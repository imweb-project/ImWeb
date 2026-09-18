import * as THREE from 'three';
import { vertexCount, MAX_DIM } from './HypercubeGeometry.js';
import { GeometryFactory } from './GeometryFactory.js';
import { TRIPLANAR_GLSL, TRI_MAP_FRAGMENT, TRI_EMISSIVEMAP_FRAGMENT } from './Triplanar.js';

const MAX_INSTANCES = 4096; // matches MAX_DIM vertex ceiling
const _geoFactory   = new GeometryFactory();

// Shared instancer geometry params — smaller than the main scene mesh
const _GEO_PARAMS = { radius: 0.5, size: 1.0, w: 1.0, h: 1.0, rt: 0.5, rb: 0.5, height: 1.0,
                      radius1: 0.5, length: 1.0, outerR: 0.5, innerR: 0.15 };

// Instance-sized tessellation, PER SHAPE (torus/knot/capsule give radSeg and
// tubeSeg different meanings, so one shared object cannot carry them). The
// scene's shapes are tessellated for vertex displacement — 128×128 spheres,
// 64³ cubes — which the instancer never does, and every instance paid for it:
// a sphere was 16,641 vertices, and 1024 of them at 10D stuttered on the
// owner's machine. Round silhouettes keep facets under ~½ px at the largest
// instance the owner uses (~400 px across); flat sides get 1 segment; the
// polyhedra keep their detail, because their facets ARE the look.
const _INST_SEG = {
  Sphere:    { widthSeg: 64, heightSeg: 32 },
  Torus:     { radSeg: 64, tubeSeg: 24 },
  Cube:      { seg: 1 },
  Plane:     { wSeg: 1, hSeg: 1 },
  Cylinder:  { seg: 64, hSeg: 1 },
  Capsule:   { cap: 12, radSeg: 48 },
  TorusKnot: { tubeSeg: 160, radSeg: 16 },
  Cone:      { seg: 64, hSeg: 1 },
  Ring:      { thetaSeg: 64, phiSeg: 2 },
};
const _instGeo = (type) => _geoFactory.create(type, { ..._GEO_PARAMS, ...(_INST_SEG[type] ?? {}) });

// Must equal SceneManager's EM_FLOOR: the instancer's texture glow matches the
// 3D scene material's, so the two are lit alike.
export const EM_FLOOR = 0.35;

// A 'Model' shape can be any size, and every instance draws all of it: the
// bundled 179k-vertex model at 12D is 733M vertices a frame, enough to hang a
// GPU. Model instances are capped at what the DEFAULT shape, the sphere,
// already costs at the full 4096 — measured from it, not a guessed constant.
let _vertBudget = 0;
const vertBudget = () => _vertBudget ||= MAX_INSTANCES *
  _instGeo('Sphere').attributes.position.count;

export class HypercubeInstancer {
  constructor(scene) {
    this._scene    = scene;
    this._mesh     = null;
    this._mat      = null;
    this._instScale = 0.08;
    this._visible  = false;
    this._opacity  = 0.8;
    this._geoType  = 'Sphere';

    this._build(this._geoType);
  }

  _build(geoType) {
    if (this._mesh) {
      this._scene.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._mesh = null;
    }

    // Use the shared GeometryFactory — same geometries as the 3D Scene section
    // 'Model' draws the 3D scene's imported model (merged, unit-sized — see
    // SceneManager._syncModelInstanceShape). A CLONE, because the old mesh's
    // geometry is disposed on every rebuild. No model loaded → a sphere.
    const geo = geoType === 'Model'
      ? (this._modelGeo ? this._modelGeo.clone() : _instGeo('Sphere'))
      : _instGeo(geoType);
    this._maxCount = geoType === 'Model' && this._modelGeo
      ? Math.max(1, Math.floor(vertBudget() / geo.attributes.position.count))
      : MAX_INSTANCES;
    this._warnedCap = null;

    if (!this._mat) {
      // Depth-writing, and transparent only below full opacity — the way the
      // 3D scene's own material works. transparent + depthWrite:false let each
      // DoubleSide instance's back faces draw over its front and instances
      // over each other in draw order; the fight concentrated where surfaces
      // are seen edge-on at eye level, a horizontal band through the centre of
      // the screen, and every instance showed its own inside (owner report
      // 2026-09-18).
      this._mat = new THREE.MeshStandardMaterial({
        side:        THREE.DoubleSide,
        transparent: this._opacity < 1,
        depthWrite:  true,
        opacity:     this._opacity,
      });
      this._setupSeamless(this._mat);
    }

    this._mesh = new THREE.InstancedMesh(geo, this._mat, MAX_INSTANCES);
    this._mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._mesh.frustumCulled = false;
    this._mesh.visible = false;
    this._scene.add(this._mesh);
  }

  /**
   * The 3D scene material's Seamless (triplanar) projection, from the SAME
   * chunks (Triplanar.js) — for the colour map AND the emissive map, or a
   * UV-mapped copy glows over the seamless one. Without it the instancer used
   * plain UVs: patches on a model's UV islands, pinched poles on spheres.
   * Object space, so every instance carries the same pattern, as the geometry
   * does; position ×2 because instance shapes are unit-sized where the scene's
   * sphere has radius 1, so the texture spans an instance as it spans the
   * geometry. On/off and sharpness come from setMapping().
   */
  _setupSeamless(mat) {
    mat.defines ??= {};
    this._triSharp ??= { value: 6 };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTriSharp = this._triSharp;
      shader.vertexShader = `varying vec3 vObjPos;\nvarying vec3 vObjNormal;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vObjPos = position * 2.0;
        vObjNormal = normal;`);
      shader.fragmentShader = `varying vec3 vObjPos;\nvarying vec3 vObjNormal;\n${TRIPLANAR_GLSL}\n${shader.fragmentShader}`
        .replace('#include <map_fragment>', TRI_MAP_FRAGMENT)
        .replace('#include <emissivemap_fragment>', TRI_EMISSIVEMAP_FRAGMENT);
    };
    mat.customProgramCacheKey = () => 'hcinst-seamless-v1' + (mat.defines.USE_TRIPLANAR ? '_tri' : '');
  }

  /** Seamless on/off (a shader define — flagged only on change) and sharpness. */
  setMapping(seamless, sharp = 6) {
    this._triSharp.value = sharp;
    const d = this._mat.defines;
    if (!!d.USE_TRIPLANAR === seamless) return;
    if (seamless) d.USE_TRIPLANAR = true; else delete d.USE_TRIPLANAR;
    this._mat.needsUpdate = true;
  }

  /**
   * Position one instance per vertex using projected coords from projBuf.
   * projBuf: Float32/64Array [x,y,z, ...] per vertex.
   * dim: active dimension. scale: world scale. instScale: per-instance size.
   */
  update(projBuf, dim, scale, instScale) {
    const count = Math.min(vertexCount(dim), MAX_INSTANCES, this._maxCount ?? MAX_INSTANCES);
    if (count < Math.min(vertexCount(dim), MAX_INSTANCES) && this._warnedCap !== count) {
      this._warnedCap = count;
      console.warn(`[Hypercube] Model has ${this._mesh.geometry.attributes.position.count} vertices — ` +
        `drawing ${count} of ${vertexCount(dim)} instances to stay within the sphere's GPU load. Use a lighter model or a lower dimension for all of them.`);
    }
    const s = instScale ?? this._instScale;

    for (let i = 0; i < count; i++) {
      const bi = i * 3;
      _dummy.position.set(
        projBuf[bi]     * scale,
        projBuf[bi + 1] * scale,
        projBuf[bi + 2] * scale,
      );
      _dummy.scale.setScalar(s);
      _dummy.updateMatrix();
      this._mesh.setMatrixAt(i, _dummy.matrix);
    }

    // count stops the draw; upload only the live range (see HypercubeFaces).
    const im = this._mesh.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(0, count * 16);
    im.needsUpdate = true;
    this._mesh.count   = count;
    this._mesh.visible = this._visible && count > 0;
  }

  setVisible(v) {
    this._visible = v;
    if (this._mesh) this._mesh.visible = v;
  }

  getMesh() { return this._mesh; }

  setInstanceScale(v) { this._instScale = v; }

  setOpacity(v) {
    this._opacity = v;
    this._mat.opacity = v;
    const t = v < 1;
    if (this._mat.transparent !== t) { this._mat.transparent = t; this._mat.needsUpdate = true; }
  }

  setGeoType(type) {
    this._geoType = type;
    this._build(type);
  }

  /** The shape 'Model' draws (or null for none). Owned here from now on. */
  setModelGeometry(geo) {
    const old = this._modelGeo;
    this._modelGeo = geo;
    if (this._geoType === 'Model') this._build('Model');
    old?.dispose();
  }

  // Called every frame. The texture is a lit colour map plus a GLOW of itself
  // at EM_FLOOR — the 3D scene material's floor (SceneManager applyParams),
  // so instances shade like the geometry. At 1.0 the glow swamped the
  // lighting and the instances read flat white. Only a CHANGED texture
  // flags the material: map/emissiveMap are shader defines.
  setTexture(tex) {
    if (this._mat.map === tex) return;
    this._mat.map           = tex;
    this._mat.emissiveMap   = tex;
    this._mat.emissive.set(1, 1, 1);
    this._mat.emissiveIntensity = EM_FLOOR;
    this._mat.needsUpdate   = true;
  }

  dispose() {
    if (!this._mesh) return;
    this._scene.remove(this._mesh);
    this._mesh.geometry.dispose();
    this._mat.dispose();
    this._mesh = null;
    this._mat  = null;
  }
}

// Module-level reusables — avoid per-frame allocation
const _dummy      = new THREE.Object3D();
const _mat4       = new THREE.Matrix4(); // eslint-disable-line no-unused-vars
