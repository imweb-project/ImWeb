# Structured Light (Gray-code ProCam scan) — design and phase plan

Status 2026-09-27: **pure maths done** — decode (Phase 1) and the bake
(Phases 3 and 5 as functions: `src/core/StructuredLightBake.js`). Nothing is
wired into the app yet. Built with no camera or projector available; every
hardware-facing number is still to be measured on the rig. Both audits run on
one shared simulated rig, `tests/lib/procam-sim.mjs`.

## Decisions (and why)

| Question | Decision | Why |
|---|---|---|
| Window coordination | Same-origin `window.open` reference, direct function calls into the output window; scan clock = the **output window's** rAF | Same agent/thread, so there is no message hop. BroadcastChannel reaches every same-origin tab; a SharedWorker cannot touch the popup's WebGL |
| Pattern transport | Patterns are **drawn in the output window** by `PATTERN_FRAG`, never sent as bitmaps | The frame path posts every 2nd frame through `createImageBitmap(…, resizeQuality:"medium")`, which blurs 1–2 px stripes and adds variable delay |
| "Is it on screen yet?" | `SettleGate` — decide by **camera content** (two agreeing frames that differ from the last pattern) | No web API reports photons; projector lag + camera buffering are invisible to the page. Rolling-shutter torn frames never agree with their successor |
| Latency | Measured once per rig by `LatencyProbe` (black/white flashes), passed to `SettleGate` — **required**, no default | At 0, a slow projector's OLD pattern gets quietly accepted (9/21 audit cases) |
| Latency definition | Frames from command until the picture has changed AND held still: the first WHOLE frame | "First change + 1" assumes one transitional frame; an exposure straddling the switch gives a torn one AND a blended one |
| Orchestration | `ScanSession`: I/O shows what it says and pushes every camera frame; all timing decisions are pure and simulated | A fixed 2-frame flush at latency 4 decodes nothing; the session matches a clean scan on 99.7% of pixels with no latency number to go stale |
| Camera not looking | White/black reference accepted without a visible change → the session stops, and `result()` says why | Otherwise a blind camera "completes" a scan of nothing |
| Frame statistic cost | `cellMAD` runs twice per camera frame; optimised 15.1 → 7.8 ms at 1280×720, bit-equal to the plain form | 30 ms of a 33 ms frame budget would have made the worker fall behind the camera |
| Pattern set | White, black, then pattern/inverse pairs adjacent, finest bits first. 1920×1080 = 2 + 2·(11+11) = **46** | 1080 rows need 11 bits. Adjacent pairs cancel gain drift; finest-first lets the decoder stream |
| Pattern generation | Fragment shader (GLSL ES 1.00, **highp**, `uP = 2^bit` from JS) | Pre-rendered bitmaps ≈ 365 MB and switch no faster (vsync-bound). mediump breaks columns > ~1024 |
| Decode | CPU, typed arrays, in a Worker (`GrayDecoder`), fed the Y plane of `VideoFrame`s | One-off bake; one testable definition; no GPU readback traps |
| Bit classification | Xu–Aliaga direct/global rule with Ld/Lg as **means** over separation pairs + noise and model margins | Max/min estimates are biased toward flipping bits (218 wrong codes in the audit corner) |
| Stripe edges | An uncertain bit whose two candidates are **adjacent** codes puts the pixel on the edge | Otherwise every coarse boundary cuts an invalid band (5.7% of a clean surface) |
| Inversion | **Rasterise** the camera grid as triangles at their projector positions; drop any triangle with an invalid vertex or an edge > 3× the median | Interpolation closes small gaps; a splat-and-fill would bridge depth steps (1,932 false fills on the audit's step) |
| Inversion rim | A mesh through camera pixel CENTRES leaves ~½ camera px unfilled at outlines and along step seams | Accepted: sub-pixel at 1080p, and a seam reads as a silhouette, which it is |
| Relief | Disparity against an **empty-wall reference scan**, projected on the displacement field's principal axis, auto sign = objects stand out | No lens calibration needed. The σ=5 wall-vs-wall null puts p99.9 at 0.41 camera px, ~5× below the step threshold |
| Normals | Step-aware smoothing (never averages across a relief jump > `step`), then central differences that also stop at steps | A blur across a step made 443 stray crease pixels; a gradient across it tilts the pixel beside every edge to 0.995 |
| SDF | Exact Felzenszwalb EDT (checked against brute force), not jump flooding | One-off bake, so exact is affordable |
| Auto map | Mesh node (i,j) = the decoded projector position of the camera point where content (i/(C−1), j/(R−1)) should appear. Uses the camera→projector map **directly**, with no inversion or lens model | "Looks right from the audience" is exactly this, once the camera sits at the audience position |
| Auto map: nodes | 2×2 → corners of the least-squares homography (normalised DLT + one trimming pass). Larger grids → Gaussian-weighted **quadratic** fit around each node | 2×2 IS one projective quad. Affine nodes were 0.075 px off a true homography; quadratic ones are 3e-4 |
| Auto map: holes | Support must surround the node in every quadrant that lies in the frame (≥30% valid); the radius doubles up to half the frame | One-sided quadratic fits were 1.3 px off in a hole; the global-homography fallback was 2–3 px off on a bump |
| Auto map: no data | Only nodes beyond the camera frame fall back to the homography, and they are listed in `extrapolated` | So the UI can mark guessed handles |
| Auto map: grid size | `fitAuto(tol)`: the smallest of 2, 3, 5, 9, 17 whose p95 residual (scored through `ProjMapMesh.sample()`) is ≤ tol | The residual is measured on the renderer's own surface, not on a copy of it |

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
2. Rig I/O. The timing logic is ✅ (`src/core/StructuredLightSession.js`:
   `LatencyProbe`, `ScanSession`). Still to do: pattern mode in the output
   window (projection mesh and edge fade off, device-pixel canvas); camera
   track with locking; a Worker loop using `MediaStreamTrackProcessor` that
   pushes Y planes into the session. **Touches main.js**, so wait until no
   other session is editing it.
3. ✅ `invertToProjector`, and ✅ packing (`src/core/StructuredLightPack.js`):
   `packBake(bake)` → typed arrays with rows flipped to bottom-up;
   `toDataTextures()` → three DataTextures. The formats:
   - relief: R16F, normalised to its peak;
   - normals: RGBA16F, y-up, valid in w;
   - edges: RGBA8;
   - distances: RG16F, capped at `meta.distCap`, which means "no edge";
   - camera-uv: **RG32F Nearest**, y-up, −1 where unseen.

   Note that three's `toHalfFloat` truncates toward zero, so the stored error
   is up to one step.
4. ✅ (maths) **Auto projection map**: `src/core/StructuredLightFit.js`.
   `fitProjectionMesh(res, {cols, rows, rect})` and `fitAuto(res, {tol})` return
   ProjMapMesh points (window fractions, y down). Audit rig: 2×2 p95 8.98 px,
   3×3 6.42, 5×5 3.64, 9×9 1.11, **17×17 0.54**. Every 17×17 node is within
   0.85 px of the true surface, including six inside a projector shadow. Input
   must go through `rejectOutliers` first. Still to do: a UI to pick the
   content rectangle in the camera view, and applying the fit (`setGrid` +
   points, or `deserialize`) plus the scan's valid mask as the object mask.
5. ✅ (maths) `bake(obj, ref)` → relief, normals (y-up), edges RGBA8 [valid,
   silhouette, step, crease], signed distance to the outline, distance to any
   edge. Packed as above. Still to do: expose them as new SOURCE_DEFS entries
   and in the Live GLSL preamble, and store scans in IndexedDB. The scan slot
   is a `global` param, because the stored scans are per-origin.
6. Optional: Gray + phase-shift hybrid for sub-pixel precision; monocular ML
   depth registered through the scan.

## Known limits

- Strong interreflection (bounced light brighter than direct) cannot be
  decoded with Gray codes. The robust rule **drops** such regions rather than
  guessing. Micro phase shifting is the published fix.
- `sepBits` (default 2,3 → 8/16 px stripes) must be resolvable by the camera.
  If they are not, coverage collapses; codes do not go wrong. Auto-selecting
  them from the captured contrast is an open item.
