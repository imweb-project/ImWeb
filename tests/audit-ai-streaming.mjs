/**
 * Runtime audit: shader generation streams, and every provider's framing is
 * parsed correctly.
 *
 * Why this exists. Four providers, four stream framings, and a wrong parser
 * fails the same silent way a wrong image envelope does — the request succeeds,
 * nothing is extracted, and the user sees "empty response" rather than a parse
 * bug. Specifically:
 *
 *   Anthropic   SSE; text lives in content_block_delta.delta.text, the stop
 *               reason in message_delta, and usage is SPLIT — input tokens in
 *               message_start, output tokens in message_delta.
 *   Gemini      SSE, but every data: is a whole response object, and only the
 *               last carries usageMetadata.
 *   OpenAI-ish  SSE with a [DONE] sentinel; usage arrives only because
 *               stream_options.include_usage was asked for, in a final chunk
 *               whose choices array is EMPTY.
 *   Ollama      not SSE at all — newline-delimited JSON.
 *
 * Two properties matter beyond "the text comes out": the stop reason must
 * survive (it is what catches truncation), and usage must survive (or the
 * token counter silently under-reports every streamed call — and streaming is
 * the path the expensive calls take).
 *
 * Run:  node tests/audit-ai-streaming.mjs
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

const SHADER = '// uParams: A | B | C | D\nvoid main(){ gl_FragColor = texture2D(uTexture, vUv); }';

/** A Response whose body streams `chunks` as bytes, split at awkward points. */
function streamResponse(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
  return { ok: true, body, json: async () => ({}) };
}

const useProvider = (prov, model) => store.set('imweb-ai-config', JSON.stringify({
  activeProvider: prov, providers: { [prov]: { apiKey: 'k', model } },
}));
const fresh = (tag) => import(`../src/ai/AIFeatures.js?s=${tag}${Math.random()}`);

// ── Anthropic ───────────────────────────────────────────────────────────────
useProvider('anthropic', 'claude-sonnet-5');
{
  const half = SHADER.slice(0, 20), rest = SHADER.slice(20);
  globalThis.fetch = async (_u, o) => {
    check('anthropic: the request asks for a stream', JSON.parse(o.body).stream === true);
    return streamResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1200,"cache_read_input_tokens":300}}}\n\n',
      // A thinking delta must be IGNORED — it is not code and would land in the editor.
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"pondering"}}\n\n',
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: half } })}\n\n`,
      // Deliberately split an event across two network chunks.
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: rest } }).slice(0, 30)}`,
      `${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: rest } }).slice(30)}\n\n`,
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":880}}\n\n',
    ]);
  };
  const m = await fresh('anth');
  const seen = [];
  const code = await m.generateShader('x', null, null, (t) => seen.push(t));
  check('anthropic: the full shader is assembled', code.includes('gl_FragColor'));
  check('anthropic: onDelta fired more than once (it really streamed)', seen.length >= 2);
  check('anthropic: deltas are CUMULATIVE, not fragments', seen[seen.length - 1].length > seen[0].length);
  check('anthropic: a thinking delta never reaches the editor', !seen.some((t) => t.includes('pondering')));
  check('anthropic: an event split across chunks is reassembled', code.includes('texture2D(uTexture, vUv)'));
  const u = m.getUsage();
  check('anthropic: input usage from message_start (incl. cache) is counted', u.session.in === 1500);
  check('anthropic: output usage from message_delta is counted', u.session.out === 880);
}

// ── Gemini ──────────────────────────────────────────────────────────────────
useProvider('gemini', 'gemini-3.1-pro');
{
  globalThis.fetch = async (u) => {
    check('gemini: uses the streaming endpoint with alt=sse',
      /streamGenerateContent/.test(u) && /alt=sse/.test(u));
    return streamResponse([
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: SHADER.slice(0, 25) }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: SHADER.slice(25) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 200, thoughtsTokenCount: 60 } })}\n\n`,
    ]);
  };
  const m = await fresh('gem');
  const seen = [];
  const code = await m.generateShader('x', null, null, (t) => seen.push(t));
  check('gemini: the full shader is assembled', code.includes('gl_FragColor'));
  check('gemini: it streamed in pieces', seen.length >= 2);
  const u = m.getUsage();
  check('gemini: prompt tokens counted', u.session.in === 700);
  check('gemini: thinking tokens counted as output', u.session.out === 260);
}

// ── OpenAI-shaped ───────────────────────────────────────────────────────────
useProvider('openai', 'gpt-4o');
{
  globalThis.fetch = async (_u, o) => {
    const b = JSON.parse(o.body);
    check('openai: the request asks for a stream', b.stream === true);
    // Without this the counter silently under-reports every streamed call.
    check('openai: usage is explicitly requested', b.stream_options?.include_usage === true);
    return streamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: SHADER.slice(0, 18) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: SHADER.slice(18) }, finish_reason: 'stop' }] })}\n\n`,
      // The usage chunk carries an EMPTY choices array.
      'data: {"choices":[],"usage":{"prompt_tokens":400,"completion_tokens":120}}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  const m = await fresh('oai');
  const seen = [];
  const code = await m.generateShader('x', null, null, (t) => seen.push(t));
  check('openai: the full shader is assembled', code.includes('gl_FragColor'));
  check('openai: the [DONE] sentinel does not corrupt the text', !code.includes('DONE'));
  const u = m.getUsage();
  check('openai: usage from the final empty-choices chunk is counted',
    u.session.in === 400 && u.session.out === 120);
}

// ── Ollama (NDJSON, not SSE) ────────────────────────────────────────────────
useProvider('ollama', 'llama3.2');
{
  globalThis.fetch = async (_u, o) => {
    check('ollama: the request asks for a stream', JSON.parse(o.body).stream === true);
    return streamResponse([
      `${JSON.stringify({ message: { content: SHADER.slice(0, 22) }, done: false })}\n`,
      // A line split across chunks, the NDJSON equivalent of the SSE case.
      `${JSON.stringify({ message: { content: SHADER.slice(22) }, done: false })}`.slice(0, 20),
      `${JSON.stringify({ message: { content: SHADER.slice(22) }, done: false })}`.slice(20) + '\n',
      `${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 90, eval_count: 45 })}\n`,
    ]);
  };
  const m = await fresh('oll');
  const code = await m.generateShader('x', null, null, () => {});
  check('ollama: NDJSON is parsed (not treated as SSE)', code.includes('gl_FragColor'));
  const u = m.getUsage();
  check('ollama: eval counts recorded', u.session.in === 90 && u.session.out === 45);
}

// ── The stop reason must survive streaming ──────────────────────────────────
// This is the property that catches truncation. A stream that loses it would
// re-open the exact bug the non-streaming path was fixed for.
useProvider('anthropic', 'claude-sonnet-5');
{
  globalThis.fetch = async () => streamResponse([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'void main(){ gl_FragColor = vec4(0.0' } })}\n\n`,
    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}\n\n',
  ]);
  const m = await fresh('trunc');
  let msg = '';
  try { await m.generateShader('x', null, null, () => {}); } catch (e) { msg = e.message; }
  check('a truncated STREAM throws rather than injecting partial code', /ran out of room/.test(msg));
  check('and still refuses to blame the quota', /not a quota or key problem/.test(msg));

  globalThis.fetch = async () => streamResponse([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
  ]);
  const m2 = await fresh('ref');
  msg = '';
  try { await m2.generateShader('x', null, null, () => {}); } catch (e) { msg = e.message; }
  check('a refused stream is reported as a refusal', /declined/.test(msg));
}

// ── Fallback: streaming must never be the reason generation fails ───────────
useProvider('anthropic', 'claude-sonnet-5');
{
  let calls = 0;
  globalThis.fetch = async (_u, o) => {
    calls++;
    if (JSON.parse(o.body).stream) throw new TypeError('ReadableStream unsupported by this proxy');
    return { ok: true, json: async () => ({
      content: [{ type: 'text', text: SHADER }], stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 5 } }) };
  };
  const m = await fresh('fall');
  const code = await m.generateShader('x', null, null, () => {});
  check('a transport failure falls back to the non-streaming path', code.includes('gl_FragColor'));
  check('and the fallback actually made a second request', calls === 2);

  // But a real provider error must NOT be retried unstreamed — that spends a
  // second request to fail identically.
  let n = 0;
  globalThis.fetch = async () => { n++; return { ok: false, status: 401, json: async () => ({ error: { message: 'Anthropic error 401' } }) }; };
  const m2 = await fresh('noretry');
  let threw = false;
  try { await m2.generateShader('x', null, null, () => {}); } catch { threw = true; }
  check('a provider HTTP error surfaces instead of being retried', threw && n === 1);
}

// ── Only the shader paths stream ────────────────────────────────────────────
{
  const src = readFileSync(resolve(root, 'src/ai/AIFeatures.js'), 'utf8');
  check('_callStream is reached only through the shader call',
    (src.match(/_callStream\(/g) ?? []).length === 2); // definition + one call
  check('the narrator still uses the plain text call', /export async function narrateState[\s\S]{0,400}_call\(/.test(src));
  check('streaming is skipped when nothing is watching', /onDelta\s*\n?\s*\?\s*await _callStream/.test(src));
  check('streamed calls are metered too', /_recordUsage\(id, pcfg\.model[\s\S]{0,80}res\.usage\)/.test(src));

  const main = readFileSync(resolve(root, 'src/main.js'), 'utf8');
  check('the modal closes once the first characters arrive', /_streamOpen = true;[\s\S]{0,60}closeAiModal\(\)/.test(main));
  check('partial text is written to the editor as it arrives', /setGlslSource\(soFar\)/.test(main));
  check('a failed stream restores the shader it overwrote',
    /if \(_streamOpen\) \{[\s\S]{0,200}setGlslSource\(undoSnapshot\.source\)/.test(main));
}

const EXPECTED_CHECKS = 34;
if (ran !== EXPECTED_CHECKS) {
  console.error(`FAIL audit-ai-streaming: ran ${ran} checks, expected ${EXPECTED_CHECKS} — a section was skipped or added without updating the count.`);
  process.exit(1);
}
if (fails.length) {
  console.error('FAIL audit-ai-streaming:');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log(`PASS audit-ai-streaming — ${ran} checks: all four framings parsed, stop reason and usage survive, fallback intact`);
