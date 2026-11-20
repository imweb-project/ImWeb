/**
 * Photo puppet — a photograph of a person, cut out, jointed and given body,
 * performing a figure's movements.
 *
 * The person (ai/PersonCutout.snapPerson) becomes a grid laid over the
 * photograph, each grid point bound to the one or two nearest body parts
 * (torso, head, upper and lower arms and legs) found by the pose model. Bound
 * to a model slot, it takes the place of that slot's figure: the figure still
 * plays its clip — every animation tool applies unchanged — but only its
 * SKELETON is used.
 *
 * In 3D, per part, each frame:
 *   - where: the part keeps the photographed person's own LENGTH and takes the
 *     DIRECTION of the figure's matching bone. A short-legged visitor driven by
 *     a long-legged figure stays themselves; their elbow lands where their own
 *     arm puts it, not on the figure's elbow.
 *   - which way it faces: the part turns by however far the figure's bone has
 *     turned since rest (the torso by the frame of its shoulders and hips). So
 *     when the figure turns, the body really turns away — with perspective —
 *     instead of shrinking on a card.
 *
 * Body: the photo is not flat. Each point is raised off the picture plane by
 * how far it lies inside the outline (from one grid cell in, so front and
 * back meet exactly at the edge), on a round profile sized per part —
 * arms and legs come out round, the torso flatter, as bodies are. A second
 * surface behind closes the shape at the outline (front and back meet where
 * the thickness is zero). The back wears the front's colours, blurred, with
 * the face painted over in the hair's colour — Photo Wake-Up's approach (Weng
 * et al., CVPR 2019), which also warps a template body's normals rather than
 * inflating the outline; this is the simpler of the two, and the template
 * version is the next step if the body reads as a balloon.
 *
 * Skinning runs here on the CPU (a few thousand points), not through three's
 * SkinnedMesh — ImWeb flattens skinned meshes for an ANGLE/Metal bug
 * (SceneManager._prepareGLTFScene), and this needs no bone texture.
 */

import * as THREE from 'three';

// The puppet's skeleton: joints in the order they are placed, each from its
// parent. Names follow PersonCutout (COCO plus neck, pelvis, headTop).
const EDGES = [
  ['pelvis', 'neck'], ['neck', 'headTop'],
  ['neck', 'lSh'], ['lSh', 'lEl'], ['lEl', 'lWr'],
  ['neck', 'rSh'], ['rSh', 'rEl'], ['rEl', 'rWr'],
  ['pelvis', 'lHip'], ['lHip', 'lKn'], ['lKn', 'lAn'],
  ['pelvis', 'rHip'], ['rHip', 'rKn'], ['rKn', 'rAn'],
];
// The parts the picture is bound to: the edge each spans, the figure bone
// that turns it (null: the torso, turned by its shoulders and hips), and how
// round it is — depth as a share of its half-width in the photo.
const SEGS = [
  { e: 0,  bone: null,  round: 0.35 },   // torso
  { e: 1,  bone: 'head', round: 1.0 },   // head
  { e: 3,  bone: 'lSh', round: 0.9 },    // left upper arm
  { e: 4,  bone: 'lEl', round: 0.9 },    // left forearm + hand
  { e: 6,  bone: 'rSh', round: 0.9 },    // right upper arm
  { e: 7,  bone: 'rEl', round: 0.9 },    // right forearm + hand
  { e: 9,  bone: 'lHip', round: 0.85 },  // left thigh
  { e: 10, bone: 'lKn', round: 0.85 },   // left shin + foot
  { e: 12, bone: 'rHip', round: 0.85 },  // right thigh
  { e: 13, bone: 'rKn', round: 0.85 },   // right shin + foot
];
const GRID = 110;            // grid cells along the person's height
const LIMB_JOINTS = ['lSh', 'lEl', 'lWr', 'lHip', 'lKn', 'lAn', 'rSh', 'rEl', 'rWr', 'rHip', 'rKn', 'rAn'];

// ── Finding the figure's joints ─────────────────────────────────────────────

/**
 * Bone names, normalised (lower case, letters and digits only, rig prefixes
 * such as `mixamorig`, `Bip01`, `Figure_1` removed), per joint and in order of
 * preference. Covers Poser (Left_Shoulder…), 3ds Max Biped (L_UpperArm…),
 * Mixamo (LeftArm…), and Poser as three's ColladaLoader names them
 * (Figure_1lShldr_1_node → lshldr). Mixamo's `LeftShoulder` is its CLAVICLE,
 * so `leftarm` must be tried before `leftshoulder`, which is Poser's upper arm.
 */
function boneNames(side) {
  const S = side === 'l' ? 'left' : 'right', s = side;
  return {
    Sh:  [`${S}arm`, `${s}upperarm`, `${S}upperarm`, `${s}shldr`, `${S}shoulder`],
    El:  [`${S}forearm`, `${s}forearm`, `${S}lowerarm`, `${s}lowerarm`],
    Wr:  [`${S}hand`, `${s}hand`],
    Hip: [`${S}upleg`, `${S}thigh`, `${s}thigh`, `${S}upperleg`],
    Kn:  [`${S}leg`, `${S}shin`, `${s}shin`, `${S}calf`, `${s}calf`, `${S}lowerleg`],
    An:  [`${S}foot`, `${s}foot`],
  };
}
const norm = (n) => (n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  .replace(/^(mixamorig\d*|bip\d+|figure\d+)/, '')
  .replace(/\d*node$/, '');          // ColladaLoader: Figure_1lShldr_1_node

/** The figure's bones for the puppet's joints, or throws naming what is missing. */
function findBones(model) {
  const byName = new Map();
  model.traverse(o => {
    const k = norm(o.name);
    if (!k) return;
    const had = byName.get(k);
    if (!had || (o.isBone && !had.isBone)) byName.set(k, o);
  });
  const pick = (list) => { for (const n of list) if (byName.has(n)) return byName.get(n); return null; };
  const out = { head: pick(['head']) };
  for (const side of ['l', 'r']) {
    const names = boneNames(side);
    for (const j in names) out[side + j] = pick(names[j]);
  }
  const missing = Object.keys(out).filter(k => !out[k]);
  if (missing.length) throw new Error(`This figure has no skeleton I recognise (missing: ${missing.join(', ')}).`);
  return out;
}

/**
 * The body's own frame from its joints: across (towards its left), up (pelvis
 * to neck), front (across × up). Written into `q`.
 */
function bodyFrame(J, q) {
  _up.copy(J.neck).sub(J.pelvis).normalize();
  _ac.copy(J.lSh).sub(J.rSh).add(_v.copy(J.lHip).sub(J.rHip));
  _ac.addScaledVector(_up, -_ac.dot(_up)).normalize();
  _fw.crossVectors(_ac, _up);
  return q.setFromRotationMatrix(_m.makeBasis(_ac, _up, _fw));
}

// ── The puppet ──────────────────────────────────────────────────────────────

export class PhotoPuppet {
  /** @param snap  what PersonCutout.snapPerson returned */
  constructor(snap) {
    const { width: w, height: h, rgba, joints } = snap;
    this.size = { w, h };
    // Photo coordinates turned y-UP, so they turn the same way as the scene's.
    this.rest = {};
    for (const k in joints) this.rest[k] = new THREE.Vector2(joints[k][0], -joints[k][1]);
    this._restFrames = EDGES.map(([a, b]) => {
      const A = this.rest[a], B = this.rest[b];
      const len = Math.max(1e-6, A.distanceTo(B));
      const d = B.clone().sub(A).divideScalar(len);
      return { A, len, d, n: new THREE.Vector2(-d.y, d.x) };
    });

    const front = this._texture(rgba, w, h);
    const back = this._texture(this._inventBack(rgba, w, h, joints), w, h);
    // Lit, but mostly by itself: the photograph already carries its light,
    // and lit only by the scene it went dark and bronze. The share that IS
    // lit is what shows the body's roundness.
    const mat = (map) => new THREE.MeshLambertMaterial({
      map, color: 0x4a4a4a, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.78,
      alphaTest: 0.5, side: THREE.DoubleSide,
    });
    this.materials = [mat(front), mat(back)];

    this._buildGrid(rgba);
    this.mesh = null;
    this._pivot = null;
  }

  _texture(rgba, w, h) {
    const tex = new THREE.DataTexture(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * A back nobody photographed: the front's colours, blurred until buttons
   * and lettering are gone (seen from behind they also land mirrored, which
   * is where a shirt's back panel is), the face covered in the colour of the
   * top of the head. Same outline as the front.
   */
  _inventBack(rgba, w, h, J) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const opaque = new Uint8ClampedArray(rgba);
    for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
    g.putImageData(new ImageData(opaque, w, h), 0, 0);
    const small = document.createElement('canvas');
    small.height = 48; small.width = Math.max(1, Math.round(48 * w / h));
    small.getContext('2d').drawImage(cv, 0, 0, small.width, small.height);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, 0, 0, w, h);

    const top = J.headTop, neck = J.neck;
    const hh = Math.max(4, neck[1] - top[1]);           // head + neck height, px
    const px = g.getImageData(Math.max(0, Math.round(top[0] - hh * 0.1)), Math.round(top[1] + hh * 0.04),
      Math.max(1, Math.round(hh * 0.2)), Math.max(1, Math.round(hh * 0.08))).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++; }
    if (n) {
      const rgb = `${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)}`;
      g.save();
      g.translate(top[0], top[1] + hh * 0.42);
      g.scale(hh * 0.42, hh * 0.5);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      grad.addColorStop(0, `rgba(${rgb},1)`);
      grad.addColorStop(0.75, `rgba(${rgb},1)`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grad;
      g.beginPath(); g.arc(0, 0, 1, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    const out = g.getImageData(0, 0, w, h).data;
    for (let i = 3; i < out.length; i += 4) out[i] = rgba[i];
    return out;
  }

  /** The grid over the person, bound to the parts, raised into a body. */
  _buildGrid(rgba) {
    const { w, h } = this.size;
    const cell = h / GRID;
    const cols = Math.ceil(w / cell), rows = GRID;
    // A cell is kept when any of its pixels is the person, plus one cell round.
    const on = new Uint8Array(cols * rows);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x0 = Math.floor(cx * cell), x1 = Math.min(w, Math.ceil((cx + 1) * cell));
        const y0 = Math.floor(cy * cell), y1 = Math.min(h, Math.ceil((cy + 1) * cell));
        let hit = 0;
        for (let y = y0; y < y1 && !hit; y += 2) for (let x = x0; x < x1; x += 2) if (rgba[(y * w + x) * 4 + 3] > 64) { hit = 1; break; }
        on[cy * cols + cx] = hit;
      }
    }
    const keep = new Uint8Array(cols * rows);
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
      if (!on[cy * cols + cx]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < cols && y < rows) keep[y * cols + x] = 1;
      }
    }

    // Vertices: the corners of kept cells, numbered as they are first used.
    const vid = new Int32Array((cols + 1) * (rows + 1)).fill(-1);
    const px = [], front = [];
    const vert = (gx, gy) => {
      const k = gy * (cols + 1) + gx;
      if (vid[k] < 0) { vid[k] = px.length / 2; px.push(Math.min(w, gx * cell), Math.min(h, gy * cell)); }
      return vid[k];
    };
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
      if (!keep[cy * cols + cx]) continue;
      const a = vert(cx, cy), b = vert(cx + 1, cy), c = vert(cx + 1, cy + 1), d = vert(cx, cy + 1);
      front.push(a, d, b, b, d, c);
    }
    const n = px.length / 2;

    // Binding: each point to its two nearest parts. Distance is measured to
    // the part's line, less its half-width — the torso is wide, and without
    // that its own sides would go to the arms and legs.
    const R = this.rest;
    const shoulderW = R.lSh.distanceTo(R.rSh);
    const radius = SEGS.map((s, k) => k === 0 ? 0.35 * shoulderW : 0);
    const eps = 0.015 * h;
    this._skin = { seg: new Uint8Array(n * 2), w0: new Float32Array(n), uv: new Float32Array(n * 4), z: new Float32Array(n) };
    const uvs = new Float32Array(n * 4);
    const p = new THREE.Vector2(), q = new THREE.Vector2();
    const dist = new Float32Array(SEGS.length);
    for (let i = 0; i < n; i++) {
      p.set(px[i * 2], -px[i * 2 + 1]);
      // DataTexture row 0 is the photo's top. Back points (n…2n) share them.
      uvs[i * 2] = uvs[(n + i) * 2] = px[i * 2] / w;
      uvs[i * 2 + 1] = uvs[(n + i) * 2 + 1] = px[i * 2 + 1] / h;
      for (let k = 0; k < SEGS.length; k++) {
        const f = this._restFrames[SEGS[k].e];
        const t = Math.max(0, Math.min(f.len, q.copy(p).sub(f.A).dot(f.d)));
        dist[k] = Math.max(0, p.distanceTo(q.copy(f.A).addScaledVector(f.d, t)) - radius[k]);
      }
      let k0 = 0, k1 = 1;
      if (dist[k1] < dist[k0]) [k0, k1] = [k1, k0];
      for (let k = 2; k < SEGS.length; k++) {
        if (dist[k] < dist[k0]) { k1 = k0; k0 = k; } else if (dist[k] < dist[k1]) k1 = k;
      }
      const a0 = 1 / Math.pow(dist[k0] + eps, 4), a1 = 1 / Math.pow(dist[k1] + eps, 4);
      this._skin.seg[i * 2] = k0; this._skin.seg[i * 2 + 1] = k1;
      this._skin.w0[i] = a0 / (a0 + a1);
      for (const [slot, k] of [[0, k0], [1, k1]]) {
        const f = this._restFrames[SEGS[k].e];
        q.copy(p).sub(f.A);
        this._skin.uv[i * 4 + slot * 2] = q.dot(f.d);
        this._skin.uv[i * 4 + slot * 2 + 1] = q.dot(f.n);
      }
    }
    this._inflate(rgba, px, n);

    const index = front.slice();
    for (let t = 0; t < front.length; t += 3) index.push(front[t] + n, front[t + 2] + n, front[t + 1] + n);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(2 * n > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
    this.geometry.addGroup(0, front.length, 0);
    this.geometry.addGroup(front.length, front.length, 1);
    this._n = n;
  }

  /**
   * Thickness per point, in photo pixels: a round profile over the distance
   * to the outline, √(2Rδ − δ²) — a circle of radius R seen side-on — where R
   * is the part's half-width (the 90th percentile of its points' distance) and
   * the result is scaled by how round that part is. Blended between a point's
   * two parts by the same weight as its movement, so there is no step at a
   * shoulder or a hip.
   */
  _inflate(rgba, px, n) {
    const { w, h } = this.size;
    const D = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) D[i] = rgba[i * 4 + 3] > 127 ? 1e9 : 0;
    const S2 = Math.SQRT2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!D[i]) continue;
      let d = D[i];
      if (x > 0) d = Math.min(d, D[i - 1] + 1); else d = Math.min(d, 1);
      if (y > 0) {
        d = Math.min(d, D[i - w] + 1);
        if (x > 0) d = Math.min(d, D[i - w - 1] + S2);
        if (x < w - 1) d = Math.min(d, D[i - w + 1] + S2);
      } else d = Math.min(d, 1);
      D[i] = d;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!D[i]) continue;
      let d = D[i];
      if (x < w - 1) d = Math.min(d, D[i + 1] + 1); else d = Math.min(d, 1);
      if (y < h - 1) {
        d = Math.min(d, D[i + w] + 1);
        if (x < w - 1) d = Math.min(d, D[i + w + 1] + S2);
        if (x > 0) d = Math.min(d, D[i + w - 1] + S2);
      } else d = Math.min(d, 1);
      D[i] = d;
    }
    // The profile starts a little more than one grid cell INSIDE the outline.
    // A circle's side is vertical at its edge: measured from the outline
    // itself, the points one cell in were already well off the picture
    // plane, front and back were apart where the cut-out's edge falls inside
    // that cell, and every limb seen at an angle showed a dashed slit. Held at
    // zero across the edge cell, the two surfaces meet at the edge.
    const inset = 1.2 * h / GRID;
    const delta = new Float32Array(n);
    const per = SEGS.map(() => []);
    for (let i = 0; i < n; i++) {
      const x = Math.min(w - 1, Math.round(px[i * 2])), y = Math.min(h - 1, Math.round(px[i * 2 + 1]));
      delta[i] = Math.max(0, D[y * w + x] - inset);
      per[this._skin.seg[i * 2]].push(delta[i]);
    }
    const Rk = per.map(a => {
      if (!a.length) return 1;
      a.sort((x, y) => x - y);
      return Math.max(1, a[Math.floor(a.length * 0.9)]);
    });
    const prof = (k, d) => { const r = Rk[k], c = Math.min(d, r); return Math.sqrt(Math.max(0, 2 * r * c - c * c)) * SEGS[k].round; };
    const { seg, w0, z } = this._skin;
    for (let i = 0; i < n; i++) {
      z[i] = w0[i] * prof(seg[i * 2], delta[i]) + (1 - w0[i]) * prof(seg[i * 2 + 1], delta[i]);
    }
  }

  /**
   * Take the place of the figure in `pivot` (a model slot's pivot). Throws when
   * the figure has no skeleton the puppet can follow; the figure is then left
   * as it was.
   */
  bind(pivot) {
    this.unbind();
    const model = pivot.userData.model;
    if (!model) throw new Error('No figure in this slot.');
    const bones = findBones(model);
    const rest = pivot.userData.boneRest, restQ = pivot.userData.boneRestQ;
    if (!rest || !restQ) throw new Error('Import the figure again — it was loaded before photo puppets existed.');
    const J = {};
    for (const k of LIMB_JOINTS) {
      if (!rest.get(bones[k])) throw new Error('This figure has no rest pose to measure.');
      J[k] = rest.get(bones[k]).clone();
    }
    J.neck = J.lSh.clone().add(J.rSh).multiplyScalar(0.5);
    J.pelvis = J.lHip.clone().add(J.rHip).multiplyScalar(0.5);
    const headRest = rest.get(bones.head);
    if (!headRest) throw new Error('This figure has no rest pose to measure.');

    // The figure's own frame at rest — and the photo, a front view, is laid
    // into it: photo right (the person's left) → across, up → up, towards the
    // camera → the figure's front.
    this._restFrame = bodyFrame(J, new THREE.Quaternion());
    this._restHeadDir = headRest.clone().sub(J.neck).normalize();
    // Scale: the puppet stands as tall, neck to ankles, as the figure.
    const ankles = J.lAn.clone().add(J.rAn).multiplyScalar(0.5);
    const R = this.rest;
    const photoNeckToAnkle = R.neck.distanceTo(new THREE.Vector2().addVectors(R.lAn, R.rAn).multiplyScalar(0.5));
    this._sigma = J.neck.distanceTo(ankles) / Math.max(1e-6, photoNeckToAnkle);

    // Per part: the turn from the photo's direction to the figure's at rest,
    // and the bone (or body frame) whose turn since rest moves it on.
    const toFig = this._restFrame;
    this._parts = SEGS.map(s => {
      const [a, b] = EDGES[s.e];
      const pd = this._restFrames[s.e].d;
      const p3 = new THREE.Vector3(pd.x, pd.y, 0).applyQuaternion(toFig);
      const r3 = b === 'headTop' ? this._restHeadDir.clone() : J[b].clone().sub(J[a]).normalize();
      const align = new THREE.Quaternion().setFromUnitVectors(p3, r3).multiply(toFig);
      const bone = s.bone ? bones[s.bone] : null;
      return { align, bone, restInv: bone ? restQ.get(bone)?.clone().invert() ?? null : null };
    });
    if (this._parts.some(p => p.bone && !p.restInv)) throw new Error('This figure has no rest pose to measure.');

    this._bones = bones;
    this._prevDir = EDGES.map(() => new THREE.Vector3(0, 1, 0));
    this.mesh = new THREE.Mesh(this.geometry, this.materials);
    this.mesh.userData.puppet = true;
    this.mesh.frustumCulled = false;   // its points move every frame
    this._hidden = [];
    model.traverse(o => { if (o.isMesh && o.visible) { o.visible = false; this._hidden.push(o); } });
    pivot.add(this.mesh);
    this._pivot = pivot;
    this.update();
  }

  /** Give the slot back its figure. Safe to call when not bound. */
  unbind() {
    if (!this._pivot) return;
    this._pivot.remove(this.mesh);
    this._hidden.forEach(o => { o.visible = true; });
    this._hidden = [];
    this._pivot = null;
    this.mesh = null;
  }

  get boundTo() { return this._pivot; }

  /** Follow the figure. Call after the slot's mixer and anchor have run. */
  update() {
    const pivot = this._pivot;
    if (!pivot) return;
    pivot.updateMatrixWorld(true);
    const inv = _inv.copy(pivot.matrixWorld).invert();
    const B = this._bones;
    // The figure's joints and turns, in the pivot's space.
    const D = _drv;
    for (const k of LIMB_JOINTS) D[k].setFromMatrixPosition(B[k].matrixWorld).applyMatrix4(inv);
    D.neck.copy(D.lSh).add(D.rSh).multiplyScalar(0.5);
    D.pelvis.copy(D.lHip).add(D.rHip).multiplyScalar(0.5);
    const turnOf = (part, q) => {
      if (!part.bone) return q.multiplyQuaternions(bodyFrame(D, _q), _q2.copy(this._restFrame).invert());
      _m.multiplyMatrices(inv, part.bone.matrixWorld).extractRotation(_m);
      return q.setFromRotationMatrix(_m).multiply(part.restInv);
    };
    for (let k = 0; k < SEGS.length; k++) turnOf(this._parts[k], _turn[k]);
    const headDir = _hd.copy(this._restHeadDir).applyQuaternion(_turn[1]);

    // The puppet's joints: from the pelvis outwards, each part the
    // photographed length, in the figure's direction.
    const J = _pup, sig = this._sigma;
    J.pelvis.copy(D.pelvis);
    for (let e = 0; e < EDGES.length; e++) {
      const [a, b] = EDGES[e];
      if (b === 'headTop') this._prevDir[e].copy(headDir);
      else {
        _v.copy(D[b]).sub(D[a]);
        const l = _v.length();
        if (l > 1e-9) this._prevDir[e].copy(_v).divideScalar(l);
      }
      J[b].copy(J[a]).addScaledVector(this._prevDir[e], this._restFrames[e].len * sig);
    }

    // Each part's frame now: along the bone, across it (the photo's across,
    // turned with the bone) and out of the picture.
    for (let k = 0; k < SEGS.length; k++) {
      const [a, b] = EDGES[SEGS[k].e];
      const fr = _fr[k], rf = this._restFrames[SEGS[k].e];
      _q.multiplyQuaternions(_turn[k], this._parts[k].align);
      fr.A.copy(J[a]);
      fr.d.copy(J[b]).sub(J[a]);
      const len = fr.d.length();
      fr.d.divideScalar(Math.max(1e-9, len));
      fr.s.set(rf.n.x, rf.n.y, 0).applyQuaternion(_q);
      fr.s.addScaledVector(fr.d, -fr.s.dot(fr.d));
      if (fr.s.lengthSq() < 1e-12) fr.s.set(0, 0, 1).applyQuaternion(_q).cross(fr.d);
      fr.s.normalize();
      fr.o.crossVectors(fr.d, fr.s);
      fr.su = len / rf.len;
    }

    const pos = this.geometry.attributes.position.array;
    const { seg, w0, uv, z } = this._skin;
    const n = this._n;
    for (let i = 0; i < n; i++) {
      const f0 = _fr[seg[i * 2]], f1 = _fr[seg[i * 2 + 1]];
      const a = w0[i], b = 1 - a;
      const u0 = uv[i * 4] * f0.su, v0 = uv[i * 4 + 1] * sig;
      const u1 = uv[i * 4 + 2] * f1.su, v1 = uv[i * 4 + 3] * sig;
      const t = z[i] * sig;
      // Centre line (on the picture plane) and the outward direction, blended.
      const cx = a * (f0.A.x + f0.d.x * u0 + f0.s.x * v0) + b * (f1.A.x + f1.d.x * u1 + f1.s.x * v1);
      const cy = a * (f0.A.y + f0.d.y * u0 + f0.s.y * v0) + b * (f1.A.y + f1.d.y * u1 + f1.s.y * v1);
      const cz = a * (f0.A.z + f0.d.z * u0 + f0.s.z * v0) + b * (f1.A.z + f1.d.z * u1 + f1.s.z * v1);
      const ox = a * f0.o.x + b * f1.o.x, oy = a * f0.o.y + b * f1.o.y, oz = a * f0.o.z + b * f1.o.z;
      pos[i * 3] = cx + ox * t; pos[i * 3 + 1] = cy + oy * t; pos[i * 3 + 2] = cz + oz * t;
      const j = (n + i) * 3;
      pos[j] = cx - ox * t; pos[j + 1] = cy - oy * t; pos[j + 2] = cz - oz * t;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  dispose() {
    this.unbind();
    this.geometry.dispose();
    for (const m of this.materials) { m.map?.dispose(); m.dispose(); }
  }
}

// Scratch, shared by every puppet (update() is synchronous).
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();
const _v = new THREE.Vector3(), _up = new THREE.Vector3(), _ac = new THREE.Vector3(), _fw = new THREE.Vector3(), _hd = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _drv = {}, _pup = {};
for (const k of ['pelvis', 'neck', 'headTop', ...LIMB_JOINTS]) {
  _drv[k] = new THREE.Vector3();
  _pup[k] = new THREE.Vector3();
}
const _turn = SEGS.map(() => new THREE.Quaternion());
const _fr = SEGS.map(() => ({ A: new THREE.Vector3(), d: new THREE.Vector3(), s: new THREE.Vector3(), o: new THREE.Vector3(), su: 1 }));
