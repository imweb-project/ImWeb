/**
 * Splat World — source 37: the Stills Buffer image on show, as a 3D world of
 * soft points pushed out by its own AI Depth map, seen by a slowly drifting
 * camera.
 *
 * Every point is one pixel of the picture, UNPROJECTED through a pinhole
 * camera: from the rest position the points reproject exactly onto the image,
 * and any drift away from it shows parallax. Depth Anything gives relative
 * INVERSE depth (white = near), so distance is 1 / mix(1/far, 1/near, d).
 * Holes open behind near things as the camera swings — the honest cost of a
 * world made from one view.
 *
 * Fades are per point, in step with the 2D Morph (DEPTH_MORPH): each point
 * moves from its place in world A to its place in world B, colour with it,
 * delayed by depth (near first) by reimagine.morph. Morph 0 moves every point
 * together. ONE definition of "which slots are showing": StillsBuffer's own
 * resolved readIndex / read2Index, as AI Depth uses.
 *
 * Rendered only while something consumes source 37 (_srcUsed in main.js).
 */
import * as THREE from 'three';

const DENSITY_ROWS = [180, 288, 432];   // splat.density Low / Mid / High
const FOV = 50;                         // degrees, vertical
const NEAR_D = 1.0;                     // distance of the nearest point
const MAX_FAR = 6.0;                    // far distance at Relief 100 %

const VERT = /* glsl */ `
  uniform sampler2D uColA;
  uniform sampler2D uColB;
  uniform sampler2D uDepA;
  uniform sampler2D uDepB;
  uniform float uT;          // fade 0..1 (FrameBlend)
  uniform float uMorph;      // 0..1
  uniform float uFar;
  uniform float uTanHalf;    // tan(fov/2)
  uniform float uAspect;
  uniform float uFoot;       // world footprint per unit distance
  uniform float uPxPerUnit;  // target height px / (2 tan(fov/2))
  uniform float uSize;
  attribute vec2 aUv;
  varying vec3 vCol;

  vec3 unproject(vec2 uv, float d) {
    float dist = 1.0 / mix(1.0 / uFar, 1.0 / ${NEAR_D.toFixed(1)}, clamp(d, 0.0, 1.0));
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3(ndc.x * uTanHalf * uAspect * dist, ndc.y * uTanHalf * dist, -dist);
  }

  void main() {
    float dA = texture2D(uDepA, aUv).r;
    float dB = texture2D(uDepB, aUv).r;
    float spread = 0.7 * uMorph;
    float delay = (1.0 - max(dA, dB)) * spread;
    float k = clamp((uT - delay) / (1.0 - spread), 0.0, 1.0);
    k = mix(k, smoothstep(0.0, 1.0, k), uMorph);
    vec3 p = mix(unproject(aUv, dA), unproject(aUv, dB), k);
    vCol = mix(texture2D(uColA, aUv).rgb, texture2D(uColB, aUv).rgb, k);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // A point covers its own pixel's footprint at ITS distance, seen from
    // where the camera now is — so the world stays closed at rest.
    float foot = -p.z * uFoot * uSize;
    gl_PointSize = clamp(foot * uPxPerUnit / max(-mv.z, 0.05), 1.0, 64.0);
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vCol;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    // A little darker at the rim: reads as a soft splat, not a flat disc.
    gl_FragColor = vec4(vCol * (1.0 - 0.25 * r2), 1.0);
  }
`;

export class SplatWorld {
  constructor(renderer, width, height) {
    this.renderer = renderer;
    this.width = width; this.height = height;
    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      generateMipmaps: false, depthBuffer: true,
    });
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    black.needsUpdate = true;
    this._black = black;
    this._mat = new THREE.ShaderMaterial({
      uniforms: {
        uColA: { value: black }, uColB: { value: black },
        uDepA: { value: black }, uDepB: { value: black },
        uT: { value: 0 }, uMorph: { value: 0 }, uFar: { value: 3 },
        uTanHalf: { value: Math.tan(THREE.MathUtils.degToRad(FOV / 2)) },
        uAspect: { value: width / height }, uFoot: { value: 0 },
        uPxPerUnit: { value: 1 }, uSize: { value: 1 },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      depthTest: true, depthWrite: true,
    });
    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(FOV, width / height, 0.05, 50);
    this._points = null;
    this._grid = null;   // "rows x cols" the geometry was built for
    this._t = 0;
  }

  get texture() { return this.target.texture; }

  _ensureGrid(rows) {
    const cols = Math.max(2, Math.round(rows * this.width / this.height));
    const key = `${rows}x${cols}`;
    if (key === this._grid) return;
    if (this._points) { this._scene.remove(this._points); this._points.geometry.dispose(); }
    const n = rows * cols;
    const uv = new Float32Array(n * 2);
    for (let j = 0, i = 0; j < rows; j++) {
      for (let c = 0; c < cols; c++, i++) {
        // Texel centres, as the warp map is authored (CLAUDE.md, Phase 24).
        uv[i * 2] = (c + 0.5) / cols;
        uv[i * 2 + 1] = (j + 0.5) / rows;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    // Position is computed in the shader; three still wants an attribute
    // named position for its draw-count and bounds.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this._points = new THREE.Points(g, this._mat);
    this._points.frustumCulled = false;
    this._scene.add(this._points);
    this._grid = key;
    this._rows = rows;
  }

  /**
   * @param {import('../inputs/StillsBuffer.js').StillsBuffer} sb
   * @param {import('./AIDepth.js').AIDepth} depth
   */
  render(ps, sb, depth, dt) {
    const rows = DENSITY_ROWS[Math.round(ps.get('splat.density').value)] ?? DENSITY_ROWS[1];
    this._ensureGrid(rows);
    const a = sb.readIndex, b = sb.read2Index;
    const fb = ps.get('buffer.frameblend').value / 100;
    const u = this._mat.uniforms;
    const colA = sb._hasFrame[a] ? sb.frames[a].texture : null;
    const colB = sb._hasFrame[b] ? sb.frames[b].texture : null;
    // Not fading (or nothing to fade to): show world A whole.
    const fading = fb > 0 && colB;
    u.uColA.value = colA ?? this._black;
    u.uColB.value = fading ? colB : u.uColA.value;
    u.uDepA.value = depth.map(a) ?? this._black;
    u.uDepB.value = fading ? (depth.map(b) ?? this._black) : u.uDepA.value;
    u.uT.value = fading ? fb : 0;
    u.uMorph.value = ps.get('reimagine.morph').value / 100;
    const relief = ps.get('splat.relief').value / 100;
    u.uFar.value = NEAR_D + 0.001 + relief * (MAX_FAR - NEAR_D);
    u.uAspect.value = this.width / this.height;
    u.uFoot.value = 1.6 * 2 * u.uTanHalf.value / this._rows;
    u.uPxPerUnit.value = this.height / (2 * u.uTanHalf.value);
    u.uSize.value = ps.get('splat.size').value / 100;

    // Camera: it orbits a PIVOT in the middle of the world, so the parallax is
    // around the subject rather than the lens. Orbit/Tilt are the owner's
    // angle, Sway the automatic swing on top. Distance from the pivot: rest is
    // pivotD (camera at the lens, picture exact); Dolly moves in up to the
    // pivot, Fly travels on in and back out through the world. The camera's
    // ORIENTATION comes from the angles alone, never lookAt(pivot) — lookAt
    // flips the view the moment the camera passes through the pivot.
    this._t += dt * ps.get('splat.speed').value;
    const ph = this._t * Math.PI * 2;
    const D2R = Math.PI / 180;
    const sway = ps.get('splat.sway').value * D2R;
    const yaw = ps.get('splat.orbit').value * D2R + sway * Math.sin(ph);
    const pitch = ps.get('splat.tilt').value * D2R + sway * 0.4 * Math.sin(ph * 0.63 + 1.1);
    const pivotD = 1 / ((1 / u.uFar.value + 1 / NEAR_D) / 2);
    const dolly = ps.get('splat.dolly').value / 100;
    const fly = ps.get('splat.fly').value / 100;
    const r = pivotD * (1 - dolly)
      - fly * 0.9 * u.uFar.value * (0.5 - 0.5 * Math.cos(ph * 0.5));
    const cam = this._camera;
    cam.aspect = this.width / this.height;
    cam.updateProjectionMatrix();
    cam.position.set(
      r * Math.sin(yaw) * Math.cos(pitch),
      r * Math.sin(pitch),
      -pivotD + r * Math.cos(yaw) * Math.cos(pitch),
    );
    cam.rotation.set(-pitch, yaw, 0, 'YXZ');

    const prev = this.renderer.getRenderTarget();
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, true, false);
    this.renderer.render(this._scene, cam);
    this.renderer.setClearColor(prevClear, prevAlpha);
    this.renderer.setRenderTarget(prev);
  }

  resize(w, h) {
    this.width = w; this.height = h;
    this.target.setSize(w, h);
    this._grid = null;   // the grid follows the aspect
  }
}
