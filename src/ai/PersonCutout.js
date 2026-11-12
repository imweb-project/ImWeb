/**
 * Snap a person — one photograph in; the person, their outline and their
 * joints out. What a photo puppet (scene3d/PhotoPuppet.js) is made from.
 *
 *   1. the cut-out model (CutoutWorker.js) says which pixels are the person;
 *   2. the picture is cropped to the box around them;
 *   3. the pose model finds the 17 body joints inside that box;
 *   4. the colour of every pixel that is NOT the person is replaced by the
 *      person's own nearby colours. It stays invisible (the outline is kept
 *      in alpha) but texture filtering at the edge then mixes in sleeve, not
 *      wall — no fringe of the room around the figure.
 *
 * Nothing leaves the browser: both models run here.
 */

const WORK_H = 1024;          // the picture is worked on at most this tall

/** COCO keypoint order, as the pose model reports them. */
export const COCO = ['nose', 'lEye', 'rEye', 'lEar', 'rEar', 'lSh', 'rSh', 'lEl', 'rEl',
  'lWr', 'rWr', 'lHip', 'rHip', 'lKn', 'rKn', 'lAn', 'rAn'];

/** The joints a puppet cannot do without, and how to name them to a person. */
const NEEDED = {
  lSh: 'left shoulder', rSh: 'right shoulder', lEl: 'left elbow', rEl: 'right elbow',
  lWr: 'left wrist', rWr: 'right wrist', lHip: 'left hip', rHip: 'right hip',
  lKn: 'left knee', rKn: 'right knee', lAn: 'left ankle', rAn: 'right ankle',
};

let _worker = null, _seq = 0, _last = null;
const _jobs = new Map();
/** { ms, device } of the last model run, for measuring. */
export const lastCutout = () => _last;

function _getWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./CutoutWorker.js', import.meta.url), { type: 'module' });
  _worker.onmessage = ({ data: m }) => {
    const job = _jobs.get(m.id);
    if (!job) return;
    if (m.type === 'status') { job.onStatus?.(m.msg); return; }
    _jobs.delete(m.id);
    if (m.type === 'error') job.reject(new Error(m.message));
    else { _last = { ms: m.ms, device: m.device }; job.resolve(m); }
  };
  _worker.onerror = (e) => {
    const err = new Error(`cut-out worker failed: ${e.message ?? e}`);
    for (const job of _jobs.values()) job.reject(err);
    _jobs.clear();
    _worker.terminate();
    _worker = null;                       // the next photograph tries afresh
  };
  return _worker;
}

function _run(job, blob, onStatus) {
  const id = ++_seq;
  return new Promise((resolve, reject) => {
    _jobs.set(id, { resolve, reject, onStatus });
    _getWorker().postMessage({ id, job, blob });
  });
}

const _blob = (cv) => new Promise(r => cv.toBlob(r, 'image/jpeg', 0.92));

/**
 * The box around the person in an alpha mask. A row or column counts once
 * 1.5% of it is person, so a stray speck of mask in a corner cannot stretch
 * the box — and with it shrink the person — the way a plain min/max would.
 * Returns { x, y, w, h } in mask pixels, or null when nobody is there.
 */
export function personBox(alpha, width, height) {
  const cols = new Uint32Array(width), rows = new Uint32Array(height);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) if (alpha[i] > 127) { cols[x]++; rows[y]++; }
  }
  const span = (a, need) => {
    let lo = 0, hi = a.length - 1;
    while (lo <= hi && a[lo] < need) lo++;
    while (hi >= lo && a[hi] < need) hi--;
    return hi >= lo ? [lo, hi] : null;
  };
  const ys = span(rows, Math.max(2, width * 0.015));
  const xs = span(cols, Math.max(2, height * 0.015));
  if (!xs || !ys) return null;
  return { x: xs[0], y: ys[0], w: xs[1] - xs[0] + 1, h: ys[1] - ys[0] + 1 };
}

/** Spread the person's own colours over everything around them (in place). */
function _fillSurround(cv) {
  const w = cv.width, h = cv.height, g = cv.getContext('2d');
  g.globalCompositeOperation = 'destination-over';
  g.imageSmoothingQuality = 'high';
  const small = document.createElement('canvas');
  const mg = small.getContext('2d');
  for (let d = 2; d <= 64; d *= 2) {
    small.width = Math.max(1, Math.round(w / d));
    small.height = Math.max(1, Math.round(h / d));
    mg.clearRect(0, 0, small.width, small.height);
    mg.drawImage(cv, 0, 0, small.width, small.height);
    // Twice: translucent edges add up towards opaque instead of staying faint.
    g.drawImage(small, 0, 0, w, h);
    g.drawImage(small, 0, 0, w, h);
  }
  small.width = small.height = 1;
  mg.drawImage(cv, 0, 0, 1, 1);
  for (let n = 0; n < 6; n++) g.drawImage(small, 0, 0, w, h);
  g.globalCompositeOperation = 'source-over';
}

/**
 * @param {ImageBitmap|HTMLCanvasElement} img  a photograph of one person, whole body
 * @param {(msg: string) => void} [onStatus]
 * @returns {Promise<{ width, height, rgba: Uint8ClampedArray, joints: Object<string, [number, number]> }>}
 *   the person's box at work size: colours with the outline in alpha, and the
 *   joints in box pixels (COCO names, plus `neck`, `pelvis` and `headTop`).
 *   Rejects, saying what to change, when the photo cannot make a puppet.
 */
export async function snapPerson(img, onStatus) {
  const k = Math.min(1, WORK_H / img.height);
  const W = Math.max(1, Math.round(img.width * k)), H = Math.max(1, Math.round(img.height * k));
  const src = document.createElement('canvas');
  src.width = W; src.height = H;
  const sg = src.getContext('2d', { willReadFrequently: true });
  sg.drawImage(img, 0, 0, W, H);

  // 1–2. Who, and where.
  const m = await _run('cutout', await _blob(src), onStatus);
  if (m.width !== W || m.height !== H) throw new Error('cut-out came back a different size');
  const box = personBox(m.alpha, W, H);
  if (!box) throw new Error('No person found in the photo.');

  // 3. Joints. The pose model wants the picture to be the person's box, at
  // its own 3 : 4 shape, so the box gets a margin and is padded to that shape
  // (grey outside the photograph) rather than stretched.
  const mx = box.w * 0.08, my = box.h * 0.05;
  let pw = box.w + 2 * mx, ph = box.h + 2 * my;
  if (pw / ph < 0.75) pw = ph * 0.75; else ph = pw / 0.75;
  const ox = box.x + box.w / 2 - pw / 2, oy = box.y + box.h / 2 - ph / 2;
  const pad = document.createElement('canvas');
  pad.width = Math.round(pw); pad.height = Math.round(ph);
  const pg = pad.getContext('2d');
  pg.fillStyle = '#808080';
  pg.fillRect(0, 0, pad.width, pad.height);
  pg.drawImage(src, -ox, -oy);
  const pose = await _run('pose', await _blob(pad), onStatus);
  const joints = {};
  pose.points.forEach(([x, y, s], i) => { joints[COCO[i]] = [x + ox - box.x, y + oy - box.y, s]; });
  const missing = Object.keys(NEEDED).filter(n => !(joints[n][2] > 0.3));
  if (missing.length) {
    throw new Error(`Could not see the ${missing.map(n => NEEDED[n]).join(', ')}. ` +
      'Stand facing the camera, whole body in the picture, arms away from the body.');
  }

  // 4. The person's box: colours spread outwards, outline in alpha.
  const out = document.createElement('canvas');
  out.width = box.w; out.height = box.h;
  const og = out.getContext('2d', { willReadFrequently: true });
  const px = sg.getImageData(box.x, box.y, box.w, box.h);
  const alpha = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const a = m.alpha[(y + box.y) * W + x + box.x];
      alpha[y * box.w + x] = a;
      // Hardened for the spreading only: the matte's soft rim still carries
      // the room's colour, which would otherwise spread as a halo.
      px.data[(y * box.w + x) * 4 + 3] = Math.max(0, Math.min(255, (a - 150) * 4));
    }
  }
  og.putImageData(px, 0, 0);
  _fillSurround(out);
  const rgba = og.getImageData(0, 0, box.w, box.h).data;
  for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i];

  // Derived joints: neck and pelvis between their pairs; the top of the head
  // is the highest outline pixel near the nose's column.
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.min(a[2], b[2])];
  joints.neck = mid(joints.lSh, joints.rSh);
  joints.pelvis = mid(joints.lHip, joints.rHip);
  const hx = Math.round(joints.nose[2] > 0.3 ? joints.nose[0] : joints.neck[0]);
  const half = Math.max(2, Math.round(Math.abs(joints.lSh[0] - joints.rSh[0]) * 0.15));
  let top = Math.round(joints.neck[1]);
  for (let x = Math.max(0, hx - half); x <= Math.min(box.w - 1, hx + half); x++) {
    for (let y = 0; y < top; y++) if (alpha[y * box.w + x] > 127) { top = y; break; }
  }
  joints.headTop = [hx, top, 1];

  return { width: box.w, height: box.h, rgba, joints };
}
