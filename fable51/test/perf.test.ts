import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import ELK from 'elkjs/lib/main.js';
import { loadDesign } from '../src/model/design';
import { buildGraph } from '../src/model/graph';
import { sizeGraph } from '../src/layout/metrics';
import { graphToElk } from '../src/layout/layout';

const src = readFileSync('src/examples/gates.v', 'utf8');

it('perf variants', { timeout: 1_000_000 }, async () => {
  const variants: Record<string, Record<string, string>> = {
    bk_leftup: { 'elk.layered.thoroughness': '1', 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', 'elk.layered.nodePlacement.bk.fixedAlignment': 'LEFTUP' },
    bk_nostraight: { 'elk.layered.thoroughness': '1', 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', 'elk.layered.nodePlacement.bk.edgeStraightening': 'NONE' },
    postcomp: { 'elk.layered.thoroughness': '1', 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', 'elk.layered.compaction.postCompaction.strategy': 'LEFT' },
    sp06: { 'elk.layered.thoroughness': '1', 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', 'elk.spacing.nodeNode': '12', 'elk.layered.spacing.nodeNodeBetweenLayers': '30', 'elk.spacing.edgeEdge': '6', 'elk.layered.spacing.edgeEdgeBetweenLayers': '6', 'elk.layered.spacing.edgeNodeBetweenLayers': '12' },
    nomerge: { 'elk.layered.thoroughness': '1', 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', 'elk.layered.mergeEdges': 'false' },
    fixedpins: { 'elk.layered.thoroughness': '1', 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', FIXEDPOS: '1' },
    nofavor: { 'elk.layered.thoroughness': '1', 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', 'elk.layered.nodePlacement.favorStraightEdges': 'false' },
  };
  const design = loadDesign(src);
  const only = process.env.VARIANT;
  for (const [name, ov] of Object.entries(variants)) {
    if (only && name !== only) continue;
    const g = buildGraph(design, 'gatelevel_top');
    sizeGraph(g, { showTypes: true });
    const fixed = !!ov.FIXEDPOS;
    delete ov.FIXEDPOS;
    const elkGraph = graphToElk(g, { showTypes: true, spacing: 0.8, thoroughness: 1, netNames: false, freePinOrder: !fixed, overrides: ov });
    const t0 = performance.now();
    const res = (await new ELK().layout(elkGraph as never)) as unknown as { width: number; height: number };
    process.stderr.write(`${name.padEnd(14)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms  ${Math.round(res.width)}x${Math.round(res.height)}\n`);
  }
});
