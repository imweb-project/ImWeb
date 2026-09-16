# ImWeb v0.25.0 — Hands On

*Released 2026-09-16*

This release is about the things in your hands. OSC remotes, a Flic button and
any gamepad now bind the way MIDI always has — by touching the control — and
they share the four mapping pages with it. Buttons can drive a value both ways,
sticks can push a value and let go of it, and a remote is told where its
controls are when the page changes. Everything here was tested on a real Flic
and a real Logitech Cordless RumblePad 2, not only in the test suite.

## Learn by touching the control

- **OSC Learn** — right-click a parameter → **OSC Learn**, press the button or
  move the fader. Its address binds to that row, so you never type a parameter
  id into a controller app. ImWeb listens for about a second and binds **the
  control that moved**, so a layout streaming an accelerometer cannot steal the
  binding. The badge names the address: `OSC:/flic/1`.
- **Gamepad Learn** — the same for a pad: right-click → **Gamepad Learn**, then
  press a button or push a stick. The menu's A/B/X/Y names mean nothing on a pad
  printed 1–10; learn asks the pad instead. A stick resting slightly off-centre
  cannot steal the binding.
- A **PAD** chip in the status bar lights when the browser can see your pad
  (press a button on it first — browsers hide pads until then) and pulses while
  learn waits.

## PAD IN: what is this button called?

Under MIDI In in the I/O panel, **PAD IN** shows every control you touch by the
name its badge will have once mapped — `G:↑`, `G:LX 0.73`, `G:RT 0.40` — and what
it already drives on the current page. Map without guessing.

## Buttons that go both ways, sticks that stay

- **Latch** — tick it in a badge's popover and each press alternates a
  continuous parameter between the row's min and max. A Flic, which sends the
  same message every click, can now drive a value down as well as up. Works the
  same for OSC, MIDI pads, gamepad buttons and keys. Badge: `⇄`.
- **Relative sticks** — a stick springs back to centre, so it could only hold a
  value while you held it. Tick **Relative (push, stays)** and pushing *moves*
  the value — faster the further you push — and letting go leaves it there.
  Pushing up raises; **Full range (s)** sets the speed. Badge: `↕`.

## Mapping pages for every input

The four pages used to hold MIDI only; on a rig with no MIDI they moved and
changed nothing. Now **MIDI, OSC and gamepad bindings all live on pages**, and
the settings you give a binding (Latch, Relative, channel) stay with its page.

- **Soft takeover** comes along for the controls that have a position — a MIDI
  fader or a stick does not jump its parameter after a page switch. Buttons,
  latched rows, relative sticks and OSC are exempt and act on the first touch.
- **An OSC remote is told where to be.** On a page switch each learned control
  is sent its new parameter's position, so a TouchOSC layout repositions itself.
- The page-step rows are now **Prev Page** and **Next Page** — as "Map Page −"
  and "Map Page +" they were cut off to the same "Map Page..." in the panel.

## OSC that talks to the right place

- **Feedback** — ImWeb reports changes back to your remote, batched, and only to
  what the remote actually talks to: a learned control at its own address. It
  had been documented but never wired; the first version then sent 70–90
  messages a second to a Flic that has nothing to display.
- `/imweb/toggle/<id>` flips a toggle on each press (a Flic could turn one on
  and never off), and a momentary button fires a trigger once, not twice.

## Fixes

- A **gamepad no longer pins** the parameters bound to it — a resting stick held
  its parameter at 0.5 and overwrote every state recall within a frame.
- Two parameters bound to **one gamepad button** both respond.
- The **status bar works on a first launch** — the OSC chip ignored clicks until
  the startup project had finished loading.
- A **cleared controller stops showing on its row** after a state recall; the
  badge used to keep advertising a binding that was gone, which looked exactly
  like dead hardware.
- Settings made in the **badge popover stay on their mapping page** instead of
  vanishing on the next page switch.
- The manual's OSC address was wrong (`/param/…`); it is `/imweb/<paramId>`.

## Under the hood

"Press acts, release does not" existed five times over and the copies disagreed;
it is now one rule in `src/controls/controlInput.js` that MIDI, OSC, keyboard and
gamepad all call. Six new audits — `audit-control-input`, `audit-mapping-pages`,
`audit-gamepad`, `audit-osc`, `audit-state-recall-badges` and
`audit-boot-nonblocking` — and the mutation suite catches **155 of 155**
deliberate breakages, up from 106.

Full detail in [CHANGELOG.md](CHANGELOG.md).
