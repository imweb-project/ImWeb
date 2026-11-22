/**
 * Vectorscope audit — Phosphor Beam (2026-11-22).
 *
 * 1. Looks load the look their name promises. Every Look sets EVERY
 *    Vectorscope control (derived from the registry, so a control added later
 *    fails every Look that forgets it), labels resolve, values are in range,
 *    and the menu is a group-'global' loader kept out of the global list.
 * 2. The colour menu is append-only: the eight fixed colours keep their
 *    indices (saved states hold an index), and Level / Pitch follow them.
 * 3. The draw path allocates nothing per frame. tick(), _strokeBeam() and
 *    _soundHue() run sixty times a second; `new`, a template string, a spread
 *    or an array literal there is garbage every frame.
 * 4. The trail fade keeps its floor-killer. A black fill at low alpha never
 *    reaches black in 8 bits — the color-burn pass is what takes the tail to
 *    0 (measured headless: ~190k lit pixels without it, 0 with it). Removing
 *    it brings the grey ghost back with no error anywhere.
 *
 * Run:  node tests/audit-scope.mjs
 */
import { readFileSync } from 'node:fs';
import { ParameterSystem, registerCoreParameters } from '../src/controls/ParameterSystem.js';
import { SCOPE_LOOKS, resolveScopeLook } from '../src/inputs/ScopeLooks.js';

const fails = [];
let checks = 0;
const check = (msg, ok) => { checks++; if (!ok) fails.push(msg); };

const ps = new ParameterSystem();
registerCoreParameters(ps);

// ── 1. Looks ────────────────────────────────────────────────────────────────
const menu = ps.get('vectorscope.look');
check('there are Looks to check (vacuity guard)', SCOPE_LOOKS.length >= 3);
check('index 0 is a no-op heading', !SCOPE_LOOKS[0]?.set);
check('vectorscope.look exists', !!menu);
check('the menu is SCOPE_LOOKS, in order',
  JSON.stringify(menu?.options) === JSON.stringify(SCOPE_LOOKS.map(l => l.name)));
check('the menu is group global (a recall must not re-apply a Look)', menu?.group === 'global');
check('the menu rests on the heading', menu?.value === 0);
check('Look names are unique', new Set(SCOPE_LOOKS.map(l => l.name)).size === SCOPE_LOOKS.length);

const ui = readFileSync(new URL('../src/ui/UI.js', import.meta.url), 'utf8');
check("vectorscope.look is kept out of the auto-built global list", ui.includes("p.id !== 'vectorscope.look'"));
check("vectorscope.look is placed in the Vectorscope panel", /'vectorscope-params':[\s\S]{0,400}'vectorscope\.look'/.test(ui));

const controls = ps.getAll().map(p => p.id)
  .filter(id => id.startsWith('vectorscope.') && id !== 'vectorscope.look').sort();
check('there are Vectorscope controls to cover (vacuity guard)', controls.length >= 9);
for (const id of controls) check(`${id} is group vectorscope (captured by Display States)`, ps.get(id).group === 'vectorscope');

for (const look of SCOPE_LOOKS.slice(1)) {
  const { values, errors } = resolveScopeLook(ps, look);
  check(`${look.name}: every value resolves (${errors.join('; ')})`, errors.length === 0);
  check(`${look.name}: has an about line`, !!look.about);
  const ids = values.map(([id]) => id).sort();
  check(`${look.name}: sets every Vectorscope control, once (missing: ${controls.filter(c => !ids.includes(c)).join(', ') || '—'})`,
    JSON.stringify(ids) === JSON.stringify(controls));
  for (const [id, v] of values) {
    const p = ps.get(id);
    const lo = p.options ? 0 : (p.min ?? 0), hi = p.options ? p.options.length - 1 : (p.max ?? 1);
    check(`${look.name}: ${id} = ${v} is within ${lo}..${hi}`, v >= lo && v <= hi);
  }
  check(`${look.name}: leaves Freeze off`, values.find(([id]) => id === 'vectorscope.freeze')?.[1] === 0);
}

// ── 2. Colour menu append-only ──────────────────────────────────────────────
const FIXED = ['Green', 'Cyan', 'Orange', 'Gold', 'Violet', 'Hot Pink', 'White', 'Aqua'];
const colours = ps.get('vectorscope.color')?.options ?? [];
check('the eight fixed colours keep their indices', JSON.stringify(colours.slice(0, 8)) === JSON.stringify(FIXED));
check('Level and Pitch are 8 and 9', colours[8] === 'Level' && colours[9] === 'Pitch');

// ── 3. Draw path allocates nothing ──────────────────────────────────────────
const src = readFileSync(new URL('../src/inputs/VectorscopeInput.js', import.meta.url), 'utf8');
/** Body of a method, by brace matching from its signature. */
function body(sig) {
  const at = src.indexOf(sig);
  if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return null;
}
const strip = (t) => t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
for (const sig of ['  tick(ps) {', '  _strokeBeam(ctx, n, beam, glow) {', '  _soundHue(kind, gain, dt) {']) {
  const b = body(sig);
  check(`${sig.trim()} found`, !!b);
  if (!b) continue;
  const code = strip(b);
  check(`${sig.trim()}: no \`new\``, !/\bnew\s+[A-Z]/.test(code));
  check(`${sig.trim()}: no template string`, !code.includes('`'));
  check(`${sig.trim()}: no spread / array or object literal built per frame`,
    !/\.\.\.|=\s*\[|=\s*\{(?!\s*$)/m.test(code.replace(/\[lineCol, glowCol\] = PALETTES\[colV\]/, '')));
}
// The mutation that must fail this check, so it is known to bite:
check('calibration: a template string IS caught', strip('{ ctx.fillStyle = `rgba(0,0,0,${a})`; }').includes('`'));

// ── 4. The fade reaches black ───────────────────────────────────────────────
const tick = strip(body('  tick(ps) {') ?? '');
check("the trail fade has its color-burn floor pass", /globalCompositeOperation\s*=\s*'color-burn'/.test(tick));
check("the color-burn fill is near-white (#fdfdfd)", /fillStyle\s*=\s*'#fdfdfd'/.test(tick));

// ── Lifecycle pairing stays (pinned elsewhere too — cheap to restate) ───────
check('initMic takes the tap as owner vectorscope', src.includes("ensureTap({ owner: 'vectorscope'"));
check('stop releases it', src.includes("releaseTap('vectorscope')"));

if (fails.length) {
  console.error(`audit-scope: FAIL (${fails.length} of ${checks})`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`audit-scope: PASS (${checks} checks, ${SCOPE_LOOKS.length - 1} Looks, ${controls.length} controls each)`);
