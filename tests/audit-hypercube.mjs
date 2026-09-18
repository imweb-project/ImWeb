/**
 * Hypercube invariants audit.
 *
 * Why this exists. The hypercube is a per-frame hot path and a boot-time
 * constructor, and every bug fixed in it on 2026-09-18 had the same property:
 * nothing threw, and the picture was plausible. Each check below pins one of
 * them, against the REAL classes (three.js runs fine in Node without a GL
 * context) or, where a DOM/GPU would be needed, against the source.
 *
 *   1. Face enumeration is bit arithmetic. The old version scanned all 2^dim
 *      vertices per candidate face and blocked boot for ~80 s, every launch,
 *      whether or not the 3D tab was ever opened. The corners must also come
 *      out pre-wound, because update() no longer sorts them.
 *   2. Faces and Instancer answer to their own toggles, not to Render Mode.
 *      Mode's default is 'none', which used to switch both off, so Faces "did
 *      nothing" until the owner also changed Mode. Faces off must also hide the
 *      mesh at once: with nothing else visible update() returns early, and the
 *      last frame's faces would otherwise stay frozen on screen.
 *   3. Face opacity fades EVERY blend mode to no effect at 0, and Multiply /
 *      Subtract leave the scene's alpha alone. three's Multiply/Subtractive
 *      presets never see source alpha (opacity did nothing), and Multiply's
 *      blendFunc also multiplied the scene's alpha by the face's — a hole in
 *      the scene's coverage the compositor then showed.
 *   4. Instance uploads are bounded to the live count, with no zero-fill past
 *      it. At 4D the faces uploaded 4224 KB a frame to draw 24.
 *   5. W distance and orthographic are independent. They shared one field, so
 *      W moved in ortho dropped to perspective, and ortho twice saved 1e9 as the
 *      distance to return to.
 *   6. HypercubeUI rows do not leave window listeners behind. They were added
 *      per row for its lifetime and never removed: 24 → 48 in four dimension
 *      changes, measured.
 *   7. Every hypercube param has a standard row — the only route to a
 *      controller badge — and a label, and targetDim reports the last queued
 *      morph (the dim handler skips on it).
 *   8. An Inst Geo change keeps the instancer under SceneManager's rotation,
 *      spin and scale: adoption compares mesh identity, not on/off.
 *  10. Dimension MORPHS over Morph Time when played (hand, LFO, MIDI) and
 *      JUMPS when recalled (state, state morph, project) — owner's call. A
 *      newer target replaces a waiting one; a jump cuts a running morph.
 *   9. While the instancer is adopted, Geometry / Back to Geometry / Cloner /
 *      material type / model import act on the scene's OWN object
 *      (_withOwnMesh), and it comes back intact when the instancer goes off.
 *
 * Calibrated 2026-09-18 with eight mutations, each caught and each restored
 * to green: renderMode re-gating faces; setVisible(false) not hiding; the
 * full-buffer upload; Multiply punching alpha; Darken fading to black; and the
 * pre-fix versions of the ortho code (64ccd43^), the UI rows (4fe617f^) and
 * the face enumeration (8d97d33^, caught at 6053 ms by the timing check only).
 *
 * Run:  node tests/audit-hypercube.mjs
 */

import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { generate2CellFaces, faceCount, MAX_DIM } from '../src/scene3d/HypercubeGeometry.js';
import { HypercubeObject } from '../src/scene3d/HypercubeObject.js';
import { HypercubeFaces } from '../src/scene3d/HypercubeFaces.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const src = p => readFileSync(new URL(`../src/scene3d/${p}`, import.meta.url), 'utf8');
// Text from `from` up to `to` (or `len` chars). A missing marker FAILS rather
// than slicing from -1 — an absent needle must never make a check vacuous.
const cut = (text, from, to, len) => {
  const a = text.indexOf(from);
  const b = to == null ? a + len : text.indexOf(to, a);
  if (a === -1 || (to != null && b === -1)) {
    check(`marker present: ${JSON.stringify(to != null && a !== -1 ? to : from)}`, false, 'the code this check reads has moved — update the marker');
    return '';
  }
  return text.slice(a, b);
};
const mk = (opts = {}) => new HypercubeObject(new THREE.Scene(), { dim: 4, ...opts });

// ── 1. Face enumeration ─────────────────────────────────────────────────────
console.log('\n1. 2-cell faces by bit arithmetic');
{
  const t0 = performance.now();
  const all = [];
  for (let d = 2; d <= MAX_DIM; d++) all[d] = generate2CellFaces(d);
  const ms = performance.now() - t0;
  // Bit arithmetic does all dims in ~75 ms. The vertex scan (8d97d33^) takes
  // 6.0 s in Node, 12.7 s for 12D alone in Chrome, ~78 s under boot. 1 s leaves
  // ~13× headroom above the fix and 6× below the regression. It is the ONLY
  // check that catches the old algorithm: its corners were already correct.
  check(`all dims 2–${MAX_DIM} generate in < 1000 ms`, ms < 1000,
    `${ms.toFixed(0)} ms — enumeration has regressed to scanning vertices; corners are ` +
    `[base, base|bitA, base|bitB, base|bitA|bitB] with base built from the fixed axes' bits`);

  let countOk = true, windOk = true, uniqOk = true, bad = '';
  for (let d = 2; d <= MAX_DIM; d++) {
    const faces = all[d];
    if (faces.length !== faceCount(d)) { countOk = false; bad ||= `dim ${d}: ${faces.length} ≠ ${faceCount(d)}`; }
    const seen = new Set();
    for (const { corners: [c0, c1, c2, c3], axisA, axisB } of faces) {
      const A = 1 << axisA, B = 1 << axisB;
      if ((c0 & (A | B)) || c1 !== (c0 | A) || c2 !== (c0 | B) || c3 !== (c0 | A | B) || c3 >= (1 << d)) {
        windOk = false; bad ||= `dim ${d}: corners ${[c0, c1, c2, c3]} on axes ${axisA},${axisB}`;
      }
      const key = `${c0}:${axisA}:${axisB}`;
      if (seen.has(key)) uniqOk = false; seen.add(key);
    }
  }
  check('face count matches faceCount(dim) for every dim', countOk, bad);
  check('corners arrive wound [(-,-),(+,-),(-,+),(+,+)] — update() relies on it, it does not sort',
    windOk, `${bad} — update() takes c1/c2 as the edges adjacent to c0; restore the winding, do not re-add a per-frame sort`);
  check('no duplicate faces', uniqOk);
}

// ── 2. Faces / Instancer independent of Render Mode ────────────────────────
console.log('\n2. Faces and Instancer answer to their own toggles');
{
  const hc = mk();
  hc.setRenderMode('none');
  hc.setFacesVisible(true); hc.setInstancerVisible(true); hc.update(16);
  check('Mode none + Faces on → face mesh visible', hc._hFaces._mesh.visible === true,
    'renderMode is gating faces again — it picks wireframe vs points only');
  check('Mode none + Instancer on → instancer mesh visible', hc._hInstancer._mesh.visible === true);
  check('Mode none + Faces on → instances actually written', hc._hFaces._mesh.count === 24,
    `count ${hc._hFaces._mesh.count} — update() is skipping faces.update()`);
  hc.setFacesVisible(false); hc.setInstancerVisible(false); hc.update(16);
  check('everything off → face mesh hidden at once (update() returns early here)',
    hc._hFaces._mesh.visible === false, 'HypercubeFaces.setVisible(false) must hide the mesh itself');

  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const fix = cut(main, 'const _hcSrc = (id, gate)', null, 400);
  check('consumption fixpoint gates face/inst sources on their toggles, not renderMode',
    fix.length > 0 && !/renderMode/.test(fix) && !/_hcLive/.test(main),
    'a renderMode gate here stops SlitScan/Rutt-Etra rendering onto faces when Mode is none');
}

// ── 3. Blend modes: opacity 0 is identity; Multiply/Subtract keep dest alpha ─
console.log('\n3. Face blend modes');
{
  // The shader's opacity shaping, read from the source so the model below
  // cannot drift from it silently.
  const fsrc = src('HypercubeFaces.js');
  const toWhite = /if \(uBlendMode == 2 \|\| uBlendMode == 6\) rgb = mix\(vec3\(1\.0\), rgb, alpha\);/.test(fsrc);
  const toBlack = /else if \(uBlendMode >= 3\)\s+rgb \*= alpha;/.test(fsrc);
  check('shader folds opacity toward white for Multiply/Darken, black for 3+', toWhite && toBlack,
    'the model below mirrors those two lines; if you change the shader, change both');
  const shade = (mode, s, a) => mode === 2 || mode === 6 ? 1 + (s - 1) * a : mode >= 3 ? s * a : s;

  const T = THREE;
  const factor = (f, s, d, sa) => ({
    [T.ZeroFactor]: 0, [T.OneFactor]: 1, [T.SrcColorFactor]: s, [T.OneMinusSrcColorFactor]: 1 - s,
    [T.OneMinusDstColorFactor]: 1 - d, [T.SrcAlphaFactor]: sa, [T.OneMinusSrcAlphaFactor]: 1 - sa,
  })[f];
  const blend = (eq, fs, fd, s, d, sa) =>
    eq === T.MaxEquation ? Math.max(s, d) : eq === T.MinEquation ? Math.min(s, d)
      : s * factor(fs, s, d, sa) + d * factor(fd, s, d, sa);

  const f = new HypercubeFaces(new THREE.Scene());
  const names = ['Normal', 'Additive', 'Multiply', 'Subtract', 'Screen', 'Lighten', 'Darken', 'Exclusion'];
  const d = 0.35, dA = 0.8;
  for (let mode = 2; mode < names.length; mode++) {
    f.setBlending(mode);
    const m = f._mat;
    check(`${names[mode]} is CustomBlending with uBlendMode ${mode}`,
      m.blending === THREE.CustomBlending && m.uniforms.uBlendMode.value === mode,
      'three\'s presets ignore source alpha — opacity would do nothing');
    let worst = 0;
    for (const s of [0, 0.3, 0.9, 1]) {
      const out = blend(m.blendEquation, m.blendSrc, m.blendDst, shade(mode, s, 0), d, 0);
      worst = Math.max(worst, Math.abs(out - d));
    }
    check(`${names[mode]}: opacity 0 leaves the scene colour untouched`, worst < 1e-9, `off by ${worst}`);
    // and opacity 1 must actually do something, or the identity check is vacuous
    // (a dark AND a bright face: Lighten ignores the first, Darken the second)
    const moved = Math.max(...[0.05, 0.95].map(s =>
      Math.abs(blend(m.blendEquation, m.blendSrc, m.blendDst, shade(mode, s, 1), d, 1) - d)));
    check(`${names[mode]}: opacity 1 changes the colour`, moved > 0.05, `moves it by only ${moved}`);
    if (mode === 2 || mode === 3) {
      const a = blend(m.blendEquationAlpha, m.blendSrcAlpha, m.blendDstAlpha, 0.6, dA, 0.6);
      check(`${names[mode]}: scene alpha kept (face opacity does not punch coverage)`, Math.abs(a - dA) < 1e-9,
        `alpha ${a} ≠ ${dA} — blendSrcAlpha Zero, blendDstAlpha One`);
    }
  }
  const opts = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    .match(/id:'hypercube\.faces\.blend'[^\n]*options:\[([^\]]*)\]/);
  check('hypercube.faces.blend options are the append-only list the code indexes',
    opts && opts[1].replace(/['\s]/g, '') === names.join(','),
    'the stored value is an index — append new modes, never reorder or remove');
}

// ── 4. Bounded instance uploads ────────────────────────────────────────────
console.log('\n4. Instance uploads bounded to the live count');
{
  const hc = mk();
  hc.setFacesVisible(true); hc.setInstancerVisible(true); hc.update(16);
  for (const [name, mesh] of [['faces', hc._hFaces._mesh], ['instancer', hc._hInstancer._mesh]]) {
    const r = mesh.instanceMatrix.updateRanges;
    const up = r.reduce((n, x) => n + x.count, 0);
    check(`${name}: uploads count×16 floats, not the whole buffer`,
      r.length > 0 && up === mesh.count * 16,
      `${r.length ? up : 'whole buffer (' + mesh.instanceMatrix.array.length + ')'} floats for ${mesh.count} instances — ` +
      'clearUpdateRanges(); addUpdateRange(0, count * 16)');
  }
  for (const file of ['HypercubeFaces.js', 'HypercubeInstancer.js']) {
    check(`${file}: no zero-fill of instances past count`, !/_zeroMatrix/.test(src(file)),
      'mesh.count already stops the draw; zero-filling 67k matrices a frame is pure cost');
  }
  const ub = src('HypercubeObject.js');
  const body = cut(ub, '  _updateBuffers() {', '// ── Point buffer');
  check('_updateBuffers edge loops stop at the live-edge ceiling',
    (body.match(/for \(let e = 0; e < ceiling; e\+\+\)/g) || []).length === 2 && !/e < edges\.length/.test(body),
    'walking every 12D edge at 4D is 768× the work');
}

// ── 5. W distance vs orthographic ──────────────────────────────────────────
console.log('\n5. W distance and orthographic are independent');
{
  const P = h => { h.setRenderMode('points'); h.update(0); return Array.from(h._projBuf.slice(0, 48)).join(','); };
  const ref = (w, mode) => { const h = mk(); h.setWDistance(w); h.setProjectionMode(mode); return P(h); };
  const ortho = ref(3, 'orthographic'), p3 = ref(3, 'perspective'), p6 = ref(6, 'perspective');
  check('control: ortho and perspective output differ', ortho !== p3 && p3 !== p6);
  { const h = mk(); h.setWDistance(3); h.setProjectionMode('orthographic'); h.setWDistance(6);
    check('W moved while ortho stays ortho', P(h) === ortho, 'W-dist is overwriting the ortho state');
    h.setProjectionMode('perspective');
    check('…and perspective then uses the moved W', P(h) === p6); }
  { const h = mk(); h.setWDistance(3); h.setProjectionMode('orthographic'); h.setProjectionMode('orthographic');
    h.setProjectionMode('perspective');
    check('ortho selected twice, back to perspective → W 3 again', P(h) === p3, 'ortho stashed its own 1e9'); }
  check('constructed with projectionMode ortho → projects ortho', P(mk({ projectionMode: 'orthographic' })) === ortho);
}

// ── 6. HypercubeUI listener lifetime ───────────────────────────────────────
console.log('\n6. HypercubeUI window listeners');
{
  // Static: the panel needs a DOM. Every window listener must be removed by
  // the same handler reference, and added only inside a mousedown handler.
  const ui = src('HypercubeUI.js');
  const adds = [...ui.matchAll(/window\.addEventListener\('(\w+)',\s*(\w+)\)/g)].map(m => `${m[1]}:${m[2]}`);
  const rems = new Set([...ui.matchAll(/window\.removeEventListener\('(\w+)',\s*(\w+)\)/g)].map(m => `${m[1]}:${m[2]}`));
  const unpaired = adds.filter(a => !rems.has(a));
  check('every window.addEventListener has a matching removeEventListener',
    adds.length > 0 && unpaired.length === 0,
    unpaired.length ? `unpaired: ${unpaired.join(', ')} — rows are discarded on every dimension change` : 'no window listeners found — has the drag moved?');
  const row = cut(ui, 'function _paramRow(', "display.addEventListener('dblclick'");
  const pre = cut(row, 'function _paramRow(', "display.addEventListener('mousedown'");
  const md  = row.slice(pre.length);
  check('_paramRow adds its window listeners inside mousedown, not at row creation',
    row.length > 0 && (md.match(/window\.addEventListener/g) || []).length === 2 &&
    (pre.match(/window\.addEventListener/g) || []).length === 0);
}

// ── 7. Every param on the modulation grid ──────────────────────────────────
console.log('\n7. Hypercube params have standard rows (badges → LFO/MIDI/OSC)');
{
  // The hand-built panel has no controller badges, so these rows are the only
  // way onto the modulation grid. They are built by GROUP; a param outside the
  // group, or one without a label (the row would read "hypercube.rot.xy"),
  // is what would slip through.
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  check('main.js builds a row for every param in the hypercube group',
    /for \(const p of ps\.getGroup\('hypercube'\)\) hcParams\.appendChild\(buildParamRow\(p, contextMenu\)\)/.test(main),
    'without these rows no hypercube param can take a controller');
  const regs = [...main.matchAll(/ps\.register\(\{ id:'(hypercube\.[^']+)'([^\n]*)\}\);/g)];
  const unlabelled = regs.filter(([, , rest]) => !/label:'[^']+'/.test(rest)).map(([, id]) => id);
  const outside = regs.filter(([, , rest]) => !/group:'hypercube'/.test(rest)).map(([, id]) => id);
  check(`all ${regs.length} hypercube params carry a label`, regs.length > 20 && unlabelled.length === 0, unlabelled.join(', '));
  check('all hypercube params are in group hypercube', outside.length === 0, `${outside.join(', ')} — would get no row`);

  const hc = mk();
  hc.morphTo(8, { durationMs: 2000 });
  check('targetDim reports the dimension a morph is heading to', hc.targetDim === 8);
  hc.morphTo(5, { durationMs: 2000 });
  check('targetDim reports the LAST queued morph', hc.targetDim === 5,
    'the dim onChange skips when targetDim already matches — a wrong target drops real changes');
}

// ── 8. SceneManager drives the instancer's CURRENT mesh ────────────────────
console.log('\n8. Inst Geo change keeps the instancer under the 3D scene transforms');
{
  // setGeoType() replaces the InstancedMesh while the instancer stays on. An
  // on/off adoption test kept SceneManager.mesh on the removed mesh, so the
  // scene's rotation, spin and scale stopped reaching the instancer until it
  // was toggled. Real SceneManager methods on a stand-in `this` (the class
  // itself needs a WebGLRenderer).
  const { SceneManager } = await import('../src/scene3d/SceneManager.js');
  const scene = new THREE.Scene();
  const own = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); scene.add(own);
  const hc = new HypercubeObject(scene, { dim: 4 });
  const sm = { scene, mesh: own, material: own.material, _adoptedMesh: null, _ownMesh: null, _hypercube: hc,
               _adoptMesh: SceneManager.prototype._adoptMesh };
  const sync = () => SceneManager.prototype._syncInstancerAdoption.call(sm);
  hc.setInstancerVisible(true); sync();
  check('instancer on → adopted', sm.mesh === hc._hInstancer.getMesh());
  hc.setInstancerGeoType('Torus'); sync();
  check('Inst Geo changed → SceneManager drives the NEW mesh', sm.mesh === hc._hInstancer.getMesh() && scene.children.includes(sm.mesh),
    'adoption must compare mesh identity, not just on/off — release, then adopt the current mesh');
  hc.setInstancerVisible(false); sync();
  check('instancer off → own mesh restored, in the scene exactly once',
    sm.mesh === own && scene.children.filter(c => c === own).length === 1,
    're-adopting without releasing first stashes the stale instancer as the scene\'s own mesh');
}

// ── 9. Geometry, import and material act on the scene's OWN object ─────────
console.log('\n9. With the instancer adopted, Geometry / import / material hit the real object');
{
  // Adoption points SceneManager.mesh/material at the instancer. The owner's
  // report (2026-09-18): with Instancer on, "Back to Geometry" did nothing and
  // Material stopped reaching the geometry — setGeometry was refused while
  // adopted, and an import pulled the instancer out of the scene and dressed
  // the model in the instancer's material. Real SceneManager (it constructs in
  // Node with a stub renderer); a real OBJ through loadOBJ via a data: URL.
  globalThis.ProgressEvent ??= class ProgressEvent extends Event { constructor(t, o = {}) { super(t); Object.assign(this, o); } };
  const { SceneManager } = await import('../src/scene3d/SceneManager.js');
  const obj = 'data:text/plain;base64,' + Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n').toString('base64');
  for (const instOn of [true, false]) {
    const tag = instOn ? 'instancer ON' : 'instancer off';
    const sm = new SceneManager({}, 64, 64);
    const hc = await sm.createHypercube({ dim: 4 });
    const inScene = o => { let f = false; sm.scene.traverse(c => { if (c === o) f = true; }); return f; };
    const inst = () => hc._hInstancer.getMesh();
    hc.setInstancerVisible(instOn); sm._syncInstancerAdoption();
    const pivot = await sm.loadOBJ(obj, 'tri.obj'); sm._syncInstancerAdoption();
    let modelMat = null; pivot.traverse(c => { if (c.isMesh) modelMat = c.material; });
    if (instOn) {
      check(`${tag}: import leaves the instancer in the scene`, inScene(inst()),
        'loaders must run inside _withOwnMesh — they replace this.mesh');
      check(`${tag}: imported model is not dressed in the instancer's material`, modelMat !== inst().material);
    }
    // "↩ Back to Geometry", exactly as the UI button does it
    sm._importedModelName = null; sm._geoKey = null; sm.setGeometry('Torus'); sm._syncInstancerAdoption();
    sm._rebuildMaterial(3);                                   // Normal
    if (instOn) {
      check(`${tag}: Back to Geometry is not refused (Torus stashed behind the instancer)`,
        sm._ownMesh?.geometry?.type?.includes('Torus') && inScene(inst()),
        '_replaceMesh must release the instancer, not return early');
      hc.setInstancerVisible(false); sm._syncInstancerAdoption();
    }
    check(`${tag}: geometry is the Torus, in the scene, wearing the Normal material`,
      sm.mesh?.geometry?.type?.includes('Torus') && inScene(sm.mesh) &&
      sm.mesh.material?.isMeshNormalMaterial === true && sm.material === sm.mesh.material,
      'Material must follow the geometry once the instancer lets go');
    check(`${tag}: the model's pivot is gone from the scene`, !inScene(pivot));
  }
}

// ── 10. Dimension morphs on control, jumps on recall ───────────────────────
console.log('\n10. Dimension: morph when played, jump when recalled');
{
  const { ParameterSystem } = await import('../src/controls/ParameterSystem.js');
  // update() skips ALL work, morphs included, when nothing is visible — so
  // these cubes must show something, or no morph ever advances.
  const run = (hc, ms) => { for (let t = 0; t < ms; t += 16) hc.update(16); };
  const live = o => { const h = mk(o); h.setRenderMode('wireframe'); return h; };
  // _rebuild() sizes the rotation-plane arrays to the dimension; a downward
  // morph defers it, so a cut morph that skips it keeps the OLD dimension's.
  const planes = hc => hc._rotAngles.length;

  // a controller moving the target mid-morph replaces what is waiting
  let hc = live();
  hc.morphToLatest(8, { durationMs: 400 }); run(hc, 160);
  const mid = !!hc._morphState;
  hc.morphToLatest(10, { durationMs: 400 });
  hc.morphToLatest(6, { durationMs: 400 });
  check('a controlled change MORPHS (a morph is running mid-way)', mid && hc._morphState?.toDim === 8);
  check('a newer target replaces the waiting one, not queued behind it',
    hc._morphQueue.length === 1 && hc.targetDim === 6, `queue ${hc._morphQueue.map(q => q.toDim)}`);
  run(hc, 1200);
  check('…and the cube settles on the LATEST target', hc.dim === 6 && !hc._morphState && hc._morphQueue.length === 0);

  // a jump cuts a running morph, including a downward one (deferred rebuild)
  hc = live({ dim: 9 });
  hc.morphToLatest(5, { durationMs: 1000 }); run(hc, 300);
  hc.morphToLatest(4, { durationMs: 0 }); hc.update(16);
  check('a jump lands at once, even mid-morph', hc.dim === 4 && !hc._morphState,
    'recall must not wait out an animation — morphToLatest ends a running morph when durationMs is 0');
  const ref = mk({ dim: 4 });
  check('…with the target dimension\'s rotation planes (downward rebuild not skipped)', planes(hc) === planes(ref),
    `${planes(hc)} planes vs ${planes(ref)} — _rebuild() must run when a downward morph is cut`);
  // the case that needs the explicit rebuild: jumping to the dimension the cut
  // morph was ALREADY heading to starts no new morph, so nothing else rebuilds
  hc = live({ dim: 9 });
  hc.morphToLatest(5, { durationMs: 1000 }); run(hc, 300);
  hc.morphToLatest(5, { durationMs: 0 }); hc.update(16);
  check('a jump to the running morph\'s own target still rebuilds', hc.dim === 5 && !hc._morphState &&
    planes(hc) === planes(mk({ dim: 5 })), `${planes(hc)} planes vs ${planes(mk({ dim: 5 }))}`);

  // restoreState marks itself for onChange handlers
  const ps = new ParameterSystem();
  ps.register({ id: 'hypercube.dim', type: 'continuous', value: 4, min: 4, max: 12, step: 1, group: 'hypercube' });
  const seen = [];
  ps.get('hypercube.dim').onChange(() => seen.push(ps.restoring));
  ps.restoreState({ 'hypercube.dim': 7 });
  ps.set('hypercube.dim', 9);
  check('ps.restoring is true inside onChange during restoreState, false for a set()',
    seen.join() === 'true,false' && ps.restoring === false, `saw ${seen}`);

  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const h = cut(main, "ps.get('hypercube.dim')?.onChange(", '});');
  check('the dim handler jumps on recall/state-morph and morphs over Morph Time otherwise',
    /ps\.restoring \|\| presetMgr\.morphing/.test(h) && /morphToLatest\(/.test(h) &&
    /recalled \? 0 : \(ps\.get\('hypercube\.morphDuration'\)/.test(h),
    'owner decision 2026-09-18: controllers and hands morph, recall jumps');
  check('…and is registered after presetMgr exists (it reads presetMgr.morphing)',
    main.indexOf('const presetMgr = new PresetManager(') !== -1 &&
    main.indexOf("ps.get('hypercube.dim')?.onChange(") > main.indexOf('const presetMgr = new PresetManager('),
    'registered earlier, a dim change before line ~874 would hit presetMgr in its temporal dead zone');
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll hypercube checks passed.\n');
process.exit(failures ? 1 : 0);
