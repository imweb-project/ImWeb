// Creature files (.imcreature, src/scene3d/CreatureCustom.js): data only, and
// nothing from a file reaches the engine or the page unchecked.
//
//   1. Every animal exports to a file that comes back as the same movements.
//   2. A hostile or broken file is refused, or cleaned to something harmless.
//   3. The Movement menu follows a custom creature, from its file alone.
//   4. The example that ships, and the guide that explains it, stay true.
//
// run: node tests/audit-creature-file.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { ParameterSystem, registerCoreParameters } from '../src/controls/ParameterSystem.js';
import { CREATURE_KINDS, registerCreatureParams, creatureMoveOptions } from '../src/scene3d/CreatureParams.js';
import { cleanCreatureFile, applyCreatureFile, exportCreatureFile, setCreatureCustom, getCreatureCustom, plainText,
  CREATURE_FILE_FORMAT, CREATURE_FILE_EXT } from '../src/scene3d/CreatureCustom.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); if (!ok) failures++; };
const KEYS = CREATURE_KINDS.map(k => k.key);
const root = new URL('..', import.meta.url);
// A view as far as a creature file is concerned (most real views need a browser to load).
const VIEW = { soft: { limb: 0xf0c0b0, body: 0x222222, roughness: 0.5 }, skinFx: { glsl: { uniforms: { uIris: [1, 0.5, 0.1], uAmt: 1 } } } };
const throws = fn => { try { fn(); return ''; } catch (e) { return e.message || 'threw'; } };

console.log('1. Every animal exports to a file that comes back the same');
for (const K of CREATURE_KINDS) {
  const def = await import(`../tools/creature/${K.key}-def.js`);
  const file = exportCreatureFile(K.key, def, VIEW, 'Round trip');
  const text = JSON.stringify(file);
  check(`${K.label}: the file is plain JSON with no code in it`, !/function|=>|<script|javascript:/i.test(text));
  const clean = cleanCreatureFile(JSON.parse(text), KEYS), { def: d2, view: v2 } = applyCreatureFile(def, VIEW, clean);
  const same = d2.SEGMENTS.length === def.SEGMENTS.length && d2.SEGMENTS.every((s, i) => s.name === plainText(def.SEGMENTS[i].name, 24)
    && Object.keys(def.DEFAULT).filter(k => typeof def.DEFAULT[k] === 'number').every(k => ({ ...def.DEFAULT, ...s.s })[k] === ({ ...def.DEFAULT, ...def.SEGMENTS[i].s })[k]));
  check(`${K.label}: its ${def.SEGMENTS.length} movements come back value for value`, same);
  check(`${K.label}: colours come back, and pose() and the rest of the definition are the animal's own`,
    v2.soft.limb === VIEW.soft.limb && v2.soft.roughness === 0.5 && d2.pose === def.pose && d2.DEFAULT === def.DEFAULT && d2.CUSTOM === true);
  // a movement of the custom creature must still be a valid state: every control a number
  const st = { ...d2.DEFAULT, ...d2.SEGMENTS[0].s };
  check(`${K.label}: a custom movement is a complete state of numbers`, Object.keys(def.DEFAULT).every(k => typeof def.DEFAULT[k] !== 'number' || Number.isFinite(st[k])));
}

console.log('2. A hostile or broken file is refused or made harmless');
{
  const pods = await import('../tools/creature/pods-def.js');
  const good = () => ({ format: CREATURE_FILE_FORMAT, version: 1, name: 'X', base: 'pods', moves: [{ name: 'A', values: { eight: 1 } }], look: {} });
  for (const [what, raw] of [['null', null], ['a string', 'creature'], ['an array', []], ['another format', { ...good(), format: 'imweb-project' }],
    ['a newer version', { ...good(), version: 99 }], ['an unknown animal', { ...good(), base: 'dragon' }], ['a prototype name as animal', { ...good(), base: '__proto__' }],
    ['no movements', { ...good(), moves: [] }], ['movements that are not objects', { ...good(), moves: [1, 'two', null] }]])
    check(`refused: ${what}`, !!throws(() => cleanCreatureFile(raw, KEYS)));

  const evil = cleanCreatureFile({ ...good(), name: '<img src=x onerror=alert(1)>',
    moves: [{ name: '<script>alert(1)</script>', desc: '"><b onmouseover=x>', values: { eight: '1; drop', knot: NaN, flower: Infinity, wv: 2.6, stretch: 1e99,
      notAControl: 5, __proto__: 7, constructor: 3, 'a b': 1, pose: 1 } }],
    look: { limb: 'url(javascript:alert(1))', body: '#12345', roughness: 50, colours: { uIris: 'red', uVein: '#00FF00', 'x y': '#000000' } },
    pose: 'function(){ fetch("//evil") }', code: 'alert(1)' }, KEYS);
  const text = JSON.stringify(evil);
  check('names and descriptions are reduced to plain text', !/[<>"=;:/\\]/.test(evil.name + evil.moves[0].name + evil.moves[0].desc), `${evil.name} | ${evil.moves[0].name} | ${evil.moves[0].desc}`);
  check('nothing but the known fields survives', Object.keys(evil).sort().join() === 'base,format,look,moves,name,version' && !/fetch|evil|javascript/.test(text));
  const v = evil.moves[0].values;
  check('a value is kept only if it is a finite number', !('eight' in v) && !('knot' in v) && !('flower' in v) && v.wv === 2.6);
  check('a number is bounded', v.stretch === 1000);
  check('odd keys are dropped', !Object.keys(v).includes('a b') && !Object.prototype.hasOwnProperty.call(v, '__proto__'));
  check('colours must be #rrggbb, roughness 0..1', !('limb' in evil.look) && !('body' in evil.look) && evil.look.roughness === 1
    && evil.look.colours.uVein === '#00ff00' && !('uIris' in evil.look.colours) && !('x y' in evil.look.colours));

  const { def, view } = applyCreatureFile(pods, VIEW, evil);
  const s = def.SEGMENTS[0].s;
  check('against the animal: a control it does not have is dropped', Object.keys(s).join() === 'wv,stretch');
  check('against the animal: a whole-number control is rounded', s.wv === 3);
  check('the definition keeps its own pose()', def.pose === pods.pose && typeof def.pose === 'function');
  check('a colour is laid only over a colour the view has', view.skinFx.glsl.uniforms.uAmt === 1 && Array.isArray(view.skinFx.glsl.uniforms.uIris)
    && !('uVein' in view.skinFx.glsl.uniforms) && view.soft.limb === VIEW.soft.limb);
  check('the animal\'s own view is not written to', VIEW.skinFx.glsl.uniforms.uIris[0] === 1 && VIEW.soft.limb === 0xf0c0b0);
  const many = cleanCreatureFile({ ...good(), moves: Array.from({ length: 500 }, (_, i) => ({ name: 'm' + i, values: {} })) }, KEYS);
  check('the number of movements is capped', many.moves.length === 40);
}

console.log('3. The Movement menu follows a custom creature');
{
  const ps = new ParameterSystem(); registerCoreParameters(ps); registerCreatureParams(ps);
  const pods = KEYS.indexOf('pods'), own = CREATURE_KINDS[pods].moves.length;
  ps.set('creature.kind', pods);
  check('before: Pods has its own movements', ps.get('creature.segment').options.length === own);
  setCreatureCustom({ format: CREATURE_FILE_FORMAT, version: 1, name: 'Three', base: 'pods', moves: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }] });
  check('loaded: the menu is the file\'s, at once, and starts at the first', ps.get('creature.segment').options.join() === '1 · One,2 · Two,3 · Three' && ps.get('creature.segment').value === 0);
  check('another animal keeps its own movements', creatureMoveOptions(0).length === CREATURE_KINDS[0].moves.length);
  ps.set('creature.kind', 0); ps.set('creature.kind', pods);
  check('coming back to the animal shows the custom movements again', ps.get('creature.segment').options.length === 3);
  check('a bad file leaves the loaded creature as it was', !!throws(() => setCreatureCustom({ format: 'nope' })) && getCreatureCustom()?.name === 'Three');
  setCreatureCustom(null);
  check('removed: the animal\'s own movements are back', ps.get('creature.segment').options.length === own && getCreatureCustom() === null);
}

console.log('4. The example and the guide');
{
  const dir = new URL('public/Creatures/', root);
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(CREATURE_FILE_EXT)) : [];
  check('at least one example creature ships', files.length > 0);
  for (const f of files) {
    const raw = JSON.parse(readFileSync(new URL(encodeURIComponent(f), dir), 'utf8'));
    const why = throws(() => cleanCreatureFile(raw, KEYS));
    check(`${f}: loads`, !why, why);
    if (why) continue;
    const clean = cleanCreatureFile(raw, KEYS), def = await import(`../tools/creature/${clean.base}-def.js`);
    const lost = raw.moves.flatMap(m => Object.keys(m.values || {}).filter(k => typeof def.DEFAULT[k] !== 'number'));
    check(`${f}: every value in it is a control its animal has`, !lost.length, lost.join(', '));
  }
  const a = readFileSync(new URL('docs/Making_Creatures.md', root), 'utf8'), b = readFileSync(new URL('public/docs/Making_Creatures.md', root), 'utf8');
  check('the guide and its served copy are the same', a === b);
  check('the guide names the buttons the panel has', ['Export…', 'Import…', 'Remove'].every(t => a.includes(`**${t}**`))
    && ['Import…', 'Export…', 'Remove'].every(t => readFileSync(new URL('src/scene3d/CreatureUI.js', root), 'utf8').includes(`btn('${t}'`)));
  check('the panel links to the guide', readFileSync(new URL('src/scene3d/CreatureUI.js', root), 'utf8').includes("'docs/Making_Creatures.md'"));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall creature-file checks passed');
process.exit(failures ? 1 : 0);
