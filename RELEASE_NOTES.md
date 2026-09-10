# ImWeb v0.23.0 — Within Reach

*Released 2026-09-10*

Three things that existed but could not be touched became playable: the 3D
camera, the text, and the MIDI desk. Plus a text layer that did not exist at
all before this release.

## New: a text layer

Fourteen typefaces, bundled with the app rather than fetched from the web — an
instrument that needs a network to draw a word is not an instrument you can
take on stage. Weight is continuous across the range the face actually carries,
and Italic is its own control rather than a separate font choice.

**Per-glyph stagger** runs a transition across the letters one at a time
instead of moving the line as a block. **Glitch** scrambles characters
continuously and **Decode** resolves them into place. **Marquee** — ScrollX and
ScrollY — crawls the text and repeats it, so a line longer than the frame reads
as a ticker rather than running off the edge.

**Paths** — Circle, Arc, Spiral, Wave — lay the line along a shape instead of
straight. The circle is round on screen, which it would not otherwise be: the
text canvas is square and your output is not. Scroll and paths compose, so the
text crawls *around* the ring.

**The text listens.** AudioTarget drives Scale, Rise, Hue, Weight, Rotate or
Opacity, and it is per glyph — on the default Spectrum band each letter reads
its own slice of the frequency range, so a word becomes a bank of meters. Point
the tap at the master bus instead and the text moves to the whole instrument.
AudioRange sets how much of the spectrum is spread across the letters, because
the top of an FFT is nearly always empty and a naive split leaves half the word
dead. AudioSmooth is a release time only: the attack stays fast, which is what
makes it look played rather than animated.

The preview is playable — drag to move the text, Shift+drag to rotate, wheel to
size, Alt+wheel for weight. It was always showing the live layer; it just could
not be touched.

## New: a 3D camera you can play

The scene had Cam X / Y / Z in world units, which is a position, not a camera
move. It now **orbits**: Distance, Orbit and Elevation, with the object staying
where you put it. Distance reaches from 0.1 to 100 and slows down as it closes
in, so the last centimetre is as controllable as the first metre. Elevation no
longer jumps at exactly 90° and now goes over the top. **Roll** turns the camera
about its own view axis, so the whole image rotates rather than the object
tilting inside it. **Spin Orbit**, **Spin Elev** and **Spin Roll** turn it on
their own.

The materials were quietly wrong in four ways, and all four are fixed:

- **The scene is lit properly out of the box.** three divides every diffuse
  contribution the way the maths requires, and the default lighting had never
  been raised to compensate — so everything arrived dimmer than it should.
- **Putting a texture on the object no longer makes it darker.** An untextured
  surface was being lit at one strength and a textured one at another.
- **A texture on a Plane is recognisable again.** The seamless projection is
  built for solids, and on a flat surface it was smearing the picture into
  something you could not identify. **Mapping** is now a real choice rather
  than an assumption, and **Blend Sharp** decides how abruptly the seamless
  projection hands over between its three axes.
- **T-Displace displaces by the texture you can see.** It was reading the
  global texture rather than the one on the object, so the bumps belonged to a
  different picture than the colour did. Displacement now follows the texture's
  own UVs, and **Disp. Tex Scale** works in seamless mode. **Disp. Smooth**
  stops an animated texture boiling when it drives geometry.

**Transparent BG** lets the scene render on nothing, so its layer carries
transparency and composites over the rest of the chain instead of arriving as a
filled rectangle.

## New: MIDI Map Mode — a desk maps in one pass

Assigning a controller with 8 knobs, 8 faders and 24 buttons meant **40 trips
through a context menu**, because learn was one-shot: the handler cancelled
itself the instant a control moved. Click the **MIDI** indicator in the top bar
to latch learn on, then click a row and move a control, repeatedly. `Esc` or a
second click leaves it. Alt/Cmd-click a mapped row to unmap it — bulk mapping is
only safe with a cheap way back out of a bad pass.

The panel wears an accent frame while the mode is on. That is not decoration: in
map mode a left-click means "arm this row" instead of "drag this value", and a
mode that silently changes what the primary gesture does has to be unmissable.

- **An incoming-MIDI monitor**, in the top bar and in Sources → I/O. A
  nanoKONTROL2 has no display, so the CC a control sends is otherwise
  unknowable. The panel keeps the last 16 controls touched, each with **what it
  already drives** — which answers "is this knob already taken?" before you map
  over it.
- **Four mapping pages**, switchable from hardware and from the app, so eight
  faders become 32 controls. The page-switch controls are themselves
  page-exempt: a paged page-switch could strand you on a page with no way back.
  **Soft takeover** means a parameter does not move until the fader passes
  through its current value, so switching pages does not jump every value the
  moment you touch something.
- **Learn accepts notes**, so keyboards and pad controllers work at all. The
  learn branch gated on CC, which meant that on a Launchkey Mini — whose keys
  and pads send notes — nothing could be learned.
- **Sequential option learn**: click a SELECT row and it arms option 0, then
  advances after each bind, so sixteen pads map to sixteen clip slots by
  pressing them in order.
- **Switching movie clips is now a parameter**, so one MIDI key per clip is
  possible at all — clip selection had never gone near the parameter system, so
  there was nothing to bind to. A movie cue also carries the clip its region
  belongs to, so recalling one switches the deck to it: a region recalled
  without its clip points at a different piece of tape entirely.
- **Learning a continuous parameter gives it a default slew** of 0.3 s. A
  hardware fader sends 7-bit steps, so a bare binding moves a value in 128
  visible jumps; a little lag makes it read as a move rather than a staircase.
  Switches are excluded. Set Learn Slew to 0 for the previous behaviour.
- **Clear All MIDI**, in Sources → I/O, takes only MIDI bindings across all
  pages and leaves LFO, mouse, sound and expression controllers alone.

## New: Pos Play — the Playback zone has a playhead

`aplay.pos` is a fraction of the region, matching MoviePos being a fraction of
the in/out window. Until now the zone always read from the start of its region
and there was no way to drop the needle anywhere else — the read head lived in
the worklet with no address at all. It is a seek, not a slewed target, and it
rides the same duck a partition change does, so a jump lands in silence rather
than clicking. An LFO or a MIDI knob on it is a playhead you can sweep.

Playback Zone cues now capture Rate and Level as well as the region.

## New: detached panels stay where you put them

The floating windows you tear off with ⊞ survive a reload — which sections are
open, where each one sits, how big it is. A per-origin autosave is what a plain
reload restores; the `.imweb` project carries the same arrangement to another
machine. Deliberately **not** a Display State: states are recalled live from
MIDI, and layout in a state would rearrange your windows mid-performance.
Restored positions are clamped to the current viewport, so a window placed on a
second monitor comes back on screen when only the laptop is attached.

## New: DeepSeek and Kimi as AI providers

Both speak the OpenAI `/chat/completions` shape verbatim, so the four
OpenAI-shaped providers share one caller with the endpoint, label and headers as
data. **Refresh models** replaces the seed list with what your account can
actually reach. Neither has been exercised against its live API here — the base
URL, auth header and response shape are the verified parts.

Separately, the default model you were advertised is now the one you get: the
defaults were written out a second time by hand and the two copies had drifted.

## Fixed: the manual you were served was two releases out of date

The in-app manual is a copy under `public/`, and it had not been resynced since
v0.20.0 — so the help was describing an instrument two releases behind the one
in front of you. Two guided-tour steps also named controls that are not on the
tab the step opens.
