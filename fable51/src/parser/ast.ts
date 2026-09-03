// AST for the netlist subset of Verilog we understand.

export interface Loc {
  /** 0-based character offset of the first token */
  start: number;
  /** 0-based character offset just past the last token */
  end: number;
  /** 1-based line of the first token */
  line: number;
}

export type Dir = 'input' | 'output' | 'inout';

export interface Range {
  msb: Expr;
  lsb: Expr;
}

export type Expr =
  | { kind: 'id'; name: string; loc: Loc }
  | { kind: 'num'; text: string; value: number | null; width: number | null; loc: Loc }
  | { kind: 'str'; text: string; loc: Loc }
  | { kind: 'select'; base: Expr; index: Expr; loc: Loc }
  | { kind: 'range'; base: Expr; msb: Expr; lsb: Expr; op: ':' | '+:' | '-:'; loc: Loc }
  | { kind: 'concat'; items: Expr[]; loc: Loc }
  | { kind: 'repl'; count: Expr; items: Expr[]; loc: Loc }
  | { kind: 'unary'; op: string; arg: Expr; loc: Loc }
  | { kind: 'binary'; op: string; lhs: Expr; rhs: Expr; loc: Loc }
  | { kind: 'ternary'; cond: Expr; a: Expr; b: Expr; loc: Loc }
  | { kind: 'call'; name: string; args: Expr[]; loc: Loc }
  | { kind: 'empty'; loc: Loc };

export interface PortDecl {
  name: string;
  dir: Dir | null; // null => declared in port list of a non-ANSI module but never given a direction
  range: Range | null;
  loc: Loc;
  /** For non-ANSI `.name(expr)` style port lists (rare): the internal expression */
  internal?: Expr;
}

export interface NetDecl {
  name: string;
  range: Range | null;
  netType: string; // wire, reg, logic, tri, supply0, supply1 ...
  loc: Loc;
  /** unpacked array dimensions, e.g. `logic [31:0] mem [0:255]` */
  unpacked: Range[];
}

export interface SensItem {
  edge: 'posedge' | 'negedge' | null;
  expr: Expr;
}

/** A procedural block (always / always_ff / always_comb / always_latch) reduced to its dataflow. */
export interface ProcBlock {
  kind: 'always' | 'always_ff' | 'always_comb' | 'always_latch';
  /** null for `always_comb`, `@*` and `@(*)` */
  sens: SensItem[] | null;
  /** expressions evaluated by the block (right-hand sides, conditions, indices) */
  reads: Expr[];
  /** left-hand sides assigned by the block */
  writes: { lhs: Expr; nonblocking: boolean; loc: Loc }[];
  /** variables declared inside the block (loop counters, temporaries) - not nets */
  locals: string[];
  loc: Loc;
}

/** Items that can appear in a module body or inside a generate block. */
export interface ItemBag {
  nets: NetDecl[];
  params: ParamDecl[];
  assigns: Assign[];
  instances: Instance[];
  procs: ProcBlock[];
  generates: GenBlock[];
}

export interface GenBody {
  label: string | null;
  items: ItemBag;
}

export type GenBlock =
  | { kind: 'for'; genvar: string; init: Expr; cond: Expr; step: Expr; body: GenBody; loc: Loc }
  | { kind: 'if'; cond: Expr; then: GenBody; else: GenBody | null; loc: Loc }
  | { kind: 'block'; body: GenBody; loc: Loc };

export interface ParamDecl {
  name: string;
  value: Expr | null;
  loc: Loc;
  local: boolean;
}

export interface Assign {
  lhs: Expr;
  rhs: Expr;
  loc: Loc;
}

export interface Connection {
  /** null for positional connections */
  port: string | null;
  expr: Expr | null; // null for unconnected `.a()`
  loc: Loc;
}

export interface ParamOverride {
  name: string | null;
  value: Expr;
}

export interface Instance {
  module: string;
  name: string;
  range: Range | null; // instance array
  params: ParamOverride[];
  conns: Connection[];
  positional: boolean;
  loc: Loc;
}

export interface Module extends ItemBag {
  name: string;
  ports: PortDecl[];
  /** order of names in the header port list (for positional connections) */
  portOrder: string[];
  loc: Loc;
  /** location of the header (module keyword .. ;) */
  headerLoc: Loc;
}

export interface Diagnostic {
  message: string;
  line: number;
  start: number;
  end: number;
  severity: 'error' | 'warning';
}

export interface ParseResult {
  modules: Module[];
  diagnostics: Diagnostic[];
}
