# Structured Light (Gray-code ProCam scan) — design and phase plan

Status 2026-09-27: **Phase 1 done** (pure core + synthetic-rig audit). Nothing is
wired into the app yet. Built with no camera or projector available; every
hardware-facing number below is still to be measured on the rig.

## Decisions (and why)

| Question | Decision | Why |
|---|---|---|
| Window coordination | Same-origin `window.open` reference, direct function calls into the output window; scan clock = the **output window's** rAF | Same agent/thread, so there is no message hop. BroadcastChannel reaches every same-origin tab; a SharedWorker cannot touch the popup's WebGL |
| Pattern transport | Patterns are **drawn in the output window** by `PATTERN_FRAG`, never sent as bitmaps | The frame path posts every 2nd frame through `createImageBitmap(…, resizeQuality:"medium")`, which blurs 1–2 px stripes and adds variable delay |
| "Is it on screen yet?" | `SettleGate` — decide by **camera content** (two agreeing frames that differ from the last pattern) | No web API reports photons; projector lag + camera buffering are invisible to the page. Rolling-shutter torn frames never agree with their successor |
| Latency | Measured once per rig (black→white flash), passed to `SettleGate` — **required**, no default | At 0, a slow projector's OLD pattern gets quietly accepted (9/21 audit cases) |
| Pattern set | White, black, then pattern/inverse pairs adjacent, finest bits first. 1920×1080 = 2 + 2·(11+11) = **46** | 1080 rows need 11 bits. Adjacent pairs cancel gain drift; finest-first lets the decoder stream |
| Pattern generation | Fragment shader (GLSL ES 1.00, **highp**, `uP = 2^bit` from JS) | Pre-rendered bitmaps ≈ 365 MB and switch no faster (vsync-bound). mediump breaks columns > ~1024 |
| Decode | CPU, typed arrays, in a Worker (`GrayDecoder`), fed the Y plane of `VideoFrame`s | One-off bake; one testable definition; no GPU readback traps |
| Bit classification | Xu–Aliaga direct/global rule with Ld/Lg as **means** over separation pairs + noise and model margins | Max/min estimates are biased toward flipping bits (218 wrong codes in the audit corner) |
| Stripe edges | An uncertain bit whose two candidates are **adjacent** codes puts the pixel on the edge | Otherwise every coarse boundary cuts an invalid band (5.7% of a clean surface) |

## Camera lock (Phase 2, needs hardware)

Project mid-grey and let auto-exposure, white balance and focus settle. Read
`getSettings()`, then `applyConstraints({advanced:[{exposureMode:'manual', …}]})`
with those values. On DLP projectors, set exposure to a whole multiple of the
refresh period. Check that the lock holds instead of trusting it: P+N of each
pair should be constant per pixel. Support depends on the camera; probe it with
`getCapabilities()`. Also turn off the projector's dynamic iris, eco mode and
keystone.

## Phases

1. ✅ `src/core/StructuredLight.js` + `tests/audit-structured-light.mjs`: codes,
   pattern set, shader, decoder, outlier rejection, settle gate.
2. Rig I/O: pattern mode in the output window (projection mesh and edge fade
   off, device-pixel canvas); camera track with locking; latency measurement;
   Worker loop using `MediaStreamTrackProcessor`. **Touches main.js**, so wait
   until no other session is editing it.
3. Inversion to projector space: rasterise the correspondence triangle grid,
   dropping triangles across discontinuities; nearest surface wins. Store the
   camera-uv map as RG32F with **Nearest** filtering (half-float is ~1 px coarse
   at 1920).
4. **Auto projection map** (the biggest win): with the camera at the audience's
   position, pre-warp content and/or fit `ProjMapMesh`, plus an automatic
   object mask.
5. Derived bakes from a reference-wall scan: relief (disparity, R16F), normals
   (plane fit on smoothed relief), edges (RGBA8: valid / silhouette / step /
   crease), SDF (exact EDT, RG16F). Expose them as new SOURCE_DEFS entries and
   to the Live GLSL preamble. The scan slot is a `global` param (contents are
   per-origin, in IndexedDB).
6. Optional: Gray + phase-shift hybrid for sub-pixel precision; monocular ML
   depth registered through the scan.

## Known limits

- Strong interreflection (bounced light brighter than direct) cannot be
  decoded with Gray codes. The robust rule **drops** such regions rather than
  guessing. Micro phase shifting is the published fix.
- `sepBits` (default 2,3 → 8/16 px stripes) must be resolvable by the camera.
  If they are not, coverage collapses; codes do not go wrong. Auto-selecting
  them from the captured contrast is an open item.
