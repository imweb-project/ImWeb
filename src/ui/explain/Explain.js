/**
 * Explain this — a short plain-language explanation of any control, opened
 * from its right-click menu.
 *
 * Two sources, in this order:
 *   1. a WRITTEN explanation from ./explanations.js (works offline, reviewed);
 *   2. a GENERATED one from the active AI provider, grounded in the control's
 *      own definition and the manual paragraphs that name it — and labelled as
 *      generated every time it is shown.
 * With neither, the panel says so plainly and sends nothing anywhere.
 *
 * The current value is NOT part of what the AI is told: the panel prints it
 * itself ("Right now"), so a generated text stays true whatever the knob says
 * and can be cached. The cache key is a fingerprint of the facts, so a control
 * whose range or manual text changes gets asked again.
 *
 * Not a chat: one answer per control, no input box, no follow-up.
 */
import { PARAM_TYPE } from '../../controls/ParameterSystem.js';
import { aiReady, explainParam, paramRangeText } from '../../ai/AIFeatures.js';
import { makeFloating } from '../components/FloatingWindow.js';
import { EXPLANATIONS, EXPLAIN_PARTS, lookupExplanation } from './explanations.js';

const CACHE_KEY = 'imweb.explain.cache.v1';
const MANUAL_URL = 'docs/ImWeb_Full_Manual.md';

let _el = null, _title = null, _body = null, _win = null;
let _ps = null;
let _seq = 0;              // stale-answer guard: only the latest open may paint
let _manual = null;        // Promise<string>

// ── facts ────────────────────────────────────────────────────────────────────

function fmt(p, v) {
  if (p.type === PARAM_TYPE.TOGGLE) return v ? 'on' : 'off';
  if (p.type === PARAM_TYPE.SELECT) return p.options?.[v] ?? String(v);
  if (p.type === PARAM_TYPE.TRIGGER) return '';
  // Same decimals as the row's own readout (Parameter.displayValue).
  const rangeDec = p.max - p.min > 10 ? 1 : 2;
  const stepDec = p.step > 0 ? Math.ceil(-Math.log10(p.step)) : 0;
  const d = Math.min(4, Math.max(rangeDec, stepDec));
  return Number(v).toFixed(d) + (p.unit ? ` ${p.unit}` : '');
}

function rangeText(p) {
  if (p.type === PARAM_TYPE.TRIGGER) return 'a button — fires once when pressed';
  if (p.type === PARAM_TYPE.TOGGLE) return 'a switch — off or on';
  return paramRangeText(p);
}

/** Where the control sits in the panel, read from its row if one is on the page. */
function placeOf(p) {
  const row = document.querySelector(`[data-param-id="${CSS.escape(p.id)}"]`);
  if (!row) return { section: '', siblings: [] };
  const sec = row.closest('.panel-section');
  const section = sec?.querySelector('.section-header')?.textContent.replace(/[^\p{L}\p{N})]+$/u, '').trim() ?? '';
  const sibs = [...(row.parentElement?.querySelectorAll('[data-param-id]') ?? [])]
    .map(r => _ps.get(r.dataset.paramId)?.label)
    .filter(l => l && l !== p.label);
  return { section, siblings: [...new Set(sibs)].slice(0, 20) };
}

function manualText() {
  _manual ??= fetch(MANUAL_URL).then(r => (r.ok ? r.text() : '')).catch(() => '');
  return _manual;
}

/** Manual lines that name the id (or, failing that, the label in bold/a table cell). */
function manualExcerpts(md, p) {
  if (!md) return '';
  const lines = md.split('\n');
  const byId = [], byLabel = [];
  const idTag = '`' + p.id + '`';
  const lab = p.label;
  let heading = '';
  for (const line of lines) {
    if (/^#{1,4} /.test(line)) { heading = line.replace(/^#+ /, ''); continue; }
    if (line.includes(idTag)) byId.push([heading, line]);
    else if (lab && (line.includes(`**${lab}**`) || line.includes(`| ${lab} |`))) byLabel.push([heading, line]);
  }
  const pick = (byId.length ? byId : byLabel).slice(0, 6);
  let out = '', last = null;
  for (const [h, l] of pick) {
    const chunk = (h !== last ? `[${h}]\n` : '') + l.trim().slice(0, 500) + '\n';
    if (out.length + chunk.length > 2200) break;
    out += chunk; last = h;
  }
  return out;
}

async function buildFacts(p) {
  const place = placeOf(p);
  const f = [
    `Control: "${p.label}"`,
    `Kind: ${p.type}`,
    `Legal values: ${rangeText(p)}`,
  ];
  if (p.type !== PARAM_TYPE.TRIGGER) f.push(`Default: ${fmt(p, p.defaultValue)}`);
  if (p.group) f.push(`Group: ${p.group}`);
  if (place.section) f.push(`Panel section: ${place.section}`);
  if (place.siblings.length) f.push(`Other controls beside it: ${place.siblings.join(', ')}`);
  if (p.help) f.push(`Its tooltip: ${p.help}`);
  if (p.optionHelp) f.push('Its options: ' + p.options.map((o, i) => `${o} — ${p.optionHelp[i] ?? ''}`).join('; '));
  const ex = manualExcerpts(await manualText(), p);
  f.push(ex ? `What the manual says about it:\n${ex}` : 'The manual does not mention it.');
  return f.join('\n');
}

function fingerprint(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function cacheGet(id, fp) {
  try { const e = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')[id]; return e?.fp === fp ? e : null; }
  catch { return null; }
}
function cachePut(id, entry) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[id] = entry;
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* private mode: no cache, still works */ }
}

/** "WHAT IT DOES: …" lines → the four parts; null if the reply ignored the shape. */
function parseGenerated(text) {
  const keys = { 'WHAT IT DOES': 'does', 'EXAMPLE': 'example', 'WHAT TO EXPECT': 'expect', "DOESN'T AFFECT": 'not', 'DOESN’T AFFECT': 'not' };
  const out = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*[*#-]*\s*/, '').replace(/\*\*/g, '');
    const m = line.match(/^(WHAT IT DOES|EXAMPLE|WHAT TO EXPECT|DOESN'T AFFECT|DOESN’T AFFECT)\s*:\s*(.*)$/i);
    if (m) { cur = keys[m[1].toUpperCase()]; out[cur] = m[2].trim(); }
    else if (cur && line.trim()) out[cur] += ' ' + line.trim();
  }
  return Object.keys(out).length >= 2 ? out : null;
}

// ── rendering ────────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Text with `param.id` references shown as that control's label, in bold. */
function richText(text) {
  const frag = document.createDocumentFragment();
  text.split(/(`[^`]+`)/).forEach(part => {
    const m = part.match(/^`([^`]+)`$/);
    if (m) frag.appendChild(el('b', null, _ps.get(m[1])?.label ?? m[1]));
    else if (part) frag.appendChild(document.createTextNode(part));
  });
  return frag;
}

function renderParts(parts) {
  for (const { key, title } of EXPLAIN_PARTS) {
    if (!parts[key]) continue;
    _body.appendChild(el('div', 'explain-h', title));
    const para = el('p', 'explain-p');
    para.appendChild(richText(parts[key]));
    _body.appendChild(para);
  }
}

function renderNow(p) {
  if (p.type === PARAM_TYPE.TRIGGER) return;
  const now = fmt(p, p.value), def = fmt(p, p.defaultValue);
  _body.appendChild(el('div', 'explain-now', `Right now: ${now}${now === def ? ' (the default)' : ` — the default is ${def}`}`));
}

function footer(text, cls = '') {
  const f = el('div', 'explain-foot ' + cls, text);
  _body.appendChild(f);
  return f;
}

async function renderGenerated(p, force) {
  const ai = aiReady();
  if (!ai) {
    if (p.help) { const para = el('p', 'explain-p'); para.textContent = p.help; _body.appendChild(para); }
    const vals = p.type === PARAM_TYPE.SELECT ? `Choices: ${(p.options ?? []).join(', ')}` : `Values: ${rangeText(p)}`;
    _body.appendChild(el('div', 'explain-p', vals));
    renderNow(p);
    const f = footer('No written explanation yet. Set up an AI provider (⚙ in the top bar) and one can be generated. ', 'explain-none');
    const go = el('button', 'explain-again', 'Open AI settings');
    go.addEventListener('click', (ev) => {
      ev.stopPropagation();   // the settings panel closes on a document click
      const panel = document.getElementById('ai-settings-panel');
      panel?.classList.remove('hidden');
      panel?.querySelector('.ai-key-input')?.focus();
    });
    f.appendChild(go);
    return;
  }
  const my = ++_seq;
  const wait = footer(`Asking ${ai.name}…`);
  let facts;
  try { facts = await buildFacts(p); } catch (e) { facts = `Control: "${p.label}"\nLegal values: ${rangeText(p)}`; }
  const fp = fingerprint(facts);
  let hit = force ? null : cacheGet(p.id, fp);
  if (!hit) {
    try {
      const text = await explainParam(facts);
      hit = { fp, text, by: `${ai.name} · ${ai.model}`, at: Date.now() };
      cachePut(p.id, hit);
    } catch (e) {
      if (my !== _seq) return;
      wait.textContent = `Couldn't get an explanation: ${e?.message === 'no-key' ? 'no API key is set' : (e?.message || e)}.`;
      wait.classList.add('explain-none');
      return;
    }
  }
  if (my !== _seq) return;   // another control was opened meanwhile
  wait.remove();
  const parts = parseGenerated(hit.text);
  if (parts) renderParts(parts);
  else _body.appendChild(el('p', 'explain-p', hit.text));
  renderNow(p);
  const f = footer(`AI-generated (${hit.by}) — may be wrong. `, 'explain-ai');
  const again = el('button', 'explain-again', 'Ask again');
  again.addEventListener('click', () => show(p, true));
  f.appendChild(again);
}

function show(p, force = false) {
  _seq++;
  _el.style.height = '';   // a drag-resize from the last control must not crop this one
  _title.textContent = `Explain · ${p.label}`;
  _body.textContent = '';
  const written = lookupExplanation(p.id);
  if (written) {
    renderParts(written);
    renderNow(p);
    footer('Written explanation', 'explain-written');
    return;
  }
  renderGenerated(p, force);
}

function build() {
  _el = el('div', 'hidden');
  _el.id = 'explain-window';
  const bar = el('div');
  bar.id = 'explain-titlebar';
  _title = el('span', 'explain-title', 'Explain');
  const close = el('button', null, '×');
  close.title = 'Close (Esc)';
  const hide = () => { _win.save(); _el.classList.add('hidden'); _seq++; };
  close.addEventListener('click', hide);
  bar.append(_title, close);
  _body = el('div');
  _body.id = 'explain-body';
  _el.append(bar, _body);
  document.body.appendChild(_el);
  _win = makeFloating(_el, bar, 'imweb.explainGeom', {
    isHidden: () => _el.classList.contains('hidden'),
    // Height follows the text, which differs per control — so it is never
    // remembered. Reporting "collapsed" is how makeFloating is told that: it
    // keeps the stored height null and saves only position and width.
    isCollapsed: () => true,
    defaultPos: (w, h, vw) => ({ x: Math.max(8, vw - w - 340), y: 90 }),
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !_el.classList.contains('hidden')) hide();
  });
}

/** Open the Explain window on parameter `p`. */
export function openExplain(ps, p) {
  if (!p) return;
  _ps = ps;
  if (!_el) build();
  const wasHidden = _el.classList.contains('hidden');
  _el.classList.remove('hidden');
  if (wasHidden) _win.place();
  show(p);
}

export { EXPLANATIONS };
