import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import ELK from 'elkjs/lib/main.js';
import { loadDesign } from '../src/model/design';
import { buildGraph } from '../src/model/graph';
import { sizeGraph } from '../src/layout/metrics';
import { graphToElk, applyLayout } from '../src/layout/layout';

it('probe end label side', { timeout: 120000 }, async () => {
  const design = loadDesign(readFileSync('src/examples/riscv.v', 'utf8'));
  const variants: Record<string, Record<string, string>> = {
    base: {},
    el1: { 'elk.spacing.edgeLabel': '1' },
    el0: { 'elk.spacing.edgeLabel': '0' },
    el1_lp0: { 'elk.spacing.edgeLabel': '1', 'elk.spacing.labelPortVertical': '0' },
    inline: { 'elk.edgeLabels.inline': 'true' },
  };
  for (const [side, ov] of Object.entries(variants)) {
    const g = buildGraph(design, 'riscv_soc');
    sizeGraph(g, { showTypes: true });
    const elkGraph = graphToElk(g, { showTypes: true, spacing: 1, thoroughness: 7, netNames: false, freePinOrder: true, overrides: ov });
    const res = await new ELK().layout(elkGraph as never);
    const placed = applyLayout(g, res as never);
    const rows: string[] = [];
    for (const [k, v] of placed.edgeLabels) {
      const e = g.edges.find((x) => k === x.id + '.h' || k === x.id + '.t');
      if (!e || !e.points) continue;
      const endY = k.endsWith('.h') ? e.points[e.points.length - 1].y : e.points[0].y;
      rows.push(`${k}:${v.text}@${(v.y - endY).toFixed(0)}..${(v.y + v.height - endY).toFixed(0)}`);
    }
    process.stderr.write(`${side.padEnd(14)} ${rows.slice(0, 8).join('  ')}\n`);
  }
});
