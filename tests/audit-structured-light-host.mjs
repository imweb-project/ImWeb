/**
 * Structured-light host audit — the Worker's protocol, end to end, in node.
 *
 * StructuredLightHost is everything the scan Worker does, with post() and the
 * store injected, so this drives the whole job the way the main thread will:
 * probe the latency, scan the object and the empty wall through a simulated
 * camera that only sees what the host last said to 'show', bake, fit, save,
 * and load into a FRESH host — whose refit must match the first bit for bit,
 * which is the end-to-end statement that storage loses nothing.
 *
 * The store here is a stand-in that structured-clones like IndexedDB and runs
 * the real encodeScan/decodeScan; the real ScanStore on real IndexedDB, and
 * the real Worker, are checked in a browser by tools/procam/worker-check.html.
 *
 * Run:  node tests/audit-structured-light-host.mjs
 */

import { createScanHost, lumaFromVideoFrame } from '../src/core/StructuredLightHost.js';
import { encodeScan, decodeScan, SCAN_FORMAT } from '../src/core/ScanStore.js';
import { rejectOutliers } from '../src/core/StructuredLight.js';
import { ScanSession } from '../src/core/StructuredLightSession.js';
import { ProjMapMesh } from '../src/inputs/ProjMapMesh.js';
import { makeRig, makeSimCamera, PW, PH, CW, CH, SIGMA } from './lib/procam-sim.mjs';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

// Structured-clone store over the real encode/decode — IndexedDB's semantics
// without IndexedDB.
function fakeStore() {
  const index = new Map(), data = new Map();
  let n = 0;
  return {
    async put({ id, name, meta, scans, fit }) {
      id = id ?? `id-${++n}`;
      const enc = {};
      for (const [r, s] of Object.entries(scans)) enc[r] = encodeScan(s);
      index.set(id, structuredClone({ id, v: SCAN_FORMAT, name, created: n, meta, fit }));
      data.set(id, structuredClone({ id, v: SCAN_FORMAT, scans: enc }));
      return id;
    },
    async get(id) {
      if (!index.has(id)) return null;
      const scans = {};
      for (const [r, e] of Object.entries(structuredClone(data.get(id)).scans)) scans[r] = decodeScan(e);
      return { ...structuredClone(index.get(id)), scans };
    },
    async list() { return [...index.values()].map(e => structuredClone(e)); },
    async delete(id) { index.delete(id); data.delete(id); },
  };
}

function makeHost(store) {
  const inbox = [];
  const host = createScanHost({ post: (msg, transfer = []) => inbox.push({ msg, transfer }), store });
  return { host, inbox };
}

// Feed camera frames until a message satisfying `until` arrives; every 'show'
// is handed to the simulated projector, exactly as the main thread would.
async function drive(h, cam, until, maxFrames = 20000) {
  for (let k = 0; k < maxFrames; k++) {
    while (h.inbox.length) {
      const { msg } = h.inbox.shift();
      if (msg.type === 'show') cam.command(msg.pattern);
      if (msg.type === 'error' || until(msg)) return msg;
    }
    await h.host.handle({ type: 'frame', luma: cam.frame(), w: CW, h: CH });
  }
  return { type: 'timeout' };
}
const take = (h, type) => {
  const i = h.inbox.findIndex(m => m.msg.type === type || m.msg.type === 'error');
  return i < 0 ? null : h.inbox.splice(i, 1)[0];
};

// ── 1. The job, end to end ──────────────────────────────────────────────────
console.log('\nProtocol, end to end');
const objRig = makeRig({ gi: false });
const wallRig = makeRig({ bump: 0, gi: false });
const store = fakeStore();
const h1 = makeHost(store);
let fit1 = null, savedId = null;
{
  const cam = makeSimCamera(objRig, { latency: 3, seed: 31 });
  await h1.host.handle({ type: 'probe', w: CW, h: CH });
  const lat = await drive(h1, cam, m => m.type === 'latency');
  check('probe reports a latency through the protocol', lat.type === 'latency' && lat.latency === 5, JSON.stringify(lat));

  await h1.host.handle({ type: 'scan', name: 'object', camW: CW, camH: CH, projW: PW, projH: PH,
                         latency: lat.latency, decoder: { noise: SIGMA } });
  const sc = await drive(h1, cam, m => m.type === 'scanned');
  const clean = objRig.scan();
  rejectOutliers(clean);
  const got = h1.host.scans.get('object');
  let same = 0;
  for (let i = 0; i < CW * CH; i++) if (got?.valid[i] && clean.valid[i] && got.x[i] === clean.x[i] && got.y[i] === clean.y[i]) same++;
  console.log(`       object scan: ${sc.nValid} valid, ${sc.frames} frames; ${(100 * same / clean.nValid).toFixed(2)}% identical to a clean scan`);
  check('object scan completes and matches a clean scan (≥ 99%)', sc.type === 'scanned' && same >= 0.99 * clean.nValid);

  const camW = makeSimCamera(wallRig, { latency: 3, seed: 32 });
  await h1.host.handle({ type: 'scan', name: 'reference', camW: CW, camH: CH, projW: PW, projH: PH,
                         latency: lat.latency, decoder: { noise: SIGMA } });
  const rf = await drive(h1, camW, m => m.type === 'scanned');
  check('reference scan completes under its own name', rf.type === 'scanned' && rf.name === 'reference' && h1.host.scans.size === 2);

  await h1.host.handle({ type: 'bake', object: 'object', reference: 'reference' });
  const bk = take(h1, 'baked');
  const bufs = bk?.transfer ?? [];
  check('bake returns packed textures for the projector', bk?.msg.type === 'baked' && bk.msg.meta.projW === PW && bk.msg.packed.relief.width === PW,
    JSON.stringify(bk?.msg).slice(0, 200));
  check('bake TRANSFERS the texture buffers (5, distinct, the packed data itself)', bufs.length === 5 && new Set(bufs).size === 5
    && ['relief', 'normals', 'edges', 'dist', 'camUV'].every(k => bufs.includes(bk.msg.packed[k].data.buffer)));

  await h1.host.handle({ type: 'fit', scan: 'object', tol: 1 });
  fit1 = take(h1, 'fitted')?.msg;
  const mesh = new ProjMapMesh(2, 2);
  console.log(`       fit: ${fit1?.mesh.cols}x${fit1?.mesh.rows}, p95 ${fit1?.residual.p95.toFixed(3)} px, met ${fit1?.met}`);
  check('fit returns a mesh ProjMapMesh can load, within tolerance', fit1?.type === 'fitted' && fit1.met && fit1.residual.p95 <= 1
    && mesh.deserialize(fit1.mesh));

  await h1.host.handle({ type: 'save', name: 'Test rock', meta: { note: 'sim' }, fit: fit1.mesh });
  savedId = take(h1, 'saved')?.msg.id;
  check('save stores both roles and returns an id', !!savedId);
}

{
  const h2 = makeHost(store);
  await h2.host.handle({ type: 'list' });
  const ls = take(h2, 'list')?.msg;
  check('a fresh host lists the saved scan', ls?.entries?.length === 1 && ls.entries[0].name === 'Test rock');
  await h2.host.handle({ type: 'load', id: savedId });
  const ld = take(h2, 'loaded')?.msg;
  check('load restores both roles into a fresh host', ld?.type === 'loaded' && h2.host.scans.has('object') && h2.host.scans.has('reference')
    && ld.entry.fit?.cols === fit1.mesh.cols);
  await h2.host.handle({ type: 'fit', scan: 'object', tol: 1 });
  const fit2 = take(h2, 'fitted')?.msg;
  check('a refit from storage is BIT-IDENTICAL to the original fit', JSON.stringify(fit2?.mesh) === JSON.stringify(fit1.mesh)
    && fit2.residual.p95 === fit1.residual.p95);
  await h2.host.handle({ type: 'delete', id: savedId });
  take(h2, 'deleted');
  await h2.host.handle({ type: 'list' });
  check('delete removes it', take(h2, 'list')?.msg.entries.length === 0);
}

{
  // Glints. The fit expects outlier-cleaned input, and the host is the one
  // place every scan passes through — so the host must clean. A clean
  // simulated scan has nothing to clean, which let a host without
  // rejectOutliers pass everything above.
  // Specular glints (see makeSimCamera): isolated pixels that decode cleanly
  // to a place 100 columns away.
  const glints = [];
  for (let v = 30; v < CH - 30; v += 13) for (let u = 20; u < CW - 130; u += 17) glints.push([v * CW + u, v * CW + u + 100]);
  const glintPx = glints.map(([i]) => i);
  const cam = makeSimCamera(objRig, { latency: 3, seed: 41, glints });
  const h = makeHost(null);
  await h.host.handle({ type: 'scan', name: 'object', camW: CW, camH: CH, projW: PW, projH: PH, latency: 5, decoder: { noise: SIGMA } });
  await drive(h, cam, m => m.type === 'scanned');
  const kept = glintPx.filter(i => h.host.scans.get('object')?.valid[i]).length;
  // Control: the same stream through a bare session, no cleaning.
  const cam2 = makeSimCamera(objRig, { latency: 3, seed: 41, glints });
  const s = new ScanSession({ camW: CW, camH: CH, projW: PW, projH: PH, latency: 5, decoder: { noise: SIGMA } });
  cam2.command({ kind: 'black' });
  for (let k = 0; k < 12; k++) cam2.frame();
  cam2.command(s.start(cam2.frame()));
  for (let k = 0; k < 20000 && !s.done; k++) { const r = s.push(cam2.frame()); if (r.accepted && r.next) cam2.command(r.next); }
  const raw = s.result();
  const clean = objRig.scan();
  const garbage = glintPx.filter(i => raw.valid[i] && (Math.abs(raw.x[i] - clean.x[i]) > 4 || Math.abs(raw.y[i] - clean.y[i]) > 4)).length;
  console.log(`       ${glintPx.length} glints: ${garbage} decode confidently to the wrong place without cleaning; ${kept} survive the host`);
  check('the scan with glints completes', h.host.scans.has('object'));
  check('control: glints decode as confident garbage in an uncleaned scan (≥ 90%)', garbage >= 0.9 * glintPx.length, `${garbage}/${glintPx.length}`);
  check('the host removes every glint before storing the scan', kept === 0, `${kept}`);
}

// ── 2. Failure paths ────────────────────────────────────────────────────────
console.log('\nFailure paths');
{
  const h = makeHost(null);
  await h.host.handle({ type: 'bake', object: 'object', reference: 'reference' });
  check('bake with no scans reports an error naming the missing scan', /no scan named 'object'/.test(take(h, 'baked')?.msg.message ?? ''));
  await h.host.handle({ type: 'save', name: 'x' });
  check('save with no store reports it', /no store/.test(take(h, 'saved')?.msg.message ?? ''));
  await h.host.handle({ type: 'nonsense' });
  check('unknown messages are refused by name', /unknown message type 'nonsense'/.test(h.inbox.shift()?.msg.message ?? ''));
  await h.host.handle({ type: 'scan', name: 'object', camW: CW, camH: CH, projW: PW, projH: PH, latency: 4 });
  await h.host.handle({ type: 'frame', luma: new Uint8Array(10 * 10), w: 10, h: 10 });
  check('a frame of the wrong size stops the scan with a reason', /frame is 10x10, scan expects/.test(h.inbox.shift()?.msg.message ?? ''));
  await h.host.handle({ type: 'scan', name: 'object', camW: CW, camH: CH, projW: PW, projH: PH, latency: 4 });
  await h.host.handle({ type: 'stop' });
  await h.host.handle({ type: 'frame', luma: new Uint8Array(CW * CH), w: CW, h: CH });
  check('after stop, frames are ignored (nothing posted)', h.inbox.length === 0, JSON.stringify(h.inbox.map(m => m.msg.type)));
}

// ── 3. VideoFrame → luma ────────────────────────────────────────────────────
console.log('\nVideoFrame → luma');
{
  const w = 37, hh = 11;                        // odd sizes: padding matters
  const Y = Uint8Array.from({ length: w * hh }, (_, i) => (i * 13 + 7) & 255);
  const R = (i) => (i * 5) & 255, G = (i) => (i * 11 + 3) & 255, B = (i) => (255 - i * 3) & 255;
  const expectRGB = Uint8Array.from({ length: w * hh }, (_, i) => (77 * R(i) + 150 * G(i) + 29 * B(i) + 128) >> 8);
  function frame(format, stride, offset) {
    const yuv = format === 'NV12' || format === 'I420';
    const bpp = yuv ? 1 : 4;
    const size = offset + stride * hh + (yuv ? stride * hh : 0);
    const buf = new Uint8Array(size).fill(99);   // padding and chroma: junk the reader must skip
    for (let r = 0; r < hh; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c, s = offset + r * stride + c * bpp;
      if (yuv) buf[s] = Y[i];
      else {
        const px = { R: R(i), G: G(i), B: B(i) };
        [...format.slice(0, 3)].forEach((ch, k) => { buf[s + k] = px[ch]; });
        buf[s + 3] = 255;
      }
    }
    return { format, codedWidth: w, codedHeight: hh, visibleRect: { x: 0, y: 0, width: w, height: hh },
             allocationSize: () => size, copyTo: async (dst) => { dst.set(buf); return [{ offset, stride }]; } };
  }
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (const [fmt, stride, off] of [['NV12', 48, 0], ['I420', 40, 16], ['NV12', 37, 0]]) {
    const r = await lumaFromVideoFrame(frame(fmt, stride, off));
    check(`${fmt}, stride ${stride}, offset ${off}: Y plane read exactly`, r.w === w && r.h === hh && eq(r.luma, Y));
  }
  const rgba = await lumaFromVideoFrame(frame('RGBA', 160, 0));
  const bgra = await lumaFromVideoFrame(frame('BGRA', 152, 8));
  check('RGBA with row padding → BT.601 luma', eq(rgba.luma, expectRGB));
  check('BGRA with row padding and offset → the same luma (channel order honoured)', eq(bgra.luma, expectRGB));
  const swapped = await lumaFromVideoFrame({ ...frame('BGRA', 152, 8), format: 'RGBA' });
  check('control: reading BGRA as RGBA gives different luma (the order test can fail)', !eq(swapped.luma, expectRGB));
  let refused = null;
  try { await lumaFromVideoFrame({ ...frame('NV12', 48, 0), format: 'P010' }); } catch (e) { refused = e.message; }
  check('unsupported formats are refused by name', /unsupported format P010/.test(refused ?? ''));
}

// ── 4. Scan encoding ────────────────────────────────────────────────────────
console.log('\nScan encoding');
{
  const res = objRig.scan();
  rejectOutliers(res);
  const e = encodeScan(res);
  const d = decodeScan(structuredClone(e));
  let exact = d.nValid === res.nValid;
  for (let i = 0; i < CW * CH && exact; i++) {
    if (d.valid[i] !== res.valid[i]) exact = false;
    else if (res.valid[i] && (d.x[i] !== res.x[i] || d.y[i] !== res.y[i])) exact = false;
  }
  console.log(`       ${CW}x${CH} scan: ${e.xy.byteLength} bytes (4 per camera pixel)`);
  check('encode → structured clone → decode is exact', exact);
  check('4 bytes per camera pixel', e.xy.byteLength === 4 * CW * CH);
  let threw = null;
  try { encodeScan({ ...res, x: Float32Array.from(res.x, (v, i) => (res.valid[i] && i === 5000 ? v + 0.25 : v)) }); }
  catch (err) { threw = err.message; }
  const hasValid5000 = res.valid[5000] === 1;
  check('a position off the 1/2 grid is refused, not rounded', hasValid5000 && /not a multiple of 1\/2/.test(threw ?? ''),
    `${hasValid5000} ${threw}`);
  let vthrew = null;
  try { decodeScan({ ...e, v: SCAN_FORMAT + 1 }); } catch (err) { vthrew = err.message; }
  check('a newer format is refused, not guessed at', /unsupported scan format/.test(vthrew ?? ''));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
