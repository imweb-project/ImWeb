/**
 * Step-sequencer controller audit.
 *
 * Why this exists. The sequencer is a controller type: a row of values stepped
 * through by a clock, written to one parameter. Its failures are quiet ones —
 * a row that still moves, at about the right speed, and is simply not the row
 * that was drawn:
 *
 *  - a long frame that makes it skip steps, so the pattern drifts against the
 *    beat it was locked to;
 *  - a skipped step that jumps to zero instead of holding (a rest that clicks);
 *  - ping-pong that plays its two end steps twice, turning 8 steps into 10;
 *  - a row restored from a state that still SHARES its arrays with the state,
 *    so drawing on it rewrites the saved state under the performer's hand;
 *  - a playhead that keeps its own copy of the row and goes on playing what
 *    the row was when it was assigned.
 *
 * The stepping is pure and imports nothing, so it is driven here with a fixed
 * clock and a random source that does what the test says.
 *
 * Run:  node tests/audit-seq-controller.mjs
 */
import { readFileSync } from 'node:fs';
import {
  SeqController, seqDefaults, seqNormalize, SEQ_MAX_STEPS, SEQ_DIRECTIONS,
} from '../src/controls/SeqController.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

/** Run a config for `n` steps at one tick per step; return the indices played. */
const play = (c, n, rng = () => 0.5) => {
  const s = new SeqController(rng);
  const idx = [], val = [];
  for (let i = 0; i < n; i++) { val.push(s.tick(c, 1 / c.hz)); idx.push(s.index); }
  return { idx, val, s };
};
const cfg = (over = {}) => seqNormalize({ type: 'seq', ...over });

console.log('the row is played as drawn');
{
  const c = cfg({ count: 4, steps: [0.1, 0.4, 0.7, 1], hz: 2 });
  const { idx, val } = play(c, 9);
  check('forward visits every step in order and wraps', idx.join('') === '012301230', idx.join(' '));
  check('and writes that step\'s value', val.slice(0, 4).join() === '0.1,0.4,0.7,1', val.slice(0, 4).join(' '));
  check('reverse runs the other way', play(cfg({ count: 4, dir: 1 }), 5).idx.join('') === '32103');
  const pp = play(cfg({ count: 4, dir: 2 }), 9).idx.join('');
  check('ping-pong plays the end steps once each, not twice', pp === '012321012', pp);
  let r = 0;
  const seqRng = () => { r = (r + 0.37) % 1; return r; };
  const rnd = play(cfg({ count: 5, dir: 3 }), 60, seqRng).idx;
  check('random never repeats a step back to back and reaches them all',
    rnd.every((v, i) => i === 0 || v !== rnd[i - 1]) && new Set(rnd).size === 5,
    rnd.slice(0, 20).join(' '));
  check('a one-step row is that step, in every direction',
    [0, 1, 2, 3].every((d) => play(cfg({ count: 1, dir: d }), 4).idx.every((i) => i === 0)));
  check('there are four directions, as the menu lists', SEQ_DIRECTIONS.length === 4);
}

console.log('\nthe clock');
{
  const c = cfg({ count: 8, hz: 4 });
  const s = new SeqController(() => 0.5);
  const seen = [];
  for (let i = 0; i < 240; i++) { s.tick(c, 1 / 60); if (seen.at(-1) !== s.index) seen.push(s.index); }
  check('4 steps a second for 4 seconds is 16 steps', seen.length === 16 || seen.length === 17, `${seen.length}`);
  // A stalled frame: 1.3 s arrives at once. The pattern must lose TIME, not order.
  const t = new SeqController(() => 0.5);
  t.tick(c, 0.01); const a = t.index;
  t.tick(c, 1.3);
  check('a long frame advances one step, never several — the pattern keeps its order',
    t.index === (a + 1) % 8, `from step ${a} to step ${t.index}`);
  // Beat sync: the position comes from the beat clock, not from dt.
  const b = cfg({ count: 4, beatSync: true, beatDiv: 0.5 });
  const u = new SeqController(() => 0.5);
  const beats = [];
  for (let ph = 0; ph < 4; ph += 0.125) { u.tick(b, 123, ph); if (beats.at(-1) !== u.index) beats.push(u.index); }
  check('synced, half a beat is one step whatever dt says', beats.join('') === '01230123', beats.join(' '));
}

console.log('\nrests, chance and glide');
{
  const c = cfg({ count: 4, steps: [0.2, 0.9, 0.5, 0.1], on: [1, 0, 1, 1], hz: 1 });
  const { val } = play(c, 4);
  check('a skipped step HOLDS the value before it — a rest, not a jump to zero',
    val.join() === '0.2,0.2,0.5,0.1', val.join(' '));
  const never = play(cfg({ count: 4, steps: [0.3, 0.6, 0.9, 1], chance: 0.25 }), 4, () => 0.9).val;
  check('a step that loses its chance holds too', never.join() === '0.3,0.3,0.3,0.3', never.join(' '));
  const always = play(cfg({ count: 4, steps: [0.3, 0.6, 0.9, 1], chance: 0.25 }), 4, () => 0.1).val;
  check('and one that wins it sounds', always.join() === '0.3,0.6,0.9,1');
  check('the very first step always sounds — there is nothing to hold yet',
    play(cfg({ count: 2, steps: [0.7, 0.2], on: [0, 0] }), 1).val[0] === 0.7);

  const g = cfg({ count: 2, steps: [0, 1], hz: 1, glide: 0.5 });
  const s = new SeqController(() => 0.5);
  s.tick(g, 1);                       // step 0: value 0
  const quarter = s.tick(g, 1.25);    // into step 1, a quarter of the way through it
  const s2 = new SeqController(() => 0.5);
  s2.tick(g, 1); s2.tick(g, 1.0001);
  const late = s2.tick(g, 0.75);
  check('glide slides to the new step over that share of it', Math.abs(quarter - 0.5) < 1e-6, `${quarter}`);
  check('and then sits on it', late === 1, `${late}`);
}

console.log('\nevolve rewrites the row you see');
{
  const c = cfg({ count: 4, steps: [0.5, 0.5, 0.5, 0.5], evolve: 1, hz: 1 });
  const before = c.steps.slice(0, 4).join();
  let r = 0;
  play(c, 9, () => { r = (r + 0.31) % 1; return r; });
  check('the steps in the CONFIG drift — what plays is what is drawn', c.steps.slice(0, 4).join() !== before);
  check('and stay inside 0..1', c.steps.every((v) => v >= 0 && v <= 1));
  const still = cfg({ count: 4, steps: [0.5, 0.5, 0.5, 0.5], evolve: 0, hz: 1 });
  play(still, 9);
  check('with Evolve at 0 the row is never touched', still.steps.slice(0, 4).join() === '0.5,0.5,0.5,0.5');
}

console.log('\nthe configuration is plain data, and its own');
{
  const d = seqDefaults();
  check('the defaults survive JSON — they save with a state like any controller',
    JSON.stringify(JSON.parse(JSON.stringify(d))) === JSON.stringify(d));
  check('sixteen steps are always present, whatever the count', d.steps.length === SEQ_MAX_STEPS && d.on.length === SEQ_MAX_STEPS);
  const saved = { type: 'seq', count: 3, steps: [0.1, 0.2, 0.3], on: [1, 1, 0] };
  const live = seqNormalize({ ...saved });
  live.steps[0] = 0.99; live.on[1] = 0;
  check('a row restored from a state does not share its arrays with the state',
    saved.steps[0] === 0.1 && saved.on[1] === 1, `the saved copy became ${saved.steps[0]}`);
  check('missing fields are filled in', live.hz > 0 && live.chance === 1 && live.steps.length === SEQ_MAX_STEPS);
  check('and out-of-range values are brought in',
    seqNormalize({ count: 99, steps: [5, -1] }).count === SEQ_MAX_STEPS && seqNormalize({ steps: [5, -1] }).steps[0] === 1);

  const cm = readFileSync(new URL('../src/controls/ControllerManager.js', import.meta.url), 'utf8');
  check('the manager reads the row off the parameter on every tick',
    /this\.seqs\.forEach\(\(seq, paramId\) => \{\s*const c = this\.ps\.get\(paramId\)\?\.controller;/.test(cm),
    'a controller object holding its own copy plays the row as it was when assigned');
  check('assign normalizes the LIVE config', /seqNormalize\(p\.controller\)/.test(cm));
  check('removing a controller removes its playhead', /this\.seqs\.delete\(paramId\)/.test(cm));
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  check('it is in the controller menu', /data-ctrl="seq"/.test(html));
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll step-sequencer checks passed.\n');
process.exit(failures ? 1 : 0);
