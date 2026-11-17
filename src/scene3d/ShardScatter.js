/**
 * ShardScatter — Shatter: the 3D scene's main object comes apart into its own
 * triangles, which flow into a strange attractor and come home.
 *
 * The second consumer of the scatter step in ../ai/SplatAttractors.js (Splat
 * World's Scatter is the first): the same shapes, the same step, the same
 * settle clock. What differs is what a "thing" is and where its home comes
 * from. Here a thing is one PIECE — a triangle, or with PieceSize a patch of
 * them — which flies whole, keeping its shape, lighting and texture, and with
 * Tumble turns as it goes. Its home is where one of its corners is in
 * world space, which moves every frame with the object's transform, its
 * animation and, for a figure that keeps its skeleton, its bones.
 *
 * AT REST NOTHING OF THIS EXISTS. The twins below are built when Shatter first
 * leaves 0 and torn down when every shard is provably home (the settle clock),
 * so a scene that does not use Shatter has the scene graph, the materials and
 * the draw calls it always had.
 *
 * While shards are out:
 *   - each mesh of the object is hidden (its layer, not `visible`: hiding a
 *     node by `visible` would hide the nodes below it too, and nothing else in
 *     the app uses layers) and a TWIN is drawn in its place — the same
 *     triangles, de-indexed so no two share a vertex, wearing a clone of the
 *     scene's material compiled with USE_SHARDS (see SceneManager
 *     _setupMaterial), which adds each triangle's offset in WORLD space;
 *   - twins live beside the object, not inside it, so the code that walks the
 *     model (materials, the cloner's merge, bounds) never meets them; they
 *     follow by having the mesh's world matrix copied onto them;
 *   - a skinned mesh gets a skinned twin on the SAME skeleton (and the same
 *     morph influences), so a figure goes on moving while it is in pieces;
 *   - two passes run before the colour pass: BAKE (each triangle writes its
 *     home into its own texel) and STEP (the shared scatter step).
 *
 * Out of scope, and Shatter does nothing there: the cloner (an InstancedMesh)
 * and a Hypercube-adopted mesh. Slots 2–4 are not shattered. The depth pass
 * draws shards at home — it uses an override material that knows no offsets.
 */
import * as THREE from 'three';
import { scatterStepGLSL, SettleClock, MAX_DT } from '../ai/SplatAttractors.js';

// The form is this many times the object's own radius.
const FORM_SCALE = 1.3;
// Tumble 100 %: a piece has turned this many radians by the time it is one
// form-radius from home.
const TUMBLE_TURNS = 8.0;
// ShatterMask: the darkest piece starts this far up the Shatter control.
const MASK_SPREAD = 0.8;

// BAKE draws one tiny triangle per shard, over that shard's own texel, and
// writes where the shard's ANCHOR (its first corner) is in the world right
// now. A triangle and not a point, because a figure that keeps its skeleton
// has to be baked THROUGH the skeleton, and three skins meshes, not points.
// The three corners carry the same position and the same bones; aCorner only
// spreads them enough (in texels) to cover the one texel centre.
const BAKE_VERT = /* glsl */ `
  attribute vec2 aShard;
  attribute vec2 aCorner;
  uniform vec2 uTexel;
  varying vec3 vWorld;
  #include <skinning_pars_vertex>
  void main() {
    vec3 transformed = position;
    #include <skinbase_vertex>
    #include <skinning_vertex>
    vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
    gl_Position = vec4(aShard * 2.0 - 1.0 + aCorner * uTexel, 0.0, 1.0);
  }
`;
// Texel units, around the texel centre: contains it, and no neighbour's.
const CORNERS = [-0.4, -0.4, 0.8, -0.4, -0.4, 0.8];
const BAKE_FRAG = /* glsl */ `
  varying vec3 vWorld;
  void main() { gl_FragColor = vec4(vWorld, 1.0); }
`;
const SIM_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const SIM_FRAG = /* glsl */ `
  uniform sampler2D uHome;
  uniform sampler2D uOff;
  uniform vec3 uPivot;
  uniform float uFrame;
  uniform float uScatter;
  uniform float uFlow;
  uniform float uShape;
  uniform float uDt;
  uniform sampler2D uMask;
  uniform float uMaskOn;
  uniform mat4 uViewProj;
  varying vec2 vUv;
  ${scatterStepGLSL()}
  void main() {
    vec3 h = texture2D(uHome, vUv).xyz;
    float s = uScatter;
    if (uMaskOn > 0.5) {
      // Where this piece's home is on screen, and how bright the mask is there.
      // Bright leaves first: a piece waits (1 - brightness) of the way up the
      // Shatter control before it starts, and all are out at 100 %.
      vec4 c = uViewProj * vec4(h, 1.0);
      vec2 suv = clamp(c.xy / max(c.w, 1.0e-4) * 0.5 + 0.5, 0.0, 1.0);
      float m = dot(texture2D(uMask, suv).rgb, vec3(0.2126, 0.7152, 0.0722));
      s = clamp((uScatter - (1.0 - m) * ${MASK_SPREAD.toFixed(2)}) / ${(1 - MASK_SPREAD).toFixed(2)}, 0.0, 1.0);
    }
    vec3 off = scatterStep(h, texture2D(uOff, vUv).xyz, uPivot, uFrame,
                           s, uFlow, uShape, uDt);
    gl_FragColor = vec4(off, 1.0);
  }
`;

export class ShardScatter {
  /** @param {import('./SceneManager.js').SceneManager} sm */
  constructor(sm) {
    this.sm = sm;
    this.renderer = sm.renderer;
    this._clock = new SettleClock();
    this._root = null;      // the object the twins were built for
    this._parts = [];       // { src, twin, pts, mask }
    this._group = null;     // holds the twins, in sm.scene
    this._bakeScene = new THREE.Scene();
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._home = null;
    this._off = null;
    this._cur = 0;
    this._mat = null;       // the twins' material
    this._matBase = null;
    this._matKey = '';
    // The offsets texture, as ONE uniform object the twins' program adopts
    // (SceneManager._setupMaterial) — so it is right from the first compile.
    const zero = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    zero.needsUpdate = true;
    this._zero = zero;
    this._offUniform = { value: zero };
    // Everything a twin's program needs beyond the scene material's own:
    // offsets, homes (a tumbling piece turns about its home) and the spin.
    this._homeUniform = { value: zero };
    this._spinUniform = { value: 0 };
    this._uniforms = { uShardOff: this._offUniform, uShardHome: this._homeUniform, uShardSpin: this._spinUniform };
    this._bakeMat = new THREE.ShaderMaterial({
      uniforms: { uTexel: { value: new THREE.Vector2(1, 1) } },
      vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, side: THREE.DoubleSide,
    });
    this._simMat = new THREE.ShaderMaterial({
      uniforms: {
        uHome: { value: zero }, uOff: { value: zero },
        uPivot: { value: new THREE.Vector3() }, uFrame: { value: 1 },
        uScatter: { value: 0 }, uFlow: { value: 1 }, uShape: { value: 0 }, uDt: { value: 0 },
        uMask: { value: zero }, uMaskOn: { value: 0 }, uViewProj: { value: new THREE.Matrix4() },
      },
      vertexShader: SIM_VERT, fragmentShader: SIM_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this._simScene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._simMat);
    quad.frustumCulled = false;
    this._simScene.add(quad);
    this._v = new THREE.Vector3();
    this._box = new THREE.Box3();
  }

  /** True while any shard may be away from home (the twins exist). */
  get out() { return this._root !== null; }
  /** How many pieces are flying. */
  get count() { return this._n ?? 0; }

  /** The object Shatter can take apart right now, or null. */
  _eligible() {
    const sm = this.sm;
    const m = sm.mesh;
    if (!m || m.isInstancedMesh || sm._adoptedMesh) return null;
    return m;
  }

  /**
   * Once a frame, after the scene's params are applied and before it draws.
   * @param {number} dt seconds
   * @param {THREE.Texture|null} mask ShatterMask's picture, or null
   */
  update(params, dt, mask = null) {
    const root = this._eligible();
    const scatter = root ? (params.get('scene3d.shatter')?.value ?? 0) / 100 : 0;
    const { out } = this._clock.tick(scatter);
    // Nothing to take apart (cloner on, object replaced by nothing): whatever
    // was out is simply gone, and the clock with it.
    if (!root) this._clock.left = 0;
    if (!out || !root) { if (this._root) this._teardown(); return; }
    // The object was swapped while its shards were out (a new geometry, a new
    // model): the old twins describe something that no longer exists.
    // … or PieceSize changed: the pieces are different pieces now.
    const piece = (params.get('scene3d.shatter.piece')?.value ?? 0) / 100;
    if (this._root && (this._root !== root || this._piece !== piece || !this._sameParts(root))) this._teardown();
    if (!this._root) { this._build(root, piece); if (!this._root) { this._clock.left = 0; return; } }

    const simDt = Math.min(Math.max(dt, 0), MAX_DT);
    root.updateWorldMatrix(true, true);
    const mat = this._syncMaterial();
    for (const p of this._parts) {
      p.twin.matrixWorld.copy(p.src.matrixWorld);
      p.pts.matrixWorld.copy(p.src.matrixWorld);
      p.twin.material = mat;
    }

    const r = this.renderer;
    const prev = r.getRenderTarget();
    // BAKE: where every triangle's home is, this frame.
    r.setRenderTarget(this._home);
    r.render(this._bakeScene, this._cam);
    // STEP.
    const u = this._simMat.uniforms;
    u.uHome.value = this._home.texture;
    u.uOff.value = this._off[this._cur].texture;
    u.uDt.value = simDt;
    u.uScatter.value = scatter;
    u.uFlow.value = (params.get('scene3d.shatter.flow')?.value ?? 100) / 100;
    u.uShape.value = Math.round(params.get('scene3d.shatter.shape')?.value ?? 0);
    u.uMask.value = mask ?? this._zero;
    u.uMaskOn.value = mask ? 1 : 0;
    const cam = this.sm.camera;
    cam.updateMatrixWorld();
    u.uViewProj.value.copy(cam.matrixWorld).invert().premultiply(cam.projectionMatrix);
    // The form sits on the object and is sized by it; both follow its
    // transform from where they were measured at build.
    root.getWorldPosition(this._v);
    u.uPivot.value.copy(this._centre0).sub(this._pos0).add(this._v);
    root.getWorldScale(this._v);
    u.uFrame.value = this._frame0 * (Math.abs(this._v.x) / this._scale0 || 1);
    const next = 1 - this._cur;
    r.setRenderTarget(this._off[next]);
    r.render(this._simScene, this._cam);
    r.setRenderTarget(prev);
    this._cur = next;
    this._offUniform.value = this._off[next].texture;
    this._homeUniform.value = this._home.texture;
    // Tumble: a piece turns as it travels — radians per world unit of offset,
    // so at home (offset zero) it has not turned at all.
    this._spinUniform.value = ((params.get('scene3d.shatter.tumble')?.value ?? 0) / 100) * TUMBLE_TURNS / u.uFrame.value;
    this._clock.ran(scatter, simDt);
  }

  // The twins' material: the scene's own, in step with it every frame, plus
  // USE_SHARDS. The same recipe ModelSlots._ownMaterial uses for a slot that
  // wears its own picture.
  _syncMaterial() {
    const main = this.sm.material;
    if (!this._mat || this._matBase !== main) {
      this._mat?.dispose();
      this._mat = main.clone();
      this._mat._shardUniforms = this._uniforms;
      this.sm._setupMaterial(this._mat);
      this._matBase = main;
      this._matKey = '';
    }
    const m = this._mat;
    m.copy(main);
    // copy() resets the defines and shares nothing of the hook.
    m.defines = { ...(main.defines ?? {}), USE_SHARDS: 1 };
    const mu = main._shader?.uniforms, ou = m._shader?.uniforms;
    if (mu && ou) for (const k in mu) if (ou[k]) ou[k].value = mu[k].value;
    const key = `${main.version}|${!!m.map}|${!!m.defines.USE_TRIPLANAR}`;
    if (key !== this._matKey) { this._matKey = key; m.needsUpdate = true; }
    return m;
  }

  _meshes(root) {
    const list = [];
    root.traverse(c => { if (c.isMesh && c.geometry?.attributes?.position) list.push(c); });
    return list;
  }

  _sameParts(root) {
    const list = this._meshes(root);
    return list.length === this._parts.length
      && list.every((m, i) => this._parts[i].src === m && this._parts[i].geo === m.geometry);
  }

  /**
   * @param {number} piece 0..1 — PieceSize. 0: every triangle is its own
   *   piece. Above 0 triangles are gathered into pieces by where they are: the
   *   object is cut by a grid in world space, bent by a slow wave so the cuts
   *   are not flat planes, and every triangle in a cell shares one home and
   *   one offset — so the cell flies as one piece, like broken china.
   */
  _build(root, piece = 0) {
    const meshes = this._meshes(root);
    root.updateWorldMatrix(true, true);
    this._box.setFromObject(root);
    const diag = Math.max(this._box.getSize(this._v).length(), 1e-3);
    const cell = piece > 0 ? diag * (0.02 + 0.33 * piece) : 0;
    const wave = cell * 0.35, wk = Math.PI / Math.max(cell * 2.3, 1e-6);
    const ids = new Map();
    const c = new THREE.Vector3();
    let n = 0;
    const made = meshes.map(src => {
      const g = src.geometry.index ? src.geometry.toNonIndexed() : src.geometry.clone();
      const pos = g.attributes.position;
      const tris = Math.floor(pos.count / 3);
      const id = new Uint32Array(tris);
      for (let t = 0; t < tris; t++) {
        if (!cell) { id[t] = n++; continue; }
        const a = t * 3;
        c.set((pos.getX(a) + pos.getX(a + 1) + pos.getX(a + 2)) / 3,
              (pos.getY(a) + pos.getY(a + 1) + pos.getY(a + 2)) / 3,
              (pos.getZ(a) + pos.getZ(a + 1) + pos.getZ(a + 2)) / 3).applyMatrix4(src.matrixWorld);
        const kx = Math.floor((c.x + wave * Math.sin(c.y * wk + 1.3) + wave * Math.sin(c.z * wk * 0.7)) / cell) + 512;
        const ky = Math.floor((c.y + wave * Math.sin(c.z * wk + 2.1) + wave * Math.sin(c.x * wk * 0.7)) / cell) + 512;
        const kz = Math.floor((c.z + wave * Math.sin(c.x * wk + 0.4) + wave * Math.sin(c.y * wk * 0.7)) / cell) + 512;
        const key = (kx * 1024 + ky) * 1024 + kz;
        let v = ids.get(key);
        if (v === undefined) { v = n++; ids.set(key, v); }
        id[t] = v;
      }
      return { src, g, tris, id };
    });
    if (n === 0) return;
    const W = Math.ceil(Math.sqrt(n)), H = Math.ceil(n / W);
    const opts = {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, type: THREE.FloatType,
      generateMipmaps: false, depthBuffer: false,
    };
    this._home = new THREE.WebGLRenderTarget(W, H, opts);
    this._off = [new THREE.WebGLRenderTarget(W, H, opts), new THREE.WebGLRenderTarget(W, H, opts)];
    this._cur = 0;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const rt of [this._home, ...this._off]) { r.setRenderTarget(rt); r.clear(true, false, false); }
    r.setClearColor(prevClear, prevAlpha);
    r.setRenderTarget(prev);
    this._offUniform.value = this._off[0].texture;
    this._bakeMat.uniforms.uTexel.value.set(2 / W, 2 / H);

    this._group = new THREE.Group();
    this._group.name = 'shards';
    const mat = this._syncMaterial();
    for (const { src, g, tris, id } of made) {
      const skinned = src.isSkinnedMesh === true;
      const pos = g.attributes.position;
      const si = skinned ? g.attributes.skinIndex : null, sw = skinned ? g.attributes.skinWeight : null;
      const shard = new Float32Array(tris * 3 * 2);   // per vertex: its triangle's texel
      // The bake's geometry: three corners per shard, all AT the anchor.
      const anchor = new Float32Array(tris * 3 * 3);
      const corner = new Float32Array(tris * 3 * 2);
      const bi = si ? new si.array.constructor(tris * 3 * 4) : null;
      const bw = sw ? new Float32Array(tris * 3 * 4) : null;
      for (let t = 0; t < tris; t++) {
        const i = id[t], a = t * 3;
        const uu = ((i % W) + 0.5) / W, vv = (Math.floor(i / W) + 0.5) / H;
        for (let k = 0; k < 3; k++) {
          const v = a + k;
          shard[v * 2] = uu; shard[v * 2 + 1] = vv;
          anchor[v * 3] = pos.getX(a); anchor[v * 3 + 1] = pos.getY(a); anchor[v * 3 + 2] = pos.getZ(a);
          corner[v * 2] = CORNERS[k * 2]; corner[v * 2 + 1] = CORNERS[k * 2 + 1];
          if (bi) for (let c = 0; c < 4; c++) {
            bi[v * 4 + c] = si.getComponent(a, c);
            bw[v * 4 + c] = sw.getComponent(a, c);
          }
        }
      }
      g.setAttribute('aShard', new THREE.BufferAttribute(shard, 2));
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(anchor, 3));
      bg.setAttribute('aShard', new THREE.BufferAttribute(shard, 2));
      bg.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
      let twin, pts;
      if (skinned) {
        bg.setAttribute('skinIndex', new THREE.BufferAttribute(bi, 4));
        bg.setAttribute('skinWeight', new THREE.BufferAttribute(bw, 4));
        // The SAME skeleton: the twin and the bake move as the figure moves.
        twin = new THREE.SkinnedMesh(g, mat);
        pts = new THREE.SkinnedMesh(bg, this._bakeMat);
        for (const o of [twin, pts]) { o.bindMode = src.bindMode; o.bind(src.skeleton, src.bindMatrix); }
      } else {
        twin = new THREE.Mesh(g, mat);
        pts = new THREE.Mesh(bg, this._bakeMat);
      }
      if (src.morphTargetInfluences) {    // a face goes on making its expression
        twin.morphTargetInfluences = src.morphTargetInfluences;
        twin.morphTargetDictionary = src.morphTargetDictionary;
      }
      for (const o of [twin, pts]) {
        o.frustumCulled = false;            // offsets move it; its own bounds mean nothing
        o.matrixAutoUpdate = false;
        o.matrixWorldAutoUpdate = false;    // its world matrix is the mesh's, copied each frame
      }
      twin.renderOrder = src.renderOrder;
      this._group.add(twin);
      this._bakeScene.add(pts);
      // Hide the mesh itself, and only itself.
      const mask = src.layers.mask;
      src.layers.disable(0);
      this._parts.push({ src, geo: src.geometry, twin, pts, mask });
    }
    this.sm.scene.add(this._group);
    this._n = n;
    this._piece = piece;
    this._root = root;
    // Where the form sits and how big it is, measured from the whole object now.
    root.updateWorldMatrix(true, true);
    this._box.setFromObject(root);
    this._centre0 = this._box.getCenter(new THREE.Vector3());
    this._pos0 = root.getWorldPosition(new THREE.Vector3());
    this._scale0 = Math.abs(root.getWorldScale(new THREE.Vector3()).x) || 1;
    this._frame0 = Math.max(this._box.getSize(new THREE.Vector3()).length() / 2, 1e-3) * FORM_SCALE;
  }

  _teardown() {
    for (const p of this._parts) {
      p.src.layers.mask = p.mask;
      p.twin.geometry.dispose();
      p.pts.geometry.dispose();
      this._bakeScene.remove(p.pts);
    }
    if (this._group) this.sm.scene.remove(this._group);
    this._home?.dispose();
    this._off?.forEach(rt => rt.dispose());
    this._home = null; this._off = null;
    this._offUniform.value = this._zero;
    this._homeUniform.value = this._zero;
    this._parts = [];
    this._group = null;
    this._root = null;
    this._n = 0;
  }

  dispose() {
    this._teardown();
    this._mat?.dispose();
    this._bakeMat.dispose();
    this._simMat.dispose();
    this._zero.dispose();
  }
}
