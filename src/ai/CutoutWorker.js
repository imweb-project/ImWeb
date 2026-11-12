/**
 * Person cut-out and joints, in a worker — the two models a photo puppet
 * needs (PersonCutout.js). Same shape as DepthWorker.js, and in a worker for
 * the same reason: transformers.js decodes, resizes and post-processes
 * synchronously, which on the main thread would freeze the picture.
 *
 * Protocol: in  { id, job: 'cutout' | 'pose', blob }
 *           out { id, type:'status', msg } … then
 *     cutout: { id, type:'done', width, height, alpha (Uint8, transferred), ms, device }
 *     pose:   { id, type:'done', points: [[x, y, score] × 17] (COCO order, blob px), ms, device }
 *            or { id, type:'error', message }
 *
 * Cut-out: Open RMBG (ISNet, Apache-2.0), trained on whole human figures —
 * portrait matting models are trained on head and shoulders and lose legs.
 * Joints: ViTPose base (Apache-2.0), the 17 COCO body keypoints. It expects
 * the picture to BE the person's box; PersonCutout crops it so.
 *
 * Both on the GPU when there is one: on the CPU (WASM) one cut-out took ~30 s,
 * which no visitor waits for. A photo is processed once, so a short stall of
 * the output there is the better trade.
 */
const CUTOUT_MODEL = 'onnx-community/ormbg-ONNX';
const POSE_MODEL = 'onnx-community/vitpose-base-simple';

const _loads = new Map();   // job → Promise<{ run, device }>

/** GPU first (fp16, then fp32), the CPU otherwise. */
async function _onBest(make, cpuDtype) {
  if (self.navigator?.gpu) {
    for (const dtype of ['fp16', 'fp32']) {
      try { return { run: await make('webgpu', dtype), device: `webgpu ${dtype}` }; }
      catch (err) { console.warn(`[cutout] WebGPU ${dtype} failed:`, err); }
    }
  }
  return { run: await make('wasm', cpuDtype), device: 'wasm' };
}

async function _load(job, say) {
  const tf = await import('@huggingface/transformers');
  tf.env.allowLocalModels = false;        // never probe this origin for /models/…
  if (job === 'cutout') {
    say('Loading the cut-out model (first time only)…');
    return _onBest((device, dtype) => tf.pipeline('background-removal', CUTOUT_MODEL, { device, dtype }), 'q8');
  }
  say('Loading the pose model (first time only)…');
  const processor = await tf.AutoProcessor.from_pretrained(POSE_MODEL);
  return _onBest(async (device, dtype) => {
    const model = await tf.AutoModel.from_pretrained(POSE_MODEL, { device, dtype });
    return async (img) => model(await processor(img));
  }, 'q8');
}

/**
 * Heatmaps [1, K, h, w] → one point per keypoint, in picture pixels: the
 * strongest cell, refined by a weighted mean over its 5 × 5 neighbourhood.
 * (transformers.js's own post-process averages the WHOLE map, which drags
 * every point toward the middle of the box.)
 */
function _peaks(t, W, H) {
  const [, K, h, w] = t.dims;
  const d = t.data;
  const pts = [];
  for (let k = 0; k < K; k++) {
    const o = k * h * w;
    let best = -Infinity, bi = 0;
    for (let i = 0; i < h * w; i++) if (d[o + i] > best) { best = d[o + i]; bi = i; }
    const by = Math.floor(bi / w), bx = bi % w;
    let sx = 0, sy = 0, s = 0;
    for (let y = Math.max(0, by - 2); y <= Math.min(h - 1, by + 2); y++) {
      for (let x = Math.max(0, bx - 2); x <= Math.min(w - 1, bx + 2); x++) {
        const v = Math.max(0, d[o + y * w + x]);
        sx += (x + 0.5) * v; sy += (y + 0.5) * v; s += v;
      }
    }
    const cx = s > 0 ? sx / s : bx + 0.5, cy = s > 0 ? sy / s : by + 0.5;
    pts.push([cx * W / w, cy * H / h, best]);
  }
  return pts;
}

self.onmessage = async ({ data: { id, job = 'cutout', blob } }) => {
  const say = (msg) => self.postMessage({ id, type: 'status', msg });
  try {
    if (!_loads.has(job)) {
      const p = _load(job, say);
      _loads.set(job, p);
      p.catch(() => _loads.delete(job));      // a failed load stays retryable
    }
    const { run, device } = await _loads.get(job);
    const { RawImage } = await import('@huggingface/transformers');
    const img = await RawImage.fromBlob(blob);
    const t0 = performance.now();
    if (job === 'pose') {
      say('Finding the joints…');
      const out = await run(img);
      const t = out.heatmaps ?? out.logits ?? Object.values(out)[0];
      self.postMessage({ id, type: 'done', points: _peaks(t, img.width, img.height),
        ms: performance.now() - t0, device });
      return;
    }
    say('Cutting out…');
    const out = await run(img);
    const r = Array.isArray(out) ? out[0] : out;          // RawImage, RGBA
    const n = r.width * r.height;
    const alpha = new Uint8Array(n);
    if (r.channels === 4) for (let i = 0; i < n; i++) alpha[i] = r.data[i * 4 + 3];
    else if (r.channels === 1) alpha.set(r.data.subarray(0, n));
    else throw new Error(`unexpected cut-out with ${r.channels} channels`);
    self.postMessage({ id, type: 'done', width: r.width, height: r.height, alpha,
      ms: performance.now() - t0, device }, [alpha.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message ?? err) });
  }
};
