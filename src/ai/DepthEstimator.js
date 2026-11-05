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
 * @returns {Promise<{canvas: HTMLCanvasElement, ms: number, device: string}>}
 */
export async function estimateDepth(imageURL, onStatus) {
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
