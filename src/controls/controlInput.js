/**
 * One rule for every physical input: **a button is not a fader.**
 *
 * A momentary control speaks twice per use — 127 then 0, note-on then note-off,
 * pressed then released, 1 then 0 over OSC. A fader's value IS the message; a
 * button's release is not a second instruction. Feeding both straight into
 * `setNormalized` makes a TOGGLE run only while held and a TRIGGER fire twice
 * per press, which is how the owner described it: "it bangs, but bangs again
 * when released".
 *
 * This existed five times over — MIDI CC, MIDI note, the computer keyboard, the
 * gamepad, and a learned OSC address — and the copies did not agree. MIDI CC
 * shipped without the rule (#83) and OSC shipped without it again months later,
 * each fixed alone. `tests/audit-midi-buttons.mjs` predicted the rest:
 *
 *   "the next input path can be added with the same hole and no test will
 *    notice. These assertions are about the RULE, not about one controller."
 *
 * So the rule lives here, the call sites translate their own hardware into
 * `isPress`, and `tests/audit-control-input.mjs` drives every path through the
 * same scenarios and demands the same answers.
 *
 * Deliberately NOT here:
 *  - **pickup** (soft takeover), which is armed by a mapping-page switch and
 *    therefore belongs to whoever owns the page state. Every input path that
 *    reports a POSITION now passes `pickupBlocked` — a button never does, since
 *    it has no position to pick up.
 *  - **response tables and slew**, which belong to `Parameter.setNormalized`
 *    and must stay there: both write paths resolve tables in one place, and
 *    re-resolving per call site is the bug tests/audit-table-write-paths.mjs
 *    exists to prevent.
 */

/**
 * Apply one input event to one parameter.
 *
 * @param {object} param        the Parameter
 * @param {object} ev
 * @param {number} ev.norm      the control's position, 0..1. Ignored for
 *                              TOGGLE and TRIGGER, which have no position.
 * @param {boolean} ev.isPress  true on the leading edge only. Each caller
 *                              decides what its hardware means: a CC crossing
 *                              half scale upward, a note-on with velocity, a
 *                              gamepad button's rising edge, an OSC message
 *                              with no argument or a value above 0.5.
 * @param {boolean} [ev.pickupBlocked]  true when soft takeover is swallowing
 *                              this value (MIDI only — see above).
 * @returns {boolean} whether the parameter was written.
 */
export function applyControlInput(param, { norm = 0, isPress = false, pickupBlocked = false } = {}) {
  if (!param) return false;

  // A button has no position, so neither branch consults `norm` — and neither
  // consults pickup either: a button cannot "pick up" a value, and blocking one
  // after a page switch would leave it looking dead until pressed twice.
  if (param.type === 'toggle') {
    if (isPress) param.toggle();
    return isPress;
  }
  if (param.type === 'trigger') {
    if (isPress) param.trigger();
    return isPress;
  }

  // ── Latch ─────────────────────────────────────────────────────────────────
  // A press-only device — a Flic sends the same message every click — can
  // otherwise drive a continuous parameter one way and never back. Latched, a
  // press ALTERNATES between the row's two ends.
  //
  // Which end is decided by where the value IS, not by a remembered side: the
  // press travels to whichever end it is further from. That is what makes a
  // state recall harmless — a recall that moves the value also moves the next
  // press's destination, where a stored "side" would desynchronise and read as
  // a skipped press.
  //
  // The ends are the row's own min/max fields (`ctrlMin`/`ctrlMax`), which
  // already bound every controller write, so "max" means whatever that field
  // says rather than the parameter's absolute ceiling.
  if (isLatched(param)) {
    if (!isPress) return false;   // the release never acts, exactly as a toggle
    const lo = param.ctrlMin ?? param.min;
    const hi = param.ctrlMax ?? param.max;
    const n = param.value < (lo + hi) / 2 ? 1 : 0;
    // `setNormalized` applies `invert` before mapping, so without this flip a
    // latched press under invert lands on the end it started from and sticks.
    param.setNormalized(param.invert ? 1 - n : n);
    return true;
  }

  if (pickupBlocked) return false;
  param.setNormalized(Math.max(0, Math.min(1, norm)));
  return true;
}

/**
 * Which controller types live in a MAPPING PAGE.
 *
 * Pages exist because a physical desk has fewer controls than the instrument
 * has parameters: a nanoKONTROL2 has eight faders, a Flic has one button, a pad
 * has four axes. Anything with that scarcity earns pages. The field is still
 * called `midiPages` — saved states, banks, .imweb files and MIDI mappings all
 * carry the name, and renaming it buys nothing but a migration.
 *
 * NOT paged, and each for its own reason:
 *  - `key` — a computer keyboard has a hundred keys and is always attached, so
 *    it has none of the scarcity pages exist to relieve. Paging it would only
 *    make a performance key stop working with no visible cause.
 *  - every GENERATED controller (lfo-*, random, fixed, expr, sound, tilt,
 *    mouse, stroke) — these are not a control surface at all, and having an LFO
 *    disappear on a page switch would read as data loss, not as paging.
 *
 * One predicate, used by the page writer, the page projection, the saved-file
 * migration and the bulk clear. Those four disagreeing is exactly how a binding
 * ends up in a page that nothing will ever project back out of it.
 */
export function isPagedBinding(type) {
  const t = String(type ?? '');
  return t.startsWith('midi') || t === 'osc' || t.startsWith('gamepad-');
}

/**
 * Latch applies to a CONTINUOUS parameter driven by a button, and nowhere else.
 *
 * A toggle already alternates on the press, so the option would be redundant
 * there; a trigger has nothing to alternate between. Read from the controller
 * rather than passed in by each call site: five callers that must all remember
 * to forward a flag is the duplication this module exists to remove.
 */
export function isLatched(param) {
  return !!param?.controller?.latch && param.type === 'continuous';
}

/**
 * Relative applies to a CONTINUOUS parameter driven by a gamepad STICK axis.
 *
 * A stick springs back to centre, so as a position it can only hold a value
 * while the hand holds the stick. Relative, it is a jog: deflection is a SPEED,
 * and letting go leaves the value where it got to. Buttons and OSC have no
 * deflection to read a speed from, so the flag means nothing there.
 */
export function isRelative(param) {
  return !!param?.controller?.relative && param.type === 'continuous'
    && String(param.controller.type).startsWith('gamepad-axis-');
}
