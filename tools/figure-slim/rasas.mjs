// Navarasa — the nine emotions — as poses of the face rig face.py builds.
// One table, used by the preview sheet and by the baking tool.
//
// Distances are in thousandths of a Poser unit (1 ≈ 2.6 mm on the figure).
//   jaw      degrees open
//   corner   [out, up]      mouth corners
//   browIn   [together, up] inner brows       browOut  up
//   lidUp    degrees: + closes, − widens      lidLo    degrees: + raises (squint)
//   cheek    up             lipUp  up         nose  up (wrinkle)
//   lipLo    up (− bares the lower teeth)     nostril  flare outward
//   gaze     [right, down]  degrees, both eyes        head  degrees chin-up (added to the loop's own head motion)
export const RASAS = {
  Shringara: { jaw: 2, corner: [2.0, 3.3], browIn: [0, 1.1], browOut: 2.0, lidUp: 8, lidLo: 8, cheek: 1.8, gaze: [10, 4] },
  Hasya:     { jaw: 7, corner: [4.2, 5.4], lipLo: 2.4, browIn: [0, 1.4], browOut: 2.0, lidUp: 12, lidLo: 16, cheek: 3.6 },
  Karuna:    { jaw: 3, corner: [-0.4, -3.6], browIn: [1.3, 4.8], browOut: -2.0, lidUp: 12, lidLo: 4, gaze: [0, 16] },
  Raudra:    { jaw: 1, corner: [1.4, -1.2], lipUp: 2.6, lipLo: -2.0, browIn: [3.0, -5.2], browOut: 1.2, lidUp: -6, lidLo: 12, nose: 2.2, nostril: 1.2 },
  Veera:     { jaw: 0, corner: [1.2, 0.5], browIn: [0, 1.8], browOut: 2.8, lidUp: -8, nostril: 1.0, head: 7 },
  Bhayanaka: { jaw: 8, corner: [2.2, -1.6], lipLo: -0.8, browIn: [2.4, 6.2], browOut: 2.4, lidUp: -16, lidLo: -5 },
  Bibhatsa:  { jaw: 3, corner: [0.4, -2.7], browIn: [1.6, -3.6], lidUp: 10, lidLo: 12, cheek: 1.6, lipUp: 2.8, nose: 3.2 },
  Adbhuta:   { jaw: 9, corner: [-2.2, 0.2], lipUp: 0.5, browIn: [0, 4.6], browOut: 5.2, lidUp: -12 },
  Shanta:    { jaw: 0, corner: [0.7, 1.4], lidUp: 12, gaze: [0, 8] },
};

/** @returns Map joint → { t:[x,y,z] offset in Poser units, r:[x,y,z] degrees (order ZYX) } */
export function facePose(r) {
  const m = new Map(), u = 0.001;
  const set = (n, t = [0, 0, 0], rot = [0, 0, 0]) => m.set(n, { t, r: rot });
  set('jaw', [0, 0, 0], [r.jaw ?? 0, 0, 0]);
  set('lipUp', [0, (r.lipUp ?? 0) * u, 0]);
  set('nose', [0, (r.nose ?? 0) * u, 0]);
  for (const [s, sx] of [['L', 1], ['R', -1]]) {
    const [co, cu] = r.corner ?? [0, 0], [bt, bu] = r.browIn ?? [0, 0];
    set('corner' + s, [sx * co * u, cu * u, -0.5 * Math.max(co, 0) * u]);       // a wide mouth wraps back round the teeth
    set('browIn' + s, [-sx * bt * u, bu * u, 0]);
    set('browOut' + s, [0, (r.browOut ?? 0) * u, 0]);
    set('cheek' + s, [0, (r.cheek ?? 0) * u, 0.3 * (r.cheek ?? 0) * u]);
    set('lidUp' + s, [0, 0, 0], [r.lidUp ?? 0, 0, 0]);
    set('lidLo' + s, [0, 0, 0], [-(r.lidLo ?? 0), 0, 0]);
  }
  set('lipLo', [0, (r.lipLo ?? 0) * u, 0]);
  for (const [s, sx] of [['L', 1], ['R', -1]]) set('nostril' + s, [sx * (r.nostril ?? 0) * u, 0.3 * (r.nostril ?? 0) * u, 0]);
  // the eye that turns toward the nose turns a little less, or a sideways glance reads as a squint
  const [gy, gp] = r.gaze ?? [0, 0];
  set('leftEye', [0, 0, 0], [gp, -gy * (gy > 0 ? 0.75 : 1), 0]);
  set('rightEye', [0, 0, 0], [gp, -gy * (gy < 0 ? 0.75 : 1), 0]);
  m.set('head', { t: [0, 0, 0], r: [-(r.head ?? 0), 0, 0], additive: true });
  return m;
}
