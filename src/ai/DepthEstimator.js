/**
 * ImWeb DepthEstimator — a depth map for each Reimagine still, made in the
 * browser (Depth Anything V2 Small through transformers.js). No API, no cost.
 *
 * Loaded LAZILY: transformers.js and onnxruntime are several MB and the model
 * ~50 MB (fp16, cached by the browser after the first load), so nothing is
 * fetched until the first depth map is asked for. A project that never uses
 * Reimagine Depth pays nothing.
 *
 * WebGPU first, WASM if the adapter is missing or the WebGPU session fails —
 * the WASM path takes the int8 model, which is half the size and the only
 * dtype that is quick on a CPU.
 *
 * Output: a canvas, white = NEAR, black = far (Depth Anything predicts
 * relative inverse depth, which is already that way round), so it reads
 * straight as height for Rutt-Etra Z, 3D displacement and DisplaceSrc.
 */

const MODEL = 'onnx-community/depth-anything-v2-small';

// The model runs in DepthWorker.js: on the main thread one estimate froze the
// app for ~1.7 s. If a worker cannot be made (or fails to start), the same
// pipeline runs here as before — slower to look at, but depth still works.
let _worker = null;      // Worker | false once known to be unusable
let _seq = 0;
const _jobs = new Map(); // id → { resolve, reject, onStatus }

function _getWorker() {
  if (_worker !== null) return _worker || null;
  try {
    _worker = new Worker(new URL('./DepthWorker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = ({ data: m }) => {
      const job = _jobs.get(m.id);
      if (!job) return;
      if (m.type === 'status') { job.onStatus?.(m.msg); return; }
      _jobs.delete(m.id);
      if (m.type === 'error') { job.reject(new Error(m.message)); return; }
      _device = m.device;
      job.resolve({ canvas: _greyToCanvas(m.width, m.height, m.data), ms: m.ms, device: m.device });
    };
    _worker.onerror = (e) => {
      console.warn('[depth] worker failed, running on the main thread:', e.message ?? e);
      _worker.terminate();
      _worker = false;
      // Hand every pending job to the main-thread path rather than dropping it.
      const pending = [..._jobs.values()]; _jobs.clear();
      pending.forEach(j => _estimateHere(j.url, j.onStatus).then(j.resolve, j.reject));
    };
  } catch (err) {
    console.warn('[depth] no worker, running on the main thread:', err);
    _worker = false;
  }
  return _worker || null;
}

function _greyToCanvas(w, h, grey) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
    img.data[j] = img.data[j + 1] = img.data[j + 2] = grey[i];
    img.data[j + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}


let _pipe = null;        // Promise<pipeline> — one load shared by every caller
let _device = null;      // 'webgpu' | 'wasm' once loaded

async function _load(onStatus) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;           // never probe this origin for /models/…
  const tryDevice = async (device, dtype) => {
    onStatus?.(`Loading depth model (${device}, first time ~${dtype === 'fp16' ? 50 : 27} MB)…`);
    const p = await pipeline('depth-estimation', MODEL, { device, dtype });
    _device = device;
    return p;
  };
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try { return await tryDevice('webgpu', 'fp16'); }
    catch (err) { console.warn('[depth] WebGPU failed, falling back to WASM:', err); }
  }
  return tryDevice('wasm', 'q8');
}

export function depthDevice() { return _device; }

/**
 * @param {string} imageURL   any URL the browser can fetch, incl. data: URLs
 * @param {(msg:string)=>void} [onStatus]
 * @param {'gpu'|'cpu'} [on]  where the worker runs it (the main-thread fallback ignores it)
 * @returns {Promise<{canvas: HTMLCanvasElement, ms: number, device: string}>}
 */
export function estimateDepth(imageURL, onStatus, on = 'gpu') {
  const w = _getWorker();
  if (!w) return _estimateHere(imageURL, onStatus);
  return new Promise((resolve, reject) => {
    const id = ++_seq;
    _jobs.set(id, { resolve, reject, onStatus, url: imageURL });
    w.postMessage({ id, url: imageURL, on });
  });
}

/** The main-thread fallback (the original path). */
async function _estimateHere(imageURL, onStatus) {
  if (!_pipe) {
    _pipe = _load(onStatus);
    // A failed load must be retryable — a cached rejected promise would make
    // one network blip disable depth for the whole session.
    _pipe.catch(() => { _pipe = null; });
  }
  const pipe = await _pipe;
  const t0 = performance.now();
  const out = await pipe(imageURL);
  const canvas = out.depth.toCanvas();
  return { canvas, ms: performance.now() - t0, device: _device };
}
