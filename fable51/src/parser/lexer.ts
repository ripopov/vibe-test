export type TokKind = 'id' | 'num' | 'str' | 'op' | 'eof';

export interface Token {
  kind: TokKind;
  text: string;
  start: number;
  end: number;
  line: number;
}

const PUNCT3 = ['<<<', '>>>', '===', '!==', '**=', '<<=', '>>=', '+:', '-:'];
const PUNCT2 = ['<=', '>=', '==', '!=', '&&', '||', '<<', '>>', '**', '~&', '~|', '~^', '^~', '->', '::', '+:', '-:', '++', '--', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '.*'];

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
 * Tokenize Verilog source. Comments, attributes `(* ... *)` and compiler
 * directives are skipped. Tolerant: unknown characters are emitted as 'op'.
 */
export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  const push = (kind: TokKind, start: number, end: number, text?: string) =>
    toks.push({ kind, text: text ?? src.slice(start, end), start, end, line });

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
    // compiler directives: skip to end of line (handles `timescale, `define, `include ...)
    if (c === '`') {
      // `ifdef/`else/`endif etc. are line based too - we simply drop them (tolerant)
      while (i < n && src[i] !== '\n') i++;
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
  toks.push({ kind: 'eof', text: '', start: n, end: n, line });
  return toks;
}
