import type { SGraph, SNode } from '../model/graph';

export const FONT = {
  pin: 11,
  title: 12,
  subtitle: 10,
  label: 10,
  port: 11.5,
  expr: 12,
};

export const M = {
  pinPitch: 20,
  pad: 8,
  headerTitle: 18,
  headerSub: 14,
  minInstWidth: 64,
  portHeight: 22,
  flagHeight: 16,
  flagPad: 12,
  constHeight: 18,
};

let canvas: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

export function textWidth(text: string, size: number, weight = ''): number {
  const key = `${size}|${weight}|${text}`;
  const c = cache.get(key);
  if (c !== undefined) return c;
  let w: number;
  if (typeof document !== 'undefined') {
    if (!canvas) canvas = document.createElement('canvas').getContext('2d');
    if (canvas) {
      canvas.font = `${weight} ${size}px "Inter", "Segoe UI", system-ui, sans-serif`.trim();
      w = canvas.measureText(text).width;
    } else w = text.length * size * 0.58;
  } else {
    w = text.length * size * 0.58;
  }
  cache.set(key, w);
  return w;
}

export function monoWidth(text: string, size: number): number {
  const key = `m${size}|${text}`;
  const c = cache.get(key);
  if (c !== undefined) return c;
  let w: number;
  if (typeof document !== 'undefined') {
    if (!canvas) canvas = document.createElement('canvas').getContext('2d');
    if (canvas) {
      canvas.font = `${size}px "JetBrains Mono", "Fira Code", ui-monospace, monospace`;
      w = canvas.measureText(text).width;
    } else w = text.length * size * 0.62;
  } else w = text.length * size * 0.62;
  cache.set(key, w);
  return w;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** Compute node size and relative pin positions for every node of the graph (recursively). */
export function sizeGraph(g: SGraph, opts: { showTypes: boolean }) {
  for (const n of g.nodes) {
    if (n.children) sizeGraph(n.children, opts);
    sizeNode(n, opts);
  }
}

export function sizeNode(n: SNode, opts: { showTypes: boolean }) {
  const left = n.pins.filter((p) => p.side === 'W');
  const right = n.pins.filter((p) => p.side === 'E');
  const layoutPins = (h0: number, height: number) => {
    // vertically center pin groups within the pin area
    const area = height - h0 - M.pad;
    for (const grp of [left, right]) {
      const total = grp.length * M.pinPitch;
      const start = h0 + Math.max(0, (area - total) / 2) + M.pinPitch / 2;
      grp.forEach((p, i) => {
        p.y = Math.round(start + i * M.pinPitch);
        p.x = p.side === 'W' ? 0 : n.width;
      });
    }
  };
  switch (n.kind) {
    case 'port': {
      const w = textWidth(n.title, FONT.port, '500');
      n.width = Math.ceil(w + 22);
      n.height = M.portHeight;
      for (const p of n.pins) {
        p.x = p.side === 'W' ? 0 : n.width;
        p.y = n.height / 2;
      }
      return;
    }
    case 'const': {
      const w = monoWidth(n.title, FONT.label);
      n.width = Math.ceil(w + 14);
      n.height = M.constHeight;
      for (const p of n.pins) {
        p.x = p.side === 'W' ? 0 : n.width;
        p.y = n.height / 2;
      }
      return;
    }
    case 'join':
    case 'split': {
      const maxL = Math.max(0, ...left.map((p) => textWidth(p.name, FONT.label)));
      const maxR = Math.max(0, ...right.map((p) => textWidth(p.name, FONT.label)));
      n.width = Math.ceil(Math.max(14, maxL + maxR + (maxL && maxR ? 16 : 8)));
      const rows = Math.max(left.length, right.length, 1);
      n.height = rows * M.pinPitch + 4;
      const h0 = 2;
      const area = n.height - h0 - 2;
      for (const grp of [left, right]) {
        const total = grp.length * M.pinPitch;
        const start = h0 + Math.max(0, (area - total) / 2) + M.pinPitch / 2;
        grp.forEach((p, i) => {
          p.y = Math.round(start + i * M.pinPitch);
          p.x = p.side === 'W' ? 0 : n.width;
        });
      }
      return;
    }
    case 'expr': {
      if (n.symbol && ['and', 'or', 'xor', 'nand', 'nor', 'xnor', 'not', 'buf', 'mux'].includes(n.symbol)) {
        sizeSymbol(n, left, right);
        return;
      }
      const label = truncate(n.title, 28);
      n.title = label;
      const tw = monoWidth(label, FONT.expr);
      const maxL = Math.max(0, ...left.map((p) => textWidth(p.name, FONT.label)));
      n.width = Math.ceil(Math.max(tw + 20, maxL + 30, 40));
      const rows = Math.max(left.length, right.length, 1);
      const h0 = 20;
      n.height = Math.max(h0 + rows * M.pinPitch + M.pad, 44);
      layoutPins(h0, n.height);
      return;
    }
    case 'inst':
    default: {
      if (n.symbol && !n.expanded && ['and', 'or', 'xor', 'nand', 'nor', 'xnor', 'not', 'buf', 'mux', 'dff'].includes(n.symbol)) {
        sizeSymbol(n, left, right);
        return;
      }
      const maxL = Math.max(0, ...left.map((p) => textWidth(p.name, FONT.pin)));
      const maxR = Math.max(0, ...right.map((p) => textWidth(p.name, FONT.pin)));
      const pinW = maxL + maxR + (maxL && maxR ? 24 : 12) + 8;
      const rows = Math.max(left.length, right.length, 1);
      if (n.expanded) {
        const titleW = textWidth(n.title, FONT.title, '600');
        const subW = opts.showTypes && n.subtitle ? textWidth(n.subtitle, FONT.subtitle) : 0;
        n.width = Math.ceil(Math.max(M.minInstWidth, titleW + 2 * M.pad + 4, subW + 2 * M.pad, pinW));
        const h0 = M.headerTitle + (opts.showTypes && n.subtitle ? M.headerSub : 0) + 2;
        n.height = Math.max(h0 + rows * M.pinPitch + M.pad, 80);
        layoutPins(h0, n.height);
        return;
      }
      // title goes above the box (ELK label), pins are centered vertically like ELK's CENTER alignment
      n.width = Math.ceil(Math.max(M.minInstWidth, pinW));
      n.height = rows * M.pinPitch + 12;
      centerPins(n, left, right);
      return;
    }
  }
}

/** Distribute pins exactly like ELK's CENTER port alignment (1px ports, pitch-1 spacing). */
function centerPins(n: SNode, left: SNode['pins'], right: SNode['pins']) {
  for (const grp of [left, right]) {
    const total = grp.length * M.pinPitch - (M.pinPitch - 1);
    const start = (n.height - total) / 2 + 0.5;
    grp.forEach((p, i) => {
      p.y = Math.round(start + i * M.pinPitch);
      p.x = p.side === 'W' ? 0 : n.width;
    });
  }
}

/** Size of the label block drawn above an instance box. */
export function headerSize(n: SNode, showTypes: boolean): { width: number; height: number; lines: string[] } {
  if (n.symbol && n.symbol !== 'dff') {
    return { width: Math.ceil(textWidth(n.title, 9)), height: 11, lines: [n.title] };
  }
  const lines = [n.title];
  if (showTypes && n.subtitle) lines.push(n.subtitle);
  const width = Math.ceil(Math.max(textWidth(n.title, FONT.title, '600'), lines[1] ? textWidth(lines[1], FONT.subtitle) : 0));
  return { width, height: lines.length > 1 ? 29 : 15, lines };
}

/** Gate symbols: fixed compact size with pins on the shape edges. */
function sizeSymbol(n: SNode, left: SNode['pins'], right: SNode['pins']) {
  const rows = Math.max(left.length, 1);
  const bodyH = Math.max(28, rows * 14 + 8);
  if (n.symbol === 'dff') {
    const maxL = Math.max(0, ...left.map((p) => textWidth(p.name, FONT.pin)));
    const maxR = Math.max(0, ...right.map((p) => textWidth(p.name, FONT.pin)));
    n.width = Math.ceil(Math.max(56, maxL + maxR + 28));
    n.height = Math.max(left.length, right.length, 1) * M.pinPitch + 12;
    centerPins(n, left, right);
    return;
  }
  n.width = n.symbol === 'mux' ? 32 : n.symbol === 'not' || n.symbol === 'buf' ? 34 : 44;
  n.height = n.symbol === 'mux' ? Math.max(44, rows * 16 + 14) : bodyH;
  const pitch = n.height / (left.length + 1);
  left.forEach((p, i) => {
    p.x = 0;
    p.y = Math.round(pitch * (i + 1));
  });
  right.forEach((p, i) => {
    p.x = n.width;
    p.y = Math.round((n.height / (right.length + 1)) * (i + 1));
  });
}
