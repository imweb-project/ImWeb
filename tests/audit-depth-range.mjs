/**
 * 3D Depth range audit — the Distance map must span the scene, not the camera.
 *
 * three's stock depth output is 1 − window z. With the 3D camera's near 0.01
 * and far 1000, an object 5 units away comes out at 0.002: one grey level
 * above black, so 3D Depth displaced nothing and looked empty from the day it
 * shipped until it was measured on 2026-11-18. SceneManager now rewrites that
 * one line of three's depth shader to stretch the scene's own depth over
 * white…black.
 *
 * That rewrite is a string replace inside onBeforeCompile. If a three.js
 * upgrade rewords the line, the replace finds nothing and 3D Depth goes black
 * again with no error a reader would connect to it. So this audit takes the
 * anchor OUT OF SceneManager.js (never retyped here) and looks for it in the
 * installed three.
 *
 * Run:  node tests/audit-depth-range.mjs
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

const fails = [];
let checks = 0;
const check = (msg, ok) => { checks++; if (!ok) fails.push(msg); };

const src = readFileSync(new URL('../src/scene3d/SceneManager.js', import.meta.url), 'utf8');

// The anchor, as SceneManager spells it.
const m = src.match(/const stock = '([^']+)';/);
check('SceneManager names the stock line it replaces', !!m);
const anchor = m?.[1] ?? '';
check('the anchor is the depth output line, not something shorter', anchor.includes('fragCoordZ') && anchor.includes('gl_FragColor'));

const frag = THREE.ShaderLib.depth.fragmentShader;
check('installed three still has that exact line in its depth shader', anchor.length > 0 && frag.includes(anchor));
check('…exactly once (a second copy would be left untouched)', anchor.length > 0 && frag.split(anchor).length === 2);
check('the depth shader includes <packing>', frag.includes('#include <packing>'));
check('<packing> provides perspectiveDepthToViewZ', THREE.ShaderChunk.packing.includes('float perspectiveDepthToViewZ('));

check('a missing anchor is reported, not skipped silently', /includes\(stock\)\) \{[\s\S]{0,400}console\.error\(/.test(src));
check('the range uniforms are wired', ['uDepthNear', 'uDepthFar', 'uCamNear', 'uCamFar'].every(u => src.includes(`shader.uniforms.${u}`)));
check('the range is set from the scene bounds in the depth pass', /_depthBox\.setFromObject\(this\.scene\)/.test(src) && /_depthRange\.far\.value\s*=/.test(src));
check('the map is clamped, so nothing can be clipped out of it', /clamp\( \( viewDist - uDepthNear \)/.test(src));

// The arithmetic, with the camera's real planes read from the source.
const cam = src.match(/new THREE\.PerspectiveCamera\(\s*[\d.]+\s*,[^,]+,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
check('the 3D camera planes can be read from the source', !!cam);
const near = +cam?.[1], far = +cam?.[2];
const windowZ = (d) => 0.5 * ((far + near) / (far - near) - (2 * far * near) / ((far - near) * d)) + 0.5;
const viewDist = (z) => (near * far) / (far - (2 * z - 1 + 1) / 2 * (far - near)); // inverse of windowZ
const d = 5, r = 1;
check('positive control: the stock output at 5 units is under one grey level', (1 - windowZ(d)) < 1 / 255);
check('inverse recovers the distance', Math.abs(viewDist(windowZ(d)) - d) < 1e-6);
const remap = (x) => 1 - Math.min(1, Math.max(0, (x - (d - r)) / (2 * r)));
check('remapped: front of the scene is white, middle mid-grey, back black',
  remap(viewDist(windowZ(d - r))) > 0.999 && Math.abs(remap(viewDist(windowZ(d))) - 0.5) < 1e-3 && remap(viewDist(windowZ(d + r))) < 0.001);

if (fails.length) {
  console.error(`audit-depth-range: FAIL (${fails.length} of ${checks})`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`audit-depth-range: PASS (${checks} checks)`);
