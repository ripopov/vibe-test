import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import ELK from 'elkjs/lib/main.js';
import { loadDesign } from '../src/model/design';
import { buildGraph } from '../src/model/graph';
import { sizeGraph } from '../src/layout/metrics';
import { graphToElk, applyLayout } from '../src/layout/layout';

it('probe gate netlist layer structure', { timeout: 600000 }, async () => {
  const design = loadDesign(readFileSync('src/examples/gates.v', 'utf8'));
  const g = buildGraph(design, 'gatelevel_top');
  sizeGraph(g, { showTypes: true });
  const elkGraph = graphToElk(g, { showTypes: true, spacing: 0.8, thoroughness: 1, netNames: false, freePinOrder: true });
  const res = await new ELK().layout(elkGraph as never);
  applyLayout(g, res as never);
  // cluster nodes by x into layers
  const xs = [...new Set(g.nodes.map((n) => Math.round(n.x)))].sort((a, b) => a - b);
  const layers: number[][] = [];
  let cur: number[] = [];
  let last = -1e9;
  for (const x of xs) {
    if (x - last > 60 && cur.length) {
      layers.push(cur);
      cur = [];
    }
    cur.push(x);
    last = x;
  }
  if (cur.length) layers.push(cur);
  const nodeLayer = new Map<string, number>();
  for (const n of g.nodes) {
    const li = layers.findIndex((l) => l.includes(Math.round(n.x)));
    nodeLayer.set(n.id, li);
  }
  const perLayer = layers.map(() => ({ n: 0, h: 0, ymin: 1e9, ymax: -1e9 }));
  for (const n of g.nodes) {
    const l = perLayer[nodeLayer.get(n.id)!];
    l.n++;
    l.h += n.height;
    l.ymin = Math.min(l.ymin, n.y);
    l.ymax = Math.max(l.ymax, n.y + n.height);
  }
  const pinNode = new Map<string, string>();
  for (const n of g.nodes) for (const p of n.pins) pinNode.set(p.id, n.id);
  let spanSum = 0;
  let back = 0;
  const spans: number[] = [];
  for (const e of g.edges) {
    const a = nodeLayer.get(pinNode.get(e.from)!)!;
    const b = nodeLayer.get(pinNode.get(e.to)!)!;
    spanSum += Math.abs(b - a);
    spans.push(b - a);
    if (b <= a) back++;
  }
  process.stderr.write(`layers=${layers.length} edges=${g.edges.length} avgSpan=${(spanSum / g.edges.length).toFixed(1)} backward=${back}\n`);
  process.stderr.write(`size=${Math.round((res as unknown as { width: number }).width)}x${Math.round((res as unknown as { height: number }).height)}\n`);
  perLayer.forEach((l, i) => process.stderr.write(`L${i}: nodes=${l.n} sumH=${l.h} extent=${Math.round(l.ymax - l.ymin)}\n`));
  const hist = new Map<number, number>();
  for (const s of spans) hist.set(s, (hist.get(s) ?? 0) + 1);
  process.stderr.write('span histogram: ' + [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' ') + '\n');
});
