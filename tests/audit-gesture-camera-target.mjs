// Audit: the Camera-mode gesture grammar drives a SWAPPABLE target.
//
// GestureArbitrator used to hardcode scene3d.rot.x/y and scene3d.scale in six
// places (orbit, pinch, rebaseline, 3-finger undo, coast, start snapshot). The
// Volume source made the target swappable (opts.camTarget). This proves:
//   1. with no override, every gesture still drives the 3D scene exactly as
//      before (rotation wraps, pinch clamps 0.01–50);
//   2. with the Volume target, the SAME gestures drive vol.* — and none of them
//      leaks a write into scene3d.* (a half-converted path would);
//   3. the 3-finger undo and the flick coast follow the target too.
// Pure node: the arbitrator needs only a canvas-shaped stub and a ps stub.

import { GestureArbitrator } from '../src/core/GestureArbitrator.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };

function makePs() {
  const p = {};
  const reg = (id, value, min = -Infinity, max = Infinity) => { p[id] = { value, min, max }; };
  reg('touch.mode', 0);
  reg('scene3d.rot.x', 10, 0, 360); reg('scene3d.rot.y', 20, 0, 360); reg('scene3d.rot.z', 0, 0, 360);
  reg('scene3d.scale', 1, 0.01, 50);
  reg('scene3d.spin.x', 0); reg('scene3d.spin.y', 0); reg('scene3d.spin.z', 0);
  reg('vol.camYaw', 35, 0, 360); reg('vol.camPitch', 20, -89, 89); reg('vol.camZoom', 100, 25, 400);
  const writes = [];
  return {
    writes,
    get: (id) => p[id],
    set: (id, v) => { const q = p[id]; q.value = Math.max(q.min, Math.min(q.max, v)); writes.push(id); },
    getAll: () => Object.values(p),
  };
}
const canvas = () => ({
  style: {}, addEventListener() {}, setPointerCapture() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
});
const volTarget = (ps) => ({
  get: () => ({ x: ps.get('vol.camPitch').value, y: -ps.get('vol.camYaw').value, s: ps.get('vol.camZoom').value / 100 }),
  set: ({ x, y, s }) => {
    if (x !== undefined) ps.set('vol.camPitch', x);
    if (y !== undefined) ps.set('vol.camYaw', (((-y) % 360) + 360) % 360);
    if (s !== undefined) ps.set('vol.camZoom', s * 100);
  },
});
const ev = (id, x, y) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y });
const drag1 = (ga, dx, dy) => {
  ga._pointerDown(ev(1, 100, 100));
  ga._pointerMove(ev(1, 100 + dx, 100 + dy));
  ga._pointerEnd(ev(1, 100 + dx, 100 + dy));
};
const pinch = (ga, ratio) => {
  ga._pointerDown(ev(1, 100, 100)); ga._pointerDown(ev(2, 200, 100));
  ga._pointerMove(ev(2, 100 + 100 * ratio, 100));
  ga._pointerEnd(ev(1, 100, 100)); ga._pointerEnd(ev(2, 100 + 100 * ratio, 100));
};
const ORBIT = 0.35;

console.log('\n1. No override — the 3D scene, as before');
{
  const ps = makePs();
  const ga = new GestureArbitrator(canvas(), ps, {});
  drag1(ga, 100, -100);
  ok(Math.abs(ps.get('scene3d.rot.y').value - (20 + 100 * ORBIT)) < 1e-9, `drag right 100px → rot.y ${ps.get('scene3d.rot.y').value}`);
  ok(Math.abs(ps.get('scene3d.rot.x').value - (10 - 100 * ORBIT + 360)) < 1e-9, `drag up 100px wraps rot.x → ${ps.get('scene3d.rot.x').value}`);
  pinch(ga, 2);
  ok(Math.abs(ps.get('scene3d.scale').value - 2) < 1e-9, `pinch ×2 → scale ${ps.get('scene3d.scale').value}`);
  ok(!ps.writes.some((id) => id.startsWith('vol.')), 'no write reaches vol.*');
}

console.log('\n2. Volume target — the same gestures drive vol.*');
{
  const ps = makePs();
  const ga = new GestureArbitrator(canvas(), ps, {}, { camTarget: () => volTarget(ps) });
  drag1(ga, 100, 40);
  ok(Math.abs(ps.get('vol.camYaw').value - (35 - 100 * ORBIT)) < 1e-9, `drag right 100px → camYaw ${ps.get('vol.camYaw').value} (object turns right)`);
  ok(Math.abs(ps.get('vol.camPitch').value - (20 + 40 * ORBIT)) < 1e-9, `drag down 40px → camPitch ${ps.get('vol.camPitch').value}`);
  drag1(ga, 0, 1000);
  ok(ps.get('vol.camPitch').value === 89, `tilt CLAMPS at the pole, does not wrap → ${ps.get('vol.camPitch').value}`);
  pinch(ga, 0.5);
  ok(Math.abs(ps.get('vol.camZoom').value - 50) < 1e-9, `pinch ×0.5 → camZoom ${ps.get('vol.camZoom').value}`);
  ok(!ps.writes.some((id) => id.startsWith('scene3d.')), 'no write leaks into scene3d.*');
}

console.log('\n3. 3-finger undo and the coast follow the target');
{
  const ps = makePs();
  const ga = new GestureArbitrator(canvas(), ps, {}, { camTarget: () => volTarget(ps) });
  ga._pointerDown(ev(1, 100, 100));
  ga._pointerMove(ev(1, 160, 100));                       // first finger drives a little
  ga._pointerDown(ev(2, 300, 100)); ga._pointerDown(ev(3, 400, 100));   // → null zone
  ok(ps.get('vol.camYaw').value === 35, `3rd finger restores camYaw → ${ps.get('vol.camYaw').value}`);
  for (const i of [1, 2, 3]) ga._pointerEnd(ev(i, 0, 0));
  ga._coastVX = 100; ga._coastVY = 0;                      // a rightward flick, deg/s
  ga.tick(0.1);
  ok(Math.abs(ps.get('vol.camYaw').value - (35 - 10)) < 1e-6, `coast 100°/s × 0.1 s → camYaw ${ps.get('vol.camYaw').value.toFixed(3)}`);
  ok(!ps.writes.some((id) => id.startsWith('scene3d.')), 'coast and undo never write scene3d.*');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
