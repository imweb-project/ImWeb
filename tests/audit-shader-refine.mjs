/**
 * Runtime audit: the AI shader Refine path must send the editor's CURRENT code,
 * and the generate path must not.
 *
 * Why this exists. Before Refine, every "add to current code …" prompt produced
 * a brand-new shader, because the modal only ever called generateShader(prompt)
 * — the editor's source was never in the request at all. That failure is
 * invisible from the outside: a valid, good-looking shader comes back, compiles,
 * and renders. The only tell is that the thing you asked to keep is gone.
 *
 * So the invariant is not "refine works", it is "the current shader is in the
 * outgoing request body". That is checkable without a provider: stub fetch and
 * read what would have been sent.
 *
 * Run:  node tests/audit-shader-refine.mjs
 */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};
store.set('imweb-ai-config', JSON.stringify({
  activeProvider: 'anthropic',
  providers: { anthropic: { apiKey: 'sk-ant-audit', model: 'claude-sonnet-5' } },
}));

let sent = null;
globalThis.fetch = async (url, opts) => {
  sent = { url, body: JSON.parse(opts.body) };
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: '// uParams: A | B | C | D\nvoid main() { gl_FragColor = texture2D(uTexture, vUv); }' }],
    }),
  };
};

import { readFileSync } from 'node:fs';

const { refineShader, generateShader } = await import('../src/ai/AIFeatures.js');

const fails = [];
let ran = 0;
const check = (label, cond) => { ran++; if (!cond) fails.push(label); };

// A distinctive marker that can only reach the provider via currentCode.
const CURRENT = `// uParams: Speed | Shape Morph | Evolve | Hue Shift
mat2 rot2D_auditMarker(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
void main() { gl_FragColor = texture2D(uTexture, vUv) * uParam1; }`;

await refineShader('zoom in/out and 360 spin on a speed control', CURRENT);
const refineUser = sent.body.messages[0].content;
const refineSys  = sent.body.system;

check('refine must send the current shader body',        refineUser.includes('rot2D_auditMarker'));
check('refine must send the existing // uParams: line',  refineUser.includes('Speed | Shape Morph | Evolve | Hue Shift'));
check('refine must send the instruction',                refineUser.includes('360 spin'));
check('refine must use the refine system prompt',        refineSys.includes('REFINEMENT RULES'));
check('refine prompt must forbid starting over',         /NEVER start over/.test(refineSys));
check('refine prompt must demand the complete shader',   /COMPLETE shader/.test(refineSys));
// The uniform contract is shared with the generate prompt; a refine that lost it
// would emit redeclared uniforms and fail to compile.
check('refine prompt must carry the uniform contract',   refineSys.includes('uniform sampler2D tAudio'));
check('refine budget must exceed generate budget',       sent.body.max_tokens > 4000);

// The compile-recovery retry must still carry the original shader — otherwise a
// refine that fails to compile silently degrades into a from-scratch rewrite.
sent = null;
await refineShader('spin', CURRENT, 'broken code here', 'ERROR: undefined variable');
check('refine retry must still send the current shader', sent.body.messages[0].content.includes('rot2D_auditMarker'));
check('refine retry must send the compiler error',       sent.body.messages[0].content.includes('undefined variable'));

// Control: plain generation must stay a clean slate.
sent = null;
await generateShader('a kaleidoscope');
check('generate must NOT send editor code',      !sent.body.messages[0].content.includes('rot2D_auditMarker'));
check('generate must NOT use the refine prompt', !sent.body.system.includes('REFINEMENT RULES'));

// An empty editor must be refused before a request is spent.
sent = null;
let threw = false;
try { await refineShader('anything', '   \n  '); } catch { threw = true; }
check('empty editor must be refused', threw);
check('empty editor must cost no request', sent === null);


// ── Truncation and stop reasons ──────────────────────────────────────────────
//
// The failure this half exists for: a thinking model that exhausts max_tokens
// while still THINKING returns a 200 with no text block at all. That surfaced
// as "Empty response from the AI provider — check the model name, quota, or
// content filters", which is actively misleading — the model, key and quota
// were all fine and the shader was simply too long to redo in the budget.
//
// Worse, a truncation that DOES return partial code must never be injected:
// extractGlsl slices to the last closing brace, and a half-written shader has
// plenty of those, so it can pass as valid code and silently replace a working
// shader with a broken one. Truncation must throw, not return.

const PROVIDER_CASES = [
  {
    id: 'anthropic',
    cfg: { apiKey: 'sk-ant-audit', model: 'claude-sonnet-5' },
    // Thinking blocks only + max_tokens: the exact shape that produced the
    // misleading "Empty response" error.
    truncatedEmpty: { content: [{ type: 'thinking', thinking: 'still reasoning…' }], stop_reason: 'max_tokens' },
    truncatedPartial: { content: [{ type: 'text', text: 'void main() { gl_FragColor = vec4(0.0' }], stop_reason: 'max_tokens' },
    refused: { content: [], stop_reason: 'refusal' },
  },
  {
    id: 'gemini',
    cfg: { apiKey: 'AIzaAudit', model: 'gemini-3.1-pro' },
    truncatedEmpty: { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] },
    truncatedPartial: { candidates: [{ content: { parts: [{ text: 'void main() { gl_FragColor = vec4(0.0' }] }, finishReason: 'MAX_TOKENS' }] },
    refused: { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] },
  },
  {
    id: 'openai',
    cfg: { apiKey: 'sk-audit', model: 'gpt-4o' },
    truncatedEmpty: { choices: [{ message: { content: '' }, finish_reason: 'length' }] },
    truncatedPartial: { choices: [{ message: { content: 'void main() { gl_FragColor = vec4(0.0' }, finish_reason: 'length' }] },
    refused: { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] },
  },
  {
    id: 'ollama',
    cfg: { apiKey: 'http://localhost:11434', model: 'llama3.2' },
    truncatedEmpty: { message: { content: '' }, done_reason: 'length' },
    truncatedPartial: { message: { content: 'void main() { gl_FragColor = vec4(0.0' }, done_reason: 'length' },
    refused: null, // Ollama has no content filter — nothing to assert
  },
];

const useProvider = (id, pcfg) => store.set('imweb-ai-config', JSON.stringify({
  activeProvider: id, providers: { [id]: pcfg },
}));
// The config is read through a module-level singleton, so reach past it the
// same way the app would on a settings change.
const { AIFeatures } = await import('../src/ai/AIFeatures.js');

for (const c of PROVIDER_CASES) {
  const reply = (payload) => { globalThis.fetch = async () => ({ ok: true, json: async () => payload }); };
  const fresh = async () => {
    useProvider(c.id, c.cfg);
    // Re-import with a cache-buster so the config singleton reloads.
    return import(`../src/ai/AIFeatures.js?p=${c.id}${Math.random()}`);
  };

  {
    const m = await fresh();
    reply(c.truncatedEmpty);
    let msg = '';
    try { await m.refineShader('spin', CURRENT); } catch (e) { msg = e.message; }
    check(`${c.id}: truncation (no text) must throw`, !!msg);
    check(`${c.id}: truncation must say it ran out of room`, /ran out of room|unfinished/i.test(msg));
    check(`${c.id}: truncation must NOT blame quota/key alone`, !/^Empty response/.test(msg));
  }
  {
    const m = await fresh();
    reply(c.truncatedPartial);
    let threw = false, out = null;
    try { out = await m.refineShader('spin', CURRENT); } catch { threw = true; }
    // The critical one: partial code must never reach the editor.
    check(`${c.id}: truncation WITH partial code must still throw, not inject`, threw && out === null);
  }
  if (c.refused) {
    const m = await fresh();
    reply(c.refused);
    let msg = '';
    try { await m.refineShader('spin', CURRENT); } catch (e) { msg = e.message; }
    check(`${c.id}: refusal must be reported as a refusal`, /declined|filter/i.test(msg));
  }
}

// A clean finish must still work — the guards must not reject good responses.
useProvider('anthropic', { apiKey: 'sk-ant-audit', model: 'claude-sonnet-5' });
{
  const m = await import(`../src/ai/AIFeatures.js?ok=${Math.random()}`);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: '// uParams: A | B | C | D\nvoid main() { gl_FragColor = texture2D(uTexture, vUv); }' }],
    stop_reason: 'end_turn',
  }) });
  const code = await m.refineShader('spin', CURRENT);
  check('a complete response still returns code', /void\s+main/.test(code));
  check('thinking-first responses still find the text block', !code.includes('plan'));
}

// A provider that reports nothing recognisable must not be treated as truncated.
{
  const m = await import(`../src/ai/AIFeatures.js?unk=${Math.random()}`);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [], stop_reason: undefined }) });
  let msg = '';
  try { await m.refineShader('spin', CURRENT); } catch (e) { msg = e.message; }
  check('unknown stop reason is reported as unknown, not truncation', /stop reason: unknown/.test(msg));
}

// ── The WIRING, not just the function ────────────────────────────────────────
//
// Found by `npm run mutate`: every check above exercises refineShader()
// directly, so replacing main.js's `baseCode = refining ? getGlslSource()
// : null` with `= null` left this audit fully green while reproducing the
// original bug exactly — refine silently degrades to generate, returns a
// perfectly good shader, and the only tell is that your shader is gone.
// A correct function reached by a broken call site is still a broken feature.
{
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const site = main.slice(main.indexOf('aiGenBtn.addEventListener'));
  check('the refine call site is still present', site.length > 0);
  // Positive assertions: the editor source must be READ and PASSED at the site.
  check('refine mode reads the editor source for baseCode',
    /const baseCode\s*=\s*refining\s*\?\s*getGlslSource\(\)\s*:\s*null/.test(site));
  check('baseCode is handed to the generation runner',
    /_runAiGeneration\(promptText,\s*baseCode\)/.test(main));
  check('a non-null baseCode routes to refineShader',
    /baseCode\s*\n?\s*\?\s*\(p, pc, pe\) => refineShader\(p, baseCode, pc, pe\)/.test(main));
}

// Refine must have more room than generate: it re-emits the whole shader.
{
  const src = readFileSync(new URL('../src/ai/AIFeatures.js', import.meta.url), 'utf8');
  const gen = Number(src.match(/const GENERATE_TOKENS\s*=\s*(\d+)/)?.[1]);
  const ref = Number(src.match(/const REFINE_TOKENS\s*=\s*(\d+)/)?.[1]);
  check('GENERATE_TOKENS is declared', Number.isFinite(gen));
  check('REFINE_TOKENS is declared', Number.isFinite(ref));
  check('refine budget exceeds generate budget', ref > gen);
  // The observed failure was a real refine dying at 6000. Hold a floor so a
  // future "trim the budget" change has to argue with this line.
  check('refine budget is at least 12000 (a real refine died at 6000)', ref >= 12000);
}

if (fails.length) {
  console.error('FAIL audit-shader-refine:');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
// An audit that passes because its body never executed is the worst outcome
// (LEARNED.md 2026-08-15). Assert the check COUNT so a silently skipped
// section fails loudly instead of reporting all-clear.
const EXPECTED_CHECKS = 44;
if (ran !== EXPECTED_CHECKS) {
  console.error(`FAIL audit-shader-refine: ran ${ran} checks, expected ${EXPECTED_CHECKS} — a section was skipped or added without updating the count.`);
  process.exit(1);
}
console.log(`PASS audit-shader-refine — ${ran} checks: refine carries the editor source, generate does not, truncation throws on every provider`);
