/**
 * ImWeb Remote — the phone/iPad page.
 *
 * Talks to ImWeb through tools/osc-relay.mjs, using ImWeb's own OSC vocabulary
 * (src/io/OSCBridge.js) over the relay's WebSocket:
 *   → /imweb/remote/hello            announce; ImWeb answers with a manifest
 *   ← /imweb/remote/manifest <json>  what to draw: controls, bank, states
 *   ← /imweb/remote/who              ImWeb (re)connected — say hello again
 *   ↔ /imweb/<id> <0..1>             a value, normalised, both ways
 *   → /imweb/toggle/<id>, /imweb/trigger/<id>, /imweb/state/<n>, /imweb/key/<k>
 *   → /imweb/remote/tilt <x> <y> <c> the device's tilt and turn, 0..1 each
 *   → /imweb/remote/shake <0..1>     how hard it is being shaken
 *   → /imweb/remote/mic <0..1>       its microphone level
 *
 * The page knows nothing on its own: everything it shows comes from the
 * manifest, so placing a control in ImWeb (right-click → Remote page 1–4) is
 * the whole of the layout work. Nothing here edits the layout — a performance
 * surface with edit gestures on it is one slip from losing a set.
 *
 * Layout: up to 4 pages of 12 items, switched by TAP on the bar at the bottom
 * (never by swipe: a fader drag always drifts sideways). A page is 12 slots —
 * one row on an iPad in landscape, 6×2 in portrait, 4×3 on a phone. A fader
 * or picker fills a slot; a knob, button or key takes half, so two stack.
 */
const $ = (id) => document.getElementById(id);
const statesEl = $('states');
const controlsEl = $('controls');
const pagesEl = $('pages');

/** Full range of a fader / knob, in px of finger travel — the same on every device. */
const FADER_TRAVEL = 320;
const KNOB_TRAVEL = 200;
/** How long a spring control takes to glide home after release. */
const SPRING_MS = 150;
const PAGE_STORE = 'imweb.remote.page';   // this device's page, kept across reloads

let ws = null;
let manifest = null;
/** id → { update(n), held } for every control drawn on the current page. */
const views = new Map();
/** id → latest value from ImWeb, for every control on ANY page: a page drawn
 *  later must start where ImWeb is now, not where the manifest found it. */
const values = new Map();
let page = 0;
try { page = Number(localStorage.getItem(PAGE_STORE)) || 0; } catch { /* private mode */ }
/** Each page's items resolved against the manifest: { c } a control, { k } a key. */
let pages = [];
/** The performer's page names from ImWeb ('' = none, the tab says "Page n"). */
let pageNames = [];

// ── Connection ──────────────────────────────────────────────────────────────

function send(address, ...args) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ address, args }));
}

function connect() {
  // The secure address (https, for the motion sensors) needs a secure socket.
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => { setStatus('on', 'connected'); send('/imweb/remote/hello'); };
  ws.onclose = () => { setStatus('off', 'reconnecting…'); setTimeout(connect, 2000); };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (typeof m?.address !== 'string') return;
    receive(m.address, Array.isArray(m.args) ? m.args : []);
  };
}

function setStatus(cls, text) {
  const s = $('status');
  s.className = `status ${cls}`;
  s.textContent = text;
}

function receive(address, args) {
  if (address === '/imweb/remote/manifest') {
    try { render(JSON.parse(args[0])); } catch (err) { console.warn('[remote] bad manifest', err); }
    return;
  }
  if (address === '/imweb/remote/who') { send('/imweb/remote/hello'); return; }
  const m = address.match(/^\/imweb\/([^/]+)$/);
  if (!m) return;
  const n = Number(args[0]);
  if (!Number.isFinite(n)) return;
  values.set(m[1], n);
  const v = views.get(m[1]);
  if (v && !v.held) v.update(n);
}

const valueOf = (c) => values.get(c.id) ?? c.value ?? 0;
/** Send a value and remember it, so another page drawn later starts there. */
function sendValue(c, n) {
  values.set(c.id, n);
  send(`/imweb/${c.id}`, n);
}

// ── Values ──────────────────────────────────────────────────────────────────

/*
 * The 0–1 on the wire is ImWeb's surface position (controlInput.surfaceNorm):
 * already inside the row's min/max fields (`lo`/`hi` in the manifest), with
 * invert applied. These helpers undo exactly that, so the page shows the same
 * number ImWeb's row does.
 */
const lo = (c) => c.lo ?? c.min ?? 0;
const hi = (c) => c.hi ?? c.max ?? 1;
const unInvert = (c, n) => (c.invert ? 1 - n : n);

/** Surface position → real units, the inverse of Parameter.toNorm. */
function fromNorm(c, n) {
  const x = unInvert(c, n), a = lo(c), b = hi(c);
  if (c.curve === 'exp' && a > 0 && b > a) return a * Math.pow(b / a, x);
  return a + x * (b - a);
}

/** Select: surface position ↔ option index, within the row's span. */
function selIndex(c, n) { return lo(c) + Math.round(unInvert(c, n) * (hi(c) - lo(c))); }
function selNorm(c, i) {
  const span = hi(c) - lo(c);
  return unInvert(c, span > 0 ? (i - lo(c)) / span : 0);
}

function format(c, n) {
  if (c.type === 'select') return String(c.options?.[selIndex(c, n)] ?? '');
  const v = fromNorm(c, n);
  const step = c.step || 0.01;
  const dec = step >= 1 ? 0 : Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))));
  return `${v.toFixed(dec)}${c.unit ? ` ${c.unit}` : ''}`;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function render(m) {
  manifest = m;
  $('bank').textContent = m.bank ?? '';
  $('keys').hidden = !(m.keys?.length);
  values.clear();
  for (const c of m.controls ?? []) values.set(c.id, c.value ?? 0);

  // An item whose control or key has gone (a binding removed) is not drawn.
  const byId = new Map((m.controls ?? []).map((c) => [c.id, c]));
  const byKey = new Map((m.keys ?? []).map((k) => [k.key, k]));
  pages = (m.pages ?? [{ items: (m.controls ?? []).map((c) => ({ id: c.id })) }]).map((p) =>
    (p.items ?? []).map((it) => (it.id ? byId.has(it.id) && { c: byId.get(it.id) } : byKey.has(it.key) && { k: byKey.get(it.key) }))
      .filter(Boolean));
  pageNames = (m.pages ?? []).map((p) => (typeof p?.name === 'string' ? p.name : ''));

  renderStates();
  closeSheet();   // a picker open over the old layout would drive a stale view
  showPage(page);
}

/** The page bar: a tab for every page that has something on it. */
function showPage(n) {
  const used = pages.map((p, i) => (p.length ? i : -1)).filter((i) => i >= 0);
  page = used.includes(n) ? n : (used[0] ?? 0);
  try { localStorage.setItem(PAGE_STORE, String(page)); } catch { /* private mode */ }
  pagesEl.hidden = used.length < 2;
  pagesEl.replaceChildren(...used.map((i) => {
    const b = document.createElement('button');
    b.className = `page-tab${i === page ? ' on' : ''}`;
    const t = document.createElement('span');   // the span clamps a long name to two lines
    t.textContent = pageNames[i] || `Page ${i + 1}`;
    b.append(t);
    b.addEventListener('click', () => { if (i !== page) { closeSheet(); showPage(i); } });
    return b;
  }));
  renderPage(pages[page] ?? []);
}

const HALF = new Set(['knob', 'toggle', 'trigger', 'key']);
function kindOf(item) {
  if (item.k) return 'key';
  const c = item.c;
  if (c.type === 'toggle' || c.type === 'trigger') return c.type;
  // A select is never a fader: dragging through 37 sources to reach one is
  // not playable (owner, first iPad test). Few options → a button each;
  // many → the current one named big, ◀ ▶ to step, tap to pick from a grid.
  if (c.type === 'select') return hi(c) - lo(c) + 1 <= 6 ? 'seg' : 'picker';
  return c.w === 'knob' ? 'knob' : 'fader';
}

function renderPage(items) {
  views.clear();
  const slots = [];
  for (const item of items) {
    const kind = kindOf(item);
    const el = kind === 'key' ? keyView(item.k)
      : kind === 'toggle' ? toggleView(item.c)
      : kind === 'trigger' ? triggerView(item.c)
      : kind === 'seg' ? segView(item.c)
      : kind === 'picker' ? pickerView(item.c)
      : kind === 'knob' ? knobView(item.c)
      : faderView(item.c);
    // Two half-height items in a row share a slot, one above the other.
    const last = slots.at(-1);
    if (HALF.has(kind) && last?.classList.contains('stack') && last.childElementCount < 2) { last.append(el); continue; }
    if (HALF.has(kind)) {
      const stack = document.createElement('div');
      stack.className = 'slot stack';
      stack.append(el);
      slots.push(stack);
    } else {
      el.classList.add('slot');
      slots.push(el);
    }
  }
  controlsEl.replaceChildren(...slots);
  $('empty').hidden = slots.length > 0;
}

/**
 * Display States in ONE row on every page — as many as fit; the rest behind
 * "More…", which is lit when the active state is one of them.
 */
function renderStates() {
  const states = manifest?.states ?? [];
  // Shown BEFORE it is measured: a hidden row is 0 px wide, and the first
  // manifest would then fit one tile — "More…" alone until the iPad rotates.
  statesEl.hidden = !states.length;
  if (!states.length) { statesEl.replaceChildren(); return; }
  const fit = Math.max(1, Math.floor((statesEl.clientWidth + 8) / 100));
  const shown = states.length > fit ? states.slice(0, fit - 1) : states;
  // Always `fit` columns: a tile is the same size whether the bank has 3 states or 30.
  statesEl.style.gridTemplateColumns = `repeat(${fit}, minmax(0, 1fr))`;
  const tiles = shown.map((s) => stateTile(s, () => {}));
  if (shown.length < states.length) {
    const more = document.createElement('button');
    const hidden = states.slice(shown.length);
    more.className = `tile more${hidden.some((s) => s.i === manifest.active) ? ' on' : ''}`;
    more.textContent = `More… (${hidden.length})`;
    more.addEventListener('click', openStates);
    tiles.push(more);
  }
  statesEl.replaceChildren(...tiles);
}
let _rs = 0;
addEventListener('resize', () => { cancelAnimationFrame(_rs); _rs = requestAnimationFrame(renderStates); });

function stateTile(s, after) {
  const b = document.createElement('button');
  b.className = `tile${s.i === manifest?.active ? ' on' : ''}`;
  b.textContent = s.name;
  b.addEventListener('click', () => {
    document.querySelectorAll('.states .tile, .sheet .tile.state').forEach((t) => t.classList.toggle('on', t === b));
    send(`/imweb/state/${s.i}`, 1);
    after();
  });
  return b;
}

function openStates() {
  newSheet(manifest?.bank || 'Display States');
  const grid = document.createElement('div');
  grid.className = 'sheet-grid';
  for (const s of manifest?.states ?? []) {
    const t = stateTile(s, closeSheet);
    t.classList.add('state');
    grid.append(t);
  }
  sheet.append(grid);
  document.body.append(sheet);
}

function card(c, kind) {
  const el = document.createElement('div');
  el.className = `ctl ${kind}`;
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = c.label;
  el.append(label);
  return el;
}

/**
 * Relative drag — the shared engine of faders and knobs. The value moves with
 * the finger from where it LANDED, never to it: touching a control must never
 * jump the parameter, which on a live instrument is a visible glitch. Full
 * range is `travel` px whatever the screen, so a gesture learned on the iPad
 * means the same on the phone. A second finger on a held control is ignored.
 */
function dragValue(el, c, view, travel, show) {
  let id = null, startY = 0, startN = 0, pending = null;
  // Spring (right-click → Remote → Spring in ImWeb): on release the value
  // glides back to `home`, where the finger first landed. Caught again
  // mid-glide, home stays put — a second push still returns to the Look.
  let home = 0, glide = 0;
  el.classList.toggle('spring', !!c.spring);
  const flush = () => {
    if (pending === null) return;
    sendValue(c, pending);
    pending = null;
  };
  const release = () => { view.held = false; el.classList.remove('held'); };
  const springBack = () => {
    const from = view.n, t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / SPRING_MS);
      view.n = t < 1 ? from + (home - from) * (1 - (1 - t) ** 3) : home;   // ease-out, lands exactly
      show(view.n);
      sendValue(c, view.n);
      if (t < 1) glide = requestAnimationFrame(step);
      else { glide = 0; release(); }
    };
    glide = requestAnimationFrame(step);
  };
  el.addEventListener('pointerdown', (e) => {
    if (id !== null) return;
    id = e.pointerId;
    el.setPointerCapture(id);
    if (glide) { cancelAnimationFrame(glide); glide = 0; } else home = view.n;
    view.held = true; el.classList.add('held');
    startY = e.clientY; startN = view.n;
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const x = Math.max(0, Math.min(1, startN + (startY - e.clientY) / travel));
    if (x === view.n) return;
    view.n = x; show(x);
    if (pending === null) requestAnimationFrame(flush);   // at most one send per frame
    pending = x;
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    flush();
    // Held until home: ImWeb's feedback must not tug the glide.
    if (c.spring && view.n !== home) springBack();
    else release();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/** A strip: the fill rises from the bottom; label and value at the top, clear of the finger. */
function faderView(c) {
  const el = card(c, 'fader');
  const val = document.createElement('div');
  val.className = 'value';
  const fill = document.createElement('div');
  fill.className = 'fill';
  el.append(val, fill);
  const show = (x) => { fill.style.height = `${x * 100}%`; val.textContent = format(c, x); };
  const view = { held: false, n: valueOf(c), update: (x) => { view.n = x; show(x); } };
  views.set(c.id, view);
  show(view.n);
  dragValue(el, c, view, FADER_TRAVEL, show);
  return el;
}

/** A knob: the same vertical drag (no circular gesture — that needs eyes), half a slot. */
const ARC = 135;   // degrees either side of top
function arcPath(r, a0, a1) {
  const p = (a) => [50 + r * Math.sin(a * Math.PI / 180), 50 - r * Math.cos(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function knobView(c) {
  const el = card(c, 'knob');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  const track = document.createElementNS(NS, 'path');
  track.setAttribute('class', 'k-track');
  track.setAttribute('d', arcPath(40, -ARC, ARC));
  const arc = document.createElementNS(NS, 'path');
  arc.setAttribute('class', 'k-arc');
  const tick = document.createElementNS(NS, 'line');
  tick.setAttribute('class', 'k-tick');
  svg.append(track, arc, tick);
  const val = document.createElement('div');
  val.className = 'value';
  el.append(svg, val);
  const show = (x) => {
    const a = -ARC + x * 2 * ARC;
    arc.setAttribute('d', x > 0.002 ? arcPath(40, -ARC, a) : '');
    const r = a * Math.PI / 180;
    tick.setAttribute('x1', (50 + 18 * Math.sin(r)).toFixed(2)); tick.setAttribute('y1', (50 - 18 * Math.cos(r)).toFixed(2));
    tick.setAttribute('x2', (50 + 34 * Math.sin(r)).toFixed(2)); tick.setAttribute('y2', (50 - 34 * Math.cos(r)).toFixed(2));
    val.textContent = format(c, x);
  };
  const view = { held: false, n: valueOf(c), update: (x) => { view.n = x; show(x); } };
  views.set(c.id, view);
  show(view.n);
  dragValue(el, c, view, KNOB_TRAVEL, show);
  return el;
}

/** One of ImWeb's keys on a page: momentary — lit while held, like the key itself. */
function keyView(k) {
  const el = document.createElement('div');
  el.className = 'ctl keyctl';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = k.label.split(' — ')[0];
  el.append(label, keyButton(k, 'big'));
  return el;
}

/** A key: down on touch, up on release — a Key... binding is held as long as the finger is. */
function keyButton(k, cls) {
  const b = document.createElement('button');
  b.className = cls;
  const cap = document.createElement('kbd');
  cap.textContent = k.cap ?? k.key;
  b.append(cap);
  b.title = k.label;
  const addr = `/imweb/key/${encodeURIComponent(k.key)}`;
  let down = null;
  b.addEventListener('pointerdown', (e) => {
    if (down !== null) return;
    down = e.pointerId;
    b.setPointerCapture(down);
    b.classList.add('on'); send(addr, 1);
  });
  const up = (e) => { if (e.pointerId !== down) return; down = null; b.classList.remove('on'); send(addr, 0); };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  return b;
}

function toggleView(c) {
  const el = card(c, 'toggle');
  const big = document.createElement('button');
  big.className = 'big';
  el.append(big);
  const view = { held: false, update: (x) => {
    const on = x > 0.5;
    el.classList.toggle('on', on);
    big.textContent = on ? 'ON' : 'OFF';
  } };
  views.set(c.id, view);
  view.update(valueOf(c));
  big.addEventListener('click', () => {
    const next = el.classList.contains('on') ? 0 : 1;
    view.update(next);   // show it now; ImWeb confirms
    values.set(c.id, next);
    send(`/imweb/toggle/${c.id}`, 1);
  });
  return el;
}

function triggerView(c) {
  const el = card(c, 'trigger');
  const big = document.createElement('button');
  big.className = 'big';
  big.textContent = 'GO';
  el.append(big);
  big.addEventListener('pointerdown', () => {
    send(`/imweb/trigger/${c.id}`, 1);
    big.classList.add('flash');
    setTimeout(() => big.classList.remove('flash'), 150);
  });
  return el;
}

/** The option indices the row allows, lo..hi. */
function span(c) {
  const out = [];
  for (let i = lo(c); i <= hi(c); i++) out.push(i);
  return out;
}

function segView(c) {
  const el = card(c, 'select');
  const seg = document.createElement('div');
  seg.className = 'seg';
  const idxs = span(c);
  const btns = idxs.map((i) => {
    const b = document.createElement('button');
    b.textContent = c.options?.[i] ?? String(i);
    b.addEventListener('click', () => { view.update(selNorm(c, i)); sendValue(c, selNorm(c, i)); });
    return b;
  });
  seg.append(...btns);
  el.append(seg);
  const view = { held: false, update: (x) => {
    const cur = selIndex(c, x);
    btns.forEach((b, k) => b.classList.toggle('on', idxs[k] === cur));
  } };
  views.set(c.id, view);
  view.update(valueOf(c));
  return el;
}

/** A long list: current option named big; ◀ ▶ step; tap the name for the grid. */
function pickerView(c) {
  const el = card(c, 'picker');
  const name = document.createElement('button');
  name.className = 'pick-name';
  const row = document.createElement('div');
  row.className = 'pick-step';
  const prev = document.createElement('button');
  const next = document.createElement('button');
  prev.textContent = '◀'; next.textContent = '▶';
  prev.setAttribute('aria-label', 'Previous'); next.setAttribute('aria-label', 'Next');
  row.append(prev, next);
  el.append(name, row);
  let cur = selIndex(c, valueOf(c));
  const choose = (i) => {
    cur = Math.max(lo(c), Math.min(hi(c), i));
    view.update(selNorm(c, cur));
    sendValue(c, selNorm(c, cur));
  };
  const view = { held: false, update: (x) => {
    cur = selIndex(c, x);
    name.textContent = c.options?.[cur] ?? String(cur);
    name.classList.toggle('empty', !!c.empty?.includes(cur));
  } };
  views.set(c.id, view);
  view.update(valueOf(c));
  prev.addEventListener('click', () => choose(cur - 1));
  next.addEventListener('click', () => choose(cur + 1));
  name.addEventListener('click', () => openSheet(c, cur, choose));
  return el;
}

/** A full-screen sheet with a title and ✕. One at a time. */
let sheet = null;
function newSheet(titleText) {
  closeSheet();
  sheet = document.createElement('div');
  sheet.className = 'sheet';
  const head = document.createElement('div');
  head.className = 'sheet-head';
  const title = document.createElement('span');
  title.textContent = titleText;
  const x = document.createElement('button');
  x.className = 'sheet-close';
  x.textContent = '✕';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', closeSheet);
  head.append(title, x);
  sheet.append(head);
  return sheet;
}

/** Full-screen grid of a select's options. */
function openSheet(c, cur, choose) {
  newSheet(c.label);
  const grid = document.createElement('div');
  grid.className = 'sheet-grid';
  for (const i of span(c)) {
    const b = document.createElement('button');
    b.className = `tile${i === cur ? ' on' : ''}${c.empty?.includes(i) ? ' empty' : ''}`;
    b.textContent = c.options?.[i] ?? String(i);
    b.addEventListener('click', () => { choose(i); closeSheet(); });
    grid.append(b);
  }
  sheet.append(grid);
  document.body.append(sheet);
  grid.querySelector('.on')?.scrollIntoView({ block: 'center' });
}

/**
 * ImWeb's keyboard shortcuts as buttons, named as in ImWeb's own keyboard help.
 * A button is a key: down on touch, up on release — so a Key... binding on a
 * continuous control is held for as long as the finger is.
 */
function openKeys() {
  const keys = manifest?.keys ?? [];
  newSheet('Keys');
  const body = document.createElement('div');
  body.className = 'sheet-grid keys-grid';
  let section = null;
  for (const k of keys) {
    if (k.section !== section) {
      section = k.section;
      const h = document.createElement('div');
      h.className = 'keys-section';
      h.textContent = section;
      body.append(h);
    }
    const b = keyButton(k, 'tile key');
    const label = document.createElement('span');
    // The help's long form ("Solo — raw layer mix, effects bypassed") is for
    // reading; a button wants the name. Full text stays on the tooltip.
    label.textContent = k.label.split(' — ')[0];
    b.append(label);
    body.append(b);
  }
  sheet.append(body);
  document.body.append(sheet);
}
$('keys').addEventListener('click', openKeys);
function closeSheet() { sheet?.remove(); sheet = null; }

// ── Tilt ────────────────────────────────────────────────────────────────────

/*
 * The device's motion sensors as three controller values — ImWeb's Tilt X,
 * Tilt Y and Compass (right-click a control → Tilt X). Sent only while the
 * Tilt button is HELD (or latched on by a tap), so a phone put down on the
 * table drives nothing.
 *
 * Relative, like the faders: holding the button is a clutch. The values move
 * with the device from the pose it was GRABBED in and stay where they were
 * left on release, so engaging never jumps a parameter and there is no "flat"
 * pose to find — an iPad held at 40° is as good a centre as one lying down.
 *
 * Browsers hand out the sensors only on a secure page, and on iOS only after
 * a tap that asks. So: https (see tools/remote-cert.mjs), then one tap.
 */
const TILT_TRAVEL = 90;    // degrees of tilt for the full 0..1
const TURN_TRAVEL = 180;   // degrees of turning on the spot for the full 0..1
/** A step bigger than this in one reading is the angles flipping over (the
 *  device passing vertical, the screen rotating), not a movement. */
const TILT_JUMP = 30;
/** A touch shorter than this is a tap: it latches Tilt on instead of holding it. */
const TILT_TAP_MS = 250;
const tiltBtn = $('tilt');
const tilt = { x: 0.5, y: 0.5, c: 0.5 };   // what ImWeb was last told
let tiltReady = false, tiltHeld = null, tiltLast = null, tiltQueued = false;
/** Which way up the screen was when Tilt was engaged (0/90/180/270). */
let tiltAngle = 0;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
/** Shortest way from `was` to `now` on an angle that wraps every `turn` degrees. */
function turnDelta(now, was, turn) {
  let d = now - was;
  if (d > turn / 2) d -= turn;
  if (d < -turn / 2) d += turn;
  return d;
}

function onTilt(e) {
  if (e.beta == null || e.gamma == null) return;   // a browser with no sensors says so with nulls
  // Screen-relative, as ImWeb's own tilt is: X is toward/away from you, Y is
  // left/right, whichever way up the device is held — as it was held when
  // Tilt was ENGAGED. Tilting far enough makes the device rotate its screen,
  // and following that swapped the two axes mid-gesture (owner, first iPad
  // test): the hand's axes do not change because the picture turned.
  const angle = tiltAngle;
  const [sx, sy] = angle === 90 ? [-e.gamma, e.beta] : angle === 180 ? [-e.beta, -e.gamma]
    : angle === 270 ? [e.gamma, -e.beta] : [e.beta, e.gamma];
  const now = { sx, sy, a: e.alpha ?? 0 };
  const was = tiltLast;
  tiltLast = now;
  if (!was) return;   // the first reading is the pose it was grabbed in
  const dx = turnDelta(sx, was.sx, 360), dy = turnDelta(sy, was.sy, 360), da = turnDelta(now.a, was.a, 360);
  if (Math.abs(dx) > TILT_JUMP || Math.abs(dy) > TILT_JUMP || Math.abs(da) > TILT_JUMP) return;
  tilt.x = clamp01(tilt.x + dx / TILT_TRAVEL);
  tilt.y = clamp01(tilt.y + dy / TILT_TRAVEL);
  tilt.c = clamp01(tilt.c - da / TURN_TRAVEL);   // alpha runs anticlockwise; turning right goes up
  if (tiltQueued) return;
  tiltQueued = true;                             // at most one send per frame
  requestAnimationFrame(() => {
    tiltQueued = false;
    send('/imweb/remote/tilt', +tilt.x.toFixed(4), +tilt.y.toFixed(4), +tilt.c.toFixed(4));
  });
}

/*
 * Shake: how hard the device is being moved, as one value — ImWeb's Shake
 * (Remote) controller. It rides on the Tilt button: engaged, the device sends
 * both. An envelope, not the raw reading: it jumps up with a jolt and falls
 * back over SHAKE_FALL_MS, so one flick is a visible pulse rather than a
 * single-frame spike, and steady shaking holds a level.
 */
const SHAKE_FULL = 20;       // m/s² of movement (gravity removed) for the full 1.0 — a firm shake
const SHAKE_FALL_MS = 350;   // how long a jolt takes to fall back to rest
/** Below this the device is being HELD, not shaken: a hand is never still, and
 *  without a floor a resting phone sends a trickle of small values forever. */
const SHAKE_REST = 0.6;      // m/s²
const shake = { env: 0, sent: 0, at: 0, grav: null };
function onShake(e) {
  let a = e.acceleration;
  if (a?.x == null) {
    // No gravity-free reading on this device: take gravity out ourselves, as
    // whatever the reading settles on while the device is held still.
    const g = e.accelerationIncludingGravity;
    if (g?.x == null) return;
    shake.grav ??= { x: g.x, y: g.y, z: g.z };
    for (const k of ['x', 'y', 'z']) shake.grav[k] += (g[k] - shake.grav[k]) * 0.1;
    a = { x: g.x - shake.grav.x, y: g.y - shake.grav.y, z: g.z - shake.grav.z };
  }
  const now = performance.now();
  const dt = shake.at ? Math.min(100, now - shake.at) : 0;
  shake.at = now;
  const hit = Math.min(1, Math.max(0, Math.hypot(a.x, a.y, a.z) - SHAKE_REST) / (SHAKE_FULL - SHAKE_REST));
  shake.env = Math.max(hit, shake.env - dt / SHAKE_FALL_MS);
  const v = +shake.env.toFixed(3);
  if (Math.abs(v - shake.sent) < 0.004 && !(v === 0 && shake.sent > 0)) return;   // at rest, say nothing
  shake.sent = v;
  send('/imweb/remote/shake', v);
}

/*
 * North: which way the top of the screen points on the real compass — ImWeb's
 * North (Remote) controller. Unlike Compass above, which counts how far the
 * device has turned since Tilt was grabbed, this is ABSOLUTE: the same
 * direction in the room is the same value tomorrow.
 *
 * North is the MIDDLE (0.5): east of it goes up, west goes down, and the one
 * place the value wraps (1 → 0) is due south, behind the player, rather than
 * at the direction most likely to be faced. iOS reports the heading itself
 * (webkitCompassHeading); elsewhere it comes from the absolute orientation
 * event, whose alpha runs anticlockwise from north.
 */
const NORTH_SMOOTH = 0.25;   // a magnetometer jitters a degree or two at rest
const north = { h: null, sent: -1, queued: false };
function onNorth(e) {
  let h = e.webkitCompassHeading;
  if (h == null && e.absolute && e.alpha != null) h = 360 - e.alpha;
  if (h == null || !Number.isFinite(h)) return;   // no magnetometer, or not this event
  // Both readings are for the device's own top edge; the player reads the
  // SCREEN's top, so add which way up it was when Tilt was engaged.
  h = (((h + tiltAngle) % 360) + 360) % 360;
  north.h = north.h == null ? h : (north.h + turnDelta(h, north.h, 360) * NORTH_SMOOTH + 360) % 360;
  if (north.queued) return;
  north.queued = true;
  requestAnimationFrame(() => {
    north.queued = false;
    if (north.h == null) return;
    const v = +(((north.h + 180) % 360) / 360).toFixed(4);
    if (Math.abs(v - north.sent) < 0.001) return;
    north.sent = v;
    send('/imweb/remote/north', v);
  });
}

/** Ask for the sensors. Must run in a tap on iOS; everywhere else it just succeeds. */
async function enableTilt() {
  if (tiltReady) return;
  if (!window.isSecureContext || typeof DeviceOrientationEvent === 'undefined') { tiltHelp(); return; }
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    let r = 'denied';
    try { r = await DeviceOrientationEvent.requestPermission(); } catch { /* not in a tap */ }
    // Refused once, iOS refuses silently from then on — say so, or the button
    // just looks dead.
    if (r !== 'granted') { tiltHelp('refused'); return; }
    // Shake reads devicemotion, which iOS gates separately but answers from
    // the same Allow — asked in the same tap, and Tilt works without it.
    try { await DeviceMotionEvent?.requestPermission?.(); } catch { /* tilt only */ }
  }
  tiltReady = true;
  tiltBtn.classList.add('ready');
}

function tiltHelp(why) {
  newSheet(String(why).startsWith('mic') ? 'Mic' : 'Tilt');
  const p = document.createElement('p');
  p.className = 'sheet-note';
  p.innerHTML = why === 'mic-refused'
    ? 'Microphone access was not allowed.<br><br>Allow the microphone for this page in the browser\'s site settings, then tap <b>Mic</b> again.'
    : why === 'mic-insecure'
    ? 'The microphone needs the secure address — phones only give it to an <b>https</b> page.<br><br>'
      + 'On the Mac, once: <code>node tools/remote-cert.mjs</code>, then restart the relay and follow what it prints.'
    : why === 'refused'
    ? 'Motion access was not allowed.<br><br>Close this page, open it again, tap <b>Tilt</b> and choose <b>Allow</b>.'
    : window.isSecureContext
    ? 'This browser gives no motion sensors.'
    : 'Tilt needs the secure address — phones only give their motion sensors to an <b>https</b> page.<br><br>'
      + 'On the Mac, once: <code>node tools/remote-cert.mjs</code>, then restart the relay and follow what it prints.';
  sheet.append(p);
  document.body.append(sheet);
}

tiltBtn.addEventListener('click', enableTilt);
/*
 * Hold = tilt for as long as the finger is down. A quick TAP latches it on, so
 * both hands are free for the faders; the next touch lets go. Lit while it is
 * sending either way, with a ● when latched — a latched tilt on a phone about
 * to be put down is the one thing here that must be visible at a glance.
 */
let tiltLatched = false, tiltDownAt = 0;
function tiltStop() {
  tiltHeld = null; tiltLatched = false;
  tiltBtn.classList.remove('held');
  tiltBtn.textContent = 'Tilt';
  removeEventListener('deviceorientation', onTilt);
  removeEventListener('devicemotion', onShake);
  removeEventListener('deviceorientation', onNorth);
  removeEventListener('deviceorientationabsolute', onNorth);
  north.h = null;   // unlike shake, the last heading STAYS in ImWeb: a direction has no rest value
  // Let go mid-shake, the value must not hang where it was.
  if (shake.sent > 0) { shake.env = 0; shake.sent = 0; send('/imweb/remote/shake', 0); }
}
tiltBtn.addEventListener('pointerdown', (e) => {
  if (!tiltReady || tiltHeld !== null) return;
  tiltHeld = e.pointerId;
  tiltBtn.setPointerCapture(tiltHeld);
  if (tiltLatched) { tiltDownAt = 0; return; }   // this touch lets go, on release
  tiltDownAt = performance.now();
  tiltBtn.classList.add('held');
  tiltLast = null;
  tiltAngle = (((screen.orientation?.angle ?? window.orientation ?? 0) % 360) + 360) % 360;
  addEventListener('deviceorientation', onTilt);
  shake.env = 0; shake.at = 0; shake.grav = null;
  addEventListener('devicemotion', onShake);
  north.h = null; north.sent = -1;
  addEventListener('deviceorientation', onNorth);
  addEventListener('deviceorientationabsolute', onNorth);
});
tiltBtn.addEventListener('pointerup', (e) => {
  if (e.pointerId !== tiltHeld) return;
  if (tiltDownAt && performance.now() - tiltDownAt < TILT_TAP_MS) {
    tiltHeld = null; tiltLatched = true;
    tiltBtn.textContent = 'Tilt ●';
    return;
  }
  tiltStop();
});
tiltBtn.addEventListener('pointercancel', (e) => { if (e.pointerId === tiltHeld) tiltStop(); });
// A latched tilt does not outlive the page being put away.
document.addEventListener('visibilitychange', () => { if (document.hidden && (tiltLatched || tiltHeld !== null)) tiltStop(); });
// Android asks nothing: ready as soon as the page is secure. iOS waits for the tap.
if (window.isSecureContext && typeof DeviceOrientationEvent !== 'undefined'
  && typeof DeviceOrientationEvent.requestPermission !== 'function') enableTilt();

// ── Mic ─────────────────────────────────────────────────────────────────────

/*
 * This device's microphone level as one controller value — ImWeb's Mic
 * (Remote). Tap Mic to switch it on (the browser asks once), tap again to
 * switch it off. Only the LEVEL leaves the device, about 30 times a second:
 * no sound is sent, recorded or played. Like every sensor here it needs the
 * secure address.
 *
 * The level is what ImWeb's own Sound controller uses — RMS × 4, capped at 1 —
 * so a mapping feels the same from either microphone. Up at once, down over
 * MIC_FALL_MS, so speech is a moving level and not a flicker.
 */
const MIC_FALL_MS = 250;
const micBtn = $('mic');
let mic = null;   // { stream, ctx, raf } while on

function micStop() {
  if (!mic) return;
  cancelAnimationFrame(mic.raf);
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.ctx.close().catch(() => {});
  mic = null;
  micBtn.classList.remove('held', 'ready');
  send('/imweb/remote/mic', 0);
}

async function micStart() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { tiltHelp('mic-insecure'); return; }
  let stream;
  try {
    // The phone's voice processing would level the very thing being measured.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch { tiltHelp('mic-refused'); return; }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume().catch(() => {});
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(an);   // analysed only — never to the speaker
  const buf = new Float32Array(an.fftSize);
  mic = { stream, ctx, raf: 0 };
  micBtn.classList.add('held', 'ready');
  let env = 0, sent = -1, at = performance.now(), sentAt = 0;
  const step = (now) => {
    if (!mic) return;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
    env = Math.max(level, env - (now - at) / MIC_FALL_MS);
    at = now;
    const v = +env.toFixed(3);
    if (now - sentAt >= 33 && Math.abs(v - sent) >= 0.004) { sent = v; sentAt = now; send('/imweb/remote/mic', v); }
    mic.raf = requestAnimationFrame(step);
  };
  mic.raf = requestAnimationFrame(step);
}
micBtn.addEventListener('click', () => (mic ? micStop() : micStart()));
// A live microphone does not outlive the page being put away.
document.addEventListener('visibilitychange', () => { if (document.hidden) micStop(); });

// ── Keep the screen on while performing (Safari 16.4+; silently absent before)
let wake = null;
document.addEventListener('pointerdown', async () => {
  if (wake || !navigator.wakeLock) return;
  try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
  catch { /* not allowed here */ }
}, { passive: true });

connect();
