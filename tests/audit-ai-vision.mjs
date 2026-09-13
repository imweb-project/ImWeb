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
// Capture must be conditional on the vision config, or every narration pays
// for an image whether or not it was asked for. Both consumers are checked in
// the change-gate section below, per feature — asserting it here as well would
// be a second copy of the same rule, pinned to one spelling.
check('no unconditional frame capture on a timer path',
  !/^\s*const frame = captureVisionFrame\(\);/m.test(main));

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
// Tolerant of TRAILING arguments, strict about position. Pinning exact arity
// broke twice in this session — once when vision added an image parameter and
// again when streaming added onDelta — and an audit that fails on correct code
// teaches people to edit the audit rather than the code.
check('the captured frame is passed into the generation runner as its 3rd argument',
  /_runAiGeneration\(promptText,\s*baseCode,\s*seeFrame\b/.test(main));
check('a non-null image routes to refineShader in the image position',
  /refineShader\(p,\s*baseCode,\s*pc,\s*pe,\s*image\b/.test(main));

// ── The change gate (Narrator AND Coach) ────────────────────────────────────
//
// Both fire on a timer forever. Untouched, each spent a call every interval
// whether or not anything had moved — the Narrator re-describing an unchanged
// patch, the Coach repeating the same advice for as long as the button stayed
// lit.
//
// The subtlety that makes this more than a string compare: once vision is on, a
// params-only check is WRONG. A live camera, a playing movie, a feedback loop
// and any running LFO all move the picture while every parameter sits still, so
// a params-only skip would fall silent over precisely the most visually active
// patches — the ones most worth describing. Hence the frame hash.
//
// ONE gate serves both. A copy per feature is how CLAUDE.md's near-duplicates
// accrue, and the two would drift the first time the threshold is tuned.
{
  check('the gate is written once, not once per feature',
    (main.match(/function makeChangeGate\(\)/g) ?? []).length === 1);
  check('both features take one', (main.match(/makeChangeGate\(\)/g) ?? []).length === 3); // 1 def + 2 uses
  check('the narrator has a gate', /_narratorGate = makeChangeGate\(\)/.test(main));
  check('the coach has one too', /_coachGate = makeChangeGate\(\)/.test(main));

  const gStart = main.indexOf('function makeChangeGate()');
  check('the gate body is readable', gStart !== -1);
  const gBody = gStart === -1 ? '' : main.slice(gStart, gStart + 1200);
  check('it compares the text the feature would send', /text === lastText/.test(gBody));
  check('it compares the FRAME as well when vision is on',
    /hammingFrac\(hash, lastHash\)/.test(gBody) && /seeing \? frameHash\(\) : null/.test(gBody));
  check('the frame comparison uses the named threshold, not a magic number',
    /FRAME_CHANGE_THRESHOLD/.test(gBody));
  check('the first run is never skipped (null sentinel, not an empty string)',
    /lastText !== null/.test(gBody));
  check('committing is a separate step from checking',
    /commit: \(\) => \{ lastText = text; lastHash = hash; \}/.test(gBody));

  // Each consumer must skip, re-arm, and commit only after a successful call.
  for (const [name, fn, cfg] of [
    ['narrator', 'async function _runNarrator()', 'getNarratorConfig'],
    ['coach', 'async function _runCoach()', 'getCoachConfig'],
  ]) {
    const i = main.indexOf(fn);
    check(`${name}: the loop is present`, i !== -1);
    const body = i === -1 ? '' : main.slice(i, i + 1800);
    check(`${name}: consults the gate`, /const gate = _\w+Gate\(snapshot, seeing\)/.test(body));
    check(`${name}: returns without calling the provider when clean`,
      /if \(gate\.clean\) \{/.test(body));
    check(`${name}: a skipped tick still re-arms the timer (it must not stop)`,
      (body.match(new RegExp(`${cfg}\\(\\)\\.interval`, 'g')) ?? []).length >= 2);
    const iCommit = body.indexOf('gate.commit()');
    const iCall = body.search(/await (narrateState|coachSuggestion)\(/);
    check(`${name}: still calls the provider`, iCall !== -1);
    check(`${name}: commits only AFTER a successful call — a failure must not mark it handled`,
      iCommit !== -1 && iCall !== -1 && iCommit > iCall);
    check(`${name}: captures the frame only when its own vision flag is set`,
      /const seeing = getVisionConfig\(\)\.\w+;/.test(body)
      && /seeing \? captureVisionFrame\(\) : null/.test(body));
  }

  // The hash must tell two pictures apart, and an unreadable canvas must count
  // as CHANGED rather than silencing the feature forever.
  const hStart = main.indexOf('function frameHash()');
  check('frameHash exists', hStart !== -1);
  const hBody = hStart === -1 ? '' : main.slice(hStart, hStart + 1200);
  check('the hash is computed from luminance, not one channel', /0\.299/.test(hBody));
  check('the hash thresholds against the frame mean (an average hash)', /mean/.test(hBody));
  check('a tainted canvas returns null rather than a hash of nothing',
    /catch\s*\{[\s\S]{0,80}return null/.test(hBody));
  check('an unknown hash counts as CHANGED, so a failure cannot silence it',
    /if \(!a \|\| !b \|\| a\.length !== b\.length\) return 1;/.test(main));
}

// ── The activity snapshot must be STABLE for an unchanged patch ─────────────
//
// Found by measuring: the Coach's gate suppressed nothing on any patch with a
// controller running. `recentChanges` is one entry per onChange and every
// controlled param fires every frame, so a single LFO put its id in the list
// hundreds of times in an order that shifted as entries aged out — the snapshot
// string could never equal the previous one, and the gate could never fire.
// It also meant the model was handed "displace.amount" ×300 instead of a
// legible summary.
{
  const m = await fresh('activity');
  const psm = await import('../src/controls/ParameterSystem.js');
  const ps = new psm.ParameterSystem();
  psm.registerCoreParameters(ps);

  const flood = (id, n) => Array.from({ length: n }, (_, i) => ({ id, t: i }));
  const a = m.buildActivitySnapshot(flood('displace.amount', 300), ps);
  const b = m.buildActivitySnapshot(flood('displace.amount', 120), ps);
  check('a repeated id appears once, not once per event', !/displace\.amount.*displace\.amount/.test(a));
  check('the same touched SET renders identically however many events it produced', a === b);

  // Insertion order must not matter either — entries age out of the front.
  const x = m.buildActivitySnapshot([{ id: 'keyer.white', t: 1 }, { id: 'blend.amount', t: 2 }], ps);
  const y = m.buildActivitySnapshot([{ id: 'blend.amount', t: 1 }, { id: 'keyer.white', t: 2 }], ps);
  check('order of arrival does not change the snapshot', x === y);

  // And it must still be a live signal, not a constant.
  const touched = m.buildActivitySnapshot([{ id: 'keyer.active', t: 1 }], ps);
  const idle = m.buildActivitySnapshot([], ps);
  check('a touched patch still differs from an idle one', touched !== idle);
  check('an idle patch says so', /Recently changed: nothing/.test(idle));
  check('a touched param leaves the untouched list', !/Untouched:[^.]*keyer\.active/.test(touched));
}

// ── The Coach log ────────────────────────────────────────────────────────────
// The toast is deliberately transient (2.5s, then fades, click-through) so it
// cannot sit over the canvas during a performance. That makes a retrievable
// copy necessary rather than optional: a suggestion glanced away from was
// otherwise gone for good.
{
  store.clear();
  const m = await fresh('coachlog');
  check('an empty log reads as an empty array, not null', Array.isArray(m.getCoachLog()) && m.getCoachLog().length === 0);

  m.logCoachSuggestion('Try routing Noise to FG');
  m.logCoachSuggestion('Increase feedback.hor to drift');
  check('suggestions are kept', m.getCoachLog().length === 2);
  check('newest is first', m.getCoachLog()[0].text === 'Increase feedback.hor to drift');
  check('each entry carries a timestamp', typeof m.getCoachLog()[0].ts === 'number');

  // Errors must not be kept — filling the log with "⚠ Coach error" would bury
  // the advice it exists to preserve.
  m.logCoachSuggestion('⚠ Coach error: 401');
  m.logCoachSuggestion('⚠ Coach: empty response from AI — try a different model');
  check('error toasts are NOT logged', m.getCoachLog().length === 2);
  m.logCoachSuggestion('   ');
  check('blank suggestions are not logged', m.getCoachLog().length === 2);

  // A repeat says nothing new; it should move rather than stack.
  m.logCoachSuggestion('Try routing Noise to FG');
  check('a repeated suggestion is not duplicated', m.getCoachLog().length === 2);
  check('and it moves to the top rather than staying put',
    m.getCoachLog()[0].text === 'Try routing Noise to FG');

  // Capped, or the panel becomes a scrollback.
  for (let i = 0; i < 20; i++) m.logCoachSuggestion(`suggestion number ${i}`);
  check('the log is capped', m.getCoachLog().length <= 8);
  check('the cap keeps the NEWEST, not the oldest', m.getCoachLog()[0].text === 'suggestion number 19');

  m.clearCoachLog();
  check('clear empties it', m.getCoachLog().length === 0);
}

// The log must be written where the toast is shown, and rendered safely.
check('the coach loop logs what it shows', /logCoachSuggestion\(msg\)/.test(main));
check('and tells the panel so it can refresh while open',
  /dispatchEvent\(new CustomEvent\('imweb-coach'\)\)/.test(main));
{
  const ui = readFileSync(resolve(root, 'src/ui/UI.js'), 'utf8');
  check('the panel listens for it', /addEventListener\('imweb-coach'/.test(ui));
  // Model output must never be interpolated as markup.
  // Comments stripped FIRST (LEARNED.md 2026-08-15): the line that sets this
  // safely is commented "textContent, never innerHTML", and that comment made
  // the check fail against perfectly correct code.
  const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const i = uiCode.indexOf('ai-coach-log-text');
  check('the coach log render is present', i !== -1);
  const near = i === -1 ? '' : uiCode.slice(i, i + 320);
  check('suggestion text is set with textContent, never innerHTML',
    /textContent = e\.text/.test(near) && !/innerHTML/.test(near));
}

const EXPECTED_CHECKS = 104;
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
