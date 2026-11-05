/**
 * Service-worker storage-failure audit — promotes LEARNED 2026-08-07.
 *
 * A rejected promise handed to respondWith() reaches the page as a bare
 * "Failed to fetch": no status, indistinguishable from the server being down.
 * caches.match() / caches.open() can reject (storage disabled, quota, private
 * mode, "clear site data" mid-request), so a storage hiccup in public/sw.js
 * would manufacture a network failure. Likewise install: addAll() is
 * all-or-nothing and APP_SHELL lists dev-only paths, so one 404 would stop the
 * worker from ever activating.
 *
 * This RUNS the real sw.js against a fake `caches` that rejects everything,
 * rather than grepping for try/catch — a guard can be present and still not
 * cover the path that fails. Calibrated below: the same file with the
 * fromCache guard removed must fail, or this audit proves nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SW = readFileSync(resolve(root, 'public/sw.js'), 'utf8');
const ORIGIN = 'http://localhost:4173';

function load(src, { cachesBroken, addFails, network }) {
  const listeners = {};
  let skipped = 0;
  const reject = () => Promise.reject(new DOMException('storage gone', 'UnknownError'));
  const cacheObj = {
    add: (u) => (addFails?.(u) ? Promise.reject(new TypeError(`404 ${u}`)) : Promise.resolve()),
    put: () => Promise.resolve(),
  };
  const caches = cachesBroken
    ? { match: reject, open: reject, keys: reject, delete: reject }
    : { match: async () => undefined, open: async () => cacheObj, keys: async () => [], delete: async () => true };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => { skipped++; return Promise.resolve(); },
    clients: { claim: () => Promise.resolve() },
  };
  const fetch = async () => { if (network === 'down') throw new TypeError('network down'); return new Response('ok', { status: 200 }); };
  const quiet = { ...console, warn: () => {} };
  new Function('self', 'caches', 'fetch', 'console', src)(self, caches, fetch, quiet);
  return { listeners, skipped: () => skipped };
}

async function fetchVia(src, path, opts) {
  const { listeners } = load(src, opts);
  let p = null;
  listeners.fetch({ request: new Request(ORIGIN + path), respondWith: (x) => { p = x; } });
  if (!p) return { handled: false };
  try { return { handled: true, status: (await p).status }; }
  catch (err) { return { handled: true, rejected: String(err) }; }
}

async function install(src, opts) {
  const sw = load(src, opts);
  let p = null;
  sw.listeners.install({ waitUntil: (x) => { p = x; } });
  try { await p; return { ok: true, skipped: sw.skipped() }; }
  catch (err) { return { ok: false, err: String(err), skipped: sw.skipped() }; }
}

async function run(src) {
  const fails = [];
  const check = (msg, ok) => { if (!ok) fails.push(msg); };
  for (const path of ['/index.html', '/assets/app.js', '/docs/ImWeb-Guide.md']) {
    const up = await fetchVia(src, path, { cachesBroken: true, network: 'up' });
    check(`${path}: broken cache + network up → network response, not a rejection (${JSON.stringify(up)})`,
      up.handled && up.status === 200);
    const down = await fetchVia(src, path, { cachesBroken: true, network: 'down' });
    check(`${path}: broken cache + network down → a 504, not a rejection (${JSON.stringify(down)})`,
      down.handled && down.status === 504);
  }
  const oneMissing = await install(src, { addFails: (u) => u.startsWith('/src/') });
  check(`install with dev-only shell entries 404ing still activates (${JSON.stringify(oneMissing)})`,
    oneMissing.ok && oneMissing.skipped > 0);
  const noStorage = await install(src, { cachesBroken: true });
  check(`install with storage gone still activates (${JSON.stringify(noStorage)})`,
    noStorage.ok && noStorage.skipped > 0);
  return fails;
}

const fails = await run(SW);

// Calibration: remove the fromCache guard. If the audit still passes, it is
// not looking where the failure is.
const GUARD = 'try { return await caches.match(req); } catch { return undefined; }';
const mutated = SW.replace(GUARD, 'return await caches.match(req);');
if (mutated === SW) fails.push('calibration: the fromCache guard text was not found — update this audit with sw.js');
else if ((await run(mutated)).length === 0) fails.push('calibration: the audit still passes with the fromCache guard removed');

if (fails.length) {
  console.error(`FAIL audit-sw-storage-failure:\n  - ${fails.join('\n  - ')}`);
  process.exit(1);
}
console.log('PASS audit-sw-storage-failure — real sw.js against rejecting caches: every fetch resolves (network or 504), install activates; calibration catches a removed guard');
