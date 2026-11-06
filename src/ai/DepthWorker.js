/**
 * Depth model in a worker — the pipeline that used to run in
 * DepthEstimator.js on the main thread, where one estimate froze the whole
 * app for ~1.7 s (measured: one 1733 ms frame between a Reimagine image
 * landing and its fade starting). transformers.js does its image decode,
 * resize and tensor post-processing synchronously in JS; here that costs
 * nothing visible.
 *
 * Protocol: in  { id, url, on: 'gpu' | 'cpu' }
 *           out { id, type:'status', msg } … then
 *               { id, type:'done', width, height, data (Uint8 grey, transferred), ms, device }
 *            or { id, type:'error', message }
 */
const MODEL = 'onnx-community/depth-anything-v2-small';

// One pipeline per device, loaded on first use. 'cpu' never touches the GPU:
// on the GPU an estimate stalls the picture ~1–1.5 s (the model and WebGL
// share the chip); on the CPU it takes ~10 s single-threaded but frames
// stay at 60 (measured on the owner's Mac, headless).
const _pipes = new Map();   // 'gpu' | 'cpu' → Promise<{ pipe, device }>

async function _load(want, say) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;           // never probe this origin for /models/…
  const tryDevice = async (device, dtype) => {
    say(`Loading depth model (${device}, first time ~${dtype === 'fp16' ? 50 : 27} MB)…`);
    return { pipe: await pipeline('depth-estimation', MODEL, { device, dtype }), device };
  };
  if (want === 'gpu' && self.navigator?.gpu) {
    try { return await tryDevice('webgpu', 'fp16'); }
    catch (err) { console.warn('[depth] WebGPU failed in the worker, falling back to WASM:', err); }
  }
  return tryDevice('wasm', 'q8');
}

self.onmessage = async ({ data: { id, url, on = 'gpu' } }) => {
  const say = (msg) => self.postMessage({ id, type: 'status', msg });
  try {
    if (!_pipes.has(on)) {
      const p = _load(on, say);
      _pipes.set(on, p);
      p.catch(() => _pipes.delete(on));      // a failed load stays retryable
    }
    const { pipe, device } = await _pipes.get(on);
    const t0 = performance.now();
    const out = await pipe(url);
    const d = out.depth;                     // RawImage, 1 channel
    let grey = d.data;
    if (d.channels !== 1) {                  // never expected; keep it honest
      grey = new Uint8Array(d.width * d.height);
      for (let i = 0; i < grey.length; i++) grey[i] = d.data[i * d.channels];
    }
    const buf = new Uint8Array(grey);        // own buffer, safe to transfer
    self.postMessage({ id, type: 'done', width: d.width, height: d.height, data: buf,
      ms: performance.now() - t0, device }, [buf.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message ?? err) });
  }
};
