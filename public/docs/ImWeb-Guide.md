# ImWeb — Guided Tour

The content of the in-app guided tour (**Shift+G**, the **?** menu in the status
bar, or the Guided tour button on the first-run splash). This file *is* the
tour — the panel parses it at runtime, so editing the prose here changes what the
app says. It is also meant to read straight through as a document.

**The tour points; it never sets.** Each step names parameters, and the panel
gives you a button per name that switches to the right tab, opens the right
section, and flashes the row. Your hand moves the control. Nothing in this file
can change a value, which is why it is safe to open mid-performance.

Three tracks, chosen with the chips at the top of the panel:

- **Basics** — the panel, the parameter row, controllers, states, keys. What you
  need before anything else makes sense.
- **Principles** — six small patches, each demonstrating one idea the whole
  instrument is built on. Three or four moves each.
- **Instruments** — the machines: Rutt-Etra, SDF, Motion Extraction, RGB
  Channel Delay, Spacetime, mix buses, warp drawing, live GLSL.
- **Tutorials** — make one thing, from a known starting point, in about five
  moves. Written for video artists and workshop rooms.

Tutorials are the one place the panel can set values, and only when you press
**Load starting point**. That runs the same full reset as `Shift`+`Esc`, behind
the same confirm, and then sets up the step's `start:` line. The moves after it
are still yours.

Step grammar, for anyone editing: one `## ` heading per step, optionally
followed by a `<!-- guide … -->` block naming `track:`, `tab:`, `point:`
(parameter ids), `show:` (CSS selectors), `keys:` (keycaps to display), and,
for tutorials, `start:` (`clean`, or `id=value` pairs; a select takes its option
label, e.g. `layer.bg=Rutt-Etra`).
Everything above the first `## ` — including this preamble — is not part of the
tour.

---

## What this instrument is
<!-- guide
track: basics
tab: mix
show: #layer-params
-->

ImWeb composites video sources through a chain of effects and renders to a
WebGL canvas. Everything you can hear yourself thinking about — a camera, a
movie, a noise field, a raymarched solid, the picture from two seconds ago — is
a **source**, and there are 33 of them.

The whole instrument is three ideas:

1. **Anything can feed anything.** A *source* is a picture the instrument can
   produce. An *input* is a slot that wants a picture — Foreground, Background,
   the displacement map, the keyer. Every slot accepts every source, and you
   change what feeds a slot by picking a name from a menu. There are no cables
   and nothing to connect.
2. **Every value is a parameter**, and every parameter can be driven by
   something else — an automatic wobble, a knob, a key, the sound in the room.
3. **The output is a source too**, so the picture can feed itself.

### Where to start

The **Basics** track covers how to work the controls. The **Principles** track
is six small patches, each one demonstrating a single idea from the list above.
Go through them in order the first time.

## Finding anything: the two keys
<!-- guide
track: basics
keys: ?, ⌘K
-->

**`?`** opens the keyboard shortcut overlay — every key the instrument has.

**`⌘K`** (`Ctrl`+`K` away from a Mac) opens parameter search. Type any part of a
name, `↑`/`↓` to move, `Enter` to jump. `/` does the same thing on a US
keyboard; on an Icelandic or other Nordic layout `/` is `Shift`+`7`, which the
instrument has already spent on something else, so `⌘K` is the one to learn — it
works on every layout.

Use the mouse to adjust the results directly: each one is a working parameter
row, so you can drag it, type into it, and hear what it does without leaving the
search. The **⌖** button beside a result takes you to that parameter in the side
panel, where you can also see everything that sits around it.

There are around a thousand parameters. Nobody navigates that many by memory,
which is why this is the first thing to learn.

### The side panel

Everything else lives in the panel down the side of the screen. Its five tabs
run left to right in signal order — **Sources · Mix · Effects · Output ·
Project**. The big editors (3D, Analog, Draw, Live GLSL) are not permanent tabs:
open one from its row and it appears as an extra tab alongside these, then goes
away again when you close it.

The panel is grouped for playing rather than for looking things up: every
control belonging to one machine sits together in one place, so a section can be
long and the thing you want can be several headings down. That is the trade —
quick to reach once you know where it lives, slow to hunt through when you do
not. Search is the shortcut for the second case.

Click any section header to collapse or expand it, and any sub-heading to fold
away the rows under it; the **⊟/⊞** button does all of them at once. If a panel
looks empty, you are looking at a collapsed header.

## The parameter row
<!-- guide
track: basics
tab: mix
point: mix.xfade
-->

Every row is the same shape, and learning it once is learning the whole panel:

```
[ label ]  [ badge ]  [ min ]  [ max ]  [ value ]
                                        [── slider ──]
```

- **Drag anywhere on the row, left and right**, to change the value. Sideways,
  not up and down — about 200 px of travel covers the whole range. Dragging up
  or down scrolls the panel instead, so if the value is not moving, check which
  way your hand is going.
- **Double-click resets to default.** To *type* a number, **Ctrl+click
  (⌘+click) the value**, then `Enter`. `Esc` cancels.
- **`⌥`+scroll wheel** over a row is a fine adjust — 1% of the range per notch,
  5% with `Shift` held. `⌥` is the **alt** / **option** key, immediately left of
  the space bar on a Mac keyboard.
- The **thin slider** underneath is the same value again, but absolute instead
  of relative: click a spot on it and the value jumps there. On a tablet, a fast
  flick coasts to a stop.

Toggles and triggers take a plain **click** anywhere on the row. Selects with
eight options or fewer are a button strip; longer lists are a dropdown.

## Min and max are not limits
<!-- guide
track: basics
point: displace.amount
-->

The two small numbers between the badge and the value are the **controller
range** — the span something driving this parameter will sweep. They are not
the parameter's hard limits, and changing them does not change the current
value.

- **Drag a min/max field up and down** to adjust it. Up and down here — the two
  little numbers are their own targets, and only the row itself drags sideways.
  0.1 per pixel, `Shift` for one parameter step per pixel.
- **Double-click** to type. `Enter` commits, `Esc` cancels.
- A field that has been moved off its default shows highlighted.

The range is what decides whether something reads as an effect or as texture.
Say you put an **LFO** on a parameter — a *low-frequency oscillator*, which is
just a slow automatic wobble that sweeps a value up and down, over and over,
without you touching it. Leave the range wide open at 0–100 and every cycle
drags the parameter across its entire span: big, obvious, unmistakably an
effect. Narrow the range to 40–46 and the identical wobble now only nudges the
value a few percent: the picture keeps moving, but it reads as the image
breathing rather than as something being done to it. The LFO did not change.
Only the amount of room you gave it did.

Set the range first, then assign the controller.

## Giving a parameter a controller
<!-- guide
track: basics
point: displace.amount, displace.angle
-->

**Right-click any row** to open its **assignment menu** — the list of things
that can move that parameter for you instead of your hand. On a Mac trackpad
with no right button, **Ctrl+click** or a two-finger click opens the same menu;
on a tablet, press and hold.

The menu offers many, and you can ignore most of them at first. These are the
ones worth knowing:

- **Random** — a new value at a chosen rate, with slew to smooth the jumps.
- **LFO Sine / Triangle / Saw ↑ / Saw ↓ / Square / S&H** — a *low-frequency
  oscillator*: an automatic wobble in a chosen shape, at a chosen speed. Sine
  glides, Square flips between two values, S&H jumps to a new random one each
  beat.
- **MIDI Learn** — then move a knob on your controller and it binds itself.
  (**MIDI CC…** if you would rather type the number.)
- **Sound Level / Bass / Mid / High** — the room drives the parameter.
- **Key…** — a keyboard key drives it. Held for continuous parameters,
  toggled for switches.
- **Fixed Value** — a constant, which sounds pointless until you want the value
  captured and recalled without anything able to nudge it.
- **None** removes the controller and leaves the value where it was.

One parameter, one controller. The **badge** in the row then shows which, in
that controller's colour — <span class="param-ctrl assigned">RND</span> <span class="param-ctrl lfo">LFO~</span> <span class="param-ctrl sound">BAS</span>
<span class="param-ctrl midi">CC7</span> — and the row highlights as driven.

Under **Options** on the same menu: **Toggle Lock** freezes a parameter against
everything, **Toggle Invert** flips the controller's direction, and **Assign
Table…** is the next step.

## Editing the controller
<!-- guide
track: basics
point: displace.amount
-->

**Right-click the badge** to open its settings — a small dark panel next to the
badge, closed with `Esc` or a click anywhere outside it. **Ctrl+click** and
long-press work here too, so a trackpad with no right button reaches everything.

What is in it depends on the controller: **Rate** and **Slew** for Random;
**Shape**, **Freq**, **Phase** and **Slew** for an LFO; **Value** for Fixed. All
of those fields use the same drag / double-click-to-type grammar as the row
itself, so there is nothing new to learn.

**Slew** is worth dwelling on: it is the seconds a controller takes to reach its
new value. At 0 a Random is a stutter; at 2 seconds it is a drift. Same
controller, entirely different instrument.

## Response curves
<!-- guide
track: basics
tab: presets
show: #tables-list, #table-editor
-->

A controller produces a number from 0 to 1. A **response curve** reshapes that
number before it reaches the parameter — so an LFO can spend most of its time
near the bottom and snap through the top, or ease at both ends.

A curve only has anything to reshape once the parameter has a controller, so
assign one first — the previous two steps — and then come back here to hear the
difference.

Curves are drawn in **Project ▸ Response Curves** and assigned per parameter
from the row's right-click menu (**Assign Table…**) or the badge popover's
**Table** field. One curve can be shared by many parameters, and there is a
`global` slot for the one you want everywhere.

Range decides *where* a controller moves; the curve decides *how* it gets
there.

## Saving what you find
<!-- guide
track: basics
tab: presets
show: #states-section, #morph-ctrl
keys: Shift+S, 0-9
-->

A **Display State** is a snapshot of the whole instrument.

- **`Shift`+`S`** saves the current look to the next empty slot.
- **`0`–`9`** recall states 0 to 9. The state bar along the bottom has the rest.
- **Morph** (bottom right) sets how long a recall takes. At 0 the picture cuts
  straight to the new state. At two seconds every parameter slides from where it
  is now to where the saved state puts it, so the two looks bleed through each
  other on the way across — the transition itself becomes something you can play
  with, instead of a switch you flip.

Do this the moment something works. Rebuilding a patch from memory takes far
longer than you expect, and the state bar is the fastest instrument in the
program.

Banks, project save/load and the **state step sequencer** are all on the
**Project** tab. The step sequencer walks through your saved states in order on
a clock, holding each for a set number of beats — so with Morph turned up, a
row of saved looks plays itself while your hands are somewhere else. Projects
are `.imweb` files; individual states are `.imstate`.

## The performance keys
<!-- guide
track: basics
point: global.keylock, global.tap, global.bpm
keys: q, a, z, v, m, k, x, c, h, f, t, g
-->

Single keys, no modifier — the reason the instrument is playable without looking
at the panel. `?` shows all of them; these are the ones you will use in the
first hour:

- **`q` / `a` / `z`** — cycle the Foreground / Background / DisplaceSrc source.
  This is how you audition 33 sources in a minute. Every one of them is also in
  the **Source** dropdown on the matching row in **Mix ▸ Layers** — the keys are
  for auditioning in order, the dropdown for going straight to one you can name.
  The rest of this tour says "press `a` until Background reads *X*"; picking *X*
  from the dropdown is always the same thing, and quicker.
- **`v` / `m`** — camera on/off, movie on/off.
- **`k` / `x`** — keyer, external key.
- **`c`** — capture the screen into the Stills Buffer.
- **`h`** — hold / fade to black. The panic button.
- **`f`** — fullscreen output. `Esc` exits.
- **`t`** — tap tempo, for anything synced to BPM.
- **`g`** — cycle what a canvas drag does: Camera → Pad → Locked → Draw → Warp.
- **`i` / `u` / `d`** — parameter OSD, state bar, debug overlay.

**Keylock** (in the status bar) disables the single-key shortcuts. Turn it on
before typing into anything, and before handing the laptop to someone else.

## Principle 1 — a picture is two layers
<!-- guide
track: principles
tab: mix
point: layer.fg, layer.bg, layer.fg.blend, layer.fg.blendAmount
keys: v, q, a
-->

**Three moves.** Press `v` for the camera. Press `a` until **Background** reads
`Camera`. Press `q` until **Foreground** reads `Noise`. (`q` / `a` / `z` cycle
those three; you can also just pick from the **Source** dropdown on each row,
which is faster once you know what you are after.)

You are looking at the composite: a Foreground over a Background. **Blend**
chooses how the two meet — add, multiply, difference, screen — and **Blend Amt**
how far to take it.

**Set Blend to `Screen` first.** At the default `Copy` the Foreground simply
replaces the Background and nothing is composited at all — Blend Amt has no
effect until a real mode is chosen, which is the first thing to trip over here.

Now drag **Blend Amt** slowly across its whole range and watch one picture
become the other. It has three stops:

- **0 %** — the Background alone.
- **50 %** — the blend mode at full strength. This is the default, and the
  detent the knob is built around.
- **100 %** — the Foreground alone.

So one control fades out either layer, with the blend in the middle. That
crossfade is the bottom of the instrument; everything else in this track is a
variation on what you can put in the two slots.

## Principle 2 — any source can drive any other
<!-- guide
track: principles
tab: mix
point: layer.ds, displace.amount, displace.angle
keys: z
-->

**Three moves.** Press `z` until **DisplaceSrc** reads `Noise`. Then find
**Displacement ▸ Displace** and drag it up from 0.

The noise is no longer something you look at — it is now a *map* that pushes the
picture around, brightness becoming distance. **DisplAngle** turns the direction
it pushes.

This is the idea the whole instrument rests on: a source's output can be another
source's control. Try `z` through a few others — `Camera` displacing itself is a
different machine again, and `SDF Depth` pushes the picture with a solid you
cannot see.

Nothing here was rewired. Displacement takes a source, and a source is a source.

## Principle 3 — any parameter can be driven
<!-- guide
track: principles
point: displace.amount
-->

**Three moves.** On the **Displace** row: set **min** to 0 and **max** to about
0.3 by dragging the two small numbers. Right-click the row → **LFO Sine**.
Right-click the <span class="param-ctrl lfo">LFO~</span> badge that appears and set **Freq** to 0.1 Hz.

The displacement now breathes on its own, between the bounds you set, and your
hands are free for something else.

Now change one thing at a time and watch what it does to the character:

- Raise **max** — the same LFO becomes a special effect instead of a texture.
- Swap the shape to **S&H** — it stutters instead of sliding.
- Add **Slew** — the stutter becomes a stagger.

A parameter with a controller is not automation. It is a second pair of hands
that never gets tired and never gets bored, and the range fields are how you
tell it how much rope it gets.

## Principle 4 — the output is a source
<!-- guide
track: principles
tab: effects
point: blend.active, feedback.active, feedback.decay, feedback.zoom, feedback.rotate
keys: b
-->

**Three moves.** Press `b` for Blend. Switch **Feedback** on. Drag **Zoom**
slightly off 1.0.

The picture now contains the previous frame, zoomed — which contains the frame
before that, and so on into a tunnel. **Rotate** turns the tunnel into a spiral.
**Decay** decides how long the trail survives.

This is not an effect with a memory. It is the output routed back in as a
source: `Output` is number 8 in the same list `q` and `a` cycle through.

Keep one hand on **Decay**. Feedback is the one part of the instrument that can
run away from you, and pulling decay down is how you catch it.

## Principle 5 — time is an axis you can point at
<!-- guide
track: principles
point: delay.source, rgbdelay.r, rgbdelay.g, rgbdelay.b
keys: a
-->

**Three moves.** Press `a` until Background reads `RGB Delay`. Set **Video
Delay ▸ Source** to `Camera`. Then pull the three channel delays apart — try
1 / 12 / 24.

Red, green and blue are now reading three different moments. Move in front of
the camera and your gesture separates into three coloured ghosts of itself.

Every temporal engine — Time Displace, Slit Scan, Video Delay, Warp Tape —
shares one frame history and each picks its own way in. Time is not a global
setting here; it is a direction you can point an engine at, the same way
Principle 2 pointed displacement at a source.

## Principle 6 — build a patch out of the five
<!-- guide
track: principles
tab: mix
point: mix.srcA, mix.srcB, mix.xfade, layer.bg
keys: a, Shift+S
-->

Nothing new. Just the five together, which is what a piece is:

1. **Mix 1 ▸ srcA** = `Camera`, **srcB** = `RGB Delay` — two sources into a bus
   *(Principle 1)*.
2. Press `a` until Background reads `Mix 1`, and `z` until DisplaceSrc reads
   `Noise` *(Principle 2)*.
3. Right-click **Crossfade** → **LFO Triangle**, slow *(Principle 3)*.
4. Switch **Feedback** on with a little Zoom *(Principle 4)*.
5. Pull the RGB delays apart *(Principle 5)*.
6. **`Shift`+`S`** to keep it. Change four things and save it again.

Two saved states and a slow **Morph** between them is a piece. That is the whole
method — the rest of this tour is which machines you can put in the slots.

## Rutt-Etra Scan Processor
<!-- guide
track: instruments
point: rutt.active, rutt.source, rutt.zgain, rutt.lines, rutt.dist
keys: a
-->

Scanlines deflected by luminance, viewed through an orbiting camera. The one
machine of the trio — Sandin, Paik/Abe, Rutt/Etra — with no representation here
until v0.15. Built faithful before general, on the argument that the machine is
beautiful because it lies about depth.

Press **`a`** until Background reads `Rutt-Etra`, then find it in
**Sources ▸ From the Signal ▸ Rutt-Etra**. Four subsections: **Scan · Depth ·
Camera · Phosphor**.

Drag **Z Gain** right until the picture leaves the plane. It is signed —
negative inverts the relief, so highlights become valleys, and that is half the
expressive range of the machine. Then orbit with **Angle**, **Elev** and
**Dist**.

**Lines** is how many scanlines you are actually looking at. Low counts are the
1972 look; high counts stop being lines and become a surface.

## SDF field renderer
<!-- guide
track: instruments
point: sdf.active, sdf.shape, sdf.glow, sdf.glowSize, sdf.texSrc, sdf.texBlend
keys: a, z
-->

Thirteen shapes, orbit camera, two-stop glow. Press **`a`** until Background
reads `SDF`.

**Glow** is deliberately two-stop — an inner and an outer with independent hue,
saturation and value. Set the inner tight and the outer wide and it stops
looking like a bloom filter.

**Video ▸ Tex Src** feeds any source onto the surface, so the raymarcher can
wear the camera.

Then the part worth staying for: `SDF Depth` is the same render's depth, packed
into the colour target's alpha and routable as its own source. Press **`z`**
until DisplaceSrc reads `SDF Depth` and the picture gets pushed around by a
solid you can no longer see.

## Motion Extraction into the keyer
<!-- guide
track: instruments
tab: mix
point: motion.source, keyer.active, keyer.keysrc, keyer.white, keyer.black
keys: k
-->

A matte of what moves: white where the picture moves, black where it does not.
Built to be routed into the keyer, not to be looked at.

Set **Motion src** to `Camera` — it is on the **Sources** tab, under **Motion
Extraction**. Back on **Mix**, press **`k`** for the keyer, then set **Key src**
to `Motion`.

**Now set KeyLevelWhite to 100%** — Ctrl+click the value, type `100`, `Enter`.
The keyer passes a *band*: it rejects the very bright as well as the very dark,
so at the default 80% a fully lit matte is keyed out, which reads as the
strongest motion being the only thing that fails to show. Let **KeyLevelBlack**
alone do the cutting.

Put two different sources in Foreground and Background with `q` and `a`. Only
the moving part of the Foreground now shows over the Background.

## Tuning the motion matte
<!-- guide
track: instruments
point: motion.gain, motion.bgtime, motion.trail, motion.blur
-->

Four rows, worth taking in this order:

- **Sensitivity** — a raw frame-to-frame difference is a few percent, so this is
  what lifts it into the keyer's useful range.
- **Bg adapt** — background half-life in seconds. Long values keep a subject who
  stops moving *in* the matte. Zero makes the background exactly the previous
  frame, which is plain frame differencing: stop moving and you vanish. The
  interesting settings are in between, which is why it is one knob and not a
  mode switch.
- **Trail** — seconds until a wake is gone.
- **Smoothness** — blurs the source *before* the comparison. Kills sensor grain,
  and fills interiors, so silhouettes come out solid rather than hollow.

## RGB Channel Delay
<!-- guide
track: instruments
point: rgbdelay.r, rgbdelay.g, rgbdelay.b, delay.source
keys: a
-->

Red, green and blue each read a different frame of history. Press **`a`** until
Background reads `RGB Delay`.

Equal values on all three are a bit-exact passthrough, so neutral is always one
drag away. Small spreads (1 / 5 / 9) smear; wide spreads separate into three
distinct ghosts of the same gesture.

It reads the Video Delay ring, so **Video Delay ▸ Source** decides *what*
history is being delayed.

## Spacetime — time as a first-class axis
<!-- guide
track: instruments
point: td.captureSource, td.angle, td.mapSource, vwarp.source, slitscan.source, delay.source
-->

Every temporal engine — Time Displace, Slit Scan, Video Delay, Warp Tape — used
to be hardwired to the composite. Since v0.15 they share one frame history and
each picks its own way in, and Time Displace additionally gets an arbitrary
angle and a **map source**.

They all live in **Sources ▸ From the Signal ▸ Warp**. Warp Tape defaults to the
camera rather than the composite, which matches the lineage: Steina performed to
a camera.

One deliberate experiment: set Time Displace's **map source** to `Motion`. Time
then bends only where the picture moved.

## Three mix buses
<!-- guide
track: instruments
tab: mix
point: mix.srcA, mix.srcB, mix.xfade, mix.mode, mix2.srcA
keys: a
-->

**srcA** and **srcB** are free source selectors resolved through the same
resolver the layers use — a bus is a real graph node, not a hardwired deck
crossfader. Pick any two of the 33.

Press **`a`** until Background reads `Mix 1`. Then set **Mix 2 ▸ srcA** to
`Mix 1`: buses can read each other.

Each bus is double-buffered, and the rule has no special cases. A bus reading an
*earlier* bus sees this frame; reading a *later* bus, or itself, sees last
frame — which is a feedback path, deliberately, not a bug to guard against.

## Warp drawing
<!-- guide
track: instruments
tab: mix
point: touch.mode, displace.warpDrawRadius, displace.warpDrawAmt, displace.warpSlot, displace.warpPreset
show: #warp-editor-container
keys: g
-->

Draw the displacement map straight onto the output canvas.

**First press `g`** until the mode OSD reads **Warp**. The five modes cycle
Camera → Pad → Locked → Draw → Warp, and only Warp smears the displacement map;
in Camera mode a drag orbits the 3D camera, and in Draw it paints. That is the
first thing to trip over here.

Now drag on the main output canvas. The picture smears where you drag, in the
direction you drag.

**Radius** and **Strength** are single parameters shared by all three drawing
surfaces — the mini editor, the main canvas, and the WarpDrawX/Y controllers —
so setting them once sets them everywhere. The editor's sliders are views onto
the same two values, not a local copy.

There are **16 slots** to store maps in and **8 preset shapes** to start from.
Slot *contents* live in per-origin browser storage, so the slot index is
deliberately not captured by Display States; the preset shapes are, because
those live in code and an index means the same thing on every machine.

## Making the stroke draw itself
<!-- guide
track: instruments
point: displace.warpDrawX, displace.warpDrawY
-->

**WarpDrawX** and **WarpDrawY** are the drawing head as parameters. Right-click
each → LFO, at frequencies that do not divide evenly into one another, and the
instrument draws its own displacement map while you play something else.

Random with a long slew is the other good choice — it wanders instead of
tracing.

## Live GLSL
<!-- guide
track: instruments
tab: effects
point: glsl.preset
show: #tab-glsl
-->

CodeMirror in the app, compiling as you type.

Break it on purpose — delete a semicolon. The render loop does not drop; it
holds the last good compile. That safety net is what makes it usable
mid-performance rather than only at the desk.

Natural-language shader generation needs an API key, set in **Project ▸ AI**. It
is stored in browser storage on this origin and never written into a saved
project file.

On the **Preset:** row, right-click the *label* for the badge menu, click the
badge to edit it, and the min/max fields set the recall range — so a controller
can sweep through presets as a performance move.

## Movie Library
<!-- guide
track: instruments
tab: sources
point: movie.active, movieB.active
show: #movie-library, #movie-a-section
keys: m
-->

An unlimited catalogue with two racks. Drag a row onto either deck — **Movie A**
or **Movie B** — and press **`m`** to run them.

Both decks are ordinary sources, so a mix bus with srcA/srcB pointing at them is
your A/B — and so is anything else you might want to crossfade against them.

## Where to go next
<!-- guide
track: instruments
keys: q, a, z
-->

Thirty-three routable sources, any of which can drive any other.

The patches worth finding are the ones where an engine's *output* becomes
another engine's *displacement*, *key*, or *time map* — not the ones where you
look at an engine directly. `q` / `a` / `z` and a couple of minutes is the whole
method.

`KNOWN-ISSUES.md` is honest about the loose ends.

## Tutorial 0 — a picture in sixty seconds
<!-- guide
track: tutorials
theme: Start
tab: mix
start: clean
point: effect.kaleidoscope, effect.kalerot
keys: Shift+S
-->

**What you will make:** your own camera picture folded into a slowly turning
kaleidoscope, saved so that one key brings it back.

**Starting point:** press **Load starting point** above. Everything goes back
to its default and the camera comes on. The browser asks to use the camera the
first time; say yes. You should see yourself.

1. On the **Effects** tab, find **Kaleidoscope** and drag it to 6. Six
   segments: the picture folds into a mandala.
2. Right-click (Control-click on a Mac) **Kale.Rot** and choose **LFO Saw ↑**. A saw climbs and then
   jumps back to the start, so the rotation keeps going round in one
   direction. (A sine would rock back and forth instead.) The row gets a
   green <span class="param-ctrl lfo">LFO⊿</span> badge: that is the controller now driving it.
3. A box asks for the LFO rate. The default is 0.5, which means two seconds
   per turn. Type **0.05** for a slow twenty-second turn and press `Enter`.
4. Press **`Shift`+`S`**. The look now sits in a slot on the state bar along
   the bottom.
5. Drag Kaleidoscope back to 0, then click the tile you just saved on the
   state bar. The mandala comes back, still turning. (The number keys `0`–`9`
   also recall states, but only the first ten slots.)

**Why it works.** You changed one value by hand and gave a second one a
controller. Every patch in this instrument is built the same way, with
more of both.

**Now try:**

- Drag Kaleidoscope through 2, 3 and 12. Odd and even numbers fold differently.
- Right-click the <span class="param-ctrl lfo">LFO⊿</span> badge on Kale.Rot and drag **Freq** right down,
  until you only notice the turning when you look away and back.
- Swap the saw for **LFO Sine**. The mandala now rocks back and forth instead
  of turning.
- Press `q` a few times to change the **Foreground** source. The kaleidoscope
  works on any source, not just the camera. (`q` and not `a`: the Foreground
  sits on top and covers the Background completely.)

## Feedback 1 — the tunnel
<!-- guide
track: tutorials
theme: Feedback
tab: effects
start: clean
point: blend.active, feedback.mode, feedback.zoom, feedback.decay
keys: b, Shift+S
-->

**What you will make:** the picture inside itself, inside itself again,
falling away into a tunnel.

**Starting point:** press **Load starting point**. Camera on, everything at
default.

**Works best with black in the picture.** Feedback needs somewhere dark for
the trails to show. A bright, busy room fills the loop with light, so stand in
front of a dark wall or black cloth, or turn the room lights down.

1. Press **`b`** to switch **Blend** on. Nothing changes yet. **Feedback** is
   already on, but it has no way to meet the picture.
2. Set **Feedback Mode** to `Screen`. Move your hand: it now leaves a trail.
   The last frame is being laid over this one, and that frame held the one
   before it.
3. Drag **FBZoom** up to about 3. Each old frame is now a little larger than
   the one after it, so the trail streams outwards. That is the tunnel.
4. Keep one hand on **FBDecay**. At 100 nothing ever fades and the picture
   fills up with light. Pull it down to around 85 and the tunnel gets a
   bottom you can see.
5. Press **`Shift`+`S`**.

**Why it works.** Feedback is not an effect with a memory. The output is
routed back in as a source (Principle 4), and Zoom, Decay and the mode
decide what happens to it on each trip around the loop.

**Now try:**

- Make **FBZoom** negative. The tunnel reverses and falls *inwards*.
- Try **Feedback Mode** `Difference`, then `Add`. Every mode is a different
  rule for how a frame meets its own past.
- If it runs away into white: **FBDecay** down. That is always the way out.

## Feedback 2 — spiral and colour
<!-- guide
track: tutorials
theme: Feedback
tab: effects
start: blend.active=1, feedback.mode=Screen, feedback.zoom=3, feedback.decay=85
point: feedback.rotate, feedback.hue, feedback.centerx, feedback.centery
keys: Shift+S
-->

**What you will make:** a spiral whose colours rotate through the spectrum
as they fall away.

**Starting point:** press **Load starting point**. You get the tunnel from
Feedback 1, ready to go.

1. Drag **FBRotate** to about 2. Each trip around the loop now turns the old
   frame a little, and the tunnel twists into a spiral.
2. Drag **FBHue** to about 20. Each generation is shifted 20° round the colour
   wheel, so the spiral's rings run through the spectrum.
3. Move **FBCenterX** and **FBCenterY**. That is the vanishing point. Off
   centre, the spiral swings to one side.
4. Right-click (Control-click on a Mac) **FBRotate** and choose **LFO Triangle**. In the rate box type
   **0.05**. The spiral now winds one way, slows, and unwinds the other.
5. Press **`Shift`+`S`**.

**Why it works.** Small changes compound. Two units of rotation is barely
visible once, but the loop applies it again every frame, so the deep
generations have turned a long way. That is the whole craft of feedback:
small values, many trips.

**Now try:**

- **FBMirror** `Both`. The spiral folds into a symmetrical pattern.
- **FBBlur** up a little. The old rings soften into smoke while the live
  picture stays sharp.
- Put **Sound Bass** on **FBHue**. The colours turn with the music.

## Feedback 3 — the picture melts into itself
<!-- guide
track: tutorials
theme: Feedback
tab: mix
start: clean
point: layer.ds, displace.amount, displace.angle
keys: z, Shift+S
-->

**What you will make:** a picture that pushes itself around, flowing like
liquid.

**Starting point:** press **Load starting point**.

1. Press **`z`** until **DisplaceSrc** reads `Output`, or pick it from that
   row's dropdown. The output is now the *map* that displaces the picture.
2. Drag **Displace** up slowly from 0. Stop as soon as the picture starts to
   flow. A little goes a long way here.
3. Right-click (Control-click on a Mac) **DisplAngle** and choose **LFO Saw ↑**, with a rate of
   **0.1**. The <span class="param-ctrl lfo">LFO⊿</span> badge appears on the row, and the direction
   of the flow now goes round in a circle.
4. Move in front of the camera. Your movement changes the output, which
   changes the map, which moves the picture again.
5. Press **`Shift`+`S`**.

**Why it works.** In Feedback 1 and 2 the output came back as a *picture*.
Here it comes back as a *control*: its brightness becomes distance (Principle
2). The loop is the same, but now it decides where things go instead of
what you see.

**Now try:**

- Add the tunnel on top: **`b`**, **Feedback Mode** `Screen`, a little
  **FBZoom**. Two loops at once, one through the picture and one through the
  map.
- Swap DisplaceSrc to `Noise` and back. Noise flows evenly; the output flows
  where the picture is bright.

## Lineage — the camera and its monitor
<!-- guide
track: tutorials
theme: Feedback
tab: output
start: clean
point: output.colorshift, effect.kaleidoscope
show: #btn-second-screen
keys: f, c
-->

**What you will make:** the original feedback: a camera filming the screen
it is shown on.

**Where it comes from.** Early in the 1970s, one of the first things artists
did with portable video was point the camera at its own monitor. The loop
makes tunnels, flames and spirals that no one draws. Steina and Woody Vasulka,
who founded The Kitchen in New York in 1971, made feedback a central material
of their early work. Everything in Feedback 1–3 is that loop moved inside the
computer. This recipe puts it back in the room.

**You need:** a projector or a second screen, and a camera you can move, such
as a USB webcam. A built-in laptop camera cannot see its own screen.

**Starting point:** press **Load starting point**. The camera comes on, and
ImWeb's own feedback is off: this loop goes through the air.

1. Open the output on the projector or second screen (the **second screen**
   button in the top bar), or press **`f`** for fullscreen if the screen is
   mirrored.
2. Point the camera at the screen until the screen fills the camera's view.
   Move closer and the tunnel grows; move away and it shrinks.
3. Tilt the camera a little. The tunnel twists into a spiral, the same
   spiral FBRotate made in Feedback 2, only now your hand is the rotation.
4. On **Output**, raise **ColorShift** a little. The shift happens once per
   trip around the loop, so the colours cycle on their own.
5. Press **`c`** to keep a still of anything that surprises you.

**Why it works.** It's the same loop as Feedback 1, but the delay, the
blur and the distortion now come from the lens, the screen and the air. That
is why optical feedback never looks quite like the digital kind, and why
artists still do it.

**Now try:**

- Turn the room lights down and up. Light leaking into the loop feeds it.
- **Kaleidoscope** at 3 inside the optical loop. Every trip folds the
  picture again.
- Put your hand between the camera and the screen. Whatever you put in the
  loop gets repeated.

## Audio 1 — one sound, one control
<!-- guide
track: tutorials
theme: Audio
tab: mix
start: layer.ds=Noise
point: displace.amount
keys: Shift+S
-->

**What you will make:** a picture that shudders on every beat.

**Starting point:** press **Load starting point**. The camera is on, and
Noise is already set up as the displacement map, so only the amount is
missing.

1. On the **Displace** row, drag the two small numbers to **min 0** and
   **max 15**. That is how far the sound will be allowed to push. Set the
   range first, always.
2. Right-click (Control-click on a Mac) **Displace** and choose **Sound
   Bass**. The browser asks for the microphone; say yes. The row gets a
   cyan <span class="param-ctrl sound">BAS</span> badge.
3. Play something with a beat. Each kick drum pushes the picture through the
   noise, then lets it go.
4. Right-click the <span class="param-ctrl sound">BAS</span> badge and set
   **Slew** to 0.15. The shudder becomes a swell: the picture still moves on
   the beat, but it rises and falls instead of jumping.
5. Press **`Shift`+`S`**.

**Why it works.** The sound is a controller like an LFO, but you can't set
its speed: the music does. Range decides how far it may push, Slew decides
how fast it gets there.

**Now try:**

- **Sound High** instead of Bass. Now hi-hats and hiss drive it, and the
  kick does nothing.
- In the badge's settings, set **Slew curve** to `Elastic`. Every beat now
  overshoots and springs back.
- Raise **max** to 40. Same music, a much more violent picture.

## Audio 2 — a colour organ
<!-- guide
track: tutorials
theme: Audio
tab: effects
start: effect.kaleidoscope=6
point: effect.kaleidoscope, effect.kalerot, effect.rgbshift
keys: Shift+S
-->

**What you will make:** one picture played by three parts of the music at
once: bass, middle and treble.

**Starting point:** press **Load starting point**. The camera is folded into
a six-way kaleidoscope.

1. **Treble.** Set **RGB Shift**'s max to 30, then right-click it → **Sound
   High**. Cymbals and hiss split the colours apart.
2. **Middle.** Right-click **Kale.Rot** → **Sound Mid**. Voices and melody
   turn the mandala.
3. **Bass.** Set **Kaleidoscope**'s min to 3 and max to 8, then right-click
   it → **Sound Bass**. Each kick snaps the mandala to more segments.
4. Play music with all three parts in it. If one band takes over, lower
   that row's **max** until all three have a share of the picture.
5. Press **`Shift`+`S`**.

**Why it works.** A sound is not one number. Splitting it into bands and
giving each band its own job is how one piece of music can play several
parts of the picture at once. Colour organs have done this with coloured
lights since long before video.

**Now try:**

- Swap which band drives which control. The same music gives a different
  piece.
- Put **Slew** on Kale.Rot only. The middle glides while bass and treble
  still snap.

## Audio 3 — a word that listens
<!-- guide
track: tutorials
theme: Audio
tab: sources
start: layer.fg=Text
point: text.audioTarget, text.audioBand, text.audioFocus, text.audioAmt
show: #text-content
keys: Shift+S
-->

**What you will make:** a word whose letters move with the sound, each
letter listening to its own part of the spectrum.

**Starting point:** press **Load starting point**. The Foreground is the
Text source, showing the word "ImWeb".

1. In the **Text** section, type your own word in the text box, such as
   your name.
2. Under **Audio**, set **AudioTarget** to `Rise`. The browser asks for the
   microphone; say yes. Make a sound and the letters jump.
3. **AudioBand** is `Spectrum`: each letter listens to its own slice, from
   low to high. Hum a low note, then whistle a high one, and different
   letters answer.
4. Raise **AudioFocus**. Each letter now hears a narrower slice, and only
   the strongest one moves. A single note becomes a single letter.
5. Press **`Shift`+`S`**.

**Why it works.** In Audio 1 and 2 a whole band drove one control. Here
every letter is its own meter, so the word turns into a spectrum display
you can read.

**Now try:**

- **AudioTarget** `Hue`, then `Scale`. The same listening, a different
  response.
- **AudioBand** `Bass`. Every letter now hears the same thing, and the word
  moves as one.
- Lower **AudioAmt** if the letters jump off the screen.

## Audio 4 — seeing the sound
<!-- guide
track: tutorials
theme: Audio
tab: sources
start: layer.fg=Scope
point: vectorscope.mode, vectorscope.decay, vectorscope.glow, layer.fg, layer.ds, displace.amount
show: #sound-params
keys: q, z, Shift+S
-->

**What you will make:** the sound drawn as a picture, and then that picture
used to bend the camera.

**Starting point:** press **Load starting point**. The Foreground is the
Scope source. It stays dark until it hears something.

1. In **Sources ▸ Sound**, press **▶ Audio**. The browser asks for the
   microphone; say yes. The Scope now draws the sound in real time.
2. Try a few **VScope Mode**s: `Waveform`, `Radial FFT`, `Spectrogram`.
   Each one draws the same sound a different way.
3. Raise **VScope Trail** and **VScope Glow**. The drawing leaves a trace
   and starts to look like light on a screen.
4. Now make it a map. Press **`q`** until **Foreground** reads `Camera`, press
   **`z`** until **DisplaceSrc** reads `Scope`, and drag **Displace** up a
   little. The camera now bends along the shape of the sound.
5. Press **`Shift`+`S`**.

**Why it works.** In Audio 1–3 the sound was a *number* driving a control.
Here it is a *picture*: the Scope is a source like the camera, so it can be
looked at, or used as any other picture can (Principle 2).

**Now try:**

- **VScope Mode** `Lissajous` with stereo music. The shape shows how wide
  the stereo is.
- Put the Scope in the Background and the camera in the Foreground with
  **Blend** `Screen`. You get the image and its sound on one screen.

## Lineage — Violin Power
<!-- guide
track: tutorials
theme: Audio
tab: sources
start: layer.fg=Rutt-Etra, rutt.active=1
point: rutt.lines, rutt.zgain, rutt.decay
keys: Shift+S
-->

**What you will make:** a scan-line picture of the room whose lines jump with
the sound, so that playing an instrument (or speaking, clapping, or putting a
record on) deforms the picture.

**Where it comes from.** In *Violin Power* (1970–78), Steina played the violin
and let the sound drive the video image. Much of it went through a Rutt/Etra
scan processor: the signal bent the raster lines, so you could see the sound
in the picture. Steina later co-created *Image/ine*, the instrument ImWeb
descends from. This recipe uses ImWeb's parts to get the same idea.

**Starting point:** press **Load starting point** above. The camera comes on
and runs through the Rutt-Etra scan processor (**Sources ▸ From the Signal ▸
Rutt-Etra**): you are looking at yourself drawn in scan lines.

1. Drag **Lines** down to about 60. Few lines with gaps between them is the
   1970s look.
2. Set **Z Gain**'s **min** to 0 and its **max** to about 1.5 by dragging the
   two small numbers.
3. Right-click (Control-click on a Mac) **Z Gain** and choose **Sound Bass**. The browser asks for the
   microphone; say yes. Now make a sound. The lines lift off the plane on low,
   loud sounds and lie flat when it's quiet.
4. The lines twitch with every sound. Right-click the <span class="param-ctrl sound">BAS</span> badge on
   Z Gain and set **Slew** to about 0.3. Now the lines breathe with the sound
   instead of jumping. (Rise and Fall further down do something else: they
   smooth the *camera picture*, not the sound.)
5. Turn **Persist** up a little so that each sound leaves a trace on the
   phosphor, and press **`Shift`+`S`**. Then play, speak or clap for a minute.
   This is the piece.

**Why it works.** Sound is a controller like any other. It does here exactly
what the LFO did in Tutorial 0, only you play it instead of letting it run. It
is Principle 3 with the room as the second pair of hands.

**Now try:**

- Swap **Sound Bass** for **Sound Level**. Now every sound moves the lines,
  including a violin's upper register, which Bass ignores.
- Turn the response upside down. In **Project ▸ Response Curves**, make a
  curve from the **Invert** preset, then right-click **Z Gain** →
  **Assign Table…** and pick it. Silence now lifts the picture and sound
  flattens it.
- Leave the camera out entirely. Set Rutt-Etra's **Source** to `Noise` and let
  the sound play an abstract surface.

## 3D 1 — a solid made of your picture
<!-- guide
track: tutorials
theme: 3D
start: layer.fg=3D Scene
point: scene3d.geo, scene3d.mat.texsrc, scene3d.spin.y, scene3d.cam.orbit
keys: Shift+S
-->

**What you will make:** your camera picture wrapped around a turning 3D
knot.

**Starting point:** press **Load starting point**. The Foreground is the
**3D Scene**, a plain sphere for now. The 3D controls open in their own
workspace; the chips below take you straight to them.

1. Set **Geometry** to `Complex: TorusKnot`.
2. Set **Texture Source** to `Camera`. The picture is now painted onto the
   surface, and it bends wherever the knot bends.
3. Drag **Spin Y** to about 20. The knot turns by itself, and the picture
   goes round with it.
4. Drag **Orbit** to move the viewpoint around the knot instead of turning
   the knot. Same scene, a different place to stand.
5. Press **`Shift`+`S`**.

**Why it works.** A 3D object here is one more place to put a source. The
texture slot takes the same list as the layers, so anything the
instrument makes can be worn by a solid.

**Now try:**

- **Material Shader** `Toon`. The picture flattens into bands of colour.
- **Texture Source** `Noise`, or `Screen` (the output itself, so the knot
  wears its own picture).
- **Wireframe** on. Only the surface's skeleton is left.

## 3D 2 — the picture pushes the surface
<!-- guide
track: tutorials
theme: 3D
start: layer.fg=3D Scene, scene3d.mat.texsrc=Camera
point: scene3d.mat.tDisplace, scene3d.spin.y, scene3d.geo, scene3d.mat.dispsrc
keys: Shift+S
-->

**What you will make:** a sphere whose surface rises where the picture is
bright, so your face becomes a relief.

**Starting point:** press **Load starting point**. The camera is already
painted onto a sphere.

1. Drag **T-Displace** up to about 0.15. Bright parts of the picture push the
   surface outwards and dark parts stay put.
2. Drag **Spin Y** to about 15. Seen from the side, the relief stands out
   against the background.
3. Set **Geometry** to `Basic: Plane`, then turn **Spin Y** back to 0 and
   **Orbit** a little. Your face is now a landscape.
4. Set **T-Disp Source** to `Noise`. The surface now moves to the noise
   while it still shows the camera. Shape and skin come from two different
   sources.
5. Press **`Shift`+`S`**.

**Why it works.** This is displacement (Principle 2) in three dimensions:
brightness becomes height instead of sideways distance. It is also the idea
behind the Rutt-Etra (see *Violin Power*), done on a surface instead of on
scan lines.

**Now try:**

- Raise **T-Displace** towards 0.5. The relief turns into spikes.
- Put **Sound Bass** on **T-Displace**. The face swells with the music.

## 3D 3 — a field of copies
<!-- guide
track: tutorials
theme: 3D
start: layer.fg=3D Scene, scene3d.geo=Platonic: Icosahedron, scene3d.mat.texsrc=Camera
point: scene3d.clone.mode, scene3d.clone.count, scene3d.clone.twist, scene3d.clone.wave, scene3d.clone.waveamp
keys: Shift+S
-->

**What you will make:** one object multiplied into a grid, then a ring, then
a wave of copies.

**Starting point:** press **Load starting point**. A single icosahedron
wearing the camera picture.

1. Set **Cloner** to `Grid`. The object becomes nine copies. Raise
   **CloneN** for more.
2. Set **Cloner** to `Ring`, and drag **Twist**. Each copy turns a little
   more than the one before it.
3. Drag **WaveAmp** up and set **Wave** to about 1. A wave now runs through
   the copies, moving them in turn.
4. Right-click (Control-click on a Mac) **WaveAmp** and choose **Sound
   Bass**. The wave now rises with the music (see the Audio theme).
5. Press **`Shift`+`S`**.

**Why it works.** The copies share one set of controls, so every change
reaches all of them at once. Twist and Wave are what make them differ:
each copy gets the same move, offset a little further along.

**Now try:**

- **Cloner** `Line`, with a high **CloneN**. A procession.
- **Scatter** up. The tidy grid breaks into a swarm.

## 3D 4 — depth as a picture
<!-- guide
track: tutorials
theme: 3D
start: layer.ds=3D Depth, scene3d.geo=Complex: TorusKnot, scene3d.spin.y=20
point: layer.fg, layer.ds, displace.amount, scene3d.depth.mode
keys: q, Shift+S
-->

**What you will make:** the camera picture bent around a 3D object you
never actually see.

**Starting point:** press **Load starting point**. A turning knot is set up
in the 3D scene, but only its *depth* is used, as the displacement map. The
picture still shows the camera.

1. Press **`q`** until **Foreground** reads `3D Depth`. This is what the
   map looks like: near is bright, far is dark. Press **`q`** until it reads
   `Camera` again.
2. Drag **Displace** up. The camera picture now bulges around the turning
   knot, which you can see only through what it does to the picture.
3. Set **DepthMode** to `Normals`. The map now records which way each part
   of the surface faces, rather than how far away it is. The bending becomes
   sharper and more sculpted.
4. Change **Geometry** while you watch. Each shape bends the picture in its
   own way.
5. Press **`Shift`+`S`**.

**Why it works.** The 3D scene is not only something to look at. It is
also a source of *maps*: depth and surface direction, which can drive
displacement, keying or anything else that takes a source.

**Now try:**

- Use **3D Depth** as the key in the keyer: the camera shows only where the
  knot is.
- Put the 3D Depth map through **Feedback**. The invisible knot leaves
  trails.

## Lineage — the hypercube
<!-- guide
track: tutorials
theme: 3D
start: layer.fg=3D Scene, hypercube.renderMode=wireframe, scene3d.mat.opacity=0
point: hypercube.rot.xw, hypercube.dim, hypercube.depthCue, hypercube.faces.active, hypercube.faces.texsrc
keys: Shift+S
-->

**What you will make:** a four-dimensional cube turning in front of you,
and then cubes of five, six or more dimensions.

**Where it comes from.** In the 1960s, A. Michael Noll at Bell Labs made
some of the first computer-animated films, among them projections of a
four-dimensional hypercube turning. Nobody can see four dimensions, but a
computer can rotate the object in four and draw its shadow in two. This
recipe does the same, in real time.

**Starting point:** press **Load starting point**. The hypercube is drawn as
a wireframe and the 3D scene's own sphere is hidden. It already turns.

1. Watch for a while. Some of the turning looks like an ordinary 3D spin.
   The rest, where the cube seems to turn itself inside out, is rotation
   through the fourth dimension.
2. Find **Slot 4 speed** (the XW plane). Set it to 0 and the inside-out
   motion stops; raise it to 1.5 and it takes over.
3. Raise **Dimension** to 5, then 6. The cube grows into a higher-dimensional
   one, morphing over **Morph Time**.
4. Raise **Depth Cue**. Parts further away in the extra dimensions get
   dimmer and thinner, which makes the tangle easier to read.
5. Switch **Faces** on and set **Face tex** to `Camera`. The camera is now
   painted onto the cube's faces. Press **`Shift`+`S`**.

**Why it works.** A rotation always happens *in a plane*. In 3D there are
three planes; in 4D there are six, and three of them involve the fourth
axis. The Plane Bank lets you choose which planes turn and how fast.

**Now try:**

- In an empty slot, pick a plane with **V** or **U** in its name. It only
  starts to move once **Dimension** is high enough to have that axis.
- **Draw** `points` instead of `wireframe`. The cube becomes a cloud of
  stars.
