// Phone check of the production build (docs/features/023-phone/spec.md): a touch phone emulated in headless Chrome,
// real touch events (CDP Input.dispatchTouchEvent: synthesize*Gesture does not scroll in this mode), one JSON line per page.
//   node scripts/mobile-check.mjs [base=http://localhost:8082] [cpuSlowdown=4]
// Needs the preview server (scripts/preview-site.sh) and Chrome. Exit code 1 if a page breaks a rule.
// From Git Bash set MSYS_NO_PATHCONV=1 before passing paths, or they are rewritten into Windows paths.
import { H, openPhone, sleep, W } from './phone-browser.mjs';

const [base = 'http://localhost:8082', cpu = '4'] = process.argv.slice(2);
const { send, ev, touch, close } = await openPhone(9333);
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: true });
  window.__rec = () => { window.__frames = []; let last = performance.now(); const tick = (now) => { if (!window.__frames) return; window.__frames.push(now - last); last = now; requestAnimationFrame(tick); }; requestAnimationFrame(tick); };
  window.__stop = () => { const f = window.__frames || []; window.__frames = null; return f; };` });

// where the page scrolls: the document on a phone, else the biggest scrolling box
const SCROLL_POS = `(() => { const s = [document.scrollingElement, ...document.querySelectorAll('*')].filter((e) => e && e.scrollHeight > e.clientHeight + 4 && (e === document.scrollingElement || /(auto|scroll)/.test(getComputedStyle(e).overflowY)));
  s.sort((a, b) => b.clientHeight - a.clientHeight); return s[0] ? s[0].scrollTop : 0; })()`;
const centerOf = (selector) => ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => { const r = x.getBoundingClientRect(); return r.width > 100 && r.height > 100; });
  if (!e) return null; const top = e.getBoundingClientRect().top + scrollY; scrollTo(0, Math.max(0, top - 200)); const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(Math.min(r.top + r.height / 2, ${H} - 120))]; })()`);
const swipeY = (x, y, distance) => touch([[x, y, x, y - distance]]);

const saleId = await (async () => {
  const doc = await (await fetch(`${base}/data/sales/92/92002.json`)).json().catch(() => null);
  const ids = doc?.sales?.id;
  return Array.isArray(ids) && ids.length ? `92002-${ids[0]}` : null;
})();

const PAGES = ['/', '/departement/92', '/place/commune/92002', '/investir', '/property', '/simulator', '/compare', '/evolution', '/method',
  ...(saleId ? [`/vente/${saleId}`] : [])];
let failed = false;
await send('Emulation.setCPUThrottlingRate', { rate: Number(cpu) });
for (const path of PAGES) {
  await send('Page.navigate', { url: base + path });
  await sleep(9000);
  const layout = await ev(`(() => {
    const vw = innerWidth;
    const clipped = (e) => { for (let a = e.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (/(auto|scroll|hidden|clip)/.test(o) && a !== document.body && a !== document.documentElement) return true; } return false; };
    const wide = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1) && getComputedStyle(e).position !== 'fixed' && !clipped(e); })
      .slice(0, 3).map((e) => (e.className && e.className.baseVal === undefined ? e.className : e.tagName).toString().slice(0, 30));
    const content = document.querySelector('.cy-content > *') ?? document.querySelector('main');
    const smallTargets = [...document.querySelectorAll('button, a[href], input, select, [role=button], summary')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight * 3 && (r.height < 40 && r.width < 40 || r.height < 32); }).length;
    const smallInputs = [...document.querySelectorAll('input, select, textarea')].filter((e) => e.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(e).fontSize) < 16).length;
    return { docWidth: document.documentElement.scrollWidth, wide, chromeTop: content ? Math.round(content.getBoundingClientRect().top) : null, smallTargets, smallInputs, docScrolls: document.scrollingElement.scrollHeight > innerHeight + 4 };
  })()`);
  // horizontal swipe on plain content must not move the page sideways
  await ev(`window.scrollTo(0, 0); document.querySelectorAll('*').forEach((e) => { if (e.scrollLeft) e.scrollLeft = 0; }); 1`);
  await touch([[W - 40, 300, W - 300, 300]]);
  const sideways = await ev(`Math.round(scrollX + (visualViewport?.offsetLeft ?? 0) + (document.querySelector('.cy-content')?.scrollLeft ?? 0))`);
  // pinch on the page must not zoom the whole app
  await touch([[W / 2 - 20, 200, W / 2 - 120, 200], [W / 2 + 20, 200, W / 2 + 120, 200]]);
  const scale = await ev('visualViewport ? visualViewport.scale : 1');
  if (scale !== 1) await touch([[W / 2 - 120, 200, W / 2 - 20, 200], [W / 2 + 120, 200, W / 2 + 20, 200]]);
  // one-finger vertical swipes over a map and over a chart must scroll the page
  const overScroll = {};
  for (const [name, selector] of [['map', '.maplibregl-canvas'], ['chart', 'div[_echarts_instance_]']]) {
    const at = await centerOf(selector);
    if (!at) continue;
    await sleep(600);
    const before = await ev(SCROLL_POS);
    await swipeY(at[0], at[1], 250);
    overScroll[name] = Math.round((await ev(SCROLL_POS)) - before);
  }
  // smoothness: a long fling down the page with the CPU slowed
  await ev('window.scrollTo(0, 0); window.__long = []; window.__rec(); 1');
  for (let i = 0; i < 4; i++) await swipeY(W / 2, H - 150, 500);
  const frames = (await ev('window.__stop()')).sort((a, b) => a - b);
  const long = await ev('window.__long.reduce((a, b) => a + b, 0)');
  const p95 = Math.round(frames[Math.floor(0.95 * (frames.length - 1))] ?? 0);
  const result = { path, ...layout, sideways, pinchScale: Math.round(scale * 100) / 100, overScroll, scrollFrames: frames.length, p95Frame: p95, scrollLongTaskMs: Math.round(long) };
  const broken = [layout.docWidth > W && 'page wider than the screen', sideways !== 0 && 'moves sideways', scale !== 1 && 'pinch zooms the app',
    ...Object.entries(overScroll).filter(([, d]) => d < 100).map(([k]) => `one finger on the ${k} does not scroll the page`),
    layout.smallInputs > 0 && 'inputs under 16 px (iOS zooms on focus)'].filter(Boolean);
  if (broken.length) failed = true;
  console.log(JSON.stringify({ ...result, broken }));
}
await close();
process.exit(failed ? 1 : 0);
