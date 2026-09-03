import type { Diagnostic } from './ast';

export type TokKind = 'id' | 'num' | 'str' | 'op' | 'eof';

export interface Token {
  kind: TokKind;
  text: string;
  start: number;
  end: number;
  line: number;
}

export interface Macro {
  params: string[] | null;
  body: string;
}

export interface LexOptions {
  /** predefined macros; the map is extended by `define directives found in the source */
  defines?: Map<string, Macro>;
  /** receives warnings (undefined macros, unbalanced `ifdef ...) */
  diagnostics?: Diagnostic[];
}

const PUNCT3 = ['<<<', '>>>', '===', '!==', '**=', '<<=', '>>=', '+:', '-:'];
const PUNCT2 = ['<=', '>=', '==', '!=', '&&', '||', '<<', '>>', '**', '~&', '~|', '~^', '^~', '->', '::', '+:', '-:', '++', '--', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '.*'];

/** directives that take the rest of the line and are otherwise ignored */
const LINE_DIRECTIVES = new Set([
  'include', 'timescale', 'default_nettype', 'resetall', 'line', 'pragma', 'celldefine', 'endcelldefine',
  'unconnected_drive', 'nounconnected_drive', 'begin_keywords', 'end_keywords', 'protect', 'endprotect',
  'undefineall', 'define', 'undef',
]);

function isIdStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}
function isIdChar(c: string): boolean {
  return isIdStart(c) || (c >= '0' && c <= '9');
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/**
 * Tokenize Verilog source. Comments and attributes `(* ... *)` are skipped. Compiler
 * directives are preprocessed: `define/`undef, `ifdef/`ifndef/`elsif/`else/`endif and macro
 * usages `NAME / `NAME(args). Tokens produced by a macro expansion carry the location of the
 * macro usage so editor synchronisation keeps working. Tolerant: unknown characters are
 * emitted as 'op'.
 */
export function tokenize(src: string, opts: LexOptions = {}): Token[] {
  const lx = new Lexer(opts.defines ?? new Map(), opts.diagnostics ?? []);
  const toks = lx.scan(src, null, 0);
  toks.push({ kind: 'eof', text: '', start: src.length, end: src.length, line: lx.lastLine });
  return toks;
}

interface Cond {
  /** tokens are emitted in the current branch */
  active: boolean;
  /** some branch of this if-chain has already been taken */
  taken: boolean;
  /** the enclosing region was active */
  outer: boolean;
}

class Lexer {
  lastLine = 1;

  constructor(private defines: Map<string, Macro>, private diags: Diagnostic[]) {}

  private warn(message: string, start: number, end: number, line: number) {
    this.diags.push({ message, line, start, end, severity: 'warning' });
  }

  /**
   * @param fixed when set, every token is stamped with this location (macro expansion)
   */
  scan(src: string, fixed: { start: number; end: number; line: number } | null, depth: number): Token[] {
    const toks: Token[] = [];
    const n = src.length;
    let i = 0;
    let line = fixed ? fixed.line : 1;
    const conds: Cond[] = [];
    const active = () => conds.length === 0 || conds[conds.length - 1].active;
    const push = (kind: TokKind, start: number, end: number, text?: string) => {
      if (!active()) return;
      const t = text ?? src.slice(start, end);
      if (fixed) toks.push({ kind, text: t, start: fixed.start, end: fixed.end, line: fixed.line });
      else toks.push({ kind, text: t, start, end, line });
    };

    while (i < n) {
      const c = src[i];
      if (c === '\n') {
        line++;
        i++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
        i++;
        continue;
      }
      // comments
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        const stop = e < 0 ? n : e + 2;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
        continue;
      }
      // attributes (* ... *)
      if (c === '(' && src[i + 1] === '*' && src[i + 2] !== ')') {
        const e = src.indexOf('*)', i + 2);
        const stop = e < 0 ? n : e + 2;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
        continue;
      }
      // compiler directives and macro usages
      if (c === '`') {
        let j = i + 1;
        while (j < n && isIdChar(src[j])) j++;
        const name = src.slice(i + 1, j);
        const dirStart = i;
        const dirLine = line;
        const restOfLine = (): { text: string; end: number } => {
          // rest of line with backslash continuations
          let k = j;
          let text = '';
          for (;;) {
            const nl = src.indexOf('\n', k);
            const stop = nl < 0 ? n : nl;
            let seg = src.slice(k, stop);
            const trimmed = seg.replace(/\s+$/, '');
            if (trimmed.endsWith('\\') && nl >= 0) {
              text += trimmed.slice(0, -1) + '\n';
              line++;
              k = nl + 1;
              continue;
            }
            text += seg;
            return { text, end: stop };
          }
        };
        switch (name) {
          case 'ifdef':
          case 'ifndef': {
            let k = j;
            while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
            let m = k;
            while (m < n && isIdChar(src[m])) m++;
            const macro = src.slice(k, m);
            const has = this.defines.has(macro);
            const on = name === 'ifdef' ? has : !has;
            const outer = active();
            conds.push({ active: outer && on, taken: on, outer });
            i = m;
            continue;
          }
          case 'elsif': {
            let k = j;
            while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
            let m = k;
            while (m < n && isIdChar(src[m])) m++;
            const macro = src.slice(k, m);
            const top = conds[conds.length - 1];
            if (!top) this.warn('`elsif without `ifdef', dirStart, m, dirLine);
            else {
              const on = !top.taken && this.defines.has(macro);
              top.active = top.outer && on;
              top.taken = top.taken || on;
            }
            i = m;
            continue;
          }
          case 'else': {
            const top = conds[conds.length - 1];
            if (!top) this.warn('`else without `ifdef', dirStart, j, dirLine);
            else {
              top.active = top.outer && !top.taken;
              top.taken = true;
            }
            i = j;
            continue;
          }
          case 'endif': {
            if (!conds.pop()) this.warn('`endif without `ifdef', dirStart, j, dirLine);
            i = j;
            continue;
          }
        }
        if (LINE_DIRECTIVES.has(name)) {
          const { text, end } = restOfLine();
          if (active()) {
            if (name === 'define') this.define(text);
            else if (name === 'undef') this.defines.delete(text.trim());
            else if (name === 'undefineall') this.defines.clear();
          }
          i = end;
          continue;
        }
        if (name === '') {
          // stray backtick (or ``/`" tokens inside macro bodies): ignore
          i = j;
          continue;
        }
        // macro usage
        if (!active()) {
          i = j;
          continue;
        }
        const macro = this.defines.get(name);
        if (!macro) {
          this.warn(`undefined macro \`${name}`, dirStart, j, dirLine);
          i = j;
          continue;
        }
        let body = macro.body;
        let end = j;
        if (macro.params) {
          // collect balanced (args)
          let k = j;
          while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
          const args: string[] = [];
          if (src[k] === '(') {
            let d = 0;
            let cur = '';
            let m = k;
            for (; m < n; m++) {
              const ch = src[m];
              if (ch === '(') {
                d++;
                if (d === 1) continue;
              } else if (ch === ')') {
                d--;
                if (d === 0) {
                  args.push(cur);
                  m++;
                  break;
                }
              } else if (ch === ',' && d === 1) {
                args.push(cur);
                cur = '';
                continue;
              } else if (ch === '\n') line++;
              cur += ch;
            }
            end = m;
          }
          macro.params.forEach((p, idx) => {
            const v = (args[idx] ?? '').trim();
            body = body.replace(new RegExp(`(?<![A-Za-z0-9_$])${p.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`, 'g'), () => v);
          });
        }
        if (depth > 32) {
          this.warn(`macro \`${name} expands too deeply`, dirStart, end, dirLine);
          i = end;
          continue;
        }
        const loc = fixed ?? { start: dirStart, end, line: dirLine };
        const sub = this.scan(body, loc, depth + 1);
        toks.push(...sub);
        i = end;
        continue;
      }
      // strings
      if (c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== '"') {
          if (src[j] === '\\') j++;
          if (src[j] === '\n') line++;
          j++;
        }
        push('str', i, Math.min(j + 1, n));
        i = j + 1;
        continue;
      }
      // escaped identifier
      if (c === '\\') {
        let j = i + 1;
        while (j < n && !/\s/.test(src[j])) j++;
        push('id', i, j, src.slice(i + 1, j));
        i = j;
        continue;
      }
      if (isIdStart(c)) {
        let j = i + 1;
        while (j < n && isIdChar(src[j])) j++;
        push('id', i, j);
        i = j;
        continue;
      }
      // numbers: [size]'[s]base digits | decimal | real
      if (isDigit(c) || (c === "'" && /[sSbBoOdDhH]/.test(src[i + 1] ?? ''))) {
        let j = i;
        while (j < n && (isDigit(src[j]) || src[j] === '_')) j++;
        // allow whitespace between size and base
        let k = j;
        while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
        if (src[k] === "'") {
          k++;
          if (/[sS]/.test(src[k] ?? '')) k++;
          if (/[bBoOdDhH]/.test(src[k] ?? '')) {
            k++;
            while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
            while (k < n && /[0-9a-fA-FxXzZ?_]/.test(src[k])) k++;
            push('num', i, k, src.slice(i, k).replace(/\s+/g, ''));
            i = k;
            continue;
          }
        }
        // real / exponent
        if (src[j] === '.' && isDigit(src[j + 1] ?? '')) {
          j++;
          while (j < n && isDigit(src[j])) j++;
        }
        if ((src[j] === 'e' || src[j] === 'E') && /[-+0-9]/.test(src[j + 1] ?? '')) {
          j += 2;
          while (j < n && isDigit(src[j])) j++;
        }
        push('num', i, j);
        i = j;
        continue;
      }
      // punctuation / operators
      let matched = false;
      for (const p of PUNCT3) {
        if (src.startsWith(p, i)) {
          push('op', i, i + p.length);
          i += p.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      for (const p of PUNCT2) {
        if (src.startsWith(p, i)) {
          push('op', i, i + p.length);
          i += p.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      push('op', i, i + 1);
      i++;
    }
    if (!fixed) {
      if (conds.length) this.warn('missing `endif', n, n, line);
      this.lastLine = line;
    }
    return toks;
  }

  /** `define NAME[(a,b)] body */
  private define(text: string) {
    const m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)(\(([^)]*)\))?\s?(.*)$/s.exec(text);
    if (!m) return;
    const params = m[2] ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : null;
    this.defines.set(m[1], { params, body: m[4] ?? '' });
  }
}
