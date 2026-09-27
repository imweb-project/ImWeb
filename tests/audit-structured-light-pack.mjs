/**
 * Structured-light pack audit — bake arrays → GPU textures.
 *
 * Three silent failures live at this boundary, and each one renders as a
 * plausible picture rather than an error:
 *   1. rows not flipped — every mask, edge and relief lands mirrored top to
 *      bottom on the object (the warp-map axis lesson, CLAUDE.md);
 *   2. precision — half-float quietly rounds; for the camera-uv map it rounds
 *      whole pixels away (1919.5 → 1919);
 *   3. formats — an unsized upload, or a 32-bit float sampled linearly, reads
 *      as black (LEARNED 2026-08-04).
 * Each is checked against the source arrays, with a control that shows the
 * check can tell the difference.
 *
 * Run:  node tests/audit-structured-light-pack.mjs
 */

import { DataUtils, RedFormat, RGFormat, RGBAFormat, HalfFloatType, FloatType, UnsignedByteType, NearestFilter } from 'three';
import { packBake, toDataTextures, halfStep, DIST_CAP } from '../src/core/StructuredLightPack.js';
import { bake } from '../src/core/StructuredLightBake.js';
import { makeRig } from './lib/procam-sim.mjs';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const half = (u16) => DataUtils.fromHalfFloat(u16);

const b = bake(makeRig({ gi: false }).exact(), makeRig({ bump: 0, gi: false }).exact());
const P = packBake(b);
const { w, h } = b;
const src = (r, c) => (h - 1 - r) * w + c;   // packed row r ← bake row h-1-r

// ── 1. Rows ─────────────────────────────────────────────────────────────────
console.log('\nRow order (bake row 0 = top → texture row 0 = bottom)');
{
  let bad = 0, unflippedBad = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) for (let k = 0; k < 4; k++) {
    if (P.edges.data[(r * w + c) * 4 + k] !== b.edges[src(r, c) * 4 + k]) bad++;
    if (P.edges.data[(r * w + c) * 4 + k] !== b.edges[(r * w + c) * 4 + k]) unflippedBad++;
  }
  check('edges: every texel equals its flipped source texel', bad === 0, `${bad}`);
  check('control: the scan is not top-bottom symmetric, so a missing flip would show', unflippedBad > 1000, `${unflippedBad}`);

  let worst = 0, n = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const p = src(r, c);
    if (!b.valid[p]) continue;
    worst = Math.max(worst, Math.abs(half(P.normals.data[(r * w + c) * 4 + 1]) - b.normals[3 * p + 1]));
    n++;
  }
  check('normals: y component matches its flipped source (half precision)', n > 50000 && worst < 1e-3, `${worst}`);

  // camUV y is UP: the projector's top row saw the camera's top rows, which
  // sit at HIGH v in a flipY video texture — and the top row is the LAST row
  // of the packed data.
  const rowMean = (r) => {
    let s = 0, k = 0;
    for (let c = 0; c < w; c++) { const y = P.camUV.data[(r * w + c) * 2 + 1]; if (y >= 0) { s += y; k++; } }
    return k ? s / k : NaN;
  };
  let top = NaN, bottom = NaN;
  for (let r = h - 1; r >= 0 && !(top >= 0); r--) top = rowMean(r);
  for (let r = 0; r < h && !(bottom >= 0); r++) bottom = rowMean(r);
  check('camUV is y-up: the projector top samples the camera top', top > 0.7 && bottom < 0.3,
    `top ${top.toFixed(3)}, bottom ${bottom.toFixed(3)}`);
}

// ── 2. Precision ────────────────────────────────────────────────────────────
console.log('\nPrecision');
{
  const s = P.meta.reliefScale;
  let worst = 0, n = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const p = src(r, c);
    if (!b.valid[p]) continue;
    worst = Math.max(worst, Math.abs(half(P.relief.data[r * w + c]) * s - b.relief[p]));
    n++;
  }
  console.log(`       relief peak ${s.toFixed(2)} camera px; worst round-trip error ${worst.toExponential(2)} px (budget ${(s * 2 ** -11).toExponential(2)})`);
  // ONE step, not half: three's toHalfFloat truncates toward zero (100.31 →
  // 100.25 with 100.3125 available), so the error reaches a full step and
  // leans toward zero. Measured to land exactly on this bound.
  check('relief round-trips within one half-float step of the normalised peak (three truncates)',
    n > 50000 && worst <= s * 2 ** -11 + 1e-9, `${worst}`);

  let exact = true, seen = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const p = src(r, c);
    const u = P.camUV.data[(r * w + c) * 2], v = P.camUV.data[(r * w + c) * 2 + 1];
    if (!b.obj.valid[p]) { if (u !== -1 || v !== -1) exact = false; continue; }
    seen++;
    if (u !== Math.fround(b.obj.u[p] / b.obj.camW) || v !== Math.fround(1 - b.obj.v[p] / b.obj.camH)) exact = false;
  }
  check('camUV is stored at full float32 precision (bit-exact), -1 where unseen', seen > 50000 && exact);
  // Why not half: at a 1920-px camera the last column's centre rounds a pixel.
  const lost = Math.abs(half(DataUtils.toHalfFloat(1919.5 / 1920)) * 1920 - 1919.5);
  check('control: half precision would lose ≥ 0.4 px of camera position at 1920 wide', lost >= 0.4, `${lost}`);
  check('halfStep matches three: the step at 1919.5 is 1', halfStep(1919.5) === 1
    && half(DataUtils.toHalfFloat(1919.5)) % 1 === 0);

  let capped = true, signOk = true;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const d0 = half(P.dist.data[(r * w + c) * 2]), d1 = half(P.dist.data[(r * w + c) * 2 + 1]);
    if (Math.abs(d0) > DIST_CAP || d1 > DIST_CAP) capped = false;
    if ((d0 < 0) !== !!b.valid[src(r, c)]) signOk = false;
  }
  check('distances are capped and the signed distance keeps its sign through half', capped && signOk);
}

// ── 3. Formats ──────────────────────────────────────────────────────────────
console.log('\nFormats');
{
  const keys = ['relief', 'normals', 'edges', 'dist', 'camUV'];
  const CH = { [RedFormat]: 1, [RGFormat]: 2, [RGBAFormat]: 4 };
  const ARR = { [HalfFloatType]: Uint16Array, [FloatType]: Float32Array, [UnsignedByteType]: Uint8Array };
  const sized = keys.every(k => P[k].format in CH);
  check('only RED / RG / RGBA formats (three can size them)', sized);
  check('every 32-bit float texture is Nearest-filtered', keys.every(k => P[k].type !== FloatType || P[k].filter === NearestFilter));
  check('array type and length match format × type', keys.every(k =>
    P[k].data instanceof ARR[P[k].type] && P[k].data.length === w * h * CH[P[k].format]));
  let finite = true;
  for (const k of keys) {
    const t = P[k];
    for (let i = 0; i < t.data.length && finite; i++) {
      const v = t.type === HalfFloatType ? half(t.data[i]) : t.data[i];
      if (!Number.isFinite(v)) finite = false;
    }
  }
  check('no NaN or Infinity reaches a texture', finite);

  // A scan with NO edges at all (a flat wall filling the frame) has an
  // edge-distance of Infinity everywhere. Finiteness is not the contract —
  // three's toHalfFloat clamps to ±65504 anyway, so a check for it passed
  // with the cap deleted. The contract is meta.distCap: "no edge" reads as
  // exactly distCap, which is what a shader tests against.
  const bare = packBake({ ...b, edgeDist: new Float32Array(w * h).fill(Infinity) });
  let atCap = true;
  for (let i = 1; i < bare.dist.data.length; i += 2) if (half(bare.dist.data[i]) !== bare.meta.distCap) { atCap = false; break; }
  check('an edgeless scan reads exactly meta.distCap for "no edge"', atCap && bare.meta.distCap === DIST_CAP);

  const T = toDataTextures(P);
  check('DataTextures: flipY off, no mipmaps, filters and size as packed', keys.every(k =>
    T[k].flipY === false && T[k].generateMipmaps === false && T[k].minFilter === P[k].filter
    && T[k].magFilter === P[k].filter && T[k].image.width === w && T[k].image.height === h
    && T[k].format === P[k].format && T[k].type === P[k].type));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
