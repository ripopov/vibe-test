import type { SEdge, SGraph, SNode, SPin } from '../model/graph';
import type { Placed, PinLabelKind } from '../layout/layout';
import { FONT, M, monoWidth, textWidth, headerSize } from '../layout/metrics';

export interface RenderOptions {
  showTypes: boolean;
}

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface RenderedParts {
  edgesG: SVGGElement;
  nodesG: SVGGElement;
  labelsG: SVGGElement;
}

/** Render the laid out graph into the given <g> element (cleared first). */
export function renderGraph(viewport: SVGGElement, g: SGraph, placed: Placed, opts: RenderOptions): RenderedParts {
  viewport.replaceChildren();
  const edgesG = el('g', { class: 'edges' });
  const nodesG = el('g', { class: 'nodes' });
  const labelsG = el('g', { class: 'labels' });
  viewport.append(edgesG, nodesG, labelsG);
  renderInto(g, placed, opts, edgesG, nodesG, labelsG);
  return { edgesG, nodesG, labelsG };
}

function renderInto(g: SGraph, placed: Placed, opts: RenderOptions, edgesG: SVGGElement, nodesG: SVGGElement, labelsG: SVGGElement) {
  for (const e of g.edges) renderEdge(e, edgesG, labelsG, placed);
  for (const n of g.nodes) {
    renderNode(n, nodesG, labelsG, placed, opts);
    if (n.children) renderInto(n.children, placed, opts, edgesG, nodesG, labelsG);
  }
}

function renderEdge(e: SEdge, edgesG: SVGGElement, labelsG: SVGGElement, placed: Placed) {
  if (!e.points || e.points.length < 2) return;
  const d = e.points.map((p, i) => `${i ? 'L' : 'M'}${r(p.x)},${r(p.y)}`).join('');
  const grp = el('g', {
    class: `edge${e.width > 1 ? ' bus' : ''}`,
    'data-id': e.id,
    'data-nets': e.nets.join(' '),
    'data-tip': e.tooltip,
  });
  grp.append(el('path', { class: 'hit', d }));
  grp.append(el('path', { class: 'wire', d }));
  for (const j of e.junctions ?? []) grp.append(el('circle', { class: 'junction', cx: r(j.x), cy: r(j.y), r: e.width > 1 ? 3.5 : 3 }));
  edgesG.append(grp);
  // labels positioned by ELK (bus width at the tail, slices at the head, optional net name)
  for (const suffix of ['.t', '.s', '.h', '.n']) {
    const l = placed.edgeLabels.get(e.id + suffix);
    if (!l) continue;
    const cls = l.kind === 'net' ? 'netname' : l.kind === 'width' ? 'wlabel' : 'wlabel slice';
    labelsG.append(el('text', { class: cls, x: r(l.x + l.width / 2), y: r(l.y + l.height / 2 + 3.2), 'text-anchor': 'middle' }, l.text));
  }
}

function r(v: number): number {
  return Math.round(v * 2) / 2;
}

function renderNode(n: SNode, nodesG: SVGGElement, labelsG: SVGGElement, placed: Placed, opts: RenderOptions) {
  const grp = el('g', {
    class: `node ${n.kind}${n.isBlackBox ? ' blackbox' : ''}${n.expanded ? ' expanded' : ''}${n.symbol ? ' sym sym-' + n.symbol : ''}`,
    transform: `translate(${r(n.x)},${r(n.y)})`,
    'data-id': n.id,
    'data-kind': n.kind,
    'data-tip': n.tooltip ?? n.title,
  });
  if (n.instPath) grp.setAttribute('data-path', n.instPath);
  const W = n.width;
  const H = n.height;
  switch (n.kind) {
    case 'port': {
      const isIn = n.portDir === 'input';
      const path = isIn
        ? `M0.5,0.5 H${W - 9} L${W - 0.5},${H / 2} L${W - 9},${H - 0.5} H0.5 Z`
        : n.portDir === 'output'
          ? `M8.5,0.5 H${W - 0.5} V${H - 0.5} H8.5 L0.5,${H / 2} Z`
          : `M7,0.5 H${W - 7} L${W - 0.5},${H / 2} L${W - 7},${H - 0.5} H7 L0.5,${H / 2} Z`;
      grp.append(el('path', { class: `shape port-${n.portDir}`, d: path }));
      grp.append(el('text', { class: 'ptitle', x: isIn ? 7 : n.portDir === 'output' ? 13 : W / 2, y: H / 2 + 4, 'text-anchor': n.portDir === 'inout' ? 'middle' : 'start' }, n.title));
      break;
    }
    case 'const': {
      grp.append(el('rect', { class: 'shape', x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 3 }));
      grp.append(el('text', { class: 'mono ctext', x: W / 2, y: H / 2 + 3.5, 'text-anchor': 'middle' }, n.title));
      break;
    }
    case 'join':
    case 'split': {
      const bar = n.kind === 'join' ? W - 3 : 3;
      for (const p of n.pins) {
        const isBar = (n.kind === 'join') === (p.side === 'E');
        if (!isBar) {
          const x0 = p.side === 'W' ? 0 : W;
          grp.append(el('line', { class: 'ripline', x1: x0, y1: p.y, x2: bar, y2: p.y }));
          if (p.name) grp.append(el('text', { class: 'riplabel', x: p.side === 'W' ? 3 : W - 3, y: p.y - 3, 'text-anchor': p.side === 'W' ? 'start' : 'end' }, p.name));
        }
      }
      const ys = n.pins.filter((p) => (n.kind === 'join') === (p.side === 'W')).map((p) => p.y);
      const y0 = Math.min(...ys, n.pins.find((p) => (n.kind === 'join') === (p.side === 'E'))!.y) - 4;
      const y1 = Math.max(...ys, n.pins.find((p) => (n.kind === 'join') === (p.side === 'E'))!.y) + 4;
      grp.append(el('line', { class: 'ripbar', x1: bar, y1: y0, x2: bar, y2: y1 }));
      break;
    }
    case 'expr': {
      if (n.symbol && ['and', 'or', 'xor', 'nand', 'nor', 'xnor', 'not', 'buf', 'mux'].includes(n.symbol)) {
        renderSymbol(n, grp);
        break;
      }
      grp.append(el('rect', { class: 'shape', x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 4 }));
      grp.append(el('text', { class: 'mono etitle', x: W / 2, y: 14, 'text-anchor': 'middle' }, n.title));
      renderPins(n, grp, FONT.label);
      break;
    }
    default: {
      if (n.symbol && !n.expanded && ['and', 'or', 'xor', 'nand', 'nor', 'xnor', 'not', 'buf', 'mux'].includes(n.symbol)) {
        renderSymbol(n, grp);
        break;
      }
      grp.append(el('rect', { class: 'shape body', x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 3 }));
      const hasSub = opts.showTypes && !!n.subtitle;
      if (n.expanded) {
        const headerH = M.headerTitle + (hasSub ? M.headerSub : 0) + 2;
        grp.append(el('text', { class: 'title', x: M.pad, y: 13 }, n.title));
        if (hasSub) grp.append(el('text', { class: 'subtitle', x: M.pad, y: 13 + M.headerSub }, n.subtitle));
        grp.append(el('line', { class: 'hdrline', x1: 0.5, y1: headerH, x2: W - 0.5, y2: headerH }));
      } else {
        // title block above the box (space reserved by ELK)
        const hdr = headerSize(n, opts.showTypes);
        const base = -hdr.height - 2;
        grp.append(el('text', { class: 'title', x: 0, y: base + 12 }, n.title));
        if (hdr.lines[1]) grp.append(el('text', { class: 'subtitle', x: 0, y: base + 26 }, hdr.lines[1]));
      }
      if (n.symbol === 'dff') {
        // clock triangle at the clk pin
        const clk = n.pins.find((p) => /clk|ck|clock/i.test(p.name) && p.side === 'W');
        if (clk) grp.append(el('path', { class: 'clkmark', d: `M0.5,${clk.y - 5} L8,${clk.y} L0.5,${clk.y + 5}` }));
      }
      renderPins(n, grp, FONT.pin);
    }
  }
  // pin markers and flags
  for (const p of n.pins) {
    if (!p.connected) {
      const x0 = p.side === 'W' ? 0 : W;
      const dir = p.side === 'W' ? -1 : 1;
      grp.append(el('line', { class: 'nc', x1: x0, y1: p.y, x2: x0 + dir * 6, y2: p.y }));
      grp.append(el('line', { class: 'nc', x1: x0 + dir * 6 - 2, y1: p.y - 2.5, x2: x0 + dir * 6 + 2, y2: p.y + 2.5 }));
      grp.append(el('line', { class: 'nc', x1: x0 + dir * 6 - 2, y1: p.y + 2.5, x2: x0 + dir * 6 + 2, y2: p.y - 2.5 }));
    }
    const hit = el('circle', { class: 'pin', cx: p.x, cy: p.y, r: 5, 'data-pin': p.id, 'data-net': p.netKey ?? '', 'data-tip': pinTip(n, p) });
    grp.append(hit);
    const lab = placed.pinLabels.get(p.id);
    if (lab) renderFlag(p, lab, labelsG);
  }
  nodesG.append(grp);
}

function pinTip(n: SNode, p: SPin): string {
  const parts: string[] = [];
  if (p.name) parts.push(`${p.dir === 'in' ? 'input' : p.dir === 'out' ? 'output' : p.dir} ${p.name}${p.width > 1 ? ` [${p.width - 1}:0]` : ''}`);
  if (p.tooltip) parts.push(p.name ? `↔ ${p.tooltip}` : p.tooltip);
  if (!parts.length) parts.push(n.title);
  return parts.join('\n');
}

function renderPins(n: SNode, grp: SVGGElement, font: number) {
  const W = n.width;
  for (const p of n.pins) {
    if (!p.name) continue;
    grp.append(el('text', {
      class: `pinlabel${p.width > 1 ? ' bus' : ''}`,
      x: p.side === 'W' ? 6 : W - 6,
      y: p.y + 3.5,
      'text-anchor': p.side === 'W' ? 'start' : 'end',
      'font-size': font,
    }, p.name));
  }
}

function renderFlag(p: SPin, lab: { x: number; y: number; width: number; height: number; text: string; kind: PinLabelKind }, labelsG: SVGGElement) {
  const { x, y, width: w, height: h } = lab;
  if (lab.kind === 'slice') {
    labelsG.append(el('text', { class: 'wlabel slice', x: r(p.side === 'W' ? x + w : x), y: r(y + h - 2.5), 'text-anchor': p.side === 'W' ? 'end' : 'start' }, lab.text));
    return;
  }
  const g = el('g', { class: `flag ${lab.kind}`, transform: `translate(${r(x)},${r(y)})`, 'data-net': p.netKey ?? '', 'data-tip': lab.kind === 'flag' ? `net ${lab.text}` : `constant ${lab.text}` });
  if (lab.kind === 'flag') {
    // pentagon pointing at the pin
    const d = p.side === 'W'
      ? `M0.5,0.5 H${w - 7} L${w - 0.5},${h / 2} L${w - 7},${h - 0.5} H0.5 Z`
      : `M7,0.5 H${w - 0.5} V${h - 0.5} H7 L0.5,${h / 2} Z`;
    g.append(el('path', { class: 'shape', d }));
    g.append(el('text', { class: 'ftext', x: p.side === 'W' ? 4 : w - 4, y: h / 2 + 3.5, 'text-anchor': p.side === 'W' ? 'start' : 'end' }, lab.text));
  } else {
    g.append(el('rect', { class: 'shape', x: 0.5, y: 0.5, width: w - 1, height: h - 1, rx: 2 }));
    g.append(el('text', { class: 'mono ftext', x: w / 2, y: h / 2 + 3.5, 'text-anchor': 'middle' }, lab.text));
  }
  labelsG.append(g);
}

/** Classic gate symbols. Pins were placed at x=0 / x=width by metrics. */
function renderSymbol(n: SNode, grp: SVGGElement) {
  const W = n.width;
  const H = n.height;
  const sym = n.symbol!;
  const bubble = sym === 'nand' || sym === 'nor' || sym === 'xnor' || sym === 'not';
  const bodyR = W - (bubble ? 8 : 0); // right edge of body
  const left = n.pins.filter((p) => p.side === 'W');
  const right = n.pins.filter((p) => p.side === 'E');
  const stubL = sym === 'or' || sym === 'nor' || sym === 'xor' || sym === 'xnor' ? 12 : 8;
  for (const p of left) {
    grp.append(el('line', { class: 'stub', x1: 0, y1: p.y, x2: stubL + 1, y2: p.y }));
    if (p.inverted) grp.append(el('circle', { class: 'shape bubble', cx: stubL - 3, cy: p.y, r: 3 }));
  }
  for (const p of right) grp.append(el('line', { class: 'stub', x1: bodyR - 1, y1: p.y, x2: W, y2: p.y }));
  const x0 = 8;
  let d = '';
  switch (sym) {
    case 'and':
    case 'nand': {
      const rr = H / 2;
      d = `M${x0},0.5 H${bodyR - rr} A${rr},${rr} 0 0 1 ${bodyR - rr},${H - 0.5} H${x0} Z`;
      break;
    }
    case 'or':
    case 'nor':
    case 'xor':
    case 'xnor': {
      d = `M${x0},0.5 Q${x0 + (bodyR - x0) * 0.55},0.5 ${bodyR},${H / 2} Q${x0 + (bodyR - x0) * 0.55},${H - 0.5} ${x0},${H - 0.5} Q${x0 + 8},${H / 2} ${x0},0.5 Z`;
      if (sym === 'xor' || sym === 'xnor') grp.append(el('path', { class: 'shape open', d: `M${x0 - 5},0.5 Q${x0 + 3},${H / 2} ${x0 - 5},${H - 0.5}` }));
      break;
    }
    case 'not':
    case 'buf': {
      d = `M${x0},0.5 L${bodyR},${H / 2} L${x0},${H - 0.5} Z`;
      break;
    }
    case 'mux': {
      d = `M${x0},0.5 L${bodyR},${8} L${bodyR},${H - 8} L${x0},${H - 0.5} Z`;
      break;
    }
  }
  grp.append(el('path', { class: 'shape body', d }));
  if (bubble) grp.append(el('circle', { class: 'shape bubble', cx: bodyR + 4, cy: H / 2, r: 3.5 }));
  if (sym === 'mux') {
    for (const p of left) if (p.name) grp.append(el('text', { class: 'pinlabel', x: x0 + 4, y: p.y + 3.5, 'font-size': 9 }, p.name));
  }
  if (n.kind === 'inst') grp.append(el('text', { class: 'symtitle', x: 0, y: -4 }, n.title));
}

// ---------------------------------------------------------------------------

export interface ThemeColors {
  bg: string;
  fg: string;
  muted: string;
  nodeFill: string;
  nodeStroke: string;
  exprFill: string;
  portFill: string;
  portStroke: string;
  wire: string;
  bus: string;
  accent: string;
  accentSoft: string;
  flagFill: string;
  flagStroke: string;
  constFill: string;
  constFg: string;
  nc: string;
  selection: string;
}

export const LIGHT: ThemeColors = {
  bg: '#f7f7f5', fg: '#1f2328', muted: '#6b7280', nodeFill: '#ffffff', nodeStroke: '#3b4252', exprFill: '#fbfbfd',
  portFill: '#e8f0fe', portStroke: '#3b6bd6', wire: '#2d3340', bus: '#1d4ed8', accent: '#f97316', accentSoft: '#fdba74',
  flagFill: '#fff7e6', flagStroke: '#c98a1b', constFill: '#eef2f7', constFg: '#475569', nc: '#9ca3af', selection: '#f97316',
};
export const DARK: ThemeColors = {
  bg: '#14171c', fg: '#e5e7eb', muted: '#9aa3b2', nodeFill: '#1f242c', nodeStroke: '#c3cad6', exprFill: '#22282f',
  portFill: '#1e2c48', portStroke: '#7aa2f7', wire: '#d7dce4', bus: '#7aa2f7', accent: '#fb923c', accentSoft: '#f59e0b',
  flagFill: '#3a2f14', flagStroke: '#d9a441', constFill: '#2a3140', constFg: '#c3cad6', nc: '#6b7280', selection: '#fb923c',
};

export function schematicCss(t: ThemeColors): string {
  return `
.schematic { font-family: "Inter", "Segoe UI", system-ui, sans-serif; fill: ${t.fg}; }
.schematic .mono { font-family: "JetBrains Mono", "Fira Code", ui-monospace, monospace; }
.edge .hit { fill: none; stroke: transparent; stroke-width: 9; cursor: pointer; }
.edge .wire { fill: none; stroke: ${t.wire}; stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: butt; }
.edge.bus .wire { stroke: ${t.bus}; stroke-width: 3; }
.edge .junction { fill: ${t.wire}; stroke: none; }
.edge.bus .junction { fill: ${t.bus}; }
.edge.hl .wire { stroke: ${t.accent} !important; stroke-width: 3.2; }
.edge.bus.hl .wire { stroke-width: 4.5; }
.edge.hl .junction { fill: ${t.accent}; }
.has-hl .edge:not(.hl) .wire { opacity: 0.35; }
.has-hl .edge:not(.hl) .junction { opacity: 0.35; }
.node .shape { fill: ${t.nodeFill}; stroke: ${t.nodeStroke}; stroke-width: 1.2; }
.node .shape.open { fill: none; }
.node.expr .shape { fill: ${t.exprFill}; }
.node.const .shape { fill: ${t.constFill}; stroke: ${t.constFg}; stroke-width: 1; }
.node.const .ctext { fill: ${t.constFg}; font-size: ${FONT.label}px; }
.node.blackbox:not(.sym) .shape.body { stroke-dasharray: 5 3; }
.node.port .shape { fill: ${t.portFill}; stroke: ${t.portStroke}; }
.node.port .ptitle { font-size: ${FONT.port}px; font-weight: 500; }
.node .title { font-size: ${FONT.title}px; font-weight: 600; }
.node .subtitle { font-size: ${FONT.subtitle}px; fill: ${t.muted}; }
.node .symtitle { font-size: 9px; fill: ${t.muted}; }
.node .hdrline { stroke: ${t.nodeStroke}; stroke-width: 0.8; opacity: 0.5; }
.node.expanded .shape.body { fill: ${t.bg}; stroke-dasharray: none; stroke-width: 1.4; }
.node .pinlabel { font-size: ${FONT.pin}px; fill: ${t.fg}; }
.node .pinlabel.bus { fill: ${t.bus}; }
.node.expr .etitle { font-size: ${FONT.expr}px; }
.node .pin { fill: transparent; stroke: none; cursor: pointer; }
.node .pin.hl { fill: ${t.accent}; }
.node .nc { stroke: ${t.nc}; stroke-width: 1; }
.node .stub { stroke: ${t.wire}; stroke-width: 1.4; }
.node .clkmark { fill: none; stroke: ${t.nodeStroke}; stroke-width: 1.2; }
.node .ripline { stroke: ${t.wire}; stroke-width: 1.4; }
.node .ripbar { stroke: ${t.bus}; stroke-width: 4; stroke-linecap: round; }
.node .riplabel { font-size: 9.5px; fill: ${t.muted}; font-family: "JetBrains Mono", ui-monospace, monospace; }
.node.selected .shape.body, .node.selected .shape { stroke: ${t.selection}; stroke-width: 2.2; }
.node.selected .ripbar { stroke: ${t.selection}; }
.node.dim { opacity: 0.45; }
.labels .wlabel { font-size: 9px; fill: ${t.bus}; font-family: "JetBrains Mono", ui-monospace, monospace; }
.labels .wlabel.slice { fill: ${t.muted}; }
.labels .netname { font-size: 9.5px; fill: ${t.muted}; }
.flag .shape { fill: ${t.flagFill}; stroke: ${t.flagStroke}; stroke-width: 1; }
.flag .ftext { font-size: ${FONT.label}px; font-weight: 500; fill: ${t.fg}; }
.flag.const .shape { fill: ${t.constFill}; stroke: ${t.constFg}; }
.flag.const .ftext { fill: ${t.constFg}; font-weight: 400; }
.flag.hl .shape { stroke: ${t.accent}; stroke-width: 2; }
.lod-low .pinlabel, .lod-low .subtitle, .lod-low .wlabel, .lod-low .riplabel, .lod-low .ftext, .lod-low .netname, .lod-low .symtitle, .lod-low .ctext { display: none; }
.lod-low .flag .shape { fill: ${t.flagStroke}; }
`;
}

export function measureLabelWidth(text: string): number {
  return textWidth(text, FONT.label);
}
