/**
 * Runtime audit: a model's output ceiling is LEARNED from the provider's own
 * rejection, remembered per model, and honoured on both routers.
 *
 * Why this exists. The shader paths ask for generous room (32K generate, 48K
 * refine) because thinking models spend most of it reasoning. On 2026-10-20
 * DeepSeek and Kimi both died at the old 8000: Kimi thought for 153 s and ran
 * out before finishing the code, and the error told the performer to "shorten
 * the shader", which they had nothing to do with. But some models refuse a
 * request above their own maximum (8192 on older DeepSeek and Gemini 2.0
 * Flash). A hand-kept table of those maxima would rot as fast as the model
 * lists did, so the router reads the cap out of the error, retries once, and
 * stores it under that model.
 *
 * Every way this breaks is silent:
 *   - parse the wrong number (the 32000 we asked for, or a "1" from "[1, 8192]")
 *     and every later request is either refused again or starved;
 *   - learn from a RATE LIMIT ("8,000 output tokens per minute") and every
 *     later request on that model is quietly capped for no reason;
 *   - store per provider instead of per model and switching model inherits a
 *     ceiling that is not its own;
 *   - apply the cap only on _callRaw and the streaming path keeps asking for
 *     32000, failing over to the slow path on every single request;
 *   - report the REQUESTED budget in the truncation message, not the granted
 *     one, so "ran out at 32000" is shown for a call that had 8192.
 *
 * Run:  node tests/audit-ai-output-caps.mjs
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

const useProvider = (prov, model) => store.set('imweb-ai-config', JSON.stringify({
  activeProvider: prov, providers: { [prov]: { apiKey: 'k', model } },
}));
const savedCaps = (prov) => JSON.parse(store.get('imweb-ai-config')).providers[prov].outputCaps ?? {};
const fresh = (tag) => import(`../src/ai/AIFeatures.js?${tag}${Math.random()}`);

const SHADER = '```glsl\nvoid main(){ gl_FragColor = vec4(1.0); }\n```';

// Real wording from each family's "too many output tokens" rejection.
const SHAPES = {
  deepseek: {
    model: 'deepseek-flash',
    limitMsg: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]',
    asked: (b) => b.max_tokens,
    ok: (stop = 'stop') => ({ choices: [{ message: { content: SHADER }, finish_reason: stop }],
                              usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  },
  anthropic: {
    model: 'claude-old',
    limitMsg: 'max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-old',
    asked: (b) => b.max_tokens,
    ok: () => ({ content: [{ type: 'text', text: SHADER }], stop_reason: 'end_turn',
                 usage: { input_tokens: 1, output_tokens: 1 } }),
  },
  gemini: {
    model: 'gemini-2.0-flash',
    limitMsg: 'The maximum number of output tokens for maxOutputTokens is 8192 (requested 32000)',
    asked: (b) => b.generationConfig?.maxOutputTokens,
    ok: () => ({ candidates: [{ content: { parts: [{ text: SHADER }] }, finishReason: 'STOP' }],
                 usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
  },
};

/** A provider that refuses anything above `cap`, recording every budget asked for. */
function mockProvider(shape, cap, { errMsg = shape.limitMsg, status = 400, okBody } = {}) {
  const seen = [];
  globalThis.fetch = async (_url, opt) => {
    const n = shape.asked(JSON.parse(opt.body));
    seen.push(n);
    if (n > cap) return { ok: false, status, json: async () => ({ error: { message: errMsg } }) };
    return { ok: true, json: async () => okBody ?? shape.ok() };
  };
  return seen;
}

// 1. Every shape: learn on the first refusal, retry at the cap, go direct after.
for (const [prov, shape] of Object.entries(SHAPES)) {
  useProvider(prov, shape.model);
  const m = await fresh(prov);
  const seen = mockProvider(shape, 8192);
  let err = null;
  try { await m.generateShader('red'); } catch (e) { err = e; }
  check(`${prov}: a too-large budget is retried, not surfaced as an error`, !err);
  check(`${prov}: the first request asks for the full generate budget`, seen[0] >= 32000);
  check(`${prov}: the retry uses the cap the provider named (8192, not the 32000 asked or the 1 in a range)`, seen[1] === 8192);
  check(`${prov}: the cap is stored under the MODEL`, savedCaps(prov)[shape.model] === 8192);
  seen.length = 0;
  await m.generateShader('blue').catch(() => {});
  check(`${prov}: once learned, the next request goes straight to the cap (one request, not two)`,
    seen.length === 1 && seen[0] === 8192);
}

// 2. The cap belongs to the model: another model on the same provider asks in full.
{
  const store0 = JSON.parse(store.get('imweb-ai-config'));
  store0.activeProvider = 'deepseek';
  store0.providers.deepseek = { apiKey: 'k', model: 'deepseek-v4-pro',
    outputCaps: { 'deepseek-flash': 8192 } };
  store.set('imweb-ai-config', JSON.stringify(store0));
  const m = await fresh('permodel');
  const seen = mockProvider(SHAPES.deepseek, 1e9);
  await m.generateShader('x').catch(() => {});
  check('a cap learned for one model does not throttle another model of the same provider',
    seen[0] >= 32000);
}

// 3. Errors that merely MENTION tokens are not caps.
for (const [label, msg, status] of [
  ['rate limit', 'This request would exceed the rate limit of 8,000 output tokens per minute', 429],
  ['bad key', 'Incorrect API key provided: sk-…', 401],
  ['quota', 'You exceeded your current quota of 10,000 output tokens', 429],
]) {
  useProvider('deepseek', 'deepseek-flash');
  const m = await fresh(label);
  const seen = mockProvider(SHAPES.deepseek, 0, { errMsg: msg, status });
  let err = null;
  try { await m.generateShader('x'); } catch (e) { err = e; }
  check(`${label}: surfaces as an error`, !!err);
  check(`${label}: is not retried`, seen.length === 1);
  check(`${label}: learns no cap`, Object.keys(savedCaps('deepseek')).length === 0);
}

// 4. The streaming router honours a learned cap too.
{
  store.set('imweb-ai-config', JSON.stringify({ activeProvider: 'deepseek',
    providers: { deepseek: { apiKey: 'k', model: 'deepseek-flash', outputCaps: { 'deepseek-flash': 8192 } } } }));
  const m = await fresh('stream');
  const seen = mockProvider(SHAPES.deepseek, 0, { errMsg: undefined, status: 500 });
  await m.generateShader('x', null, null, () => {}).catch(() => {});
  check('the streaming path asks for the learned cap, not the full budget', seen[0] === 8192);
}

// 5. Truncation names the room actually GRANTED.
{
  store.set('imweb-ai-config', JSON.stringify({ activeProvider: 'deepseek',
    providers: { deepseek: { apiKey: 'k', model: 'deepseek-flash', outputCaps: { 'deepseek-flash': 8192 } } } }));
  const m = await fresh('trunc');
  mockProvider(SHAPES.deepseek, 1e9, { okBody: SHAPES.deepseek.ok('length') });
  let msg = '';
  try { await m.generateShader('x'); } catch (e) { msg = e.message; }
  check('a truncation under a learned cap reports that cap', /ran out of room at 8192 tokens/.test(msg));
  check('a fresh generate is not told to shorten the shader in the editor', !/refine also rewrites/.test(msg));
}

// 6. Budgets keep their floor. Kimi's own docs recommend ≥16K for thinking
//    models; 8000 is what failed. A learned cap makes a high ceiling safe.
{
  const src = readFileSync(resolve(root, 'src/ai/AIFeatures.js'), 'utf8');
  const gen = Number(src.match(/const GENERATE_TOKENS\s*=\s*(\d+)/)?.[1]);
  check('GENERATE_TOKENS is at least 32000 (8000 starved DeepSeek and Kimi)', gen >= 32000);
}

const EXPECTED_CHECKS = 29;
if (ran !== EXPECTED_CHECKS) {
  console.error(`FAIL audit-ai-output-caps: ran ${ran} checks, expected ${EXPECTED_CHECKS} — a section was skipped or added without updating the count.`);
  process.exit(1);
}
if (fails.length) {
  console.error('FAIL audit-ai-output-caps:');
  for (const f of fails) console.error('  - ' + f);
  console.error('Fix: caps are learned in _callRaw (_capFromError) and applied in BOTH _callRaw and _callStream via _capFor; they live in providers[id].outputCaps[model].');
  process.exit(1);
}
console.log(`PASS audit-ai-output-caps — ${ran} checks: caps learned from three provider shapes, per model, on both routers; rate limits and key errors ignored`);
