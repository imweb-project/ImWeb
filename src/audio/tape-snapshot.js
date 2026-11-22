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

/**
 * Copy a span of tape out, exactly — every sample, as floats — so it can be
 * put back. This is the undo for the tape-writing verbs, and it is NOT
 * `captureSnapshot`: that one is for keeping a recording across Audio Off and
 * in a project file, so it skips silence and rounds to 16 bits. An undo that
 * came back 16-bit, or with its silences untouched while the render it was
 * undoing had written into them, would not be an undo.
 *
 * @returns {Promise<null | {start:number, end:number, parts:{at:number, channels:number, data:Float32Array}[]}>}
 */
export async function captureSpan(read, start, end, sampleRate) {
  const chunk = Math.max(1, Math.floor(CHUNK_SECONDS * sampleRate));
  const parts = [];
  for (let at = start; at < end; at += chunk) {
    const got = await read(at, Math.min(end, at + chunk));
    if (!got) return null;
    parts.push({ at, channels: got.channels ?? CHANNELS, data: Float32Array.from(got.data) });
  }
  return { start, end, parts };
}

/** Put a `captureSpan` back. Copies on the way out: the engine takes the buffer. */
export function restoreSpan(saved, write) {
  for (const p of saved.parts) write(p.at, p.channels, Float32Array.from(p.data));
}

/** The default for where Normalize puts the loudest sample (`aplay.normTo`). */
export const NORMALIZE_PEAK = 0.9;

/**
 * Normalize a span of tape: one gain for the whole span and both channels, so
 * that its loudest sample lands on `target`.
 *
 * ONE gain, never one per channel — a quiet right channel is part of the
 * stereo image, and scaling the two sides separately would drag everything
 * toward the centre.
 *
 * Two passes of chunked reads (find the peak, then scale and write back)
 * rather than holding the span: a ten-minute stereo tape is 230 MB as floats.
 * Like `captureSnapshot` it goes through `read`/`write` callbacks and knows
 * nothing of the engine, which is what lets it be tested without one.
 *
 * Silence is left as silence and reported — dividing by a peak of nothing
 * would turn the noise floor into the signal.
 *
 * @returns {Promise<{ok:boolean, peak:number, gain:number, reason?:string}>}
 */
export async function normalizeSpan(read, write, start, end, sampleRate, target = NORMALIZE_PEAK) {
  const chunk = Math.max(1, Math.floor(CHUNK_SECONDS * sampleRate));
  let peak = 0;
  for (let at = start; at < end; at += chunk) {
    const got = await read(at, Math.min(end, at + chunk));
    if (!got) return { ok: false, peak: 0, gain: 1, reason: 'the tape could not be read' };
    const d = got.data;
    for (let i = 0; i < d.length; i++) {
      const v = d[i] < 0 ? -d[i] : d[i];
      if (v > peak) peak = v;
    }
  }
  if (!(peak > 1e-5)) return { ok: false, peak, gain: 1, reason: 'the selection is silent' };
  const gain = target / peak;
  if (Math.abs(gain - 1) < 1e-4) return { ok: true, peak, gain: 1 };
  for (let at = start; at < end; at += chunk) {
    const got = await read(at, Math.min(end, at + chunk));
    if (!got) return { ok: false, peak, gain, reason: 'the tape could not be read' };
    const out = new Float32Array(got.data.length);
    for (let i = 0; i < out.length; i++) out[i] = got.data[i] * gain;
    write(at, got.channels ?? CHANNELS, out);
  }
  return { ok: true, peak, gain };
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
  // A missing rate makes the resample ratio NaN in `restoreSnapshot`, and every
  // run then lands at index NaN: nothing is written and nothing is reported, so
  // the project opens with a silent tape. No recording beats a silent lie.
  if (!(obj.sampleRate > 0)) return null;
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
