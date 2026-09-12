/**
 * Runtime audit: the AI parameter reference must be DERIVED from the live
 * ParameterSystem, and every id it advertises must resolve.
 *
 * Why this exists. The reference was a hand-typed prose block, and it rotted
 * exactly the way CLAUDE.md's SOURCE_DEFS lesson says a second copy always
 * does. Measured when it was found: of 39 ids advertised, 17 did not exist
 * (keyer.soft for keyer.softness, feedback.x/y for feedback.hor/ver,
 * transfermode.mode for a blend system that had replaced it, color.* for
 * color1.*, effect.kaleid for effect.kaleidoscope, output.brightness for
 * effect.outbright, …), and its source table stopped at 20 of 33 entries with
 * EVERY index from 4 upward shifted by one — so "route Noise to FG" produced
 * Color2.
 *
 * Nothing caught it, and nothing could have: the apply path skipped an id it
 * could not resolve and still reported "(N params set)", so a dead name was a
 * silent no-op and a wrong index routed to the neighbouring source. The only
 * durable fix is derivation, and the only way to keep derivation is to assert
 * it — a future "let me just add a note about X to the prompt" is how the first
 * copy started.
 *
 * Run:  node tests/audit-ai-param-reference.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};

const psm = await import('../src/controls/ParameterSystem.js');
const ai  = await import('../src/ai/AIFeatures.js');
const ps  = new psm.ParameterSystem();
psm.registerCoreParameters(ps);

const fails = [];
let ran = 0;
const check = (label, cond) => { ran++; if (!cond) fails.push(label); };

const reference = ai.buildParamReference(ps);
const allowed = ai.allowedParamIds(ps);

// 1. Every id in the reference must resolve in ps. This is the whole invariant.
const advertised = [...reference.matchAll(/^ {2}([a-z0-9]+(?:\.[A-Za-z0-9_]+)+) \[/gm)].map((m) => m[1]);
check('the reference advertises a non-trivial number of ids', advertised.length > 100);
const dead = advertised.filter((id) => !ps.params.has(id));
check(`every advertised id exists in ps (dead: ${dead.slice(0, 8).join(', ')})`, dead.length === 0);

// 2. The ids that were wrong in the hand-written block must never reappear.
// These are real historical values, not hypotheticals.
const RETIRED = [
  'keyer.soft', 'feedback.x', 'feedback.y', 'transfermode.mode',
  'colorshift.amount', 'color.hue', 'color.sat', 'color.val',
  'effect.fade', 'effect.interlace', 'effect.kaleid', 'effect.mirror',
  'effect.pixsort', 'effect.lut', 'output.brightness', 'output.contrast',
  'scene3d.spin.x/y/z',
];
for (const id of RETIRED) {
  check(`retired id "${id}" is absent from the reference`, !reference.includes(`  ${id} [`));
  check(`retired id "${id}" is not in the allowed set`, !allowed.has(id));
}

// 3. SELECT options must be spelled out. An index with no legend is how
// "route to Noise" silently became "route to Color2".
for (const id of ['layer.fg', 'layer.bg', 'layer.ds']) {
  const p = ps.params.get(id);
  check(`${id} is in the reference`, reference.includes(`  ${id} [`));
  // Every source, at its real index, with its real label.
  const missing = (p.options ?? []).filter((o, i) => !reference.includes(`${i}=${o}`));
  check(`${id} lists every source with its real index (missing: ${missing.slice(0, 4).join(', ')})`, missing.length === 0);
}
// The specific off-by-one that shipped: Noise is index 5, not 4.
const noiseIdx = ps.params.get('layer.fg').options.indexOf('Noise');
check('Noise is advertised at its real index', reference.includes(`${noiseIdx}=Noise`));
check('the source list reaches the LAST source, not a stale prefix of it',
  reference.includes(`${ps.params.get('layer.fg').options.length - 1}=${ps.params.get('layer.fg').options.at(-1)}`));

// 4. Coverage must be broad. The old block reached 22 of 731 params; a
// regression to a curated handful would quietly shrink what the AI can do.
check(`allowed set covers most params (${allowed.size} of ${ps.params.size})`, allowed.size > ps.params.size * 0.5);

// 5. Excluded prefixes must still EXIST. A rename would otherwise turn an
// exclusion into dead config and silently re-admit audio DSP internals.
const src = readFileSync(resolve(root, 'src/ai/AIFeatures.js'), 'utf8');
// Guard both ends before slicing: `indexOf` returns -1 when the needle is gone,
// and an unguarded pair silently yields a garbage span that every downstream
// check then passes over — green on a file that no longer has the list at all.
const exStart = src.indexOf('const NON_VISUAL_PREFIXES = [');
const exEnd = exStart === -1 ? -1 : src.indexOf('];', exStart);
check('the exclusion list is still present in source', exStart !== -1 && exEnd !== -1);
const block = exStart === -1 || exEnd === -1 ? '' : src.slice(exStart, exEnd);
// Strip comments BEFORE parsing the list (LEARNED.md 2026-08-15, the corollary
// for source-text audits). Caught live: the list is documented line by line and
// one comment quotes the group name 'global', which parsed as a list entry and
// failed the audit against config that was perfectly correct.
const excluded = [...block.replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('exclusion list is non-empty', excluded.length > 0);
const livePrefixes = new Set([...ps.params.keys()].map((id) => id.split('.')[0]));
const stale = excluded.filter((p) => !livePrefixes.has(p));
check(`every excluded prefix matches a real one (stale: ${stale.join(', ')})`, stale.length === 0);
for (const p of excluded) {
  check(`excluded prefix "${p}" really is excluded`, ![...allowed].some((id) => id.startsWith(`${p}.`)));
}

// 6. The prompt must be built from the derived reference, not a literal.
check('no hand-written PARAM_REFERENCE constant has crept back',
  !/const PARAM_REFERENCE\s*=/.test(src));
check('the preset prompt takes the reference as an argument',
  /function presetSystem\(paramReference\)/.test(src));
check('generatePreset requires ps', /generatePreset needs the ParameterSystem/.test(src));

// 7. A truncated patch must be reported as truncated, not as missing JSON.
// Reported live: a real Generate State run returned valid JSON cut off
// mid-string, and the error blamed the reply for containing "no JSON object" —
// sending the user to hunt for a model or prompt fault when the actual answer
// was that the patch needed more room. Same misdiagnosis already fixed on the
// shader path; this half was missed.
{
  const CUT = '{\n  "params": {\n    "layer.fg": 21,\n    "sdf.active": 1,\n    "';
  const reply = (text, stop) => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({
      content: [{ type: 'text', text }], stop_reason: stop }) });
  };
  store.set('imweb-ai-config', JSON.stringify({
    activeProvider: 'anthropic', providers: { anthropic: { apiKey: 'k', model: 'claude-sonnet-5' } } }));
  const m = await import(`../src/ai/AIFeatures.js?trunc=${Math.random()}`);

  reply(CUT, 'max_tokens');
  let msg = '';
  try { await m.generatePreset('x', ps); } catch (e) { msg = e.message; }
  check('a provider-reported truncation says it ran out of room', /ran out of room/.test(msg));
  check('and denies the quota/key theory outright', /not a quota or key problem/i.test(msg));
  check('and does not claim there was no JSON', !/contained no JSON object/.test(msg));

  // Some providers report a clean stop on a reply the model simply stopped
  // writing, so the shape has to be detected independently of the stop reason.
  reply(CUT, 'end_turn');
  msg = '';
  try { await m.generatePreset('x', ps); } catch (e) { msg = e.message; }
  check('a silently truncated patch is still detected as cut off', /cut off mid-object|unfinished/i.test(msg));

  // A genuinely JSON-free reply must still say exactly that.
  reply('I cannot help with that.', 'end_turn');
  msg = '';
  try { await m.generatePreset('x', ps); } catch (e) { msg = e.message; }
  check('a real no-JSON reply still reports no JSON', /contained no JSON object/.test(msg));

  const budget = Number(src.match(/const PRESET_TOKENS = (\d+)/)?.[1]);
  check('the preset budget is well clear of the 2000 that failed', budget >= 8000);
}

const EXPECTED_CHECKS = 79;
if (ran !== EXPECTED_CHECKS) {
  console.error(`FAIL audit-ai-param-reference: ran ${ran} checks, expected ${EXPECTED_CHECKS} — a section was skipped or added without updating the count.`);
  process.exit(1);
}
if (fails.length) {
  console.error('FAIL audit-ai-param-reference:');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log(`PASS audit-ai-param-reference — ${ran} checks: ${advertised.length} ids advertised, all resolve; ${allowed.size}/${ps.params.size} params reachable`);
