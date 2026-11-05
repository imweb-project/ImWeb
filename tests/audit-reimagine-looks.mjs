/**
 * Reimagine Looks audit — every Look must load the patch its name promises.
 *
 * A Look is written as labels ('Stills Buffer', 'Luminosity') and resolved at
 * load time by Guide.resolveStart. A renamed source, a renamed blend mode or a
 * removed param would otherwise load a DIFFERENT patch with no error a player
 * could see — the menu says "Woodcut shadow" and the screen shows something
 * else. This fails it here instead.
 *
 * Also holds the two structural rules from src/ai/ReimagineLooks.js:
 *   - index 0 is a no-op heading (no `set`), so the menu never claims a Look
 *     the patch is not in;
 *   - a Look whose picture is the Stills Buffer ALONE (FG = Stills Buffer,
 *     FG Blend Copy) must `seed`, or its first request is an empty slot — a
 *     black frame sent to a paid model.
 */
import { ParameterSystem, registerCoreParameters } from '../src/controls/ParameterSystem.js';
import { resolveStart } from '../src/ui/Guide.js';
import { REIMAGINE_LOOKS } from '../src/ai/ReimagineLooks.js';

const fails = [];
let checks = 0;
const check = (msg, ok) => { checks++; if (!ok) fails.push(msg); };

const ps = new ParameterSystem();
registerCoreParameters(ps);

check('there are Looks to check (vacuity guard)', REIMAGINE_LOOKS.length >= 3);
check('index 0 is a no-op heading', !REIMAGINE_LOOKS[0]?.set);
const menu = ps.get('reimagine.look');
check('reimagine.look exists', !!menu);
check('reimagine.look menu is REIMAGINE_LOOKS, in order',
  JSON.stringify(menu?.options) === JSON.stringify(REIMAGINE_LOOKS.map(l => l.name)));
check('reimagine.look is group global (a recall must not re-run a reset)', menu?.group === 'global');
check('Look names are unique', new Set(REIMAGINE_LOOKS.map(l => l.name)).size === REIMAGINE_LOOKS.length);

for (const look of REIMAGINE_LOOKS.slice(1)) {
  const { values, errors } = resolveStart(ps, look.set);
  check(`${look.name}: every value resolves (${errors.join('; ')})`, errors.length === 0);
  check(`${look.name}: has a prompt and an about line`, !!look.prompt && !!look.about);
  const v = Object.fromEntries(values);
  const SB = ps.get('layer.fg').options.indexOf('Stills Buffer');
  const bufferAlone = v['layer.fg'] === SB && !v['layer.fg.blend'];
  check(`${look.name}: shows the buffer alone, so it must seed from the camera`, !bufferAlone || look.seed === true);
}

if (fails.length) {
  console.error(`FAIL audit-reimagine-looks:\n  - ${fails.join('\n  - ')}`);
  process.exit(1);
}
console.log(`PASS audit-reimagine-looks — ${checks} checks: ${REIMAGINE_LOOKS.length - 1} Looks resolve, heading is a no-op, buffer-only Looks seed`);
