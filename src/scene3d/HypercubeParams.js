/**
 * Hypercube parameters — registered here rather than inline in main.js so
 * that Node-side audits (tests/audit-guide-targets.mjs) can build the same
 * parameter set the app has. Same shape as registerAnalogParams /
 * registerTeletextParams. Moved verbatim; ids, options and defaults are
 * unchanged, so every saved state, bank and MIDI binding behaves as before.
 */

import { OPT_SOURCES } from '../controls/ParameterSystem.js';
import { EASING, PLANE_NAMES, PLANE_HELP, PLANE_MENU_ORDER } from './HypercubeGeometry.js';

/** Speed param id of each plane-bank slot. Slots 1–4 keep the old rot.* ids. */
export const HC_SLOT_SPEED = ['hypercube.rot.xy', 'hypercube.rot.xz', 'hypercube.rot.yz', 'hypercube.rot.xw',
                              'hypercube.slot5.speed', 'hypercube.slot6.speed', 'hypercube.slot7.speed', 'hypercube.slot8.speed'];

export function registerHypercubeParams(ps) {
  ps.register({ id:'hypercube.dim',           type:'continuous', value:4,    min:4,    max:12,   step:1,     label:'Dimension',    group:'hypercube' });
  // Options derived from EASING, never retyped: stored as an index, so the key
  // order there is append-only. Default easeInOut, what the panel always used.
  ps.register({ id:'hypercube.easing',        type:'select',     options:Object.keys(EASING), value:Object.keys(EASING).indexOf('easeInOut'), label:'Easing', group:'hypercube' });
  ps.register({ id:'hypercube.morphDuration', type:'continuous', value:2000, min:200,  max:8000, step:100, label:'Morph Time',  group:'hypercube' });
  ps.register({ id:'hypercube.wDistance',     type:'continuous', value:3.0,  min:1.1,  max:20,   step:0.1, label:'W Distance',  group:'hypercube' });
  ps.register({ id:'hypercube.scale',         type:'continuous', value:1.0,  min:0.1,  max:5.0,  step:0.05, label:'Scale',  group:'hypercube' });
  ps.register({ id:'hypercube.edgeOpacity',   type:'continuous', value:1.0,  min:0.0,  max:1.0,  step:0.01, label:'Edge Opacity',  group:'hypercube' });
  ps.register({ id:'hypercube.pointSize',     type:'continuous', value:3.0,  min:0.5,  max:20,   step:0.5, label:'Point Size',  group:'hypercube' });
  // ── Plane Bank: 8 slots, each a plane + a speed ────────────────────────────
  // Any of the 66 planes of the 12-cube can be played; planes in no slot turn
  // at their default speed. Slots 1–4 KEEP the old rot.xy/xz/yz/xw ids as
  // their speeds, with planes defaulting to XY/XZ/YZ/XW — so every saved state,
  // bank and MIDI binding on those rows behaves exactly as before (the mix.
  // bus-1 rule: renaming ids breaks every save for zero gain). Plane menus are
  // indices into PLANE_NAMES (append-only), 0 = none.
  const _PLANE_OPTS = ['—', ...PLANE_NAMES];
  const _planeOpt = n => _PLANE_OPTS.indexOf(n);
  const _slotDefaults = [['XY', 0.30], ['XZ', 0.20], ['YZ', 0.15], ['XW', 0.40], ['—', 0], ['—', 0], ['—', 0], ['—', 0]];
  for (let n = 1; n <= 8; n++) {
    const [plane, speed] = _slotDefaults[n - 1];
    ps.register({ id:`hypercube.slot${n}.plane`, type:'select', select:true, options:_PLANE_OPTS, value:_planeOpt(plane), label:`Slot ${n} plane`, group:'hypercube',
      help: 'Which rotation plane this slot turns. XY, XZ and YZ are ordinary 3D spins; planes with W, V, U … turn the cube through a higher dimension and only move once it has that many. Hover an entry for what it does.',
      optionHelp: ['— : this slot turns nothing', ...PLANE_HELP], displayOrder: PLANE_MENU_ORDER });
    ps.register({ id:HC_SLOT_SPEED[n - 1], type:'continuous', value:speed, min:-2.0, max:2.0, step:0.01, label:`Slot ${n} speed`, group:'hypercube',
      help: 'How fast this slot\'s plane turns — radians per second, negative turns the other way. Two slots on the same plane add. A plane in no slot turns at its default speed.' });
  }
  // Depth cue by w: far in the extra dimensions = dimmer and thinner, so a
  // rotating high-D cube reads as depth rather than a flat tangle.
  ps.register({ id:'hypercube.depthCue',      type:'continuous', value:0,    min:0,    max:1,    step:0.01,  label:'Depth Cue',    group:'hypercube' });
  ps.register({ id:'hypercube.edgeWidth',     type:'continuous', value:1.5,  min:0.5,  max:8.0,  step:0.1,   label:'Edge Width',   group:'hypercube' });
  ps.register({ id:'hypercube.renderMode',    type:'select',     options:['wireframe','points','both','off'], value:3, label:'Draw', group:'hypercube' });
  ps.register({ id:'hypercube.projMode',      type:'select',     options:['perspective','orthographic'],      value:0, label:'Proj Mode',    group:'hypercube' });
  ps.register({ id:'hypercube.faces.active',  type:'toggle',     value:0,                                    label:'Faces',        group:'hypercube' });
  ps.register({ id:'hypercube.faces.opacity', type:'continuous', value:0.5,  min:0.0,  max:1.0,  step:0.01,  label:'Face opacity', group:'hypercube' });
  ps.register({ id:'hypercube.faces.blend',   type:'select',     options:['Normal','Additive','Multiply','Subtract','Screen','Lighten','Darken','Exclusion'], value:0, label:'Face blend', group:'hypercube' });
  ps.register({ id:'hypercube.faces.hue',     type:'continuous', value:0,    min:0,    max:360,  step:1,     label:'Face hue',     group:'hypercube' });
  ps.register({ id:'hypercube.faces.sat',     type:'continuous', value:0,    min:0,    max:100,  step:1,     label:'Face sat',     group:'hypercube' });
  ps.register({ id:'hypercube.faces.texsrc',  type:'select',     options:OPT_SOURCES, value:0, label:'Face tex',   group:'hypercube' });
  ps.register({ id:'hypercube.faces.masksrc', type:'select',     options:OPT_SOURCES, value:0, label:'Face mask',  group:'hypercube' });
  ps.register({ id:'hypercube.faces.maskinv', type:'toggle',     value:0,                                    label:'Mask invert', group:'hypercube' });
  ps.register({ id:'hypercube.faces.masklvl', type:'continuous', value:1.0,  min:0.0,  max:4.0,  step:0.01,  label:'Mask level',  group:'hypercube' });
  ps.register({ id:'hypercube.inst.active',   type:'toggle',     value:0,                                    label:'Instancer',    group:'hypercube' });
  ps.register({ id:'hypercube.inst.geo',      type:'select',     options:['Sphere','Torus','Cube','Plane','Cylinder','Capsule','TorusKnot','Cone','Dodecahedron','Icosahedron','Octahedron','Tetrahedron','Ring','Model'], value:0, label:'Inst Geo', group:'hypercube' });
  ps.register({ id:'hypercube.inst.scale',    type:'continuous', value:0.08, min:0.01, max:2.0,  step:0.01,  label:'Inst Scale',   group:'hypercube' });
  ps.register({ id:'hypercube.inst.opacity',  type:'continuous', value:1.0,  min:0.0,  max:1.0,  step:0.01,  label:'Inst Opacity', group:'hypercube' });
  ps.register({ id:'hypercube.inst.texsrc',   type:'select',     options:OPT_SOURCES, value:0, label:'Inst tex', group:'hypercube' });
  // Off: the instancer REPLACES the 3D scene's geometry/model (and wears its
  // Material). On: both are visible — geometry keeps Transform and Material,
  // the instancer rides the same Transform with its own Inst tex/opacity.
  // GPU guard: instance count × shape vertices ≤ this many million a frame.
  ps.register({ id:'hypercube.inst.budget',   type:'continuous', value:9,    min:1,    max:64,   step:0.5,   label:'Inst Budget (M verts)', group:'hypercube' });
  ps.register({ id:'hypercube.inst.showGeo',  type:'toggle',     value:0,                                    label:'Show geometry', group:'hypercube' });
}
