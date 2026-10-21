/**
 * The Live GLSL ("Shader Code") wrapper: Blend Mode + Blend Amt applied inside
 * the user's own pass. Pure string work, no GL, so it can be compiled and
 * measured against a fixed input outside the render loop. Verified that way
 * on 2026-10-21: modes 0–7 and 14 against computed values on a 1x1 input,
 * all within 2/255, and the result passes the editor's ES 1.00 check.
 */
import { BLEND_PHOTO_FNS } from './index.js';

// Blend (glsl.mix) is done inside the shader's own pass: the user's main()
// is renamed and a wrapper mixes its result with the input. A separate mix
// pass would read the insert's input from the two-target ping-pong pool —
// the very target it may be writing — and cost a full-screen pass for it.
// Only the first `void main()` outside comments is renamed; a source without
// one compiles (or fails) exactly as written.
export function wrapGlslMain(src) {
  const re = /\bvoid\s+main\s*\(\s*(?:void\s*)?\)/;
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, (m) => " ".repeat(m.length));
  const at = code.search(re);
  if (at < 0) return src;
  const len = code.slice(at).match(re)[0].length;
  return src.slice(0, at) + "void imweb_user_main()" + src.slice(at + len) + GLSL_BLEND_TAIL;
}

// The layer blend modes, renamed imweb_* so a pasted shader that defines its
// own rgb2hsl or blendScreen still compiles. Names are read from the shared
// source, not listed, so a mode added there arrives here too. Bitwise modes
// (XOR/OR/AND) are done bit by bit in floats: the editor's compile check is
// GLSL ES 1.00, which has no integer bit operators — the layer shader is
// ES 3.00 and uses ^ | &; both truncate to 8 bits the same way.
export const GLSL_BLEND_TAIL = (() => {
  const names = [...BLEND_PHOTO_FNS.matchAll(/\b(?:vec3|float)\s+(\w+)\s*\(/g)].map((m) => m[1]);
  const fns = names.reduce(
    (src, n) => src.replace(new RegExp(`\\b${n}\\b`, "g"), `imweb_${n}`), BLEND_PHOTO_FNS);
  return `
uniform float uGlslMix;
uniform int uGlslBlend;
${fns}
float imweb_bitop(float x, float y, int op) {
float r = 0.0;
float p = 1.0;
for (int i = 0; i < 8; i++) {
  float bx = mod(floor(x / p), 2.0);
  float by = mod(floor(y / p), 2.0);
  float bit = op == 1 ? abs(bx - by) : (op == 2 ? max(bx, by) : bx * by);
  r += bit * p;
  p *= 2.0;
}
return r;
}
void main() {
imweb_user_main();
vec4 s = gl_FragColor;
vec4 i = texture2D(uTexture, vUv);
vec3 r = s.rgb;
if (uGlslBlend > 0 && uGlslBlend < 4) {
  vec3 a = floor(clamp(s.rgb, 0.0, 1.0) * 255.0);
  vec3 b = floor(clamp(i.rgb, 0.0, 1.0) * 255.0);
  r = vec3(imweb_bitop(a.r, b.r, uGlslBlend), imweb_bitop(a.g, b.g, uGlslBlend),
           imweb_bitop(a.b, b.b, uGlslBlend)) / 255.0;
} else if (uGlslBlend >= 4) {
  r = clamp(imweb_blendPhoto(uGlslBlend, s.rgb, i.rgb), 0.0, 1.0);
}
gl_FragColor = vec4(mix(i.rgb, r, uGlslMix), mix(i.a, s.a, uGlslMix));
}
`;
})();
