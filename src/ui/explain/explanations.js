/**
 * Written "Explain this" texts — one per parameter id, in four parts:
 *
 *   does    — what moving it changes in the picture or the sound
 *   example — a few settings from its real range, with real numbers
 *   expect  — what typical material does with it
 *   not     — what it leaves alone
 *
 * Plain language, for a performer. A control named inside a text is written
 * as its id in backticks (`aplay.rate`); the panel shows that control's label,
 * and tests/audit-explain.mjs fails if the id does not exist — so a renamed
 * control cannot leave a text pointing at nothing.
 *
 * Numbered copies share one text through a `{n}` key (`aheads.on{n}` covers
 * `aheads.on2`…`aheads.on4`); `{n}` inside the text becomes the number.
 *
 * Numbers here are read from the code, not guessed. Where the sample rate
 * matters the text assumes 48 kHz and says so.
 */

export const EXPLAIN_PARTS = [
  { key: 'does', title: 'What it does' },
  { key: 'example', title: 'Example' },
  { key: 'expect', title: 'What to expect' },
  { key: 'not', title: "Doesn't affect" },
];

export const EXPLANATIONS = {
  // ── Audio · Engine ────────────────────────────────────────────────────────
  'audio.tapeSec': {
    does: 'How long the tape is, in seconds. Everything in the Audio tab records into, plays from and renders onto this one tape.',
    example: 'At the default 60 s the four partitions are 15 s each. At 20 s they are 5 s each; at 240 s they are a minute each.',
    expect: 'It changes the running tape a moment after you let go, and keeps what is recorded — a shorter tape keeps what fits. It waits while recording, playback, the Grain Player or a render is running; the status line says which to stop.',
    not: 'The partitions keep their fractions (P1 still starts a quarter of the way in), so they stretch with the tape while the recording stays where it was in time.',
  },

  // ── Audio · Playback ──────────────────────────────────────────────────────
  'aplay.rate': {
    does: 'The speed the Playback zone reads the tape at. Like tape, speed and pitch move together, and it loops its region.',
    example: '1 = as recorded. 0.5 = half speed, an octave lower, a 15 s region takes 30 s. 2 = an octave higher, 7.5 s. −1 = backwards at normal speed. 0 = the playhead stands still.',
    expect: 'Small moves around 1 sound like a tape machine drifting; an LFO on it gives vibrato or wow. Slow × in the Spectral Writer is made to be played back at Rate 1 ÷ Slow ×.',
    not: 'The recording itself — nothing on tape changes. The extra playheads have their own rates (`aheads.rate2` and the others).',
  },

  // ── Audio · Spectral Writer ───────────────────────────────────────────────
  'aspec.tilt': {
    does: 'Gives each row of the picture its own speed when the picture is rendered to sound. One end of the pitch range plays the picture once, slowly; the other end races through it and repeats.',
    example: 'Rendering into a 15 s region at Tilt 1: the top row plays the picture once in 15 s, a row halfway up 3 times (every 5 s), the bottom row 8 times (every 1.9 s). At 0.5 the bottom row repeats 3 times. Below about 0.2 nothing changes yet; at 0.2 the lowest rows go to 2. At −1 it is upside down: the bottom row plays once and the top row 8 times.',
    expect: 'A canon in whole numbers — 2 against 3 against 4 — so every row ends together and the render loops without a seam. Tilt moves in steps, adding a faster band as it rises. A face or a bright shape in the middle of the frame comes round again and again in the low notes while the high notes take their time.',
    not: 'The pitches (Scale, Root, Rows), the region length, or anything already on tape — it is used when you press `aspec.render`. 0 renders exactly as before Tilt existed.',
  },
  'aspec.rows': {
    does: 'How many pitches the picture is cut into, top to bottom. Each row is a horizontal band of the picture and becomes one note of the chosen Scale, counted up from Root.',
    example: 'Major from Root 45 (110 Hz): 12 rows span 110–330 Hz; the default 48 rows reach about 11.8 kHz. Chromatic with 128 rows would go past what the tape can hold, so at 48 kHz only 94 fit — the status line says "94 of 128 rows fit below Nyquist".',
    expect: 'Few rows: a chord-like, blocky reading where each note covers a wide band of the picture. Many rows: finer vertical detail, closer to a spectrogram, and a denser sound.',
    not: 'Time — how the picture is cut left to right is `aspec.frames`. Nothing changes until you press `aspec.render`.',
  },

  // ── Audio · Voice ─────────────────────────────────────────────────────────
  'avoice.cut': {
    does: 'Where the Voice’s filter sits, in semitones (the same numbers as MIDI notes). The filter shape — low-pass, band, high-pass, notch — is `avoice.ftype`.',
    example: '60 = 262 Hz (middle C), 84 (the default) ≈ 1046 Hz, 108 ≈ 4186 Hz, 130 ≈ 14.9 kHz. With the low-pass shape, lower numbers sound darker and more muffled.',
    expect: 'Sweeping it with an LFO is the classic filter sweep. More `avoice.res` makes a ringing peak at the cutoff.',
    not: 'The note’s pitch (`avoice.pitch`) or the loudness (`avoice.level`), except that a low-pass far below the note takes most of it away.',
  },

  // ── Video · Layers ────────────────────────────────────────────────────────
  'layer.fg': {
    does: 'Which source is the Foreground — the picture on top. The keyer cuts holes in it, and the Background shows through them.',
    example: 'Camera as Foreground over a Movie Background: with Keyer on, the dark and bright parts of the camera picture are replaced by the movie. With Keyer off you see only the Foreground.',
    expect: 'Choosing a source here is the first thing to do in any patch. The Mix buses (Mix 1/2/3) can be chosen too, to put a whole sub-mix on top.',
    not: 'The Background (`layer.bg`) or the Displacement source (`layer.ds`) — each layer has its own selector.',
  },

  // ── Video · Keyer ─────────────────────────────────────────────────────────
  'keyer.softness': {
    does: 'How soft the edge of the key is. Brightness right at `keyer.black` or `keyer.white` fades between Foreground and Background instead of switching.',
    example: 'With Black at 10%: Softness 0 cuts hard at 10%. Softness 5% (the default) fades over 5–15%. Softness 20% fades over 0–30%, a wide, ghostly edge.',
    expect: 'A little softness hides the jagged, flickering edge a camera image gets at the threshold. A lot turns the key into a cross-fade by brightness.',
    not: 'Where the thresholds are — only how wide the edge around them is. It does nothing while Keyer is off.',
  },

  // ── Video · Feedback ──────────────────────────────────────────────────────
  'feedback.zoom': {
    does: 'Each frame, the previous frame is enlarged (or shrunk) before it is mixed back in, so the picture flows outward or inward. It compounds frame after frame.',
    example: '0 = no zoom. 10% = each frame grows 1.1×, so a detail reaches the edge in well under a second. 100% = 2× per frame, a blur of streaks. −20% = each frame shrinks to 0.8×, a tunnel falling inward.',
    expect: 'Small values (2–5%) give the classic video-feedback bloom. The centre it zooms about is `feedback.centerx` / `feedback.centery`. How long the trails last is `feedback.decay`.',
    not: 'The live source — only the fed-back copy is zoomed. It only acts while Blend and Feedback are on and Feedback Mode is not Off.',
  },
  // ── Audio · start-up switches ─────────────────────────────────────────────
  'audio.enable': {
    does: 'Starts and stops the sound engine. With `audio.mic` armed (the default) it also opens the microphone.',
    example: 'Off → On: the engine starts and, if Mic is armed, the input opens; the status line says what happened. On → Off: everything stops and the microphone is released.',
    expect: 'The browser only lets sound start from a click, so nothing plays when the page loads. The first time, the browser asks for microphone permission.',
    not: 'What is on the tape — turning it off and on keeps the recording. A Display State never switches it.',
  },
  'audio.mic': {
    does: 'Arms the microphone: when Audio On starts the engine, the input opens. Off runs the instrument with no input at all.',
    example: 'On (the default) + click Audio On = the mic opens. Off + Audio On = the Voice, the tape and renders work, but Recording records silence.',
    expect: 'Turn it off when you only want to play what is already on the tape, or the Voice, and do not want the browser asking for the microphone.',
    not: 'Which input device is used — that is the Input list below it. It never opens a device by itself before Audio On.',
  },
  'audio.monitor': {
    does: 'Tells the instrument how you are listening, so it knows whether sound from the speakers can get back into the microphone.',
    example: 'Speakers (the default, the cautious choice): a warning line appears while a mic → speakers → mic loop is possible. Headphones: that warning is not needed and stays away.',
    expect: 'Set it once at the start of a session. It is a setup switch, so no controller can be attached to it.',
    not: 'Any level or routing — it changes nothing you hear. It is not captured by Display States.',
  },
  'audio.undo': {
    does: 'Takes back the last thing that overwrote tape — a Spectral Render, a Stretch, a Freeze or a Normalize — exactly as it was. Press it again to redo.',
    example: 'Render a picture into P0, dislike it, press Undo Tape: P0 sounds as before. Press it again and the render is back. There is one level only.',
    expect: 'A write longer than 240 s (four minutes) is not kept; the status line says so before the write.',
    not: 'Recording — a live recording is not one of the verbs it undoes. Nor any control settings.',
  },

  // ── Audio · Engine ────────────────────────────────────────────────────────
  'audio.tapSrc': {
    does: 'What the sound-reactive controllers and the Vectorscope listen to.',
    example: 'Mic (the default): they follow the microphone. Master Out: they follow what ImWeb itself plays — the tape, the heads, the Voice.',
    expect: 'Master Out lets the picture follow the instrument’s own sound. Through speakers with an open mic, that is a loop — Mic is the safe default for that reason.',
    not: 'What you hear or what is recorded — it only chooses the listening point for the analysers.',
  },
  'audio.outGain': {
    does: 'The master volume of everything the engine plays, just before the output limiter.',
    example: '0.8 is the default. 0.4 is about 6 dB quieter. 1 is full level; anything that then goes over the ceiling is caught by the limiter.',
    expect: 'Use it as the one master fader. If the sound starts to flatten and pump at the top, turn this down rather than the ceiling up.',
    not: 'Recording levels or anything on the tape — it only scales the output.',
  },
  'audio.glide': {
    does: 'How long a zone’s Start and Length take to reach a new value, in milliseconds.',
    example: '0 = exact: every move lands at once, best for scrubbing by hand. 3 ms (the default) smooths the small steps a controller writes 60 times a second. 50 ms makes moves slide audibly.',
    expect: 'Small values remove zipper noise when an LFO or MIDI knob moves a region. Large values give a portamento-like slur on region moves.',
    not: 'Rate, Level or Pos — only the region’s position and length.',
  },
  'audio.limitThresh': {
    does: 'The ceiling of the output limiter: the loudest the output is allowed to get. The limiter itself cannot be switched off.',
    example: '0.891 (the default) ≈ −1 dB below full scale. 0.5 ≈ −6 dB. 1 = right up to full scale.',
    expect: 'Lower it to protect speakers or ears on an unknown system; the loud parts are then held down while quiet parts stay as they are.',
    not: 'The level of anything below the ceiling — the limiter only acts on peaks above it.',
  },
  'audio.limitRel': {
    does: 'How quickly the limiter lets the level come back up after it has caught a peak.',
    example: '0.15 s (the default). 0.01 s recovers almost at once — can sound gritty on loud bass. 1–2 s recovers slowly, so a loud hit ducks everything after it for a moment.',
    expect: 'You only hear it when the output is actually hitting the ceiling. Longer release sounds smoother; shorter keeps more loudness.',
    not: 'Where the ceiling is (`audio.limitThresh`) or anything that stays below it.',
  },

  // ── Audio · Partitions ────────────────────────────────────────────────────
  'apart{n}.start': {
    does: 'Where partition P{n} begins on the tape, as a fraction of the whole tape. Zones work inside a partition.',
    example: 'With the default four equal partitions on a 60 s tape, P1 starts at 0.25 = 15 s. Setting P{n} Start to 0.5 puts its beginning 30 s in.',
    expect: 'A setup choice, made before playing. The engine refuses to move a partition while a zone working in it is running.',
    not: 'The recording — the sound stays where it is in time; only the window onto it moves. Not captured by Display States.',
  },
  'apart{n}.len': {
    does: 'How long partition P{n} is, as a fraction of the whole tape.',
    example: 'The default 0.25 on a 60 s tape is 15 s. 0.5 = 30 s; 0.1 = 6 s.',
    expect: 'Make one partition long for a big recording and others short for renders. Zones cannot go past the end of their partition unless their Unsafe switch is on.',
    not: 'The recording itself, and not the other partitions — they may overlap if you let them.',
  },

  // ── Audio · Recording zone ────────────────────────────────────────────────
  'arec.part': {
    does: 'Which partition the Recording zone records into.',
    example: 'P0 (the default) = the first quarter of a default tape. P2 = the third quarter.',
    expect: 'Record into one partition and play or granulate another, so recording never overwrites what you are playing.',
    not: 'Where Playback reads — that is `aplay.part`.',
  },
  'arec.start': {
    does: 'Where in its partition the recording begins, as a fraction of the partition.',
    example: 'In a 15 s partition: 0 = at its start, 0.5 = 7.5 s in, 0.9 = 13.5 s in.',
    expect: 'The REC handle on the Tape moves with it, and dragging the handle moves this.',
    not: 'The recording already on tape — only where the next recording lands.',
  },
  'arec.len': {
    does: 'How long the recording region is, as a fraction of its partition. Recording loops round this region.',
    example: 'In a 15 s partition: 1 = the whole 15 s, 0.2 = a 3 s loop that is recorded over again and again while Run is on.',
    expect: 'A short region with Run left on keeps only the last few seconds — like a looper that always holds “just now”.',
    not: 'The partition’s own size (`apart0.len` and the others).',
  },
  'arec.unsafe': {
    does: 'Lets the Recording zone reach outside its partition, across the whole tape.',
    example: 'Off (the default): a region that would run past the partition end is held inside it. On: it may cross into the next partition and record over whatever is there.',
    expect: 'Leave it off unless you mean to cross. It exists so the safe choice is the default.',
    not: 'Anything while Run is off — it only changes where a recording may land.',
  },
  'arec.on': {
    does: 'Starts and stops recording the microphone into the Recording zone. What was there is replaced.',
    example: 'On: the region fills from its start and, when it reaches the end, carries on from the start again (unless Dynamic is on). Off: recording stops and the tape keeps what was written.',
    expect: 'Needs Audio On and an open microphone. Recording is not undoable with Undo Tape, so check the region first.',
    not: 'Playback — you can play another partition while recording this one.',
  },
  'arec.dynamic': {
    does: 'Makes the take as long as you record, instead of looping a fixed region.',
    example: 'On: press Run, play for 4 s, press Run again — Length becomes those 4 s. If you never stop, it stops at the end of the partition.',
    expect: 'The natural way to catch a phrase of unknown length and then loop exactly that with Playback.',
    not: 'Where the take starts (`arec.start`) or which partition it uses.',
  },

  // ── Audio · Playback zone ─────────────────────────────────────────────────
  'aplay.part': {
    does: 'Which partition the Playback zone, and the three extra playheads, read from.',
    example: 'P0 (the default) plays what Recording put there. P1 might hold a Stretch, P2 a Spectral render.',
    expect: 'Switching partition is the quickest way to change material in performance.',
    not: 'Recording or render destinations — each has its own Partition control.',
  },
  'aplay.start': {
    does: 'Where in its partition the playback loop begins, as a fraction of the partition.',
    example: 'In a 15 s partition: 0 = from its start, 0.4 = from 6 s in.',
    expect: 'An LFO on Start makes the loop wander through the recording; `audio.glide` smooths the moves.',
    not: 'The tape — nothing is changed, only where it is read.',
  },
  'aplay.len': {
    does: 'How long the playback loop is, as a fraction of its partition.',
    example: 'In a 15 s partition: 1 = the whole 15 s, 0.1 = a 1.5 s loop, 0.01 = 0.15 s, a buzzing stutter.',
    expect: 'Very short loops turn into tones: the loop length becomes a pitch.',
    not: 'The speed (`aplay.rate`) — a shorter loop repeats sooner, it does not play faster.',
  },
  'aplay.unsafe': {
    does: 'Lets the Playback zone reach outside its partition, across the whole tape.',
    example: 'Off (the default): the loop is held inside its partition. On: it may run into the next one.',
    expect: 'Useful for playing across a boundary on purpose; otherwise leave it off.',
    not: 'What is on the tape.',
  },
  'aplay.on': {
    does: 'Starts and stops the Playback zone, which loops its region.',
    example: 'On: the playhead (the bright line on the Tape) starts at the region start and loops. Off: it fades out quickly rather than clicking.',
    expect: 'The extra playheads read the same region but each has its own Run switch.',
    not: 'The extra playheads (`aheads.on2` and the others) — they start and stop separately.',
  },
  'aplay.pos': {
    does: 'Jumps the playhead to a point inside the loop region, as a fraction of the region.',
    example: '0 = the region start, 0.5 = halfway, 0.9 = near the end. Each new value is a jump, not a slide.',
    expect: 'Good for triggering from a known point with a MIDI pad. The engine fades briefly over the jump so it does not click.',
    not: 'The region (`aplay.start`, `aplay.len`) — the playhead jumps within it.',
  },
  'aplay.level': {
    does: 'The Playback zone’s own fader.',
    example: '1 (the default) = as recorded. 0.5 ≈ 6 dB quieter. 0 = silent while the playhead keeps moving.',
    expect: 'Fade the main loop under the extra playheads, or ride it with an envelope.',
    not: 'The extra playheads — each has its own Level.',
  },
  'aplay.cueSlot': {
    does: 'Chooses one of eight stored playback regions and recalls it — partition, Start and Length together.',
    example: 'Store a short loop in slot 1 and the whole partition in slot 2; switching between 1 and 2 jumps between them.',
    expect: 'The eight cues are saved in the project file, so they come back when the project is opened.',
    not: 'Rate, Level or the tape — only where Playback reads. Not captured by Display States.',
  },
  'aplay.cueStore': {
    does: 'Stores the current Playback region (partition, Start, Length) into the chosen cue slot.',
    example: 'Set a loop, choose slot 3 with CueSlot, press CueStore — slot 3 now recalls that loop.',
    expect: 'Build up to eight regions before a performance and switch between them by slot.',
    not: 'The tape, or any other slot.',
  },
  'aplay.normalize': {
    does: 'Rewrites the Playback zone’s stretch of tape so its loudest point sits just under full level.',
    example: 'A quiet take peaking at 0.2 is turned up about 4.5×, so its peak lands at 0.891 (−1 dB). One gain for the whole zone and both channels.',
    expect: 'Quiet recordings become usable without changing their dynamics or stereo balance. Undo Tape takes it back.',
    not: 'Anything outside the zone, and silence is left alone.',
  },

  // ── Audio · extra playheads ───────────────────────────────────────────────
  'aheads.on{n}': {
    does: 'Starts and stops playhead {n}: another reader of the same Playback region, with its own speed and level.',
    example: 'With the defaults, heads 2, 3 and 4 play the region at half speed, backwards and double speed — all on at once is a three-voice canon of the same loop.',
    expect: 'The thin green line {n} on the Tape shows where it reads. Move the PLAY handle and all four heads follow.',
    not: 'The region — heads share the Playback zone’s partition, Start, Length and Unsafe.',
  },
  'aheads.rate{n}': {
    does: 'The speed of playhead {n}. Like tape, speed and pitch move together.',
    example: '1 = as recorded, 0.5 = an octave down, 2 = an octave up, −1 = backwards. The defaults are 0.5 (head 2), −1 (head 3) and 2 (head 4).',
    expect: 'An LFO or the Step Sequencer on a head’s Rate is the quickest way to hear what heads are for.',
    not: 'The main Playback rate (`aplay.rate`) or the other heads.',
  },
  'aheads.level{n}': {
    does: 'The fader of playhead {n}.',
    example: '0.7 is the default. 0 silences the head while it keeps moving; 1 matches a full-level main playhead.',
    expect: 'Balance the heads against each other to bring one voice of the canon forward.',
    not: 'The main Playback level or the other heads.',
  },
  'aspec.part': {
    does: 'Which partition the Spectral Writer renders the picture into.',
    example: 'P0 (the default). Render into P2 and set Playback to P2 to hear it.',
    expect: 'Keep renders in a partition you are not recording into — a render overwrites its region.',
    not: 'Where Playback reads (`aplay.part`).',
  },
  'aspec.start': {
    does: 'Where in its partition the render begins, as a fraction of the partition.',
    example: 'In a 15 s partition: 0 = at its start, 0.5 = 7.5 s in.',
    expect: 'If the region would run past the partition end, the render is shortened to fit (unless Unsafe Spec is on).',
    not: 'Anything until you press `aspec.render`.',
  },
  'aspec.len': {
    does: 'How long the render is, as a fraction of its partition. The whole picture is spread across this time.',
    example: 'In a 15 s partition: 1 = the picture lasts 15 s, 0.2 = it is squeezed into 3 s.',
    expect: 'Short renders sound like a gesture or a chord; long ones like a slow scan across the picture.',
    not: 'Pitch — Scale, Root and Rows decide that. Nothing changes until Render.',
  },
  'aspec.unsafe': {
    does: 'Lets the render reach outside its partition, across the whole tape.',
    example: 'Off (the default): a render that would cross the partition end is shortened to fit. On: it crosses and overwrites the next partition.',
    expect: 'Leave it off unless you mean to write across a boundary.',
    not: 'Anything until you press Render.',
  },
  'aspec.slow': {
    does: 'Renders the picture that many times too high and that many times shorter, made to be played back slowed down.',
    example: 'Slow × 4 into a 15 s region: the render is 3.75 s long, two octaves up. Set `aplay.rate` to 0.25 and it plays back 15 s long, at the pitch Root says.',
    expect: 'The slowed-down playback adds the grain and smear of slowed tape. 1 (the default) = off.',
    not: 'Which notes the scale holds — the same notes, only rendered higher and shorter for playing back slow.',
  },
  'aspec.scale': {
    does: 'Which scale the rows of the picture are tuned to. Each row becomes the next note of this scale, counting up from Root.',
    example: 'Major: a drawn line sounds as a major-scale melody. Harmonic series: a vertical stroke sounds as one rich tone instead of a chord. Mel (by ear): rows spaced like a spectrogram, up to about 12 kHz.',
    expect: 'This is the musical decision: the same picture sounds tonal, exotic or noisy depending on it. 36 to choose from.',
    not: 'Time, loudness or stereo position. Nothing changes until Render.',
  },
  'aspec.root': {
    does: 'The pitch of the bottom row, in semitones (the same numbers as MIDI notes).',
    example: '45 (the default) = A2, 110 Hz. 33 = 55 Hz, a deep bass. 57 = 220 Hz. 69 = 440 Hz.',
    expect: 'A higher Root moves the whole render up; with many rows, high roots run out of room and rows above the top of the audio range are dropped.',
    not: 'The spacing between rows (`aspec.scale`). Nothing changes until Render.',
  },
  'aspec.frames': {
    does: 'How many time steps the picture is read as, left to right.',
    example: 'Into a 15 s region: 256 columns (the default) ≈ 59 ms each; 32 columns ≈ 0.47 s each, a slow step sequence; 1024 ≈ 15 ms each, smooth.',
    expect: 'Few columns: blocky, rhythmic chords. Many columns: fine detail and smooth glides. Each column is an average of the picture strip it covers.',
    not: 'Pitch (`aspec.rows`) or the region length. Nothing changes until Render.',
  },
  'aspec.gamma': {
    does: 'How brightness becomes loudness. Higher values let only the brightest parts of the picture speak clearly.',
    example: 'A 50% grey cell (above the Floor): Contrast 1 → half loudness, 2 (the default) → a quarter, 4 → about 6%. A white cell is full loudness at any setting.',
    expect: 'Raise it when a busy picture renders as a wash of every pitch; lower it to hear soft, shaded areas.',
    not: 'Which pitches exist, or pure black — black is silent at any setting. Nothing changes until Render.',
  },
  'aspec.floor': {
    does: 'Brightness at or below this is silent; the rest is rescaled from it.',
    example: '0.06 (the default) silences the faint noise a camera frame always has. 0 = every non-black pixel sounds. 0.3 = only clearly bright areas sound.',
    expect: 'The cure for a render that hisses with all pitches at once. A fading stroke still fades rather than switching off.',
    not: 'How loud the bright parts are relative to each other (`aspec.gamma`). Nothing changes until Render.',
  },
  'aspec.level': {
    does: 'The overall level of the render, written into the tape.',
    example: '1 (the default) = full. 0.5 ≈ 6 dB quieter. 0 renders silence.',
    expect: 'Lower it if renders with many bright rows come out too hot; Normalize afterwards brings a quiet render up.',
    not: 'Anything already on tape until you press Render.',
  },
  'aspec.pan': {
    does: 'How the picture becomes stereo position.',
    example: 'Off (the default): mono. Colour: red parts of the picture go right, blue parts left. Spread: low rows left, high rows right. Sweep: the render travels from left to right over its length.',
    expect: 'Colour follows what is in the picture; Spread and Sweep are pure geometry and work on any picture, even grey.',
    not: 'Loudness or pitch. Nothing changes until Render.',
  },
  'aspec.panWidth': {
    does: 'How far from the centre the stereo placement reaches.',
    example: '1 (the default) = full left to full right. 0.5 = half way. 0 = mono, whatever Pan Image says.',
    expect: 'Narrow it for a render that should sit in the middle of a mix.',
    not: 'Which way things are placed (`aspec.pan`). Nothing changes until Render.',
  },
  'aspec.render': {
    does: 'Reads the current output frame — whatever ImWeb is showing — and writes it into the Spectral region as sound. This overwrites that region.',
    example: 'With the defaults: a 48-row, 256-column reading of the picture in Major from 110 Hz, spread over the whole of P0. The status line says "spectral: … rendered into P0".',
    expect: 'Takes a moment; play the region afterwards with Playback. Undo Tape takes a render back.',
    not: 'The picture, and nothing outside the Spectral region.',
  },
  'aspec.cancel': {
    does: 'Stops a Spectral render that is in progress.',
    example: 'Press it during a long render: it stops, and the part already written stays on tape.',
    expect: 'Useful when you pressed Render on the wrong settings.',
    not: 'Anything when no render is running.',
  },

  // ── Audio · Stretch ───────────────────────────────────────────────────────
  'astretch.part': {
    does: 'Which partition the stretched result is written into.',
    example: 'P1 (the default), because the result may not overlap the Playback zone it reads from, which defaults to P0.',
    expect: 'Point Playback at this partition afterwards to hear the stretch.',
    not: 'The source — the Stretch always reads what the Playback zone is set to.',
  },
  'astretch.start': {
    does: 'Where in its partition the stretched result begins, as a fraction of the partition.',
    example: 'In a 15 s partition: 0 = at its start, 0.5 = 7.5 s in.',
    expect: 'The STRETCH handle on the Tape moves with it.',
    not: 'Anything until you press `astretch.render` or `astretch.freeze`.',
  },
  'astretch.len': {
    does: 'How much tape the stretched result may fill, as a fraction of its partition.',
    example: 'A 2 s sound at Stretch × 8 wants 16 s; in a 15 s zone it stops at 15 s, the zone being full.',
    expect: 'The stretch stops when the zone is full or the source runs out, whichever comes first.',
    not: 'How much the sound is stretched (`astretch.amount`).',
  },
  'astretch.unsafe': {
    does: 'Lets the stretched result be written outside its partition.',
    example: 'Off (the default): kept inside the partition. On: it may cross into the next one and overwrite it.',
    expect: 'Leave it off unless you mean to cross.',
    not: 'Anything until you press Stretch or Freeze.',
  },
  'astretch.amount': {
    does: 'How many times longer the Stretch makes the sound, without changing its pitch.',
    example: '8 (the default): a 2 s phrase becomes 16 s. 2 = twice as long, still recognisable. 50–100 = a single word becomes a slow, shimmering drone.',
    expect: 'The result is a smooth wash at any amount rather than a slowed-down recording — the PaulStretch method.',
    not: 'Pitch — that stays as recorded. Nothing changes until you press Stretch.',
  },
  'astretch.window': {
    does: 'The size of the slices the Stretch works with — the grain of it.',
    example: '0.25 s (the default). 0.05 s keeps more of the source’s rhythm and sounds granular. 1–1.5 s loses every attack and becomes a smooth wash. It is rounded to the nearest size the engine uses.',
    expect: 'Short for speech and percussion you still want to recognise; long for pads and drones.',
    not: 'How long the result is (`astretch.amount`).',
  },
  'astretch.level': {
    does: 'The level of the stretched result as it is written.',
    example: '1 (the default) = full; a loud source is rounded off softly rather than clipping. 0.5 ≈ 6 dB quieter.',
    expect: 'Lower it if you plan to layer the stretch under other material.',
    not: 'Anything already on tape until you press Stretch or Freeze.',
  },
  'astretch.render': {
    does: 'Stretches what the Playback zone is set to and writes the result into the Stretch zone. This overwrites that region.',
    example: 'Playback on a 2 s phrase in P0, Stretch × 8, press Stretch: P1 fills with a 15 s wash (the zone being full before 16 s).',
    expect: 'It renders about four times faster than it plays. The same settings on the same material give the same sound every time. Undo Tape takes it back.',
    not: 'The source region — it is only read.',
  },
  'astretch.freeze': {
    does: 'Holds one moment instead of moving through the sound: the first Window of the Playback zone, as a steady drone filling the whole Stretch zone.',
    example: 'Move the PLAY handle’s left edge onto a vowel, Window 0.25 s, press Freeze: the Stretch zone fills with that vowel, held.',
    expect: 'A quick way to make a sustained tone from any sound. Undo Tape takes it back.',
    not: '`astretch.amount` — a freeze fills the zone whatever the amount.',
  },
  'astretch.cancel': {
    does: 'Stops a Stretch or Freeze that is in progress.',
    example: 'Press it during a long stretch: it stops, and the part already written stays.',
    expect: 'Useful when a stretch was started with the wrong settings.',
    not: 'Anything when no stretch is running.',
  },

  // ── Audio · Corpus ────────────────────────────────────────────────────────
  'acorp.hop': {
    does: 'How often the Analyse step takes a measurement: one grain every this many milliseconds.',
    example: '45 ms (the default): a 15 s partition becomes about 330 points on the pad. 10 ms ≈ 1500 points, finer but slower to analyse. 200 ms ≈ 75 points.',
    expect: 'Shorter hops give a denser map; you will not hear a difference until you navigate.',
    not: 'The tape or the grain player’s sound. Used the next time you press `acorp.analyse`.',
  },
  'acorp.window': {
    does: 'How long a slice of sound each measurement listens to.',
    example: '85 ms (the default). 20 ms measures quick details (single consonants, clicks). 300 ms averages over whole notes.',
    expect: 'Match it roughly to the sounds you care about: short for percussive material, long for sustained.',
    not: 'The tape. Used the next time you press Analyse.',
  },
  'acorp.analyse': {
    does: 'Measures the tape in short grains — loudness, brightness, pitch and periodicity — and draws every grain as a point on the pad.',
    example: 'After recording into P0, press Analyse: the status line says how many grains it found, e.g. "corpus: 330 grains".',
    expect: 'Run it again after recording something new; the map does not update by itself.',
    not: 'The tape — it only reads.',
  },
  'acorp.cancel': {
    does: 'Stops an analysis that is in progress.',
    example: 'Press it during a long analysis of a 10-minute tape: it stops at once.',
    expect: 'Run Analyse again for a complete map.',
    not: 'Anything when no analysis is running.',
  },
  'acorp.xAxis': {
    does: 'Which measurement runs left to right on the pad.',
    example: 'Brightness (the default): dull sounds on the left, bright on the right. Pitch: low on the left, high on the right, spaced by octaves.',
    expect: 'Changing an axis redraws the map at once — no new analysis needed.',
    not: 'The sound — only how the map is laid out.',
  },
  'acorp.yAxis': {
    does: 'Which measurement runs bottom to top on the pad.',
    example: 'Loudness (the default), on a decibel scale so quiet material is not crushed into the bottom edge. Periodicity: noisy at the bottom, clearly pitched at the top.',
    expect: 'Brightness against Loudness separates most material; try Pitch against Periodicity for sung or played notes.',
    not: 'The sound — only how the map is laid out.',
  },
  'acorp.x': {
    does: 'Where you point on the pad, left to right. The grain player jumps to the grain nearest that point.',
    example: 'With Brightness on X: 0.1 points the grains at dull sounds, 0.9 at bright ones. Its landing place shows on `agrain.pos`.',
    expect: 'Drag on the pad, or drive it with an LFO or MIDI knob to wander through sounds by their character rather than by time.',
    not: 'Anything until Analyse has made a map. You only hear it while Run Grain is on.',
  },
  'acorp.y': {
    does: 'Where you point on the pad, bottom to top. The grain player jumps to the grain nearest that point.',
    example: 'With Loudness on Y: 0.1 points at quiet moments, 0.9 at the loudest.',
    expect: 'Together with Corpus X it turns the pad into a map of “this bright, this loud”.',
    not: 'Anything until Analyse has made a map.',
  },

  // ── Audio · Grain Player ──────────────────────────────────────────────────
  'agrain.part': {
    does: 'Which partition the Grain Player reads from.',
    example: 'P0 (the default). Point it at a Stretch in P1 for grains of a wash.',
    expect: 'The corpus pad only shows grains the player can reach, so changing this redraws the map.',
    not: 'Where anything is written — the Grain Player only reads.',
  },
  'agrain.on': {
    does: 'Starts and stops the Grain Player — a cloud of short overlapping slices of the tape.',
    example: 'On with the defaults: 25 grains a second, each 90 ms long, read around Grain Pos.',
    expect: 'A yellow GRAIN line on the Tape shows where it is pointed while it runs.',
    not: 'Playback or the heads — they run independently.',
  },
  'agrain.pos': {
    does: 'Where in its partition the grains are read from, as a fraction of the partition.',
    example: 'In a 15 s partition: 0.5 = 7.5 s in. A slow LFO sweeping 0 → 1 over 60 s plays the 15 s four times slower without lowering the pitch.',
    expect: 'This is the time-stretch control. The corpus pad writes here when you point at a sound.',
    not: 'Pitch (`agrain.pitch`) — moving the position slowly does not change pitch.',
  },
  'agrain.size': {
    does: 'How long each grain is.',
    example: '90 ms (the default). 10–20 ms = a buzzy, granular texture. 300–500 ms = recognisable fragments, almost loops.',
    expect: 'Size × Density decides how much grains overlap: 90 ms at 25 a second ≈ 2 grains sounding at once.',
    not: 'Where grains are read (`agrain.pos`).',
  },
  'agrain.rate': {
    does: 'Density: how many grains start each second.',
    example: '25 a second (the default). 5 = separate, audible blips. 100–200 = a dense, continuous cloud. At most 16 grains sound at once.',
    expect: 'Low density with short grains gives rhythm; high density gives a smooth texture.',
    not: 'Grain length or pitch.',
  },
  'agrain.pitch': {
    does: 'Transposes every grain, in semitones.',
    example: '0 (the default) = as recorded. +12 = an octave up. −7 = a fifth down. ±24 = two octaves.',
    expect: 'Unlike playback Rate, transposing grains does not change how fast the player moves through the tape.',
    not: 'Grain Pos — the place in time stays where it is.',
  },
  'agrain.spray': {
    does: 'Scatters each grain’s read position randomly, either side of Grain Pos.',
    example: '20 ms (the default): a slight blur. 0 = every grain from the same spot, a frozen, buzzing tone. 300–500 ms = grains from a wide neighbourhood, a shimmering smear.',
    expect: 'A little spray stops a frozen position sounding mechanical.',
    not: 'Pitch, size or density.',
  },
  'agrain.level': {
    does: 'The Grain Player’s fader.',
    example: '0.6 (the default). 0 silences it while it runs; 1 is full.',
    expect: 'Dense clouds add up, so they may need a lower level than sparse ones.',
    not: 'The other zones or the Voice.',
  },
  'agrain.unsafe': {
    does: 'Lets the Grain Player read across the whole tape, not just its partition.',
    example: 'Off (the default): Grain Pos 0–1 spans its partition. On: grains may come from anywhere on the tape, and the corpus pad shows all of it.',
    expect: 'Turn it on to navigate the whole tape from the corpus pad.',
    not: 'The tape — the Grain Player only reads.',
  },

  // ── Audio · Voice ─────────────────────────────────────────────────────────
  'avoice.on': {
    does: 'Starts and stops the Voice — a simple synthesizer inside the audio engine.',
    example: 'On with the defaults: a sine at 220 Hz (A3) at level 0.3, through a low-pass filter at about 1 kHz.',
    expect: 'It needs no tape and no microphone, only Audio On. It fades in and out rather than clicking.',
    not: 'The tape — the Voice is heard, not recorded.',
  },
  'avoice.src': {
    does: 'What the Voice starts from: an oscillator (Osc) or noise.',
    example: 'Osc: a pitched tone shaped by Wave and FM. Noise: hiss, shaped by Colour and the filter.',
    expect: 'Noise through a resonant filter gives wind and whistles; Osc gives notes.',
    not: 'The filter, drive or level — those act on either source.',
  },
  'avoice.wave': {
    does: 'The oscillator’s waveform.',
    example: 'Sine: pure and round. Saw: bright and buzzy, rich in harmonics. Square: hollow, reedy. Tri: soft, between sine and square.',
    expect: 'Bright waves (Saw, Square) give the filter something to work on; a Sine changes little under a low-pass.',
    not: 'Anything while Source is Noise.',
  },
  'avoice.pitch': {
    does: 'The note the oscillator plays, in semitones (the same numbers as MIDI notes).',
    example: '57 (the default) = A3, 220 Hz. 69 = A4, 440 Hz. 45 = 110 Hz. 120 ≈ 8.4 kHz, the top.',
    expect: 'A Step Sequencer or MIDI on Pitch plays melodies; whole numbers are equal-tempered notes.',
    not: 'Noise, or the filter cutoff (`avoice.cut`) — they do not follow the note.',
  },
  'avoice.fmRatio': {
    does: 'The speed of the FM modulator relative to the note. Only heard when `avoice.fmIndex` is above 0.',
    example: '1 (the default) and 2 keep the tone harmonic (bright, brassy). 1.41 or 3.5 give clangorous, bell-like tones.',
    expect: 'Whole-number ratios sound musical; in-between ratios sound metallic.',
    not: 'The pitch of the note — FM here keeps the centre pitch steady.',
  },
  'avoice.fmIndex': {
    does: 'How much FM is applied — how strongly the modulator bends the waveform.',
    example: '0 (the default) = no FM. 0.2 = a slight brightening. 1 = clearly metallic. 4 = harsh and noisy.',
    expect: 'An envelope or LFO on Index is the classic way to make FM tones speak.',
    not: 'Anything while Source is Noise.',
  },
  'avoice.colour': {
    does: 'The colour of the noise source, from dark to bright.',
    example: '0 = dark, rumbling noise. 0.5 (the default) = white noise. 1 = bright, thin hiss.',
    expect: 'Combine with the filter for wind, surf or breath.',
    not: 'The oscillator — Colour only shapes Noise.',
  },
  'avoice.res': {
    does: 'Resonance: how strongly the filter rings at its cutoff.',
    example: '0 = gentle, no peak. 0.2 (the default) = a slight emphasis. 0.9–1 = a sharp, whistling peak.',
    expect: 'Sweep the cutoff with high resonance for the classic synth “wow”. It is built so it cannot run away into a scream.',
    not: 'Where the filter sits (`avoice.cut`).',
  },
  'avoice.ftype': {
    does: 'The filter’s shape, blended smoothly from one to the next.',
    example: '0 = low-pass (keeps the lows), 1 = band-pass (only around the cutoff), 2 = high-pass (keeps the highs), 3 = notch (removes around the cutoff). 0.5 is halfway between low- and band-pass.',
    expect: 'Because it is continuous, an LFO on it morphs the timbre without clicks.',
    not: 'Where the filter sits (`avoice.cut`) or how much it rings (`avoice.res`).',
  },
  'avoice.drive': {
    does: 'Pushes the Voice into a soft saturation after the filter, adding warmth and harmonics.',
    example: '0 (the default) = clean. 0.3 = warm, slightly fuzzy. 1 = up to 10× into the saturator, heavily distorted. The level is partly compensated so it does not jump.',
    expect: 'Most audible on Saw and Square; drive after a resonant filter makes the peak growl.',
    not: 'Pitch or the filter settings.',
  },
  'avoice.level': {
    does: 'The Voice’s fader.',
    example: '0.3 (the default). 0.6 ≈ 6 dB louder. 0 silences it while it runs.',
    expect: 'The Voice adds to everything else before the master Out Gain and the limiter.',
    not: 'The tape zones or the Grain Player.',
  },

  // ── Video · more core controls ──────────────────────────────────────────
  'layer.bg': {
    does: 'Which source is the Background — the picture underneath, seen wherever the keyer cuts the Foreground away.',
    example: 'Color 1 (the default): a flat colour, set by `color1.hue`. Movie A: the movie fills the dark and bright parts of the camera picture when Keyer is on.',
    expect: 'With Keyer off the Background is hidden behind the Foreground, so a change here seems to do nothing until the keyer is on.',
    not: 'The Foreground (`layer.fg`) or the Displacement source (`layer.ds`).',
  },
  'layer.ds': {
    does: 'Which source drives Displacement: its brightness decides how far each pixel of the picture is pushed.',
    example: 'Color 2 (the default): a flat colour, so every pixel is pushed the same way. Noise: a restless, liquid distortion. Camera: the picture is bent by your own image.',
    expect: 'You see nothing from it until `displace.amount` is above 0. The Displacement source itself is not shown.',
    not: 'What is shown — only how it is bent.',
  },
  'blend.amount': {
    does: 'How strongly the feedback (the previous frame, combined by Feedback Mode) is mixed into the live picture.',
    example: '0% = the live picture only. 50% (the default) = half and half: clear trails. 100% = the feedback result only, which builds up fast.',
    expect: 'It only acts while Blend and Feedback are both on and Feedback Mode is not Off. Above about 80% the picture tends to smear into itself.',
    not: 'The keyer or the sources. With Blend off it does nothing.',
  },
  'keyer.white': {
    does: 'The upper brightness threshold of the key. Foreground brighter than this is cut away and the Background shows through.',
    example: '80% (the default): only the brightest parts (sky, lamps) are replaced. 100%: nothing is cut for being bright. 50%: everything above mid-grey is replaced.',
    expect: 'Pair it with `keyer.black`: the Foreground stays only where its brightness lies between the two.',
    not: 'Anything while Keyer is off, and not the Background picture.',
  },
  'keyer.black': {
    does: 'The lower brightness threshold of the key. Foreground darker than this is cut away and the Background shows through.',
    example: '10% (the default): only near-black areas are replaced. 0%: nothing is cut for being dark. 40%: all the shadows are replaced.',
    expect: 'Raise it to put the Background into the shadows of the camera picture. If it passes `keyer.white`, nothing of the Foreground is left.',
    not: 'Anything while Keyer is off.',
  },
  'feedback.rotate': {
    does: 'Each frame, the previous frame is turned a little before it is mixed back in, so the trails spiral.',
    example: 'At 60 frames a second: 0.5% = 1.8° a frame, a slow swirl (about one turn every 3.3 s). 2% = 7.2° a frame, a fast vortex. Negative turns the other way.',
    expect: 'Small values are the useful ones; combine with `feedback.zoom` for spirals. Near 50% or 100% the turn is a half or whole turn per frame and reads as flicker or as standing still.',
    not: 'The live source. It only acts while Blend and Feedback are on and Feedback Mode is not Off.',
  },
  'feedback.decay': {
    does: 'How much of the previous frame survives each time it is fed back — how long trails last.',
    example: '100% (the default) = no fading: trails last until something covers them. 98% = halves in about 34 frames (≈ 0.6 s at 60 fps). 90% = halves in about 7 frames, short tails.',
    expect: 'Lower it when feedback fills the screen and goes white. Small changes near 100% make a big difference.',
    not: 'The live picture. It only acts while Blend and Feedback are on and Feedback Mode is not Off.',
  },
  'displace.amount': {
    does: 'How far each pixel is pushed, according to the brightness of the Displacement source.',
    example: '0 (the default) = off. 20 = bright or dark parts of the source push pixels up to 1% of the screen; mid-grey pushes nothing. 100 = up to 5% of the screen, a strong melt.',
    expect: 'The direction is `displace.angle`. A moving source (Noise, Camera) makes the picture ripple.',
    not: 'Colour or brightness — it only moves pixels.',
  },
  'color1.hue': {
    does: 'The hue of the Color 1 source, a flat colour — and the default Background.',
    example: '0 = red, about 17 = yellow, 33 = green, 50 = cyan, 67 = blue, 83 = magenta, 100 = red again.',
    expect: 'An LFO on it cycles the background through the rainbow. Saturation and brightness are `color1.sat` and `color1.val`.',
    not: 'Any other source. You only see it where Color 1 is used.',
  },
};

/** The written explanation for `id`, with `{n}` filled in, or null. */
export function lookupExplanation(id) {
  if (EXPLANATIONS[id]) return EXPLANATIONS[id];
  const m = id.match(/\d+/);
  if (!m) return null;
  const tpl = EXPLANATIONS[id.replace(/\d+/, '{n}')];
  if (!tpl) return null;
  const out = {};
  for (const [k, v] of Object.entries(tpl)) out[k] = v.replaceAll('{n}', m[0]);
  return out;
}
