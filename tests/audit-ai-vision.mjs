/**
 * Runtime audit: the canvas frame must reach every provider in ITS OWN image
 * envelope, and the narrator must actually be told to look at it.
 *
 * Why this exists. The four request shapes disagree on every detail of how an
 * image is attached:
 *
 *   Anthropic   content[] block {type:'image', source:{type:'base64', data}}
 *   Gemini      parts[]   {inline_data:{mime_type, data}}
 *   OpenAI-ish  content[] {type:'image_url', image_url:{url}}   ← full data: URL
 *   Ollama      message.images[]                                 ← raw base64
 *
 * Three take bare base64 and one takes a full data: URL, and a provider handed
 * the wrong envelope does NOT error — it ignores the image and answers from the
 * text alone. The narration still arrives, still reads plausibly, and is still
 * billed at vision prices; the only symptom is that it describes the patch
 * rather than the picture, which is exactly what it did before vision existed.
 * That is unfalsifiable by eye, so it is asserted here.
 *
 * Run:  node tests/audit-ai-vision.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};

const fails = [];
let ran = 0;
const check = (label, cond) => { ran++; if (!cond) fails.push(label); };

// A marker that can only appear in the request if the image was really carried.
const B64 = 'SUdOSVRFRF9GUkFNRV9NQVJLRVI=';
const IMAGE = { b64: B64, mime: 'image/jpeg' };

let sent = null;
const useProvider = (prov, model) => {
  store.set('imweb-ai-config', JSON.stringify({
    activeProvider: prov, providers: { [prov]: { apiKey: 'k', model } },
  }));
};
const reply = (payload) => {
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, json: async () => payload };
  };
};
const OK_REPLY = {
  content: [{ type: 'text', text: 'green tendrils' }], stop_reason: 'end_turn',
  candidates: [{ content: { parts: [{ text: 'green tendrils' }] }, finishReason: 'STOP' }],
  choices: [{ message: { content: 'green tendrils' }, finish_reason: 'stop' }],
  message: { content: 'green tendrils' }, done_reason: 'stop',
};
const fresh = (tag) => import(`../src/ai/AIFeatures.js?v=${tag}${Math.random()}`);

// ── Anthropic: an image content block, base64, no data: prefix ──
useProvider('anthropic', 'claude-sonnet-5'); reply(OK_REPLY);
{
  const m = await fresh('anth');
  await m.narrateState('FG=Camera', 'short', IMAGE);
  const content = sent.messages[0].content;
  check('anthropic: content becomes an array when an image is sent', Array.isArray(content));
  const img = content.find?.((b) => b.type === 'image');
  check('anthropic: an image block is present', !!img);
  check('anthropic: base64 is carried verbatim', img?.source?.data === B64);
  check('anthropic: source type is base64', img?.source?.type === 'base64');
  check('anthropic: media_type is set', img?.source?.media_type === 'image/jpeg');
  check('anthropic: NOT wrapped in a data: URL', !String(img?.source?.data).startsWith('data:'));
  check('anthropic: image precedes the text block',
    content.findIndex?.((b) => b.type === 'image') < content.findIndex?.((b) => b.type === 'text'));
  // Text-only must stay a plain string — regressing that would change every
  // non-vision call's request shape.
  sent = null;
  await m.narrateState('FG=Camera', 'short');
  check('anthropic: no image → content stays a plain string', typeof sent.messages[0].content === 'string');
}

// ── Gemini: inline_data inside parts ──
useProvider('gemini', 'gemini-3.1-pro'); reply(OK_REPLY);
{
  const m = await fresh('gem');
  await m.narrateState('FG=Camera', 'short', IMAGE);
  const parts = sent.contents[0].parts;
  const inline = parts.find((p) => p.inline_data);
  check('gemini: inline_data part present', !!inline);
  check('gemini: base64 carried verbatim', inline?.inline_data?.data === B64);
  check('gemini: mime_type (snake_case) is set', inline?.inline_data?.mime_type === 'image/jpeg');
  check('gemini: the text part survives alongside it', parts.some((p) => typeof p.text === 'string' && p.text.length));
  sent = null;
  await m.narrateState('FG=Camera', 'short');
  check('gemini: no image → a single text part', sent.contents[0].parts.length === 1);
}

// ── OpenAI shape: image_url, and this one DOES want the data: URL ──
useProvider('openai', 'gpt-4o'); reply(OK_REPLY);
{
  const m = await fresh('oai');
  await m.narrateState('FG=Camera', 'short', IMAGE);
  const user = sent.messages.find((x) => x.role === 'user');
  check('openai: user content becomes an array', Array.isArray(user.content));
  const img = user.content.find((c) => c.type === 'image_url');
  check('openai: an image_url part is present', !!img);
  check('openai: it IS a full data: URL (this shape differs)',
    img?.image_url?.url === `data:image/jpeg;base64,${B64}`);
  sent = null;
  await m.narrateState('FG=Camera', 'short');
  check('openai: no image → content stays a plain string',
    typeof sent.messages.find((x) => x.role === 'user').content === 'string');
}

// ── Ollama: a sibling images[] array of raw base64 ──
useProvider('ollama', 'llava'); reply(OK_REPLY);
{
  const m = await fresh('oll');
  await m.narrateState('FG=Camera', 'short', IMAGE);
  const user = sent.messages.find((x) => x.role === 'user');
  check('ollama: images[] present on the user message', Array.isArray(user.images));
  check('ollama: raw base64, not a data: URL', user.images?.[0] === B64);
  check('ollama: content stays the text', typeof user.content === 'string' && user.content.length > 0);
  sent = null;
  await m.narrateState('FG=Camera', 'short');
  check('ollama: no image → no images key at all',
    !('images' in sent.messages.find((x) => x.role === 'user')));
}

// ── The prompt must change with the image ──
// Sending a picture while still asking "describe the signal path" produces the
// same narration as before at vision prices — the expensive no-op.
useProvider('anthropic', 'claude-sonnet-5'); reply(OK_REPLY);
{
  const m = await fresh('prompt');
  await m.narrateState('FG=Camera', 'short', IMAGE);
  const visionSys = sent.system;
  sent = null;
  await m.narrateState('FG=Camera', 'short');
  const textSys = sent.system;
  check('the narrator system prompt differs when an image is attached', visionSys !== textSys);
  check('the vision prompt makes the IMAGE the subject', /what you SEE|the image is the subject/i.test(visionSys));
  check('the vision prompt forbids reciting parameters', /Do not list parameters/i.test(visionSys));
  check('the vision prompt handles an empty frame', /black or nearly empty/i.test(visionSys));
  check('the text-only prompt is unchanged in spirit', /signal path/i.test(textSys));

  // Coach likewise.
  sent = null;
  await m.coachSuggestion('changed displace.amount', IMAGE);
  const coachVision = sent.system;
  sent = null;
  await m.coachSuggestion('changed displace.amount');
  check('the coach prompt differs when it can see', coachVision !== sent.system);
  check('the seeing coach judges the image first', /OUTPUT FRAME/i.test(coachVision));
}

// ── Vision must be OFF by default and gated per feature ──
{
  store.clear();
  const m = await fresh('cfg');
  const v = m.getVisionConfig();
  check('vision defaults to off for the narrator', v.narrator === false);
  check('vision defaults to off for the coach', v.coach === false);
}

// ── Capture correctness (source-level: main.js needs a DOM to run) ──
const main = readFileSync(resolve(root, 'src/main.js'), 'utf8');
check('the renderer preserves the drawing buffer (a WebGL canvas reads back blank otherwise)',
  /preserveDrawingBuffer:\s*true/.test(main));
const capStart = main.indexOf('function captureVisionFrame()');
check('captureVisionFrame exists', capStart !== -1);
const cap = capStart === -1 ? '' : main.slice(capStart, capStart + 1400);
check('capture downscales rather than sending the full canvas', /VISION_W/.test(cap));
check('capture encodes JPEG, not PNG', /image\/jpeg/.test(cap));
check('capture strips the data: prefix before sending', /indexOf\("?,"?\)|slice\(comma \+ 1\)/.test(cap));
check('a tainted canvas degrades to text instead of throwing', /catch\s*\{/.test(cap));
// The gate: capture must be conditional on the vision config, or every
// narration pays for an image whether or not it was asked for.
// Read the narrator body rather than pinning one spelling: the gate moved
// into a `seeing` local when the dirty-check landed, and an audit that fails
// on correct code teaches people to edit the audit.
{
  const nStart = main.indexOf('async function _runNarrator()');
  check('the narrator loop is still present', nStart !== -1);
  const nBody = nStart === -1 ? '' : main.slice(nStart, nStart + 2600);
  check('the narrator reads the vision setting', /getVisionConfig\(\)\.narrator/.test(nBody));
  check('narrator capture is gated on it, never unconditional',
    /seeing \? captureVisionFrame\(\) : null/.test(nBody)
    && !/^\s*const frame = captureVisionFrame\(\);/m.test(nBody));
}
check('coach capture is gated on the vision setting',
  /getVisionConfig\(\)\.coach \? captureVisionFrame\(\) : null/.test(main));

// ── Refine with vision ───────────────────────────────────────────────────────
// The frame must reach the refine request, the prompt must tell the model to
// READ it, and the compile-recovery retry must deliberately NOT carry it.
useProvider('anthropic', 'claude-sonnet-5'); reply(OK_REPLY);
{
  const m = await fresh('refvis');
  const SHADER = 'void main(){ gl_FragColor = texture2D(uTexture, vUv); }';

  await m.refineShader('more contrast', SHADER, null, null, IMAGE);
  const seeingSys = sent.system;
  const content = sent.messages[0].content;
  check('refine+vision: the frame reaches the request', Array.isArray(content)
    && content.some((b) => b.type === 'image' && b.source?.data === B64));
  check('refine+vision: the shader is still sent', JSON.stringify(content).includes('gl_FragColor'));
  check('refine+vision: prompt tells the model the image IS the current output',
    /CURRENT output of the shader/i.test(seeingSys));
  check('refine+vision: prompt says read the image before the code',
    /Read the image before the code/i.test(seeingSys));
  check('refine+vision: prompt forbids describing the image',
    /Do not describe the image/i.test(seeingSys));
  check('refine+vision: the base refine rules are still in force',
    /NEVER start over/.test(seeingSys) && /COMPLETE shader/.test(seeingSys));
  check('refine+vision: the uniform contract survives',
    seeingSys.includes('uniform sampler2D tAudio'));

  // Without an image the prompt must revert — otherwise every text-only refine
  // is told to look at a picture it was never given.
  sent = null;
  await m.refineShader('more contrast', SHADER);
  check('refine without an image uses the plain refine prompt',
    !/CURRENT output of the shader/i.test(sent.system));
  check('refine without an image sends no image block',
    typeof sent.messages[0].content === 'string');

  // The compile retry must drop the frame: the compiler error answers the
  // question, and the last frame is of the shader that FAILED.
  sent = null;
  await m.refineShader('more contrast', SHADER, 'broken', 'ERROR: undefined x', IMAGE);
  check('the compile-recovery retry drops the image',
    typeof sent.messages[0].content === 'string'
    || !sent.messages[0].content.some?.((b) => b.type === 'image'));
  check('the compile-recovery retry still carries the compiler error',
    JSON.stringify(sent.messages[0].content).includes('undefined x'));
}

// Shader vision is a remembered preference, off by default.
{
  store.clear();
  const m = await fresh('shadercfg');
  check('shader vision defaults to off', m.getVisionConfig().shader === false);
  m.setVisionShader(true);
  check('setVisionShader persists', m.getVisionConfig().shader === true);
}

// Gating in the modal: the frame is captured only when the box is ticked, and
// only on a refine — a new shader has no current output to judge.
check('the shader frame is gated on the checkbox AND refine mode',
  /refining && aiSeeCb\.checked \? captureVisionFrame\(\) : null/.test(main));
check('the captured frame is passed into the generation runner',
  /_runAiGeneration\(promptText, baseCode, seeFrame\)/.test(main));
check('a non-null image routes to refineShader with it',
  /refineShader\(p, baseCode, pc, pe, image\)/.test(main));

// ── The narrator dirty-check ─────────────────────────────────────────────────
//
// The narrator fires on a timer forever, so an unchanged patch used to be
// re-described every interval for the life of the session — the same sentence,
// billed each time, for as long as the button stayed lit.
//
// The subtlety is that a params-only check is WRONG once vision is on: a live
// camera, a playing movie, a feedback loop and any running LFO all move the
// picture while every parameter sits still. A params-only skip would fall
// silent over exactly the most visually active patches — the ones most worth
// narrating. Hence the frame hash.
{
  const nStart = main.indexOf('async function _runNarrator()');
  const nBody = nStart === -1 ? '' : main.slice(nStart, nStart + 2600);
  check('the narrator compares against the last narrated snapshot',
    /_lastNarratedSnapshot/.test(nBody));
  check('it also compares the FRAME when vision is on (params alone are not enough)',
    /_lastNarratedHash/.test(nBody) && /hammingFrac/.test(nBody));
  check('an unchanged patch returns without calling the provider',
    /paramsSame && frameSame/.test(nBody) && /return;/.test(nBody));
  check('a skipped tick still re-arms the timer (the narrator must not stop)',
    (nBody.match(/setTimeout\(_runNarrator/g) ?? []).length >= 2);
  // Both ends guarded: an unguarded `a > b` is TRUE when b is absent (-1), so
  // it would pass on a narrator with no provider call at all.
  const iRecord = nBody.indexOf('_lastNarratedSnapshot = snapshot');
  const iCall = nBody.indexOf('await narrateState');
  check('the narrator still calls the provider', iCall !== -1);
  check('and still records what it narrated', iRecord !== -1);
  check('state is recorded only AFTER a successful call — a failed one must not mark it narrated',
    iRecord !== -1 && iCall !== -1 && iRecord > iCall);
  check('the first run is never skipped (null sentinel, not an empty string)',
    /_lastNarratedSnapshot !== null/.test(nBody));

  // The hash itself must be able to tell two pictures apart, and must treat an
  // unreadable canvas as "changed" rather than silently skipping forever.
  const hStart = main.indexOf('function frameHash()');
  check('frameHash exists', hStart !== -1);
  const hBody = hStart === -1 ? '' : main.slice(hStart, hStart + 1200);
  check('the hash is computed from luminance, not one channel', /0\.299/.test(hBody));
  check('the hash thresholds against the frame mean (an average hash)', /mean/.test(hBody));
  check('a tainted canvas returns null rather than a hash of nothing',
    /catch\s*\{[\s\S]{0,80}return null/.test(hBody));
  check('an unknown hash counts as CHANGED, so a failure cannot silence it',
    /if \(!a \|\| !b \|\| a\.length !== b\.length\) return 1;/.test(main));
  check('the change threshold is a named constant, not a magic number',
    /FRAME_CHANGE_THRESHOLD/.test(main));
}

const EXPECTED_CHECKS = 70;
if (ran !== EXPECTED_CHECKS) {
  console.error(`FAIL audit-ai-vision: ran ${ran} checks, expected ${EXPECTED_CHECKS} — a section was skipped or added without updating the count.`);
  process.exit(1);
}
if (fails.length) {
  console.error('FAIL audit-ai-vision:');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log(`PASS audit-ai-vision — ${ran} checks: the frame reaches all four providers in their own envelope, and the prompt changes with it`);
