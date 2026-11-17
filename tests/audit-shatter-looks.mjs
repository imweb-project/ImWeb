/**
 * Shatter Looks audit — every Look must load the look its name promises.
 *
 * A Look is written with labels ('Lorenz', 'Body parts', 'Camera') resolved
 * when it is applied. A renamed shape, a renamed source or a removed control
 * would otherwise load something else with no error anyone could see. And a
 * Look that leaves one control unset gives a different result depending on
 * what was dialled before it — the name would no longer mean one thing.
 *
 * Run:  node tests/audit-shatter-looks.mjs
 */
import { ParameterSystem, registerCoreParameters } from '../src/controls/ParameterSystem.js';
import { SHATTER_LOOKS, resolveShatterLook } from '../src/scene3d/ShatterLooks.js';

const fails = [];
let checks = 0;
const check = (msg, ok) => { checks++; if (!ok) fails.push(msg); };

const ps = new ParameterSystem();
registerCoreParameters(ps);

const menu = ps.get('scene3d.shatter.look');
check('there are Looks to check (vacuity guard)', SHATTER_LOOKS.length >= 3);
check('index 0 is a no-op heading', !SHATTER_LOOKS[0]?.set);
check('scene3d.shatter.look exists', !!menu);
check('the menu is SHATTER_LOOKS, in order',
  JSON.stringify(menu?.options) === JSON.stringify(SHATTER_LOOKS.map(l => l.name)));
check('the menu is group global (a recall must not re-apply a Look)', menu?.group === 'global');
check('the menu rests on the heading', menu?.value === 0);
check('Look names are unique', new Set(SHATTER_LOOKS.map(l => l.name)).size === SHATTER_LOOKS.length);

// Every Shatter control there is — DERIVED from the registry, so a control
// added later makes every Look that does not set it fail here.
const controls = ps.getAll().map(p => p.id)
  .filter(id => (id === 'scene3d.shatter' || id.startsWith('scene3d.shatter.')) && id !== 'scene3d.shatter.look').sort();
check('there are Shatter controls to cover (vacuity guard)', controls.length >= 8);

for (const look of SHATTER_LOOKS.slice(1)) {
  const { values, errors } = resolveShatterLook(ps, look);
  check(`${look.name}: every value resolves (${errors.join('; ')})`, errors.length === 0);
  check(`${look.name}: has an about line`, !!look.about);
  const ids = values.map(([id]) => id).sort();
  check(`${look.name}: sets every Shatter control, once (missing: ${controls.filter(c => !ids.includes(c)).join(', ') || '—'})`,
    JSON.stringify(ids) === JSON.stringify(controls));
  for (const [id, v] of values) {
    const p = ps.get(id);
    const lo = p.options ? 0 : p.min, hi = p.options ? p.options.length - 1 : p.max;
    check(`${look.name}: ${id} = ${v} is within ${lo}..${hi}`, v >= lo && v <= hi);
  }
  const amt = values.find(([id]) => id === 'scene3d.shatter')?.[1] ?? 0;
  check(`${look.name}: shows itself at once (Shatter above 0)`, amt > 0);
}

if (fails.length) {
  console.error(`audit-shatter-looks: FAIL (${fails.length} of ${checks})`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`audit-shatter-looks: PASS (${checks} checks, ${SHATTER_LOOKS.length - 1} Looks, ${controls.length} controls each)`);
