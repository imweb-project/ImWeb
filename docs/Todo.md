**Chromium bug:** https://issues.chromium.org/issues/513611558 (filed 2026-05-16)
**Status:** Active — Chromium team investigating. hopefully fixed in Cromes next version. It is fixed.

**Defer to next Claude Code session:**

- GitHub cleanup (personal .imweb files, junk folders)
- public/docs/ deduplication
- Teletext full documentation

TASK for claude code: remove public/docs/ duplication
- Check how vite.config.js serves static assets
- Either alias /docs → docs/ in Vite config
- Or update in-app links to point to GitHub URLs
- Then: rm -r public/docs/
- Do not touch: docs/, public/assets/

Cleaning up the MasterProject.imweb that starts up with new project.  MasterProject.imweb is not always starting up in the beginning?  with Restore MasterProject? 

All current banks, states, and tables will be permanently replaced with the factory MasterProject defaults.  
  
**This cannot be undone.**

- ~~Redesign the Noise~~ — Phase 1 done: family→type selector
- ~~Noise: scale from center (shader fix)~~
- ~~Noise Phase 2: psrdnoise / Periodic family~~
- ~~PsrdWarp~~
  * Note: tearing fixed; phase jump fixed; organic non-periodic mode
    restored. Remaining: period tile-count semantics, gradient
    discontinuity seams at small period with Gain > 0 (deferred).

**PSRDnoise extensions — next session:**
- [x] Swirl parameter — blend gradient warp ↔ perpendicular curl warp
      (uSwirl=0: billowing clouds, uSwirl=1: vortex/cyclone). One
      uniform, one line: mix(gsum, vec2(-gsum.y, gsum.x), uSwirl)
- [x] Ridge mode — abs() on noise accumulation for turbulent ridge
      and tendril patterns
- [ ] Period-as-tile-count redesign — pass uScale/uPeriod to psrdnoise
      so range 0–8 is always visually meaningful regardless of Scale
- [ ] Investigate Period slider even-only display — step:1 confirmed
      in ParameterSystem; check DOM range input step attribute after
      hard refresh (Cmd+Shift+R)
- [ ] Speed range -10..10 — confirm ParameterSystem change landed
- [x] FIX FIRST: 3D objects still appear gray by default
- [ ] Textured 3D objects darker than 2D pipeline — see KNOWN-ISSUES.md
- [ ] 3D procedural noise on mesh — psrdnoise3D injected into material
  shader using object-space position (future enhancement)


**Controller mapping — decided 2026-09-16, not yet built:**

- [x] **Latch: ONE option, not a family.** BUILT 2026-09-16. A press on a CONTINUOUS param
      alternates between the row's **min and max fields** — those already
      bound every controller write (`ctrlMin ?? min` / `ctrlMax ?? max`,
      ParameterSystem ~464), so the two ends are configurable today and
      only the alternation is missing. Why it is needed: a press-only
      device (a Flic sends the same message every click) can currently
      drive a continuous param one way and never back.
      * Lives in the SHARED rule (`src/controls/controlInput.js`) so a
        Flic, a MIDI pad, a gamepad button and a key behave identically —
        an OSC-only setting would re-introduce the divergence that rule
        was just created to remove.
      * Off by default. Offered ONLY on continuous params: a toggle
        already flips on the press, so the option never appears where it
        would be redundant.
      * **The badge must show it** (`OSC:/flic/1 ⇄`) — one button
        alternating while another does not, with nothing on screen saying
        which, is the entire confusion risk. The checkbox belongs in the
        badge popover that already exists.
      * Rejected: a family of modes (bang-to-max / bang-to-min / step /
        set-to-X). Each multiplies UI, persistence and audit surface, and
        most are already reachable — "set to X" is "set the row's max to
        X", and momentary already works for devices that send 1 then 0.
      * Fiddly part: after a state recall moves the value, the next press
        must decide from the CURRENT value (nearest end, then travel to
        the other) or it reads as a skipped press. Needs an audit case.

- [ ] **Mapping pages for non-MIDI bindings** — the other half of the
      shared-dispatch work. `param.midiPages[]` holds MIDI configs, so
      letting gamepad and OSC bindings live in pages touches persistence;
      keep the field NAME (saved states, banks and .imweb files carry it).
      Soft takeover becomes reachable for those inputs at the same time,
      and only then: it is armed solely by a mapping-page switch today,
      which is why it was deliberately left out of the shared rule rather
      than wired in as a gate that could never fire.

- [ ] **Delete the dead `nudge` badge label** — ParameterSystem maps a
      `nudge` controller type to the badge `NDG` and nothing anywhere
      dispatches it (grepped 2026-09-16). Either implement it or remove
      the entry; a label that can name a controller no code drives is rot.


