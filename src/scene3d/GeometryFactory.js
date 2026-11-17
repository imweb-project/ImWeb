/**
 * ImWeb Geometry Factory
 * All procedural geometry generators.
 * Each returns a THREE.BufferGeometry.
 */

import * as THREE from 'three';
import { ParametricGeometry } from 'three/examples/jsm/geometries/ParametricGeometry.js';
import { TeapotGeometry } from 'three/examples/jsm/geometries/TeapotGeometry.js';

/** Centre a geometry and scale it so it sits in a sphere of radius r, like the basics do. */
function fit(geo, r = 1) {
  geo.center();
  geo.computeBoundingSphere();
  const k = r / (geo.boundingSphere.radius || 1);
  geo.scale(k, k, k);
  return geo;
}

export class GeometryFactory {
  create(name, params = {}) {
    const fn = this[name.toLowerCase()];
    if (fn) return fn.call(this, params);
    console.warn(`[GeometryFactory] Unknown geometry: ${name}, falling back to Sphere`);
    return this.sphere(params);
  }

  sphere({ radius = 1, widthSeg = 128, heightSeg = 128 } = {}) {
    return new THREE.SphereGeometry(radius, widthSeg, heightSeg);
  }

  torus({ radius = 0.8, tube = 0.3, radSeg = 128, tubeSeg = 32 } = {}) {
    return new THREE.TorusGeometry(radius, tube, radSeg, tubeSeg);
  }

  cube({ size = 1.4, seg = 64 } = {}) {
    return new THREE.BoxGeometry(size, size, size, seg, seg, seg);
  }

  plane({ w = 2, h = 2, wSeg = 128, hSeg = 128 } = {}) {
    return new THREE.PlaneGeometry(w, h, wSeg, hSeg);
  }

  cylinder({ rt = 0.6, rb = 0.6, height = 1.6, seg = 64, hSeg = 64 } = {}) {
    return new THREE.CylinderGeometry(rt, rb, height, seg, hSeg);
  }

  capsule({ radius = 0.5, length = 1, cap = 32, radSeg = 64 } = {}) {
    return new THREE.CapsuleGeometry(radius, length, cap, radSeg);
  }

  torusknot({ radius = 0.7, tube = 0.2, tubeSeg = 256, radSeg = 32, p = 2, q = 3 } = {}) {
    return new THREE.TorusKnotGeometry(radius, tube, tubeSeg, radSeg, p, q);
  }

  cone({ radius = 0.8, height = 1.6, seg = 64, hSeg = 64 } = {}) {
    return new THREE.ConeGeometry(radius, height, seg, hSeg);
  }

  dodecahedron({ radius = 1, detail = 3 } = {}) {
    return new THREE.DodecahedronGeometry(radius, detail);
  }

  icosahedron({ radius = 1, detail = 5 } = {}) {
    return new THREE.IcosahedronGeometry(radius, detail);
  }

  octahedron({ radius = 1, detail = 5 } = {}) {
    return new THREE.OctahedronGeometry(radius, detail);
  }

  tetrahedron({ radius = 1, detail = 5 } = {}) {
    return new THREE.TetrahedronGeometry(radius, detail);
  }

  // ── Surfaces and curiosities (appended 2026-11) ────────────────────────────
  // All fitted to radius 1 so swapping shapes never changes the framing.

  mobius({ seg = 256, wSeg = 32 } = {}) {
    return fit(new ParametricGeometry((u, v, out) => {
      const a = u * Math.PI * 2, t = (v - 0.5) * 0.9;
      const r = 1 + t * Math.cos(a / 2);
      out.set(r * Math.cos(a), r * Math.sin(a), t * Math.sin(a / 2));
    }, seg, wSeg));
  }

  // Figure-8 immersion: the one Klein bottle that is smooth everywhere.
  klein({ seg = 192, tubeSeg = 96 } = {}) {
    return fit(new ParametricGeometry((u, v, out) => {
      const a = u * Math.PI * 2, b = v * Math.PI * 2;
      const r = 2 + Math.cos(a / 2) * Math.sin(b) - Math.sin(a / 2) * Math.sin(2 * b);
      out.set(r * Math.cos(a), r * Math.sin(a),
              Math.sin(a / 2) * Math.sin(b) + Math.cos(a / 2) * Math.sin(2 * b));
    }, seg, tubeSeg));
  }

  spring({ turns = 4, radius = 0.6, height = 1.8, tube = 0.12 } = {}) {
    class Helix extends THREE.Curve {
      getPoint(t, out = new THREE.Vector3()) {
        const a = t * turns * Math.PI * 2;
        return out.set(radius * Math.cos(a), (t - 0.5) * height, radius * Math.sin(a));
      }
    }
    return fit(new THREE.TubeGeometry(new Helix(), 480, tube, 24, false));
  }

  // Logarithmic seashell: a circle swept round an axis while it grows.
  shell({ turns = 3, growth = 0.12, seg = 320, tubeSeg = 48 } = {}) {
    return fit(new ParametricGeometry((u, v, out) => {
      const a = u * turns * Math.PI * 2, b = v * Math.PI * 2;
      const r = Math.exp(growth * a);
      out.set(r * (1 + Math.cos(b)) * Math.cos(a),
              r * Math.sin(b) - 2.2 * r,
              r * (1 + Math.cos(b)) * Math.sin(a));
    }, seg, tubeSeg));
  }

  // Gielis superformula, the same profile used for longitude and latitude.
  supershape({ m = 7, n1 = 0.2, n2 = 1.7, n3 = 1.7, seg = 192 } = {}) {
    const sf = a => Math.pow(Math.pow(Math.abs(Math.cos(m * a / 4)), n2) +
                             Math.pow(Math.abs(Math.sin(m * a / 4)), n3), -1 / n1);
    return fit(new ParametricGeometry((u, v, out) => {
      const th = (u - 0.5) * Math.PI * 2, ph = (v - 0.5) * Math.PI;
      const r1 = sf(th), r2 = sf(ph);
      out.set(r1 * Math.cos(th) * r2 * Math.cos(ph),
              r2 * Math.sin(ph),
              r1 * Math.sin(th) * r2 * Math.cos(ph));
    }, seg, seg));
  }

  // Stellated icosahedron: a spike on every face, flat-shaded.
  star({ spike = 2.1 } = {}) {
    const src = new THREE.IcosahedronGeometry(1, 0).getAttribute('position');
    const pos = [], uv = [];
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), T = new THREE.Vector3();
    const put = v => {
      pos.push(v.x, v.y, v.z);
      const n = v.clone().normalize();
      uv.push(0.5 + Math.atan2(n.z, n.x) / (Math.PI * 2), 0.5 + Math.asin(n.y) / Math.PI);
    };
    for (let i = 0; i < src.count; i += 3) {
      A.fromBufferAttribute(src, i); B.fromBufferAttribute(src, i + 1); C.fromBufferAttribute(src, i + 2);
      T.copy(A).add(B).add(C).normalize().multiplyScalar(spike);
      for (const [p, q] of [[A, B], [B, C], [C, A]]) { put(p); put(q); put(T); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    return fit(geo);
  }

  knot37({ radius = 0.7, tube = 0.12 } = {}) {
    return fit(new THREE.TorusKnotGeometry(radius, tube, 400, 24, 3, 7));
  }

  // Faceted: the Platonic entries above are subdivided until they read as
  // spheres (they exist to be displaced); this one keeps its flat faces.
  gem() {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    geo.computeVertexNormals();   // non-indexed, so this gives per-face normals
    return geo;
  }

  teapot() {
    return fit(new TeapotGeometry(0.6, 16));
  }

  // Ring (like a flat disc with a hole)
  ring({ innerR = 0.3, outerR = 1, thetaSeg = 128, phiSeg = 8 } = {}) {
    return new THREE.RingGeometry(innerR, outerR, thetaSeg, phiSeg);
  }
}

export const GEOMETRY_NAMES = [
  'Sphere', 'Torus', 'Cube', 'Plane', 'Cylinder',
  'Capsule', 'TorusKnot', 'Cone', 'Dodecahedron', 'Icosahedron',
  'Octahedron', 'Tetrahedron', 'Ring',
  // APPEND-ONLY: scene3d.geo is saved as an index into this list.
  'Mobius', 'Klein', 'Spring', 'Shell', 'Supershape', 'Star', 'Knot37', 'Gem', 'Teapot',
];
