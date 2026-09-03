import ELK from 'elkjs/lib/main.js';
const elk = new ELK();
const mk = (extra, portH = 1) => ({
  id: 'root',
  layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL', 'elk.spacing.portPort': '19' },
  children: [
    { id: 'a', width: 40, height: 40, ports: [{ id: 'a.o', width: 1, height: 1, layoutOptions: { 'elk.port.side': 'EAST' } }], layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' } },
    { id: 'b', width: 100, height: 130, layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE', ...extra },
      ports: [0, 1, 2, 3].map((i) => ({ id: `b.p${i}`, width: 1, height: portH, layoutOptions: { 'elk.port.side': 'WEST' } })) },
  ],
  edges: [0, 1, 2, 3].map((i) => ({ id: `e${i}`, sources: ['a.o'], targets: [`b.p${i}`] })),
});
const S = '[top=40,left=0,bottom=10,right=0]';
for (const [name, extra] of Object.entries({
  center_min: { 'elk.nodeSize.constraints': 'PORTS PORT_LABELS MINIMUM_SIZE', 'elk.nodeSize.minimum': '(100, 130)', 'elk.portAlignment.default': 'CENTER', 'elk.spacing.portsSurrounding': S },
  center_nomin: { 'elk.nodeSize.constraints': 'PORTS PORT_LABELS', 'elk.portAlignment.default': 'CENTER', 'elk.spacing.portsSurrounding': S },
  end_min: { 'elk.nodeSize.constraints': 'PORTS PORT_LABELS MINIMUM_SIZE', 'elk.nodeSize.minimum': '(100, 130)', 'elk.portAlignment.default': 'END', 'elk.spacing.portsSurrounding': S },
  begin_min: { 'elk.nodeSize.constraints': 'PORTS PORT_LABELS MINIMUM_SIZE', 'elk.nodeSize.minimum': '(100, 130)', 'elk.portAlignment.default': 'BEGIN', 'elk.spacing.portsSurrounding': S },
  justified_nomin: { 'elk.nodeSize.constraints': 'PORTS PORT_LABELS', 'elk.portAlignment.default': 'JUSTIFIED', 'elk.spacing.portsSurrounding': S },
  fixed_center: { 'elk.portAlignment.default': 'CENTER', 'elk.spacing.portsSurrounding': S },
  fixed_end: { 'elk.portAlignment.default': 'END', 'elk.spacing.portsSurrounding': S },
  nodelabels: { 'elk.nodeSize.constraints': 'PORTS PORT_LABELS NODE_LABELS MINIMUM_SIZE', 'elk.nodeSize.minimum': '(100, 130)', 'elk.portAlignment.default': 'CENTER', 'elk.nodeLabels.placement': 'INSIDE V_TOP H_LEFT', NL: 1 },
})) {
  const g = mk(extra);
  if (extra.NL) { g.children[1].labels = [{ text: 'hdr', width: 60, height: 38 }]; delete g.children[1].layoutOptions.NL; }
  const r = await elk.layout(g);
  const b = r.children[1];
  console.log(name.padEnd(16), 'size', b.width, b.height, 'ports', b.ports.map((p) => `${p.y.toFixed(1)}`).join(' '));
}
