/**
 * Creature invariants audit — the procedural creatures in the 3D scene.
 *
 * Why this exists. A creature in ImWeb is the test page's engine
 * (tools/creature/engine.js) plus three things that live as INDICES in saved
 * work — which animal, which movement, which skin — and every failure found
 * while it was built had the same property: nothing threw, and something
 * plausible happened instead. Each check below pins one of them, against the
 * REAL classes (three.js, the engine, the views and CreatureObject all run in
 * Node without a GL context; only a canvas has to be faked).
 *
 *   1. The Movement menu's lists (CreatureParams.js CREATURE_KINDS) equal the
 *      movements in each animal's definition file. They are a second copy, on
 *      purpose — the menu has to be right before the definition has loaded —
 *      and a second copy drifts.
 *   2. Both lists only ever grow at the end. creature.kind and
 *      creature.segment are saved as indices: an inserted animal or a
 *      reordered movement makes every saved state recall something else, with
 *      no error anywhere.
 *   3. Every creature param has a row, a label and group 'creature' (so
 *      Display States capture it), and kind is registered before segment.
 *   4. The menu is swapped AT THE PARAM when the animal changes. A recall
 *      writes kind then segment in one synchronous pass, and a segment written
 *      while the previous animal's shorter list was still in place was
 *      clamped to it.
 *   5. The engine builds and plays every listed animal, and keys its compiled
 *      shaders per animal. three.js shares programs between materials whose
 *      onBeforeCompile SOURCE TEXT matches — the same text for every creature,
 *      writing different code — so the second animal would be drawn with the
 *      first one's skin shader.
 *   6. CreatureObject, on a stand-in scene:
 *      a. a recall across animals lands on the recalled movement. While the
 *         next animal loaded, the one on screen was sent the NEW animal's
 *         movement number, wrapped it to its own shorter list and wrote the
 *         wrapped number back over the recalled value (found 2026-11-23:
 *         "Cuttlefish, movement 26" came back as 5);
 *      b. Advance moves on by itself and the Movement param follows;
 *      c. an animal once built is kept: going back to it builds nothing and
 *         happens in the same frame;
 *      d. a new animal is warmed (shaders compiled in the background) BEFORE
 *         it replaces the one on screen;
 *      e. the depth pass draws the skin with the creature's own stretch-aware
 *         material, hides fur and world extras, and puts everything back;
 *      f. only the skin counts toward the scene's bounds (3D Depth's range).
 *   7. The wiring: main.js registers the params and builds the panel;
 *      SceneManager ticks the creature after Transform, faces it after the
 *      camera, and gives it its own turn in the depth pass.
 *   8. A movement the creature chose itself is not somebody's edit. Both found
 *      by the state-capture audit, 2026-11-23, before the feature shipped:
 *      a. Advance writes each new movement to creature.segment, and
 *         Preset.liveIsUnsaved() compares every value with the stored state —
 *         so a saved look with a creature in it read as "unsaved" from its
 *         first move on, and a hand-driven bank switch kept it instead of
 *         recalling the bank;
 *      b. the AI state generator was shown only the current animal's
 *         movements, validated a reply against them, and applied the reply in
 *         the model's own key order: a movement for another animal was
 *         rejected or reset to 0. It may choose the animal, not the movement.
 *
 *   9. The Video skin (Skin Source on the creature). The picture is laid on by
 *      shader code spliced into three.js's own material at four named places;
 *      if an upgrade renames one, the splice finds nothing and the creature is
 *      plain white with no error. Its source menu is the one canonical list,
 *      it is resolved by the canonical resolver with the feedback guard, and
 *      main.js counts it as a reader of that source — a lazily drawn source
 *      (a Mix bus, Growth) worn as skin was otherwise a texture nobody drew.
 *
 * Calibrated 2026-11-23 with nine mutations, each caught and each restored to
 * green: a movement renamed in a definition (1); two movements swapped in
 * both the definition and the list (2); the `current` guard removed from
 * tick() (6a, "movement 25 → 4"); customProgramCacheKey removed from the
 * engine's patchSkin (5); _show() moved before _warm() (6d); the self-driven
 * skip removed from liveIsUnsaved() (8a); creature.segment taken out of the
 * AI's exclusions (8b); and for the Video skin two more: the
 * reader row removed from main.js, and the picture never switched on in the
 * engine (9).
 *
 * Run:  node tests/audit-creature.mjs
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ── A browser's worth of globals, for the views' canvases and the param store ──
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
function fakeCanvas() {
  const made = { createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), measureText: () => ({ width: 0 }) };
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : made[k] ?? (() => {})), set: (t, k, v) => { t[k] = v; return true; } });
  return { width: 0, height: 0, style: {}, getContext: () => ctx };
}
globalThis.document = { createElement: () => fakeCanvas() };

const THREE = await import('three');
const { ParameterSystem, registerCoreParameters } = await import('../src/controls/ParameterSystem.js');
const { CREATURE_KINDS, CREATURE_PARAM_IDS, CREATURE_SKINS, CREATURE_ADVANCE, creatureMoveOptions, registerCreatureParams } =
  await import('../src/scene3d/CreatureParams.js');
const { OPT_SOURCES } = await import('../src/controls/ParameterSystem.js');
const { PresetManager } = await import('../src/state/Preset.js');
const { allowedParamIds, buildParamReference } = await import('../src/ai/AIFeatures.js');
const { CREATURES } = await import('../tools/creature/core.js');
const { createCreature } = await import('../tools/creature/engine.js');
const { CreatureObject } = await import('../src/scene3d/CreatureObject.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Text from `from` to `to`. A missing marker FAILS rather than slicing from -1 —
// an absent needle must never make a check vacuous.
const between = (src, from, to, what) => {
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { check(`${what}: markers found`, false, `"${a < 0 ? from : to}" not in source`); return ''; }
  return src.slice(a, b);
};

// Plain imports, as CreatureFiles.js does with Vite's glob: own view file, or a block in views.js.
const { VIEWS } = await import('../tools/creature/views.js');
const loaded = new Map();
async function loadFiles(key) {
  if (!loaded.has(key)) {
    const def = await import(`../tools/creature/${key}-def.js`);
    const view = VIEWS[key] ?? (await import(`../tools/creature/${key}-view.js`)).VIEW;
    loaded.set(key, { def, view });
  }
  return loaded.get(key);
}

// ── 1. The menu's lists equal the definitions ────────────────────────────────
console.log('1. Movement lists match the definition files');
for (const K of CREATURE_KINDS) {
  const { def, view } = await loadFiles(K.key);
  const names = def.SEGMENTS.map(s => s.name);
  check(`${K.label}: ${K.moves.length} movements, as in ${K.key}-def.js`, names.join('|') === K.moves.join('|'),
    `definition has [${names.join(', ')}] — update CREATURE_KINDS in src/scene3d/CreatureParams.js (APPEND only; a rename is fine, a reorder or a removal changes what saved states recall)`);
  check(`${K.label}: label is the definition's NAME`, def.NAME === K.label, `NAME is "${def.NAME}"`);
  check(`${K.label}: registered in core.js CREATURES, with a framed view`, CREATURES.includes(K.key) && view?.camera?.pos?.length === 3 && view?.camera?.target?.length === 3);
}
check('keys are unique', new Set(CREATURE_KINDS.map(k => k.key)).size === CREATURE_KINDS.length);

// ── 2. Append-only ───────────────────────────────────────────────────────────
// Frozen 2026-11-23, the day creatures entered ImWeb. An APPENDED animal or
// movement passes (only the first `n` are digested); to bless one, leave this
// alone. A change to an existing entry fails: if it really is a rename, update
// the digest below — if it is a reorder, an insert or a removal, saved states
// now recall something else and need a migration first.
console.log('2. Animals and movements only grow at the end');
const digest = a => createHash('sha1').update(a.join('|')).digest('hex').slice(0, 10);
const FROZEN_KINDS = ['octopus', 'centipede', 'snake', 'cuttlefish', 'manta', 'paradise', 'featherstar'];
const FROZEN_MOVES = { octopus: [21, '29b6d36131'], centipede: [20, '4eee3b7df4'], snake: [15, 'cf43c3db33'], cuttlefish: [26, '96374a4988'],
  manta: [8, '07135ced30'], paradise: [14, 'f30c4cae0e'], featherstar: [12, '993feb9c6d'] };
check('the first animals are the frozen ones, in order', CREATURE_KINDS.slice(0, FROZEN_KINDS.length).map(k => k.key).join() === FROZEN_KINDS.join(),
  `now: ${CREATURE_KINDS.map(k => k.key).join()}`);
for (const K of CREATURE_KINDS) {
  const f = FROZEN_MOVES[K.key];
  if (!f) continue;                    // an animal added since: nothing saved before it existed
  const got = digest(K.moves.slice(0, f[0]));
  check(`${K.label}: its first ${f[0]} movements are unchanged`, K.moves.length >= f[0] && got === f[1],
    `digest ${got}, frozen ${f[1]}; first ${f[0]}: [${K.moves.slice(0, f[0]).join(', ')}]`);
}

// ── 3. Params ────────────────────────────────────────────────────────────────
console.log('3. Every creature param has a row, a label and is captured');
const newPs = () => { const ps = new ParameterSystem(); registerCoreParameters(ps); registerCreatureParams(ps); return ps; };
{
  const ps = newPs();
  const ids = [...ps.params.keys()].filter(id => id.startsWith('creature.'));
  const missing = ids.filter(id => !CREATURE_PARAM_IDS.includes(id)), unknown = CREATURE_PARAM_IDS.filter(id => !ids.includes(id));
  check('CREATURE_PARAM_IDS lists every creature param exactly once',
    !missing.length && !unknown.length && new Set(CREATURE_PARAM_IDS).size === CREATURE_PARAM_IDS.length,
    [missing.length && `no row: ${missing.join(', ')}`, unknown.length && `not a param: ${unknown.join(', ')}`].filter(Boolean).join('; '));
  check('each has a label of its own and a help text', ids.every(id => { const p = ps.get(id); return p.label && p.label !== id && p.help; }));
  check("all are group 'creature' and in captureState()", ids.every(id => ps.get(id).group === 'creature') && ids.every(id => id in ps.captureState()));
  check('creature.kind is registered before creature.segment (recall order)', ids.indexOf('creature.kind') >= 0 && ids.indexOf('creature.kind') < ids.indexOf('creature.segment'));
  check('skin and advance options match the engine names',
    ps.get('creature.skin').options.length === CREATURE_SKINS.length && ps.get('creature.advance').options.length === CREATURE_ADVANCE.length);
}

// ── 4. The menu swaps at the param ───────────────────────────────────────────
console.log('4. The Movement menu follows the animal, synchronously');
{
  const ps = newPs(), seg = ps.get('creature.segment');
  const long = CREATURE_KINDS.findIndex(k => k.moves.length === Math.max(...CREATURE_KINDS.map(x => x.moves.length)));
  const short = CREATURE_KINDS.findIndex(k => k.moves.length === Math.min(...CREATURE_KINDS.map(x => x.moves.length)));
  ps.set('creature.kind', short); ps.set('creature.segment', 3);
  ps.set('creature.kind', long);
  check('a new animal brings its own list and starts at its first movement',
    seg.options.join('|') === creatureMoveOptions(long).join('|') && seg.value === 0, `value ${seg.value}, ${seg.options.length} options`);
  ps.set('creature.kind', short);
  const last = CREATURE_KINDS[long].moves.length - 1;
  ps.restoreState({ 'creature.kind': long, 'creature.segment': last });
  check(`a recall of "${CREATURE_KINDS[long].label}, movement ${last + 1}" from the ${CREATURE_KINDS[short].label} (${CREATURE_KINDS[short].moves.length}) keeps ${last + 1}`,
    seg.value === last, `landed on ${seg.value + 1}`);
}

// ── 5. The engine builds every animal; shaders are keyed per animal ──────────
console.log('5. Engine: every animal builds, plays, and owns its shaders');
const built = [];
for (const K of CREATURE_KINDS) {
  const { def, view } = await loadFiles(K.key);
  let c, err = '';
  const mats = [];
  try {
    c = createCreature(THREE, def, view, { world: new THREE.Group(), onMaterial: m => mats.push(m) });
    for (let i = 0; i < 12; i++) c.step(1 / 30, { advance: 'off' });
    c.jump(def.SEGMENTS.length - 1);
    for (let i = 0; i < 12; i++) c.step(1 / 30, { advance: 'off' });
  } catch (e) { err = String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '); }
  const finite = !!c && c.bones.every(b => [...b.position.toArray(), ...b.quaternion.toArray()].every(Number.isFinite));
  check(`${K.label}: builds and plays (${c?.bones.length ?? 0} bones)`, !err && finite && c.seg === def.SEGMENTS.length - 1, err || 'a bone went non-finite');
  if (c) built.push({ K, c, mats });
}
{
  const keys = built.map(b => b.c.limbs.material.customProgramCacheKey());
  // keys.length first: with no animal built, every claim below is true of nothing.
  check('each animal\'s skin has a program key of its own',
    keys.length === CREATURE_KINDS.length && new Set(keys).size === keys.length && keys.every((k, i) => k.includes(built[i].K.label)),
    `keys: ${keys.map(k => k.slice(0, 40)).join(' / ')}`);
  const furry = built.find(b => b.c.furShells.length);
  check('fur is keyed apart from the skin it grows on, and one key serves all its shells',
    !!furry && new Set(furry.c.furShells.map(m => m.material.customProgramCacheKey())).size === 1 &&
    furry.c.furShells[0].material.customProgramCacheKey() !== furry.c.limbs.material.customProgramCacheKey(),
    furry ? '' : 'no furry animal in the list to check with');
  check('onMaterial sees every material the engine makes (skin, body, each fur shell)',
    built.every(b => b.mats.includes(b.c.limbs.material) && b.c.furShells.every(m => b.mats.includes(m.material)) && b.mats.length >= 2 + b.c.furShells.length));
  let threw = '';
  try { built.forEach(b => b.c.dispose()); } catch (e) { threw = String(e); }
  check('dispose() frees them without throwing', !threw, threw);
}

// ── 6. CreatureObject on a stand-in scene ────────────────────────────────────
console.log('6. CreatureObject');
{
  // What CreatureObject asks of a SceneManager, and no more.
  const log = { compiled: [], rendered: [] };
  let warmGate = null;                                     // set to a promise to hold a warm-up open
  const sm = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 1000), target: { isRenderTarget: true },
    _depthMat: Object.assign(new THREE.MeshDepthMaterial(), { onBeforeCompile() {} }), _normalMat: new THREE.MeshNormalMaterial(),
    renderer: {
      autoClear: true, _rt: null,
      getRenderTarget() { return this._rt; }, setRenderTarget(t) { this._rt = t; },
      compileAsync(obj) { log.compiled.push({ obj, target: this._rt }); return warmGate ?? Promise.resolve(obj); },
      render(root) {
        const seen = [];
        root.traverseVisible(o => { if (o.geometry) seen.push({ o, material: o.material }); });
        log.rendered.push({ root, seen, autoClear: this.autoClear });
      },
    },
  };
  sm.camera.position.set(0, 0, 5);
  const ps = newPs();
  let makes = 0;
  const cr = new CreatureObject(sm, loadFiles);
  const make0 = cr._make.bind(cr); cr._make = (...a) => { makes++; return make0(...a); };
  const mesh = new THREE.Object3D();
  const frame = (dt = 1 / 60) => { cr.tick(ps, dt, mesh, 1); cr.face(sm.camera, new THREE.Vector3()); };
  const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 0)); frame(); } };
  const iOct = CREATURE_KINDS.findIndex(k => k.key === 'octopus'), iCut = CREATURE_KINDS.findIndex(k => k.key === 'cuttlefish');
  const iFur = CREATURE_KINDS.findIndex(k => k === built.find(b => b.c.furShells.length)?.K);
  const iWorld = CREATURE_KINDS.findIndex(k => k.key === 'manta');

  frame();
  check('off: nothing is built and nothing shows', !cr.shown && makes === 0);
  ps.set('creature.active', 1); ps.set('creature.advance', 0); ps.set('creature.kind', iOct);
  frame(); await settle();
  check('on: the animal is fetched, built and shown', cr.shown && cr.kind === iOct && makes === 1, `kind ${cr.kind}, built ${makes}`);
  check('its shaders were compiled against the 3D scene\'s own target, which was put back after',
    log.compiled.length === 1 && log.compiled[0].target === sm.target && sm.renderer._rt === null);

  // a. recall across animals, while the first is still on screen
  const last = CREATURE_KINDS[iCut].moves.length - 1;
  warmGate = new Promise(r => { globalThis.__openGate = r; });
  ps.restoreState({ 'creature.kind': iCut, 'creature.segment': last });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 0)); frame(); }   // the octopus plays on meanwhile
  check('d. the animal on screen stays until the next one is warm', cr.kind === iOct && cr.shown && makes === 2, `on screen: ${cr.kind}, built ${makes}`);
  check('a. the outgoing animal leaves the recalled movement alone', ps.get('creature.segment').value === last,
    `creature.segment is ${ps.get('creature.segment').value}, recalled ${last}`);
  globalThis.__openGate(); warmGate = null; await settle();
  check(`a. the recall lands: ${CREATURE_KINDS[iCut].label}, movement ${last + 1}`,
    cr.kind === iCut && cr.creature.seg === last && ps.get('creature.segment').value === last,
    `kind ${cr.kind}, engine at ${cr.creature?.seg}, param ${ps.get('creature.segment').value}`);

  // b. advance
  ps.set('creature.advance', 1); ps.set('creature.loops', 1); ps.set('creature.segment', 0); frame();
  const T = cr.creature.T; for (let t = 0; t < T + 0.5; t += 0.05) frame(0.05);
  check('b. Advance moves on after its loops and the Movement param follows', cr.creature.seg === 1 && ps.get('creature.segment').value === 1,
    `engine ${cr.creature.seg}, param ${ps.get('creature.segment').value}`);
  ps.set('creature.advance', 0);

  // c. back to a kept animal
  const before = makes, compiledBefore = log.compiled.length;
  ps.set('creature.kind', iOct); frame();
  check('c. going back to an animal already built is instant and builds nothing', cr.kind === iOct && makes === before && log.compiled.length === compiledBefore,
    `kind ${cr.kind} after one frame, built ${makes - before} more`);
  check('c. the animal it replaced left the scene graph', cr.turn.children.length === 1);

  // e. depth pass
  for (const [i, what] of [[iFur, 'fur'], [iWorld, 'world extras']]) {
    if (i < 0) { check(`e. an animal with ${what} to check the depth pass with`, false); continue; }
    ps.set('creature.kind', i); frame(); await settle();
    const st = cr._stage, c = st.c, skinMat = c.limbs.material;
    const vis = new Map(); cr.root.traverse(o => vis.set(o, o.visible));
    log.rendered.length = 0;
    const took = cr.depthBegin();
    const hiddenForOverride = cr.root.visible === false;
    cr.depthDraw(sm.renderer, sm.camera, false);
    const r = log.rendered[0];
    const drew = r?.seen.map(s => s.o) ?? [];
    check(`e. ${CREATURE_KINDS[i].label}: steps out of the override pass, then draws its skin with its own depth material`,
      took && hiddenForOverride && r?.root === cr.root && r.autoClear === false && r.seen.find(s => s.o === c.limbs)?.material === st.depthMat);
    check(`e. ${CREATURE_KINDS[i].label}: ${what} are not drawn into depth (${st.ghost.length} hidden)`,
      st.ghost.length > 0 && st.ghost.every(g => !drew.includes(g.o)) && c.furShells.every(m => !drew.includes(m)) && c.worldAdded.every(o => !drew.includes(o)));
    check(`e. ${CREATURE_KINDS[i].label}: materials, visibility and autoClear are put back`,
      c.limbs.material === skinMat && [...vis].every(([o, v]) => o.visible === v) && sm.renderer.autoClear === true);
    cr.depthDraw(sm.renderer, sm.camera, true);
    check(`e. ${CREATURE_KINDS[i].label}: Normals mode uses its normal material`, log.rendered[1]?.seen.find(s => s.o === c.limbs)?.material === st.normalMat && c.limbs.material === skinMat);
  }

  // f. bounds
  {
    sm.scene.updateMatrixWorld(true);
    const all = new THREE.Box3().setFromObject(sm.scene);
    const skin = cr._stage.c.limbs, only = skin.boundingBox.clone().applyMatrix4(skin.matrixWorld);
    check('f. the scene\'s bounds with a creature in it are its skin\'s box, nothing else',
      !all.isEmpty() && all.min.distanceTo(only.min) < 1e-6 && all.max.distanceTo(only.max) < 1e-6 && Number.isFinite(all.getSize(new THREE.Vector3()).length()),
      `scene ${all.getSize(new THREE.Vector3()).toArray().map(v => v.toFixed(2))} vs skin ${only.getSize(new THREE.Vector3()).toArray().map(v => v.toFixed(2))}`);
  }

  ps.set('creature.active', 0); frame();
  check('off again: hidden, and kept', !cr.shown && cr.kind >= 0);
  let threw = '';
  try { cr.dispose(); } catch (e) { threw = String(e?.stack ?? e).split('\n').slice(0, 2).join(' | '); }
  check('dispose() frees every kept animal and leaves the scene', !threw && !sm.scene.children.includes(cr.root) && cr._kept.size === 0, threw);
}

// ── 7. Wiring ────────────────────────────────────────────────────────────────
console.log('7. Wiring');
{
  const main = read('src/main.js'), smSrc = read('src/scene3d/SceneManager.js');
  check('main.js registers the creature params', /registerCreatureParams\(ps\)/.test(main));
  check('main.js builds the Creature panel with standard param rows',
    // (the row builder is what is checked; what follows it — the guide opener — is free to grow)
    /buildCreaturePanel\(crContainer, ps,\s*id => buildParamRow\(ps\.get\(id\), contextMenu\)[,)]/.test(main));
  const apply = between(smSrc, '  applyParams(params, dt = 0, inputs = {}) {', '\n  // ── Render', 'applyParams');
  const iRide = apply.indexOf('this._rideTransform(p, s);'), iTick = apply.indexOf('this._creatureTick(p, dt, s, inputs);');
  const iLook = apply.indexOf('this.camera.lookAt('), iFace = apply.indexOf('this._creature?.face(this.camera, _t)');
  check('SceneManager ticks the creature after Transform', iRide >= 0 && iTick > iRide);
  check('SceneManager faces it after the camera is placed', iLook >= 0 && iFace > iLook);
  const render = between(smSrc, '  render(params, dt = 0, inputs = {}) {', '\n  get texture()', 'render');
  const iBegin = render.indexOf('this._creature?.depthBegin()'), iScene = render.indexOf('this.renderer.render(this.scene, this.camera);', iBegin);
  const iNull = render.indexOf('this.scene.overrideMaterial = null;', iScene), iDraw = render.indexOf('this._creature.depthDraw(', iNull);
  check('depth pass: creature out → scene with the override → override off → creature draws itself', iBegin >= 0 && iScene > iBegin && iNull > iScene && iDraw > iNull);
  check('the scene\'s own object is hidden only while a creature is SHOWN and Show Object is off',
    /const solo = !!this\._creature\?\.shown && !p\.get\('creature\.withObject'\)\?\.value;/.test(smSrc));
}

// ── 9. The Video skin ────────────────────────────────────────────────────────
console.log('9. Video skin');
{
  const { def, view } = await loadFiles('octopus');
  const c = createCreature(THREE, def, view, { world: new THREE.Group() });
  // Run the skin's shader patch against the INSTALLED three.js material source,
  // as the renderer would when it compiles it.
  const compile = mat => { const lib = mat.isMeshPhysicalMaterial ? THREE.ShaderLib.physical : THREE.ShaderLib.standard;
    const sh = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader }; mat.onBeforeCompile(sh); return sh; };
  c.setSkin('video');
  const sh = compile(c.limbs.material);
  const spliced = ['uniform sampler2D uVideo;', 'vec3 videoSkin(){', 'diffuseColor.rgb = videoC;', 'totalEmissiveRadiance += videoC', 'vBindNrm = normal;']
    .filter(t => !(sh.fragmentShader + sh.vertexShader).includes(t));
  check('the picture code lands in the installed three.js material (all four splice points exist)', spliced.length === 0, `missing: ${spliced.join(' | ')}`);
  const tex = new THREE.Texture();
  c.setVideo(tex); c.step(1 / 30, { advance: 'off' });
  check('Video skin + a picture: the shader is handed it and switched on', sh.uniforms.uVideo?.value === tex && sh.uniforms.uVideoOn?.value === 1);
  check('the picture spans the animal: its box is finite and not empty', [...sh.uniforms.uVideoBox.value.toArray()].every(Number.isFinite) && sh.uniforms.uVideoBox.value.w > 0 && sh.uniforms.uVideoBox.value.w < 1e5);
  c.setVideo(null); c.step(1 / 30, { advance: 'off' });
  check('no picture: switched off (plain white), not sampling nothing', sh.uniforms.uVideoOn.value === 0);
  c.setVideo(tex); c.setSkin('soft'); const soft = compile(c.limbs.material); c.step(1 / 30, { advance: 'off' });
  check('any other skin ignores the picture', soft.uniforms.uVideoOn.value === 0);
  let freed = false; tex.addEventListener('dispose', () => { freed = true; });
  let threw = ''; try { c.dispose(); } catch (e) { threw = String(e); }
  check('dispose() leaves the host\'s picture alone', !threw && !freed, threw);

  const ps = newPs(), p = ps.get('creature.texsrc');
  check('Skin Source is the canonical optional-source list itself, not a copy', p.options === OPT_SOURCES && p.options[0] === 'None' && p.options.length > 30);
  check('Skin lists Video last (appended; the first three keep their numbers)', ps.get('creature.skin').options.join() === 'Soft,Chrome,Glassy,Video' && CREATURE_SKINS.join() === 'soft,chrome,glass,video');
  const smSrc = read('src/scene3d/SceneManager.js'), main = read('src/main.js');
  check('SceneManager resolves it through _resolveOptSource and refuses the 3D scene\'s own picture',
    /const skinTex = this\._resolveOptSource\(p, 'creature\.texsrc', inputs\);/.test(smSrc) && /skinTex === this\.target\.texture \? null : skinTex/.test(smSrc));
  const reads = between(main, 'const _s3dReads = [', '].filter((i) => i >= 0);', '_s3dReads');
  check('main.js counts the worn source as read by the 3D scene, only while Video is worn',
    /creature\.active/.test(reads) && /creature\.skin"\)\?\.value === CREATURE_SKIN_VIDEO/.test(reads) && /creature\.texsrc"\)\?\.value \?\? 0\) - 1/.test(reads));
}

// ── 8. A movement the creature chose itself is not an edit ───────────────────
console.log('8. Self-driven movement: saved looks and the AI');
{
  // liveIsUnsaved() needs no renderer: it reads the bank's active state and ps.
  const ps = newPs();
  ps.set('creature.active', 1); ps.set('creature.kind', 0); ps.set('creature.segment', 2); ps.set('creature.advance', 1);
  const stored = ps.captureState();
  const mgr = Object.create(PresetManager.prototype);
  Object.assign(mgr, { ps, _morphActive: false, currentIdx: 0, presets: [{ activeState: 0, getState: () => ({ values: stored, controllers: {} }) }] });
  check('positive control: the look just saved is not unsaved', mgr.liveIsUnsaved() === false);
  ps.set('creature.segment', 3);                               // what Advance does at the end of a movement
  check('a. the creature moving on by itself does not make the look unsaved', mgr.liveIsUnsaved() === false);
  ps.set('creature.speed', 1.5);
  check('a. …while a real edit beside it still does', mgr.liveIsUnsaved() === true);
  ps.set('creature.speed', stored['creature.speed']);
  ps.set('creature.advance', 0); ps.set('creature.segment', 5);
  check('a. …and so does a movement chosen by hand with Advance off', mgr.liveIsUnsaved() === true);

  const allowed = allowedParamIds(ps), ref = buildParamReference(ps);
  check('b. the AI may set the animal, skin and pace', ['creature.kind', 'creature.skin', 'creature.speed', 'creature.active'].every(id => allowed.has(id) && ref.includes(`${id} [`)));
  check('b. …but not a movement number, which means nothing without its animal', !allowed.has('creature.segment') && !ref.includes('creature.segment'));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall creature checks passed');
process.exit(failures ? 1 : 0);
