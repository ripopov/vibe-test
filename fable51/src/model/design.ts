import type { Assign, Dir, Expr, Instance, ItemBag, Module, NetDecl, ParseResult, PortDecl, ProcBlock, Range } from '../parser/ast';
import { parseVerilog } from '../parser/parser';
import type { Macro } from '../parser/lexer';

export interface PortInfo {
  name: string;
  dir: Dir;
  msb: number;
  lsb: number;
  width: number;
  decl: PortDecl;
}

export interface ModuleInfo {
  name: string;
  ast: Module;
  /** ports sized with the default parameter values */
  ports: PortInfo[];
  /** default parameter values */
  params: Map<string, number>;
  /** number of direct child instances that resolve to defined modules */
  isLeaf: boolean;
}

/** Parameter/genvar values (and generate-scope renames) in effect for an elaborated item. */
export interface Scope {
  params: Map<string, number>;
  /** local name -> hierarchical name for nets declared inside labelled generate blocks */
  rename: Map<string, string> | null;
}

export interface ElabItems {
  nets: { decl: NetDecl; name: string; scope: Scope }[];
  assigns: { assign: Assign; scope: Scope }[];
  instances: { inst: Instance; name: string; scope: Scope }[];
  procs: { proc: ProcBlock; scope: Scope }[];
}

export interface Design {
  modules: Map<string, ModuleInfo>;
  /** modules referenced by instances but not defined anywhere */
  blackBoxes: Set<string>;
  /** candidate top modules (not instantiated by anyone) */
  tops: string[];
  parse: ParseResult;
}

export function evalConst(e: Expr | null | undefined, params: Map<string, number>, depth = 0): number | null {
  if (!e || depth > 40) return null;
  switch (e.kind) {
    case 'num':
      return e.value;
    case 'id': {
      const v = params.get(e.name);
      return v === undefined ? null : v;
    }
    case 'unary': {
      const a = evalConst(e.arg, params, depth + 1);
      if (a === null) return null;
      switch (e.op) {
        case '-': return -a;
        case '+': return a;
        case '!': return a ? 0 : 1;
        case '~': return ~a;
        default: return null;
      }
    }
    case 'binary': {
      const a = evalConst(e.lhs, params, depth + 1);
      const b = evalConst(e.rhs, params, depth + 1);
      if (a === null || b === null) return null;
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? null : Math.trunc(a / b);
        case '%': return b === 0 ? null : a % b;
        case '**': return Math.pow(a, b);
        case '<<': case '<<<': return a << b;
        case '>>': case '>>>': return a >> b;
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '&&': return a && b ? 1 : 0;
        case '||': return a || b ? 1 : 0;
        default: return null;
      }
    }
    case 'ternary': {
      const c = evalConst(e.cond, params, depth + 1);
      if (c === null) return null;
      return evalConst(c ? e.a : e.b, params, depth + 1);
    }
    case 'call': {
      if (e.name === '$clog2') {
        const a = evalConst(e.args[0], params, depth + 1);
        if (a === null) return null;
        return a <= 1 ? 0 : Math.ceil(Math.log2(a));
      }
      return null;
    }
    default:
      return null;
  }
}

export function evalRange(r: Range | null, params: Map<string, number>): { msb: number; lsb: number } {
  if (!r) return { msb: 0, lsb: 0 };
  const msb = evalConst(r.msb, params);
  const lsb = evalConst(r.lsb, params);
  if (msb === null || lsb === null) {
    // unknown width: keep it symbolic-ish but drawable
    return { msb: msb ?? (lsb ?? 0), lsb: lsb ?? 0 };
  }
  return { msb, lsb };
}

export function rangeWidth(msb: number, lsb: number): number {
  return Math.abs(msb - lsb) + 1;
}

/** Evaluate a module's parameters; `overrides` replace the defaults of non-local parameters. */
export function buildParams(m: Module, overrides?: Map<string, number>): Map<string, number> {
  const params = new Map<string, number>();
  if (overrides) for (const p of m.params) if (!p.local && overrides.has(p.name)) params.set(p.name, overrides.get(p.name)!);
  // iterate a few times to resolve forward references
  for (let iter = 0; iter < 4; iter++) {
    for (const p of m.params) {
      if (params.has(p.name)) continue;
      const v = evalConst(p.value, params);
      if (v !== null) params.set(p.name, v);
    }
  }
  return params;
}

/** Ports of a module sized for the given parameter values. */
export function portsOf(mi: ModuleInfo, params: Map<string, number>): PortInfo[] {
  if (params === mi.params) return mi.ports;
  return mi.ast.ports.map((p) => {
    const { msb, lsb } = evalRange(p.range, params);
    return { name: p.name, dir: p.dir ?? 'inout', msb, lsb, width: rangeWidth(msb, lsb), decl: p };
  });
}

/** Parameter overrides an instance applies to its target, evaluated in the parent's scope. */
export function instanceOverrides(inst: Instance, parentParams: Map<string, number>, target: ModuleInfo | undefined): Map<string, number> {
  const out = new Map<string, number>();
  const formal = target ? target.ast.params.filter((p) => !p.local) : [];
  let pos = 0;
  for (const po of inst.params) {
    const v = evalConst(po.value, parentParams);
    const name = po.name ?? formal[pos++]?.name;
    if (name && v !== null) out.set(name, v);
  }
  return out;
}

/** Parameters of the module instantiated by `inst`, given the parent's scope. */
export function childParams(inst: Instance, parentParams: Map<string, number>, target: ModuleInfo | undefined): Map<string, number> {
  if (!target) return new Map();
  const ov = instanceOverrides(inst, parentParams, target);
  if (!ov.size) return target.params;
  const p = buildParams(target.ast, ov);
  // identical to defaults? share the default map so callers can compare by identity
  let same = p.size === target.params.size;
  if (same) for (const [k, v] of p) if (target.params.get(k) !== v) same = false;
  return same ? target.params : p;
}

/** Non-default parameter values of an instance, for display (`WIDTH=8, N=4`). */
export function paramSummary(inst: Instance, parentParams: Map<string, number>, target: ModuleInfo | undefined): string {
  const ov = instanceOverrides(inst, parentParams, target);
  const parts: string[] = [];
  const fmt = (v: number) => (Number.isInteger(v) && Math.abs(v) >= 4096 ? `0x${v.toString(16)}` : String(v));
  for (const [k, v] of ov) if (!target || target.params.get(k) !== v) parts.push(`${k}=${fmt(v)}`);
  return parts.join(', ');
}

/**
 * Flatten a module body for one set of parameter values: unroll generate loops, resolve
 * generate conditions and evaluate local parameters. Nets/instances declared inside labelled
 * generate blocks get hierarchical names (`label[i].name`).
 */
export function elaborateItems(m: Module, params: Map<string, number>): ElabItems {
  const out: ElabItems = { nets: [], assigns: [], instances: [], procs: [] };
  const walk = (bag: ItemBag, scope: Scope, prefix: string, depth: number) => {
    if (depth > 16) return;
    if (bag.params.length && bag !== m) {
      const p = new Map(scope.params);
      for (let iter = 0; iter < 3; iter++) for (const d of bag.params) {
        if (p.has(d.name) && iter > 0) continue;
        const v = evalConst(d.value, p);
        if (v !== null) p.set(d.name, v);
      }
      scope = { params: p, rename: scope.rename };
    }
    if (prefix && bag.nets.length) {
      const rn = new Map(scope.rename ?? []);
      for (const d of bag.nets) rn.set(d.name, `${prefix}.${d.name}`);
      scope = { params: scope.params, rename: rn };
    }
    for (const d of bag.nets) out.nets.push({ decl: d, name: prefix ? `${prefix}.${d.name}` : d.name, scope });
    for (const a of bag.assigns) out.assigns.push({ assign: a, scope });
    for (const i of bag.instances) out.instances.push({ inst: i, name: prefix ? `${prefix}.${i.name}` : i.name, scope });
    for (const pr of bag.procs) out.procs.push({ proc: pr, scope });
    for (const g of bag.generates) {
      const join = (label: string | null, idx?: number) => {
        const seg = label ? (idx === undefined ? label : `${label}[${idx}]`) : idx === undefined ? '' : `genblk[${idx}]`;
        return seg ? (prefix ? `${prefix}.${seg}` : seg) : prefix;
      };
      if (g.kind === 'for') {
        const p = new Map(scope.params);
        let v = evalConst(g.init, p);
        if (v === null) continue;
        for (let iter = 0; iter < 4096; iter++) {
          p.set(g.genvar, v);
          const c = evalConst(g.cond, p);
          if (!c) break;
          walk(g.body.items, { params: new Map(p), rename: scope.rename }, join(g.body.label, v), depth + 1);
          const nv = evalConst(g.step, p);
          if (nv === null || nv === v) break;
          v = nv;
        }
      } else if (g.kind === 'if') {
        const c = evalConst(g.cond, scope.params);
        const body = c ? g.then : c === 0 ? g.else : null;
        if (body) walk(body.items, scope, join(body.label), depth + 1);
      } else {
        walk(g.body.items, scope, join(g.body.label), depth + 1);
      }
    }
  };
  walk(m, { params, rename: null }, '', 0);
  return out;
}

export function elaborate(parse: ParseResult): Design {
  const modules = new Map<string, ModuleInfo>();
  for (const m of parse.modules) {
    const params = buildParams(m);
    const ports: PortInfo[] = m.ports.map((p) => {
      const { msb, lsb } = evalRange(p.range, params);
      return { name: p.name, dir: p.dir ?? 'inout', msb, lsb, width: rangeWidth(msb, lsb), decl: p };
    });
    modules.set(m.name, { name: m.name, ast: m, ports, params, isLeaf: true });
  }
  const blackBoxes = new Set<string>();
  const instantiated = new Set<string>();
  for (const mi of modules.values()) {
    for (const { inst } of elaborateItems(mi.ast, mi.params).instances) {
      instantiated.add(inst.module);
      if (modules.has(inst.module)) mi.isLeaf = false;
      else blackBoxes.add(inst.module);
    }
  }
  let tops = [...modules.keys()].filter((n) => !instantiated.has(n));
  // sort tops: biggest hierarchy first
  const sizeCache = new Map<string, number>();
  const hierSize = (name: string, seen: Set<string>): number => {
    if (sizeCache.has(name)) return sizeCache.get(name)!;
    const mi = modules.get(name);
    if (!mi || seen.has(name)) return 1;
    seen.add(name);
    let s = 1;
    for (const { inst } of elaborateItems(mi.ast, mi.params).instances) s += hierSize(inst.module, seen);
    seen.delete(name);
    sizeCache.set(name, s);
    return s;
  };
  tops = tops.sort((a, b) => hierSize(b, new Set()) - hierSize(a, new Set()));
  if (tops.length === 0 && modules.size) tops = [[...modules.keys()][0]];
  return { modules, blackBoxes, tops, parse };
}

export function loadDesign(src: string, defines?: Map<string, Macro>): Design {
  return elaborate(parseVerilog(src, defines));
}

export interface PathStep {
  /** instance name ('' for the top) */
  inst: string;
  module: string;
  params: Map<string, number>;
  ast?: Instance;
}

/** Resolve an instance path (top + instance names) to modules and parameter values; null if invalid. */
export function resolvePath(design: Design, top: string, path: string[]): PathStep[] | null {
  const mi0 = design.modules.get(top);
  if (!mi0) return null;
  const steps: PathStep[] = [{ inst: '', module: top, params: mi0.params }];
  let cur = mi0;
  for (const name of path) {
    const items = elaborateItems(cur.ast, steps[steps.length - 1].params);
    const found = items.instances.find((x) => x.name === name);
    if (!found) return null;
    const target = design.modules.get(found.inst.module);
    if (!target) return null;
    const params = childParams(found.inst, found.scope.params, target);
    steps.push({ inst: name, module: target.name, params, ast: found.inst });
    cur = target;
  }
  return steps;
}

/** Resolve the connections of an instance to (portName -> expr) pairs, handling positional and .* */
export function resolveConnections(
  inst: { conns: { port: string | null; expr: Expr | null }[]; positional: boolean },
  target: ModuleInfo | undefined,
  parentNets: Iterable<string>,
): { port: string; expr: Expr | null }[] {
  const out: { port: string; expr: Expr | null }[] = [];
  if (inst.positional) {
    inst.conns.forEach((c, i) => {
      const pname = target?.ports[i]?.name ?? `p${i}`;
      out.push({ port: pname, expr: c.expr });
    });
    return out;
  }
  const named = new Set<string>();
  let wildcard = false;
  for (const c of inst.conns) {
    if (c.port === '*') {
      wildcard = true;
      continue;
    }
    if (c.port) {
      named.add(c.port);
      out.push({ port: c.port, expr: c.expr });
    }
  }
  if (wildcard && target) {
    const parent = new Set(parentNets);
    for (const p of target.ports) {
      if (!named.has(p.name) && parent.has(p.name)) {
        out.push({ port: p.name, expr: { kind: 'id', name: p.name, loc: { start: 0, end: 0, line: 0 } } });
      }
    }
  }
  return out;
}

/** Hierarchy tree of instances */
export interface HierNode {
  name: string; // instance name (or module name for top)
  module: string;
  path: string; // top/u_a/u_b
  children: HierNode[];
  isBlackBox: boolean;
  loc?: { start: number; end: number; line: number };
  /** non-default parameters, e.g. "WIDTH=8" */
  paramText?: string;
}

export function buildHierarchy(design: Design, top: string, maxDepth = 64, maxNodes = 20000): HierNode {
  let count = 0;
  const build = (module: string, name: string, path: string, depth: number, params: Map<string, number>, loc?: HierNode['loc'], paramText?: string): HierNode => {
    const mi = design.modules.get(module);
    const node: HierNode = { name, module, path, children: [], isBlackBox: !mi, loc, paramText: paramText || undefined };
    count++;
    if (mi && depth < maxDepth && count < maxNodes) {
      for (const { inst, name: iname, scope } of elaborateItems(mi.ast, params).instances) {
        const label = inst.range ? `${iname}[]` : iname;
        const target = design.modules.get(inst.module);
        node.children.push(build(inst.module, label, `${path}/${iname}`, depth + 1, childParams(inst, scope.params, target), inst.loc, paramSummary(inst, scope.params, target)));
      }
    }
    return node;
  };
  const mi0 = design.modules.get(top);
  return build(top, top, top, 0, mi0?.params ?? new Map());
}
