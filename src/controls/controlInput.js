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
 *  - **pickup** (soft takeover), which is armed only by a MIDI mapping-page
 *    switch, so a gamepad or OSC binding never has an entry to gate against.
 *    Passing an inert gate through this function would read as coverage it does
 *    not have. The caller that can arm it passes `pickupBlocked`.
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

  if (pickupBlocked) return false;
  param.setNormalized(Math.max(0, Math.min(1, norm)));
  return true;
}
