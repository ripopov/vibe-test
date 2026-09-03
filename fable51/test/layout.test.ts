import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ELK from 'elkjs/lib/main.js';
import { loadDesign } from '../src/model/design';
import { buildGraph } from '../src/model/graph';
import { sizeGraph } from '../src/layout/metrics';
import { graphToElk, applyLayout } from '../src/layout/layout';

const src = readFileSync('src/examples/riscv.v', 'utf8');

describe('layout', () => {
  it('places input ports in the first layer and outputs in the last', async () => {
    const design = loadDesign(src);
    const g = buildGraph(design, 'riscv_core');
    sizeGraph(g, { showTypes: true });
    const elkGraph = graphToElk(g, { showTypes: true, spacing: 1, thoroughness: 7, netNames: false, freePinOrder: true });
    const elk = new ELK();
    const res = await elk.layout(elkGraph as never);
    applyLayout(g, res as never);
    const ports = g.nodes.filter((n) => n.kind === 'port');
    const others = g.nodes.filter((n) => n.kind !== 'port');
    const minX = Math.min(...others.map((n) => n.x));
    const maxX = Math.max(...others.map((n) => n.x + n.width));
    const report = ports.map((p) => `${p.portDir} ${p.title} x=${p.x.toFixed(0)}`).join('\n');
    for (const p of ports) {
      const hasEdges = g.edges.some((e) => e.from.startsWith(p.id + '.') || e.to.startsWith(p.id + '.'));
      if (!hasEdges) continue;
      if (p.portDir === 'input') expect(p.x + p.width, `${p.title} should be left of everything\n${report}`).toBeLessThanOrEqual(minX + 1);
      else expect(p.x, `${p.title} should be right of everything\n${report}`).toBeGreaterThanOrEqual(maxX - 1);
    }
  });
});
