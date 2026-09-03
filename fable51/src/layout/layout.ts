import type { SEdge, SGraph, SNode, SPin } from '../model/graph';
import { M, textWidth, FONT, monoWidth, headerSize } from './metrics';

export interface LayoutOptions {
  showTypes: boolean;
  /** let ELK reorder pins on each side to reduce crossings */
  freePinOrder: boolean;
  /** raw ELK option overrides for experiments */
  overrides?: Record<string, string>;
  /** extra spacing multiplier */
  spacing: number;
  thoroughness: number;
  netNames: boolean;
}

export interface LayoutResult {
  width: number;
  height: number;
  ms: number;
}

interface ElkPort {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  labels?: { id?: string; text: string; width: number; height: number; x?: number; y?: number }[];
  layoutOptions?: Record<string, string>;
}
interface ElkNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  ports?: ElkPort[];
  children?: ElkNode[];
  edges?: ElkEdge[];
  labels?: { text: string; width: number; height: number; x?: number; y?: number }[];
  layoutOptions?: Record<string, string>;
}
interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  layoutOptions?: Record<string, string>;
  labels?: { id?: string; text: string; width: number; height: number; x?: number; y?: number; layoutOptions?: Record<string, string> }[];
  sections?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: { x: number; y: number }[] }[];
  junctionPoints?: { x: number; y: number }[];
  container?: string;
}

export type PinLabelKind = 'flag' | 'const' | 'slice';

export function labelSize(text: string, kind: PinLabelKind): { width: number; height: number } {
  if (kind === 'const') return { width: Math.ceil(monoWidth(text, FONT.label) + 10), height: M.flagHeight };
  if (kind === 'slice') return { width: Math.ceil(monoWidth(text, 9) + 2), height: 10 };
  return { width: Math.ceil(textWidth(text, FONT.label, '500') + M.flagPad + 4), height: M.flagHeight };
}

export function pinLabelKind(p: SPin): PinLabelKind | null {
  if (p.netLabel) return 'flag';
  if (p.constLabel) return 'const';
  if (p.sliceLabel) return 'slice';
  return null;
}

function pinToElk(p: SPin, wired: Set<string>): ElkPort {
  const port: ElkPort = {
    id: p.id,
    x: p.x,
    y: p.y,
    width: 1,
    height: 1,
    layoutOptions: { 'elk.port.side': p.side === 'W' ? 'WEST' : 'EAST', 'elk.port.borderOffset': '0' },
  };
  // slices of wired pins travel with the wire as edge end labels instead
  const kind = wired.has(p.id) && !p.netLabel && !p.constLabel ? null : pinLabelKind(p);
  const text = p.netLabel ?? p.constLabel ?? p.sliceLabel;
  if (kind && text) {
    const s = labelSize(text, kind);
    port.labels = [{ id: `${p.id}.l`, text, width: s.width, height: s.height }];
  }
  return port;
}

function nodeToElk(n: SNode, o: LayoutOptions, wired: Set<string>): ElkNode {
  const node: ElkNode = {
    id: n.id,
    width: n.width,
    height: n.height,
    ports: n.pins.map((p) => pinToElk(p, wired)),
    layoutOptions: {
      'elk.portConstraints': 'FIXED_POS',
      'elk.portLabels.placement': 'OUTSIDE NEXT_TO_PORT_IF_POSSIBLE ALWAYS_SAME_SIDE',
      'elk.nodeSize.constraints': '',
      'elk.spacing.labelPortHorizontal': '3',
      'elk.spacing.labelPortVertical': '2',
    },
  };
  if (n.kind === 'port') {
    node.layoutOptions!['elk.layered.layering.layerConstraint'] = n.portDir === 'input' ? 'FIRST' : 'LAST';
  }
  if (n.kind === 'inst' && !n.children) {
    // instance name (and type) sit above the box; ELK reserves the space
    const hdr = headerSize(n, o.showTypes);
    node.labels = [{ text: n.title, width: hdr.width, height: hdr.height }];
    node.layoutOptions!['elk.nodeLabels.placement'] = 'OUTSIDE V_TOP H_LEFT';
    node.layoutOptions!['elk.spacing.labelNode'] = '2';
  }
  if (o.freePinOrder && !n.children && n.kind === 'inst' && (!n.symbol || n.symbol === 'dff')) {
    // ELK may reorder pins along each side; pins are centered over the box height
    node.layoutOptions = {
      ...node.layoutOptions,
      'elk.portConstraints': 'FIXED_SIDE',
      'elk.nodeSize.constraints': 'MINIMUM_SIZE',
      'elk.nodeSize.minimum': `(${n.width}, ${n.height})`,
      'elk.portAlignment.default': 'CENTER',
    };
  }
  if (n.children) {
    // compound node: let ELK size it; ports keep their side and order
    node.layoutOptions = {
      ...node.layoutOptions,
      'elk.portConstraints': 'FIXED_ORDER',
      'elk.nodeSize.constraints': 'PORTS PORT_LABELS MINIMUM_SIZE',
      'elk.nodeSize.minimum': `(${n.width}, ${n.height})`,
      'elk.padding': `[top=${M.headerTitle + (o.showTypes ? M.headerSub : 0) + 14},left=18,bottom=14,right=18]`,
      'elk.spacing.portPort': String(M.pinPitch - 1),
      'elk.portAlignment.default': 'CENTER',
      'elk.spacing.portsSurrounding': `[top=${M.headerTitle + (o.showTypes ? M.headerSub : 0) + 4},left=0,bottom=6,right=0]`,
    };
    // port order: index within side, west pins top-to-bottom => in ELK, WEST side ports are ordered bottom-to-top (clockwise)
    const west = n.pins.filter((p) => p.side === 'W');
    const east = n.pins.filter((p) => p.side === 'E');
    for (const p of node.ports!) {
      const pin = n.pins.find((x) => x.id === p.id)!;
      const idx = pin.side === 'W' ? west.length - 1 - west.indexOf(pin) : east.indexOf(pin);
      p.layoutOptions!['elk.port.index'] = String(idx);
    }
    const inner = graphToElk(n.children, o, false, new Set(n.pins.map((p) => p.id)));
    node.children = inner.children;
    node.edges = inner.edges;
    // pins of the compound node itself are wired from the inside
    for (const p of node.ports!) delete p.labels;
    for (const p of n.pins) {
      const kind = pinLabelKind(p);
      const text = p.netLabel ?? p.constLabel;
      if (kind && text && kind !== 'slice') {
        const s = labelSize(text, kind);
        node.ports!.find((x) => x.id === p.id)!.labels = [{ id: `${p.id}.l`, text, width: s.width, height: s.height }];
      }
    }
  }
  return node;
}

export const LABEL_H = 12;

function edgeToElk(e: SEdge, o: LayoutOptions, ctx: { tailDone: Set<string>; pins: Map<string, SPin>; compoundPins: Set<string> }): ElkEdge {
  const edge: ElkEdge = {
    id: e.id,
    sources: [e.from],
    targets: [e.to],
    layoutOptions: {
      'elk.edge.thickness': e.width > 1 ? '3' : '1.5',
    },
    labels: [],
  };
  // bus width once per driver pin (not inside an expanded box where the pin label sits)
  if (e.tailLabel && !ctx.tailDone.has(e.from) && !ctx.compoundPins.has(e.from)) {
    ctx.tailDone.add(e.from);
    edge.labels!.push({ id: `${e.id}.t`, text: e.tailLabel, width: Math.ceil(monoWidth(e.tailLabel, 9)) + 2, height: LABEL_H, layoutOptions: { 'elk.edgeLabels.placement': 'TAIL' } });
  }
  // bit/part select at the sink pin, plus alias slices
  const sinkPin = ctx.pins.get(e.to);
  const srcPin = ctx.pins.get(e.from);
  const parts: string[] = [];
  if (srcPin?.sliceLabel && !ctx.compoundPins.has(e.from) && !srcPin.netLabel) {
    edge.labels!.push({ id: `${e.id}.s`, text: srcPin.sliceLabel, width: Math.ceil(monoWidth(srcPin.sliceLabel, 9)) + 2, height: LABEL_H, layoutOptions: { 'elk.edgeLabels.placement': 'TAIL' } });
  }
  if (sinkPin?.sliceLabel && !ctx.compoundPins.has(e.to) && !sinkPin.netLabel) parts.push(sinkPin.sliceLabel);
  if (e.headLabel) parts.push(e.headLabel);
  if (parts.length) {
    const text = parts.join(' ');
    edge.labels!.push({ id: `${e.id}.h`, text, width: Math.ceil(monoWidth(text, 9)) + 2, height: LABEL_H, layoutOptions: { 'elk.edgeLabels.placement': 'HEAD' } });
  }
  if (o.netNames && !e.netKey.startsWith('~')) {
    const text = e.netKey;
    edge.labels!.push({ id: `${e.id}.n`, text, width: Math.ceil(textWidth(text, FONT.label)) + 4, height: 12, layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' } });
  }
  if (!edge.labels!.length) delete edge.labels;
  return edge;
}

/** Nodes that have no edges at all (e.g. ports of labeled nets) are placed manually. */
export function isFloating(n: SNode, g: SGraph): boolean {
  if (n.kind !== 'port') return false;
  const pinIds = new Set(n.pins.map((p) => p.id));
  for (const e of g.edges) if (pinIds.has(e.from) || pinIds.has(e.to)) return false;
  return true;
}

export function graphToElk(g: SGraph, o: LayoutOptions, root = true, outerPins = new Set<string>()): ElkNode {
  const sp = o.spacing;
  const wired = new Set<string>();
  for (const e of g.edges) {
    wired.add(e.from);
    wired.add(e.to);
  }
  const pins = new Map<string, SPin>();
  const compoundPins = new Set<string>(outerPins);
  for (const n of g.nodes) for (const p of n.pins) {
    pins.set(p.id, p);
    if (n.children) compoundPins.add(p.id);
  }
  const ctx = { tailDone: new Set<string>(), pins, compoundPins };
  const node: ElkNode = {
    id: root ? 'root' : `${g.path || 'sub'}_${g.module}`,
    children: g.nodes.filter((n) => !(root && isFloating(n, g))).map((n) => nodeToElk(n, o, wired)),
    edges: g.edges.map((e) => edgeToElk(e, o, ctx)),
  };
  if (root) {
    node.layoutOptions = {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      // hierarchical layout is ~4x slower in ELK; only pay for it when something is expanded
      'elk.hierarchyHandling': g.nodes.some((n) => n.children) ? 'INCLUDE_CHILDREN' : 'SEPARATE_CHILDREN',
      'elk.layered.mergeEdges': 'true',
      'elk.layered.mergeHierarchyEdges': 'true',
      'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
      // network simplex placement gives the most compact, straight results but is slow (and
      // recursion-heavy) on big graphs
      // ... and Brandes-Koepf turns thousands of long straight edges into thousands of lanes,
      // so big flat netlists use the compact SIMPLE placer
      'elk.layered.nodePlacement.strategy': g.nodes.length <= 150 ? 'NETWORK_SIMPLEX' : g.nodes.length <= 400 ? 'BRANDES_KOEPF' : 'SIMPLE',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
      'elk.layered.crossingMinimization.greedySwitchHierarchical.type': 'TWO_SIDED',
      'elk.layered.thoroughness': String(o.thoroughness),
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      'elk.layered.feedbackEdges': 'false',
      'elk.layered.unnecessaryBendpoints': 'true',
      'elk.layered.considerModelOrder.strategy': g.nodes.length <= 300 ? 'PREFER_EDGES' : 'NONE',
      'elk.spacing.nodeNode': String(Math.round(28 * sp)),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(56 * sp)),
      'elk.layered.spacing.edgeNodeBetweenLayers': String(Math.round(28 * sp)),
      'elk.spacing.edgeNode': String(Math.round(18 * sp)),
      'elk.spacing.edgeEdge': String(Math.round(10 * sp)),
      'elk.layered.spacing.edgeEdgeBetweenLayers': String(Math.round(10 * sp)),
      'elk.spacing.portPort': String(M.pinPitch - 1),
      'elk.spacing.labelNode': '6',
      'elk.spacing.labelLabel': '4',
      'elk.spacing.edgeLabel': '2',
      'elk.spacing.componentComponent': String(Math.round(40 * sp)),
      'elk.separateConnectedComponents': 'true',
      'elk.layered.compaction.connectedComponents': 'true',
      'elk.layered.compaction.postCompaction.strategy': 'NONE',
      'elk.layered.edgeLabels.sideSelection': 'ALWAYS_UP',
      'elk.edgeLabels.inline': 'false',
      'elk.layered.highDegreeNodes.treatment': 'false',
      'elk.layered.layering.nodePromotion.strategy': 'NONE',
      'elk.layered.wrapping.strategy': 'OFF',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      ...(o.overrides ?? {}),
    };
  }
  return node;
}

// ---------------------------------------------------------------------------

export interface Placed {
  /** absolute label placements (net label flags / const tags) keyed by pin id */
  pinLabels: Map<string, { x: number; y: number; width: number; height: number; text: string; kind: PinLabelKind }>;
  /** absolute edge labels keyed by "<edgeId>.<t|s|h|n>" (tail width, source slice, head slice, net name) */
  edgeLabels: Map<string, { x: number; y: number; width: number; height: number; text: string; kind: 'width' | 'slice' | 'net' }>;
}

/** Copy positions from ELK output back into the SGraph (absolute coordinates). */
export function applyLayout(g: SGraph, elkRoot: ElkNode): Placed {
  const placed: Placed = { pinLabels: new Map(), edgeLabels: new Map() };
  const walk = (sg: SGraph, en: ElkNode, ox: number, oy: number) => {
    const byId = new Map((en.children ?? []).map((c) => [c.id, c]));
    for (const n of sg.nodes) {
      const e = byId.get(n.id);
      if (!e) continue;
      n.x = ox + (e.x ?? 0);
      n.y = oy + (e.y ?? 0);
      n.width = e.width ?? n.width;
      n.height = e.height ?? n.height;
      const portById = new Map((e.ports ?? []).map((p) => [p.id, p]));
      for (const p of n.pins) {
        const ep = portById.get(p.id);
        if (!ep) continue;
        p.x = Math.round(ep.x + (ep.width ?? 0) / 2);
        p.y = Math.round(ep.y + (ep.height ?? 0) / 2);
        if (ep.labels && ep.labels[0]) {
          const l = ep.labels[0];
          placed.pinLabels.set(p.id, {
            x: n.x + ep.x + (l.x ?? 0),
            y: n.y + ep.y + (l.y ?? 0),
            // label coordinates are relative to the port's top-left corner
            width: l.width,
            height: l.height,
            text: l.text,
            kind: pinLabelKind(p) ?? 'slice',
          });
        }
      }
      if (n.children) walk(n.children, e, n.x, n.y);
    }
    const edgeById = new Map((en.edges ?? []).map((e) => [e.id, e]));
    for (const ed of sg.edges) {
      const ee = edgeById.get(ed.id);
      if (!ee || !ee.sections || !ee.sections.length) {
        ed.points = undefined;
        continue;
      }
      // hierarchical edges may be reported relative to a different container
      let cx = ox;
      let cy = oy;
      if (ee.container && ee.container !== en.id) {
        const c = containerOffset.get(ee.container);
        if (c) {
          cx = c.x;
          cy = c.y;
        }
      }
      const s = ee.sections[0];
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: cx + p.x, y: cy + p.y }));
      ed.points = pts;
      ed.junctions = (ee.junctionPoints ?? []).map((p) => ({ x: cx + p.x, y: cy + p.y }));
      for (const l of ee.labels ?? []) {
        const id = l.id ?? `${ed.id}.n`;
        const kind = id.endsWith('.t') ? 'width' : id.endsWith('.n') ? 'net' : 'slice';
        placed.edgeLabels.set(id, { x: cx + (l.x ?? 0), y: cy + (l.y ?? 0), width: l.width, height: l.height, text: l.text, kind });
      }
    }
  };
  // pre-compute absolute container offsets
  const containerOffset = new Map<string, { x: number; y: number }>();
  const pre = (en: ElkNode, ox: number, oy: number) => {
    containerOffset.set(en.id, { x: ox, y: oy });
    for (const c of en.children ?? []) pre(c, ox + (c.x ?? 0), oy + (c.y ?? 0));
  };
  pre(elkRoot, 0, 0);
  walk(g, elkRoot, 0, 0);
  return placed;
}

// ---------------------------------------------------------------------------

import ELK from 'elkjs/lib/elk-api.js';

let elk: InstanceType<typeof ELK> | null = null;
function getElk() {
  if (!elk) {
    elk = new ELK({
      workerFactory: () => new Worker(new URL('elkjs/lib/elk-worker.min.js', import.meta.url), { type: 'module' }),
    });
  }
  return elk;
}

export function cancelPending() {
  // ELK does not support cancellation; results are discarded by sequence number in the caller
}

export async function layoutGraph(g: SGraph, o: LayoutOptions): Promise<LayoutResult & { placed: Placed }> {
  const elkGraph = graphToElk(g, o);
  const t0 = performance.now();
  const result = (await getElk().layout(elkGraph as never)) as unknown as ElkNode;
  const ms = performance.now() - t0;
  const placed = applyLayout(g, result);
  const size = placeFloating(g, placed, result.width ?? 0, result.height ?? 0);
  return { width: size.width, height: size.height, ms, placed };
}

/** Put edgeless port nodes in tidy columns: inputs on the left margin, outputs on the right. */
function placeFloating(g: SGraph, placed: Placed, width: number, height: number): { width: number; height: number } {
  const floating = g.nodes.filter((n) => isFloating(n, g));
  if (!floating.length) return { width, height };
  const ins = floating.filter((n) => n.portDir === 'input');
  const outs = floating.filter((n) => n.portDir !== 'input');
  const gap = 10;
  const pad = 24;
  let shift = 0;
  if (ins.length) {
    const colW = Math.max(...ins.map((n) => n.width));
    shift = colW + 40;
    let y = pad;
    for (const n of ins) {
      n.x = pad + colW - n.width;
      n.y = y;
      y += n.height + gap;
    }
    height = Math.max(height, y + pad);
  }
  if (shift) {
    // move everything else right
    const move = (sg: SGraph) => {
      for (const n of sg.nodes) {
        if (floating.includes(n)) continue;
        n.x += shift;
        if (n.children) move(n.children);
      }
      for (const e of sg.edges) {
        e.points?.forEach((p) => (p.x += shift));
        e.junctions?.forEach((p) => (p.x += shift));
      }
    };
    move(g);
    for (const l of placed.pinLabels.values()) l.x += shift;
    for (const l of placed.edgeLabels.values()) l.x += shift;
    width += shift;
  }
  if (outs.length) {
    const colW = Math.max(...outs.map((n) => n.width));
    let y = pad;
    for (const n of outs) {
      n.x = width - pad + 16;
      n.y = y;
      y += n.height + gap;
    }
    width += colW + 40;
    height = Math.max(height, y + pad);
  }
  return { width, height };
}
