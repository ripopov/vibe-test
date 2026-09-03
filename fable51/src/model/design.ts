import type { Dir, Expr, Module, ParseResult, PortDecl, Range } from '../parser/ast';
import { parseVerilog } from '../parser/parser';

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
  ports: PortInfo[];
  params: Map<string, number>;
  /** number of direct child instances that resolve to defined modules */
  isLeaf: boolean;
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

function buildParams(m: Module): Map<string, number> {
  const params = new Map<string, number>();
  // iterate a few times to resolve forward references
  for (let iter = 0; iter < 3; iter++) {
    for (const p of m.params) {
      if (params.has(p.name)) continue;
      const v = evalConst(p.value, params);
      if (v !== null) params.set(p.name, v);
    }
  }
  return params;
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
    for (const inst of mi.ast.instances) {
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
    for (const inst of mi.ast.instances) s += hierSize(inst.module, seen);
    seen.delete(name);
    sizeCache.set(name, s);
    return s;
  };
  tops = tops.sort((a, b) => hierSize(b, new Set()) - hierSize(a, new Set()));
  if (tops.length === 0 && modules.size) tops = [[...modules.keys()][0]];
  return { modules, blackBoxes, tops, parse };
}

export function loadDesign(src: string): Design {
  return elaborate(parseVerilog(src));
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
}

export function buildHierarchy(design: Design, top: string, maxDepth = 64): HierNode {
  const build = (module: string, name: string, path: string, depth: number, loc?: HierNode['loc']): HierNode => {
    const mi = design.modules.get(module);
    const node: HierNode = { name, module, path, children: [], isBlackBox: !mi, loc };
    if (mi && depth < maxDepth) {
      for (const inst of mi.ast.instances) {
        const label = inst.range ? `${inst.name}[]` : inst.name;
        node.children.push(build(inst.module, label, `${path}/${inst.name}`, depth + 1, inst.loc));
      }
    }
    return node;
  };
  return build(top, top, top, 0);
}
