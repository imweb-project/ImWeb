# ImWeb v0.24.0 — Eyes on the Output

*Released 2026-09-14*

The AI layer was rebuilt. It can now look at what the instrument is making,
it reaches the whole instrument instead of a stale corner of it, it writes
shaders in front of you, and it has learned to stay quiet when nothing has
changed.

## New: the AI can see the output

**Canvas vision** is two switches in the AI settings panel. With it on, the
**Narrator** describes the picture — colour, movement, texture, what dominates
the frame — instead of reciting the patch, and the **Coach** can judge the image:
"too dark", "gone static".

The AI Shader modal gains **Let it see the canvas** in Refine mode. The model
reads the frame *before* the code, because the picture says what a shader
actually does, which is often not what it appears to do.

Vision is **off by default**, and the panel says what it costs. It works on every
provider, including local Ollama.

## Shaders stream, and Refine edits what is there

- **Refine this shader** sits beside *Start new*, and is the default whenever the
  editor holds a custom shader. "Add a slow zoom to this" now adds to what is on
  screen instead of quietly replacing it.
- The code **streams into the editor** as the model writes it, instead of a
  dead panel for twenty seconds.
- **Undo (`↩`)** puts back the shader and knob labels from before the last AI
  write.
- **Dictate the prompt (🎤)** with the browser's own speech recognition.
- A reply that ran out of room, or was refused, is reported as exactly that —
  and a half-written shader is never injected over a working one.

## The State Generator works again — on the whole instrument

The list of parameters the model was given had been hand-written and had
rotted: 17 of its 39 ids no longer existed and its source table was off by one.
It is now **derived from the instrument itself**, so **594 of 731 parameters**
are reachable, up from 22. Every value is checked before it is written, and the
panel tells you what was set, what was clamped and what was ignored.

## The Narrator and Coach only speak when something changed

Both used to fire on a timer whatever happened, re-describing an untouched patch
for the life of the session. Now they call the provider only when the patch —
or, with vision on, the picture — has moved. Measured: **one call over six ticks
on an idle patch, where it was six.** The Coach's last eight suggestions are
kept in the settings panel, so advice you glanced away from is not lost. Both
have labelled Run buttons beside their settings.

## A token meter

This session, the last call, and a row per provider and model, from each
provider's own usage report — never a guess. Cost is shown where a published
rate is on file; local models show a real $0.00.

## An OSC relay

`node tools/osc-relay.mjs` bridges OSC from TouchOSC, Max or a Flic button into
the browser, which cannot open a UDP socket on its own.

## Under the hood

Four audits (`audit-ai-param-reference`, `audit-ai-usage`, `audit-ai-vision`,
`audit-ai-streaming`) join `audit-shader-refine`. Every provider difference that
fails silently — stop reasons, token usage, image envelopes, stream framing — is
covered, and the mutation suite catches **106 of 106** deliberate breakages.

Full detail in [CHANGELOG.md](CHANGELOG.md).
