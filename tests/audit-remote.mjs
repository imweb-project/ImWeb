/**
 * ImWeb Remote audit — the phone/iPad page's contract with ImWeb.
 *
 * What must stay true:
 *   1. `/imweb/remote/hello` is answered with a manifest holding EXACTLY the
 *      remote list, in order, with each control's range and current value, and
 *      the current bank's states with the active one;
 *   2. nothing is sent before a remote has said hello (a Flic rig pays nothing);
 *   3. `/imweb/state/<n>` recalls Display State n — not bank n;
 *   4. every control on the manifest gets ordinary feedback afterwards, with no
 *      second feedback path;
 *   5. the list changing, a state recall, and a bank switch re-send it;
 *   6. RemoteList caps (4 pages × 12), dedupes, persists per origin, and
 *      round-trips through the project file; a v1 file (one flat list) opens
 *      as page 1; a project WITHOUT the key leaves it alone;
 *   7. the relay serves the page and relays browser↔browser, never back to the
 *      sender (spawned for real, on spare ports);
 *  14. pages: put() places and MOVES an item, a full page refuses with a
 *      message, keys are pinned by key, the manifest carries the pages and a
 *      fader/knob per continuous control (° → knob unless the performer chose),
 *      and a spring flag only on the control that has one.
 *  15. page names: trimmed, capped, carried on the manifest's pages, kept when
 *      a page empties, persisted and round-tripped; junk names are dropped.
 *  16. tilt: `/imweb/remote/tilt x y c` reaches ControllerManager.feedMotion and
 *      drives exactly the params mapped to Tilt X / Tilt Y / Compass; it is not
 *      a parameter address, and OSC Learn does not hear it. Likewise
 *      `/imweb/remote/shake` and `/imweb/remote/mic` for Shake and Mic (Remote).
 *  17. the secure address: with a certificate from tools/remote-cert.mjs the
 *      relay ALSO serves https + wss on port + 363, the certificate verifies
 *      against its authority, the two ports are one room, and only the
 *      authority's public half is ever served. Without one, nothing changes.
 * Negative checks are paired with a positive control through the same rig.
 *
 * Run:  node tests/audit-remote.mjs
 */
import { spawn } from 'node:child_process';
import { ParameterSystem, PARAM_TYPE } from '../src/controls/ParameterSystem.js';

const sockets = [];
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
}
const RealWS = globalThis.WebSocket;   // Node 22+ has one; the relay test uses it
globalThis.WebSocket = FakeWS;
globalThis.document ??= { getElementById: () => null };
const store = new Map();
globalThis.localStorage ??= {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { OSCBridge } = await import('../src/io/OSCBridge.js');
const { RemoteList, REMOTE_MAX, REMOTE_KEY, REMOTE_PAGES, PAGE_MAX, NAME_MAX, autoWidget } = await import('../src/io/RemoteList.js');
const { ProjectFile } = await import('../src/io/ProjectFile.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

/** A PresetManager stand-in: an EventTarget with one bank and recallState. */
function fakePresets() {
  const pm = new EventTarget();
  pm.recalled = [];
  pm.loaded = [];
  pm.current = { name: 'Bank 1', activeState: 0,
    states: [{ name: 'Calm' }, null, { name: '' }] };
  pm.recallState = (n) => {
    pm.recalled.push(n);
    pm.current.activeState = n;
    pm.dispatchEvent(new CustomEvent('stateRecalled'));
  };
  pm.loadPreset = (n) => pm.loaded.push(n);
  return pm;
}

function rig() {
  store.clear();
  const ps = new ParameterSystem();
  ps.register({ id: 't.cont', label: 'Zoom', group: 'g', min: 0, max: 100, value: 25, step: 0.5, unit: '%' });
  ps.register({ id: 't.tog', label: 'Strobe', group: 'g', type: PARAM_TYPE.TOGGLE, value: 0 });
  ps.register({ id: 't.sel', label: 'Mode', group: 'g', type: PARAM_TYPE.SELECT, value: 1, options: ['a', 'b', 'c'] });
  ps.register({ id: 't.other', label: 'O', group: 'g', min: 0, max: 1, value: 0 });
  const pm = fakePresets();
  const bridge = new OSCBridge(ps, pm);
  const list = new RemoteList();
  bridge.setRemoteList(list);
  bridge.connect('ws://relay');
  const ws = sockets.at(-1);
  ws.readyState = FakeWS.OPEN;
  ws.onopen?.();
  const msg = (address, args = []) => ws.onmessage({ data: JSON.stringify({ address, args }) });
  const manifests = () => ws.sent.filter((m) => m.address === '/imweb/remote/manifest').map((m) => JSON.parse(m.args[0]));
  const flush = () => { const before = ws.sent.length; bridge._flush(); return ws.sent.slice(before); };
  return { ps, pm, bridge, list, ws, msg, manifests, flush };
}

console.log('\n1–2. hello → manifest; silent before hello');
{
  const { ps, list, ws, msg, manifests } = rig();
  check('on connect, ImWeb asks any remote to say hello', ws.sent.some((m) => m.address === '/imweb/remote/who'));
  list.add('t.sel'); list.add('t.cont'); list.add('t.tog');
  check('no manifest before any hello', manifests().length === 0, JSON.stringify(ws.sent));
  msg('/imweb/remote/hello');
  const m = manifests().at(-1);
  check('hello is answered (positive control)', !!m);
  check('controls are exactly the list, in order', JSON.stringify(m?.controls.map((c) => c.id)) === '["t.sel","t.cont","t.tog"]',
    JSON.stringify(m?.controls.map((c) => c.id)));
  const z = m?.controls.find((c) => c.id === 't.cont');
  check('a control carries label, range, unit, step and value',
    z?.label === 'Zoom' && z.min === 0 && z.max === 100 && z.unit === '%' && z.step === 0.5 && z.value === ps.get('t.cont').normalized,
    JSON.stringify(z));
  check('a select carries its options', JSON.stringify(m?.controls[0].options) === '["a","b","c"]');
  check('bank name', m?.bank === 'Bank 1');
  check('states: occupied only, named, unnamed gets a fallback',
    JSON.stringify(m?.states) === '[{"i":0,"name":"Calm"},{"i":2,"name":"State 2"}]', JSON.stringify(m?.states));
  check('active state', m?.active === 0);
}

console.log('\n3. /imweb/state/<n> recalls a STATE, not a bank');
{
  const { pm, msg } = rig();
  msg('/imweb/state/2', [1]);
  check('state 2 recalled', JSON.stringify(pm.recalled) === '[2]', JSON.stringify(pm.recalled));
  check('no bank loaded', pm.loaded.length === 0);
  msg('/imweb/state/1', [0]);
  check('a release recalls nothing', pm.recalled.length === 1);
  msg('/imweb/preset/3', [1]);
  check('/imweb/preset/<n> still loads a bank (positive control)', JSON.stringify(pm.loaded) === '[3]');
}

console.log('\n4. remote controls get feedback, others do not');
{
  const { ps, list, msg, flush } = rig();
  list.add('t.cont');
  msg('/imweb/remote/hello');
  ps.set('t.cont', 80);
  ps.set('t.other', 1);
  const out = flush();
  check('a remote control is sent back', out.some((m) => m.address === '/imweb/t.cont' && Math.abs(m.args[0] - 0.8) < 1e-9), JSON.stringify(out));
  check('a control not on the remote is not', out.filter((m) => m.address === '/imweb/t.other').length === 0, JSON.stringify(out));
  check('nothing re-sent when nothing moved', flush().length === 0);
  msg('/imweb/t.cont', [0.3]);
  check('the remote moving it reaches the param', Math.abs(ps.get('t.cont').value - 30) < 1e-9);
  check('…and is not echoed back to the finger', flush().filter((m) => m.address === '/imweb/t.cont').length === 0);
}

console.log('\n5. re-sent when the list, the state or the bank changes');
{
  const { pm, list, msg, manifests } = rig();
  msg('/imweb/remote/hello');
  let n = manifests().length;
  list.add('t.tog');
  check('adding a control re-sends', manifests().length === n + 1 && manifests().at(-1).controls.length === 1);
  n = manifests().length;
  msg('/imweb/state/2', [1]);
  check('a state recall re-sends with the new active tile', manifests().length === n + 1 && manifests().at(-1).active === 2);
  n = manifests().length;
  pm.current = { name: 'Bank 2', activeState: null, states: [{ name: 'X' }] };
  pm.dispatchEvent(new CustomEvent('presetActivated'));
  check('a bank switch re-sends the new bank', manifests().at(-1)?.bank === 'Bank 2' && manifests().length === n + 1);
}

console.log('\n8. surface position is the exact inverse of input (owner: "slider gets pulled back")');
{
  const { surfaceNorm, applyControlInput } = await import('../src/controls/controlInput.js');
  const ps = new ParameterSystem();
  const cases = [
    ['plain', { min: 0, max: 10 }],
    ['row range', { min: 0, max: 10, ctrlMin: 2, ctrlMax: 6 }],
    ['invert', { min: 0, max: 10, invert: true }],
    ['exp curve', { min: 0.1, max: 100, curve: 'exp' }],
    ['slewed', { min: 0.1, max: 3, slew: 0.5 }],
    ['all of it', { min: 0.1, max: 3, ctrlMin: 0.5, ctrlMax: 2, invert: true, slew: 0.3 }],
  ];
  for (const [name, o] of cases) {
    const p = ps.register({ id: `inv.${name}`, label: name, group: 'g', min: o.min, max: o.max, value: o.min,
      ...(o.curve ? { curve: o.curve } : {}) });
    Object.assign(p, o);
    let worst = 0;
    for (const n of [0, 0.13, 0.5, 0.77, 1]) {
      applyControlInput(p, { norm: n });
      worst = Math.max(worst, Math.abs(surfaceNorm(p) - n));
    }
    check(`${name}: what a surface sends is what it reads back`, worst < 1e-9, `off by ${worst}`);
  }
  const sel = ps.register({ id: 'inv.sel', label: 'S', group: 'g', type: PARAM_TYPE.SELECT, value: 0,
    options: ['a', 'b', 'c', 'd', 'e', 'f'] });
  Object.assign(sel, { ctrlMin: 1, ctrlMax: 4, invert: true });
  let selOk = true;
  for (let i = 1; i <= 4; i++) {
    const n = 1 - (i - 1) / 3;           // what the page sends for option i (selNorm)
    applyControlInput(sel, { norm: n });
    selOk &&= sel.value === i && Math.abs(surfaceNorm(sel) - n) < 1e-9;
  }
  check('select with a row span and invert round-trips every option', selOk);
  const tog = ps.register({ id: 'inv.tog', label: 'T', group: 'g', type: PARAM_TYPE.TOGGLE, value: 1 });
  tog.invert = true;
  check('a toggle shows its state as it is, invert or not (input flips it on the press)', surfaceNorm(tog) === 1);
}

console.log('\n9. a slewed control: feedback is the target, and there is no glide tail');
{
  const { ps, list, msg, flush } = rig();
  const p = ps.get('t.cont');
  p.slew = 1;
  list.add('t.cont');
  msg('/imweb/remote/hello');
  flush();
  ps.get('t.cont').setNormalized(0.9);   // something in ImWeb moves it, slewed
  for (let i = 0; i < 5; i++) p.tickSlew(0.05);
  check('mid-glide (positive control: the value is still moving)', p.value > 25 && p.value < 89, String(p.value));
  const out = flush();
  check('the remote is sent the target, not the glide',
    out.some((m) => m.address === '/imweb/t.cont' && Math.abs(m.args[0] - 0.9) < 1e-9), JSON.stringify(out));
  for (let i = 0; i < 5; i++) p.tickSlew(0.05);
  check('the glide continuing sends nothing more', flush().filter((m) => m.address === '/imweb/t.cont').length === 0);
}
{
  const { ps, list, msg, ws } = rig();
  const p = ps.get('t.cont');
  Object.assign(p, { ctrlMin: 20, ctrlMax: 60, invert: true });
  list.add('t.cont');
  msg('/imweb/remote/hello');
  const m = JSON.parse(ws.sent.filter((x) => x.address === '/imweb/remote/manifest').at(-1).args[0]).controls[0];
  check('manifest carries the row range and invert', m.lo === 20 && m.hi === 60 && m.invert === true, JSON.stringify(m));
}

console.log('\n10. clip names on a picker; empty slots marked');
{
  const { bridge, list, msg, manifests } = rig();
  bridge.setOptionLabels('t.sel', () => ['Harbour night', 'Dive']);
  list.add('t.sel');
  msg('/imweb/remote/hello');
  const c = manifests().at(-1).controls[0];
  check('racked slots carry their names', c.options[0] === 'Harbour night' && c.options[1] === 'Dive', JSON.stringify(c.options));
  check('an empty slot is named as empty', c.options[2] === 'c · empty', JSON.stringify(c.options));
  check('and listed as empty', JSON.stringify(c.empty) === '[2]', JSON.stringify(c.empty));
  bridge.setOptionLabels('t.sel', () => { throw new Error('rack gone'); });
  msg('/imweb/remote/hello');
  check('a provider that throws does not break the manifest', manifests().at(-1)?.controls[0]?.options.length === 3);
}

console.log('\n11. keys: listed, pressed and released; anything else refused');
{
  const { bridge, msg, manifests } = rig();
  const pressed = [], released = [];
  bridge.setKeyProvider({
    list: () => [{ key: 'k', code: 'KeyK', cap: 'K', label: 'Keyer toggle', section: 'Processing' }],
    press: (k) => pressed.push(k), release: (k) => released.push(k),
  });
  msg('/imweb/remote/hello');
  check('the manifest lists the keys', manifests().at(-1).keys?.[0]?.label === 'Keyer toggle');
  msg('/imweb/key/k', [1]);
  msg('/imweb/key/k', [0]);
  check('a listed key is pressed and released', pressed.join() === 'k' && released.join() === 'k', `${pressed}|${released}`);
  msg('/imweb/key/S', [1]);
  msg('/imweb/key/' + encodeURIComponent('Escape'), [1]);
  check('a key not on the list is never pressed', pressed.length === 1, pressed.join());
}

console.log('\n12. the layout refresh sends only when the layout changed');
{
  const { ps, bridge, list, msg, manifests } = rig();
  let names = ['A'];
  bridge.setOptionLabels('t.sel', () => names);
  list.add('t.sel'); list.add('t.cont');
  msg('/imweb/remote/hello');
  const n = manifests().length;
  ps.set('t.cont', 77);
  bridge.refreshRemote();
  check('a value moving does not re-send the layout', manifests().length === n);
  names = ['A', 'B'];
  bridge.refreshRemote();
  check('a clip racked does (positive control)', manifests().length === n + 1);
  bridge.refreshRemote();
  check('and only once', manifests().length === n + 1);
}

console.log('\n13. every key the remote offers exists in ImWeb\'s keyboard help, none with ⌘');
{
  const { readFileSync } = await import('node:fs');
  const html = readFileSync('index.html', 'utf8');
  const main = readFileSync('src/main.js', 'utf8');
  const help = new Set([...html.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((m) => m[1].trim()));
  const block = main.match(/const REMOTE_KEYS = \{([\s\S]*?)\};/)?.[1] ?? '';
  const keys = [...block.matchAll(/(?:^|[\s,{])"?([^\s":,]+)"?\s*:/g)].map((m) => m[1]);
  check('REMOTE_KEYS found in main.js (positive control)', keys.length >= 10, keys.join(' '));
  const missing = keys.filter((k) => !help.has(k));
  check('each is a <kbd> in the keyboard help', missing.length === 0, `missing: ${missing.join(' ')}`);
  check('no ⌘/⇧-combos (a phone must not save, open or reset)', keys.every((k) => !/[⌘⇧⌥]/.test(k)), keys.join(' '));
}

console.log('\n6. RemoteList: cap, dedupe, per-origin store, project round-trip');
{
  store.clear();
  const l = new RemoteList();
  const CAP = REMOTE_PAGES * PAGE_MAX;
  check('the cap is 4 pages of 12 (positive control on the constants)', REMOTE_PAGES === 4 && PAGE_MAX === 12 && REMOTE_MAX === PAGE_MAX);
  let added = 0;
  for (let i = 0; i < CAP; i++) added += l.add(`p.${i}`) ? 1 : 0;
  check(`add() fills all ${CAP}, page after page`, added === CAP && l.pages.every((p) => p.items.length === PAGE_MAX));
  check(`refuses #${CAP + 1}`, l.add('p.extra') === false && l.ids.length === CAP);
  check('refuses a duplicate', new RemoteList().add('p.0') === false);
  const saved = JSON.parse(store.get(REMOTE_KEY));
  check('persists per origin, as pages', saved.v === 2 && saved.pages.length === REMOTE_PAGES, JSON.stringify(saved).slice(0, 80));
  check('a fresh instance reloads it', new RemoteList().ids.join() === l.ids.join());
  check('remove', l.remove('p.3') && !l.has('p.3') && l.ids.length === CAP - 1);
  const n = RemoteList.normalize({ pages: [{ items: [{ id: 'a' }, { id: 'a' }, { id: 3 }, { id: '' }, null, { key: 'k' }, { key: 'k' },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `x${i}` }))] }, { items: [{ id: 'a' }] }, 'junk', {}, { items: [{ id: 'late' }] }] });
  check('normalize: always 4 pages', n.length === REMOTE_PAGES, n.length);
  check('normalize: drops junk and duplicates, keeps a key, caps a page',
    n[0].items.length === PAGE_MAX && n[0].items[0].id === 'a' && n[0].items[1].key === 'k' && n[1].items.length === 0,
    JSON.stringify(n[0].items.slice(0, 3)));
  check('normalize: a 5th page is dropped, not merged', !n.some((p) => p.items.some((it) => it.id === 'late')));
  const v1 = RemoteList.normalize({ v: 1, ids: ['m.a', 'm.b'] });
  check('a v1 list (before pages) opens as page 1', v1[0].items.map((it) => it.id).join() === 'm.a,m.b' && v1[1].items.length === 0);

  // Through the real ProjectFile, with only the hooks this needs.
  const ps = new ParameterSystem();
  const pm = { exportAll: async () => ({}), importAll: async () => ({}), currentIndex: 0,
    activatePreset: async () => {}, loadPreset: async () => {}, presets: [], get current() { return null; } };
  const src = new RemoteList(); src.restore({ pages: [{ items: [{ id: 't.a' }] }, { items: [{ id: 't.b', w: 'knob' }, { key: 'k' }] }] });
  let data = null;
  try { data = await new ProjectFile(ps, pm, null, { remote: src })._collect('x', { audio: false }); }
  catch (e) { check('ProjectFile._collect runs in the rig', false, e.message); }
  check('the project file carries the pages', JSON.stringify(data?.remote?.pages?.slice(0, 2)) === '[{"items":[{"id":"t.a"}]},{"items":[{"id":"t.b","w":"knob"},{"key":"k"}]}]',
    JSON.stringify(data?.remote));
  const dst = new RemoteList(); dst.restore({ ids: ['keep.me'] });
  const pf = new ProjectFile(ps, pm, null, { remote: dst });
  try { await pf._apply({ format: 'imweb', remote: data?.remote }); } catch (e) { check('_apply runs in the rig', false, e.message); }
  check('loading it restores pages, knob and key', dst.pageOf('t.b') === 1 && dst.widgetOf('t.b') === 'knob' && dst.pageOfKey('k') === 1,
    JSON.stringify(dst.pages.slice(0, 2)));
  dst.restore({ ids: ['keep.me'] });
  try { await pf._apply({ format: 'imweb' }); } catch (e) { check('_apply runs (old file)', false, e.message); }
  check('an older project (no key) leaves the remote alone', dst.ids.join() === 'keep.me', dst.ids.join());
  try { await pf._apply({ format: 'imweb', remote: { v: 1, ids: ['old.a'] } }); } catch (e) { check('_apply runs (v1 file)', false, e.message); }
  check('a v1 project file opens its remote on page 1', dst.pageOf('old.a') === 0, JSON.stringify(dst.pages[0]));
}

console.log('\n14. pages: put, move, full, keys, widgets');
{
  const { ps, bridge, list, msg, manifests } = rig();
  ps.register({ id: 't.hue', label: 'Hue', group: 'g', min: 0, max: 360, value: 0, unit: '°' });
  check('put on page 3', list.put({ id: 't.cont' }, 2) === null && list.pageOf('t.cont') === 2);
  check('put on another page MOVES it (never two copies)', list.put({ id: 't.cont' }, 0) === null
    && list.pageOf('t.cont') === 0 && list.ids.filter((x) => x === 't.cont').length === 1);
  for (let i = 0; i < PAGE_MAX; i++) list.put({ id: `fill.${i}` }, 3);
  const full = list.put({ id: 't.tog' }, 3);
  check('a full page refuses with a message that names it', typeof full === 'string' && full.includes('4') && !list.has('t.tog'), full);
  check('a moved item keeps its widget', list.put({ id: 't.hue' }, 1) === null && list.setWidget('t.hue', 'fader')
    && list.put({ id: 't.hue' }, 2) === null && list.widgetOf('t.hue') === 'fader');
  check('setWidget back to auto', list.setWidget('t.hue', null) && list.widgetOf('t.hue') === undefined);
  check('keys are pinned by key', list.put({ key: 'k' }, 1) === null && list.pageOfKey('k') === 1 && !list.has('k'));

  bridge.setKeyProvider({ list: () => [{ key: 'k', code: 'KeyK', cap: 'K', label: 'Keyer toggle', section: 'Processing' }],
    press: () => {}, release: () => {} });
  msg('/imweb/remote/hello');
  const m = manifests().at(-1);
  check('the manifest carries 4 pages (positive control)', m?.v === 2 && m.pages?.length === REMOTE_PAGES, JSON.stringify(m?.pages?.length));
  check('items name controls by id and keys by key',
    m?.pages[0].items[0].id === 't.cont' && m.pages[1].items.some((it) => it.key === 'k') && m.pages[2].items[0].id === 't.hue',
    JSON.stringify(m?.pages.map((p) => p.items.map((it) => it.id ?? it.key))));
  const w = (id) => m?.controls.find((c) => c.id === id)?.w;
  check('auto widget: a ° control is a knob, anything else a fader', w('t.hue') === 'knob' && w('t.cont') === 'fader'
    && autoWidget(ps.get('t.hue')) === 'knob', `${w('t.hue')} ${w('t.cont')}`);
  check('a toggle carries no widget', m?.controls.find((c) => c.id === 't.tog') === undefined
    || m.controls.find((c) => c.id === 't.tog').w === undefined);
  list.setWidget('t.cont', 'knob');
  check('the performer\'s choice wins and re-sends', w('t.cont') === 'fader' && manifests().at(-1).controls.find((c) => c.id === 't.cont').w === 'knob');

  // Spring: a per-control flag that rides with the item and reaches the page.
  const springIn = () => manifests().at(-1).controls.filter((c) => c.spring).map((c) => c.id).join();
  check('no control springs until asked', springIn() === '' && list.springOf('t.cont') === false);
  check('setSpring', list.setSpring('t.cont', true) && list.springOf('t.cont'));
  check('the manifest says which control springs (and only that one)', springIn() === 't.cont', springIn());
  check('a moved control keeps its spring', list.put({ id: 't.cont' }, 1) === null && list.springOf('t.cont'));
  check('it survives a reload of the store', new RemoteList().springOf('t.cont'));
  check('normalize keeps s only when it is exactly true',
    JSON.stringify(RemoteList.normalize({ pages: [{ items: [{ id: 'a', s: true }, { id: 'b', s: 'yes' }, { id: 'c', s: 1 }] }] })[0].items)
      === '[{"id":"a","s":true},{"id":"b"},{"id":"c"}]');
  check('setSpring off', list.setSpring('t.cont', false) && !list.springOf('t.cont') && springIn() === '');
}

console.log('\n15. page names');
{
  const { list, msg, manifests } = rig();
  list.put({ id: 't.cont' }, 1);
  msg('/imweb/remote/hello');
  const names = () => manifests().at(-1)?.pages?.map((p) => p.name ?? '').join('|');
  check('no page is named until asked (positive control: the page is there)',
    names() === '|||' && manifests().at(-1).pages[1].items[0]?.id === 't.cont', names());
  const before = manifests().length;
  check('setName trims and names the page', list.setName(1, '  Drums  ') && list.nameOf(1) === 'Drums');
  check('the manifest carries the name, re-sent', names() === '|Drums||' && manifests().length > before, names());
  check('the same name again changes nothing', list.setName(1, 'Drums') === false);
  check('a page that is not there refuses', list.setName(REMOTE_PAGES, 'x') === false && list.setName(-1, 'x') === false);
  list.setName(2, 'x'.repeat(40));
  check(`a name is capped at ${NAME_MAX}`, list.nameOf(2).length === NAME_MAX, String(list.nameOf(2).length));
  list.remove('t.cont');
  check('a page that empties keeps its name', list.nameOf(1) === 'Drums' && list.pages[1].items.length === 0);
  check('it survives a reload of the store', new RemoteList().nameOf(1) === 'Drums');
  const back = new RemoteList(); back.restore(list.capture());
  check('it round-trips through capture/restore (the project file)', back.nameOf(1) === 'Drums' && back.nameOf(2) === list.nameOf(2));
  check('normalize drops a name that is not text, or only spaces',
    RemoteList.normalize({ pages: [{ name: 42, items: [] }, { name: '   ', items: [] }, { name: ' Ok ', items: [] }] })
      .map((p) => p.name ?? '-').join() === '-,-,Ok,-');
  check('setName \'\' clears it — the tab says "Page n" again', list.setName(1, '') && list.nameOf(1) === ''
    && !('name' in manifests().at(-1).pages[1]), JSON.stringify(manifests().at(-1).pages[1]));
}

console.log('\n7. relay: serves the page, relays browser↔browser');
if (!RealWS) {
  check('this Node has a global WebSocket (22+) for the relay test', false, process.version);
} else {
  const UDP = 39000 + Math.floor(Math.random() * 500), WSP = UDP + 600;
  const relay = spawn(process.execPath, ['tools/osc-relay.mjs', String(UDP), String(WSP)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  relay.stdout.on('data', (d) => { log += d; });
  relay.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 50 && !log.includes('Remote page'); i++) await new Promise((r) => setTimeout(r, 100));
    const page = await fetch(`http://localhost:${WSP}/`).then((r) => r.text()).catch((e) => `ERR ${e.message}`);
    check('GET / serves the remote page', page.includes('ImWeb Remote'), page.slice(0, 80));
    const js = await fetch(`http://localhost:${WSP}/remote.js`).then((r) => r.status);
    check('GET /remote.js', js === 200, String(js));
    const sneaky = await fetch(`http://localhost:${WSP}/../osc-relay.mjs`).then((r) => r.status);
    const pkg = await fetch(`http://localhost:${WSP}/package.json`).then((r) => r.status);
    check('nothing outside the page is served', sneaky === 404 && pkg === 404, `${sneaky} ${pkg}`);
    const open = (u) => new Promise((res, rej) => { const s = new RealWS(u); s.got = []; s.onmessage = (e) => s.got.push(JSON.parse(e.data)); s.onopen = () => res(s); s.onerror = rej; });
    const a = await open(`ws://localhost:${WSP}`);
    const b = await open(`ws://localhost:${WSP}`);
    a.send(JSON.stringify({ address: '/imweb/t.cont', args: [0.5] }));
    await new Promise((r) => setTimeout(r, 200));
    check('A → B', b.got.some((m) => m.address === '/imweb/t.cont' && m.args[0] === 0.5), JSON.stringify(b.got));
    check('never back to the sender', a.got.length === 0, JSON.stringify(a.got));
    a.close(); b.close();
  } finally { relay.kill(); }
}

console.log('\n16. tilt: the remote\'s sensors drive Tilt X / Tilt Y / Compass');
{
  const { ControllerManager } = await import('../src/controls/ControllerManager.js');
  globalThis.window ??= { addEventListener() {}, removeEventListener() {} };   // its keyboard listeners
  const { ps, bridge, msg } = rig();
  ps.register({ id: 't.ty', label: 'Y', group: 'g', min: 0, max: 1, value: 0 });
  ps.register({ id: 't.cp', label: 'C', group: 'g', min: 0, max: 1, value: 0 });
  const cm = new ControllerManager(ps);
  cm.assign('t.cont', { type: 'tilt-x' });
  cm.assign('t.ty', { type: 'tilt-y' });
  cm.assign('t.cp', { type: 'compass' });
  const got = [];
  bridge.setMotionSink((v) => { got.push(v); cm.feedMotion(v); });
  const before = ps.get('t.other').value;
  msg('/imweb/remote/tilt', [0.8, 0.25, 0.6]);
  check('the sink gets three numbers', JSON.stringify(got) === '[{"tiltX":0.8,"tiltY":0.25,"compass":0.6}]', JSON.stringify(got));
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  check('Tilt X drives its param', near(ps.get('t.cont').normalized, 0.8), String(ps.get('t.cont').normalized));
  check('Tilt Y drives its param', near(ps.get('t.ty').normalized, 0.25), String(ps.get('t.ty').normalized));
  check('Compass drives its param', near(ps.get('t.cp').normalized, 0.6), String(ps.get('t.cp').normalized));
  check('a param with no tilt controller is left alone', ps.get('t.other').value === before);
  msg('/imweb/remote/tilt', [5, 'x']);
  check('out of range is clamped; a missing axis keeps its value',
    near(ps.get('t.cont').normalized, 1) && near(ps.get('t.ty').normalized, 0.25) && near(ps.get('t.cp').normalized, 0.6),
    `${ps.get('t.cont').normalized} ${ps.get('t.ty').normalized} ${ps.get('t.cp').normalized}`);
  ps.register({ id: 't.sh', label: 'S', group: 'g', min: 0, max: 1, value: 0 });
  ps.register({ id: 't.mic', label: 'M', group: 'g', min: 0, max: 1, value: 0 });
  cm.assign('t.sh', { type: 'shake' });
  cm.assign('t.mic', { type: 'remote-mic' });
  msg('/imweb/remote/shake', [0.9]);
  check('Shake drives its param, and only its own',
    near(ps.get('t.sh').normalized, 0.9) && near(ps.get('t.mic').normalized, 0) && near(ps.get('t.ty').normalized, 0.25),
    `${ps.get('t.sh').normalized} ${ps.get('t.mic').normalized} ${ps.get('t.ty').normalized}`);
  msg('/imweb/remote/mic', [0.35]);
  check('Mic drives its param, and leaves Shake where it was',
    near(ps.get('t.mic').normalized, 0.35) && near(ps.get('t.sh').normalized, 0.9),
    `${ps.get('t.mic').normalized} ${ps.get('t.sh').normalized}`);
  check('shake and mic are not parameter addresses', !ps.get('remote/shake') && !ps.get('remote/mic'));
  let heard = 0;
  bridge._observeLearn = () => { heard++; };
  bridge._learn = { paramId: 't.other', cands: new Map(), settleTimer: null };
  msg('/imweb/remote/tilt', [0.1, 0.1, 0.1]);
  msg('/imweb/remote/shake', [0.2]);
  msg('/imweb/remote/mic', [0.2]);
  check('OSC Learn does not hear the sensor streams', heard === 0, String(heard));
  msg('/imweb/t.other', [0.5]);
  check('…and does hear a control (positive control)', heard === 1, String(heard));
  bridge._learn = null;
}

console.log('\n17. the secure address (https + wss), for the Tilt button');
{
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const https = await import('node:https');
  const { readFileSync } = await import('node:fs');
  const { WebSocket: WS } = await import('ws');
  const dir = mkdtempSync(join(tmpdir(), 'imweb-cert-'));
  const env = { ...process.env, IMWEB_REMOTE_CERT: dir };
  const run = (args) => new Promise((res) => {
    const p = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
    p.on('close', (code) => res({ code, o }));
  });
  const UDP = 39600 + Math.floor(Math.random() * 300), WSP = UDP + 600, TLSP = WSP + 363;
  const start = async () => {
    const relay = spawn(process.execPath, ['tools/osc-relay.mjs', String(UDP), String(WSP)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    relay.log = '';
    relay.stdout.on('data', (d) => { relay.log += d; });
    relay.stderr.on('data', (d) => { relay.log += d; });
    for (let i = 0; i < 50 && !relay.log.includes('WebSocket listening'); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 200));
    return relay;
  };
  const stop = (relay) => new Promise((res) => { relay.on('close', res); relay.kill(); });
  const get = (ca) => new Promise((res) => {
    https.get({ host: 'localhost', port: TLSP, path: '/', ca }, (r) => {
      let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res(b));
    }).on('error', (e) => res(`ERR ${e.code ?? e.message}`));
  });
  try {
    // Without a certificate: the plain relay, and nothing more.
    let relay = await start();
    check('no certificate → no secure port', (await get(undefined)).startsWith('ERR'));
    check('no certificate → /ca.crt is not served',
      await fetch(`http://localhost:${WSP}/ca.crt`).then((r) => r.status) === 404);
    check('…and the relay says how to get Tilt', relay.log.includes('remote-cert.mjs'), relay.log);
    await stop(relay);

    const made = await run(['tools/remote-cert.mjs']);
    check('remote-cert.mjs makes an authority and a relay certificate',
      made.code === 0 && ['ca.crt', 'ca.key', 'server.crt', 'server.key'].every((f) => existsSync(join(dir, f))), made.o);
    const ca1 = readFileSync(join(dir, 'ca.crt'), 'utf8');
    const again = await run(['tools/remote-cert.mjs']);
    check('run again, the authority is KEPT — devices need nothing new',
      again.code === 0 && readFileSync(join(dir, 'ca.crt'), 'utf8') === ca1, again.o);

    relay = await start();
    const page = await get(ca1);
    check('https serves the remote page, and the certificate verifies against the authority',
      page.includes('ImWeb Remote'), page.slice(0, 80));
    check('…and does NOT verify without it (so the check above means something)', (await get(undefined)).startsWith('ERR'));
    const pub = await fetch(`http://localhost:${WSP}/ca.crt`).then((r) => r.text());
    check('/ca.crt is the authority\'s public certificate', pub === ca1);
    const keys = await Promise.all(['/ca.key', '/server.key', '/.remote-cert/ca.key'].map((u) => fetch(`http://localhost:${WSP}${u}`).then((r) => r.status)));
    check('no key is ever served', keys.length === 3 && keys.every((k) => k === 404), keys.join(' '));
    check('the relay prints the secure address', relay.log.includes(`:${TLSP}/`) && relay.log.includes('https://'), relay.log);
    const open = (u, o) => new Promise((res, rej) => { const s = new WS(u, o); s.got = []; s.on('message', (d) => s.got.push(JSON.parse(String(d)))); s.on('open', () => res(s)); s.on('error', rej); });
    const phone = await open(`wss://localhost:${TLSP}`, { ca: ca1 });
    const imweb = await open(`ws://localhost:${WSP}`);
    phone.send(JSON.stringify({ address: '/imweb/remote/tilt', args: [0.7, 0.3, 0.5] }));
    imweb.send(JSON.stringify({ address: '/imweb/t.cont', args: [0.4] }));
    await new Promise((r) => setTimeout(r, 250));
    check('phone (wss) → ImWeb (ws): tilt crosses the two ports',
      imweb.got.some((m) => m.address === '/imweb/remote/tilt' && m.args[0] === 0.7 && m.args[2] === 0.5), JSON.stringify(imweb.got));
    check('ImWeb (ws) → phone (wss): feedback crosses back',
      phone.got.some((m) => m.address === '/imweb/t.cont' && m.args[0] === 0.4), JSON.stringify(phone.got));
    phone.close(); imweb.close();
    await stop(relay);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
