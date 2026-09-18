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
  // Bit arithmetic does all dims in ~75 ms; the vertex scan took 12.7 s for
  // 12D alone standalone and ~78 s under boot. 3 s sits far from both.
  check(`all dims 2–${MAX_DIM} generate in < 3000 ms`, ms < 3000,
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

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll hypercube checks passed.\n');
process.exit(failures ? 1 : 0);
