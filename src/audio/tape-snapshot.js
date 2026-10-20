/**
 * A recording taken OUT of the tape, so it can outlive Audio Off and travel in
 * a project file.
 *
 * Pure: no engine, no ParameterSystem, no DOM. The binding hands in a `read`
 * and a `write` — the same split as `spectral-image.js` and `corpus-index.js`,
 * and what lets `tests/audit-tape-snapshot.mjs` check the round trip in node.
 *
 * **16-bit, and only what was recorded.** Float32 is 4 bytes a sample for
 * precision nobody can hear, and an allocated tape is exact zeros until
 * something writes to it — so the tape is cut into one-second blocks, blocks
 * that are still exact zero are dropped, and neighbours are merged into runs.
 * A mostly-empty 600 s tape costs what was actually recorded, not 230 MB.
 * Recorded silence is never exact zero (a mic has a noise floor), so "exact
 * zero" means "never written", not "quiet".
 */

/** Largest span one `/tape/read` or `/tape/write` may carry (the engine caps reads at 10 s). */
export const CHUNK_SECONDS = 10;
const CHANNELS = 2;

/**
 * @param {(start:number,end:number)=>Promise<{data:Float32Array}|null>} read
 * @param {number} length     tape length in frames
 * @param {number} sampleRate
 * @returns {Promise<{sampleRate:number,length:number,channels:number,runs:{start:number,pcm:Int16Array}[]}|null>}
 *   `null` if any read was refused — a partial snapshot would be restored as if
 *   it were whole, which is the silent-loss this module exists to remove.
 */
export async function captureSnapshot(read, length, sampleRate) {
  const block = Math.max(1, Math.round(sampleRate));
  const chunk = Math.max(block, Math.floor(CHUNK_SECONDS * sampleRate / block) * block);
  const runs = [];
  let cur = null; // the run being extended: { start, parts: Int16Array[], frames }
  for (let at = 0; at < length; at += chunk) {
    const end = Math.min(length, at + chunk);
    const got = await read(at, end);
    if (!got) return null;
    const d = got.data;
    for (let b = 0; b < end - at; b += block) {
      const n = Math.min(block, end - at - b);
      const off = b * CHANNELS;
      let used = false;
      for (let i = 0; i < n * CHANNELS; i++) if (d[off + i] !== 0) { used = true; break; }
      if (!used) { cur = null; continue; }
      const pcm = new Int16Array(n * CHANNELS);
      for (let i = 0; i < pcm.length; i++) {
        const x = Math.max(-1, Math.min(1, d[off + i]));
        pcm[i] = Math.round(x * 32767);
      }
      const start = at + b;
      if (cur && cur.start + cur.frames === start) {
        cur.parts.push(pcm); cur.frames += n;
      } else {
        cur = { start, parts: [pcm], frames: n };
        runs.push(cur);
      }
    }
  }
  return {
    sampleRate, length, channels: CHANNELS,
    runs: runs.map(({ start, parts, frames }) => {
      const pcm = new Int16Array(frames * CHANNELS);
      let o = 0;
      for (const p of parts) { pcm.set(p, o); o += p.length; }
      return { start, pcm };
    }),
  };
}

/**
 * Write a snapshot into a tape of `tapeLen` frames at `sampleRate`.
 *
 * A different sample rate (another machine, another interface) is resampled
 * linearly rather than refused — pitch and timing are what a performer would
 * notice, not interpolation error. Anything past the end of the tape is
 * dropped (the tape may have been made shorter since).
 *
 * @param {boolean} clear also write zeros over every span the snapshot does
 *   not cover — needed when the tape already holds material (a project loaded
 *   while audio runs); skipped after a fresh allocation, which is zero already.
 * @returns {number} frames of recorded material written
 */
export function restoreSnapshot(snap, write, sampleRate, tapeLen, { clear = false } = {}) {
  const ratio = snap.sampleRate / sampleRate; // source frames per target frame
  const runs = snap.runs.map(({ start, pcm }) => ({
    from: Math.round(start / ratio),
    to: Math.round((start + pcm.length / CHANNELS) / ratio),
    start, pcm,
  }));
  const chunk = Math.max(1, Math.floor(CHUNK_SECONDS * sampleRate));
  let written = 0;
  for (let at = 0; at < tapeLen; at += chunk) {
    const end = Math.min(tapeLen, at + chunk);
    const hits = runs.filter((r) => r.from < end && r.to > at);
    if (!hits.length && !clear) continue;
    const out = new Float32Array((end - at) * CHANNELS);
    for (const r of hits) {
      const srcFrames = r.pcm.length / CHANNELS;
      for (let t = Math.max(at, r.from); t < Math.min(end, r.to); t++) {
        const pos = t * ratio - r.start;          // source frame, fractional
        const i0 = Math.max(0, Math.min(srcFrames - 1, Math.floor(pos)));
        const i1 = Math.min(srcFrames - 1, i0 + 1);
        const f = ratio === 1 ? 0 : pos - Math.floor(pos);
        for (let c = 0; c < CHANNELS; c++) {
          const a = r.pcm[i0 * CHANNELS + c], b = r.pcm[i1 * CHANNELS + c];
          out[(t - at) * CHANNELS + c] = (a + (b - a) * f) / 32767;
        }
        written++;
      }
    }
    write(at, CHANNELS, out);
  }
  return written;
}

// ── JSON form, for the .imweb file ──────────────────────────────────────────

function toB64(bytes) {
  let s = '';
  const STEP = 0x8000; // fromCharCode's argument list has a ceiling
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

/** Little-endian 16-bit PCM, interleaved stereo, base64 per run. */
export function snapshotToJSON(snap) {
  if (!snap) return null;
  return {
    format: 'pcm16le', sampleRate: snap.sampleRate, length: snap.length,
    channels: snap.channels,
    runs: snap.runs.map(({ start, pcm }) => {
      const le = new Uint8Array(pcm.length * 2);
      const dv = new DataView(le.buffer);
      for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i], true);
      return { start, data: toB64(le) };
    }),
  };
}

export function snapshotFromJSON(obj) {
  if (!obj || obj.format !== 'pcm16le' || !Array.isArray(obj.runs)) return null;
  return {
    sampleRate: obj.sampleRate, length: obj.length, channels: obj.channels ?? CHANNELS,
    runs: obj.runs.map(({ start, data }) => {
      const le = fromB64(data);
      const dv = new DataView(le.buffer);
      const pcm = new Int16Array(le.length / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = dv.getInt16(i * 2, true);
      return { start, pcm };
    }),
  };
}
