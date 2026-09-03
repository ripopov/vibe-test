// End-to-end interaction checks with headless Chrome.
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:4173/';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
const settle = async () => {
  await page.waitForFunction(() => window.nsv && !window.nsv.isBusy() && window.nsv.state.graph, { timeout: 120000, polling: 100 });
  await new Promise((r) => setTimeout(r, 150));
};
const check = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);

await page.goto(`${base}?example=riscv&theme=light&path=u_core`, { waitUntil: 'networkidle0' });
await settle();

// 1. click an instance -> selected + editor jumps to its source line
const instBox = await page.evaluate(() => {
  const n = [...document.querySelectorAll('.node.inst')].find((e) => e.dataset.tip.includes('u_alu'));
  const r = n.querySelector('.shape').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: n.dataset.id };
});
await page.mouse.click(instBox.x, instBox.y);
await new Promise((r) => setTimeout(r, 200));
let res = await page.evaluate(() => ({
  selected: document.querySelector('.node.selected')?.dataset.tip,
  hilite: document.querySelectorAll('.cm-lineHilite').length,
  hiliteText: document.querySelector('.cm-lineHilite')?.textContent,
  treeSel: document.querySelector('.tree .row.selected')?.textContent,
}));
check('click instance selects it', res.selected?.includes('u_alu'), res.selected);
check('editor jumps to instance source', res.hilite > 0 && /alu\s+u_alu/.test(res.hiliteText ?? ''), JSON.stringify(res.hiliteText));
check('tree follows selection', (res.treeSel ?? '').includes('u_alu'), res.treeSel);

// 2. click a wire -> net highlighted, editor jumps to declaration
const wire = await page.evaluate(() => {
  const e = [...document.querySelectorAll('.edge')].find((x) => x.dataset.nets.includes('alu_result'));
  const p = e.querySelector('.wire');
  const len = p.getTotalLength();
  const pt = p.getPointAtLength(len / 2);
  const ctm = p.getScreenCTM();
  return { x: ctm.a * pt.x + ctm.e, y: ctm.d * pt.y + ctm.f, nets: e.dataset.nets };
});
await page.mouse.click(wire.x, wire.y);
await new Promise((r) => setTimeout(r, 200));
res = await page.evaluate(() => ({
  hl: document.querySelectorAll('.edge.hl').length,
  total: document.querySelectorAll('.edge').length,
  pins: document.querySelectorAll('.pin.hl').length,
  hiliteText: document.querySelector('.cm-lineHilite')?.textContent,
}));
check('click wire highlights whole net', res.hl >= 3 && res.hl < res.total, `${res.hl}/${res.total} edges, ${res.pins} pins`);
check('editor jumps to net declaration', /alu_result/.test(res.hiliteText ?? ''), JSON.stringify(res.hiliteText));

// 3. hover tooltip
await page.mouse.move(instBox.x, instBox.y);
await new Promise((r) => setTimeout(r, 100));
res = await page.evaluate(() => ({ hidden: document.querySelector('#tooltip').hidden, text: document.querySelector('#tooltip').textContent }));
check('hover shows tooltip', !res.hidden && res.text.includes('alu'), res.text);

// 4. editor cursor -> schematic selection
await page.evaluate(() => {
  const v = window.nsv.editor.view;
  const doc = v.state.doc.toString();
  const off = doc.indexOf('branch_unit u_bru');
  v.dispatch({ selection: { anchor: off + 3 }, userEvent: 'select' });
});
await new Promise((r) => setTimeout(r, 200));
res = await page.evaluate(() => document.querySelector('.node.selected')?.dataset.tip);
check('editor cursor selects instance in schematic', (res ?? '').includes('u_bru'), res);
await page.evaluate(() => {
  const v = window.nsv.editor.view;
  const doc = v.state.doc.toString();
  const off = doc.indexOf('wire [31:0] alu_a, alu_b, alu_result;');
  v.dispatch({ selection: { anchor: off + 30 }, userEvent: 'select' });
});
await new Promise((r) => setTimeout(r, 200));
res = await page.evaluate(() => document.querySelectorAll('.edge.hl').length);
check('editor cursor on net declaration highlights net', res > 0, `${res} edges`);

// 5. expand in place
await page.evaluate(() => {
  const n = window.nsv.state.graph.nodes.find((x) => x.refName === 'u_alu');
  window.nsv.toggleExpand(n);
});
await settle();
res = await page.evaluate(() => ({
  expanded: document.querySelectorAll('.node.expanded').length,
  inner: [...document.querySelectorAll('.node.inst')].filter((e) => e.dataset.path?.startsWith('u_alu/')).length,
  status: document.querySelector('#status').textContent,
}));
check('expand instance in place', res.expanded === 1 && res.inner >= 2, JSON.stringify(res));
await page.screenshot({ path: 'shots/core_expanded.png' });
const report = await page.evaluate(() => {
  const vp = document.querySelector('#viewport');
  const texts = [...vp.querySelectorAll('text')].map((t) => t.getBoundingClientRect());
  const els = [...vp.querySelectorAll('text')];
  let overlaps = 0;
  const pairs = [];
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i], b = texts[j];
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
      overlaps++;
      const rr = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      pairs.push([els[i].textContent, els[i].className.baseVal, rr(a), els[j].textContent, els[j].className.baseVal, rr(b)]);
    }
  }
  return { overlaps, pairs };
});
check('no label overlaps with expanded instance', report.overlaps === 0, JSON.stringify(report));

// 6. live edit re-parses: add an instance
await page.evaluate(() => {
  const v = window.nsv.editor.view;
  const doc = v.state.doc.toString();
  const off = doc.indexOf('  irq_ctrl u_irq (');
  v.dispatch({ changes: { from: off, insert: '  alu u_alu2 (.a(alu_a), .b(alu_b), .op(alu_op), .result(), .zero(), .lt());\n' } });
});
await new Promise((r) => setTimeout(r, 500));
await settle();
res = await page.evaluate(() => [...document.querySelectorAll('.node.inst')].some((e) => e.dataset.tip.includes('u_alu2')));
check('live edit adds instance to schematic', res);

// 7. descend by double click
await page.evaluate(() => window.nsv.navigateTo(['u_core', 'u_alu']));
await settle();
res = await page.evaluate(() => ({ crumbs: document.querySelector('#breadcrumbs').textContent, status: document.querySelector('#status').textContent }));
check('navigate into u_alu', res.crumbs.includes('u_alu') && res.status.startsWith('alu'), res.crumbs);
await page.screenshot({ path: 'shots/alu.png' });

// 8. search
await page.type('#search', 'imm');
await new Promise((r) => setTimeout(r, 200));
res = await page.evaluate(() => [...document.querySelectorAll('#search-results .item')].map((e) => e.textContent));
check('search finds hierarchy items', res.some((t) => t.includes('u_imm')), res.slice(0, 3).join(' | '));

// 9. dark theme + export
await page.evaluate(() => window.nsv.setTheme(true));
await new Promise((r) => setTimeout(r, 200));
await page.evaluate(() => window.nsv.navigateTo([]));
await settle();
await page.screenshot({ path: 'shots/soc_dark.png' });
const svg = await page.evaluate(() => window.nsv.exportSvg());
writeFileSync('shots/export.svg', svg);
const valid = await page.evaluate((s) => !new DOMParser().parseFromString(s, 'image/svg+xml').querySelector('parsererror'), svg);
check('export produces valid SVG', valid && svg.includes('<path') && svg.includes('<style>'), `${svg.length} bytes`);

// 10. black boxes & odd syntax via file load
await page.evaluate(() => {
  window.nsv.editor.setDoc(`module t(input a, b, output y, inout [3:0] z);
    wire [1:0] w;
    mystery u0 (.x(a), .y(w[0]), .z(z));
    mystery u1 (a, b, w[1]);
    assign y = &w;
  endmodule`);
});
await new Promise((r) => setTimeout(r, 600));
await settle();
res = await page.evaluate(() => ({ status: document.querySelector('#status').textContent, bb: document.querySelectorAll('.node.blackbox').length }));
check('black boxes render', res.bb === 2, JSON.stringify(res));
await page.screenshot({ path: 'shots/blackbox.png' });

// 11. default example: riscv-simple-sv single-cycle core, process nodes, parameters
await page.goto(`${base}?theme=light`, { waitUntil: 'networkidle0' });
await settle();
res = await page.evaluate(() => ({
  example: document.querySelector('#example-select').value,
  status: document.querySelector('#status').textContent,
  crumbs: document.querySelector('#crumbs')?.textContent ?? '',
  diags: document.querySelector('#diag-count')?.textContent,
}));
check('default example is riscv-simple-sv', res.example === 'rvsimple-singlecycle' && res.status.startsWith('toplevel'), JSON.stringify(res));
check('no parser diagnostics', /modules/.test(res.diags ?? ''), res.diags);
// descend into the ALU: an always_comb process drives result
await page.evaluate(() => window.nsv.navigateTo(['riscv_core', 'singlecycle_datapath', 'alu']));
await settle();
const proc = await page.evaluate(() => {
  const n = document.querySelector('.node.proc');
  const r = n.querySelector('.shape').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tip: n.dataset.tip, pins: [...n.querySelectorAll('.pinlabel')].map((e) => e.textContent) };
});
check('always_comb renders as a process node', proc.tip.startsWith('always_comb') && proc.pins.includes('operand_a') && proc.pins.includes('result'), JSON.stringify(proc.pins));
await page.mouse.click(proc.x, proc.y);
await new Promise((r) => setTimeout(r, 200));
res = await page.evaluate(() => ({ selected: document.querySelector('.node.selected')?.dataset.kind, hiliteText: document.querySelector('.cm-lineHilite')?.textContent }));
check('clicking a process jumps to the always block', res.selected === 'proc' && /always_comb/.test(res.hiliteText ?? ''), JSON.stringify(res));
// parameterised instance: multiplexer #(CHANNELS=8) shows 256-bit in_bus
await page.evaluate(() => window.nsv.navigateTo(['riscv_core', 'singlecycle_datapath', 'mux_reg_writeback', 'multiplexer']));
await settle();
res = await page.evaluate(() => ({
  status: document.querySelector('#status').textContent,
  labels: [...document.querySelectorAll('.wlabel')].map((e) => e.textContent),
  tree: document.querySelector('.tree .row.current')?.textContent,
}));
check('parameter overrides size the ports', res.labels.includes('256') && res.labels.includes('3'), JSON.stringify(res.labels));
check('tree shows parameter values', (res.tree ?? '').includes('CHANNELS=8'), res.tree);
// pipeline registers: unpacked array elements are separate nets
await page.evaluate(() => { document.querySelector('#example-select').value = 'rvsimple-pipeline'; document.querySelector('#example-select').dispatchEvent(new Event('change')); });
await settle();
await page.evaluate(() => window.nsv.navigateTo(['riscv_core', 'pipeline_datapath']));
await settle();
res = await page.evaluate(() => ({
  procs: document.querySelectorAll('.node.proc').length,
  pins: [...document.querySelectorAll('.node.proc .pinlabel')].map((e) => e.textContent).filter((t) => /^inst\[/.test(t)),
  status: document.querySelector('#status').textContent,
}));
check('pipeline registers are processes over array elements', res.procs === 4 && res.pins.includes('inst[0]') && res.pins.includes('inst[1]'), JSON.stringify(res));
await page.screenshot({ path: 'shots/pipeline.png' });

await browser.close();
