/**
 * Shader Code source audit.
 *
 * Why this exists. The Shader Code (GLSL) material has TWO uses a frame: the
 * insert at glsl.target, and the Shader Code SOURCE (35). One compiled
 * material, so every uniform that differs between the uses must be written by
 * EACH use, and the source must render into its own double buffer:
 *
 *   - the insert writes Blend Amt / Blend Mode (this._glslMix / _glslBlend);
 *   - the source writes 1 / 0 (raw shader — a source has no stage to blend on);
 *   - the source renders with _passTo into _glslSrcRT[cur ^ 1] and flips cur
 *     only AFTER the draw, so a self-read or a read by Growth sees last frame;
 *   - it renders after the mix buses and before layer resolution, gated on
 *     inputs.glslSrcNeeded, which main.js fills from the _srcUsed() fixpoint.
 *
 * Every way this breaks is a plausible picture, never an error: drop one
 * per-use write and the source silently wears the insert's Blend (or the
 * insert loses it after the first source render); render through _pass() and
 * the source lands in the ping-pong pair that the next pass overwrites; drop
 * the gate and Growth seeds from a frozen frame. None of it can throw from the
 * render loop, so it is checked here, statically.
 *
 * Run:  node tests/audit-glsl-source.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pipe = readFileSync(resolve(root, 'src/core/Pipeline.js'), 'utf8');
const main = readFileSync(resolve(root, 'src/main.js'), 'utf8');

let failures = 0;
const check = (label, cond, fix) => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}\n       fix: ${fix}`); failures++; }
};

/** Body of a method `name(` in Pipeline.js, up to the next 2-space-indented `}`. */
const method = (name) => {
  const at = pipe.search(new RegExp(`\\n  ${name}\\([^)]*\\)\\s*\\{`));
  if (at < 0) return '';
  return pipe.slice(at, pipe.indexOf('\n  }', at));
};

const ins = method('_applyCustomPass');
const src = method('_renderCustomSource');
const uni = method('setCustomUniforms');
const ren = method('render');

check('_applyCustomPass and _renderCustomSource exist', ins && src,
  'the two uses of the custom material were renamed — update this audit with them.');

check('insert writes Blend Amt per use (uGlslMix = this._glslMix)',
  /uGlslMix\.value\s*=\s*this\._glslMix\b/.test(ins),
  'set u.uGlslMix.value = this._glslMix in _applyCustomPass — the source use writes 1 and would leak into the insert.');
check('insert writes Blend Mode per use (uGlslBlend = this._glslBlend)',
  /uGlslBlend\.value\s*=\s*this\._glslBlend\b/.test(ins),
  'set u.uGlslBlend.value = this._glslBlend in _applyCustomPass.');
check('source writes raw Blend Amt (uGlslMix = 1)',
  /uGlslMix\.value\s*=\s*1\b/.test(src),
  'set u.uGlslMix.value = 1 in _renderCustomSource — otherwise the source wears the insert\'s Blend Amt.');
check('source writes raw Blend Mode (uGlslBlend = 0)',
  /uGlslBlend\.value\s*=\s*0\b/.test(src),
  'set u.uGlslBlend.value = 0 in _renderCustomSource.');
check('setCustomUniforms stores Blend, does not write the shared uniforms',
  /this\._glslMix\s*=/.test(uni) && !/uGlslMix\.value/.test(uni) && !/uGlslBlend\.value/.test(uni),
  'store vals[4]/vals[5] in this._glslMix/_glslBlend; the per-use writes apply them.');

check('source renders with _passTo, never through the ping-pong _pass()',
  /this\._passTo\(\s*this\._customMat/.test(src) && !/this\._pass\(/.test(src),
  'render into this._glslSrcRT[...] with _passTo — _pass() writes the shared ping-pong pair.');
const writeAt = src.search(/_glslSrcRT\[\s*this\._glslSrcCur\s*\^\s*1\s*\]/);
const flipAt = src.search(/this\._glslSrcCur\s*\^=\s*1/);
check('source writes the BACK buffer and flips only after the draw',
  writeAt >= 0 && flipAt > writeAt,
  'write _glslSrcRT[this._glslSrcCur ^ 1], then this._glslSrcCur ^= 1 — the double buffer is what makes a self-read safe.');

const busAt = ren.indexOf('this._mixCur[k] ^= 1');
const srcAt = ren.indexOf('this._renderCustomSource(');
const layerAt = ren.indexOf("p.get('layer.fg')");
check('render(): source after the mix buses, before layer resolution',
  busAt >= 0 && srcAt > busAt && layerAt > srcAt,
  'move the Shader Code source block between the mix-bus loop and "Resolve input textures".');
check('render(): source gated on inputs.glslSrcNeeded',
  /if\s*\(\s*inputs\.glslSrcNeeded\b[^)]*\)\s*\{[^}]*_renderCustomSource/.test(ren),
  'gate the source render on inputs.glslSrcNeeded so an unrouted source costs nothing.');

check('_resolveSource names the glsl key',
  /key === 'glsl'\)\s*return this\.customSourceTexture/.test(pipe),
  "add `if (key === 'glsl') return this.customSourceTexture;` to Pipeline._resolveSource.");
check('main.js fills the gate from the fixpoint (glslSrcNeeded: _srcUsed(GLSL_IDX))',
  /glslSrcNeeded:\s*_srcUsed\(GLSL_IDX\)/.test(main),
  'add glslSrcNeeded: _srcUsed(GLSL_IDX) to the inputs bag.');
check('main.js has a puller row for the source (it reads glsl.srcInput)',
  /\{\s*idx:\s*GLSL_IDX,\s*reads:\s*\[[^\]]*glsl\.srcInput/.test(main),
  'add { idx: GLSL_IDX, reads: [glsl.srcInput − 1] } to _pullers so its input is scheduled.');

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll Shader Code source checks passed.\n');
process.exit(failures ? 1 : 0);
