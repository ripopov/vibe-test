import type { Dir, Expr, Loc, ProcBlock } from '../parser/ast';
import { collectIds, exprToString } from '../parser/parser';
import {
  childParams, elaborateItems, evalConst, paramSummary, portsOf, rangeWidth, resolveConnections,
  type Design, type ElabItems, type ModuleInfo, type Scope,
} from './design';

export type Side = 'W' | 'E';
export type PinDir = 'in' | 'out' | 'inout' | 'unknown';

export interface SPin {
  id: string;
  name: string;
  side: Side;
  dir: PinDir;
  width: number;
  /** high-fanout net shown as a flag instead of a wire */
  netLabel?: string;
  /** constant tie-off shown as a tag */
  constLabel?: string;
  /** bit/part-select of the connected net, e.g. "[7:0]" */
  sliceLabel?: string;
  /** input of a gate symbol that is inverted (drawn as a bubble) */
  inverted?: boolean;
  /** edge-sensitive input of a process (drawn with a clock triangle) */
  clock?: 'posedge' | 'negedge';
  /** width shown on the wire when it is not just the bit count (memories: "256×32") */
  widthLabel?: string;
  netKey?: string;
  tooltip?: string;
  x: number;
  y: number;
  connected: boolean;
  loc?: Loc;
}

export type NodeKind = 'inst' | 'port' | 'expr' | 'join' | 'split' | 'const' | 'proc';

export interface SNode {
  id: string;
  kind: NodeKind;
  title: string;
  subtitle?: string;
  pins: SPin[];
  width: number;
  height: number;
  x: number;
  y: number;
  loc?: Loc;
  refKind: 'instance' | 'port' | 'assign' | 'connection' | 'process';
  refName: string;
  instPath?: string;
  moduleName?: string;
  isBlackBox?: boolean;
  portDir?: Dir;
  expanded?: boolean;
  children?: SGraph;
  tooltip?: string;
  /** symbolic gate shape hint (and/or/xor/not/buf/mux/dff...) */
  symbol?: string;
}

export interface SEdge {
  id: string;
  from: string;
  to: string;
  width: number;
  nets: string[];
  netKey: string;
  tailLabel?: string;
  headLabel?: string;
  tooltip: string;
  points?: { x: number; y: number }[];
  junctions?: { x: number; y: number }[];
  /** absolute offset container for hierarchical edges (set by layout) */
  parent?: string;
}

export interface NetInfo {
  name: string;
  msb: number;
  lsb: number;
  width: number;
  isPort: Dir | null;
  loc?: Loc;
  drivers: Endpoint[];
  sinks: Endpoint[];
  unknowns: Endpoint[];
  aliases: Alias[];
  labeled: boolean;
  declared: boolean;
  /** number of resolved sink endpoints (after aliasing) */
  fanout: number;
  /** unpacked array: number of elements and packed width of one element */
  elems?: number;
  packed?: number;
  /** element index of an unpacked array element net (`mem[3]`) */
  elemOf?: { array: string; index: number };
}

export interface Endpoint {
  node: SNode;
  pin: SPin;
  hi: number;
  lo: number;
}

interface Alias {
  src: string;
  srcHi: number;
  srcLo: number;
  dstHi: number;
  dstLo: number;
  loc?: Loc;
}

export interface SGraph {
  module: string;
  path: string;
  nodes: SNode[];
  edges: SEdge[];
  nets: Map<string, NetInfo>;
}

export interface GraphOptions {
  /** nets with at least this many sinks are drawn as labels */
  labelFanout: number;
  /** clock/reset-like nets with at least this many sinks are drawn as labels */
  clockFanout: number;
  /** instance paths (relative to the graph root, e.g. "u_core/u_alu") to expand in place */
  expanded: Set<string>;
  /** show all ports of a sub-module even if unconnected */
  showUnconnected: boolean;
  maxExprLabel: number;
}

export const defaultGraphOptions: GraphOptions = {
  labelFanout: 6,
  clockFanout: 2,
  expanded: new Set(),
  showUnconnected: true,
  maxExprLabel: 28,
};

const CLOCK_RE = /(^|_)(clk|clock|ck|rst|reset|rstn|rst_n|resetn|reset_n|arst|arstn|srst|clr|clear|en|enable|ce|scan_en|test_en|vdd|vss|gnd|vcc)(_?[a-z]*)?(\d*)$/i;

export function isClockLike(name: string): boolean {
  return CLOCK_RE.test(name);
}

// ---------------------------------------------------------------------------

interface PlainRef {
  net: string;
  hi: number | null;
  lo: number | null;
  partial: boolean;
  text: string;
  loc: Loc;
}

class GraphBuilder {
  private nodes: SNode[] = [];
  private edges: SEdge[] = [];
  private nets = new Map<string, NetInfo>();
  private constNodes = new Map<string, SNode>();
  private mi: ModuleInfo;
  private items: ElabItems;
  private scope: Scope;
  private declaredNames = new Set<string>();

  constructor(
    private design: Design,
    private moduleName: string,
    private opts: GraphOptions,
    private ids: { n: number; e: number },
    private path: string,
    params?: Map<string, number>,
  ) {
    const mi = design.modules.get(moduleName);
    if (!mi) throw new Error(`unknown module ${moduleName}`);
    this.mi = mi;
    this.scope = { params: params ?? mi.params, rename: null };
    this.items = elaborateItems(mi.ast, this.scope.params);
  }

  private newId(): string {
    return `n${this.ids.n++}`;
  }
  private newEdgeId(): string {
    return `e${this.ids.e++}`;
  }

  private params(): Map<string, number> {
    return this.scope.params;
  }

  /** Apply generate-scope renames to a local net name. */
  private netName(name: string): string {
    return this.scope.rename?.get(name) ?? name;
  }

  private getNet(name: string, loc?: Loc): NetInfo {
    let n = this.nets.get(name);
    if (!n) {
      n = {
        name, msb: 0, lsb: 0, width: 1, isPort: null, loc, drivers: [], sinks: [], unknowns: [], aliases: [],
        labeled: false, declared: false, fanout: 0,
      };
      this.nets.set(name, n);
    }
    return n;
  }

  /** Net for element `index` of unpacked array `arr` (created on first use). */
  private getElem(arr: NetInfo, index: number, loc?: Loc): NetInfo {
    const name = `${arr.name}[${index}]`;
    let n = this.nets.get(name);
    if (!n) {
      n = this.getNet(name, loc ?? arr.loc);
      n.msb = arr.msb;
      n.lsb = arr.lsb;
      n.width = arr.packed ?? arr.width;
      n.declared = true;
      n.elemOf = { array: arr.name, index };
      // element nets are drawn with the array's declaration; the whole array keeps its flattened range
    }
    return n;
  }

  private declareNets() {
    for (const p of portsOf(this.mi, this.params())) {
      const n = this.getNet(p.name, p.decl.loc);
      n.msb = p.msb;
      n.lsb = p.lsb;
      n.width = p.width;
      n.isPort = p.dir;
      n.declared = true;
      n.loc = p.decl.loc;
      this.declaredNames.add(p.name);
    }
    for (const { decl: d, name, scope } of this.items.nets) {
      const params = scope.params;
      const n = this.getNet(name, d.loc);
      this.declaredNames.add(name);
      if (d.range) {
        const msb = evalConst(d.range.msb, params);
        const lsb = evalConst(d.range.lsb, params);
        if (msb !== null && lsb !== null) {
          n.msb = msb;
          n.lsb = lsb;
          n.width = rangeWidth(msb, lsb);
        }
      }
      if (d.unpacked.length) {
        let elems = 1;
        for (const r of d.unpacked) {
          const a = evalConst(r.msb, params);
          const b = evalConst(r.lsb, params);
          elems *= a !== null && b !== null ? rangeWidth(a, b) : 1;
        }
        n.elems = elems;
        n.packed = n.width;
        n.width = elems * n.packed;
      }
      n.declared = true;
      if (!n.isPort) n.loc = d.loc;
    }
  }

  /** A parameter / genvar name (unless a net of the same name is declared). */
  private isParamName(name: string): boolean {
    return this.params().has(name) && !this.declaredNames.has(this.netName(name)) && !this.nets.has(this.netName(name));
  }

  /** Whole-array pins show "elems×width" instead of the flattened bit count. */
  private widthLabelFor(net: NetInfo, hi: number, lo: number): string | undefined {
    if (net.elems && net.packed && hi - lo + 1 === net.width) return `${net.elems}×${net.packed}`;
    return undefined;
  }

  /**
   * Net designated by an expression base: a plain identifier, or `array[const]` for an unpacked
   * array element. Returns null for anything else (dynamic index, nested expression).
   */
  private baseNet(e: Expr): { net: NetInfo; loc: Loc } | null {
    if (e.kind === 'id') {
      if (this.isParamName(e.name)) return null;
      return { net: this.getNet(this.netName(e.name), e.loc), loc: e.loc };
    }
    if (e.kind === 'select' && e.base.kind === 'id') {
      const arr = this.getNet(this.netName(e.base.name), e.base.loc);
      if (!arr.elems) return null;
      const i = evalConst(e.index, this.params());
      if (i === null) return null;
      return { net: this.getElem(arr, i, e.loc), loc: e.loc };
    }
    return null;
  }

  // ---- helpers -----------------------------------------------------------

  /** Try to interpret an expression as a plain net reference (with optional constant slice). */
  private plainRef(e: Expr): PlainRef | null {
    const params = this.params();
    const whole = this.baseNet(e);
    if (whole) {
      const n = whole.net;
      const hi = n.elems ? n.width - 1 : Math.max(n.msb, n.lsb);
      const lo = n.elems ? 0 : Math.min(n.msb, n.lsb);
      return { net: n.name, hi, lo, partial: false, text: exprToString(e), loc: e.loc };
    }
    if (e.kind === 'select') {
      const base = this.baseNet(e.base);
      if (!base || base.net.elems) return null;
      const i = evalConst(e.index, params);
      if (i === null) return null;
      return { net: base.net.name, hi: i, lo: i, partial: true, text: exprToString(e), loc: e.loc };
    }
    if (e.kind === 'range') {
      const base = this.baseNet(e.base);
      if (!base || base.net.elems) return null;
      const a = evalConst(e.msb, params);
      const b = evalConst(e.lsb, params);
      if (a === null || b === null) return null;
      let hi: number, lo: number;
      if (e.op === ':') {
        hi = Math.max(a, b);
        lo = Math.min(a, b);
      } else if (e.op === '+:') {
        lo = a;
        hi = a + b - 1;
      } else {
        hi = a;
        lo = a - b + 1;
      }
      const n = base.net;
      const full = hi === Math.max(n.msb, n.lsb) && lo === Math.min(n.msb, n.lsb);
      return { net: n.name, hi, lo, partial: !full, text: exprToString(e), loc: e.loc };
    }
    return null;
  }

  /** The net an arbitrary lvalue/rvalue expression touches, widened to the whole net when the selection is dynamic. */
  private wholeRef(e: Expr): PlainRef | null {
    const r = this.plainRef(e);
    if (r) return r;
    if (e.kind === 'select' || e.kind === 'range') {
      const b = this.baseNet(e.base) ?? (e.base.kind === 'select' || e.base.kind === 'range' ? null : null);
      if (b) {
        const n = b.net;
        const hi = n.elems ? n.width - 1 : Math.max(n.msb, n.lsb);
        const lo = n.elems ? 0 : Math.min(n.msb, n.lsb);
        return { net: n.name, hi, lo, partial: false, text: exprToString(e), loc: e.loc };
      }
      return this.wholeRef(e.base);
    }
    return null;
  }

  /** Visit every net reference inside an expression (dynamic indices are visited as reads too). */
  private visitRefs(e: Expr, cb: (ref: PlainRef, expr: Expr) => void) {
    const r = this.plainRef(e);
    if (r) {
      cb(r, e);
      return;
    }
    switch (e.kind) {
      case 'select':
        this.visitRefs(e.base, cb);
        if (!this.isConst(e.index)) this.visitRefs(e.index, cb);
        break;
      case 'range':
        this.visitRefs(e.base, cb);
        if (!this.isConst(e.msb)) this.visitRefs(e.msb, cb);
        if (!this.isConst(e.lsb)) this.visitRefs(e.lsb, cb);
        break;
      case 'concat':
      case 'repl':
        e.items.forEach((i) => this.visitRefs(i, cb));
        break;
      case 'unary':
        this.visitRefs(e.arg, cb);
        break;
      case 'binary':
        this.visitRefs(e.lhs, cb);
        this.visitRefs(e.rhs, cb);
        break;
      case 'ternary':
        this.visitRefs(e.cond, cb);
        this.visitRefs(e.a, cb);
        this.visitRefs(e.b, cb);
        break;
      case 'call':
        e.args.forEach((i) => this.visitRefs(i, cb));
        break;
    }
  }

  private isConst(e: Expr): boolean {
    if (e.kind === 'num' || e.kind === 'str') return true;
    if (e.kind === 'concat' || e.kind === 'repl') return e.items.every((i) => this.isConst(i)) && (e.kind !== 'repl' || true);
    if (e.kind === 'unary') return this.isConst(e.arg);
    if (e.kind === 'binary') return this.isConst(e.lhs) && this.isConst(e.rhs);
    if (e.kind === 'id') return this.isParamName(e.name);
    return false;
  }

  private exprWidth(e: Expr): number {
    const params = this.params();
    switch (e.kind) {
      case 'num':
        return e.width ?? 32;
      case 'str':
        return Math.max(1, (e.text.length - 2) * 8);
      case 'id': {
        if (this.isParamName(e.name)) return 32;
        return this.getNet(this.netName(e.name)).width;
      }
      case 'select': {
        const b = this.baseNet(e.base);
        if (b?.net.elems) return b.net.packed ?? 1;
        const r = this.plainRef(e);
        if (r) return 1;
        const w = this.wholeRef(e);
        const n = w ? this.nets.get(w.net) : undefined;
        return n?.elemOf || n?.elems ? (n.packed ?? n.width) : 1;
      }
      case 'range': {
        const r = this.plainRef(e);
        return r && r.hi !== null && r.lo !== null ? r.hi - r.lo + 1 : 1;
      }
      case 'concat':
        return e.items.reduce((s, i) => s + this.exprWidth(i), 0);
      case 'repl': {
        const c = evalConst(e.count, params) ?? 1;
        return c * e.items.reduce((s, i) => s + this.exprWidth(i), 0);
      }
      case 'unary':
        return ['!', '&', '~&', '|', '~|', '^', '~^', '^~'].includes(e.op) ? 1 : this.exprWidth(e.arg);
      case 'binary':
        if (['==', '!=', '===', '!==', '<', '<=', '>', '>=', '&&', '||'].includes(e.op)) return 1;
        return Math.max(this.exprWidth(e.lhs), this.exprWidth(e.rhs));
      case 'ternary':
        return Math.max(this.exprWidth(e.a), this.exprWidth(e.b));
      case 'call':
        return e.args.length ? this.exprWidth(e.args[0]) : 1;
      default:
        return 1;
    }
  }

  private constText(e: Expr): string {
    const s = exprToString(e);
    return s.length > 14 ? s.slice(0, 13) + '…' : s;
  }

  private addEndpoint(net: NetInfo, ep: Endpoint, role: PinDir) {
    ep.pin.connected = true;
    ep.pin.netKey = net.name;
    if (role === 'out') net.drivers.push(ep);
    else if (role === 'in') net.sinks.push(ep);
    else net.unknowns.push(ep);
  }

  private makePin(node: SNode, name: string, side: Side, dir: PinDir, width: number, loc?: Loc): SPin {
    const pin: SPin = { id: `${node.id}.${node.pins.length}`, name, side, dir, width, x: 0, y: 0, connected: false, loc };
    node.pins.push(pin);
    return pin;
  }

  private makeNode(kind: NodeKind, title: string, refKind: SNode['refKind'], refName: string, loc?: Loc): SNode {
    const node: SNode = { id: this.newId(), kind, title, pins: [], width: 0, height: 0, x: 0, y: 0, loc, refKind, refName };
    this.nodes.push(node);
    return node;
  }

  /**
   * Connect a pin (of an instance / expr node) to an arbitrary expression.
   * role: what the pin does for the connected net ('in' = pin reads the net => net sink).
   */
  private connectPin(node: SNode, pin: SPin, expr: Expr, role: PinDir, loc: Loc) {
    if (expr.kind === 'empty') return;
    const ref = this.plainRef(expr);
    if (ref && ref.hi !== null && ref.lo !== null) {
      const net = this.getNet(ref.net, ref.loc);
      pin.tooltip = ref.text;
      pin.connected = true;
      if (ref.partial && !pin.name.startsWith('[')) pin.sliceLabel = sliceText(ref);
      pin.widthLabel = this.widthLabelFor(net, ref.hi, ref.lo);
      this.addEndpoint(net, { node, pin, hi: ref.hi, lo: ref.lo }, role);
      return;
    }
    if (this.isConst(expr)) {
      pin.constLabel = this.constText(expr);
      pin.tooltip = exprToString(expr);
      pin.connected = true;
      return;
    }
    if (expr.kind === 'concat' && role !== 'out') {
      // bus assembly feeding the pin
      const join = this.makeNode('join', '', 'connection', exprToString(expr), loc);
      join.tooltip = exprToString(expr);
      const items = flattenConcat(expr);
      for (const it of items) {
        const r = this.plainRef(it);
        const p = this.makePin(join, r && r.partial ? sliceText(r) : '', 'W', 'in', this.exprWidth(it), it.loc);
        this.connectPin(join, p, it, 'in', it.loc);
      }
      const out = this.makePin(join, '', 'E', 'out', this.exprWidth(expr), loc);
      this.directEdge(join, out, node, pin, this.exprWidth(expr), exprToString(expr), loc);
      return;
    }
    if (expr.kind === 'concat' && role === 'out') {
      // output pin driving a concatenation of nets -> splitter
      const split = this.makeNode('split', '', 'connection', exprToString(expr), loc);
      split.tooltip = exprToString(expr);
      const inp = this.makePin(split, '', 'W', 'in', this.exprWidth(expr), loc);
      const items = flattenConcat(expr);
      let bit = this.exprWidth(expr) - 1;
      for (const it of items) {
        const w = this.exprWidth(it);
        const r = this.plainRef(it);
        const label = w > 1 ? `[${bit}:${bit - w + 1}]` : `[${bit}]`;
        const p = this.makePin(split, r && r.partial ? `${label}` : label, 'E', 'out', w, it.loc);
        if (r && r.hi !== null && r.lo !== null) this.connectPin(split, p, it, 'out', it.loc);
        bit -= w;
      }
      this.directEdge(node, pin, split, inp, this.exprWidth(expr), exprToString(expr), loc);
      return;
    }
    // general expression -> operator node
    const exprNode = this.exprNode(expr, loc);
    if (role === 'out') {
      // driving an expression is meaningless; treat as sink of the expression output
    }
    const out = exprNode.pins.find((p) => p.side === 'E')!;
    this.directEdge(exprNode, out, node, pin, this.exprWidth(expr), exprToString(expr), loc);
  }

  /** Build an operator node for an expression; returns node with one output pin. */
  private exprNode(expr: Expr, loc: Loc): SNode {
    const text = exprToString(expr);
    const node = this.makeNode('expr', text, 'assign', text, loc);
    node.tooltip = text;
    node.symbol = exprSymbol(expr);
    // inputs: distinct plain refs in order of appearance
    const refs: Expr[] = [];
    const seen = new Set<string>();
    const invertedRefs = new Set<string>();
    if (node.symbol) {
      const mark = (e: Expr) => {
        if (e.kind === 'unary' && (e.op === '~' || e.op === '!') && this.plainRef(e.arg)) invertedRefs.add(this.plainRef(e.arg)!.text);
        else if (e.kind === 'binary') {
          mark(e.lhs);
          mark(e.rhs);
        } else if (e.kind === 'unary') mark(e.arg);
      };
      mark(expr);
    }
    this.visitRefs(expr, (r, e) => {
      if (!seen.has(r.text)) {
        seen.add(r.text);
        refs.push(e);
      }
    });
    for (const r of refs) {
      const pr = this.plainRef(r)!;
      const p = this.makePin(node, pr.partial ? sliceText(pr) : '', 'W', 'in', this.exprWidth(r), r.loc);
      if (invertedRefs.has(pr.text)) p.inverted = true;
      this.connectPin(node, p, r, 'in', r.loc);
    }
    if (node.symbol === 'mux') {
      // label mux inputs; a slice on an operand moves out to the pin label
      const labels = ['sel', '1', '0'];
      node.pins.slice(0, 3).forEach((p, i) => {
        if (p.name.startsWith('[')) p.sliceLabel = p.name;
        p.name = labels[i] ?? '';
      });
    }
    this.makePin(node, '', 'E', 'out', this.exprWidth(expr), loc);
    return node;
  }

  /** A direct pin-to-pin edge that is not part of a named net (expression outputs etc.) */
  private directEdge(fromNode: SNode, from: SPin, toNode: SNode, to: SPin, width: number, tooltip: string, loc: Loc) {
    from.connected = true;
    to.connected = true;
    const key = `~${from.id}`;
    from.netKey = from.netKey ?? key;
    to.netKey = to.netKey ?? key;
    this.edges.push({
      id: this.newEdgeId(), from: from.id, to: to.id, width, nets: [key], netKey: key, tooltip,
      tailLabel: from.widthLabel ?? (width > 1 ? String(width) : undefined),
    });
    void fromNode;
    void toNode;
    void loc;
  }

  // ---- module contents ---------------------------------------------------

  private buildPorts() {
    for (const p of portsOf(this.mi, this.params())) {
      const node = this.makeNode('port', p.name, 'port', p.name, p.decl.loc);
      node.portDir = p.dir;
      node.tooltip = `${p.dir} ${p.width > 1 ? `[${p.msb}:${p.lsb}] ` : ''}${p.name}`;
      const net = this.getNet(p.name);
      if (p.dir === 'input') {
        const pin = this.makePin(node, '', 'E', 'out', p.width, p.decl.loc);
        this.addEndpoint(net, { node, pin, hi: Math.max(p.msb, p.lsb), lo: Math.min(p.msb, p.lsb) }, 'out');
      } else if (p.dir === 'output') {
        const pin = this.makePin(node, '', 'W', 'in', p.width, p.decl.loc);
        this.addEndpoint(net, { node, pin, hi: Math.max(p.msb, p.lsb), lo: Math.min(p.msb, p.lsb) }, 'in');
      } else {
        const pin = this.makePin(node, '', 'W', 'inout', p.width, p.decl.loc);
        this.addEndpoint(net, { node, pin, hi: Math.max(p.msb, p.lsb), lo: Math.min(p.msb, p.lsb) }, 'inout');
      }
    }
  }

  private buildInstances() {
    for (const { inst, name: instName, scope } of this.items.instances) {
      this.scope = scope;
      const target = this.design.modules.get(inst.module);
      const tParams = childParams(inst, this.params(), target);
      const tPorts = target ? portsOf(target, tParams) : [];
      const conns = resolveConnections(inst, target, this.nets.keys());
      const rangeText = inst.range
        ? `[${evalConst(inst.range.msb, this.params()) ?? '?'}:${evalConst(inst.range.lsb, this.params()) ?? '?'}]`
        : '';
      const node = this.makeNode('inst', instName + rangeText, 'instance', instName, inst.loc);
      node.subtitle = inst.module;
      node.moduleName = inst.module;
      node.isBlackBox = !target;
      node.instPath = this.path ? `${this.path}/${instName}` : instName;
      node.symbol = target ? undefined : gateSymbol(inst.module);
      const relPath = node.instPath;
      const ptext = paramSummary(inst, this.params(), target);
      node.tooltip = `${inst.module}${ptext ? ` #(${ptext})` : ''} ${instName}${rangeText}${target ? '' : ' (black box)'}`;

      const connByPort = new Map<string, { expr: Expr | null; loc: Loc }>();
      for (const c of conns) connByPort.set(c.port, { expr: c.expr, loc: inst.conns.find((x) => x.port === c.port)?.loc ?? inst.loc });

      const pinDefs: { name: string; dir: PinDir; width: number }[] = [];
      if (target) {
        for (const p of tPorts) {
          if (!this.opts.showUnconnected && !connByPort.has(p.name)) continue;
          pinDefs.push({ name: p.name, dir: p.dir === 'input' ? 'in' : p.dir === 'output' ? 'out' : 'inout', width: p.width });
        }
        // connections to unknown ports (typos) are still shown
        for (const c of conns) if (!tPorts.some((p) => p.name === c.port)) pinDefs.push({ name: c.port, dir: 'unknown', width: c.expr ? this.exprWidth(c.expr) : 1 });
      } else {
        for (const c of conns) pinDefs.push({ name: c.port, dir: guessDir(c.port), width: c.expr ? this.exprWidth(c.expr) : 1 });
      }

      if (this.opts.expanded.has(relPath) && target && relPath.split('/').length < 12) {
        this.buildExpanded(node, target, tParams, pinDefs, connByPort);
        continue;
      }

      for (const pd of pinDefs) {
        const side: Side = pd.dir === 'out' || pd.dir === 'inout' ? 'E' : 'W';
        const c = connByPort.get(pd.name);
        const pin = this.makePin(node, pd.name, side, pd.dir, pd.width, c?.loc);
        if (c?.expr) this.connectPin(node, pin, c.expr, pd.dir, c.loc);
      }
    }
  }

  private buildExpanded(node: SNode, target: ModuleInfo, tParams: Map<string, number>, pinDefs: { name: string; dir: PinDir; width: number }[], connByPort: Map<string, { expr: Expr | null; loc: Loc }>) {
    node.expanded = true;
    const child = new GraphBuilder(this.design, target.name, this.opts, this.ids, node.instPath!, tParams).build();
    // Map child port nodes to pins of the compound node
    const pinByName = new Map<string, SPin>();
    for (const pd of pinDefs) {
      const side: Side = pd.dir === 'out' || pd.dir === 'inout' ? 'E' : 'W';
      const c = connByPort.get(pd.name);
      const pin = this.makePin(node, pd.name, side, pd.dir, pd.width, c?.loc);
      pinByName.set(pd.name, pin);
      if (c?.expr) this.connectPin(node, pin, c.expr, pd.dir, c.loc);
    }
    const remap = new Map<string, string>();
    const keep: SNode[] = [];
    for (const cn of child.nodes) {
      if (cn.kind === 'port') {
        const pin = pinByName.get(cn.refName);
        if (pin && cn.pins[0]) {
          remap.set(cn.pins[0].id, pin.id);
          pin.connected = pin.connected || cn.pins[0].connected;
          if (cn.pins[0].netLabel) pin.netLabel = pin.netLabel ?? undefined; // outer label wins
        }
        continue;
      }
      keep.push(cn);
    }
    child.nodes = keep;
    for (const e of child.edges) {
      e.from = remap.get(e.from) ?? e.from;
      e.to = remap.get(e.to) ?? e.to;
    }
    node.children = child;
  }

  private buildAssigns() {
    for (const { assign: a, scope } of this.items.assigns) {
      this.scope = scope;
      const lhsItems = this.flattenLhs(a.lhs);
      if (!lhsItems) {
        // unusual lhs: make an expression node anyway
        continue;
      }
      const rhs = a.rhs;
      const rhsRef = this.plainRef(rhs);
      if (rhsRef && rhsRef.hi !== null && rhsRef.lo !== null) {
        // pure alias: lhs bits <- rhs bits (msb-first over lhs items)
        let srcBit = rhsRef.hi;
        for (const it of lhsItems) {
          const w = it.hi - it.lo + 1;
          const net = this.getNet(it.net, it.loc);
          net.aliases.push({ src: rhsRef.net, srcHi: srcBit, srcLo: srcBit - w + 1, dstHi: it.hi, dstLo: it.lo, loc: a.loc });
          srcBit -= w;
        }
        continue;
      }
      if (rhs.kind === 'concat' && lhsItems.length >= 1) {
        // concat of refs/consts: alias each piece
        const items = flattenConcat(rhs);
        const pieces: { expr: Expr; w: number }[] = items.map((it) => ({ expr: it, w: this.exprWidth(it) }));
        const total = pieces.reduce((s, p) => s + p.w, 0);
        const lhsTotal = lhsItems.reduce((s, it) => s + (it.hi - it.lo + 1), 0);
        if (pieces.every((p) => this.plainRef(p.expr) || this.isConst(p.expr)) && total === lhsTotal) {
          // walk bits from MSB
          let lhsIdx = 0;
          let lhsBit = lhsItems[0].hi;
          for (const p of pieces) {
            let remaining = p.w;
            let srcHi = p.w - 1;
            while (remaining > 0 && lhsIdx < lhsItems.length) {
              const it = lhsItems[lhsIdx];
              const avail = lhsBit - it.lo + 1;
              const take = Math.min(avail, remaining);
              const net = this.getNet(it.net, it.loc);
              const ref = this.plainRef(p.expr);
              if (ref && ref.hi !== null && ref.lo !== null) {
                const sHi = ref.lo + srcHi;
                net.aliases.push({ src: ref.net, srcHi: sHi, srcLo: sHi - take + 1, dstHi: lhsBit, dstLo: lhsBit - take + 1, loc: a.loc });
              } else {
                this.constDriver(net, lhsBit, lhsBit - take + 1, p.expr, a.loc);
              }
              srcHi -= take;
              remaining -= take;
              lhsBit -= take;
              if (lhsBit < it.lo) {
                lhsIdx++;
                if (lhsIdx < lhsItems.length) lhsBit = lhsItems[lhsIdx].hi;
              }
            }
          }
          continue;
        }
      }
      if (this.isConst(rhs)) {
        for (const it of lhsItems) this.constDriver(this.getNet(it.net, it.loc), it.hi, it.lo, rhs, a.loc);
        continue;
      }
      // general expression
      const node = this.exprNode(rhs, a.loc);
      node.refName = lhsItems.map((i) => i.text).join(', ');
      node.loc = a.loc;
      const out = node.pins.find((p) => p.side === 'E')!;
      out.width = lhsItems.reduce((s, it) => s + (it.hi - it.lo + 1), 0);
      for (const it of lhsItems) {
        const net = this.getNet(it.net, it.loc);
        this.addEndpoint(net, { node, pin: out, hi: it.hi, lo: it.lo }, 'out');
      }
    }
  }

  /**
   * Procedural blocks become process nodes: one input pin per net the block evaluates, one
   * output pin per net it assigns. Edge-sensitive signals (clock, async reset) are marked.
   */
  private buildProcs() {
    for (const { proc, scope } of this.items.procs) {
      this.scope = scope;
      const locals = new Set(proc.locals);
      const sensText = proc.sens
        ? proc.sens.map((s) => `${s.edge ? s.edge + ' ' : ''}${exprToString(s.expr)}`).join(', ')
        : '';
      const node = this.makeNode('proc', proc.kind, 'process', `${proc.kind}@${proc.loc.line}`, proc.loc);
      node.subtitle = sensText ? `@(${sensText})` : proc.kind === 'always' ? '@*' : undefined;

      type Span = { hi: number; lo: number; loc: Loc; partial: boolean };
      const merge = (m: Map<string, Span>, r: PlainRef) => {
        if (r.hi === null || r.lo === null) return;
        const cur = m.get(r.net);
        if (!cur) m.set(r.net, { hi: r.hi, lo: r.lo, loc: r.loc, partial: r.partial });
        else {
          cur.hi = Math.max(cur.hi, r.hi);
          cur.lo = Math.min(cur.lo, r.lo);
          cur.partial = cur.partial && r.partial;
        }
      };
      const writes = new Map<string, Span>();
      for (const w of proc.writes) {
        for (const it of flattenConcat(w.lhs)) {
          const r = this.wholeRef(it);
          if (r) merge(writes, r);
        }
      }
      const reads = new Map<string, Span>();
      const edges = new Map<string, 'posedge' | 'negedge'>();
      const order: string[] = [];
      const noteRead = (r: PlainRef) => {
        if (r.hi === null) return;
        if (!reads.has(r.net)) order.push(r.net);
        merge(reads, r);
      };
      if (proc.sens) {
        for (const s of proc.sens) {
          this.visitRefs(s.expr, (r) => {
            noteRead(r);
            if (s.edge) edges.set(r.net, s.edge);
          });
        }
      }
      for (const r of proc.reads) this.visitRefs(r, (ref) => noteRead(ref));

      const isLocal = (name: string) => locals.has(name) || locals.has(name.replace(/\[.*$/, ''));
      const full = (net: NetInfo, s: Span) => s.hi >= Math.max(net.msb, net.lsb) && s.lo <= Math.min(net.msb, net.lsb);
      const dataIn = order.filter((n) => !edges.has(n) && !isLocal(n));
      const clkIn = order.filter((n) => edges.has(n) && !isLocal(n));
      const stateNets: string[] = [];
      for (const name of [...dataIn, ...clkIn]) {
        const span = reads.get(name)!;
        const net = this.getNet(name, span.loc);
        if (writes.has(name) && !edges.has(name)) {
          stateNets.push(name);
          continue;
        }
        const w = net.elems ? net.width : span.hi - span.lo + 1;
        const pin = this.makePin(node, name, 'W', 'in', net.elems ? net.width : w, span.loc);
        pin.clock = edges.get(name);
        const isFull = net.elems ? true : full(net, span);
        const hi = isFull ? Math.max(net.msb, net.lsb, net.width - 1) : span.hi;
        const lo = isFull ? Math.min(net.msb, net.lsb) : span.lo;
        if (!isFull) pin.sliceLabel = hi === lo ? `[${hi}]` : `[${hi}:${lo}]`;
        pin.width = hi - lo + 1;
        pin.widthLabel = this.widthLabelFor(net, hi, lo);
        pin.tooltip = `${name}${pin.sliceLabel ?? ''}`;
        this.addEndpoint(net, { node, pin, hi, lo }, 'in');
      }
      for (const [name, span] of writes) {
        if (isLocal(name)) continue;
        const net = this.getNet(name, span.loc);
        const isFull = net.elems ? true : full(net, span);
        const hi = isFull ? Math.max(net.msb, net.lsb, net.width - 1) : span.hi;
        const lo = isFull ? Math.min(net.msb, net.lsb) : span.lo;
        const pin = this.makePin(node, name, 'E', 'out', hi - lo + 1, span.loc);
        if (!isFull) pin.sliceLabel = hi === lo ? `[${hi}]` : `[${hi}:${lo}]`;
        pin.widthLabel = this.widthLabelFor(net, hi, lo);
        pin.tooltip = `${name}${pin.sliceLabel ?? ''}`;
        this.addEndpoint(net, { node, pin, hi, lo }, 'out');
      }
      const outs = [...writes.keys()].filter((n) => !isLocal(n));
      node.refName = outs.length ? outs.join(', ') : node.refName;
      node.tooltip = `${proc.kind}${sensText ? ` @(${sensText})` : ''} → ${outs.join(', ') || '(no outputs)'}${stateNets.length ? `\nreads its own ${stateNets.join(', ')}` : ''}`;
    }
  }

  /** Connect unpacked-array element nets (`mem[3]`) with the whole-array net (`mem`) through aliases. */
  private linkArrays() {
    for (const net of [...this.nets.values()]) {
      if (!net.elemOf) continue;
      const arr = this.nets.get(net.elemOf.array);
      if (!arr || !arr.packed) continue;
      const base = net.elemOf.index * arr.packed;
      const lo = Math.min(arr.msb, arr.lsb);
      const hi = Math.max(arr.msb, arr.lsb);
      const wholeDriven = arr.drivers.length > 0 || arr.unknowns.length > 0;
      if (wholeDriven) net.aliases.push({ src: arr.name, srcHi: base + (hi - lo), srcLo: base, dstHi: hi, dstLo: lo, loc: arr.loc });
      if (arr.sinks.length || arr.unknowns.length) arr.aliases.push({ src: net.name, srcHi: hi, srcLo: lo, dstHi: base + (hi - lo), dstLo: base, loc: net.loc });
    }
  }

  private constDriver(net: NetInfo, hi: number, lo: number, expr: Expr, loc: Loc) {
    const text = this.constText(expr);
    const key = `${text}`;
    let node = this.constNodes.get(key);
    if (!node) {
      node = this.makeNode('const', text, 'assign', text, loc);
      node.tooltip = exprToString(expr);
      this.makePin(node, '', 'E', 'out', hi - lo + 1, loc);
      this.constNodes.set(key, node);
    }
    this.addEndpoint(net, { node, pin: node.pins[0], hi, lo }, 'out');
  }

  private flattenLhs(lhs: Expr): { net: string; hi: number; lo: number; text: string; loc: Loc }[] | null {
    if (lhs.kind === 'concat') {
      const out: { net: string; hi: number; lo: number; text: string; loc: Loc }[] = [];
      for (const it of lhs.items) {
        const sub = this.flattenLhs(it);
        if (!sub) return null;
        out.push(...sub);
      }
      return out;
    }
    const r = this.plainRef(lhs);
    if (!r || r.hi === null || r.lo === null) return null;
    return [{ net: r.net, hi: r.hi, lo: r.lo, text: r.text, loc: r.loc }];
  }

  // ---- edges -------------------------------------------------------------

  private resolveRoles() {
    for (const net of this.nets.values()) {
      if (!net.unknowns.length) continue;
      const covered = (hi: number, lo: number) =>
        net.drivers.some((d) => d.hi >= lo && d.lo <= hi) || net.aliases.some((a) => a.dstHi >= lo && a.dstLo <= hi);
      // black-box ports first (an inout port of this module is more likely a sink of the black box)
      const order = [...net.unknowns].sort((a, b) => Number(a.node.kind === 'port') - Number(b.node.kind === 'port'));
      for (const u of order) {
        if (!covered(u.hi, u.lo)) {
          net.drivers.push(u);
          if (u.pin.dir === 'unknown') {
            u.pin.dir = 'out';
            if (u.node.kind === 'inst') u.pin.side = 'E';
          }
        } else {
          net.sinks.push(u);
          if (u.pin.dir === 'unknown') u.pin.dir = 'in';
        }
      }
      net.unknowns = [];
    }
    // keep pins of one side in declaration order even after flips
    for (const n of this.nodes) n.pins.forEach((p, i) => (p.id = p.id || `${n.id}.${i}`));
  }

  private resolveDrivers(net: NetInfo, hi: number, lo: number, visited: Set<string>, chain: string[]): ResolvedDriver[] {
    const out: ResolvedDriver[] = [];
    if (visited.has(net.name)) return out;
    visited.add(net.name);
    for (const d of net.drivers) {
      const oHi = Math.min(d.hi, hi);
      const oLo = Math.max(d.lo, lo);
      if (oHi < oLo) continue;
      out.push({ ep: d, srcNet: net, srcHi: oHi, srcLo: oLo, dstHi: oHi, dstLo: oLo, chain: [...chain, net.name] });
    }
    for (const a of net.aliases) {
      const oHi = Math.min(a.dstHi, hi);
      const oLo = Math.max(a.dstLo, lo);
      if (oHi < oLo) continue;
      const src = this.nets.get(a.src);
      if (!src) continue;
      const sHi = a.srcLo + (oHi - a.dstLo);
      const sLo = a.srcLo + (oLo - a.dstLo);
      const sub = this.resolveDrivers(src, sHi, sLo, visited, [...chain, net.name]);
      for (const r of sub) {
        // map back to this net's bit numbering
        const dHi = a.dstLo + (r.dstHi - a.srcLo);
        const dLo = a.dstLo + (r.dstLo - a.srcLo);
        out.push({ ...r, dstHi: dHi, dstLo: dLo });
      }
    }
    visited.delete(net.name);
    return out;
  }

  private buildEdges() {
    // fanout (for labeling): resolved sinks per driver pin
    const sinkList: { net: NetInfo; sink: Endpoint; drivers: ResolvedDriver[] }[] = [];
    const fanout = new Map<string, number>();
    for (const net of this.nets.values()) {
      for (const sink of net.sinks) {
        const drivers = this.resolveDrivers(net, sink.hi, sink.lo, new Set(), []);
        sinkList.push({ net, sink, drivers });
        for (const d of drivers) fanout.set(d.ep.pin.id, (fanout.get(d.ep.pin.id) ?? 0) + 1);
        // each sink counts once per net it is (transitively) attached to
        const chainNets = new Set<string>();
        for (const d of drivers) for (const n of d.chain) chainNets.add(n);
        if (!drivers.length) chainNets.add(net.name);
        for (const n of chainNets) {
          const ni = this.nets.get(n);
          if (ni) ni.fanout++;
        }
      }
    }
    // decide labeled nets
    for (const net of this.nets.values()) {
      const f = net.fanout;
      net.labeled = f >= this.opts.labelFanout || (isClockLike(net.name) && f >= this.opts.clockFanout && net.width === 1);
    }
    const labelFor = (chain: string[], srcNet: NetInfo): NetInfo | null => {
      // prefer the sink-side net name that is labeled, else source net
      for (const n of chain) {
        const ni = this.nets.get(n);
        if (ni?.labeled) return ni;
      }
      return srcNet.labeled ? srcNet : null;
    };

    const seen = new Set<string>();
    const labeledDrivers = new Set<string>();
    const fullOf = (n: NetInfo) => (n.elems ? { hi: n.width - 1, lo: 0 } : { hi: Math.max(n.msb, n.lsb), lo: Math.min(n.msb, n.lsb) });
    for (const { net, sink, drivers } of sinkList) {
      const nf = fullOf(net);
      const sinkPartial = !(sink.hi === nf.hi && sink.lo === nf.lo);
      const sinkEdges: { edge: SEdge; dstHi: number; dstLo: number }[] = [];
      for (const d of drivers) {
        const labeledNet = labelFor(d.chain, d.srcNet);
        const width = d.dstHi - d.dstLo + 1;
        const dstSlice = width === net.width && !sinkPartial ? '' : `[${d.dstHi}${d.dstHi !== d.dstLo ? ':' + d.dstLo : ''}]`;
        const srcNetW = d.srcNet.width;
        const sf = fullOf(d.srcNet);
        const srcFull = d.srcHi === sf.hi && d.srcLo === sf.lo;
        const srcSlice = srcFull ? '' : `[${d.srcHi}${d.srcHi !== d.srcLo ? ':' + d.srcLo : ''}]`;
        if (labeledNet) {
          // the flag shows the local (sink-side) net name; aliases are explained in the tooltip
          const label = `${net.name}${dstSlice}`;
          if (sink.pin.netLabel && sink.pin.netLabel !== label) sink.pin.netLabel += `,${net.name}`;
          else sink.pin.netLabel = label;
          sink.pin.netKey = net.name;
          if (d.srcNet !== net) sink.pin.tooltip = `${net.name}${dstSlice} ← ${d.srcNet.name}${srcSlice}`;
          if (d.ep.node.kind !== 'port') {
            d.ep.pin.netLabel = d.srcNet.name + (!srcFull ? srcSlice : '');
            d.ep.pin.tooltip = d.srcNet !== net ? `${d.srcNet.name}${srcSlice} → ${net.name}${dstSlice}` : d.ep.pin.tooltip;
            labeledDrivers.add(d.ep.pin.id);
          }
          continue;
        }
        // constant tie-off drawn as a tag when it covers the whole sink
        if (d.ep.node.kind === 'const' && drivers.length === 1 && width === sink.hi - sink.lo + 1) {
          sink.pin.constLabel = d.ep.node.title;
          sink.pin.tooltip = `${net.name}${dstSlice} = ${d.ep.node.tooltip}`;
          continue;
        }
        const key = `${d.ep.pin.id}>${sink.pin.id}>${dstSlice}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const nets = Array.from(new Set([d.srcNet.name, ...d.chain]));
        const headParts: string[] = [];
        if (srcSlice && !(dstSlice && d.srcNet === net) && !d.ep.pin.sliceLabel) headParts.push(srcSlice);
        if (dstSlice && !sink.pin.sliceLabel) headParts.push(dstSlice);
        const head = headParts.length === 2 ? `${headParts[0]}→${headParts[1]}` : headParts[0];
        const netRange = net.elems ? ` ${net.elems}×${net.packed}` : net.width > 1 ? ` [${net.msb}:${net.lsb}]` : '';
        const tooltip = d.srcNet === net
          ? `${net.name}${netRange}${dstSlice ? ' ' + dstSlice : ''}`
          : `${net.name}${dstSlice} ← ${d.srcNet.name}${srcSlice}`;
        const edge: SEdge = {
          id: this.newEdgeId(),
          from: d.ep.pin.id,
          to: sink.pin.id,
          width,
          nets,
          netKey: net.name,
          tailLabel: d.ep.pin.widthLabel ?? (d.ep.pin.width > 1 ? String(d.ep.pin.width) : undefined),
          headLabel: head || undefined,
          tooltip,
        };
        this.edges.push(edge);
        sinkEdges.push({ edge, dstHi: d.dstHi, dstLo: d.dstLo });
        void srcNetW;
      }
      // several slices travelling between the same two pins are drawn as one wire
      const groups = new Map<string, typeof sinkEdges>();
      for (const se of sinkEdges) {
        const k = `${se.edge.from}>${se.edge.to}`;
        const g = groups.get(k);
        if (g) g.push(se);
        else groups.set(k, [se]);
      }
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        g.sort((a, b) => b.dstHi - a.dstHi);
        const first = g[0].edge;
        let contiguous = true;
        for (let i = 1; i < g.length; i++) if (g[i].dstHi !== g[i - 1].dstLo - 1) contiguous = false;
        const hi = g[0].dstHi;
        const lo = g[g.length - 1].dstLo;
        const coversSink = contiguous && hi === sink.hi && lo === sink.lo;
        first.width = g.reduce((a, x) => a + (x.dstHi - x.dstLo + 1), 0);
        first.nets = Array.from(new Set(g.flatMap((x) => x.edge.nets)));
        first.tooltip = g.map((x) => x.edge.tooltip).join('\n');
        first.headLabel = coversSink && !sinkPartial ? undefined : contiguous ? `[${hi}:${lo}]` : `${g.length} slices`;
        const drop = new Set(g.slice(1).map((x) => x.edge));
        this.edges = this.edges.filter((e) => !drop.has(e));
      }
    }
    // remove const nodes that ended up unused
    const usedPins = new Set<string>();
    for (const e of this.edges) {
      usedPins.add(e.from);
      usedPins.add(e.to);
    }
    this.nodes = this.nodes.filter((n) => n.kind !== 'const' || n.pins.some((p) => usedPins.has(p.id)));
    // drop 'connected' flag for pins that ended with nothing attached and no label
    for (const n of this.nodes) for (const p of n.pins) {
      if (!usedPins.has(p.id) && !p.netLabel && !p.constLabel) {
        // ports of labeled nets stay "connected" (the port itself is the label)
        const net = p.netKey ? this.nets.get(p.netKey) : undefined;
        p.connected = n.kind === 'port' && !!net && (net.labeled || net.fanout > 0 || net.drivers.length > 1);
      }
    }
  }

  build(): SGraph {
    this.declareNets();
    this.buildPorts();
    this.buildInstances();
    this.buildAssigns();
    this.buildProcs();
    this.linkArrays();
    this.resolveRoles();
    this.buildEdges();
    // tooltips for pins
    for (const n of this.nodes) for (const p of n.pins) {
      if (!p.tooltip && p.netKey && !p.netKey.startsWith('~')) p.tooltip = p.netKey;
    }
    return { module: this.moduleName, path: this.path, nodes: this.nodes, edges: this.edges, nets: this.nets };
  }
}

interface ResolvedDriver {
  ep: Endpoint;
  srcNet: NetInfo;
  srcHi: number;
  srcLo: number;
  dstHi: number;
  dstLo: number;
  chain: string[];
}

function flattenConcat(e: Expr): Expr[] {
  if (e.kind !== 'concat') return [e];
  const out: Expr[] = [];
  for (const it of e.items) out.push(...flattenConcat(it));
  return out;
}

function sliceText(r: PlainRef): string {
  if (r.hi === null || r.lo === null) return '';
  return r.hi === r.lo ? `[${r.hi}]` : `[${r.hi}:${r.lo}]`;
}

function guessDir(port: string): PinDir {
  const p = port.toLowerCase();
  if (/^(q|qn|y|z|out|o|dout|zn|co|cout|so|sum|result|data_out|rdata|dat_o|q\d*|y\d*|o\d*)$/.test(p)) return 'out';
  if (/(_o|_out|_q|_y|_z|_n)$/.test(p) && !/(_en|_in)$/.test(p)) return 'out';
  if (/^(a|b|c|d|i|in|s|sel|clk|ck|rst|rstn|en|ce|din|a\d*|b\d*|i\d*|d\d*|s\d*|clr|set|sn|rn)$/.test(p)) return 'in';
  if (/(_i|_in|_d|_en)$/.test(p)) return 'in';
  return 'unknown';
}

/** Recognize standard-cell-like primitive names so they can be drawn with gate symbols. */
export function gateSymbol(moduleName: string): string | undefined {
  const m = moduleName.toLowerCase();
  const tests: [RegExp, string][] = [
    [/^(nand|nnd)\d*/, 'nand'],
    [/^(nor)\d*/, 'nor'],
    [/^(xnor|xnr)\d*/, 'xnor'],
    [/^(xor|xr)\d*/, 'xor'],
    [/^(and|an)\d*/, 'and'],
    [/^(or)\d*/, 'or'],
    [/^(inv|not|clkinv|invx?\d*)/, 'not'],
    [/^(buf|clkbuf|dly)/, 'buf'],
    [/^(mux|mx)\d*/, 'mux'],
    [/^(dff|sdff|edff|flop|dffr|dffs|dffrs|dfrtp|dfxtp|dfxbp|dfrtn|dfstp|sdfxtp|reg\d*|latch|dlatch|dlh|dll)/, 'dff'],
  ];
  for (const [re, sym] of tests) if (re.test(m)) return sym;
  return undefined;
}

/** True for a bare net reference: name, bit-select or part-select with constant indices. */
function isPlainRefExpr(e: Expr): boolean {
  if (e.kind === 'id') return true;
  if (e.kind === 'select') return e.base.kind === 'id';
  if (e.kind === 'range') return e.base.kind === 'id';
  return false;
}

/**
 * A gate symbol is only used when the picture tells the whole story: a chain of one
 * associative operator over bare nets (optionally inverted), or a 2:1 mux of bare nets.
 */
function exprSymbol(e: Expr): string | undefined {
  const gateOf: Record<string, string> = { '&': 'and', '&&': 'and', '|': 'or', '||': 'or', '^': 'xor', '~^': 'xnor', '^~': 'xnor' };
  // leaves may be bare nets or inverted bare nets (drawn as input bubbles)
  const leaf = (x: Expr): boolean => isPlainRefExpr(x) || ((x.kind === 'unary' && (x.op === '~' || x.op === '!')) && isPlainRefExpr(x.arg));
  const pureChain = (x: Expr, op: string): boolean =>
    leaf(x) || (x.kind === 'binary' && x.op === op && pureChain(x.lhs, op) && pureChain(x.rhs, op));
  if (e.kind === 'binary' && gateOf[e.op] && pureChain(e, e.op)) return gateOf[e.op];
  if (e.kind === 'unary' && (e.op === '~' || e.op === '!')) {
    if (isPlainRefExpr(e.arg)) return 'not';
    if (e.arg.kind === 'binary' && gateOf[e.arg.op] && pureChain(e.arg, e.arg.op)) {
      const g = gateOf[e.arg.op];
      return g === 'and' ? 'nand' : g === 'or' ? 'nor' : g === 'xor' ? 'xnor' : undefined;
    }
  }
  if (e.kind === 'ternary' && isPlainRefExpr(e.cond) && isPlainRefExpr(e.a) && isPlainRefExpr(e.b)) return 'mux';
  return undefined;
}

export function buildGraph(design: Design, moduleName: string, opts: Partial<GraphOptions> = {}, path = '', params?: Map<string, number>): SGraph {
  const o: GraphOptions = { ...defaultGraphOptions, ...opts };
  return new GraphBuilder(design, moduleName, o, { n: 0, e: 0 }, path, params).build();
}

/** Iterate over all nodes including expanded children */
export function* allNodes(g: SGraph): Generator<SNode> {
  for (const n of g.nodes) {
    yield n;
    if (n.children) yield* allNodes(n.children);
  }
}
export function* allEdges(g: SGraph): Generator<SEdge> {
  for (const e of g.edges) yield e;
  for (const n of g.nodes) if (n.children) yield* allEdges(n.children);
}

export { collectIds };
