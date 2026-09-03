import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ELK from 'elkjs/lib/main.js';
import { loadDesign } from '../src/model/design';
import { buildGraph } from '../src/model/graph';
import { sizeGraph } from '../src/layout/metrics';
import { graphToElk } from '../src/layout/layout';

it('lays out every module of the riscv example', { timeout: 120000 }, async () => {
  const design = loadDesign(readFileSync('src/examples/riscv.v', 'utf8'));
  for (const name of design.modules.keys()) {
    const g = buildGraph(design, name);
    sizeGraph(g, { showTypes: true });
    const t0 = performance.now();
    const res = (await new ELK().layout(graphToElk(g, { showTypes: true, spacing: 1, thoroughness: 7, netNames: false, freePinOrder: true }) as never)) as unknown as { width: number };
    process.stderr.write(`${name.padEnd(16)} ${g.nodes.length} nodes ${g.edges.length} edges ${(performance.now() - t0).toFixed(0)} ms\n`);
    if (g.edges.length) expect(res.width).toBeGreaterThan(0);
  }
});
