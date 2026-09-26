// Minimal headless Chrome-for-Testing driver: load a URL, wait for
// window.__result, print it. Real GPU via ANGLE/Metal. Never the owner's browser.
//   node cdp-run.mjs <url> [timeoutMs] [script.js]   script: evaluated in the page
//   after load (may be async); it must set window.__result.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const [url, tmo = '60000', script] = process.argv.slice(2);
const { readFileSync } = await import('node:fs');
const prof = mkdtempSync(join(tmpdir(), 'nca-cft-'));
const port = 9400 + Math.floor(Math.random() * 400);
const ch = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pend = new Map(); const logs = [];
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + d.params.exceptionDetails.exception?.description); };
  await send('Runtime.enable');
  await send('Page.navigate', { url });
  if (script) {
    for (let i = 0; i < 100; i++) { const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }); if (r?.result?.value === 'complete') break; await sleep(200); }
    send('Runtime.evaluate', { expression: readFileSync(script, 'utf8'), awaitPromise: false });
  }
  const t0 = Date.now(); let r;
  while (Date.now() - t0 < +tmo) {
    r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__result ?? null)', returnByValue: true });
    if (r?.result?.value && r.result.value !== 'null') break;
    await sleep(250);
  }
  console.log(r?.result?.value ?? 'TIMEOUT');
  if (logs.length) console.log('console:\n' + logs.slice(0, 20).join('\n'));
} finally {
  const gone = new Promise((r) => ch.once('exit', r));
  ch.kill(); await Promise.race([gone, sleep(3000)]);
  for (let i = 0; i < 5; i++) { try { rmSync(prof, { recursive: true, force: true }); break; } catch { await sleep(300); } }
}
