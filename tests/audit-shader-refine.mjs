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

const { refineShader, generateShader } = await import('../src/ai/AIFeatures.js');

const fails = [];
const check = (label, cond) => { if (!cond) fails.push(label); };

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

if (fails.length) {
  console.error('FAIL audit-shader-refine:');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS audit-shader-refine — refine carries the editor source; generate does not');
