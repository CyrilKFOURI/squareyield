// Phone flows of the production build (docs/features/023-phone/spec.md): every feature used with a finger on an
// emulated touch phone. One line per flow, exit code 1 if one fails.
//   node scripts/mobile-flows.mjs [base=http://localhost:8082] [only=part of a flow name]
// Needs the preview server (scripts/preview-site.sh), Chrome, and the internet for the address lookup (BAN).
import { H, openPhone, sleep, W } from './phone-browser.mjs';

const [base = 'http://localhost:8082', only = ''] = process.argv.slice(2);
const phone = await openPhone(9334);
const { send, ev, tap, tapAt, go } = phone;
const path = () => ev('location.pathname');
const text = () => ev('document.body.innerText');
const typeInto = async (selector, value) => {
  await tap(selector);
  await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select?.(); return 1; })()`);
  await send('Input.insertText', { text: value });
  await sleep(400);
};

const flows = {
  'home: no search box, no heatmap, départements as a ten-row list that scrolls': async () => {
    await go(`${base}/`, 9000);
    const page = await ev(`(() => {
      const visible = (e) => e && e.getBoundingClientRect().height > 0;
      const list = document.querySelector('.cy-rank-list.scroll');
      return { search: Boolean(document.querySelector('.cy-search')), heatmap: [...document.querySelectorAll('.cy-panel')].some((p) => visible(p) && /d’une année sur l’autre/.test(p.textContent)),
        rows: list ? Math.round(list.clientHeight / 32) : 0, total: list ? list.querySelectorAll('li').length : 0 };
    })()`);
    const box = await ev(`(() => { const l = document.querySelector('.cy-rank-list.scroll'); const top = l.getBoundingClientRect().top + scrollY; scrollTo(0, top - 150); const r = l.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    await sleep(600);
    const before = await ev(`document.querySelector('.cy-rank-list.scroll').scrollTop`);
    await phone.touch([[box[0], box[1] + 100, box[0], box[1] - 100]]);
    const after = await ev(`document.querySelector('.cy-rank-list.scroll').scrollTop`);
    return [!page.search && !page.heatmap && page.rows === 10 && page.total > 90 && after > before, `${JSON.stringify(page)}, list scrolled ${before} → ${after}`];
  },
  'tables fit the width, pinch zooms, double tap returns, "Afficher tout"': async () => {
    await go(`${base}/investir`, 9000);
    const fit = await ev(`(() => { const b = document.querySelector('.cy-ptable-box'); const t = b.querySelector('table'); const r = b.getBoundingClientRect(); scrollTo(0, r.top + scrollY - 200);
      return { fits: t.getBoundingClientRect().width <= b.clientWidth + 1, zoom: Number(t.style.zoom || 1), rows: [...t.tBodies[0].rows].filter((x) => x.getBoundingClientRect().height > 0).length }; })()`);
    await sleep(600);
    const at = await ev(`(() => { const r = document.querySelector('.cy-ptable-box').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + Math.min(r.height, 300) / 2)]; })()`);
    await phone.touch([[at[0] - 30, at[1], at[0] - 120, at[1]], [at[0] + 30, at[1], at[0] + 120, at[1]]]);
    const zoomed = await ev(`Number(document.querySelector('.cy-ptable-box table').style.zoom)`);
    for (let i = 0; i < 2; i++) { // a double tap: two taps 100 ms apart
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at[0], y: at[1] - 40 }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(100);
    }
    await sleep(800);
    const back = await ev(`(() => { const b = document.querySelector('.cy-ptable-box'); const t = b.querySelector('table'); return { zoom: Number(t.style.zoom), fits: t.getBoundingClientRect().width <= b.clientWidth + 1 }; })()`);
    await tap('.cy-ptable-more');
    const all = await ev(`[...document.querySelector('.cy-ptable-box table').tBodies[0].rows].filter((x) => x.getBoundingClientRect().height > 0).length`);
    return [fit.fits && fit.rows === 8 && zoomed > fit.zoom * 1.5 && back.fits && back.zoom < zoomed && all > 8,
      `fits ${fit.fits} at zoom ${fit.zoom.toFixed(2)}, ${fit.rows} rows; pinch → ${zoomed.toFixed(2)}; double tap → ${back.zoom.toFixed(2)} (fits ${back.fits}); all rows ${all}`];
  },
  'bottom tabs switch section': async () => {
    await go(`${base}/`);
    await tap('.cy-tabbar a', 'Investir');
    const a = await path();
    await tap('.cy-tabbar a', 'Méthode');
    const b = await path();
    await tap('.cy-tabbar a', 'Marché');
    const c = await path();
    return [a === '/investir' && b === '/method' && c === '/', `${a} ${b} ${c}`];
  },
  'filters sheet changes the type': async () => {
    await go(`${base}/`);
    await tap('[aria-label=Filtres]');
    const open = await ev(`Boolean(document.querySelector('.cy-sheet')) && document.body.style.overflow === 'hidden'`);
    await tap('.cy-sheet .cy-seg button', 'Maisons');
    await tap('.cy-sheet-head button');
    await sleep(1500);
    const closed = await ev(`!document.querySelector('.cy-sheet') && document.body.style.overflow !== 'hidden'`);
    const houses = /prix maisons/i.test(await text());
    return [open && closed && houses, `open ${open}, closed ${closed}, houses ${houses}`];
  },
  'département picker is a bottom sheet': async () => {
    await go(`${base}/`);
    await tap('button.cy-level', 'Département');
    const sheet = await ev(`(() => { const p = document.querySelector('.cy-level-panel'); if (!p) return null; const r = p.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.bottom), Math.round(r.width)]; })()`);
    await typeInto('.cy-level-panel input', 'Gironde');
    await tap('.cy-level-panel .cy-level-row', 'Gironde');
    await sleep(3000);
    const at = await path();
    return [sheet && sheet[0] === 0 && Math.abs(sheet[1] - H) <= 2 && sheet[2] === W && at === '/departement/33', `panel ${sheet}, then ${at}`];
  },
  'map: first tap previews, second opens': async () => {
    await go(`${base}/`, 10000);
    const at = await ev(`(() => { const c = document.querySelector('.maplibregl-canvas'); const top = c.getBoundingClientRect().top + scrollY; scrollTo(0, top - 80); const r = c.getBoundingClientRect(); return [Math.round(r.left + r.width * 0.5), Math.round(r.top + r.height * 0.5)]; })()`);
    await sleep(1500);
    await tapAt(at[0], at[1]);
    const card = await ev(`Boolean(document.querySelector('.cy-map-card'))`);
    const still = await path();
    await tapAt(at[0], at[1]);
    await sleep(2500);
    const opened = await path();
    return [card && still === '/' && opened.startsWith('/departement/'), `card ${card}, after first tap ${still}, after second ${opened}`];
  },
  'sales map: tap a building twice, its panel comes up, open a sale': async () => {
    await go(`${base}/place/commune/92002`, 9000);
    await ev(`(() => { const v = document.getElementById('ventes'); scrollTo(0, v.getBoundingClientRect().top + scrollY - 60); return 1; })()`);
    await sleep(5000);
    const box = await ev(`(() => { const c = document.querySelector('.cy-sales-map .maplibregl-canvas'); if (!c) return null; const top = c.getBoundingClientRect().top + scrollY; scrollTo(0, top - 70); const r = c.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })()`);
    if (!box) return [false, 'no sales map'];
    await sleep(1500);
    let found = false;
    for (let i = 0; i < 49 && !found; i++) {
      const x = box[0] + box[2] * (0.2 + 0.1 * (i % 7));
      const y = box[1] + box[3] * (0.2 + 0.1 * Math.floor(i / 7));
      await tapAt(Math.round(x), Math.round(y));
      if (await ev(`Boolean(document.querySelector('.cy-map-card'))`)) {
        await tapAt(Math.round(x), Math.round(y)); // first tap previews the building, the second opens it
      }
      found = await ev(`Boolean(document.querySelector('.cy-sales-panel'))`);
    }
    if (!found) return [false, 'no building under 49 taps'];
    await sleep(1500);
    const panelTop = await ev(`Math.round(document.querySelector('.cy-sales-panel').getBoundingClientRect().top)`);
    const opened = await tap('.cy-sales-list tbody tr');
    await sleep(3000);
    const at = await path();
    return [panelTop >= 0 && panelTop < H / 2 && opened && at.startsWith('/vente/'), `panel top ${panelTop}, sale link ${opened}, then ${at}`];
  },
  'info bubble opens on tap, inside the screen': async () => {
    await go(`${base}/place/commune/92002`);
    await tap('.cy-info');
    const pop = await ev(`(() => { const p = [...document.querySelectorAll('.cy-info-pop')].find((e) => getComputedStyle(e).display === 'block'); if (!p) return null; const r = p.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; })()`);
    return [pop && pop[0] >= 0 && pop[1] <= W, `pop ${pop}`];
  },
  'estimate a property': async () => {
    await go(`${base}/property`);
    await typeInto('input[placeholder="12 rue Lenepveu, Angers"]', '204 rue Adolphe Pajeaud, Antony');
    await tap('button[type=submit]', 'Analyser');
    await sleep(9000);
    const t = await text();
    const ok = /ESTIMATION\s*\n?\s*[\d\s ]+€/i.test(t) && /VENTES COMPARABLES/i.test(t);
    return [ok, ok ? 'estimate and comparables shown' : t.slice(0, 200)];
  },
  'simulator reacts to an input': async () => {
    await go(`${base}/simulator`);
    const before = await ev(`[...document.querySelectorAll('.cy-kpi-value')].map((e) => e.textContent).join('|')`);
    await typeInto('.cy-content input[inputmode], .cy-content input[type=number], .cy-content input', '400000');
    await ev('document.activeElement.blur(); 1');
    await sleep(1500);
    const after = await ev(`[...document.querySelectorAll('.cy-kpi-value')].map((e) => e.textContent).join('|')`);
    return [before !== after && after.length > 0, `${before.slice(0, 60)} → ${after.slice(0, 60)}`];
  },
};

let failed = false;
for (const [name, run] of Object.entries(flows).filter(([n]) => n.includes(only))) {
  let ok = false;
  let detail = '';
  try {
    [ok, detail] = await run();
  } catch (error) {
    detail = String(error);
  }
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}
await phone.close();
process.exit(failed ? 1 : 0);
