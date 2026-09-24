/**
 * Output-copies audit.
 *
 * Why this exists. Every copy of the WebGL output canvas into a 2D context
 * must composite it over black — through _drawOutputOpaque, which fills black
 * and then draws. The one exception is a canvas created fresh for the copy
 * and encoded as JPEG (capturePresetThumb): nothing earlier is under it, and
 * JPEG flattens onto black anyway.
 *
 * What went wrong. The output canvas carries alpha. three.js (r163+) always
 * creates its context with alpha:true — `alpha:false` in the renderer options
 * now only makes the clear opaque — and with Particles behind a 3D scene 28%
 * of the output was fully transparent and most of the rest partly. The
 * recorder copied it into a REUSED record canvas with a bare drawImage, under
 * a comment saying a full-cover drawImage writes every pixel so no clear was
 * needed. drawImage blends: every earlier frame survived under the
 * transparent pixels. A 7-minute recording came out as a washed-out blue
 * haze with frozen grey 3D ghosts around it, while the live view (the canvas
 * on a black page) was clean. Measured on a test recording: particle-area
 * brightness 141 → 147 and rising before the fix, a steady 85 → 80 after.
 * Four more reused canvases copied the same way: the spectral-image grab,
 * the Draw layer's Output-ink cache, the AI vision frame and the frame hash.
 *
 * Why static. The failure is a plausible picture, not an error, and only
 * shows once the output has transparency — a check would have to reproduce
 * a particular source routing. The rule is about the source text: no bare
 * copy of `canvas` may exist outside the two allowed places.
 *
 * Run:  node tests/audit-output-copies.mjs [path/to/main.js]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stripComments } from './lib/source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? resolve(root, 'src/main.js');
const src = stripComments(readFileSync(file, 'utf8'));

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

// [start, end) of a function declaration's body, brace-balanced. A missing
// function is null — never -1, which would slice most of the file.
function bodyOf(name) {
  const m = src.match(new RegExp(`function\\s+${name}\\s*\\(`));
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return [open, i + 1];
  }
  return null;
}
const lineOf = i => src.slice(0, i).split('\n').length;

console.log('\noutput-canvas copies composite over black');

const helper = bodyOf('_drawOutputOpaque');
check('_drawOutputOpaque exists', !!helper, 'the helper every output copy goes through is gone');
if (helper) {
  const body = src.slice(helper[0], helper[1]);
  const fill = body.search(/\.fillRect\s*\(/);
  const draw = body.search(/\.drawImage\s*\(\s*canvas\b/);
  check('the helper fills before it draws', fill >= 0 && draw > fill,
    'fillRect (after fillStyle = black) must come before drawImage(canvas…), or transparent output pixels keep earlier frames');
  check('the helper fills with black', /fillStyle\s*=\s*["'](#000|#000000|black)["']/.test(body),
    'the page shows the canvas over black; any other fill changes the recorded picture');
}

const thumb = bodyOf('capturePresetThumb');
const allowed = [helper, thumb].filter(Boolean);
if (thumb) {
  const body = src.slice(thumb[0], thumb[1]);
  check('the thumbnail exception draws into a canvas it just created',
    /document\.createElement\(\s*["']canvas["']\s*\)/.test(body) && /image\/jpeg/.test(body),
    'capturePresetThumb is exempt only because its canvas is fresh and JPEG-encoded; route it through _drawOutputOpaque otherwise');
}

const bare = [...src.matchAll(/\.drawImage\s*\(\s*canvas\s*,/g)]
  .filter(m => !allowed.some(([a, b]) => m.index >= a && m.index < b));
check(`no bare drawImage(canvas, …) outside the helper (${bare.length} found)`, bare.length === 0,
  bare.map(m => `line ${lineOf(m.index)}`).join(', ') +
  ' — replace with _drawOutputOpaque(ctx, w, h): a bare copy of the output leaves earlier frames under its transparent pixels');

// The five known consumers still use it — a rename or a refactor that drops
// the call would otherwise pass the "no bare copy" check by deleting the copy.
const uses = (src.match(/_drawOutputOpaque\s*\(/g) ?? []).length - 1; // minus the declaration
check(`the helper is used by the recorder and the four other copies (${uses} calls)`, uses >= 5,
  'expected _recBlit, the spectral grab, the Output-ink cache, the vision frame and the frame hash');

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll output-copy checks passed.\n');
process.exit(failures ? 1 : 0);
