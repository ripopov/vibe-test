// End-to-end checks for the mobile (schematic-first) layout with an emulated phone in headless Chrome.
// usage: node scripts/mobile.mjs [baseUrl]
import puppeteer, { KnownDevices } from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5173/';
mkdirSync('shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const phone = KnownDevices['iPhone 13'];
await page.emulate({ ...phone, viewport: { ...phone.viewport, deviceScaleFactor: 2 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => {
  await page.waitForFunction(() => window.nsv && !window.nsv.isBusy() && window.nsv.state.graph, { timeout: 120000, polling: 100 });
  await sleep(150);
};
let fails = 0;
const check = (name, ok, extra = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
};
const url = (q) => `${base}?${q}`;
const tapSel = async (sel) => {
  const r = await page.evaluate((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel);
  await page.touchscreen.tap(r.x, r.y);
};
const nodeCenter = (pred) => page.evaluate((src) => {
  const pred = new Function('n', `return (${src})(n)`);
  const n = [...document.querySelectorAll('.node')].find((e) => pred(e));
  if (!n) return null;
  const r = (n.querySelector('.shape.body') ?? n.querySelector('.shape')).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: n.dataset.id, tip: n.dataset.tip };
}, pred.toString());

// ---- 1. mode detection -------------------------------------------------------
await page.goto(url('theme=light'), { waitUntil: 'networkidle0' });
await settle();
let res = await page.evaluate(() => ({
  mobile: document.documentElement.classList.contains('mobile'),
  mbar: getComputedStyle(document.querySelector('#mbar')).display,
  tree: getComputedStyle(document.querySelector('#tree-panel')).position,
  editorVisible: document.querySelector('#editor-panel').getBoundingClientRect().top < window.innerHeight,
  crumbsInBar: !!document.querySelector('#m-title #breadcrumbs'),
  status: document.querySelector('#status').textContent,
  hscroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
}));
check('phone gets the mobile layout', res.mobile && res.mbar === 'flex' && res.tree === 'fixed' && res.crumbsInBar, JSON.stringify(res));
check('sheets start closed', !res.editorVisible);
check('default design loads on mobile', res.status.startsWith('toplevel · 13 nodes'), res.status);
check('no horizontal page overflow', res.hscroll);
res = await page.evaluate(() => {
  const v = window.nsv.viewer.getView();
  const b = window.nsv.viewer.getBounds();
  const c = document.querySelector('#viewer');
  return { fitsW: b.width * v.scale <= c.clientWidth + 1, fitsH: b.height * v.scale <= c.clientHeight + 1, scale: v.scale };
});
check('schematic is fitted to the phone screen', res.fitsW && res.fitsH, JSON.stringify(res));
await page.screenshot({ path: 'shots/m-01-default.png' });

// ---- 2. tap selects, info card offers actions ----------------------------------
let core = await nodeCenter((n) => n.classList.contains('inst') && n.dataset.tip.includes('riscv_core'));
await page.touchscreen.tap(core.x, core.y);
await sleep(250);
res = await page.evaluate(() => ({
  selected: document.querySelector('.node.selected')?.dataset.tip,
  card: !document.querySelector('#infocard').hidden,
  title: document.querySelector('#ic-title').textContent,
  actions: [...document.querySelectorAll('#ic-actions .btn')].map((b) => b.textContent),
  tooltip: getComputedStyle(document.querySelector('#tooltip')).display,
}));
check('tap selects an instance', (res.selected ?? '').includes('riscv_core'), res.selected);
check('info card shows selection with actions', res.card && res.title.startsWith('riscv_core') && res.actions.includes('Descend') && res.actions.includes('Source'), JSON.stringify(res));
check('no hover tooltip on mobile', res.tooltip === 'none');
await page.screenshot({ path: 'shots/m-02-selected.png' });

// tap the Descend action
await page.evaluate(() => [...document.querySelectorAll('#ic-actions .btn')].find((b) => b.textContent === 'Descend').click());
await settle();
res = await page.evaluate(() => ({ path: window.nsv.state.path.join('/'), crumbs: document.querySelector('#breadcrumbs').textContent, up: document.querySelector('#m-up').disabled }));
check('Descend action navigates into the instance', res.path === 'riscv_core' && res.crumbs.includes('riscv_core') && !res.up, JSON.stringify(res));

// ---- 3. double tap descends, back button goes up --------------------------------
const dp = await nodeCenter((n) => n.classList.contains('inst') && n.dataset.tip.includes('singlecycle_datapath'));
await page.touchscreen.tap(dp.x, dp.y);
await sleep(80);
await page.touchscreen.tap(dp.x, dp.y);
await settle();
res = await page.evaluate(() => window.nsv.state.path.join('/'));
check('double tap descends into instance', res === 'riscv_core/singlecycle_datapath', res);
await tapSel('#m-up');
await settle();
res = await page.evaluate(() => ({ path: window.nsv.state.path.join('/'), sel: document.querySelector('.node.selected')?.dataset.tip }));
check('back button goes up and selects the instance we came from', res.path === 'riscv_core' && (res.sel ?? '').includes('singlecycle_datapath'), JSON.stringify(res));

// ---- 4. pan and pinch ----------------------------------------------------------
const v0 = await page.evaluate(() => window.nsv.viewer.getView());
let t = await page.touchscreen.touchStart(200, 500);
for (let i = 1; i <= 8; i++) await t.move(200 + i * 10, 500 + i * 5);
await t.end();
await sleep(300);
let v1 = await page.evaluate(() => ({ ...window.nsv.viewer.getView(), pending: window.nsv.viewer.hasPendingTransform(), sel: !!document.querySelector('.node.selected') }));
check('one-finger drag pans', Math.abs(v1.tx - v0.tx - 80) < 1 && Math.abs(v1.ty - v0.ty - 40) < 1 && !v1.pending, JSON.stringify(v1));
check('panning keeps the selection', v1.sel);
// pinch out around (195, 500)
const a = await page.touchscreen.touchStart(170, 500);
const b = await page.touchscreen.touchStart(220, 500);
for (let i = 1; i <= 6; i++) {
  await a.move(170 - i * 15, 500);
  await b.move(220 + i * 15, 500);
}
await a.end();
await b.end();
await sleep(300);
const v2 = await page.evaluate(() => ({ ...window.nsv.viewer.getView(), pending: window.nsv.viewer.hasPendingTransform() }));
// the graph point under the pinch centre must stay put: (195 - tx)/scale is invariant
const g1 = (195 - v1.tx) / v1.scale;
const g2 = (195 - v2.tx) / v2.scale;
check('pinch zooms around its centre', v2.scale / v1.scale > 3 && Math.abs(g1 - g2) < 2 && !v2.pending, `x${(v2.scale / v1.scale).toFixed(2)} drift ${(g2 - g1).toFixed(2)}`);
await page.screenshot({ path: 'shots/m-03-zoomed.png' });
await tapSel('#m-fit');
await sleep(100);
const v3 = await page.evaluate(() => window.nsv.viewer.getView());
check('fit button restores the view', Math.abs(v3.scale - v0.scale) < 1e-6);

// ---- 5. long press opens the context menu ---------------------------------------
core = await nodeCenter((n) => n.classList.contains('inst') && n.dataset.tip.includes('singlecycle_ctlpath'));
t = await page.touchscreen.touchStart(core.x, core.y);
await sleep(700);
await t.end();
await sleep(200);
res = await page.evaluate(() => ({ menu: !document.querySelector('#ctxmenu').hidden, items: [...document.querySelectorAll('#ctxmenu .item')].map((i) => i.textContent) }));
check('long press opens the context menu', res.menu && res.items.includes('Descend into instance'), JSON.stringify(res.items));
await page.screenshot({ path: 'shots/m-04-ctxmenu.png' });
await page.evaluate(() => [...document.querySelectorAll('#ctxmenu .item')].find((i) => i.textContent === 'Descend into instance').click());
await settle();
res = await page.evaluate(() => ({ path: window.nsv.state.path.join('/'), menu: !document.querySelector('#ctxmenu').hidden }));
check('context menu action works and closes the menu', res.path === 'riscv_core/singlecycle_ctlpath' && !res.menu, JSON.stringify(res));
await tapSel('#m-up');
await settle();

// ---- 6. hierarchy sheet ---------------------------------------------------------
await tapSel('#m-tree');
await sleep(350);
res = await page.evaluate(() => {
  const p = document.querySelector('#tree-panel');
  const r = p.getBoundingClientRect();
  return { open: p.classList.contains('open'), onScreen: r.top < window.innerHeight && r.bottom <= window.innerHeight + 1, backdrop: !document.querySelector('#backdrop').hidden, rows: document.querySelectorAll('.tree .row').length };
});
check('hierarchy sheet slides in', res.open && res.onScreen && res.backdrop && res.rows > 5, JSON.stringify(res));
await page.screenshot({ path: 'shots/m-05-tree.png' });
const row = await page.evaluate(() => {
  const r = [...document.querySelectorAll('.tree .row')].find((x) => x.dataset.path === 'toplevel/riscv_core/singlecycle_datapath/alu');
  if (!r) return null;
  const b = r.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, visible: b.top >= 0 && b.bottom <= window.innerHeight };
});
check('tree row for a nested instance is visible', row?.visible, JSON.stringify(row));
await page.touchscreen.tap(row.x, row.y);
await settle();
res = await page.evaluate(() => ({ path: window.nsv.state.path.join('/'), sel: document.querySelector('.node.selected')?.dataset.tip, open: document.querySelector('#tree-panel').classList.contains('open') }));
check('tapping a tree row shows it and closes the sheet', res.path === 'riscv_core/singlecycle_datapath' && (res.sel ?? '').includes('alu') && !res.open, JSON.stringify(res));

// ---- 7. source sheet ------------------------------------------------------------
await page.evaluate(() => [...document.querySelectorAll('#ic-actions .btn')].find((b) => b.textContent === 'Source').click());
await sleep(400);
res = await page.evaluate(() => {
  const p = document.querySelector('#editor-panel');
  const hl = document.querySelector('.cm-lineHilite');
  const r = hl?.getBoundingClientRect();
  const pr = p.getBoundingClientRect();
  return { open: p.classList.contains('open'), text: hl?.textContent, hlVisible: !!r && r.top >= pr.top && r.bottom <= pr.bottom, cm: !!p.querySelector('.cm-editor') };
});
check('Source action opens the editor sheet at the instance', res.open && /alu\s+alu/.test(res.text ?? '') && res.hlVisible, JSON.stringify(res));
await page.screenshot({ path: 'shots/m-06-source.png' });
await page.touchscreen.tap(195, 100); // backdrop area between the bar and the sheet
await sleep(300);
res = await page.evaluate(() => document.querySelector('#editor-panel').classList.contains('open'));
check('tapping the backdrop closes the sheet', !res);

// ---- 8. search --------------------------------------------------------------------
await tapSel('#m-search');
await sleep(200);
res = await page.evaluate(() => ({ open: document.documentElement.classList.contains('search-open'), focused: document.activeElement === document.querySelector('#search'), visible: document.querySelector('#search').getBoundingClientRect().width > 200 }));
check('search bar opens full width and focuses', res.open && res.focused && res.visible, JSON.stringify(res));
await page.keyboard.type('regfile');
await sleep(200);
res = await page.evaluate(() => [...document.querySelectorAll('#search-results .item')].map((i) => i.textContent));
check('search finds instances in the current module', res.some((x) => x.includes('regfile')), JSON.stringify(res.slice(0, 3)));
await page.screenshot({ path: 'shots/m-07-search.png' });
const item = await page.evaluate(() => {
  const i = [...document.querySelectorAll('#search-results .item')].find((x) => x.textContent.startsWith('instance') && x.textContent.includes('regfile'));
  const r = i.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.touchscreen.tap(item.x, item.y);
await sleep(300);
res = await page.evaluate(() => ({ sel: document.querySelector('.node.selected')?.dataset.tip, open: document.documentElement.classList.contains('search-open') }));
check('tapping a result selects it and closes search', (res.sel ?? '').includes('regfile') && !res.open, JSON.stringify(res));

// ---- 9. settings sheet: example, theme --------------------------------------------
await tapSel('#m-settings');
await sleep(350);
res = await page.evaluate(() => {
  const p = document.querySelector('#settings-panel');
  const r = p.getBoundingClientRect();
  const sel = document.querySelector('#example-select').getBoundingClientRect();
  return { open: p.classList.contains('open'), onScreen: r.top > 0 && r.bottom <= window.innerHeight + 1, selectVisible: sel.top >= r.top && sel.bottom <= r.bottom && sel.width > 150 };
});
check('settings sheet shows the example selector', res.open && res.onScreen && res.selectVisible, JSON.stringify(res));
await page.screenshot({ path: 'shots/m-08-settings.png' });
await page.select('#example-select', 'rvsimple-pipeline');
await settle();
res = await page.evaluate(() => document.querySelector('#status').textContent);
check('switching the example from settings reloads the design', res.startsWith('toplevel'), res);
await tapSel('#theme-btn');
await sleep(100);
res = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, meta: document.querySelector('meta[name=theme-color]').content }));
check('theme toggle works on mobile', res.theme === 'dark' && res.meta === '#1b1f26', JSON.stringify(res));
await page.evaluate(() => document.querySelector('[data-close="settings-panel"]').click());
await sleep(300);
await page.evaluate(() => window.nsv.navigateTo(['riscv_core', 'pipeline_datapath']));
await settle();
await page.screenshot({ path: 'shots/m-09-pipeline-dark.png' });
await tapSel('#theme-btn');

// ---- 10. landscape keeps the mobile layout and refits --------------------------------
const land = KnownDevices['iPhone 13 landscape'];
await page.emulate({ ...land, viewport: { ...land.viewport, deviceScaleFactor: 2 } });
await sleep(400);
res = await page.evaluate(() => {
  const v = window.nsv.viewer.getView();
  const b = window.nsv.viewer.getBounds();
  const c = document.querySelector('#viewer');
  return { mobile: document.documentElement.classList.contains('mobile'), fits: b.width * v.scale <= c.clientWidth + 1 && b.height * v.scale <= c.clientHeight + 1, w: c.clientWidth };
});
check('landscape phone stays in mobile mode with a fitted view', res.mobile && res.fits && res.w > 700, JSON.stringify(res));
await page.screenshot({ path: 'shots/m-10-landscape.png' });
await page.emulate({ ...phone, viewport: { ...phone.viewport, deviceScaleFactor: 2 } });
await sleep(300);

// ---- 11. gesture performance under CPU throttling ------------------------------------
// measure frames during a scripted 40-frame pan; the frame budget at 4x throttling is generous
// because the emulated CPU is ~4x slower than the dev machine
const panProbe = async () => page.evaluate(async () => {
  const c = document.querySelector('#viewer');
  const rect = c.getBoundingClientRect();
  const x0 = rect.left + rect.width / 2, y0 = rect.top + rect.height / 2;
  const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1 }));
  const svg = document.querySelector('#svg');
  const target = svg.firstElementChild;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  ev('pointerdown', x0, y0);
  const frames = [];
  let last = performance.now();
  for (let i = 1; i <= 40; i++) {
    ev('pointermove', x0 + i * 4, y0 + i * 2);
    await raf();
    const now = performance.now();
    frames.push(now - last);
    last = now;
  }
  ev('pointerup', x0 + 160, y0 + 80);
  void target;
  frames.sort((a, b) => a - b);
  return { median: frames[20], p90: frames[36], max: frames[39], composited: window.nsv.viewer.isComposited(), elements: window.nsv.viewer.elementCount };
});
await page.emulateCPUThrottling(4);
let perf = await panProbe();
check('pan stays smooth on a medium graph (4x CPU throttle)', perf.median < 20 && perf.p90 < 34, `median ${perf.median.toFixed(1)} ms, p90 ${perf.p90.toFixed(1)} ms, ${perf.elements} elements, composited=${perf.composited}`);
await page.emulateCPUThrottling(1);
await page.evaluate(() => { document.querySelector('#example-select').value = 'gates'; document.querySelector('#example-select').dispatchEvent(new Event('change')); });
await settle();
await page.emulateCPUThrottling(4);
perf = await panProbe();
check('large graph uses the composited gesture path', perf.composited && perf.elements > 5000, `${perf.elements} elements`);
check('pan stays smooth on the 1.5k-cell netlist (4x CPU throttle)', perf.median < 20 && perf.p90 < 34, `median ${perf.median.toFixed(1)} ms, p90 ${perf.p90.toFixed(1)} ms`);
await sleep(400);
res = await page.evaluate(() => ({ pending: window.nsv.viewer.hasPendingTransform(), css: document.querySelector('#svg').style.transform }));
check('composited transform is committed after the gesture', !res.pending && res.css === '', JSON.stringify(res));
// the composited path must not change what the user sees: compare a drag with the direct path
const drift = await page.evaluate(async () => {
  const v = window.nsv.viewer;
  const c = document.querySelector('#viewer');
  const rect = c.getBoundingClientRect();
  const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1 }));
  const run = async (mode) => {
    v.setGestureMode(mode);
    v.fit();
    const x0 = rect.left + 100, y0 = rect.top + 300;
    ev('pointerdown', x0, y0);
    for (let i = 1; i <= 10; i++) { ev('pointermove', x0 + i * 7, y0 + i * 3); await new Promise((r) => requestAnimationFrame(r)); }
    ev('pointerup', x0 + 70, y0 + 30);
    await new Promise((r) => setTimeout(r, 300));
    return v.getView();
  };
  const a = await run('direct');
  const b = await run('composited');
  v.setGestureMode('auto');
  return Math.abs(a.tx - b.tx) + Math.abs(a.ty - b.ty) + Math.abs(a.scale - b.scale);
});
check('composited and direct gesture paths agree', drift < 0.01, `drift ${drift}`);
await page.emulateCPUThrottling(1);

// ---- 12. desktop is untouched -------------------------------------------------------
const desk = await browser.newPage();
await desk.setViewport({ width: 1600, height: 1000 });
await desk.goto(url('theme=light'), { waitUntil: 'networkidle0' });
await desk.waitForFunction(() => window.nsv && !window.nsv.isBusy() && window.nsv.state.graph, { timeout: 120000, polling: 100 });
res = await desk.evaluate(() => ({
  mobile: document.documentElement.classList.contains('mobile'),
  mbar: getComputedStyle(document.querySelector('#mbar')).display,
  tree: document.querySelector('#tree-panel').getBoundingClientRect().width,
  editor: document.querySelector('#editor-panel').getBoundingClientRect().width,
  crumbsInToolbar: !!document.querySelector('.toolbar #breadcrumbs'),
  fabs: getComputedStyle(document.querySelector('.fabs')).display,
}));
check('desktop browser gets the desktop layout', !res.mobile && res.mbar === 'none' && res.tree > 200 && res.editor > 300 && res.crumbsInToolbar && res.fabs === 'none', JSON.stringify(res));
await desk.goto(url('theme=light&mobile=1'), { waitUntil: 'networkidle0' });
await desk.waitForFunction(() => window.nsv && !window.nsv.isBusy() && window.nsv.state.graph, { timeout: 120000, polling: 100 });
res = await desk.evaluate(() => document.documentElement.classList.contains('mobile'));
check('?mobile=1 forces the mobile layout on desktop', res);
// narrow desktop window switches live
await desk.goto(url('theme=light'), { waitUntil: 'networkidle0' });
await desk.waitForFunction(() => window.nsv && !window.nsv.isBusy() && window.nsv.state.graph, { timeout: 120000, polling: 100 });
await desk.setViewport({ width: 600, height: 900 });
await sleep(300);
res = await desk.evaluate(() => document.documentElement.classList.contains('mobile'));
await desk.setViewport({ width: 1400, height: 900 });
await sleep(300);
const back = await desk.evaluate(() => ({ mobile: document.documentElement.classList.contains('mobile'), crumbs: !!document.querySelector('.toolbar #breadcrumbs') }));
check('layout switches live when the window is resized', res && !back.mobile && back.crumbs, JSON.stringify({ narrow: res, back }));
await desk.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} check(s) failed` : 'all mobile checks passed');
process.exit(fails ? 1 : 0);
