// What each creature's body looks like around its bone chains: the parts that are not chains
// (bell, mantle, eyes), the camera framing, and the colours of the Soft skin.
// build(THREE, body, mats) adds meshes to `body` and returns an object apply(P) can drive.
// mats.limb / mats.body are swapped by the page when the skin changes.
import { TAU } from './core.js';

// Where the octopus eyes sit on the head (declared before VIEWS, which reads it).
const EYE = { y: 0.29, R: 0.36, theta: Math.PI / 2 - 0.55, lift: 0.2, mound: 0.105, sigma: 0.1, ball: 0.09, slit: [0.072, 0.032] };   // ball well under the skin: the head curves away above the eye

export const VIEWS = {
  jelly: {
    // A lion's mane, after the owner's photos: a deep, lobed, clear bell, blue-violet at the edge
    // to magenta over the stomach, branching canals showing through; four folded gonads under it;
    // eight clusters of fine pink-lilac hairs; four bunches of translucent orange curtains (the
    // oral arms). Colour comes from per-vertex tints (the hairs' from their chain tint).
    camera: { pos: [0, -0.6, 11.5], target: [0, -2.4, 0] },        // room for the long trailing hairs
    // See-through: per-vertex alpha (aAlpha) makes the bell clear and the inner parts translucent.
    // Sheen brightens grazing angles (the glow round a jellyfish's edges); a faint emissive keeps
    // the shaded underside from going dead.
    soft: { limb: 0xffffff, body: 0xffffff, bodyClear: false, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12,
      limbProps: { transparent: true, sheen: 1, sheenColor: 0xa8dcff, sheenRoughness: 0.45, emissive: 0x1a1220 } },
    skinFx: { mottle: 0.12, bump: 0.05 },

    // Everything goes into the skinned mesh: one surface, one material. Order matters for a
    // see-through skin: what is added first is drawn first, so the bell goes last, over the rest.
    skin(ctx) {
      const { THREE, chains, boneAt, axisAt } = ctx;
      const dn = new THREE.Vector3(), downY = c => dn.set(0, -1, 0).applyQuaternion(c.q).y;
      const ribs = chains.filter(c => !c.parented && downY(c) > -0.5);    // bound flat: apex → margin
      const oral = chains.filter(c => !c.parented && downY(c) <= -0.5);   // hang from the mouth
      const hairs = chains.filter(c => c.parented);
      const C = h => new THREE.Color(h), col = new THREE.Color();
      const add = (p, tint, alpha, wts, ix, fix) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(ix); g.computeVertexNormals();
        if (fix) fix(g.attributes.normal);
        g.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 3));
        g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alpha, 1));
        ctx.addGeometry(g, vi => wts[vi]);
      };
      const grid = (ix, base, rows, cols) => {      // quads over a (rows+1) × (cols+1) block of points
        for (let m = 0; m < rows; m++) for (let q = 0; q < cols; q++) {
          const q0 = base + m * (cols + 1) + q; ix.push(q0, q0 + cols + 1, q0 + 1, q0 + 1, q0 + cols + 1, q0 + cols + 2);
        }
      };
      // Crumple: seeded 2D value noise in three octaves, −0.5..0.5. Folds made of sines line up
      // into rows and read as manufactured; noise reads as tissue.
      const hash = (x, y) => { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); };
      const vn = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
        const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
        return (hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u) * (1 - v) + (hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u) * v; };
      const crumple = (x, y) => 0.55 * vn(x, y) + 0.3 * vn(2.1 * x + 7.3, 2.1 * y + 1.9) + 0.15 * vn(4.3 * x + 3.1, 4.3 * y + 5.7) - 0.5;
      // Which two ribs a rim angle lies between, and how far: shared by the bell and the gonads.
      const NRb = ribs.length, L = ribs[0].length, Y0 = ribs[0].p.y;
      const ribW = (phi, s) => {
        const f = (((phi / (TAU / NRb)) % NRb) + NRb) % NRb, ra = Math.floor(f) % NRb, rb = (ra + 1) % NRb, w = f - Math.floor(f);
        const sc = Math.min(s, L - 1e-4), A = boneAt(ribs[ra], sc), B = boneAt(ribs[rb], sc);
        return [[A.i, A.b1, B.i, B.b1], [(1 - w) * (1 - A.w1), (1 - w) * A.w1, w * (1 - B.w1), w * B.w1]];
      };

      // Oral arms: each chain is a soft core (its own tube, jelly-def.js) wrapped in one ribbon of
      // tissue, centred on the core and twisting round it as it falls, its two edges ruffled like a
      // lettuce leaf (an edge longer than the middle has to wave). Ruffles and twist mean no flat
      // sheet faces the viewer from any side: a flat sheet with folds read as paper.
      // Pale pink-white at the mouth, peach in the thick middle, paler and thinner at the frills.
      const MOUTH = C(0xfbe6dc), PEACH = C(0xfcbc8a), ORANGE = C(0xf3923e), FRILL = C(0xffe2c8);
      const NS = 130, NW = 10, ax = new THREE.Vector3(), az = new THREE.Vector3(), wd = new THREE.Vector3(), wn = new THREE.Vector3(), a = new THREE.Vector3();
      oral.forEach((ch, oi) => {
        ax.set(1, 0, 0).applyQuaternion(ch.q); az.set(0, 0, 1).applyQuaternion(ch.q);
        const seed = 3.7 * oi + 1.3, psi0 = hash(oi, 9) * TAU, turns = 0.6 + 0.5 * hash(oi, 4), wide = 0.8 + 0.4 * hash(oi, 3);
        const F = 6 + 4 * hash(oi, 7);                                    // ruffles along each edge: broad, round
        const p = [], tint = [], alpha = [], wts = [], ix = [];
        for (let m = 0; m <= NS; m++) {
          const t = m / NS, s = t * ch.length * 0.999;
          const psi = psi0 + TAU * turns * t + 0.8 * (vn(2 * t + seed, seed) - 0.5);
          wd.copy(ax).multiplyScalar(Math.cos(psi)).addScaledVector(az, Math.sin(psi));
          wn.copy(ax).multiplyScalar(-Math.sin(psi)).addScaledVector(az, Math.cos(psi));
          const W = (0.05 + 0.2 * wide * Math.sin(Math.PI * Math.pow(t, 0.6))) * (1 - 0.3 * t * t);
          axisAt(ch, s, a);
          const kb = boneAt(ch, s);
          for (let q = 0; q <= NW; q++) {
            const v = q / NW * 2 - 1, e = Math.abs(v), side = v < 0 ? 1.7 : 0;   // the two edges ruffle out of step
            const wob = crumple(6 * t + seed, 2 * v + seed);
            const ruf = Math.sin(TAU * F * (1 + 0.15 * e) * t + side + 2.5 * wob);
            const off = 0.05 * e * e * ruf + 0.018 * e * e * e * Math.sin(TAU * 2 * F * t + side + seed) + 0.04 * wob + 0.04 * (1 - e * e);
            p.push(a.x + wd.x * v * W + wn.x * off, a.y + wd.y * v * W + wn.y * off, a.z + wd.z * v * W + wn.z * off);
            col.copy(MOUTH).lerp(PEACH, Math.min(1, t * 4)).lerp(ORANGE, Math.min(1, 0.25 + t * 0.4) * (1 - e)).lerp(FRILL, e * e * 0.6);
            col.multiplyScalar(1.05 + 0.18 * ruf * e + 0.3 * wob);
            tint.push(col.r, col.g, col.b); alpha.push(0.72 - 0.35 * e * e);   // thick and fuller in the middle
            wts.push([[kb.i, kb.b1, 0, 0], [1 - kb.w1, kb.w1, 0, 0]]);
          }
        }
        grid(ix, 0, NS, NW);
        add(p, tint, alpha, wts, ix);
      });

      // Gonads: four folded, crumpled crescents hanging just under the bell, between the oral arms,
      // each a horseshoe round the mouth, tapering to nothing at its ends, its lower edge ruffled
      // (a straight-edged ribbon read as a flat plate). They follow the ribs above them (they grow from the bell's
      // underside), so they move with every beat. Cream-yellow to orange-pink, translucent.
      {
        const GA = 90, GV = 8, CREAM = C(0xf6cf96), GPINK = C(0xf09a70);
        const p = [], tint = [], alpha = [], wts = [], ix = [];
        for (let gi = 0; gi < 4; gi++) {
          const g0 = gi * TAU / 4, base = p.length / 3;
          for (let m = 0; m <= GA; m++) {
            const e = m / GA * 2 - 1, phi = g0 + 0.5 * e;
            const s0 = L * (0.19 + 0.06 * Math.cos(e * Math.PI / 2)), cp = Math.cos(phi), sp = Math.sin(phi);   // in round the oral arms' roots
            const wt = ribW(phi, s0);
            for (let q = 0; q <= GV; q++) {
              const v = q / GV, hang = 0.2 * v * Math.pow(1 - e * e, 0.7) * (0.85 + 0.3 * vn(4 * e + gi, gi));
              const fold = crumple(7 * e + gi * 5, 3 * v + gi);
              // Folded like an accordion round the arc, so from no side is it a flat panel.
              const out = 0.06 * (0.3 + 0.7 * v) * Math.sin(TAU * 6 * e + gi) + 0.06 * v * fold + 0.04 * v * v * Math.sin(TAU * 13 * e + gi + 3 * fold);
              p.push((s0 + out) * cp, Y0 - 0.006 - hang, (s0 + out) * sp);
              col.copy(CREAM).lerp(GPINK, v * 0.8).multiplyScalar(1.05 + 0.45 * fold);
              tint.push(col.r, col.g, col.b); alpha.push(0.4 - 0.15 * v);
              wts.push(wt);
            }
          }
          grid(ix, base, GA, GV);
        }
        add(p, tint, alpha, wts, ix);
      }

      // Hair strands: four on each hair chain (the chains themselves draw nothing: bones are the
      // cost). The first follows its chain; the others drift toward a neighbouring chain of the same
      // cluster further down (a blend that grows along it), so no two strands move as one. Every
      // strand is curled — a loose helix round its line, opening up and tightening toward the tip,
      // as real tentacles coil — and the def twists the chains, so the curls roll along them.
      {
        const HT = C(0xdca8d8), HTIP = C(0xf2e8f6), SR = 40, SV = 3;
        const p = [], tint = [], alpha = [], wts = [], ix = [], o = new THREE.Vector3(), bA = new THREE.Vector3(), bB = new THREE.Vector3();
        const ox = new THREE.Vector3(), oz = new THREE.Vector3();
        hairs.forEach((A, hi) => {
          const nb = [hairs[hi + 1], hairs[hi - 1]].filter(B => B && B.p.distanceTo(A.p) < 0.15);   // same cluster
          ox.set(1, 0, 0).applyQuaternion(A.q); oz.set(0, 0, 1).applyQuaternion(A.q);
          for (let k = 0; k < 4; k++) {
            const B = k && nb.length ? nb[k % nb.length] : A;
            const b0 = k ? 0.05 + 0.06 * k : 0, b1 = k ? 0.3 + 0.3 * ((hi * 7 + k * 3) % 5) / 4 : 0, side = (k % 2 ? -1 : 1) * (k ? 1 + (k >> 1) : 0);
            const fr = 0.55 + 0.45 * (((hi * 13 + k * 5) % 7) / 6);
            const cr = 0.03 + 0.08 * hash(hi, k), turns = 2.5 + 4 * hash(k, hi + 0.5), c0 = hash(hi + 0.3, k) * TAU;   // its curl
            const base = p.length / 3;
            for (let m = 0; m <= SR; m++) {
              const u = m / SR, sA = u * A.length * fr, sB = u * B.length * fr, be = b0 + (b1 - b0) * u;
              const rc = cr * Math.pow(u, 1.2) * Math.min(1, u * 5), th = c0 + TAU * turns * Math.pow(u, 1.3);   // tighter to the tip
              axisAt(A, sA, bA); axisAt(B, sB, bB);
              o.copy(bA).lerp(bB, be).addScaledVector(oz, side * 0.008).addScaledVector(ox, rc * Math.cos(th)).addScaledVector(oz, rc * Math.sin(th));
              const kA = boneAt(A, sA), kB = boneAt(B, sB), r = 0.003 * (1 - 0.6 * u) * (m === SR ? 0.3 : 1);
              col.copy(HT).lerp(HTIP, Math.max(0, (u - 0.7) / 0.3));
              for (let j = 0; j <= SV; j++) {
                const an = TAU * j / SV, c = Math.cos(an) * r, sn = Math.sin(an) * r;
                p.push(o.x + ox.x * c + oz.x * sn, o.y + ox.y * c + oz.y * sn, o.z + ox.z * c + oz.z * sn);
                tint.push(col.r, col.g, col.b); alpha.push(0.38);
                wts.push([[kA.i, kA.b1, kB.i, kB.b1], [(1 - be) * (1 - kA.w1), (1 - be) * kA.w1, be * (1 - kB.w1), be * kB.w1]]);
              }
            }
            grid(ix, base, SR, SV);
          }
        });
        add(p, tint, alpha, wts, ix);
      }

      // Bell: one closed shell round every meridian — over the top from the apex to the margin,
      // round the rim, back underneath to the mouth. Bound flat (the ribs are straight at bind);
      // the ribs' bends make the dome. Each point follows the two ribs either side of it.
      // A round smooth dome: eight shallow scalloped lobes at the rim, each edged with four smaller ones.
      const lobe = phi => { const l = ((phi * 8 / TAU) % 1 + 1) % 1;
        return 1 - 0.1 * (1 - Math.pow(Math.sin(Math.PI * l), 0.8)) - 0.035 * (1 - Math.sqrt(Math.abs(Math.sin(4 * Math.PI * l)))); };
      const ht = u => 0.16 * Math.pow(Math.max(0, 1 - u * u), 1.2) + 0.014;   // jelly above the underside: a thick lens
      const HB0 = 0.004;
      const prof = [];   // [fraction of the way to the margin, extra past it, offset off the rib (+ up)]
      const NT = 22, ease = x => x * (1.3 - 0.3 * x);                          // closer rings near the margin
      for (let j = 0; j <= NT; j++) prof.push([ease(j / NT), 0, ht(ease(j / NT))]);
      const rr = (ht(1) + HB0) / 2, nc = (ht(1) - HB0) / 2;
      for (let j = 1; j < 5; j++) { const g = Math.PI * j / 5; prof.push([1, rr * Math.sin(g), nc + rr * Math.cos(g)]); }
      for (let j = NT; j >= 0; j--) prof.push([ease(j / NT), 0, -HB0]);
      const NP = prof.length, NA = 192;
      // Seen through the clear jelly: a magenta stomach at the centre with sixteen gastric pouches,
      // violet, then blue-turquoise lobes with a pale edge. Sixteen radial canals run out from the
      // stomach and fork twice on their way into the lobes.
      const STOM = C(0xb8487e), CEN = C(0xc8609e), MID = C(0x8e7ad0), EDGE = C(0x5aa6d2), RIM = C(0xd4eef6), MOUTHU = C(0xf0d0d8);
      const sec = TAU / 16, smooth = (a0, b0, x) => { const t = Math.min(1, Math.max(0, (x - a0) / (b0 - a0))); return t * t * (3 - 2 * t); };
      const canalAt = (phi, uu) => {
        let rel = ((phi / sec) % 1 + 1) % 1; rel = (rel > 0.5 ? rel - 1 : rel) * sec;   // angle from the nearest canal
        const f1 = sec * 0.25 * smooth(0.45, 0.75, uu), f2 = sec * 0.12 * smooth(0.72, 0.95, uu);
        const d = Math.min(Math.abs(rel - f1 - f2), Math.abs(rel - f1 + f2), Math.abs(rel + f1 - f2), Math.abs(rel + f1 + f2));
        return Math.exp(-Math.pow(d * uu * L / 0.012, 2)) * smooth(0.18, 0.3, uu);
      };
      const p = [], tint = [], alpha = [], wts = [], ix = [];
      for (let kk = 0; kk <= NA; kk++) {
        const phi = kk * TAU / NA, cp = Math.cos(phi), sp = Math.sin(phi), sm = L * lobe(phi);
        for (let j = 0; j < NP; j++) {
          const [u, ds, n] = prof[j], s = u * sm + ds, uu = s / L;
          p.push(s * cp, Y0 + n, s * sp);
          wts.push(ribW(phi, s));
          if (uu < 0.5) col.copy(n < 0 ? MOUTHU : CEN).lerp(MID, Math.max(0, (uu - 0.12) / 0.38));
          else col.copy(MID).lerp(EDGE, Math.min(1, (uu - 0.5) / 0.35));
          const pouch = smooth(0.24, 0.1, uu) * (0.75 + 0.25 * Math.cos(16 * phi));          // the stomach
          col.lerp(STOM, 0.7 * pouch).lerp(RIM, Math.max(0, (u - 0.93) / 0.07) * 0.8);
          const cn = canalAt(phi, uu);
          col.lerp(STOM, 0.6 * cn);
          tint.push(col.r, col.g, col.b);
          // Clear jelly; the rim firmer, and the stomach and canals inside it showing as colour.
          alpha.push((n < 0 ? 0.08 : 0.13) + 0.3 * Math.max(0, (u - 0.85) / 0.15) + 0.22 * pouch + 0.28 * cn);
        }
      }
      grid(ix, 0, NA, NP - 1);
      add(p, tint, alpha, wts, ix, N => {
        const v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
        for (let j = 0; j < NP; j++) {       // first and last meridian are the same points: one normal
          v1.fromBufferAttribute(N, j).add(v2.fromBufferAttribute(N, NA * NP + j)).normalize();
          N.setXYZ(j, v1.x, v1.y, v1.z); N.setXYZ(NA * NP + j, v1.x, v1.y, v1.z);
        }
        for (let kk = 0; kk <= NA; kk++) { N.setXYZ(kk * NP, 0, 1, 0); N.setXYZ(kk * NP + NP - 1, 0, -1, 0); }   // the two poles
      });
      return {};
    },

    // Marine snow: faint motes in the water, in world space (not on the body). The jellyfish
    // cannot leave the frame — a loop must end where it began — so when it swims, the water moves
    // past instead: down along its axis by however far it swam since the last frame (fast on
    // each stroke, slow while it coasts), and sideways with the current.
    build(THREE, body) {
      const N = 700, pos = new Float32Array(N * 3);
      let sd = 77; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < N; i++) pos.set([(rnd() - 0.5) * 16, -9.5 + rnd() * 14, -6 + rnd() * 10], 3 * i);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const dot = document.createElement('canvas'); dot.width = dot.height = 32;     // a soft round mote, not a square
      const dc = dot.getContext('2d'), gr = dc.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      dc.fillStyle = gr; dc.fillRect(0, 0, 32, 32);
      const snow = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaab6c4, size: 0.05, map: new THREE.CanvasTexture(dot),
        transparent: true, opacity: 0.5, depthWrite: false }));
      (body.parent || body).add(snow);
      return { meshes: [], snow, last: null };
    },
    apply(P, v) {
      const f = P.parts.flow, c = P.parts.clock, dr = P.parts.drift;
      if (!f || !v.snow) return;
      const now = [Math.atan2(f[1], f[0]), Math.atan2(c[1], c[0])], last = v.last; v.last = now;
      if (!last) return;
      const wrap = d => d - TAU * Math.round(d / TAU);
      const swum = wrap(now[0] - last[0]) / TAU * f[2], dl = wrap(now[1] - last[1]) / TAU;   // this frame
      const rz = P.root.rz, dx = Math.sin(rz) * swum + dr[0] * dl, dy = -Math.cos(rz) * swum, dz = dr[1] * dl;
      const A = v.snow.geometry.attributes.position, a = A.array;
      const wrapIn = (x, lo, span) => x - span * Math.floor((x - lo) / span);
      for (let i = 0; i < a.length; i += 3) {
        a[i] = wrapIn(a[i] + dx, -8, 16); a[i + 1] = wrapIn(a[i + 1] + dy, -9.5, 14); a[i + 2] = wrapIn(a[i + 2] + dz, -6, 10);
      }
      A.needsUpdate = true;
    },
  },

  octopus: {
    camera: { pos: [0, 2.6, 7.2], target: [0, -0.4, 0] },
    soft: { limb: 0xb04a32, under: 0xe8b49a, body: 0xb04a32, bodyClear: false },

    // Head and webs go INTO the arms' skinned mesh: one surface, one material.
    skin(ctx) {
      const { THREE, chains, boneAt, axisAt } = ctx;
      const head = ctx.newBone(new THREE.Vector3(0, 0, 0));          // never moves: neck, crown, eye region
      const mantle = ctx.newBone(new THREE.Vector3(0, 0.36, 0));     // leans back and breathes

      // Crown (where the arms leave) → neck → eye bulge → narrow waist → the mantle bag.
      const prof = [[0.001, -0.13], [0.22, -0.12], [0.38, -0.06], [0.43, 0.02], [0.37, 0.12], [0.34, 0.2],
        [0.37, 0.28], [0.33, 0.37], [0.38, 0.5], [0.45, 0.7], [0.47, 0.9], [0.42, 1.08], [0.3, 1.2], [0.12, 1.27], [0.001, 1.28]];
      const curve = new THREE.SplineCurve(prof.map(([r, y]) => new THREE.Vector2(r, y)));
      const NP = 65, NS = 64;
      const lathe = new THREE.LatheGeometry(curve.getPoints(NP - 1), NS);

      // Eye mounds: the head surface itself rises over each eye (no separate lid pieces), and the
      // shader cuts a slit through it where the eyeball shows. aEye holds each vertex's position
      // in its eye's plane (x across, y up) plus a mask; vertices far from both eyes get mask 0.
      const P = lathe.attributes.position, Nn = lathe.attributes.normal, eyeA = new Float32Array(P.count * 3);
      const eyes = [-1, 1].map(s => eyeFrame(THREE, s));
      const v = new THREE.Vector3(), d = new THREE.Vector3();
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i);
        for (const E of eyes) {
          const g = Math.exp(-v.distanceToSquared(E.c) / (EYE.sigma * EYE.sigma));
          if (g > 1e-4) { d.fromBufferAttribute(Nn, i); v.addScaledVector(d, EYE.mound * g); }
        }
        P.setXYZ(i, v.x, v.y, v.z);
      }
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i);
        const E = eyes[0].peak.distanceTo(v) < eyes[1].peak.distanceTo(v) ? eyes[0] : eyes[1];
        if (E.peak.distanceTo(v) < 0.3) { d.subVectors(v, E.peak); eyeA.set([d.dot(E.right), d.dot(E.up), 1], i * 3); }
      }
      lathe.computeVertexNormals();
      // The lathe's first and last meridians are the same vertices twice: average their normals
      // or the displaced head shows a crease down the front.
      for (let j = 0; j < NP; j++) {
        const a = j, b = NS * NP + j;
        v.fromBufferAttribute(lathe.attributes.normal, a).add(d.fromBufferAttribute(lathe.attributes.normal, b)).normalize();
        lathe.attributes.normal.setXYZ(a, v.x, v.y, v.z); lathe.attributes.normal.setXYZ(b, v.x, v.y, v.z);
      }
      lathe.setAttribute('aEye', new THREE.BufferAttribute(eyeA, 3));
      const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      // Mantle weighting starts ABOVE the eye mounds, so the eyes never slide against their sockets.
      ctx.addGeometry(lathe, (vi, x, y) => { const w = ss(0.44, 0.64, y); return [[head.index, mantle.index, 0, 0], [1 - w, w, 0, 0]]; });

      // Web between neighbouring arms: each point follows both arms, so it stretches and folds
      // with them. Deepest at the arms, scalloped shallower between them.
      const U = 10, R = 14, a = new THREE.Vector3(), b = new THREE.Vector3();
      for (let j = 0; j < chains.length; j++) {
        // Deep enough to show past the thick arm bases (at 0.27 it hid entirely inside them).
        const A = chains[j], B = chains[(j + 1) % chains.length], Wd = 0.42 * A.length;
        const p = [], wts = [], ix = [];
        for (let c = 0; c <= U; c++) {
          const u = c / U, edge = Wd * (0.4 + 0.6 * (2 * u - 1) ** 2);
          for (let r = 0; r <= R; r++) {
            const s = edge * r / R;
            axisAt(A, s, a); axisAt(B, s, b); a.lerp(b, u);
            p.push(a.x, a.y, a.z);
            const ka = boneAt(A, s), kb = boneAt(B, s);
            wts.push([[ka.i, ka.b1, kb.i, kb.b1], [(1 - u) * (1 - ka.w1), (1 - u) * ka.w1, u * (1 - kb.w1), u * kb.w1]]);
          }
        }
        for (let c = 0; c < U; c++) for (let r = 0; r < R; r++) {
          const q = c * (R + 1) + r; ix.push(q, q + 1, q + R + 1, q + 1, q + R + 2, q + R + 1);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(ix); g.computeVertexNormals();
        ctx.addGeometry(g, vi => wts[vi]);
      }
      return { mantle: mantle.bone };
    },

    // Skin shader extras (creature.html patchSkin): slit size in the eye plane, mottling, relief.
    skinFx: { slit: EYE.slit, mottle: 0.55, bump: 1, suckers: true },

    build(THREE, body) {
      // Eyeballs sit just under the skin mounds the head surface makes (see skin()); only the
      // slit cut through the skin shows them. Amber striated iris, horizontal bar pupil, cornea.
      const tex = new THREE.CanvasTexture(irisCanvas()); tex.colorSpace = THREE.SRGBColorSpace;
      const r = EYE.ball, ball = new THREE.SphereGeometry(r, 40, 28);
      const P = ball.attributes.position, uv = ball.attributes.uv;
      for (let i = 0; i < P.count; i++) uv.setXY(i, P.getX(i) / (2 * r) + 0.5, P.getY(i) / (2 * r) + 0.5);   // project from the front (+Z)
      const eyeMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35 });
      const cornea = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.02, clearcoat: 1, transparent: true, opacity: 0.1 });
      for (const s of [-1, 1]) {
        const E = eyeFrame(THREE, s), g = new THREE.Group();
        g.position.copy(E.peak).addScaledVector(E.n, -0.02 - r);        // front of the ball 2 cm under the mound's peak
        g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(E.right, E.up, E.n));
        g.add(new THREE.Mesh(ball, eyeMat), new THREE.Mesh(new THREE.SphereGeometry(r * 1.03, 32, 20), cornea));
        body.add(g);
      }
      return { meshes: [] };
    },
    apply(P, v, s) {
      const m = P.parts.mantle;
      s.mantle.rotation.x = -m.pitch;
      s.mantle.scale.set(m.sx, m.sy, m.sx);
    },
  },

  centipede: {
    camera: { pos: [3.2, 4.6, 8.4], target: [0, 0.4, 0] },   // far enough to keep Circle's whole path in view
    floor: { color: 0x4a4036 },                              // a walker: stands on a floor (fades when weightless)
    fur: { shells: 6, freq: 140, droop: 0.6, gravity: 0.1 },   // few shells: only legs and antennae are furry
    // Waxy chitin, not plastic: a soft sheen rather than a hard clearcoat mirror, fine pitting that
    // breaks the highlights up (bump), and colour that varies plate to plate (mottle + tints).
    soft: { limb: 0xffffff, body: 0x222222, bodyClear: false, roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.45 },
    skinFx: { mottle: 0.2, bump: 0.4 },

    // The body is not a tube: a shell of domed plates on the body chain's bones. Each plate rises
    // out of a groove of yellow joint skin, widens slightly toward its back and ends in a hard
    // lip that drops into the next groove; two faint ridges run along the back. The head is a
    // flat, round-fronted shield. Each plate moves almost rigidly with its own bone (the blend
    // between neighbours is squeezed toward the joint): armour.
    skin(ctx) {
      const { THREE, chains, boneAt, axisAt } = ctx;
      const ch = chains[0], Ltot = ch.length, NSEG = ch.L.length;
      // Rings per plate, dense where the shape turns: the groove, the rise, the rear lip.
      const FS = [0, 0.03, 0.06, 0.09, 0.13, 0.18, 0.25, 0.33, 0.42, 0.52, 0.62, 0.71, 0.79, 0.86, 0.91, 0.945, 0.965, 0.985];
      const NA = 24, ring = [];
      for (let i = 0; i < NSEG; i++) for (const f of FS) ring.push(ch.cum[i] + f * ch.L[i]);
      ring.push(Ltot - 1e-4);
      const NR = ring.length;
      const C = hex => new THREE.Color(hex);
      // Near-black plates with a warm brown sheen, a lighter rear rim, yellow joint skin (the
      // references: black-and-yellow Scolopendra), dark red-brown head, plates reddening at the tail.
      const HEAD = C(0x5a1e10), TERG = C(0x1e1612), EDGE = C(0x4a2e1a), JOINT = C(0xc8902e), BELLY = C(0xb08646), TAILC = C(0x5e2414);
      const p = [], tint = [], wts = [], ix = [], fur = [];
      const a = new THREE.Vector3(), v = new THREE.Vector3(), col = new THREE.Color();
      const sq = x => Math.sqrt(Math.max(0, 1 - x * x));
      let seed = 99; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const PLATE = Array.from({ length: NSEG }, () => 0.82 + 0.36 * rnd());   // per-plate brightness
      for (let m = 0; m < NR; m++) {
        const s = Math.min(Ltot - 1e-4, ring[m]);
        let i = 0; while (i < NSEG - 1 && s > ch.cum[i + 1]) i++;
        const f = (s - ch.cum[i]) / ch.L[i];                              // 0..1 along this plate
        const cap = sq(Math.max(0, 1 - s / 0.11)) * sq(Math.max(0, 1 - (Ltot - s) / 0.1));
        const taper = i < 4 ? 0.86 + 0.035 * i : 1 - 0.2 * Math.max(0, (s / Ltot - 0.75) / 0.25);   // narrower neck plates
        const plate = f < 0.06 ? 0.8
          : f < 0.18 ? 0.8 + 0.17 * Math.sin((f - 0.06) / 0.12 * Math.PI / 2)
          : f < 0.94 ? 0.97 + 0.03 * (f - 0.18) / 0.76 + 0.02 * Math.sin((f - 0.18) / 0.76 * Math.PI)
          : 1 - 0.16 * Math.pow((f - 0.94) / 0.06, 1.5);                 // the lip
        const w = i === 0 ? 0.205 * cap : 0.22 * cap * taper * plate;
        const h = i === 0 ? 0.09 * cap : 0.15 * cap * taper * plate;     // the head shield is flat
        axisAt(ch, s, a);
        const k = boneAt(ch, s), w1 = 0.5 * Math.pow(2 * k.w1, 2);   // squeeze the blend toward the joint
        const joint = i > 0 && f < 0.08, under = i > 0 && f < 0.035;  // under: in the shadow of the lip
        const tailR = Math.max(0, (i - (NSEG - 5)) / 4);              // last plates redden
        for (let jj = 0; jj <= NA; jj++) {
          const th = Math.PI + TAU * jj / NA;                          // seam along the belly
          const ct = Math.cos(th), st = Math.sin(th), ang = Math.atan2(st, ct);   // ang: 0 on top
          const rid = i > 0 && !joint && ct > 0 ? Math.exp(-Math.pow((Math.abs(ang) - 0.42) / 0.07, 2)) : 0;
          let upv = ct >= 0 ? h * (i === 0 ? Math.pow(ct, 0.6) : ct) : 0.65 * h * ct;   // domed back, flatter belly
          upv -= rid * 0.01;                                           // the two ridges are shallow grooves
          v.set(upv, 0, w * st).applyQuaternion(ch.q).add(a);
          p.push(v.x, v.y, v.z);
          if (ct < -0.3) col.copy(BELLY).multiplyScalar(joint ? 0.75 : 1);
          else if (joint) col.copy(JOINT).multiplyScalar(under ? 0.45 : 1);
          else if (i === 0) col.copy(HEAD);
          else {
            col.copy(TERG).lerp(TAILC, tailR).lerp(EDGE, 0.65 * Math.max(0, (f - 0.82) / 0.12)).lerp(EDGE, 0.5 * rid);
            col.lerp(EDGE, 0.35 * Math.max(0, Math.min(1, (0.45 - ct) / 0.35)));   // thinner, warmer chitin toward the sides
            col.multiplyScalar(PLATE[i]);                                         // no two plates quite alike
          }
          if (ct >= -0.3 && ct < 0.05 && !joint) col.lerp(JOINT, 0.3);    // a warmer line along the flanks
          tint.push(col.r, col.g, col.b);
          // A fringe of fine hairs along each plate's rear lip (not the head, not the belly).
          const fringe = i > 0 && f > 0.86 && ct > -0.3;
          fur.push(fringe ? 0.012 : 0, 0.35, 0.3, 0);
          wts.push([[k.i, k.b1, 0, 0], [1 - w1, w1, 0, 0]]);
        }
      }
      for (let m = 0; m < NR - 1; m++) for (let jj = 0; jj < NA; jj++) {
        const q0 = m * (NA + 1) + jj; ix.push(q0, q0 + NA + 1, q0 + 1, q0 + 1, q0 + NA + 1, q0 + NA + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(ix); g.computeVertexNormals();
      // First and last column are the same points: average their normals (no crease down the belly).
      const N = g.attributes.normal, n1 = new THREE.Vector3(), n2 = new THREE.Vector3();
      for (let m = 0; m < NR; m++) {
        const a0 = m * (NA + 1), b0 = a0 + NA;
        n1.fromBufferAttribute(N, a0).add(n2.fromBufferAttribute(N, b0)).normalize();
        N.setXYZ(a0, n1.x, n1.y, n1.z); N.setXYZ(b0, n1.x, n1.y, n1.z);
      }
      g.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 3));
      g.setAttribute('aFur', new THREE.Float32BufferAttribute(fur, 4));
      ctx.addGeometry(g, vi => wts[vi]);

      // Spines: a Scolopendra's legs carry little spurs at the far end of each segment, and its
      // tail legs rows of strong spines. Tiny pyramids, each rigid with its own leg bone.
      // Chain indices and sizes repeat centipede-def.js CHAINS: walking legs 1..40, tail legs 41..42.
      {
        const sp = [], st = [], sw = [], si = [];
        const SPUR = C(0x8a5a1c), SPTIP = C(0x241005);
        const rad = new THREE.Vector3(), dir = new THREE.Vector3(), base = new THREE.Vector3(), tip = new THREE.Vector3();
        const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), ax = new THREE.Vector3();
        const spine = (lc, s, r, ang, len, thick) => {
          axisAt(lc, s, a);
          rad.set(Math.cos(ang), 0, Math.sin(ang)).applyQuaternion(lc.q);                 // out from the leg's axis
          dir.set(Math.cos(ang), -0.9, Math.sin(ang)).normalize().applyQuaternion(lc.q);   // raked toward the tip
          base.copy(a).addScaledVector(rad, r * 0.8); tip.copy(base).addScaledVector(dir, len);
          ax.set(0, 1, 0).applyQuaternion(lc.q);
          e1.crossVectors(ax, rad).normalize().multiplyScalar(thick);
          e2.crossVectors(dir, e1).normalize().multiplyScalar(thick);
          const k = boneAt(lc, s), b0 = sp.length / 3;
          for (const [x, y] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
            v.copy(base).addScaledVector(e1, x).addScaledVector(e2, y);
            sp.push(v.x, v.y, v.z); st.push(SPUR.r, SPUR.g, SPUR.b);
          }
          sp.push(tip.x, tip.y, tip.z); st.push(SPTIP.r, SPTIP.g, SPTIP.b);
          for (let n = 0; n < 5; n++) sw.push([[k.i, k.b1, 0, 0], [1 - k.w1, k.w1, 0, 0]]);
          for (let n = 0; n < 4; n++) si.push(b0 + n, b0 + (n + 1) % 4, b0 + 4);
        };
        for (let L = 1; L <= 42; L++) {
          const lc = chains[L], tail = L > 40, art = tail ? 6 : 5, r0 = tail ? 0.055 : 0.042, r1 = 0.014;
          for (let n = 0; n < art - 1; n++) {                   // every segment but the claw
            const u = (n + 0.82) / art, s = u * lc.length, r = r0 + (r1 - r0) * u, count = tail ? 4 : 2;
            for (let c2 = 0; c2 < count; c2++) {
              const ang = (tail ? Math.PI * (0.75 + 0.5 * c2 / (count - 1)) : Math.PI * (0.6 + 0.8 * c2)) + 0.3 * (rnd() - 0.5);
              spine(lc, s, r, ang, (tail ? 0.05 : 0.028) * (0.8 + 0.4 * rnd()), tail ? 0.009 : 0.005);
            }
          }
        }
        const sg = new THREE.BufferGeometry();
        sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sg.setIndex(si); sg.computeVertexNormals();
        sg.setAttribute('aTint', new THREE.Float32BufferAttribute(st, 3));
        ctx.addGeometry(sg, vi => sw[vi]);
      }
      return {};
    },
    build() { return { meshes: [] }; },
    apply() {},
  },
};

// Frame of one octopus eye, shared by the skin (mounds, slit) and the eyeballs.
function eyeFrame(THREE, s) {
  const c = new THREE.Vector3(s * Math.sin(EYE.theta) * EYE.R, EYE.y, Math.cos(EYE.theta) * EYE.R);   // on the plain head surface
  const n = new THREE.Vector3(s * Math.sin(EYE.theta), EYE.lift, Math.cos(EYE.theta)).normalize();   // looks out, a little up
  const peak = c.clone().addScaledVector(n, EYE.mound);
  const right = new THREE.Vector3(0, 1, 0).cross(n).normalize(), up = n.clone().cross(right).normalize();
  return { c, n, peak, right, up };
}

// Octopus iris, drawn once: amber with radial striations and a dark limbal ring; horizontal pupil.
function irisCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), C = 128;
  g.fillStyle = '#3a2412'; g.fillRect(0, 0, 256, 256);
  const rad = g.createRadialGradient(C, C, 10, C, C, 118);
  rad.addColorStop(0, '#f2c25a'); rad.addColorStop(0.55, '#d0922e'); rad.addColorStop(0.9, '#8a5418'); rad.addColorStop(1, '#2a1608');
  g.fillStyle = rad; g.beginPath(); g.arc(C, C, 118, 0, TAU); g.fill();
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    const a = rnd() * TAU, r0 = 25 + rnd() * 30, r1 = 80 + rnd() * 35;
    g.strokeStyle = rnd() < 0.5 ? `rgba(255,230,150,${0.15 + rnd() * 0.25})` : `rgba(90,45,10,${0.15 + rnd() * 0.3})`;
    g.lineWidth = 0.6 + rnd() * 1.4; g.beginPath();
    g.moveTo(C + Math.cos(a) * r0, C + Math.sin(a) * r0); g.lineTo(C + Math.cos(a) * r1, C + Math.sin(a) * r1); g.stroke();
  }
  g.fillStyle = '#060404'; g.beginPath();                          // horizontal bar pupil, slightly waisted
  g.moveTo(C - 70, C - 13); g.quadraticCurveTo(C, C - 7, C + 70, C - 13);
  g.quadraticCurveTo(C + 82, C, C + 70, C + 13); g.quadraticCurveTo(C, C + 7, C - 70, C + 13);
  g.quadraticCurveTo(C - 82, C, C - 70, C - 13); g.fill();
  return c;
}
