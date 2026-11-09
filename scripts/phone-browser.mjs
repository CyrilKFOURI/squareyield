// A touch phone emulated in headless Chrome over CDP (docs/features/023-phone/spec.md), shared by
// scripts/mobile-check.mjs and scripts/mobile-flows.mjs. Gestures are real touch events (Input.dispatchTouchEvent):
// Input.synthesize*Gesture does not scroll a page in this mode.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const W = 390;
export const H = 844;
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const openPhone = async (port = 9333) => {
  const profile = mkdtempSync(join(tmpdir(), 'rea-phone-'));
  const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--window-size=${W},${H}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* starting */ }
    if (!target) await sleep(300);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) pending.get(m.id)(m.result ?? m.error); });
  const send = (method, params = {}) => new Promise((res) => { const n = ++seq; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36', platform: 'Android' });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'prefers-color-scheme', value: 'light' }] });

  /** Fingers moving over `steps` frames; one [x0, y0, x1, y1] per finger. */
  const touch = async (fingers, steps = 12) => {
    const at = (k) => fingers.map(([x0, y0, x1, y1], id) => ({ x: x0 + ((x1 - x0) * k) / steps, y: y0 + ((y1 - y0) * k) / steps, id }));
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
    for (let k = 1; k <= steps; k++) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
      await sleep(16);
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700);
  };
  const tapAt = async (x, y) => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(60);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(900);
  };
  /** Scrolls the first visible match of `selector` (optionally containing `text`) on screen and taps its centre. */
  const tap = async (selector, text) => {
    const at = await ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getBoundingClientRect().width > 0
        && (${JSON.stringify(text ?? '')} === '' || x.textContent.includes(${JSON.stringify(text ?? '')})));
      if (!e) return null; const r0 = e.getBoundingClientRect(); if (r0.top < 70 || r0.bottom > innerHeight - 70) scrollBy(0, r0.top - innerHeight / 2);
      const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    if (!at) return false;
    await sleep(300);
    await tapAt(at[0], at[1]);
    return true;
  };
  const go = async (url, wait = 8000) => {
    await send('Page.navigate', { url });
    await sleep(wait);
  };
  const close = async () => {
    ws.close();
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still closing */ }
  };
  return { send, ev, touch, tap, tapAt, go, close };
};
