/**
 * AI Depth — the source (SOURCE_DEFS 36) that shows the depth of whatever the
 * Stills Buffer is showing.
 *
 * Depth maps are kept PER SLOT (Reimagine writes one beside each image it
 * lands), and this source blends them exactly the way the buffer blends its
 * pictures: depth[fs1] → depth[fs2] by FrameBlend. So a Reimagine crossfade
 * fades the relief with the picture, and scanning the buffer by hand scans
 * the depth with it. A slot with no depth map reads as black (flat).
 *
 * ONE definition of "which slot is showing": StillsBuffer.readIndex /
 * read2Index, which its own tick has already resolved (scatter included) —
 * not a second reading of buffer.fs1 here that could disagree with it.
 *
 * A slot overwritten by anything other than Reimagine keeps its old depth
 * until forget(slot) is called; StillsBuffer.revision cannot say WHICH slot
 * changed, so stale depth is cleared by the callers that know.
 */
import * as THREE from 'three';
import { VERT, BLEND } from '../shaders/index.js';

export class AIDepth {
  constructor(renderer, width, height) {
    this.renderer = renderer;
    this._maps = new Map();          // slot → THREE.Texture
    this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    this._black.needsUpdate = true;
    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, generateMipmaps: false,
    });
    this._mat = new THREE.ShaderMaterial({
      uniforms: {
        uCurrent: { value: this._black }, uPrev: { value: this._black },
        uActive: { value: 1 }, uAmount: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: BLEND, depthTest: false, depthWrite: false,
    });
    this._scene = new THREE.Scene();
    this._scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._mat));
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  get texture() { return this.target.texture; }

  /** Has slot `i` got a depth map? */
  has(i) { return this._maps.has(i); }

  /** Store a depth map (a canvas, white = near) for slot `i`. */
  set(i, canvas) {
    this._maps.get(i)?.dispose();
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this._maps.set(i, tex);
  }

  /** Slot `i`'s depth map, or null (the Stills Buffer's depth morph). */
  map(i) { return this._maps.get(i) ?? null; }

  forget(i) { this._maps.get(i)?.dispose(); this._maps.delete(i); }

  /** Render the blended depth. Call only while something consumes source 36. */
  render(stillsBuffer, frameBlend01) {
    const u = this._mat.uniforms;
    u.uCurrent.value = this._maps.get(stillsBuffer.readIndex) ?? this._black;
    u.uPrev.value    = this._maps.get(stillsBuffer.read2Index) ?? this._black;
    u.uAmount.value  = frameBlend01;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this._scene, this._camera);
    this.renderer.setRenderTarget(prev);
  }

  resize(w, h) { this.target.setSize(w, h); }
}
