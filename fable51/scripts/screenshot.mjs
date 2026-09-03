// Headless screenshot helper: node scripts/screenshot.mjs <url> <out.png> [width] [height]
import puppeteer, { KnownDevices } from 'puppeteer-core';

const [url = 'http://localhost:4173/', out = 'shots/shot.png', w = '1600', h = '1000'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
// MOBILE=1 emulates a phone (touch, mobile UA, 390x844); MOBILE=<name> picks a puppeteer KnownDevice
if (process.env.MOBILE) {
  const dev = KnownDevices[process.env.MOBILE === '1' ? 'iPhone 13' : process.env.MOBILE];
  await page.emulate({ ...dev, viewport: { ...dev.viewport, deviceScaleFactor: parseFloat(process.env.DPR ?? '2') } });
} else await page.setViewport({ width: parseInt(w, 10), height: parseInt(h, 10), deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
await page.waitForFunction(() => window.nsv && !window.nsv.isBusy() && window.nsv.state.graph, { timeout: 120000, polling: 200 });
await new Promise((r) => setTimeout(r, 400));
if (process.env.FOCUS) {
  await page.evaluate((name, zoom) => {
    const n = window.nsv.state.graph.nodes.find((x) => x.refName === name || x.title === name);
    if (n) { window.nsv.viewer.zoomToNode(n); window.nsv.viewer.zoomBy(zoom); }
  }, process.env.FOCUS, parseFloat(process.env.ZOOM ?? '1'));
  await new Promise((r) => setTimeout(r, 200));
}
const status = await page.evaluate(() => document.querySelector('#status')?.textContent);
console.log('status:', status);
// geometry checks: wire/box crossings and label overlaps (measured at zoom 1 so Chrome's minimum
// rendered font size does not inflate text boxes)
await page.evaluate(() => { const v = window.nsv.viewer; v.zoomBy(1 / v.getScale()); });
const report = await page.evaluate(() => {
  const svg = document.querySelector('#svg');
  const vp = document.querySelector('#viewport');
  const ctm = vp.getScreenCTM();
  const toLocal = (r) => ({ x: (r.left - ctm.e) / ctm.a, y: (r.top - ctm.f) / ctm.d, w: r.width / ctm.a, h: r.height / ctm.d });
  // precise graph-space rect of an element: its own bbox mapped through its transform chain
  const vpInv = ctm.inverse();
  const gRect = (elm) => {
    const bb = elm.getBBox();
    const m = vpInv.multiply(elm.getScreenCTM());
    const x0 = m.a * bb.x + m.e, y0 = m.d * bb.y + m.f;
    return { x: x0, y: y0, w: bb.width * m.a, h: bb.height * m.d, left: x0, top: y0, right: x0 + bb.width * m.a, bottom: y0 + bb.height * m.d, width: bb.width * m.a, height: bb.height * m.d };
  };
  const nodes = [...vp.querySelectorAll('.node')].map((n) => {
    const shape = n.querySelector('.shape.body, .shape');
    let r;
    if (shape) r = gRect(shape);
    else {
      // rippers: union of their lines only (pin hit-circles stick out of the node)
      const parts = [...n.querySelectorAll('.ripbar, .ripline')].map(gRect);
      const l = Math.min(...parts.map((p) => p.left)), t = Math.min(...parts.map((p) => p.top));
      const rr = Math.max(...parts.map((p) => p.right)), b = Math.max(...parts.map((p) => p.bottom));
      r = { x: l, y: t, w: rr - l, h: b - t };
    }
    return { id: n.dataset.id, kind: n.dataset.kind, expanded: n.classList.contains('expanded'), ...r };
  });
  const edges = [...vp.querySelectorAll('.edge .wire')].map((p) => {
    const d = p.getAttribute('d');
    const pts = d.split(/[ML]/).filter(Boolean).map((s) => s.split(',').map(Number)).map(([x, y]) => ({ x, y }));
    return { id: p.parentElement.dataset.id, pts };
  });
  let crossings = 0;
  const crossList = [];
  for (const e of edges) {
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const a = e.pts[i], b = e.pts[i + 1];
      const minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x), miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
      for (const n of nodes) {
        if (n.expanded) continue;
        const eps = 1.5;
        // segment strictly inside the node interior (endpoints on border are allowed)
        const ix0 = Math.max(minx, n.x + eps), ix1 = Math.min(maxx, n.x + n.w - eps);
        const iy0 = Math.max(miny, n.y + eps), iy1 = Math.min(maxy, n.y + n.h - eps);
        if (ix0 <= ix1 && iy0 <= iy1) {
          // horizontal segment inside vertical extent & overlapping x range, or vertical inside x extent
          const horiz = Math.abs(a.y - b.y) < 0.01, vert = Math.abs(a.x - b.x) < 0.01;
          if ((horiz && ix1 - ix0 > 2) || (vert && iy1 - iy0 > 2) || (!horiz && !vert)) {
            crossings++;
            if (crossList.length < 10) crossList.push({ edge: e.id, node: n.id, kind: n.kind });
          }
        }
      }
    }
  }
  // label overlaps (text elements)
  const texts = [...vp.querySelectorAll('text')].map((t) => ({ el: t, r: gRect(t), txt: t.textContent }));
  let overlaps = 0;
  const ovList = [];
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i].r, b = texts[j].r;
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 1 && oy > 1) {
      overlaps++;
      if (ovList.length < 10) ovList.push([texts[i].txt, texts[j].txt]);
    }
  }
  // text vs wire overlaps
  let textWire = 0;
  const twList = [];
  for (const t of texts) {
    const r = t.r;
    const shrink = 1;
    for (const e of edges) for (let i = 0; i + 1 < e.pts.length; i++) {
      const a = e.pts[i], b = e.pts[i + 1];
      const minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x), miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
      if (maxx > r.x + shrink && minx < r.x + r.w - shrink && maxy > r.y + shrink && miny < r.y + r.h - shrink) {
        textWire++;
        if (twList.length < 10) twList.push({ txt: t.txt, cls: t.el.getAttribute('class'), edge: e.id, rect: [r.x, r.y, r.w, r.h].map(Math.round), seg: [a.x, a.y, b.x, b.y].map(Math.round) });
        break;
      }
    }
  }
  // edge/edge crossings, bends, total length
  let ee = 0, bends = 0, len = 0;
  const segs = [];
  for (const e of edges) {
    bends += Math.max(0, e.pts.length - 2);
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const a = e.pts[i], b = e.pts[i + 1];
      len += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      segs.push({ a, b, id: e.id, h: Math.abs(a.y - b.y) < 0.01 });
    }
  }
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s = segs[i], t = segs[j];
    if (s.id === t.id || s.h === t.h) continue;
    const hs = s.h ? s : t, vs = s.h ? t : s;
    const x = vs.a.x, y = hs.a.y;
    const hx0 = Math.min(hs.a.x, hs.b.x), hx1 = Math.max(hs.a.x, hs.b.x);
    const vy0 = Math.min(vs.a.y, vs.b.y), vy1 = Math.max(vs.a.y, vs.b.y);
    if (x > hx0 + 0.5 && x < hx1 - 0.5 && y > vy0 + 0.5 && y < vy1 - 0.5) ee++;
  }
  const bb = vp.getBBox();
  return { nodes: nodes.length, edges: edges.length, boxCross: crossings, crossList, labelOverlap: overlaps, ovList, textWire, twList, edgeCross: ee, bends, wireLen: Math.round(len), area: `${Math.round(bb.width)}x${Math.round(bb.height)}` };
});
console.log(JSON.stringify(report));
if (!process.env.FOCUS) await page.evaluate(() => window.nsv.viewer.fit());
await new Promise((r) => setTimeout(r, 100));
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
