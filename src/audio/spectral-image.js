/**
 * The client half of the spectral writer (§4.5) — scales, and turning a picture
 * into the magnitude image the engine renders.
 *
 * **Zero imports, on purpose.** Not because a worklet will load it (it will
 * not — this runs on the main thread), but because everything here is
 * arithmetic with no ImWeb in it, and that is what makes it testable in Node
 * without a canvas, a GL context or a parameter system. The engine-side
 * counterpart is `_specStep` in `engine/tape-processor.js`.
 *
 * The division of labour is the point. §4.5's claim is that quantizing the
 * vertical axis to a musical scale is precisely what made Metasynth and UPIC
 * feel like instruments rather than curiosities — so the scale is the musical
 * decision, and it lives HERE, entirely. What crosses the protocol is a list of
 * frequencies in Hz. The engine has no idea what a mode is, cannot be taught
 * one, and never needs a version bump when a tuning is added.
 */

/**
 * The scale vocabulary. Semitone offsets within an octave, repeated upward —
 * except the harmonic series, which is not an octave-repeating pattern at all
 * and gets its own kind rather than an approximation in semitones.
 *
 * Append-only, and for the usual reason: an index into this list is what a
 * SELECT parameter stores, so inserting in the middle re-tunes every saved
 * project (the SOURCE_DEFS rule, one subsystem over).
 */
const TRITAVE = tritave();

export const SCALES = Object.freeze([
  { name: 'Chromatic',      kind: 'steps',    steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { name: 'Major',          kind: 'steps',    steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'Natural minor',  kind: 'steps',    steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Harmonic minor', kind: 'steps',    steps: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'Dorian',         kind: 'steps',    steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Pentatonic',     kind: 'steps',    steps: [0, 2, 4, 7, 9] },
  { name: 'Minor pentatonic', kind: 'steps',  steps: [0, 3, 5, 7, 10] },
  { name: 'Whole tone',     kind: 'steps',    steps: [0, 2, 4, 6, 8, 10] },
  { name: 'Octatonic',      kind: 'steps',    steps: [0, 1, 3, 4, 6, 7, 9, 10] },
  // Row r is the (r+1)th harmonic of the root. Rows are NOT equally spaced in
  // pitch here, and that is the whole character of it: a vertical brush stroke
  // paints a harmonic spectrum, so drawing produces timbre rather than chords.
  { name: 'Harmonic series', kind: 'harmonic', steps: null },

  // ── appended 2026-11 — everything below is NEW indices, nothing above moved ──
  // The modes that were missing.
  { name: 'Phrygian',       kind: 'steps',    steps: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'Lydian',         kind: 'steps',    steps: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'Mixolydian',     kind: 'steps',    steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'Locrian',        kind: 'steps',    steps: [0, 1, 3, 5, 6, 8, 10] },
  { name: 'Melodic minor',  kind: 'steps',    steps: [0, 2, 3, 5, 7, 9, 11] },
  // Other twelve-tone scales.
  { name: 'Blues',          kind: 'steps',    steps: [0, 3, 5, 6, 7, 10] },
  { name: 'Hungarian minor', kind: 'steps',   steps: [0, 2, 3, 6, 7, 8, 11] },
  { name: 'Double harmonic', kind: 'steps',   steps: [0, 1, 4, 5, 7, 8, 11] },
  { name: 'Phrygian dominant', kind: 'steps', steps: [0, 1, 4, 5, 7, 8, 10] },
  { name: 'Hirajoshi',      kind: 'steps',    steps: [0, 2, 3, 7, 8] },
  { name: 'In-sen',         kind: 'steps',    steps: [0, 1, 5, 7, 10] },
  { name: 'Messiaen 3',     kind: 'steps',    steps: [0, 2, 3, 4, 6, 7, 8, 10, 11] },
  // Bare interval stacks: a picture becomes organ-like columns of one interval.
  { name: 'Fifths',         kind: 'steps',    steps: [0, 7] },
  { name: 'Octaves',        kind: 'steps',    steps: [0] },
  // Microtonal. `steps` has always been in semitones and has never had to be
  // whole ones — these need no new mechanism, only fractions.
  { name: 'Quarter-tone',   kind: 'steps',    steps: equal(24, 12) },
  { name: '19-tone equal',  kind: 'steps',    steps: equal(19, 12) },
  { name: '31-tone equal',  kind: 'steps',    steps: equal(31, 12) },
  { name: 'Slendro',        kind: 'steps',    steps: equal(5, 12) },
  // An approximation, and named for what it evokes: a real pelog differs from
  // one gamelan to the next and is not a set of semitone offsets at all.
  { name: 'Pelog',          kind: 'steps',    steps: [0, 1.2, 2.7, 5.4, 6.7, 7.9, 10.4] },
  // Just intonation: whole-number ratios, so chords painted in it do not beat.
  { name: 'Just major',     kind: 'steps',    steps: ratios([1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8]) },
  { name: '7-limit just',   kind: 'steps',    steps: ratios([1, 8 / 7, 7 / 6, 5 / 4, 4 / 3, 7 / 5, 3 / 2, 5 / 3, 7 / 4]) },
  // Thirteen equal steps of the 3:1 "tritave" — the one scale here that does
  // not repeat at the octave, which is what `period` exists for.
  { name: 'Bohlen-Pierce',  kind: 'steps',    steps: equal(13, TRITAVE), period: TRITAVE },
  // Series that are not step patterns at all, like the harmonic one above.
  // Undertones: the harmonic series upside down, spanning the same range.
  { name: 'Subharmonic series', kind: 'subharmonic', steps: null },
  // Odd harmonics only — the hollow, clarinet-like half of the spectrum.
  { name: 'Odd harmonics',  kind: 'odd',      steps: null },
  // Harmonics pulled progressively sharp, as a stiff string or a bell does.
  { name: 'Stretched harmonics', kind: 'stretched', steps: null },
  // Evenly spaced as the EAR hears pitch (the mel scale), root to ~12 kHz:
  // the spacing a spectrogram of real sound wants, where the musical scales
  // above deliberately throw most of the spectrum away.
  { name: 'Mel (by ear)',   kind: 'mel',      steps: null },
]);

/** Semitones in a 3:1 tritave. */
function tritave() { return 12 * Math.log2(3); }
/** `n` equal divisions of `period` semitones. */
function equal(n, period) {
  return Array.from({ length: n }, (_, i) => (i * period) / n);
}
/** Frequency ratios → semitone offsets. */
function ratios(list) { return list.map((r) => 12 * Math.log2(r)); }

/** Inharmonicity of the stretched series — audible by the 8th partial, a bell by the 30th. */
const STRETCH_B = 0.0008;
const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel) => 700 * (Math.pow(10, mel / 2595) - 1);

export const SCALE_NAMES = Object.freeze(SCALES.map((s) => s.name));

/**
 * Frequencies for `rows` scale degrees upward from `rootHz`, in Hz.
 *
 * **May return FEWER than `rows` entries.** Anything at or above Nyquist
 * aliases — it does not merely sound wrong, it folds down and lands on top of
 * material that is supposed to be there — so the table stops at the last legal
 * degree and the caller reads the real row count off `.length`. The engine
 * refuses an illegal table outright; this is the client making sure it never
 * builds one, which is the difference between a range control that runs out of
 * rows and an instrument that refuses to render.
 */
export function buildPitches(scaleIndex, rootHz, rows, sampleRate) {
  const scale = SCALES[scaleIndex] ?? SCALES[0];
  const nyquist = sampleRate / 2;
  const out = [];
  for (let r = 0; r < rows; r++) {
    let hz;
    if (scale.kind === 'harmonic') {
      hz = rootHz * (r + 1);
    } else if (scale.kind === 'subharmonic') {
      // Undertones of `rootHz × rows`, listed upward: the lowest row is the
      // root and the top row is the generator they are all divisions of.
      hz = (rootHz * rows) / (rows - r);
    } else if (scale.kind === 'odd') {
      hz = rootHz * (2 * r + 1);
    } else if (scale.kind === 'stretched') {
      const k = r + 1;
      // Divided through by the first partial's own stretch, so that Root is
      // still the pitch of the bottom row and not a few cents above it.
      hz = rootHz * k * Math.sqrt((1 + STRETCH_B * k * k) / (1 + STRETCH_B));
    } else if (scale.kind === 'mel') {
      const lo = hzToMel(rootHz);
      const hi = hzToMel(Math.max(rootHz, Math.min(12000, nyquist * 0.9)));
      hz = melToHz(rows > 1 ? lo + ((hi - lo) * r) / (rows - 1) : lo);
    } else {
      const n = scale.steps.length;
      const semitones = scale.steps[r % n] + (scale.period ?? 12) * Math.floor(r / n);
      hz = rootHz * Math.pow(2, semitones / 12);
    }
    // Strictly below Nyquist, not at it: a partial exactly at Nyquist is
    // sampled twice per cycle and renders as an amplitude that depends on
    // phase alone, which is a row that mysteriously does nothing.
    if (!(hz > 0) || hz >= nyquist) break;
    out.push(hz);
  }
  return Float32Array.from(out);
}

/**
 * Resample a luminance picture into a `frames × rows` magnitude image, laid out
 * FRAME-MAJOR (one whole column of `rows` magnitudes per frame) because that is
 * the order the engine's inner loop reads.
 *
 * `luma` is any single-channel grid, values 0..1, row 0 at the TOP — which is
 * what `getImageData` and a GL readback both hand you. Screen up becomes pitch
 * up, so the y axis is flipped here. (The warp maps one subsystem over are
 * y-UP by DataTexture's default and have their own convention; this one is not
 * that one, and the two must not be reasoned about together.)
 *
 * Every target cell is a BOX AVERAGE of the source cells it covers, not a point
 * sample. A 640-wide video frame point-sampled into 256 columns throws away
 * three quarters of the picture and turns any fine vertical detail into
 * whatever happened to land under the sample point — which reads as the writer
 * being unreliable rather than as aliasing.
 */
export function imageFromLuma(luma, width, height, rows, frames, opts = {}) {
  const { gamma = 2, floor = 0.06, gain = 1 } = opts;
  const out = boxAverage(luma, width, height, rows, frames);
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    // The floor is not a nicety. A camera frame is never actually black, so
    // without it every row is faintly on in every column and the render is a
    // wash of all pitches at once — the exact "drawn spectra are noise"
    // failure §4.5 says the scale quantization exists to avoid. Subtracting
    // and rescaling rather than hard-gating keeps a fading stroke fading
    // instead of switching off at the threshold.
    const lifted = v <= floor ? 0 : (v - floor) / (1 - floor);
    out[i] = lifted > 0 ? Math.pow(lifted, gamma) * gain : 0;
  }
  return out;
}

/**
 * Box-average a single-channel grid into `frames × rows`, frame-major, y
 * flipped.
 *
 * Extracted so the magnitude image and the pan image cannot disagree about
 * WHICH WAY UP the picture is. Two copies of a y-flip is the shape of bug this
 * project has paid for before (CLAUDE.md's warp-axis note is a whole section
 * about one), and a pan image flipped relative to its magnitudes would place
 * every stroke on the wrong side while sounding otherwise perfect — audible
 * only if you happen to know what you drew.
 *
 * `weight`, when given, is a second grid of the same size: cells are averaged
 * weighted by it, and a cell whose weights are all zero comes out 0.
 */
export function boxAverage(src, width, height, rows, frames, weight = null) {
  const out = new Float32Array(frames * rows);
  for (let f = 0; f < frames; f++) {
    const x0 = Math.floor((f * width) / frames);
    const x1 = Math.max(x0 + 1, Math.floor(((f + 1) * width) / frames));
    for (let r = 0; r < rows; r++) {
      // Flip: row 0 is the LOWEST pitch and lives at the BOTTOM of the picture.
      const top = rows - 1 - r;
      const y0 = Math.floor((top * height) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((top + 1) * height) / rows));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        const base = y * width;
        for (let x = x0; x < x1 && x < width; x++) {
          const w = weight ? weight[base + x] : 1;
          sum += src[base + x] * w;
          n += w;
        }
      }
      out[f * rows + r] = n > 0 ? sum / n : 0;
    }
  }
  return out;
}

/** How many octaves of slowing Tilt reaches at ±1: 2^3 = eight times. */
export const TILT_OCTAVES = 3;

/**
 * Tilt: stretch each ROW of a frame-major image along time by its own amount.
 *
 * The engine's time axis is one playhead for every row — at a given sample all
 * oscillators read the same column. Tilt is what happens when they do not: at
 * `tilt` > 0 a row plays out slower the HIGHER it is (the top row up to 2^3 =
 * eight times slower than the bottom, which is left alone), so the top of the
 * picture trails behind the bottom and only its first eighth is reached by the
 * end. `tilt` < 0 is the mirror: the low rows are the slow ones.
 *
 * Done here, to the image, so it costs no engine or protocol change: the
 * engine still crossfades between neighbouring columns, and is simply handed
 * columns in which each row has already been resampled. Linear interpolation
 * between source columns, matching what the engine does between the results.
 *
 * `tilt === 0` returns the SAME array, untouched — not a copy that happens to
 * be equal — so a project that never touches Tilt renders bit-for-bit as before.
 * Used for the pan image too: a position must stay with the magnitude it places.
 */
export function tiltImage(img, rows, frames, tilt) {
  if (!tilt || !img || rows < 1 || frames < 2) return img;
  const out = new Float32Array(img.length);
  const amt = Math.min(Math.abs(tilt), 1) * TILT_OCTAVES;
  for (let r = 0; r < rows; r++) {
    const h = rows > 1 ? r / (rows - 1) : 0;           // 0 bottom … 1 top
    const k = Math.pow(2, amt * (tilt > 0 ? h : 1 - h)); // this row's slowing
    for (let f = 0; f < frames; f++) {
      const pos = f / k;
      const c = pos | 0;
      const c1 = c + 1 < frames ? c + 1 : c;
      const a = img[c * rows + r];
      out[f * rows + r] = a + (img[c1 * rows + r] - a) * (pos - c);
    }
  }
  return out;
}

/**
 * How a picture becomes stereo positions (§8.14).
 *
 * The engine is never told which of these is in force — it receives positions in
 * [-1, +1] and nothing else. That is the same split §4.5 makes for scales, and
 * it buys the same thing: a fifth mode is a line here and no protocol change.
 *
 * Append-only. A SELECT stores an index into this list.
 */
export const PAN_MODES = Object.freeze(['Off', 'Colour', 'Spread', 'Sweep']);
export const PAN = Object.freeze({ OFF: 0, COLOUR: 1, SPREAD: 2, SWEEP: 3 });

/**
 * Build the pan image, or null for Off.
 *
 * @param {number} mode index into `PAN_MODES`
 * @param {number} rows @param {number} frames the grid, matching the magnitudes
 * @param {number} amount 0..1, how far from centre the extremes reach. This is
 *   the width control, and it lives here rather than on the wire for the reason
 *   the mode does — the engine holds positions, not a notion of how wide the
 *   image was allowed to be.
 * @param {object|null} pic `{ chroma, luma, width, height }`, needed only by
 *   Colour. Spread and Sweep are pure geometry and ignore the picture entirely,
 *   which is why they still work on a frame that has no colour in it at all.
 */
export function buildPan(mode, rows, frames, amount, pic = null) {
  if (mode === PAN.OFF || !(amount > 0) || rows < 1 || frames < 1) return null;
  const out = new Float32Array(frames * rows);

  if (mode === PAN.COLOUR) {
    if (!pic?.chroma) return null;
    // LUMA-WEIGHTED, and that is the difference between a pan image and a
    // colour histogram. A cell is mostly black with one bright red stroke
    // through it: an unweighted average pulls the position toward centre in
    // proportion to how much darkness surrounds the stroke, so the same stroke
    // moves depending on its background. Weighting by luma asks where the SOUND
    // in this cell is, which is the only question the render can act on — the
    // dark pixels contribute no magnitude either.
    const c = boxAverage(pic.chroma, pic.width, pic.height, rows, frames, pic.luma);
    for (let i = 0; i < out.length; i++) {
      const v = c[i] * amount;
      out[i] = v < -1 ? -1 : v > 1 ? 1 : v;
    }
    return out;
  }

  // Spread: pitch becomes position, lowest row left. Sweep: time becomes
  // position, the render travelling left to right across its own duration.
  const span = mode === PAN.SPREAD ? rows : frames;
  for (let f = 0; f < frames; f++) {
    for (let r = 0; r < rows; r++) {
      const i = mode === PAN.SPREAD ? r : f;
      const p = span > 1 ? (i / (span - 1)) * 2 - 1 : 0;
      out[f * rows + r] = p * amount;
    }
  }
  return out;
}

/**
 * Luminance from packed RGBA bytes, which is what both `getImageData` and
 * `gl.readPixels` produce. Rec. 709 weights, normalized to 0..1.
 */
export function lumaFromRGBA(rgba, width, height) {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) / 255;
  }
  return out;
}

/**
 * Red-to-blue balance from packed RGBA, in [-1, +1] — the pan image's raw
 * material, and precisely the information luminance throws away.
 *
 * **Blue is left and red is right, arbitrarily but permanently.** It falls out
 * of writing the difference as `R − B` rather than the other way round, and
 * there is no physical fact to appeal to. What matters is that it never changes:
 * a performer learns which way their picture moves, and a later "improvement"
 * would silently mirror every project that used it. The audit pins the sign for
 * that reason and no other.
 *
 * Green is absent rather than forgotten. Adding it would need a second axis and
 * stereo has one, so the choice is which pair opposes — and red/blue is the pair
 * the eye reads as warm against cool, which is the distinction a performer is
 * already making while they paint.
 */
export function chromaFromRGBA(rgba, width, height) {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = (rgba[p] - rgba[p + 2]) / 255;
  }
  return out;
}
