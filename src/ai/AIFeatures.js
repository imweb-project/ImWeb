/**
 * ImWeb AI Features — multi-provider system
 *
 * Providers: Anthropic, Google Gemini, OpenAI, Ollama (local)
 * Config persisted to localStorage key 'imweb-ai-config'.
 *
 * Exports:
 *   PROVIDERS                              — provider definitions for UI
 *   AIFeatures (class)                     — constructor(ps, ui)
 *   getApiKey / setApiKey / clearApiKey    — backward-compat (active provider)
 *   generatePreset / narrateState /
 *   coachSuggestion                        — backward-compat feature functions
 *   buildStateSnapshot /
 *   buildActivitySnapshot                  — pure state helpers
 */

import { SOURCES, PARAM_TYPE } from '../controls/ParameterSystem.js';

// ── Provider definitions ──────────────────────────────────────────────────────

export const PROVIDERS = {
  anthropic: {
    id:          'anthropic',
    name:        'Anthropic',
    keyLabel:    'API Key',
    keyUrl:      'https://console.anthropic.com/settings/keys',
    keyUrlLabel: 'Get API key →',
    keyPlaceholder: 'sk-ant-…',
    models:      ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6'],
    defaultModel:'claude-sonnet-5',
    needsKey:    true,
  },
  gemini: {
    id:          'gemini',
    name:        'Google Gemini',
    keyLabel:    'API Key',
    keyUrl:      'https://aistudio.google.com/app/apikey',
    keyUrlLabel: 'Get API key →',
    keyPlaceholder: 'AIza…',
    models:      ['gemini-3.1-pro', 'gemini-3.1-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'],
    defaultModel:'gemini-2.0-flash',
    needsKey:    true,
  },
  openai: {
    id:          'openai',
    name:        'OpenAI',
    keyLabel:    'API Key',
    keyUrl:      'https://platform.openai.com/api-keys',
    keyUrlLabel: 'Get API key →',
    keyPlaceholder: 'sk-…',
    models:      ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    defaultModel:'gpt-4o-mini',
    needsKey:    true,
  },
  ollama: {
    id:          'ollama',
    name:        'Ollama (local)',
    keyLabel:    'Base URL',
    keyUrl:      'http://localhost:11434',
    keyUrlLabel: 'Run locally — no key needed',
    keyPlaceholder: 'http://localhost:11434',
    models:      ['llama3.2', 'mistral', 'phi3', 'qwen2.5', 'deepseek-r1'],
    defaultModel:'llama3.2',
    // The only provider whose "key" is an address, so the only one with a
    // non-empty default. buildDefaultConfig reads this rather than carrying its
    // own copy of the string.
    defaultKey:  'http://localhost:11434',
    needsKey:    false,
  },
  openrouter: {
    id:          'openrouter',
    name:        'OpenRouter',
    keyLabel:    'API Key',
    keyUrl:      'https://openrouter.ai/keys',
    keyUrlLabel: 'Get API key →',
    keyPlaceholder: 'sk-or-…',
    models:      ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o-mini', 'google/gemini-2.0-flash-001', 'meta-llama/llama-3.3-70b-instruct'],
    defaultModel:'anthropic/claude-sonnet-4.5',
    needsKey:    true,
  },
  deepseek: {
    id:          'deepseek',
    name:        'DeepSeek',
    keyLabel:    'API Key',
    keyUrl:      'https://platform.deepseek.com/api_keys',
    keyUrlLabel: 'Get API key →',
    keyPlaceholder: 'sk-…',
    models:      ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel:'deepseek-chat',
    needsKey:    true,
  },
  kimi: {
    id:          'kimi',
    name:        'Kimi (Moonshot)',
    keyLabel:    'API Key',
    keyUrl:      'https://platform.moonshot.ai/console/api-keys',
    keyUrlLabel: 'Get API key →',
    keyPlaceholder: 'sk-…',
    // Seed list only — Kimi's lineup moves fast, and "Refresh models" replaces
    // this with whatever the account can actually reach (see fetchModels).
    models:      ['kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3'],
    defaultModel:'kimi-k2.6',
    needsKey:    true,
  },
};

// ── Config management ─────────────────────────────────────────────────────────

const CONFIG_KEY = 'imweb-ai-config';

/**
 * Derived from PROVIDERS, never hand-copied.
 *
 * This used to be a second literal list, and the two had already drifted: it
 * pinned Anthropic to `claude-sonnet-4-6` while PROVIDERS advertised
 * `claude-sonnet-5` as the default, so the advertised default was one nothing
 * could ever select. Nothing catches that — both ids are real, both resolve,
 * and the call succeeds against the wrong model. Same failure as the six
 * hand-copied SOURCE_DEFS in CLAUDE.md, one subsystem over: a list with two
 * origins has one that nothing tests.
 *
 * Adding a provider now needs no edit here at all.
 */
function buildDefaultConfig() {
  const providers = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    providers[id] = { apiKey: p.defaultKey ?? '', model: p.defaultModel };
  }
  return {
    activeProvider: 'gemini',
    providers,
    narrator: { interval: 10000, length: 'medium' },
    coach:    { interval: 45000 },
    // Vision is OFF by default. It is a real cost step — an image is worth
    // roughly a thousand input tokens — and the narrator fires on a timer, so
    // defaulting it on would quietly spend money on an idle patch.
    vision:   { narrator: false, coach: false, shader: false },
  };
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return buildDefaultConfig();
    const saved = JSON.parse(raw);
    // Merge so any new provider defaults are present
    const def = buildDefaultConfig();
    return {
      ...def,
      ...saved,
      providers: { ...def.providers, ...saved.providers },
      narrator: { ...def.narrator, ...saved.narrator },
      coach: { ...def.coach, ...saved.coach },
      vision: { ...def.vision, ...saved.vision },
    };
  } catch {
    return buildDefaultConfig();
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

// Module-level config singleton — loaded once on first use
let _cfg = null;
function _config() { return (_cfg ??= loadConfig()); }

// ── Provider API callers ──────────────────────────────────────────────────────

/**
 * Normalised stop reasons. Every provider caller returns { text, stop } where
 * `stop` is one of these, because the question "did the model finish?" has the
 * same answer everywhere and four different field names:
 *
 *   'end'        finished on its own
 *   'max_tokens' ran out of room — the output is TRUNCATED
 *   'refusal'    declined, or a safety/content filter tripped
 *   'unknown'    provider said nothing recognisable
 *
 * This exists because discarding it produced a genuinely misleading failure:
 * a thinking model that exhausts max_tokens while still thinking returns a
 * response with NO text block, which read as 'Empty response from the AI
 * provider — check the model name, quota, or content filters'. The model name
 * and the quota were both fine; the shader was simply too long to redo in the
 * budget it had. Four fields, one meaning — map it once, at the edge.
 */
const STOP_MAP = {
  // Anthropic — response.stop_reason
  end_turn: 'end', stop_sequence: 'end', tool_use: 'end',
  max_tokens: 'max_tokens', refusal: 'refusal',
  // Gemini — candidates[0].finishReason (SCREAMING_CASE)
  STOP: 'end', MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal', PROHIBITED_CONTENT: 'refusal', BLOCKLIST: 'refusal',
  RECITATION: 'refusal', SPII: 'refusal',
  // OpenAI-shaped — choices[0].finish_reason  (also Ollama's done_reason)
  stop: 'end', length: 'max_tokens', content_filter: 'refusal',
};
const _stop = (raw) => STOP_MAP[raw] ?? 'unknown';

/**
 * Vision: each provider takes an image in its OWN envelope, so the four shapes
 * are mapped here at the edge exactly as the stop reasons and usage fields are.
 * `image` is { b64, mime } with NO data: prefix — three of the four want raw
 * base64 and the OpenAI shape wants the full data URL, which is the kind of
 * difference that is invisible until a provider silently ignores the image and
 * describes the parameter list instead of the picture.
 */
async function callAnthropic(pcfg, system, user, maxTokens, image) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'x-api-key':     pcfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model:      pcfg.model,
      max_tokens: maxTokens,
      system,
      messages: [{
        role: 'user',
        // Image FIRST: Anthropic documents better results with the image ahead
        // of the question it is about.
        content: image
          ? [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.b64 } },
             { type: 'text', text: user }]
          : user,
      }],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message ?? `Anthropic error ${res.status}`);
  }
  // Models with adaptive thinking (Sonnet 5, Opus 4.7+) return a thinking
  // block FIRST — content[0].text is undefined there. Find the text block.
  const data = await res.json();
  return {
    text: (data.content ?? []).find((b) => b.type === 'text')?.text ?? '',
    stop: _stop(data.stop_reason),
    // Cache reads/writes are billed differently but are still input tokens —
    // counting them keeps the total honest about what was sent.
    usage: {
      in:  (data.usage?.input_tokens ?? 0)
         + (data.usage?.cache_read_input_tokens ?? 0)
         + (data.usage?.cache_creation_input_tokens ?? 0),
      out: data.usage?.output_tokens ?? 0,
    },
  };
}

async function callGemini(pcfg, system, user, maxTokens, image) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(pcfg.model)}:generateContent?key=${pcfg.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: image
          ? [{ inline_data: { mime_type: image.mime, data: image.b64 } },
             { text: `${system}\n\n${user}` }]
          : [{ text: `${system}\n\n${user}` }],
      }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message ?? `Gemini error ${res.status}`);
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  return {
    text: (cand?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
    // A prompt blocked before generation has no candidate at all — the reason
    // is on promptFeedback instead, and reading only finishReason would report
    // that as 'unknown' rather than the refusal it is.
    stop: cand ? _stop(cand.finishReason)
               : (data.promptFeedback?.blockReason ? 'refusal' : 'unknown'),
    usage: {
      in:  data.usageMetadata?.promptTokenCount ?? 0,
      // thoughtsTokenCount is billed as output on thinking models and is
      // omitted elsewhere — the ?? 0 covers both.
      out: (data.usageMetadata?.candidatesTokenCount ?? 0)
         + (data.usageMetadata?.thoughtsTokenCount ?? 0),
    },
  };
}

/**
 * The OpenAI /chat/completions shape, which four of these providers speak
 * verbatim — OpenAI, OpenRouter, DeepSeek and Kimi. Only the endpoint, the
 * label in the error and any extra headers differ, so those are DATA rather
 * than four near-identical functions. CLAUDE.md's rule about copied patterns
 * ("do not copy the pattern, which is how seven near-duplicates accrued")
 * applies here as much as it does to _srcUsed.
 *
 * Anthropic, Gemini and Ollama each keep their own caller: they differ in
 * request body, not just in address.
 */
const OPENAI_SHAPED = {
  openai:     { url: 'https://api.openai.com/v1/chat/completions',   label: 'OpenAI' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', label: 'OpenRouter',
                headers: { 'HTTP-Referer': 'https://imweb.app', 'X-Title': 'ImWeb' } },
  // Both are documented as OpenAI-compatible; `/v1` is a compatibility path on
  // each and has nothing to do with the model generation.
  deepseek:   { url: 'https://api.deepseek.com/v1/chat/completions',  label: 'DeepSeek' },
  kimi:       { url: 'https://api.moonshot.ai/v1/chat/completions',   label: 'Kimi' },
};

async function callOpenAIShaped(providerId, pcfg, system, user, maxTokens, image) {
  const ep = OPENAI_SHAPED[providerId];
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${pcfg.apiKey}`,
      ...(ep.headers ?? {}),
    },
    body: JSON.stringify({
      model:      pcfg.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          // This shape wants a full data: URL, not bare base64 — the one
          // provider family that differs here.
          content: image
            ? [{ type: 'text', text: user },
               { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.b64}` } }]
            : user,
        },
      ],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message ?? `${ep.label} error ${res.status}`);
  }
  const body = await res.json();
  const choice = body.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    stop: _stop(choice?.finish_reason),
    usage: { in: body.usage?.prompt_tokens ?? 0, out: body.usage?.completion_tokens ?? 0 },
  };
}

async function callOllama(pcfg, system, user, _maxTokens, image) {
  const base = (pcfg.apiKey || 'http://localhost:11434').replace(/\/$/, '');
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:  pcfg.model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        // Ollama keeps `content` a plain string and hangs raw base64 off a
        // sibling `images` array. It does NOT take the OpenAI image_url shape
        // — handed that, it ignores the picture and answers from the text,
        // with no error and a plausible reply.
        { role: 'user', content: user, ...(image ? { images: [image.b64] } : {}) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status} — is it running at ${base}?`);
  const data = await res.json();
  return {
    text: data.message?.content ?? '',
    stop: _stop(data.done_reason),
    usage: { in: data.prompt_eval_count ?? 0, out: data.eval_count ?? 0 },
  };
}

// ── Streaming ────────────────────────────────────────────────────────────────
//
// Streaming exists for ONE reason: a shader refine can take 20s+ on a thinking
// model, and a dead modal for 20 seconds is indistinguishable from a hung one.
// Watching the code arrive also suits the instrument — it is a performance tool.
//
// Only the shader paths stream. The Narrator, Coach, preset generator and
// connection test all consume a whole answer and have nothing to show in
// pieces, so they keep the simpler non-streaming path.
//
// Every provider frames its stream differently, and a wrong parser fails the
// same silent way a wrong image envelope does — no text, no error. The four
// framings, and what each one carries:
//
//   Anthropic   SSE. `content_block_delta` → delta.text; `message_start`
//               carries input usage, `message_delta` the stop reason and
//               output usage.
//   Gemini      SSE via :streamGenerateContent?alt=sse. Each `data:` is a whole
//               GenerateContentResponse; the LAST one carries usageMetadata.
//   OpenAI-ish  SSE. choices[0].delta.content, terminated by `data: [DONE]`.
//               Usage only arrives if stream_options.include_usage is asked for.
//   Ollama      NOT SSE — newline-delimited JSON. Final object has done:true
//               plus the eval counts.

/** Read an SSE body and hand each `data:` payload to `onEvent`. */
async function pumpSSE(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // Events are separated by a blank line; a chunk can split one anywhere, so
    // only complete events are consumed and the remainder stays buffered.
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + (buf[i] === '\r' ? 4 : 2));
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { onEvent(JSON.parse(payload)); } catch { /* keep-alive or partial */ }
      }
    }
  }
}

/** Read a newline-delimited-JSON body (Ollama). */
async function pumpNDJSON(res, onObject) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onObject(JSON.parse(line)); } catch { /* partial */ }
    }
  }
  const tail = buf.trim();
  if (tail) { try { onObject(JSON.parse(tail)); } catch { /* ignore */ } }
}

/** Shared failure path — an error body is JSON, not a stream. */
async function streamError(res, label) {
  const e = await res.json().catch(() => ({}));
  return new Error(e.error?.message ?? `${label} error ${res.status}`);
}

async function streamAnthropic(pcfg, system, user, maxTokens, image, onDelta) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': pcfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: pcfg.model, max_tokens: maxTokens, system, stream: true,
      messages: [{
        role: 'user',
        content: image
          ? [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.b64 } },
             { type: 'text', text: user }]
          : user,
      }],
    }),
  });
  if (!res.ok) throw await streamError(res, 'Anthropic');
  let text = '', stop = 'unknown', inTok = 0, outTok = 0;
  await pumpSSE(res, (ev) => {
    if (ev.type === 'message_start') {
      const u = ev.message?.usage ?? {};
      inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            + (u.cache_creation_input_tokens ?? 0);
      outTok = u.output_tokens ?? 0;
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      // Thinking deltas arrive as thinking_delta and are deliberately ignored:
      // the editor shows CODE, and a thinking stream would fill it with prose
      // that is then replaced.
      text += ev.delta.text;
      onDelta?.(text);
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stop = _stop(ev.delta.stop_reason);
      if (ev.usage?.output_tokens != null) outTok = ev.usage.output_tokens;
    }
  });
  return { text, stop, usage: { in: inTok, out: outTok } };
}

async function streamGemini(pcfg, system, user, maxTokens, image, onDelta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(pcfg.model)}:streamGenerateContent?alt=sse&key=${pcfg.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: image
          ? [{ inline_data: { mime_type: image.mime, data: image.b64 } }, { text: `${system}\n\n${user}` }]
          : [{ text: `${system}\n\n${user}` }],
      }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) throw await streamError(res, 'Gemini');
  let text = '', stop = 'unknown', inTok = 0, outTok = 0;
  await pumpSSE(res, (d) => {
    const cand = d.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (typeof part.text === 'string') { text += part.text; onDelta?.(text); }
    }
    if (cand?.finishReason) stop = _stop(cand.finishReason);
    else if (d.promptFeedback?.blockReason) stop = 'refusal';
    if (d.usageMetadata) {
      inTok = d.usageMetadata.promptTokenCount ?? inTok;
      outTok = (d.usageMetadata.candidatesTokenCount ?? 0)
             + (d.usageMetadata.thoughtsTokenCount ?? 0);
    }
  });
  return { text, stop, usage: { in: inTok, out: outTok } };
}

async function streamOpenAIShaped(providerId, pcfg, system, user, maxTokens, image, onDelta) {
  const ep = OPENAI_SHAPED[providerId];
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${pcfg.apiKey}`,
      ...(ep.headers ?? {}),
    },
    body: JSON.stringify({
      model: pcfg.model, max_tokens: maxTokens, stream: true,
      // Usage is omitted from a stream unless asked for. Without this the
      // token counter would silently under-report every streamed call.
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: image
            ? [{ type: 'text', text: user },
               { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.b64}` } }]
            : user,
        },
      ],
    }),
  });
  if (!res.ok) throw await streamError(res, ep.label);
  let text = '', stop = 'unknown', inTok = 0, outTok = 0;
  await pumpSSE(res, (d) => {
    const ch = d.choices?.[0];
    const piece = ch?.delta?.content;
    if (typeof piece === 'string' && piece) { text += piece; onDelta?.(text); }
    if (ch?.finish_reason) stop = _stop(ch.finish_reason);
    // The usage-only chunk arrives last and carries an empty choices array.
    if (d.usage) {
      inTok = d.usage.prompt_tokens ?? inTok;
      outTok = d.usage.completion_tokens ?? outTok;
    }
  });
  return { text, stop, usage: { in: inTok, out: outTok } };
}

async function streamOllama(pcfg, system, user, _maxTokens, image, onDelta) {
  const base = (pcfg.apiKey || 'http://localhost:11434').replace(/\/$/, '');
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: pcfg.model, stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user, ...(image ? { images: [image.b64] } : {}) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status} — is it running at ${base}?`);
  let text = '', stop = 'unknown', inTok = 0, outTok = 0;
  await pumpNDJSON(res, (o) => {
    const piece = o.message?.content;
    if (typeof piece === 'string' && piece) { text += piece; onDelta?.(text); }
    if (o.done) {
      stop = _stop(o.done_reason);
      inTok = o.prompt_eval_count ?? inTok;
      outTok = o.eval_count ?? outTok;
    }
  });
  return { text, stop, usage: { in: inTok, out: outTok } };
}

/**
 * Streaming sibling of _callRaw. Same { text, stop, usage } contract, plus
 * `onDelta(textSoFar)` as each piece arrives.
 *
 * Falls back to the non-streaming path on ANY streaming failure, because a
 * cosmetic feature must never be the reason a shader cannot be generated:
 * a proxy that buffers SSE, a runtime without ReadableStream, or a provider
 * that refuses `stream: true` should cost the live typing, not the shader.
 */
async function _callStream(system, user, maxTokens, image, onDelta) {
  const cfg = _config();
  const id = cfg.activeProvider;
  const pcfg = cfg.providers[id];
  if (!pcfg) throw new Error('No provider configured');
  if (PROVIDERS[id]?.needsKey && !pcfg.apiKey) throw new Error('no-key');

  const canStream = typeof ReadableStream !== 'undefined'
    && typeof TextDecoder !== 'undefined';
  if (canStream) {
    try {
      const res = (id in OPENAI_SHAPED)
        ? await streamOpenAIShaped(id, pcfg, system, user, maxTokens, image, onDelta)
        : id === 'anthropic' ? await streamAnthropic(pcfg, system, user, maxTokens, image, onDelta)
        : id === 'gemini'    ? await streamGemini   (pcfg, system, user, maxTokens, image, onDelta)
        : id === 'ollama'    ? await streamOllama   (pcfg, system, user, maxTokens, image, onDelta)
        : null;
      if (res) {
        _recordUsage(id, pcfg.model ?? PROVIDERS[id]?.defaultModel ?? '?', res.usage);
        return res;
      }
    } catch (e) {
      // A 'no-key' or an HTTP error from the provider is a REAL failure and must
      // surface — retrying it unstreamed just spends a second request to fail
      // the same way. Only a transport-shaped failure is worth falling back on.
      if (e?.message === 'no-key') throw e;
      if (import.meta.env?.DEV) console.warn('[glsl-ai] stream failed, falling back:', e?.message);
      if (/error \d{3}|^Ollama \d{3}/.test(e?.message ?? '')) throw e;
    }
  }
  return _callRaw(system, user, maxTokens, image);
}

// ── Model list fetchers ─────────────────────────────────────────────────────

async function fetchModels(providerId) {
  const cfg = _config();
  const pcfg = cfg.providers[providerId];
  if (!pcfg) throw new Error('No provider configured');
  switch (providerId) {
    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': pcfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      });
      if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
      const data = await res.json();
      return (data.data ?? []).map(m => m.id);
    }
    case 'gemini': {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${pcfg.apiKey}`);
      if (!res.ok) throw new Error(`Gemini error ${res.status}`);
      const data = await res.json();
      return (data.models ?? [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));
    }
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${pcfg.apiKey}` },
      });
      if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
      const data = await res.json();
      return (data.data ?? [])
        .map(m => m.id)
        .filter(id => /^(gpt|o\d)/.test(id))
        .sort();
    }
    case 'ollama': {
      const base = (pcfg.apiKey || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${base}/api/tags`);
      if (!res.ok) throw new Error(`Ollama ${res.status} — is it running at ${base}?`);
      const data = await res.json();
      return (data.models ?? []).map(m => m.name);
    }
    case 'openrouter': {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (!res.ok) throw new Error(`OpenRouter error ${res.status}`);
      const data = await res.json();
      return (data.data ?? []).map(m => m.id).sort();
    }
    // Both serve OpenAI's /models listing verbatim. This is the path that
    // matters for Kimi in particular: its lineup moves faster than any list
    // shipped in source, so the seed in PROVIDERS is a starting point and THIS
    // is the truth.
    case 'deepseek':
    case 'kimi': {
      const base = providerId === 'deepseek'
        ? 'https://api.deepseek.com/v1/models'
        : 'https://api.moonshot.ai/v1/models';
      const res = await fetch(base, {
        headers: { 'Authorization': `Bearer ${pcfg.apiKey}` },
      });
      if (!res.ok) throw new Error(`${PROVIDERS[providerId].name} error ${res.status}`);
      const data = await res.json();
      return (data.data ?? []).map(m => m.id).sort();
    }
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

// ── Module-level call router ──────────────────────────────────────────────────

// ── Token accounting ────────────────────────────────────────────────────────
//
// Tokens are REPORTED BY THE PROVIDER, never estimated here: every one of the
// four request shapes returns a count, and a local guess (chars/4) would be
// wrong in the direction that matters — it cannot see thinking tokens, which
// are billed as output and are most of the spend on a refine.
//
// Cost is deliberately separate. A price table in source drifts silently and
// is the exact hand-copied-list failure this file has already been bitten by
// twice, so an unpriced model shows '—' rather than a confident wrong number.

const USAGE_KEY = 'imweb-ai-usage';

/**
 * Published rates, USD per million tokens, [input, output].
 * RATES VERIFIED 2026-09-12 — anything not listed prices as unknown, on
 * purpose: a missing row costs a dash on screen, a stale row costs trust.
 */
const RATES = {
  'claude-opus-5':      [5.00, 25.00],
  'claude-opus-4-8':    [5.00, 25.00],
  'claude-opus-4-7':    [5.00, 25.00],
  'claude-opus-4-6':    [5.00, 25.00],
  'claude-sonnet-5':    [2.00, 10.00],
  'claude-sonnet-4-6':  [3.00, 15.00],
  'claude-haiku-4-5':   [1.00,  5.00],
  'claude-fable-5':     [10.00, 50.00],
  'claude-fable-5-1':   [10.00, 50.00],
  // Local inference is free — a real zero, not an unknown.
  __ollama:             [0, 0],
};

function loadUsage() {
  try { return JSON.parse(localStorage.getItem(USAGE_KEY)) ?? {}; }
  catch { return {}; }
}
let _usage = null;
const _usageAll = () => (_usage ??= loadUsage());
// Session totals live in memory only — "since this page loaded" is a different
// question from "ever", and both are worth having.
const _session = { in: 0, out: 0, calls: 0 };

/** Record one call's usage against provider/model, and persist the total. */
function _recordUsage(providerId, model, usage) {
  if (!usage) return;
  const inTok = usage.in | 0, outTok = usage.out | 0;
  if (!inTok && !outTok) return; // provider reported nothing — record nothing
  _session.in += inTok; _session.out += outTok; _session.calls++;
  const all = _usageAll();
  const key = `${providerId}:${model}`;
  const e = (all[key] ??= { in: 0, out: 0, calls: 0 });
  e.in += inTok; e.out += outTok; e.calls++;
  all.__last = { provider: providerId, model, in: inTok, out: outTok, ts: Date.now() };
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(all)); }
  catch { /* quota — the in-memory session figures still work */ }
}

/** USD for a provider:model row, or null when the rate is not known. */
export function usageCost(providerId, model, inTok, outTok) {
  const r = providerId === 'ollama' ? RATES.__ollama : RATES[model];
  if (!r) return null;
  return (inTok / 1e6) * r[0] + (outTok / 1e6) * r[1];
}

/**
 * { session, totals, last } — session is this page load, totals is per
 * provider:model across every load on this origin.
 */
export function getUsage() {
  const all = _usageAll();
  const totals = {};
  for (const [k, v] of Object.entries(all)) if (!k.startsWith('__')) totals[k] = v;
  return { session: { ..._session }, totals, last: all.__last ?? null };
}

// ── Coach log ───────────────────────────────────────────────────────────────
//
// The toast flashes for 2.5s and fades. That is right for a performance — it
// must not sit over the canvas — but it means a suggestion you glanced away
// from is gone for good, and there was no way to read it back. The log is the
// retrievable half: the toast stays transient, the text is kept.
//
// Capped and per-origin, like the token totals. Eight is enough to cover a
// couple of coaching cycles without turning the panel into a scrollback.

const COACH_LOG_KEY = 'imweb-ai-coach-log';
const COACH_LOG_MAX = 8;

/** Newest first. [{ text, ts }] */
export function getCoachLog() {
  try {
    const raw = JSON.parse(localStorage.getItem(COACH_LOG_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

/**
 * Record a suggestion. Errors are NOT logged — the log is for advice worth
 * re-reading, and filling it with "⚠ Coach error: …" would bury the thing it
 * exists to keep.
 */
export function logCoachSuggestion(text) {
  const t = (text ?? '').trim();
  if (!t || t.startsWith('⚠')) return;
  const log = getCoachLog();
  // A repeat says nothing new; refresh its timestamp instead of stacking it.
  const dup = log.findIndex((e) => e.text === t);
  if (dup !== -1) log.splice(dup, 1);
  log.unshift({ text: t, ts: Date.now() });
  try { localStorage.setItem(COACH_LOG_KEY, JSON.stringify(log.slice(0, COACH_LOG_MAX))); }
  catch { /* quota — the toast still showed */ }
}

export function clearCoachLog() {
  try { localStorage.removeItem(COACH_LOG_KEY); } catch { /* nothing to clear */ }
}

export function resetUsage() {
  _usage = {};
  _session.in = _session.out = _session.calls = 0;
  try { localStorage.removeItem(USAGE_KEY); } catch { /* nothing to clear */ }
}

/** Full result: { text, stop, usage }. Use when the stop reason matters. */
async function _callRaw(system, user, maxTokens = 512, image = null) {
  const cfg  = _config();
  const id   = cfg.activeProvider;
  const pcfg = cfg.providers[id];
  if (!pcfg) throw new Error('No provider configured');
  if (PROVIDERS[id]?.needsKey && !pcfg.apiKey) throw new Error('no-key');
  // ONE metering point. Every caller returns through here, so a new provider
  // is counted the moment it is routed — the alternative, a _recordUsage call
  // inside each of the four callers, is four places for the next one to be
  // forgotten, and an uncounted provider reads as "free".
  const res = (id in OPENAI_SHAPED)
    ? await callOpenAIShaped(id, pcfg, system, user, maxTokens, image)
    : id === 'anthropic' ? await callAnthropic(pcfg, system, user, maxTokens, image)
    : id === 'gemini'    ? await callGemini   (pcfg, system, user, maxTokens, image)
    : id === 'ollama'    ? await callOllama   (pcfg, system, user, maxTokens, image)
    : null;
  if (!res) throw new Error(`Unknown provider: ${id}`);
  _recordUsage(id, pcfg.model ?? PROVIDERS[id]?.defaultModel ?? '?', res.usage);
  return res;
}

/**
 * Text only — the long-standing contract for the Narrator, Coach, preset
 * generator and connection test, none of which can act on a stop reason.
 * Kept as a thin wrapper so those call sites are unchanged.
 */
async function _call(system, user, maxTokens = 512, image = null) {
  return (await _callRaw(system, user, maxTokens, image)).text;
}

// ── Backward-compatible API key helpers ───────────────────────────────────────

export function getApiKey() {
  const cfg = _config();
  return cfg.providers[cfg.activeProvider]?.apiKey ?? '';
}
export function setApiKey(k) {
  const cfg = _config();
  (cfg.providers[cfg.activeProvider] ??= {}).apiKey = k;
  saveConfig(cfg);
}
export function clearApiKey() {
  const cfg = _config();
  if (cfg.providers[cfg.activeProvider]) cfg.providers[cfg.activeProvider].apiKey = '';
  saveConfig(cfg);
}

export function getNarratorConfig() {
  return _config().narrator;
}
export function getCoachConfig() {
  return _config().coach;
}
export function getVisionConfig() {
  return _config().vision;
}
export function setVisionShader(on) {
  const cfg = _config();
  cfg.vision = { ...cfg.vision, shader: !!on };
  saveConfig(cfg);
}

// ── System prompts ────────────────────────────────────────────────────────────

/**
 * The parameter reference is DERIVED from the live ParameterSystem, never
 * written out by hand.
 *
 * The block this replaces was a prose copy of the parameter set, and it had
 * rotted exactly as CLAUDE.md's SOURCE_DEFS lesson predicts: of the 39 ids it
 * advertised, 17 no longer existed (`keyer.soft` for `keyer.softness`,
 * `feedback.x/y` for `feedback.hor/ver`, `transfermode.mode` for a blend
 * system that replaced it, `color.*` for `color1.*`, `effect.kaleid` for
 * `effect.kaleidoscope`, and so on), and its source table stopped at 20 of 33
 * with every index from 4 up shifted by one. Nothing caught it: the apply loop
 * skips an id it cannot resolve, so a wrong name is a no-op and a wrong index
 * quietly routes to the neighbouring source. The model was designing for an
 * instrument that had not existed for a year.
 *
 * Deriving it also fixes the half nobody would have noticed — the AI could
 * only ever reach the params somebody remembered to type out.
 *
 * SUBJECTS ARE DERIVED, EXCEPTIONS ARE LISTED (LEARNED.md 2026-08-15): every
 * registered parameter is included unless its prefix is excluded below, so a
 * newly added parameter is exposed by default rather than silently missing.
 */
const NON_VISUAL_PREFIXES = [
  // Audio engine internals — the Sound SOURCE is visual, its DSP guts are not.
  'aspec', 'avoice', 'aplay', 'agrain', 'acorp', 'arec', 'audio',
  'apart0', 'apart1', 'apart2', 'apart3',
  // Hardware, input and plumbing: nothing here describes a look.
  'midi', 'touch', 'canvas', 'screen', 'clip', 'projmap',
  // Draw stroke loopers — transport state, not appearance.
  'drawloop1', 'drawloop2', 'drawloop3', 'drawloop4',
  // Index into a user-editable list; meaningless as a cross-machine value
  // (the same reason glsl.preset is group 'global' — see CLAUDE.md).
  'glsl',
];

/** Type-specific range text, so the model knows what a legal value is. */
function _paramRange(p) {
  switch (p.type) {
    case PARAM_TYPE.TOGGLE: return '0|1';
    case PARAM_TYPE.SELECT:
      // Options ARE the contract for a SELECT — an index with no legend is how
      // "route to Noise" became "route to Color2".
      return (p.options ?? []).map((o, i) => `${i}=${o}`).join(' ');
    default: {
      const r = `${p.min}..${p.max}`;
      return p.unit ? `${r}${p.unit}` : r;
    }
  }
}

/**
 * Build the parameter reference for the preset prompt from `ps`.
 * Grouped by prefix so related controls read together.
 */
export function buildParamReference(ps) {
  const groups = new Map();
  for (const [id, p] of ps.params) {
    const prefix = id.split('.')[0];
    if (NON_VISUAL_PREFIXES.includes(prefix)) continue;
    // A TRIGGER fires an event and resets; it is an action, not a look.
    if (p.type === PARAM_TYPE.TRIGGER) continue;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(`  ${id} [${_paramRange(p)}]${p.label && p.label !== id ? ` — ${p.label}` : ''}`);
  }
  const out = ['ImWeb parameter reference — id [legal values] — label.',
    'These are the ONLY valid ids. Do not invent or abbreviate one.', ''];
  for (const [prefix, lines] of groups) out.push(`${prefix.toUpperCase()}:`, ...lines, '');
  return out.join('\n');
}

/**
 * The set of ids the model may write, for validating its reply. Same
 * derivation as the reference, so the two cannot disagree.
 */
export function allowedParamIds(ps) {
  const ids = new Set();
  for (const [id, p] of ps.params) {
    if (NON_VISUAL_PREFIXES.includes(id.split('.')[0])) continue;
    if (p.type === PARAM_TYPE.TRIGGER) continue;
    ids.add(id);
  }
  return ids;
}

function presetSystem(paramReference) {
  return `You are an ImWeb parameter designer. ImWeb is a real-time video synthesis instrument.

${paramReference}
The user describes a visual look or mood. Respond with ONLY a JSON object — no
markdown fences, no prose before or after:
{
  "params": { "param.id": value, ... },
  "explanation": "One sentence describing what you set and why."
}
Rules:
- Use ONLY ids from the reference above, spelled exactly. An id that is not in
  the list does nothing at all.
- For a SELECT, write the INTEGER index, not the label ("layer.fg": 5, not "Noise").
- Booleans are 0 or 1, never true/false.
- Keep every value inside the stated range.
- Set only the parameters that matter for the look — a focused patch reads
  better than a hundred tweaks. Route the sources first (layer.fg / layer.bg /
  layer.ds), then shape them.`;
}

/**
 * Pull a JSON object out of a model reply.
 *
 * The regex this replaces was `/\{[\s\S]*\}/` — greedy, fence-blind, and the
 * direct cause of the reported "Bad response: no JSON found". Three real
 * shapes defeated it: a ```json fence (the braces are there but so is prose
 * the parse then chokes on), a reply that opens with a sentence and happens to
 * contain a brace in it, and trailing commentary after the object. Greedy also
 * means the LAST brace in the message closes the match, so any following text
 * with a `}` in it swallowed the lot.
 *
 * It walks forward from a `{` tracking depth, string state and escapes, so it
 * ends at the brace that actually closes that object — and it tries EVERY `{`
 * in turn, returning the first candidate that both parses as JSON and carries
 * a "params" key. Taking only the first `{` is not enough: prose like
 * `I think {like this} you want: {...}` opens with a balanced brace pair that
 * is not JSON at all, so a single-shot scan returns garbage and the parse
 * fails on text the reply did contain a perfectly good object for.
 * Exported for headless tests.
 */
export function extractJsonObject(text) {
  if (!text) return null;
  // A fence, if present, is the most reliable delimiter — take its contents.
  const fence = text.match(/```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/);
  const hay = fence ? fence[1] : text;

  // The span of the balanced object opening at `from`, or null if unbalanced.
  const spanAt = (from) => {
    let depth = 0, inStr = false, esc = false;
    for (let i = from; i < hay.length; i++) {
      const c = hay[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return hay.slice(from, i + 1);
    }
    return null; // truncated mid-object
  };

  let firstParseable = null;
  for (let i = hay.indexOf('{'); i !== -1; i = hay.indexOf('{', i + 1)) {
    const span = spanAt(i);
    if (!span) continue;
    let parsed;
    try { parsed = JSON.parse(span); } catch { continue; }
    // Prefer the object that is actually the patch; fall back to the first
    // thing that parsed so a differently-shaped reply still reaches the
    // caller's own error message rather than dying here.
    if (parsed && typeof parsed === 'object' && 'params' in parsed) return span;
    firstParseable ??= span;
  }
  return firstParseable;
}

/**
 * Coerce and validate one parameter value against its descriptor. Returns
 * { ok, value } or { ok: false, why }.
 *
 * This is the half that made the old failure silent: main.js applied whatever
 * came back with `if (p) ps.set(id, val)`, so a string where a number belonged,
 * a true/false, or an out-of-range value was written straight into the
 * instrument — and an id that did not resolve was skipped with no report at
 * all, while the readout still said "(N params set)".
 */
function _coerceParamValue(p, raw) {
  let v = raw;
  if (typeof v === 'boolean') v = v ? 1 : 0;
  if (typeof v === 'string') {
    // A SELECT answered with its label rather than its index is worth
    // recovering — it is the single most common deviation, and the label is
    // unambiguous.
    if (p.type === PARAM_TYPE.SELECT && p.options) {
      const i = p.options.findIndex((o) => o.toLowerCase() === v.trim().toLowerCase());
      if (i !== -1) return { ok: true, value: i };
    }
    const n = Number(v.trim());
    if (!Number.isFinite(n)) return { ok: false, why: `not a number: ${JSON.stringify(raw)}` };
    v = n;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { ok: false, why: `not a number: ${JSON.stringify(raw)}` };
  }
  switch (p.type) {
    case PARAM_TYPE.TOGGLE:
      return { ok: true, value: v ? 1 : 0 };
    case PARAM_TYPE.SELECT: {
      const i = Math.round(v);
      if (!p.options || i < 0 || i >= p.options.length) {
        return { ok: false, why: `index ${i} out of range 0..${(p.options?.length ?? 1) - 1}` };
      }
      return { ok: true, value: i };
    }
    default: {
      // Clamped rather than rejected: a slightly hot value is a usable
      // intention, where dropping it loses the whole look.
      const clamped = Math.min(p.max, Math.max(p.min, v));
      return { ok: true, value: clamped, clamped: clamped !== v };
    }
  }
}

/**
 * Generate a parameter patch from a description.
 *
 * `ps` is required: the reference and the validation both derive from it, so
 * the prompt can never advertise an id the instrument does not have.
 * Returns { params, explanation, rejected, clamped } — `rejected` is REPORTED
 * rather than swallowed, because an unresolvable id used to vanish silently.
 */
/**
 * Budget for a patch. Generous for the same reason the shader paths are: on a
 * thinking model max_tokens covers thinking AND output, and the derived
 * reference gives the model a great deal to think about. 2000 was not enough —
 * a real request came back cut off mid-string, and a ceiling costs nothing
 * unless it is hit.
 */
const PRESET_TOKENS = 8000;

export async function generatePreset(description, ps) {
  if (!ps) throw new Error('generatePreset needs the ParameterSystem');
  const reference = buildParamReference(ps);
  const allowed = allowedParamIds(ps);

  // _callRaw, not _call: the stop reason is the difference between "the model
  // wrote nonsense" and "the model was cut off mid-patch", and those need
  // opposite responses from the user. Reported live — a truncated reply whose
  // visible text was perfectly good JSON was blamed on "no JSON object",
  // exactly the misdiagnosis already fixed on the shader path and missed here.
  const { text, stop } = await _callRaw(
    presetSystem(reference),
    `Create ImWeb parameters for this look: "${description}"`,
    PRESET_TOKENS,
  );
  if (stop === 'max_tokens') {
    throw new Error(
      `The model ran out of room at ${PRESET_TOKENS} tokens and the patch came back unfinished. ` +
      'This is not a quota or key problem. Ask for a simpler look, or try a model with a larger budget.',
    );
  }
  if (stop === 'refusal') {
    throw new Error('The provider declined this request (safety or content filter) — rephrase the description.');
  }
  if (!text?.trim()) {
    throw new Error(`Empty response from the AI provider (stop reason: ${stop}) — check the model name, quota, or content filters.`);
  }
  const json = extractJsonObject(text);
  if (!json) {
    // An unbalanced object means the reply was cut off even if the provider
    // did not say so — some report 'stop' on a response the model simply
    // stopped writing. Say which it looks like rather than "no JSON".
    const looksCut = text.includes('"params"') && !text.trim().endsWith('}');
    throw new Error(
      looksCut
        ? `The patch came back unfinished — the JSON is cut off mid-object. Ask for a simpler look, or use a model with more room.\nFirst 200 characters:\n${text.trim().slice(0, 200)}`
        : `The reply contained no JSON object. First 200 characters:\n${text.trim().slice(0, 200)}`,
    );
  }
  let data;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error(`The reply was not valid JSON (${e.message}).`);
  }
  if (!data.params || typeof data.params !== 'object') {
    throw new Error('The reply had no "params" object.');
  }

  const params = {};
  const rejected = [];
  const clamped = [];
  for (const [id, raw] of Object.entries(data.params)) {
    if (!allowed.has(id)) { rejected.push(`${id} (no such parameter)`); continue; }
    const r = _coerceParamValue(ps.params.get(id), raw);
    if (!r.ok) { rejected.push(`${id} (${r.why})`); continue; }
    params[id] = r.value;
    if (r.clamped) clamped.push(id);
  }
  if (!Object.keys(params).length) {
    throw new Error(
      `None of the ${Object.keys(data.params).length} parameters the model returned were usable: ${rejected.slice(0, 5).join(', ')}`,
    );
  }
  return { params, explanation: data.explanation ?? '', rejected, clamped };
}

// ── Feature: Live GLSL shader generator ──────────────────────────────────────

/**
 * The uniform contract and output rules, shared verbatim by the generate and
 * refine prompts. One origin: a refine prompt carrying its own hand-copied
 * uniform list is the SOURCE_DEFS failure (CLAUDE.md) in prompt form — the two
 * would drift the first time a uniform is added, and the only symptom would be
 * refined shaders quietly failing to compile against a uniform they were never
 * told about.
 */
const SHADER_CONTRACT = `The following uniforms are ALREADY DECLARED and fed per-frame — never redeclare them:
  varying vec2 vUv;              // 0..1 UV coords
  uniform sampler2D uTexture;    // input frame at the routed insert point
  uniform sampler2D tAudio;      // 256x2 texture: y<0.5 FFT bins, y>0.5 waveform; .r = 0..1
  uniform sampler2D tPrev;       // previous output frame (feedback/trails)
  uniform vec2  uResolution;     // canvas size in px
  uniform float uTime;           // seconds
  uniform float uBPM;            // detected tempo (0 = unknown)
  uniform float uBeat;           // beat phase 0..1 (0 = on the beat)
  uniform float uLevel;          // overall audio level 0..1
  uniform float uBass;           // low-band energy 0..1
  uniform float uMid;            // mid-band energy 0..1
  uniform float uHigh;           // high-band energy 0..1
  uniform float uParam1;         // performance knob 0..1
  uniform float uParam2;         // performance knob 0..1
  uniform float uParam3;         // performance knob 0..1
  uniform float uParam4;         // performance knob 0..1

CRITICAL RULES — violating any of these breaks the instrument:
- DO NOT declare uniforms or varyings (uTexture, uTime, vUv, tAudio, tPrev,
  uResolution, uBPM, uBeat, uLevel, uBass, uMid, uHigh, uParam1..4, etc.).
  They are injected automatically by the engine. Redeclaring them — with or
  without precision qualifiers — causes duplicate-declaration compile errors.
  Start your code directly with the // uParams: line followed by
  void main() { ... } (helper functions before main() are allowed).
- Strictly WebGL 1.0 / GLSL ES 1.00: use gl_FragColor and texture2D().
  NEVER use #version, precision statements, in/out qualifiers, texture(),
  fragColor, or any WebGL 2.0 / GLSL ES 3.00 syntax.
- Output ONLY raw GLSL code. NO markdown, NO backticks, no prose.

Rules:
- The FIRST line must be exactly: // uParams: <Label1> | <Label2> | <Label3> | <Label4>
  (short labels for what uParam1..4 control in your shader; always use all four).
- Define void main() exactly once. The shader is a full-screen pass.
- Base the image on uTexture unless the request is clearly fully generative.
- Wire uParam1..4 to the most performance-relevant quantities in the effect.`;

const SHADER_SYSTEM = `You write GLSL ES 1.00 fragment shaders for ImWeb, a live video synthesis instrument.
${SHADER_CONTRACT}`;

/**
 * Refine mode. The performer already has a shader they like on screen and wants
 * ONE thing changed about it — the failure this prompt exists to prevent is the
 * model quietly starting over, which is what happened for every "add to current
 * code …" request before the editor's source was sent at all.
 */
const REFINE_SYSTEM = `You EDIT an existing GLSL ES 1.00 fragment shader for ImWeb, a live video synthesis instrument.
${SHADER_CONTRACT}

REFINEMENT RULES — these override any instinct to write a better shader:
- You are given a WORKING shader and ONE instruction. Apply the instruction and
  change NOTHING else. This is an edit, not a rewrite.
- NEVER start over. Keep the existing structure, helper functions, variable
  names, constants and overall look intact. If the instruction can be satisfied
  by adding a few lines, add a few lines.
- Return the COMPLETE shader, ready to compile — never a diff, never a snippet,
  never "…rest unchanged", never only the function you touched.
- If the instruction introduces a new controllable quantity, wire it to the most
  suitable uParam and update the // uParams: line to match. Keep the existing
  uParam meanings and labels unless the instruction reassigns them.
- If the instruction is vague, make the SMALLEST change that satisfies it.`;

/**
 * Extract GLSL from a model response, discarding conversational text.
 * 1. Fenced block (any language tag) → contents of the first block.
 * 2. Unfenced → slice from the first code-looking line (// uParams:,
 *    #define, uniform/varying/const, a function definition, or void main)
 *    to the last closing brace, dropping prose before and after.
 * 3. Nothing code-looking at all → the trimmed response (compile check
 *    downstream reports the real error).
 * Exported for headless tests.
 */
export function extractGlsl(text) {
  const hasMain = (s) => /void\s+main\s*\(/.test(s);
  const longest = (arr) => arr.reduce((a, b) => (b.length > a.length ? b : a), '');
  // Distinguishes real split-off code (starts with a comment, directive, or
  // top-level declaration/definition) from quoted mid-expression excerpts
  const looksTopLevel = (b) =>
    /^[ \t]*(\/\/|\/\*|#|precision\b|uniform\b|varying\b|const\b|struct\b|(?:float|vec[234]|mat[234]|int)\s+\w+\s*\(|void\s+\w+)/.test(b);

  const blocks = [...text.matchAll(/```[\w-]*[ \t]*\r?\n?([\s\S]*?)```/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);

  let candidate = null;
  if (blocks.length) {
    const withMain = blocks.filter(hasMain);
    // Several complete shaders (model offered variants): take the longest
    if (withMain.length > 1) return longest(withMain);
    if (withMain.length === 1) {
      // One main() — stitch in sibling blocks that look like top-level
      // code (models split helpers and main across fences with prose
      // between), but never quoted mid-expression excerpts
      return blocks
        .filter((b) => b === withMain[0] || looksTopLevel(b))
        .join('\n');
    }
    candidate = longest(blocks); // fences present, but no main() anywhere
  } else {
    // Unclosed fence (response truncated mid-code): take everything after it
    const open = text.match(/```[\w-]*[ \t]*\r?\n?/);
    if (open) candidate = text.slice(open.index + open[0].length).trim() || null;
  }
  if (candidate && hasMain(candidate)) return candidate;

  // Heuristic slice over the raw text — may recover a main() that sat
  // outside the fences; strip any stray fence-marker lines it swallows
  const start = text.search(
    /^[ \t]*(\/\/\s*uParams:|#define\b|precision\b|uniform\b|varying\b|const\b|(?:float|vec[234]|mat[234]|int)\s+\w+\s*\(|void\s+main\b)/m,
  );
  if (start !== -1) {
    const body = text.slice(start);
    const lastBrace = body.lastIndexOf('}');
    const sliced = (lastBrace === -1 ? body : body.slice(0, lastBrace + 1))
      .replace(/^[ \t]*```.*$/gm, '')
      .trim();
    if (hasMain(sliced) || !candidate) return sliced;
  }
  return candidate ?? text.trim();
}

/**
 * Call a provider for shader code and hand back the extracted GLSL.
 * Shared by generate and refine so the empty-response abort and the extraction
 * logging have ONE implementation — the guard below is a documented safety net
 * (CLAUDE.md, Live GLSL & AI Subsystem) and a second copy is a second place for
 * it to be dropped.
 */
async function _shaderCall(system, user, maxTokens, tag, image = null, onDelta = null) {
  // Stream only when someone is watching. Without an onDelta there is nothing
  // to show mid-flight, and the simpler path has fewer ways to go wrong.
  const { text: raw, stop } = onDelta
    ? await _callStream(system, user, maxTokens, image, onDelta)
    : await _callRaw(system, user, maxTokens, image);
  // DEV-only ground truth for diagnosing extraction/model misbehaviour —
  // filter the console with [glsl-ai]
  if (import.meta.env?.DEV) {
    console.log(`[glsl-ai] raw response (${tag}, stop=${stop}):\n${raw}`);
  }

  // Ran out of room. Check this BEFORE the empty-text check and before
  // extraction: a truncated shader is the one failure that can still look like
  // valid code, because extractGlsl slices to the last closing brace and a
  // half-written shader has plenty of those. Injecting it would replace a
  // working shader with a subtly broken one — worse than any error message.
  if (stop === 'max_tokens') {
    throw new Error(
      `The model ran out of room at ${maxTokens} tokens, so the shader came back unfinished.\n` +
      'This is not a quota or key problem. Ask for a smaller change, or shorten the shader ' +
      'in the editor first — a refine has to rewrite the whole thing, so a long shader needs ' +
      'more room than a short one.',
    );
  }
  if (stop === 'refusal') {
    throw new Error(
      'The provider declined this request (safety or content filter) — rephrase the prompt.',
    );
  }

  // Providers throw on HTTP errors, but a 200 with an unexpected shape
  // (wrong model, exhausted quota, a filter that reports nothing) falls back
  // to '' — never feed that to the GLSL compiler as a phantom 'Missing main()'.
  if (!raw?.trim()) {
    throw new Error(
      `Empty response from the AI provider (stop reason: ${stop}) — check the model name, quota, or content filters.`,
    );
  }
  const code = extractGlsl(raw);
  if (import.meta.env?.DEV) {
    console.log(`[glsl-ai] extracted (${tag}):\n${code}`);
  }
  if (!code) throw new Error('The AI response contained no usable code.');
  return code;
}

/**
 * Refine with the frame attached. The rules are the refine rules plus the one
 * thing an image changes: the model can now check its own premise. Without
 * this the picture is decoration — the model reads the code, ignores what it
 * shows, and rewrites from the instruction alone at vision prices.
 */
const REFINE_SEEING_SYSTEM = `${REFINE_SYSTEM}

YOU CAN SEE THE OUTPUT:
- The attached image is the CURRENT output of the shader you are editing.
- Read the image before the code. It tells you what the code actually does,
  which is often not what the code appears to do — a term that looks dominant
  may be invisible, and a subtle one may be all you can see.
- If the image already shows what was asked for, say so by making a SMALL
  adjustment rather than a rewrite.
- If the image is black, blown out, or flat, treat that as the first thing to
  fix — those are bugs in the look, whatever the instruction said.
- Do not describe the image. Return only the shader.`;

/**
 * Token ceilings for the two shader paths.
 *
 * Refine gets a much larger one than generate and it is not arbitrary: a
 * generate writes ONE shader, a refine must re-emit the whole existing shader
 * on top of whatever the model thinks first. At the old 4000/6000 a real
 * refine of a ~60-line shader came back as 'Empty response from the AI
 * provider' — the budget had gone entirely on thinking, leaving no text block
 * at all. Raising a ceiling is free; hitting one wastes the whole request.
 */
const GENERATE_TOKENS = 8000;
const REFINE_TOKENS   = 16000;

/**
 * Generate a Live GLSL shader from a natural-language description.
 * Pass priorCode + priorError for the single automatic recovery retry.
 */
export async function generateShader(description, priorCode = null, priorError = null, onDelta = null) {
  const user = priorError
    ? `Your previous shader failed to compile.\nCompiler error:\n${priorError}\n\nBroken code:\n${priorCode}\n\nOutput ONLY the corrected COMPLETE shader (same rules) for the original request: "${description}". Do not explain the fix, do not quote the broken lines — code only.`
    : `Write a shader: "${description}"`;
  // max_tokens is a CEILING, not a charge — you pay for tokens produced, so
  // headroom costs nothing and truncation costs the whole request. On
  // adaptive-thinking models this budget covers thinking AND code, and a
  // complex shader thinks a lot before it writes a line.
  return _shaderCall(SHADER_SYSTEM, user, GENERATE_TOKENS,
    priorError ? 'generate retry' : 'generate', null, onDelta);
}

/**
 * Refine the shader the performer already has on screen: `currentCode` plus one
 * `instruction`, complete shader back. Pass priorCode + priorError for the same
 * single compile-recovery retry generateShader gets.
 *
 * Budget is larger than generate's on purpose — see REFINE_TOKENS. Truncation
 * is now DETECTED rather than injected: _shaderCall throws on a max_tokens
 * stop, so a half-written shader can never replace the working one.
 */
export async function refineShader(instruction, currentCode, priorCode = null, priorError = null, image = null, onDelta = null) {
  if (!currentCode?.trim()) throw new Error('Nothing to refine — the editor is empty.');
  // On the compile-recovery retry the frame is dropped deliberately: the
  // question there is "why did this not compile", which the compiler error
  // answers exactly. Paying for an image to re-ask it is waste, and the last
  // frame is of the shader that FAILED — misleading evidence for the fix.
  const seeing = !!image && !priorError;
  const user = priorError
    ? `Your previous edit failed to compile.\nCompiler error:\n${priorError}\n\nBroken code:\n${priorCode}\n\nThe shader you were asked to edit:\n${currentCode}\n\nThe requested change was: "${instruction}"\n\nOutput ONLY the corrected COMPLETE shader (same rules). Do not explain the fix — code only.`
    : seeing
      ? `The attached image is what this shader is CURRENTLY putting on screen. Look at it, then apply ONE change.\n\nCURRENT SHADER:\n${currentCode}\n\nCHANGE TO APPLY: "${instruction}"\n\nJudge the change against what you can see — if the image already shows what was asked for, make the smallest adjustment that improves it rather than rewriting. Return the complete edited shader.`
      : `Here is the shader currently running. Keep it, and apply ONE change.\n\nCURRENT SHADER:\n${currentCode}\n\nCHANGE TO APPLY: "${instruction}"\n\nReturn the complete edited shader.`;
  return _shaderCall(
    seeing ? REFINE_SEEING_SYSTEM : REFINE_SYSTEM,
    user, REFINE_TOKENS,
    priorError ? 'refine retry' : (seeing ? 'refine+vision' : 'refine'),
    seeing ? image : null,
    onDelta,
  );
}

// ── Feature 2: Parameter Narrator ────────────────────────────────────────────

const NARRATOR_LENGTHS = {
  short:  { words: 15, maxTokens: 80,  sentences: 'ONE concise sentence' },
  medium: { words: 35, maxTokens: 150, sentences: 'one or two sentences' },
  long:   { words: 70, maxTokens: 250, sentences: 'two or three sentences' },
};

function narratorSystem(length, seeing) {
  const cfg = NARRATOR_LENGTHS[length] ?? NARRATOR_LENGTHS.medium;
  // With an image the instruction inverts: the patch stops being the subject
  // and becomes vocabulary for naming what is actually on screen. Without this
  // the model dutifully reads the parameter list back with a picture attached,
  // which is the same narration as before at vision prices.
  return seeing
    ? `You are the voice of ImWeb, a real-time video synthesis instrument.
You are shown THE CURRENT OUTPUT FRAME plus the signal path that produced it.
Describe what you SEE — the image is the subject; the signal path is only there
to give you the right words for it (source names, effects, modes).
Return ${cfg.sentences} (max ${cfg.words} words total).
Name colours, movement, texture, density, what dominates the frame. If the frame
is black or nearly empty, say so plainly.
Do not list parameters. Do not describe the patch. No preamble. No trailing punctuation.`
    : `You are the voice of ImWeb, a real-time video synthesis instrument.
Given a snapshot of the current signal path, return ${cfg.sentences} (max ${cfg.words} words total) describing
what is visually happening — like "Camera keyed over noise with slow displacement feedback loop".
Be specific about what's active: name the sources, effects, and modes in play. No punctuation at end. No preamble.`;
}

/**
 * `image` — { b64, mime } of the current output frame, or null for the
 * text-only narration.
 */
export async function narrateState(stateSnapshot, length = 'medium', image = null) {
  const cfg = NARRATOR_LENGTHS[length] ?? NARRATOR_LENGTHS.medium;
  return _call(
    narratorSystem(length, !!image),
    image
      ? `This is the current output frame. The signal path producing it: ${stateSnapshot}`
      : `Current signal path: ${stateSnapshot}`,
    cfg.maxTokens,
    image,
  );
}

// Imported, not copied. A hand-copy here drifted twice: once causing the
// Narrator to describe the wrong source entirely (e.g. "Noise" reported as
// "3D"), and again at 25 entries against a 27-entry list, so any layer routed
// to Movie B or Mix Bus was narrated as '?'.
const SOURCE_NAMES = SOURCES;

// Adds a short, source-specific detail (e.g. which noise type or 3D geometry
// is active) so the Narrator can describe what's actually on screen, not just
// which slot it's routed through.
function describeSourceDetail(name, ps) {
  switch (name) {
    case 'Noise': {
      const t = ps.get('noise.type');
      return t?.options ? `noise=${t.options[t.value] ?? '?'}` : null;
    }
    case '3D Scene':
    case '3D Depth': {
      if (!ps.get('scene3d.active')?.value) return null;
      const g = ps.get('scene3d.geo');
      return g?.options ? `3D=${(g.options[g.value] ?? '?').replace(/^.*: /, '')}` : null;
    }
    case 'SDF': {
      if (!ps.get('sdf.active')?.value) return null;
      const s = ps.get('sdf.shape');
      return s?.options ? `SDF=${s.options[s.value] ?? '?'}` : null;
    }
    case 'Analog': {
      const t = ps.get('analog.sourceType');
      return t?.options ? `analog=${t.options[t.value] ?? '?'}` : null;
    }
    case 'Seq1': case 'Seq2': case 'Seq3': {
      const s = ps.get(`${name.toLowerCase()}.source`);
      return s?.options ? `${name} src=${s.options[s.value] ?? '?'}` : null;
    }
    case 'SlitScan':
      return ps.get('slitscan.active')?.value ? 'slit-scan' : null;
    case 'Particles': return 'particle field';
    case 'VWarp':     return 'vasulka warp';
    case 'TimeDisp':  return 'time-displaced';
    default: return null;
  }
}

export function buildStateSnapshot(ps) {
  const fg = SOURCE_NAMES[ps.get('layer.fg').value] ?? '?';
  const bg = SOURCE_NAMES[ps.get('layer.bg').value] ?? '?';
  const ds = SOURCE_NAMES[ps.get('layer.ds').value] ?? '?';
  const parts = [`FG=${fg}`, `BG=${bg}`, `DS=${ds}`];

  for (const name of new Set([fg, bg, ds])) {
    const detail = describeSourceDetail(name, ps);
    if (detail) parts.push(detail);
  }

  if (ps.get('keyer.active')?.value) parts.push('keyer active');
  if (ps.get('displace.amount')?.value > 0.05) parts.push(`displace=${ps.get('displace.amount').value.toFixed(2)}`);
  if (ps.get('blend.active')?.value) parts.push(`blend=${ps.get('blend.amount')?.value?.toFixed(2) ?? '?'}`);
  const tm = ps.get('transfermode.mode')?.value;
  if (tm && tm > 0) {
    const modes = ['XOR','OR','AND','Multiply','Screen','Add','Difference','Exclusion',
      'Overlay','Hardlight','Softlight','Dodge','Burn','Subtract','Divide'];
    parts.push(`mode=${modes[tm-1] ?? tm}`);
  }
  if (ps.get('colorshift.amount')?.value > 0.05) parts.push('colorshift');
  if (ps.get('effect.bloom')?.value)   parts.push('bloom');
  if (ps.get('effect.kaleid')?.value)  parts.push('kaleidoscope');
  if (ps.get('effect.mirror')?.value)  parts.push('quad-mirror');
  if (ps.get('effect.strobe')?.value)  parts.push('strobe');
  if (ps.get('effect.pixsort')?.value) parts.push('pixel-sort');
  if (Math.abs(ps.get('feedback.x')?.value ?? 0) > 0.02 || Math.abs(ps.get('feedback.y')?.value ?? 0) > 0.02) {
    parts.push('feedback-drift');
  }
  return parts.join(', ');
}

// ── Feature 3: Performance Coach ─────────────────────────────────────────────

const COACH_SYSTEM = `You are a performance coach for ImWeb, a real-time video synthesis instrument.
Given a 30-second snapshot of parameter activity, suggest ONE short actionable thing to try.
Keep it under 12 words. Start with a verb. Be specific to ImWeb parameters and sources.
Examples: "Try routing Noise to FG for more texture" or "Increase feedback.x to drift the frame"
No preamble, no explanation, just the suggestion.`;

const COACH_SEEING_SYSTEM = `You are a performance coach for ImWeb, a real-time video synthesis instrument.
You are shown THE CURRENT OUTPUT FRAME and a 30-second snapshot of parameter activity.
Judge the IMAGE first — is it too dark, blown out, static, cluttered, monotone? —
then suggest ONE short actionable change that would improve what is on screen.
Under 12 words. Start with a verb. Name a real ImWeb parameter or source.
No preamble, no explanation, just the suggestion.`;

/** `image` — { b64, mime } of the current frame, or null for text-only coaching. */
export async function coachSuggestion(activitySnapshot, image = null) {
  return _call(
    image ? COACH_SEEING_SYSTEM : COACH_SYSTEM,
    `30-second performance activity: ${activitySnapshot}`,
    80,
    image,
  );
}

export function buildActivitySnapshot(recentChanges, ps) {
  // DEDUPED AND SORTED, not the raw event log.
  //
  // `recentChanges` is one entry per onChange, and every param carrying a
  // controller fires on every frame — so a single LFO put its id in this list
  // hundreds of times, in an order that shifted as entries aged out of the 30s
  // window. Two consequences, both bad: the model was handed
  // "displace.amount, displace.amount, …" ×300 instead of a legible summary,
  // and the Coach's change gate could never see two ticks as equal, so the
  // gate suppressed nothing on any patch with a controller running.
  //
  // Sorted so the same set of touched params always renders the same string —
  // an unsorted set still varies with insertion order.
  const ids = [...new Set(recentChanges.map(r => r.id))].sort();
  const changed   = ids.join(', ') || 'nothing';
  const unchanged = ['keyer.active','displace.amount','blend.active','effect.bloom','effect.kaleid','effect.mirror']
    .filter(id => !ids.includes(id))
    .join(', ');
  const fg = SOURCE_NAMES[ps.get('layer.fg').value] ?? '?';
  const bg = SOURCE_NAMES[ps.get('layer.bg').value] ?? '?';
  return `Current FG=${fg}, BG=${bg}. Recently changed: ${changed}. Untouched: ${unchanged}.`;
}

// ── AIFeatures class ──────────────────────────────────────────────────────────

export class AIFeatures {
  constructor(ps, ui) {
    this.ps = ps;
    this.ui = ui;
  }

  // Config accessors
  getConfig()             { return _config(); }
  setActiveProvider(id)   { _config().activeProvider = id; saveConfig(_config()); }
  setProviderKey(id, key) {
    const cfg = _config();
    const pCfg = (cfg.providers[id] ??= {});
    if (pCfg.apiKey !== key) delete pCfg.lastTest;
    pCfg.apiKey = key;
    saveConfig(cfg);
  }
  setProviderModel(id, m) { (_config().providers[id] ??= {}).model  = m;   saveConfig(_config()); }

  setNarratorInterval(ms) { _config().narrator = { ..._config().narrator, interval: ms }; saveConfig(_config()); }
  setNarratorLength(len)  { _config().narrator = { ..._config().narrator, length: len }; saveConfig(_config()); }
  setCoachInterval(ms)    { _config().coach    = { ..._config().coach, interval: ms };    saveConfig(_config()); }
  setVision(which, on)    { _config().vision   = { ..._config().vision, [which]: !!on };   saveConfig(_config()); }
  getVisionConfig()       { return getVisionConfig(); }

  // Persist the result of a connection test for a provider, with a timestamp
  // so the status survives panel rebuilds and page reloads.
  setProviderTestResult(id, { ok, message }) {
    const cfg = _config();
    (cfg.providers[id] ??= {}).lastTest = { ok, message, ts: Date.now() };
    saveConfig(cfg);
  }

  // Internal call router (delegates to module-level _call)
  async _call(system, user, maxTokens = 512) { return _call(system, user, maxTokens); }

  // Test the active provider with a minimal request
  async testConnection() {
    return _call('Reply with exactly the word: ok', 'ok', 10);
  }

  // Fetch the live model list for a provider from its API
  async fetchModels(id) { return fetchModels(id); }

  // Token accounting
  getCoachLog()   { return getCoachLog(); }
  clearCoachLog() { return clearCoachLog(); }
  getUsage()   { return getUsage(); }
  resetUsage() { return resetUsage(); }
  usageCost(provider, model, inTok, outTok) { return usageCost(provider, model, inTok, outTok); }

  // Feature methods (delegates to module-level functions)
  async generatePreset(description)    { return generatePreset(description, this.ps); }
  async narrateState()                 { return narrateState(buildStateSnapshot(this.ps), _config().narrator?.length); }
  async coachSuggestion(recentChanges) { return coachSuggestion(buildActivitySnapshot(recentChanges, this.ps)); }
}
