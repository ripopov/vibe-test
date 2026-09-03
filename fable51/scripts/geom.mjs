import puppeteer from 'puppeteer-core';
const url = process.argv[2];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.nsv && !window.nsv.isBusy() && window.nsv.state.graph, { timeout: 120000, polling: 100 });
const out = await page.evaluate((sel) => {
  const vp = document.querySelector('#viewport');
  const ctm = vp.getScreenCTM();
  const t = document.querySelector(sel);
  const bb = t.getBBox();
  const m = ctm.inverse().multiply(t.getScreenCTM());
  const r = t.getBoundingClientRect();
  const info = { text: t.textContent, bbox: [bb.x, bb.y, bb.width, bb.height], m: [m.a, m.d, m.e, m.f], vpScale: ctm.a, screenRect: [r.left, r.top, r.width, r.height], fontSize: getComputedStyle(t).fontSize, cls: t.getAttribute('class') };
  const labels = [...window.nsv.state.placed.edgeLabels.entries()].filter(([k]) => k.endsWith('.h')).slice(0, 3).map(([k, v]) => {
    const e = [...window.nsv.state.graph.edges].find((x) => k.startsWith(x.id + '.'));
    return { k, box: [v.x, v.y, v.width, v.height], end: e?.points?.slice(-2) };
  });
  return { info, labels };
}, process.argv[3] ?? '.symtitle');
console.log(JSON.stringify(out));
await browser.close();
