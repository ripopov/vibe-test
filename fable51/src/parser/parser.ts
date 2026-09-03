import type {
  Assign, Connection, Diagnostic, Dir, Expr, GenBody, Instance, ItemBag, Loc, Module, NetDecl, ParamDecl,
  ParamOverride, ParseResult, PortDecl, ProcBlock, Range, SensItem,
} from './ast';
import { tokenize, type Token, type Macro } from './lexer';

interface ProcCtx {
  reads: Expr[];
  writes: ProcBlock['writes'];
  locals: string[];
}

export function newBag(): ItemBag {
  return { nets: [], params: [], assigns: [], instances: [], procs: [], generates: [] };
}

const KEYWORDS = new Set([
  'module', 'macromodule', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic', 'tri',
  'tri0', 'tri1', 'triand', 'trior', 'wand', 'wor', 'supply0', 'supply1', 'assign', 'parameter',
  'localparam', 'defparam', 'always', 'always_comb', 'always_ff', 'always_latch', 'initial', 'begin',
  'end', 'function', 'endfunction', 'task', 'endtask', 'generate', 'endgenerate', 'genvar', 'integer',
  'real', 'time', 'realtime', 'event', 'if', 'else', 'for', 'while', 'repeat', 'case', 'casex', 'casez',
  'endcase', 'default', 'signed', 'unsigned', 'specify', 'endspecify', 'specparam', 'primitive',
  'endprimitive', 'table', 'endtable', 'fork', 'join', 'bit', 'byte', 'int', 'shortint', 'longint',
  'var', 'timeunit', 'timeprecision', 'package', 'endpackage', 'interface', 'endinterface', 'import',
  'export', 'typedef', 'enum', 'struct', 'union', 'scalared', 'vectored', 'small', 'medium', 'large',
  'string', 'uwire', 'trireg', 'automatic', 'static', 'const', 'program', 'endprogram', 'class',
  'endclass', 'modport', 'clocking', 'endclocking', 'property', 'endproperty', 'sequence',
  'endsequence', 'covergroup', 'endgroup', 'assert', 'assume', 'cover', 'final', 'return',
]);

const NET_TYPES = new Set([
  'wire', 'reg', 'logic', 'tri', 'tri0', 'tri1', 'triand', 'trior', 'wand', 'wor', 'supply0', 'supply1',
  'bit', 'uwire', 'trireg', 'var',
]);

const INT_TYPES = new Set(['integer', 'int', 'byte', 'shortint', 'longint', 'time']);

const BLOCK_STARTERS = new Set(['always', 'always_comb', 'always_ff', 'always_latch', 'initial', 'final']);

const BINARY_PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '~^': 4, '^~': 4, '&': 5,
  '==': 6, '!=': 6, '===': 6, '!==': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '<<<': 8, '>>>': 8,
  '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11,
};

class ParseError extends Error {
  constructor(message: string, public tok: Token) {
    super(message);
  }
}

export class Parser {
  private toks: Token[];
  private pos = 0;
  private diags: Diagnostic[] = [];
  /** while parsing an assignment target, `<=` is the non-blocking operator, not a comparison */
  private lhsMode = false;

  constructor(private src: string, defines?: Map<string, Macro>) {
    this.toks = tokenize(src, { defines, diagnostics: this.diags });
  }

  // ---- token helpers -------------------------------------------------------
  private peek(o = 0): Token {
    return this.toks[Math.min(this.pos + o, this.toks.length - 1)];
  }
  private next(): Token {
    const t = this.toks[this.pos];
    if (this.pos < this.toks.length - 1) this.pos++;
    return t;
  }
  private at(text: string, o = 0): boolean {
    const t = this.peek(o);
    return t.kind !== 'str' && t.kind !== 'eof' && t.text === text;
  }
  private atId(o = 0): boolean {
    const t = this.peek(o);
    return t.kind === 'id' && !KEYWORDS.has(t.text);
  }
  private accept(text: string): Token | null {
    return this.at(text) ? this.next() : null;
  }
  private expect(text: string): Token {
    if (this.at(text)) return this.next();
    throw new ParseError(`expected '${text}' but found '${this.describe(this.peek())}'`, this.peek());
  }
  private expectId(): Token {
    const t = this.peek();
    if (t.kind === 'id') return this.next();
    throw new ParseError(`expected identifier but found '${this.describe(t)}'`, t);
  }
  private describe(t: Token): string {
    return t.kind === 'eof' ? 'end of file' : t.text;
  }
  private loc(from: Token, to?: Token): Loc {
    const last = to ?? this.toks[Math.max(0, this.pos - 1)];
    return { start: from.start, end: Math.max(from.end, last.end), line: from.line };
  }
  private error(message: string, tok: Token, severity: 'error' | 'warning' = 'error') {
    this.diags.push({ message, line: tok.line, start: tok.start, end: tok.end, severity });
  }

  /** Skip a balanced procedural statement (begin..end, if/else, for, case, or up to ';'). */
  private skipStatement() {
    const t = this.peek();
    if (t.kind === 'id') {
      if (t.text === 'begin') {
        this.skipBlock('begin', 'end');
        return;
      }
      if (t.text === 'fork') {
        this.skipBlock('fork', 'join');
        return;
      }
      if (t.text === 'case' || t.text === 'casex' || t.text === 'casez') {
        this.skipBlock(t.text, 'endcase');
        return;
      }
      if (t.text === 'if') {
        this.next();
        this.skipParens();
        this.skipStatement();
        if (this.at('else')) {
          this.next();
          this.skipStatement();
        }
        return;
      }
      if (t.text === 'for' || t.text === 'while' || t.text === 'repeat' || t.text === 'foreach') {
        this.next();
        this.skipParens();
        this.skipStatement();
        return;
      }
      if (t.text === 'forever') {
        this.next();
        this.skipStatement();
        return;
      }
      if (t.text === 'endmodule' || t.text === 'endgenerate') return;
    }
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const c = this.peek();
      if (depth === 0 && c.kind === 'op' && c.text === ';') {
        this.next();
        return;
      }
      if (depth === 0 && c.kind === 'id' && (c.text === 'endmodule' || c.text === 'endgenerate')) return;
      if (c.kind === 'op' && (c.text === '(' || c.text === '[' || c.text === '{')) depth++;
      if (c.kind === 'op' && (c.text === ')' || c.text === ']' || c.text === '}')) depth = Math.max(0, depth - 1);
      this.next();
    }
  }

  private skipParens() {
    if (this.at('(')) {
      this.next();
      this.skipUntilTopLevel([')']);
      this.accept(')');
    }
  }

  /** Skip from `open` keyword to its matching `close`, handling nested pairs. */
  private skipBlock(open: string, close: string) {
    const pairs: Record<string, string> = {
      begin: 'end', fork: 'join', case: 'endcase', casex: 'endcase', casez: 'endcase',
      function: 'endfunction', task: 'endtask', generate: 'endgenerate', specify: 'endspecify',
      module: 'endmodule', primitive: 'endprimitive', table: 'endtable', package: 'endpackage',
      interface: 'endinterface', class: 'endclass', program: 'endprogram',
    };
    const stack: string[] = [];
    if (this.at(open)) {
      this.next();
      stack.push(close);
    }
    while (stack.length && this.peek().kind !== 'eof') {
      const t = this.next();
      if (t.kind !== 'id') continue;
      if (t.text === stack[stack.length - 1]) {
        stack.pop();
        // optional ": label"
        if (this.at(':') && this.peek(1).kind === 'id') {
          this.next();
          this.next();
        }
      } else if (pairs[t.text] && !(t.text === 'module' && open === 'module')) {
        stack.push(pairs[t.text]);
      } else if (t.text === 'endmodule' && close !== 'endmodule') {
        // unterminated block – stop before endmodule so the module still closes
        this.pos--;
        return;
      }
    }
  }

  // ---- expressions ---------------------------------------------------------
  parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const start = this.peek();
    const cond = this.parseBinary(1);
    if (this.accept('?')) {
      const a = this.parseTernary();
      this.expect(':');
      const b = this.parseTernary();
      return { kind: 'ternary', cond, a, b, loc: this.loc(start) };
    }
    return cond;
  }

  private parseBinary(minPrec: number): Expr {
    const start = this.peek();
    let lhs = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op') break;
      const prec = BINARY_PREC[t.text];
      if (prec === undefined || prec < minPrec) break;
      if (this.lhsMode && t.text === '<=') break;
      this.next();
      const rhs = this.parseBinary(prec + 1);
      lhs = { kind: 'binary', op: t.text, lhs, rhs, loc: this.loc(start) };
    }
    return lhs;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && ['+', '-', '!', '~', '&', '~&', '|', '~|', '^', '~^', '^~'].includes(t.text)) {
      this.next();
      const arg = this.parseUnary();
      return { kind: 'unary', op: t.text, arg, loc: this.loc(t) };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(base: Expr): Expr {
    for (;;) {
      if (this.at('[')) {
        const start = this.peek();
        this.next();
        const a = this.parseExpr();
        if (this.at(':') || this.at('+:') || this.at('-:')) {
          const op = this.next().text as ':' | '+:' | '-:';
          const b = this.parseExpr();
          this.expect(']');
          base = { kind: 'range', base, msb: a, lsb: b, op, loc: { start: base.loc.start, end: this.loc(start).end, line: base.loc.line } };
        } else {
          this.expect(']');
          base = { kind: 'select', base, index: a, loc: { start: base.loc.start, end: this.loc(start).end, line: base.loc.line } };
        }
        continue;
      }
      break;
    }
    return base;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.kind === 'num') {
      this.next();
      return { kind: 'num', text: t.text, ...parseNumber(t.text), loc: this.loc(t) };
    }
    if (t.kind === 'str') {
      this.next();
      return { kind: 'str', text: t.text, loc: this.loc(t) };
    }
    if (t.kind === 'id') {
      this.next();
      let name = t.text;
      // hierarchical names a.b.c and package scope p::x
      while ((this.at('.') || this.at('::')) && this.peek(1).kind === 'id') {
        name += this.next().text + this.next().text;
      }
      if (this.at('(') ) {
        // function call (e.g. $signed(x), $clog2(N))
        this.next();
        const args: Expr[] = [];
        if (!this.at(')')) {
          do {
            args.push(this.parseExpr());
          } while (this.accept(','));
        }
        this.expect(')');
        return { kind: 'call', name, args, loc: this.loc(t) };
      }
      return { kind: 'id', name, loc: this.loc(t) };
    }
    if (t.kind === 'op' && t.text === '(') {
      this.next();
      const e = this.parseExpr();
      this.expect(')');
      return { ...e, loc: this.loc(t) } as Expr;
    }
    if (t.kind === 'op' && t.text === '{') {
      this.next();
      if (this.at('}')) {
        this.next();
        return { kind: 'concat', items: [], loc: this.loc(t) };
      }
      const first = this.parseExpr();
      if (this.at('{')) {
        // replication {N{a,b}}
        this.next();
        const items: Expr[] = [];
        if (!this.at('}')) {
          do {
            items.push(this.parseExpr());
          } while (this.accept(','));
        }
        this.expect('}');
        this.expect('}');
        return { kind: 'repl', count: first, items, loc: this.loc(t) };
      }
      const items = [first];
      while (this.accept(',')) items.push(this.parseExpr());
      this.expect('}');
      return { kind: 'concat', items, loc: this.loc(t) };
    }
    throw new ParseError(`unexpected '${this.describe(t)}' in expression`, t);
  }

  private parseRange(): Range | null {
    if (!this.at('[')) return null;
    const save = this.pos;
    try {
      this.next();
      const msb = this.parseExpr();
      if (this.accept(':')) {
        const lsb = this.parseExpr();
        this.expect(']');
        return { msb, lsb };
      }
      // single dimension like [N] (unpacked array size) -> treat as [N-1:0]
      this.expect(']');
      return { msb: { kind: 'binary', op: '-', lhs: msb, rhs: { kind: 'num', text: '1', value: 1, width: null, loc: msb.loc }, loc: msb.loc }, lsb: { kind: 'num', text: '0', value: 0, width: null, loc: msb.loc } };
    } catch (e) {
      this.pos = save;
      throw e;
    }
  }

  // ---- top level ---------------------------------------------------------------
  parse(): ParseResult {
    const modules: Module[] = [];
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'id' && (t.text === 'module' || t.text === 'macromodule')) {
        try {
          modules.push(this.parseModule());
        } catch (e) {
          if (e instanceof ParseError) {
            this.error(e.message, e.tok);
            // recover: skip to endmodule
            while (this.peek().kind !== 'eof' && !this.at('endmodule')) this.next();
            this.accept('endmodule');
          } else throw e;
        }
        continue;
      }
      if (t.kind === 'id' && (t.text === 'primitive' || t.text === 'package' || t.text === 'interface' || t.text === 'program' || t.text === 'class')) {
        this.skipBlock(t.text, t.text === 'primitive' ? 'endprimitive' : t.text === 'package' ? 'endpackage' : t.text === 'interface' ? 'endinterface' : t.text === 'program' ? 'endprogram' : 'endclass');
        continue;
      }
      // stray token outside module
      this.next();
    }
    return { modules, diagnostics: this.diags };
  }

  private parseModule(): Module {
    const kw = this.next(); // module
    const nameTok = this.expectId();
    const mod: Module = {
      name: nameTok.text, ports: [], portOrder: [], ...newBag(),
      loc: this.loc(kw), headerLoc: this.loc(kw),
    };
    // package imports `import pkg::*;`
    while (this.at('import')) this.skipStatement();
    // parameter port list
    if (this.at('#')) {
      this.next();
      this.expect('(');
      this.parseParamPortList(mod);
      this.expect(')');
    }
    // port list
    if (this.at('(')) {
      this.next();
      this.parsePortList(mod);
      this.expect(')');
    }
    this.expect(';');
    mod.headerLoc = this.loc(kw);

    while (this.peek().kind !== 'eof' && !this.at('endmodule')) {
      this.parseItemSafe(mod, mod);
    }
    const endTok = this.expect('endmodule');
    if (this.at(':') && this.peek(1).kind === 'id') {
      this.next();
      this.next();
    }
    mod.loc = this.loc(kw, endTok);
    finalizePorts(mod);
    return mod;
  }

  private parseParamPortList(mod: Module) {
    // #( parameter [type] [range] N = 8, M = 4, parameter W = 2 )
    while (!this.at(')') && this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'id' && (t.text === 'parameter' || t.text === 'localparam')) {
        this.next();
        this.skipDataType();
      }
      if (!this.atId()) {
        // tolerate `type T = ...` and other odd items
        this.skipUntilTopLevel([',', ')']);
        this.accept(',');
        continue;
      }
      const nameTok = this.expectId();
      let value: Expr | null = null;
      if (this.accept('=')) value = this.parseExpr();
      mod.params.push({ name: nameTok.text, value, loc: this.loc(nameTok), local: false });
      if (!this.accept(',')) break;
    }
  }

  /** Skip type keywords and ranges before a declared name. */
  private skipDataType() {
    for (;;) {
      const t = this.peek();
      if (t.kind === 'id' && (NET_TYPES.has(t.text) || INT_TYPES.has(t.text) || t.text === 'signed' || t.text === 'unsigned' || t.text === 'real' || t.text === 'realtime' || t.text === 'string' || t.text === 'scalared' || t.text === 'vectored')) {
        this.next();
        continue;
      }
      if (t.kind === 'id' && t.text === 'type') {
        this.next();
        continue;
      }
      if (this.at('[')) {
        this.parseRange();
        continue;
      }
      break;
    }
  }

  private skipUntilTopLevel(stops: string[]) {
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (depth === 0 && t.kind === 'op' && stops.includes(t.text)) return;
      if (t.kind === 'op' && (t.text === '(' || t.text === '[' || t.text === '{')) depth++;
      if (t.kind === 'op' && (t.text === ')' || t.text === ']' || t.text === '}')) {
        if (depth === 0) return;
        depth--;
      }
      this.next();
    }
  }

  private parsePortList(mod: Module) {
    if (this.at(')')) return;
    let curDir: Dir | null = null;
    let curRange: Range | null = null;
    let ansi = false;
    while (!this.at(')') && this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'id' && (t.text === 'input' || t.text === 'output' || t.text === 'inout')) {
        ansi = true;
        curDir = this.next().text as Dir;
        // optional net type / var / signed / range
        curRange = null;
        while (this.peek().kind === 'id' && (NET_TYPES.has(this.peek().text) || INT_TYPES.has(this.peek().text) || this.peek().text === 'signed' || this.peek().text === 'unsigned')) this.next();
        // user-defined type name followed by identifier (SystemVerilog) - tolerate: id id
        if (this.atId() && this.peek(1).kind === 'id' && !this.at('[', 1)) this.next();
        if (this.at('[')) curRange = this.parseRange();
      } else if (t.kind === 'id' && t.text === 'interface') {
        // interface port - skip name
        this.next();
        this.accept('.');
        if (this.atId()) this.next();
      }
      if (this.at('.') && this.peek(1).kind === 'id' && this.at('(', 2)) {
        // non-ANSI explicit port: .name(expr)
        this.next();
        const nameTok = this.expectId();
        this.expect('(');
        const internal = this.at(')') ? null : this.parseExpr();
        this.expect(')');
        mod.portOrder.push(nameTok.text);
        mod.ports.push({ name: nameTok.text, dir: null, range: null, loc: this.loc(nameTok), internal: internal ?? undefined });
      } else if (this.atId() || this.peek().kind === 'id') {
        const nameTok = this.next();
        if (ansi) {
          // trailing unpacked dims or default value
          while (this.at('[')) this.parseRange();
          if (this.accept('=')) this.parseExpr();
          mod.portOrder.push(nameTok.text);
          mod.ports.push({ name: nameTok.text, dir: curDir, range: curRange, loc: this.loc(nameTok) });
        } else {
          // non-ANSI: just names (maybe with select like a[3:0] which we ignore)
          while (this.at('[')) this.parseRange();
          mod.portOrder.push(nameTok.text);
          mod.ports.push({ name: nameTok.text, dir: null, range: null, loc: this.loc(nameTok) });
        }
      } else if (this.at('{')) {
        // concatenated port expression in non-ANSI list: rare; skip
        this.parseExpr();
      } else {
        throw new ParseError(`unexpected '${this.describe(t)}' in port list`, t);
      }
      if (!this.accept(',')) break;
    }
  }

  private parseItemSafe(bag: ItemBag, mod: Module) {
    const before = this.pos;
    try {
      this.parseItem(bag, mod);
    } catch (e) {
      if (e instanceof ParseError) {
        this.error(e.message, e.tok);
        this.pos = Math.max(before, this.pos);
        this.skipStatement();
      } else throw e;
    }
    if (this.pos === before) this.next(); // guarantee progress
  }

  private parseItem(bag: ItemBag, mod: Module) {
    const t = this.peek();
    if (t.kind !== 'id') {
      if (t.kind === 'op' && t.text === ';') {
        this.next();
        return;
      }
      throw new ParseError(`unexpected '${this.describe(t)}'`, t);
    }
    switch (t.text) {
      case 'input':
      case 'output':
      case 'inout':
        this.parsePortDecl(mod);
        return;
      case 'parameter':
      case 'localparam':
        this.parseParamDecl(bag);
        return;
      case 'assign':
        this.parseAssign(bag);
        return;
      case 'defparam':
      case 'genvar':
      case 'specparam':
      case 'import':
      case 'timeunit':
      case 'timeprecision':
      case 'typedef':
      case 'real':
      case 'realtime':
      case 'event':
        this.skipStatement();
        return;
      case 'generate':
        this.next();
        return; // treat contents as module items
      case 'endgenerate':
        this.next();
        return;
      case 'function':
        this.skipBlock('function', 'endfunction');
        return;
      case 'task':
        this.skipBlock('task', 'endtask');
        return;
      case 'specify':
        this.skipBlock('specify', 'endspecify');
        return;
      case 'for':
        this.parseGenFor(bag, mod);
        return;
      case 'if':
        this.parseGenIf(bag, mod);
        return;
      case 'case':
        // generate case: not elaborated
        this.error(`generate '${t.text}' block skipped (not elaborated)`, t, 'warning');
        this.skipGenerateConstruct();
        return;
      case 'begin': {
        const body = this.parseGenBody(mod);
        bag.generates.push({ kind: 'block', body, loc: this.loc(t) });
        return;
      }
    }
    if (BLOCK_STARTERS.has(t.text)) {
      this.parseProc(bag);
      return;
    }
    if (NET_TYPES.has(t.text) || INT_TYPES.has(t.text)) {
      this.parseNetDecl(bag);
      return;
    }
    if (!KEYWORDS.has(t.text)) {
      // instantiation: module_name [#(...)] inst_name [range] ( ... ) ;
      const n1 = this.peek(1);
      if ((n1.kind === 'op' && n1.text === '#') || (n1.kind === 'id' && !KEYWORDS.has(n1.text)) || (n1.kind === 'op' && n1.text === '(' )) {
        this.parseInstantiation(bag);
        return;
      }
      // user-defined type declaration: mytype_t x;  -> treat as net of unknown width
      if (n1.kind === 'op' && n1.text === '[') {
        this.parseNetDecl(bag);
        return;
      }
    }
    throw new ParseError(`unexpected '${t.text}'`, t);
  }

  // ---- generate blocks -----------------------------------------------------

  private parseGenBody(mod: Module): GenBody {
    const items = newBag();
    let label: string | null = null;
    if (this.at('begin')) {
      this.next();
      if (this.accept(':')) label = this.expectId().text;
      while (!this.at('end') && !this.at('endmodule') && this.peek().kind !== 'eof') this.parseItemSafe(items, mod);
      this.expect('end');
      if (this.accept(':')) this.expectId();
    } else {
      this.parseItemSafe(items, mod);
    }
    return { label, items };
  }

  private parseGenFor(bag: ItemBag, mod: Module) {
    const kw = this.next();
    this.expect('(');
    this.accept('genvar');
    const varTok = this.expectId();
    this.expect('=');
    const init = this.parseExpr();
    this.expect(';');
    const cond = this.parseExpr();
    this.expect(';');
    const stepVar = this.expectId();
    const v: Expr = { kind: 'id', name: stepVar.text, loc: this.loc(stepVar, stepVar) };
    const one: Expr = { kind: 'num', text: '1', value: 1, width: null, loc: v.loc };
    let step: Expr;
    if (this.accept('++')) step = { kind: 'binary', op: '+', lhs: v, rhs: one, loc: v.loc };
    else if (this.accept('--')) step = { kind: 'binary', op: '-', lhs: v, rhs: one, loc: v.loc };
    else if (this.accept('+=')) step = { kind: 'binary', op: '+', lhs: v, rhs: this.parseExpr(), loc: v.loc };
    else if (this.accept('-=')) step = { kind: 'binary', op: '-', lhs: v, rhs: this.parseExpr(), loc: v.loc };
    else {
      this.expect('=');
      step = this.parseExpr();
    }
    this.expect(')');
    const body = this.parseGenBody(mod);
    bag.generates.push({ kind: 'for', genvar: varTok.text, init, cond, step, body, loc: this.loc(kw) });
  }

  private parseGenIf(bag: ItemBag, mod: Module) {
    const kw = this.next();
    this.expect('(');
    const cond = this.parseExpr();
    this.expect(')');
    const then = this.parseGenBody(mod);
    let els: GenBody | null = null;
    if (this.accept('else')) {
      if (this.at('if')) {
        const inner = newBag();
        this.parseGenIf(inner, mod);
        els = { label: null, items: inner };
      } else els = this.parseGenBody(mod);
    }
    bag.generates.push({ kind: 'if', cond, then, else: els, loc: this.loc(kw) });
  }

  // ---- procedural blocks ---------------------------------------------------

  /** always / always_ff / always_comb / always_latch / initial / final */
  private parseProc(bag: ItemBag) {
    const kw = this.next();
    const kind = kw.text === 'initial' || kw.text === 'final' ? null : (kw.text as ProcBlock['kind']);
    let sens: SensItem[] | null = null;
    if (this.at('#')) {
      this.next();
      if (this.at('(')) this.skipParens();
      else this.next();
    }
    if (this.accept('@')) {
      if (this.at('*')) this.next();
      else if (this.at('(')) {
        this.next();
        if (this.at('*')) this.next();
        else {
          sens = [];
          while (!this.at(')') && this.peek().kind !== 'eof') {
            let edge: SensItem['edge'] = null;
            if (this.at('posedge') || this.at('negedge')) edge = this.next().text as 'posedge' | 'negedge';
            else if (this.at('edge')) this.next();
            const expr = this.parseExpr();
            sens.push({ edge, expr });
            if (!this.accept(',') && !this.accept('or')) break;
          }
        }
        this.expect(')');
      } else if (this.peek().kind === 'id') {
        const t = this.next();
        sens = [{ edge: null, expr: { kind: 'id', name: t.text, loc: this.loc(t, t) } }];
      }
    }
    const ctx: ProcCtx = { reads: [], writes: [], locals: [] };
    this.parseStatement(ctx);
    if (kind) bag.procs.push({ kind, sens, reads: ctx.reads, writes: ctx.writes, locals: ctx.locals, loc: this.loc(kw) });
  }

  /** Parse one statement, recovering at the next ';' on errors. */
  private parseStatement(ctx: ProcCtx) {
    const before = this.pos;
    try {
      this.parseStatementInner(ctx);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.error(e.message, e.tok);
      this.pos = Math.max(before, this.pos);
      this.skipToStatementEnd();
    }
  }

  /** Skip to just past the next ';' at nesting depth 0, stopping before a block closer. */
  private skipToStatementEnd() {
    let depth = 0;
    const closers = new Set(['end', 'endcase', 'endmodule', 'join', 'join_any', 'join_none', 'endfunction', 'endtask', 'else']);
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (depth === 0 && t.kind === 'op' && t.text === ';') {
        this.next();
        return;
      }
      if (depth === 0 && t.kind === 'id' && closers.has(t.text)) return;
      if (t.kind === 'op' && (t.text === '(' || t.text === '[' || t.text === '{')) depth++;
      if (t.kind === 'op' && (t.text === ')' || t.text === ']' || t.text === '}')) depth = Math.max(0, depth - 1);
      this.next();
    }
  }

  private skipTimingControl() {
    if (this.at('#')) {
      this.next();
      if (this.at('(')) this.skipParens();
      else this.next();
    } else if (this.at('@')) {
      this.next();
      if (this.at('(')) this.skipParens();
      else this.next();
    }
  }

  private parseStatementInner(ctx: ProcCtx) {
    const t = this.peek();
    if (t.kind === 'op') {
      if (t.text === ';') {
        this.next();
        return;
      }
      if (t.text === '#' || t.text === '@') {
        this.skipTimingControl();
        this.parseStatementInner(ctx);
        return;
      }
      if (t.text === '{') {
        this.parseProcAssign(ctx);
        return;
      }
      if (t.text === '->') {
        this.skipToStatementEnd();
        return;
      }
      throw new ParseError(`unexpected '${t.text}' in statement`, t);
    }
    if (t.kind !== 'id') throw new ParseError(`unexpected '${this.describe(t)}' in statement`, t);
    // labeled statement
    if (!KEYWORDS.has(t.text) && this.at(':', 1)) {
      this.next();
      this.next();
      this.parseStatementInner(ctx);
      return;
    }
    switch (t.text) {
      case 'begin':
        this.parseStmtBlock(ctx, ['end']);
        return;
      case 'fork':
        this.parseStmtBlock(ctx, ['join', 'join_any', 'join_none']);
        return;
      case 'unique':
      case 'unique0':
      case 'priority':
        this.next();
        this.parseStatementInner(ctx);
        return;
      case 'if': {
        this.next();
        this.expect('(');
        ctx.reads.push(this.parseExpr());
        this.expect(')');
        this.parseStatement(ctx);
        if (this.accept('else')) this.parseStatement(ctx);
        return;
      }
      case 'case':
      case 'casex':
      case 'casez':
        this.parseCase(ctx);
        return;
      case 'for':
        this.parseFor(ctx);
        return;
      case 'while':
      case 'repeat':
      case 'wait': {
        this.next();
        this.expect('(');
        ctx.reads.push(this.parseExpr());
        this.expect(')');
        this.parseStatement(ctx);
        return;
      }
      case 'forever':
        this.next();
        this.parseStatement(ctx);
        return;
      case 'do': {
        this.next();
        this.parseStatement(ctx);
        this.expect('while');
        this.expect('(');
        ctx.reads.push(this.parseExpr());
        this.expect(')');
        this.expect(';');
        return;
      }
      case 'foreach':
        this.next();
        this.skipParens();
        this.parseStatement(ctx);
        return;
      case 'disable':
      case 'return':
      case 'break':
      case 'continue':
      case 'assert':
      case 'assume':
      case 'cover':
      case 'deassign':
      case 'release':
        this.skipToStatementEnd();
        return;
      case 'assign':
      case 'force':
        this.next();
        this.parseProcAssign(ctx);
        return;
      case 'end':
      case 'endcase':
      case 'endmodule':
      case 'join':
      case 'else':
        throw new ParseError(`unexpected '${t.text}'`, t);
    }
    // local declarations: integer i; logic [3:0] tmp = x;
    if (NET_TYPES.has(t.text) || INT_TYPES.has(t.text) || t.text === 'real' || t.text === 'realtime' || t.text === 'genvar' || t.text === 'string' || t.text === 'automatic' || t.text === 'static') {
      if (t.text === 'automatic' || t.text === 'static' || t.text === 'genvar') this.next();
      const scratch = newBag();
      this.parseNetDecl(scratch);
      for (const nd of scratch.nets) ctx.locals.push(nd.name);
      for (const a of scratch.assigns) ctx.reads.push(a.rhs);
      return;
    }
    if (t.text.startsWith('$')) {
      // system task ($display, $readmemh, ...): no dataflow
      this.skipToStatementEnd();
      return;
    }
    // user-defined type declaration `mytype_t x;`
    if (this.peek(1).kind === 'id' && !KEYWORDS.has(this.peek(1).text)) {
      const scratch = newBag();
      this.next();
      this.parseNetDecl(scratch);
      for (const nd of scratch.nets) ctx.locals.push(nd.name);
      return;
    }
    this.parseProcAssign(ctx);
  }

  private parseStmtBlock(ctx: ProcCtx, closers: string[]) {
    this.next(); // begin / fork
    if (this.accept(':')) this.expectId();
    while (!closers.some((c) => this.at(c)) && !this.at('endmodule') && this.peek().kind !== 'eof') {
      const before = this.pos;
      this.parseStatement(ctx);
      if (this.pos === before) this.next();
    }
    if (closers.some((c) => this.at(c))) {
      this.next();
      if (this.at(':') && this.peek(1).kind === 'id') {
        this.next();
        this.next();
      }
    }
  }

  private parseCase(ctx: ProcCtx) {
    this.next();
    this.expect('(');
    ctx.reads.push(this.parseExpr());
    this.expect(')');
    this.accept('inside');
    while (!this.at('endcase') && !this.at('endmodule') && this.peek().kind !== 'eof') {
      const before = this.pos;
      try {
        if (this.at('default')) {
          this.next();
          this.accept(':');
          this.parseStatement(ctx);
        } else {
          do {
            if (this.at('[')) {
              // value range [a:b] (case inside)
              this.next();
              ctx.reads.push(this.parseExpr());
              this.expect(':');
              ctx.reads.push(this.parseExpr());
              this.expect(']');
            } else ctx.reads.push(this.parseExpr());
          } while (this.accept(','));
          this.expect(':');
          this.parseStatement(ctx);
        }
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.error(e.message, e.tok);
        this.skipToStatementEnd();
      }
      if (this.pos === before) this.next();
    }
    this.expect('endcase');
  }

  private parseFor(ctx: ProcCtx) {
    this.next();
    this.expect('(');
    if (!this.at(';')) {
      // init: [type] var = expr {, var = expr}
      if (this.peek().kind === 'id' && (INT_TYPES.has(this.peek().text) || NET_TYPES.has(this.peek().text) || (this.peek(1).kind === 'id' && !KEYWORDS.has(this.peek(1).text)))) {
        this.next();
        while (this.at('[')) this.parseRange();
      }
      do {
        const v = this.expectId();
        ctx.locals.push(v.text);
        if (this.accept('=')) ctx.reads.push(this.parseExpr());
      } while (this.accept(','));
    }
    this.expect(';');
    if (!this.at(';')) ctx.reads.push(this.parseExpr());
    this.expect(';');
    if (!this.at(')')) {
      do {
        this.lhsMode = true;
        let e: Expr;
        try {
          e = this.parseExpr();
        } finally {
          this.lhsMode = false;
        }
        if (this.at('++') || this.at('--')) this.next();
        else if (this.peek().kind === 'op' && /^([-+*\/&|^%]|<<|>>)?=$/.test(this.peek().text)) {
          this.next();
          ctx.reads.push(this.parseExpr());
        }
        void e;
      } while (this.accept(','));
    }
    this.expect(')');
    this.parseStatement(ctx);
  }

  /** lhs = rhs; lhs <= rhs; lhs op= rhs; lhs++; task(args); */
  private parseProcAssign(ctx: ProcCtx) {
    const start = this.peek();
    this.lhsMode = true;
    let lhs: Expr;
    try {
      lhs = this.parseExpr();
    } finally {
      this.lhsMode = false;
    }
    if (lhs.kind === 'call') {
      // task call: arguments may be read (and written, for output args - treated as reads)
      for (const a of lhs.args) ctx.reads.push(a);
      this.expect(';');
      return;
    }
    const opTok = this.peek();
    if (opTok.kind === 'op' && (opTok.text === '++' || opTok.text === '--')) {
      this.next();
      ctx.writes.push({ lhs, nonblocking: false, loc: this.loc(start) });
      ctx.reads.push(lhs);
      this.expect(';');
      return;
    }
    if (opTok.kind === 'op' && /^(<=|=|[-+*\/&|^%]=|<<=|>>=|<<<=|>>>=)$/.test(opTok.text)) {
      this.next();
      this.skipTimingControl();
      const rhs = this.parseExpr();
      ctx.writes.push({ lhs, nonblocking: opTok.text === '<=', loc: this.loc(start) });
      ctx.reads.push(rhs);
      if (opTok.text !== '=' && opTok.text !== '<=') ctx.reads.push(lhs);
      this.addIndexReads(lhs, ctx);
      this.expect(';');
      return;
    }
    throw new ParseError(`expected assignment but found '${this.describe(opTok)}'`, opTok);
  }

  /** Indices used on the left-hand side (mem[addr] <= x) are read by the block. */
  private addIndexReads(lhs: Expr, ctx: ProcCtx) {
    switch (lhs.kind) {
      case 'select':
        ctx.reads.push(lhs.index);
        this.addIndexReads(lhs.base, ctx);
        break;
      case 'range':
        ctx.reads.push(lhs.msb);
        ctx.reads.push(lhs.lsb);
        this.addIndexReads(lhs.base, ctx);
        break;
      case 'concat':
        lhs.items.forEach((i) => this.addIndexReads(i, ctx));
        break;
    }
  }

  private skipGenerateConstruct() {
    // for (...) stmt | if (...) stmt [else stmt] | case (...) ... endcase
    const kw = this.next();
    if (kw.text === 'case') {
      this.skipBlock('case', 'endcase');
      return;
    }
    if (this.at('(')) {
      this.next();
      this.skipUntilTopLevel([')']);
      this.expect(')');
    }
    this.skipGenerateBody();
    if (kw.text === 'if' && this.at('else')) {
      this.next();
      if (this.at('if')) {
        this.skipGenerateConstruct();
      } else this.skipGenerateBody();
    }
  }

  private skipGenerateBody() {
    if (this.at('begin')) {
      this.skipBlock('begin', 'end');
      return;
    }
    if (this.at('for') || this.at('if') || this.at('case')) {
      this.skipGenerateConstruct();
      return;
    }
    // single item
    const before = this.pos;
    this.skipStatement();
    if (this.pos === before) this.next();
  }

  private parsePortDecl(mod: Module) {
    const dir = this.next().text as Dir;
    while (this.peek().kind === 'id' && (NET_TYPES.has(this.peek().text) || INT_TYPES.has(this.peek().text) || this.peek().text === 'signed' || this.peek().text === 'unsigned')) this.next();
    if (this.atId() && this.peek(1).kind === 'id') this.next(); // user type
    const range = this.parseRange();
    do {
      const nameTok = this.expectId();
      while (this.at('[')) this.parseRange();
      if (this.accept('=')) this.parseExpr();
      const existing = mod.ports.find((p) => p.name === nameTok.text);
      if (existing) {
        existing.dir = dir;
        existing.range = range;
        existing.loc = this.loc(nameTok);
      } else {
        mod.ports.push({ name: nameTok.text, dir, range, loc: this.loc(nameTok) });
        if (!mod.portOrder.includes(nameTok.text)) mod.portOrder.push(nameTok.text);
      }
    } while (this.accept(','));
    this.expect(';');
  }

  private parseParamDecl(mod: ItemBag) {
    const kw = this.next();
    this.skipDataType();
    do {
      if (!this.atId()) throw new ParseError(`expected parameter name`, this.peek());
      const nameTok = this.expectId();
      let value: Expr | null = null;
      if (this.accept('=')) value = this.parseExpr();
      mod.params.push({ name: nameTok.text, value, loc: this.loc(nameTok), local: kw.text === 'localparam' });
    } while (this.accept(','));
    this.expect(';');
  }

  private parseNetDecl(mod: ItemBag) {
    const typeTok = this.next();
    let netType = typeTok.text;
    if (netType === 'var' && this.peek().kind === 'id' && NET_TYPES.has(this.peek().text)) netType = this.next().text;
    // drive strength / charge strength (supply0, (strong0, ...)) - skip parens
    if (this.at('(')) {
      this.next();
      this.skipUntilTopLevel([')']);
      this.expect(')');
    }
    while (this.peek().kind === 'id' && (this.peek().text === 'signed' || this.peek().text === 'unsigned' || this.peek().text === 'scalared' || this.peek().text === 'vectored' || (NET_TYPES.has(this.peek().text) && netType === 'reg'))) this.next();
    let range = this.parseRange();
    if (INT_TYPES.has(netType) && !range) {
      const w = netType === 'byte' ? 8 : netType === 'shortint' ? 16 : netType === 'longint' || netType === 'time' ? 64 : 32;
      const fake: Loc = this.loc(typeTok);
      range = { msb: { kind: 'num', text: String(w - 1), value: w - 1, width: null, loc: fake }, lsb: { kind: 'num', text: '0', value: 0, width: null, loc: fake } };
    }
    // delay #(...)
    if (this.at('#')) {
      this.next();
      if (this.at('(')) {
        this.next();
        this.skipUntilTopLevel([')']);
        this.expect(')');
      } else this.next();
    }
    do {
      const nameTok = this.expectId();
      const unpacked: Range[] = [];
      while (this.at('[')) {
        const r = this.parseRange();
        if (r) unpacked.push(r);
      }
      const net: NetDecl = { name: nameTok.text, range, netType, loc: this.loc(nameTok), unpacked };
      mod.nets.push(net);
      if (this.accept('=')) {
        const rhs = this.parseExpr();
        mod.assigns.push({ lhs: { kind: 'id', name: nameTok.text, loc: this.loc(nameTok, nameTok) }, rhs, loc: this.loc(nameTok) });
      }
    } while (this.accept(','));
    this.expect(';');
  }

  private parseAssign(mod: ItemBag) {
    this.next(); // assign
    // optional drive strength / delay
    if (this.at('(')) {
      this.next();
      this.skipUntilTopLevel([')']);
      this.expect(')');
    }
    if (this.at('#')) {
      this.next();
      if (this.at('(')) {
        this.next();
        this.skipUntilTopLevel([')']);
        this.expect(')');
      } else this.next();
    }
    do {
      const start = this.peek();
      const lhs = this.parseExpr();
      this.expect('=');
      const rhs = this.parseExpr();
      mod.assigns.push({ lhs, rhs, loc: this.loc(start) });
    } while (this.accept(','));
    this.expect(';');
  }

  private parseInstantiation(mod: ItemBag) {
    const modTok = this.expectId();
    const params: ParamOverride[] = [];
    if (this.accept('#')) {
      if (this.at('(')) {
        this.next();
        if (!this.at(')')) {
          do {
            if (this.at('.')) {
              this.next();
              const p = this.expectId();
              this.expect('(');
              const value = this.at(')') ? null : this.parseExpr();
              this.expect(')');
              if (value) params.push({ name: p.text, value });
            } else {
              params.push({ name: null, value: this.parseExpr() });
            }
          } while (this.accept(','));
        }
        this.expect(')');
      } else {
        this.next(); // #10 delay
      }
    }
    do {
      let nameTok: Token | null = null;
      if (this.peek().kind === 'id') nameTok = this.next();
      const range = this.parseRange();
      const open = this.expect('(');
      const inst: Instance = {
        module: modTok.text,
        name: nameTok ? nameTok.text : `u_${modTok.text}_${open.line}`,
        range, params, conns: [], positional: false,
        loc: this.loc(modTok),
      };
      if (!this.at(')')) {
        if (this.at('.') || this.at('.*')) {
          // named connections
          do {
            if (this.at(')')) break;
            if (this.at('.*')) {
              const star = this.next();
              inst.conns.push({ port: '*', expr: null, loc: this.loc(star) });
              continue;
            }
            const dot = this.expect('.');
            const p = this.expectId();
            if (this.at('(')) {
              this.next();
              const expr = this.at(')') ? null : this.parseExpr();
              this.expect(')');
              inst.conns.push({ port: p.text, expr, loc: this.loc(dot) });
            } else {
              // .name shorthand for .name(name)
              inst.conns.push({ port: p.text, expr: { kind: 'id', name: p.text, loc: this.loc(p, p) }, loc: this.loc(dot) });
            }
          } while (this.accept(','));
        } else {
          inst.positional = true;
          for (;;) {
            const t = this.peek();
            if (this.at(',')) {
              inst.conns.push({ port: null, expr: null, loc: this.loc(t, t) });
              this.next();
              continue;
            }
            if (this.at(')')) {
              // trailing empty after comma
              if (inst.conns.length && this.toks[this.pos - 1].text === ',') inst.conns.push({ port: null, expr: null, loc: this.loc(t, t) });
              break;
            }
            const expr = this.parseExpr();
            inst.conns.push({ port: null, expr, loc: this.loc(t) });
            if (!this.accept(',')) break;
            if (this.at(')')) {
              inst.conns.push({ port: null, expr: null, loc: this.loc(this.peek(), this.peek()) });
              break;
            }
          }
        }
      }
      const close = this.expect(')');
      inst.loc = this.loc(modTok, close);
      mod.instances.push(inst);
    } while (this.accept(','));
    this.expect(';');
    // include the semicolon
    const last = mod.instances[mod.instances.length - 1];
    if (last) last.loc.end = this.toks[this.pos - 1].end;
  }
}

/** Assign directions to ports declared only in the header (non-ANSI without body decl) */
function finalizePorts(mod: Module) {
  // Reorder ports to header order
  const byName = new Map(mod.ports.map((p) => [p.name, p]));
  const ordered: PortDecl[] = [];
  for (const n of mod.portOrder) {
    const p = byName.get(n);
    if (p) {
      ordered.push(p);
      byName.delete(n);
    }
  }
  for (const p of byName.values()) ordered.push(p);
  mod.ports = ordered;
  // Ports without a range may have a net declaration with a range (e.g. `output y; wire [3:0] y;`)
  for (const p of mod.ports) {
    if (!p.range) {
      const nd = mod.nets.find((n) => n.name === p.name);
      if (nd && nd.range) p.range = nd.range;
    }
  }
}

export function parseNumber(text: string): { value: number | null; width: number | null } {
  const m = /^(\d[\d_]*)?\s*'\s*([sS])?([bBoOdDhH])\s*([0-9a-fA-FxXzZ?_]+)$/.exec(text);
  if (m) {
    const width = m[1] ? parseInt(m[1].replace(/_/g, ''), 10) : null;
    const base = m[3].toLowerCase();
    const digits = m[4].replace(/_/g, '');
    if (/[xXzZ?]/.test(digits)) return { value: null, width: width ?? 32 };
    const radix = base === 'b' ? 2 : base === 'o' ? 8 : base === 'd' ? 10 : 16;
    const v = parseInt(digits, radix);
    let w = width;
    if (w === null) {
      const bitsPerDigit = base === 'b' ? 1 : base === 'o' ? 3 : base === 'h' ? 4 : 0;
      w = bitsPerDigit ? digits.length * bitsPerDigit : 32;
    }
    return { value: Number.isNaN(v) ? null : v, width: w };
  }
  const v = Number(text.replace(/_/g, ''));
  return { value: Number.isNaN(v) ? null : v, width: null };
}

export function parseVerilog(src: string, defines?: Map<string, Macro>): ParseResult {
  return new Parser(src, defines).parse();
}

/** Render an expression back to compact Verilog text (used for labels/tooltips). */
export function exprToString(e: Expr): string {
  switch (e.kind) {
    case 'id':
      return e.name;
    case 'num':
      return e.text;
    case 'str':
      return e.text;
    case 'select':
      return `${exprToString(e.base)}[${exprToString(e.index)}]`;
    case 'range':
      return `${exprToString(e.base)}[${exprToString(e.msb)}${e.op}${exprToString(e.lsb)}]`;
    case 'concat':
      return `{${e.items.map(exprToString).join(', ')}}`;
    case 'repl':
      return `{${exprToString(e.count)}{${e.items.map(exprToString).join(', ')}}}`;
    case 'unary':
      return `${e.op}${wrap(e.arg)}`;
    case 'binary':
      return `${wrap(e.lhs)} ${e.op} ${wrap(e.rhs)}`;
    case 'ternary':
      return `${wrap(e.cond)} ? ${wrap(e.a)} : ${wrap(e.b)}`;
    case 'call':
      return `${e.name}(${e.args.map(exprToString).join(', ')})`;
    case 'empty':
      return '';
  }
}
function wrap(e: Expr): string {
  const s = exprToString(e);
  return e.kind === 'binary' || e.kind === 'ternary' ? `(${s})` : s;
}

/** Collect identifiers referenced by an expression (nets), excluding constants. */
export function collectIds(e: Expr, out: Set<string> = new Set()): Set<string> {
  switch (e.kind) {
    case 'id':
      out.add(e.name);
      break;
    case 'select':
      collectIds(e.base, out);
      break;
    case 'range':
      collectIds(e.base, out);
      break;
    case 'concat':
      e.items.forEach((i) => collectIds(i, out));
      break;
    case 'repl':
      e.items.forEach((i) => collectIds(i, out));
      break;
    case 'unary':
      collectIds(e.arg, out);
      break;
    case 'binary':
      collectIds(e.lhs, out);
      collectIds(e.rhs, out);
      break;
    case 'ternary':
      collectIds(e.cond, out);
      collectIds(e.a, out);
      collectIds(e.b, out);
      break;
    case 'call':
      e.args.forEach((i) => collectIds(i, out));
      break;
  }
  return out;
}
