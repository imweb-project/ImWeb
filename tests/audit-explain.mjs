/**
 * "Explain this" audit — the written explanations stay true to the instrument.
 *
 * Why this exists. A written explanation is prose about code, and prose rots
 * silently: the AI's hand-written parameter reference once advertised 39 ids of
 * which 17 no longer existed, and nothing noticed, because a wrong name is a
 * no-op rather than an error (LEARNED.md, the SOURCE_DEFS lesson). An
 * explanation that points at a renamed control reads fine and teaches the
 * performer to look for something that is not there.
 *
 * So, on the real ParameterSystem:
 *   1. every entry's KEY is a real parameter id (a `{n}` key must match at
 *      least one real id with a number in its place);
 *   2. every `backticked.id` inside a text is a real parameter id;
 *   3. every entry has exactly the four parts, none empty;
 *   4. every Audio parameter, and the core video controls, HAS an entry — so a
 *      new audio control cannot arrive unexplained;
 *   5. `{n}` is filled in for numbered copies.
 * And the checks are shown to catch a planted bad entry, so a pass means
 * something (LEARNED.md 2026-09-22: check the separation before the result).
 *
 * Run:  node tests/audit-explain.mjs
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};

const psm = await import('../src/controls/ParameterSystem.js');
const { EXPLANATIONS, EXPLAIN_PARTS, lookupExplanation } = await import('../src/ui/explain/explanations.js');
const ps = new psm.ParameterSystem();
psm.registerCoreParameters(ps);
const ids = new Set(ps.params.keys());

const AUDIO = /^(audio|arec|aplay|aspec|astretch|agrain|acorp|avoice|aheads|apart\d+)\./;
const CORE_VIDEO = ['layer.fg', 'layer.bg', 'layer.ds', 'blend.amount', 'keyer.white', 'keyer.black',
  'keyer.softness', 'feedback.zoom', 'feedback.rotate', 'feedback.decay', 'displace.amount', 'color1.hue'];
const PART_KEYS = EXPLAIN_PARTS.map((p) => p.key);

/** Real ids a key stands for: itself, or every id its `{n}` pattern matches. */
function expand(key) {
  if (!key.includes('{n}')) return ids.has(key) ? [[key, null]] : [];
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{n\\}', '(\\d+)');
  const re = new RegExp(`^${esc}$`);
  return [...ids].map((id) => [id, id.match(re)?.[1]]).filter(([, n]) => n != null);
}

function problems(entries) {
  const out = [];
  for (const [key, e] of Object.entries(entries)) {
    const real = expand(key);
    if (!real.length) { out.push(`key "${key}" is not a parameter id`); continue; }
    const keys = Object.keys(e);
    for (const k of PART_KEYS) {
      if (typeof e[k] !== 'string' || !e[k].trim()) out.push(`"${key}" is missing its "${k}" part`);
    }
    for (const k of keys) if (!PART_KEYS.includes(k)) out.push(`"${key}" has an unknown part "${k}"`);
    for (const [, n] of real) {
      for (const k of keys) {
        const text = String(e[k]).replaceAll('{n}', n ?? '{n}');
        for (const m of text.matchAll(/`([^`]+)`/g)) {
          if (!ids.has(m[1])) out.push(`"${key}" (${k}) names \`${m[1]}\`, which is not a parameter id`);
        }
      }
    }
  }
  return [...new Set(out)];
}

const fails = [];
let ran = 0;
const check = (label, cond) => { ran++; if (!cond) fails.push(label); };

// 1–3 on the real texts
for (const p of problems(EXPLANATIONS)) check(p, false);
ran++;

// 4 coverage
const audioIds = [...ids].filter((id) => AUDIO.test(id));
check('there are Audio parameters to cover (the prefix list matches something)', audioIds.length > 50);
for (const id of audioIds) check(`Audio control ${id} has no written explanation`, !!lookupExplanation(id));
for (const id of CORE_VIDEO) {
  check(`core video id ${id} exists`, ids.has(id));
  check(`core video control ${id} has no written explanation`, !!lookupExplanation(id));
}

// 5 {n} filled in
for (const id of audioIds.filter((i) => /\d/.test(i))) {
  const e = lookupExplanation(id);
  if (e) check(`${id}: "{n}" left unfilled`, !Object.values(e).some((v) => v.includes('{n}')));
}

// Separation: the checker must catch each kind of planted mistake.
const good = { does: 'a', example: 'b', expect: 'c', not: 'd' };
const planted = problems({
  'no.such.param': good,
  'aplay.rate': { ...good, does: 'see `aplay.speed`' },
  'aplay.level': { does: 'a', example: 'b', expect: 'c' },
  'aheads.on{n}': { ...good, not: 'see `aheads.rate{n}`' },   // valid: must NOT be reported
});
check('planted: unknown key is caught', planted.some((p) => p.includes('no.such.param')));
check('planted: unknown backticked id is caught', planted.some((p) => p.includes('aplay.speed')));
check('planted: missing part is caught', planted.some((p) => p.includes('"aplay.level" is missing')));
check('planted: a valid {n} reference is not reported', !planted.some((p) => p.includes('aheads')));

if (fails.length) {
  console.error(`audit-explain: ${fails.length} of ${ran} checks FAILED`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`audit-explain: ${ran} checks passed (${Object.keys(EXPLANATIONS).length} written explanations)`);
