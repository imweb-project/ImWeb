/**
 * Runtime audit: token usage must be read from each provider's OWN usage
 * fields, metered at exactly one place, and priced only where a rate exists.
 *
 * Why this exists. Four request shapes report tokens under four different
 * names — Anthropic `usage.input_tokens`, Gemini `usageMetadata
 * .promptTokenCount`, the OpenAI shape `usage.prompt_tokens`, Ollama
 * `prompt_eval_count`. A counter that misses one shows a provider as FREE,
 * which is the worst possible failure for a number whose entire job is telling
 * you what you are spending. There is no error and no zero row to notice — the
 * provider simply never appears.
 *
 * Two further traps this holds:
 *   - Thinking tokens. Gemini reports them separately (`thoughtsTokenCount`)
 *     and they are billed as output; Anthropic folds them into
 *     `output_tokens`. Dropping Gemini's field under-reports a refine by most
 *     of its real cost, since thinking dominates.
 *   - Cache tokens. Anthropic splits input across three fields; counting only
 *     `input_tokens` under-reports every cached call.
 *
 * Run:  node tests/audit-ai-usage.mjs
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
const fresh = (tag) => import(`../src/ai/AIFeatures.js?${tag}${Math.random()}`);

// Every provider shape, with the field names it really uses.
const CASES = [
  { prov: 'anthropic', model: 'claude-sonnet-5',
    body: { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn',
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 200 } },
    // Cache reads AND writes are input tokens too.
    in: 1500, out: 200 },
  { prov: 'gemini', model: 'gemini-3.1-pro',
    body: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 100, thoughtsTokenCount: 400 } },
    // Thinking is billed as output and must be counted as output.
    in: 800, out: 500 },
  { prov: 'openai', model: 'gpt-4o',
    body: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 300, completion_tokens: 50 } },
    in: 300, out: 50 },
  { prov: 'ollama', model: 'llama3.2',
    body: { message: { content: 'x' }, done_reason: 'stop', prompt_eval_count: 77, eval_count: 33 },
    in: 77, out: 33 },
];

for (const c of CASES) {
  store.clear();
  useProvider(c.prov, c.model);
  globalThis.fetch = async () => ({ ok: true, json: async () => c.body });
  const m = await fresh(c.prov);
  await m.narrateState('x', 'short');
  const u = m.getUsage();
  check(`${c.prov}: input tokens counted (${c.in})`, u.session.in === c.in);
  check(`${c.prov}: output tokens counted (${c.out})`, u.session.out === c.out);
  check(`${c.prov}: the call is counted`, u.session.calls === 1);
  check(`${c.prov}: totals keyed by provider:model`, !!u.totals[`${c.prov}:${c.model}`]);
  check(`${c.prov}: last-call detail recorded`, u.last?.in === c.in && u.last?.out === c.out);
}

// Metering must cover the shader paths, not just the narrator — a refine is
// the single most expensive call the instrument makes.
store.clear();
useProvider('anthropic', 'claude-sonnet-5');
globalThis.fetch = async () => ({ ok: true, json: async () => ({
  content: [{ type: 'text', text: '// uParams: A | B | C | D\nvoid main(){ gl_FragColor = vec4(0.0); }' }],
  stop_reason: 'end_turn', usage: { input_tokens: 5000, output_tokens: 900 } }) });
{
  const m = await fresh('shader');
  await m.generateShader('x');
  check('generateShader is metered', m.getUsage().session.in === 5000);
  await m.refineShader('y', 'void main(){}');
  check('refineShader is metered', m.getUsage().session.calls === 2);
  check('usage accumulates rather than overwriting', m.getUsage().session.in === 10000);
}

// A provider that reports no usage must not invent a zero row — an invented
// row reads as "this model is free".
store.clear();
useProvider('openai', 'gpt-4o');
globalThis.fetch = async () => ({ ok: true, json: async () => ({
  choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }) });
{
  const m = await fresh('nousage');
  await m.narrateState('x', 'short');
  check('no reported usage → no invented row', m.getUsage().session.calls === 0);
  check('no reported usage → no totals entry', Object.keys(m.getUsage().totals).length === 0);
}

// Pricing: known rates compute, unknown models price as null (NOT zero), and
// local inference is a real zero.
store.clear();
useProvider('anthropic', 'claude-sonnet-5');
{
  const m = await fresh('cost');
  // sonnet-5 is $2/MTok in, $10/MTok out → 2M in + 2M out = $4 + $20.
  check('a known rate prices correctly', Math.abs(m.usageCost('anthropic', 'claude-sonnet-5', 2e6, 2e6) - 24) < 1e-9);
  check('an unpriced model returns null, never 0', m.usageCost('openai', 'gpt-4o', 1e6, 1e6) === null);
  check('local inference is a real zero', m.usageCost('ollama', 'llama3.2', 1e6, 1e6) === 0);
  check('reset clears session and stored totals', (() => {
    m.resetUsage();
    const u = m.getUsage();
    return u.session.in === 0 && u.session.calls === 0 && Object.keys(u.totals).length === 0;
  })());
}

// Structural: ONE metering point. A _recordUsage call inside each provider
// caller is four places for the next provider to be forgotten.
const src = readFileSync(resolve(root, 'src/ai/AIFeatures.js'), 'utf8');
const callSites = (src.match(/_recordUsage\(/g) ?? []).length;
check(`_recordUsage is called from exactly one place (found ${callSites - 1})`, callSites === 2); // 1 definition + 1 call
check('every provider caller returns a usage field', (src.match(/usage: \{/g) ?? []).length >= 4);
// Rates carry a verification date, so a stale table is visible rather than assumed.
check('the rate table records when it was verified', /RATES VERIFIED \d{4}-\d{2}-\d{2}/.test(src));

const EXPECTED_CHECKS = 32;
if (ran !== EXPECTED_CHECKS) {
  console.error(`FAIL audit-ai-usage: ran ${ran} checks, expected ${EXPECTED_CHECKS} — a section was skipped or added without updating the count.`);
  process.exit(1);
}
if (fails.length) {
  console.error('FAIL audit-ai-usage:');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log(`PASS audit-ai-usage — ${ran} checks: all four provider shapes counted, one metering point, unpriced models not faked as free`);
