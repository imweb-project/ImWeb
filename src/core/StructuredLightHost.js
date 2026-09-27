/**
 * ImWeb Structured Light — the scan's message host.
 *
 * Everything the scan Worker does, as a plain object with an async handle()
 * and an injected post(): the Worker file is a five-line shell around this,
 * so the whole protocol runs in node against the simulated rig.
 *
 * main → host                                  host → main
 *   {type:'probe', w, h}                          {type:'show', pattern}      show this, now
 *   {type:'scan', name, camW, camH, projW,        {type:'latency', latency, counts}
 *          projH, latency, decoder?, gate?}       {type:'progress', name, i, n}
 *   {type:'frame', luma, w, h}  (row 0 top)     {type:'scanned', name, nValid, frames, quiet, timeouts}
 *   {type:'videoframe', frame}  (closed here)     {type:'baked', meta, packed}   (buffers transferred)
 *   {type:'stream', readable}   (pumped here)     {type:'fitted', mesh, residual, tried, met, extrapolated}
 *   {type:'stop'}                                  {type:'saved', id} {type:'loaded', id, entry}
 *   {type:'bake', object, reference, opts?}       {type:'list', entries} {type:'deleted', id}
 *   {type:'fit', scan, tol?, rect?, cols?, rows?}  {type:'error', stage, message}
 *   {type:'save', name, meta?, roles?, fit?, id?}
 *   {type:'load', id}  {type:'list'}  {type:'delete', id}
 *
 * Scans live HERE, by name ('object', 'reference', …), and go to storage from
 * here: megabytes of correspondence never cross to the main thread unless it
 * asks for the baked textures, which it needs anyway.
 *
 * A frame arriving while nothing is running is dropped. The first frame after
 * a 'scan' message is the BASELINE (what the camera sees before the first
 * pattern), so a scan starts on camera time, not message time.
 */

import { rejectOutliers } from './StructuredLight.js';
import { LatencyProbe, ScanSession } from './StructuredLightSession.js';
import { bake } from './StructuredLightBake.js';
import { packBake } from './StructuredLightPack.js';
import { fitAuto, fitProjectionMesh } from './StructuredLightFit.js';

const YUV = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12']);
// Byte offsets of R, G, B within a pixel, per packed RGB format.
const RGB = { RGBA: [0, 1, 2], RGBX: [0, 1, 2], BGRA: [2, 1, 0], BGRX: [2, 1, 0] };

/**
 * 8-bit luma of a VideoFrame's visible rect, row 0 = top. YUV formats hand
 * over their Y plane as-is (stride honoured — camera planes are often padded
 * to an alignment); packed RGB is converted with BT.601 weights. Anything
 * else is refused by name rather than decoded wrong.
 */
export async function lumaFromVideoFrame(frame) {
  const rect = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const w = rect.width;
  const h = rect.height;
  const fmt = frame.format;
  if (!YUV.has(fmt) && !RGB[fmt]) throw new Error(`lumaFromVideoFrame: unsupported format ${fmt}`);
  const buf = new Uint8Array(frame.allocationSize({ rect }));
  const layout = await frame.copyTo(buf, { rect });
  const { offset, stride } = layout[0];
  const out = new Uint8Array(w * h);
  if (YUV.has(fmt)) {
    for (let r = 0; r < h; r++) out.set(buf.subarray(offset + r * stride, offset + r * stride + w), r * w);
    return { luma: out, w, h };
  }
  const [ri, gi, bi] = RGB[fmt];
  for (let r = 0; r < h; r++) {
    let s = offset + r * stride;
    for (let c = 0; c < w; c++, s += 4) out[r * w + c] = (77 * buf[s + ri] + 150 * buf[s + gi] + 29 * buf[s + bi] + 128) >> 8;
  }
  return { luma: out, w, h };
}

export function createScanHost({ post, store = null }) {
  const scans = new Map();
  let probe = null;
  let session = null;
  let job = null;          // the running scan's parameters
  let waitingBaseline = false;
  let reader = null;

  const fail = (stage, message) => post({ type: 'error', stage, message });

  function onFrame(luma, w, h) {
    if (probe) {
      if (w !== probe.w || h !== probe.h) return fail('probe', `frame is ${w}x${h}, probe expects ${probe.w}x${probe.h}`);
      const r = probe.push(luma);
      if (r.show) post({ type: 'show', pattern: { kind: r.show } });
      if (r.done) {
        probe = null;
        if (r.error) fail('probe', r.error);
        else post({ type: 'latency', latency: r.latency, counts: r.counts });
      }
      return;
    }
    if (!session) return;
    if (w !== job.camW || h !== job.camH) {
      session = null;
      return fail('scan', `frame is ${w}x${h}, scan expects ${job.camW}x${job.camH}`);
    }
    if (waitingBaseline) {
      waitingBaseline = false;
      post({ type: 'show', pattern: session.start(luma) });
      return;
    }
    const r = session.push(luma);
    if (r.accepted) {
      post({ type: 'progress', name: job.name, i: session.i, n: session.patterns.length });
      if (r.next) post({ type: 'show', pattern: r.next });
    }
    if (!r.done) return;
    const s = session;
    session = null;
    if (s.error) return fail('scan', s.error);
    const res = s.result();
    rejectOutliers(res);
    scans.set(job.name, res);
    post({ type: 'scanned', name: job.name, nValid: res.nValid, frames: res.frames, quiet: res.quiet, timeouts: res.timeouts });
  }

  async function pump(readable) {
    reader = readable.getReader();
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        try {
          const f = await lumaFromVideoFrame(value);
          onFrame(f.luma, f.w, f.h);
        } finally {
          value.close();
        }
      }
    } catch (e) {
      fail('stream', String(e?.message ?? e));
    } finally {
      reader = null;
    }
  }

  const need = (name) => {
    const s = scans.get(name);
    if (!s) throw new Error(`no scan named '${name}'`);
    return s;
  };

  async function handle(msg) {
    try {
      switch (msg.type) {
        case 'probe':
          probe = new LatencyProbe({ w: msg.w, h: msg.h, ...msg.opts });
          probe.w = msg.w;
          probe.h = msg.h;
          session = null;
          post({ type: 'show', pattern: { kind: probe.start().show } });
          return;
        case 'scan':
          job = { name: msg.name ?? 'object', camW: msg.camW, camH: msg.camH };
          session = new ScanSession({ camW: msg.camW, camH: msg.camH, projW: msg.projW, projH: msg.projH,
                                      latency: msg.latency, decoder: msg.decoder, gate: msg.gate });
          probe = null;
          waitingBaseline = true;
          return;
        case 'frame':
          onFrame(msg.luma, msg.w, msg.h);
          return;
        case 'videoframe':
          try {
            const f = await lumaFromVideoFrame(msg.frame);
            onFrame(f.luma, f.w, f.h);
          } finally {
            msg.frame.close?.();
          }
          return;
        case 'stream':
          pump(msg.readable);
          return;
        case 'stop':
          probe = null;
          session = null;
          await reader?.cancel();
          return;
        case 'bake': {
          const b = bake(need(msg.object ?? 'object'), need(msg.reference ?? 'reference'), msg.opts ?? {});
          const packed = packBake(b);
          const keys = ['relief', 'normals', 'edges', 'dist', 'camUV'];
          post({ type: 'baked', meta: packed.meta, packed }, keys.map(k => packed[k].data.buffer));
          return;
        }
        case 'fit': {
          const res = need(msg.scan ?? 'object');
          const f = msg.cols
            ? fitProjectionMesh(res, { cols: msg.cols, rows: msg.rows ?? msg.cols, rect: msg.rect })
            : fitAuto(res, { tol: msg.tol ?? 1, rect: msg.rect });
          post({ type: 'fitted', mesh: f.mesh.serialize(), residual: f.residual, tried: f.tried ?? null,
                 met: f.met ?? null, extrapolated: f.extrapolated });
          return;
        }
        case 'save': {
          if (!store) throw new Error('no store');
          const roles = msg.roles ?? [...scans.keys()];
          const set = {};
          for (const r of roles) set[r] = need(r);
          const id = await store.put({ id: msg.id, name: msg.name, meta: msg.meta ?? {}, scans: set, fit: msg.fit ?? null });
          post({ type: 'saved', id });
          return;
        }
        case 'load': {
          if (!store) throw new Error('no store');
          const rec = await store.get(msg.id);
          if (!rec) throw new Error(`no stored scan ${msg.id}`);
          for (const [role, res] of Object.entries(rec.scans)) scans.set(role, res);
          const { scans: _s, ...entry } = rec;
          post({ type: 'loaded', id: msg.id, entry });
          return;
        }
        case 'list':
          if (!store) throw new Error('no store');
          post({ type: 'list', entries: await store.list() });
          return;
        case 'delete':
          if (!store) throw new Error('no store');
          await store.delete(msg.id);
          post({ type: 'deleted', id: msg.id });
          return;
        default:
          throw new Error(`unknown message type '${msg.type}'`);
      }
    } catch (e) {
      fail(msg.type, String(e?.message ?? e));
    }
  }

  return { handle, scans };
}
