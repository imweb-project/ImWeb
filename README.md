# ImWeb

**A browser-based reimagining of Tom Demeyer's Image/ine video synthesis instrument (STEIM, Amsterdam)**

Real-time video compositing, 3D scene integration, and a complete parameter/controller mapping system — all in a Progressive Web App.

---

## Quick Start

```bash
npm install
npm run dev
# → open http://localhost:3000
```

Requires Chrome 113+ (for WebGPU detection and best WebGL performance).  
Works on Firefox and Safari in WebGL mode with minor limitations.

---

## What This Is

Image/ine was a real-time video synthesis environment created by Tom Demeyer at STEIM Amsterdam. It ran on Mac OS 9 (1997) and later OS X (2008). ImWeb is a ground-up reimplementation for the modern browser, restoring features lost between versions and adding a full 3D scene pipeline.

**Signal path:**
```
INPUT SOURCES
  Camera · Movie · Stills Buffer · Color · Noise
  3D Scene · Draw · Output (feedback)
        ↓ assigned to ↓
  Foreground | Background | DisplaceSrc
        ↓ effects chain ↓
  TransferMode → Displacement → WarpMap → Keyer → Blend → ColorShift → Interlace → Fade
        ↓
  Output canvas → fullscreen / capture / record
```

---

## Controls

| Key | Action |
|-----|--------|
| `V` | Toggle camera on/off |
| `K` | Toggle keyer |
| `B` | Toggle blend (motion persistence) |
| `S` | Solo (bypass all effects) |
| `C` | Capture frame to buffer |
| `M` | Toggle movie playback |
| `0–9` | Recall Display States 0–9 |
| `Cmd/Ctrl+F` | Fullscreen output |
| `NumPad +/-` | Next / previous preset |

**Right-click any parameter** to assign a controller:  
Mouse X/Y · MIDI CC · LFO (4 waveforms) · Sound level · Random · Fixed value · Key

---

## Architecture

```
src/
  main.js                 Application bootstrap + render loop
  style.css               Dark performance UI

  controls/
    ParameterSystem.js    All controllable parameters + reactivity
    ControllerManager.js  Mouse, MIDI, LFO, Sound, Key, Random drivers
    LFO.js                Sine / Triangle / Sawtooth / Square oscillators

  core/
    Pipeline.js           WebGL render-target compositing chain

  shaders/
    index.js              All GLSL effect shaders (keyer, displace, warp,
                          transfermode, colorshift, interlace, noise, blend…)

  inputs/
    CameraInput.js        WebRTC getUserMedia → VideoTexture

  scene3d/
    SceneManager.js       Three.js 3D scene → RenderTarget → compositing input
    GeometryFactory.js    All procedural geometry generators

  state/
    Preset.js             Presets + Display States, persisted to IndexedDB

  ui/
    UI.js                 Parameter rows, tabs, state dots, signal path,
                          context menu, feedback overlay
```

---

## Features

### Phase 1 (this build — v0.1)
- [x] Full parameter system with reactive updates
- [x] Controller mapping: Mouse X/Y, MIDI CC, LFO ×4, Sound, Random, Fixed, Key
- [x] Luminance keyer (KeyLevelWhite, KeyLevelBlack, KeySoftness)
- [x] Displacement (amount, angle, offset, RotateGrey)
- [x] Blend (frame persistence / motion blur)
- [x] Feedback (HorOffset, VerOffset, Scale)
- [x] TransferMode (Copy, XOR, OR, AND)
- [x] ColorShift, Interlace, Fade, Mirror
- [x] Camera input (WebRTC)
- [x] Color source (HSV solid)
- [x] Noise source (pixel)
- [x] 3D scene as input source (all geometry, transforms, material, camera)
- [x] Model import: GLTF/GLB, OBJ, STL
- [x] Presets + Display States (128 per preset, IndexedDB)
- [x] WebM recording
- [x] Fullscreen output mode

### Phase 2 (next — v0.2)
- [ ] Movie clip playback with speed/position/loop control
- [ ] Stills buffer (16 frames, FrameSelect 1/2/3)
- [ ] ExtKey mode
- [ ] OSC via WebSocket bridge
- [ ] HID / Gamepad API
- [ ] Wacom pressure support

### Phase 3 (v0.3 — full ImOs9 restoration)
- [ ] WarpMode editor (32 storable warp maps, Wave V/H/Randomize)
- [ ] Draw layer (DrawX/Y, pensize, erase, LFO-drawn strokes)
- [ ] Tables (16,384-point response curve editor)
- [ ] External Mapping (controller-of-controller, FM-style)
- [ ] Text layer with scripting language
- [ ] rand1/rand2/rand3 noise sources (pixel, horizontal, vertical)
- [ ] MidiSync / AutoSync (frame rate locked to MIDI clock)
- [ ] Protected buffer zones

### Phase 4 (v0.4 — 3D depth + effects)
- [ ] Depth pass → DisplaceSrc (3D geometry distorts video)
- [ ] WarpMap on 3D UV coordinates
- [ ] 3D material: video texture from input sources
- [ ] Post-processing on 3D output (bloom, chromatic aberration)

### Phase 5 (v0.5)
- [ ] Second monitor output (BroadcastChannel API)
- [ ] PWA manifest + service worker
- [ ] `.imweb` project file format (save/load full state)
- [ ] Non-realtime capture (frame-by-frame export)

---

## OSC Bridge (Phase 2)

For OSC support, run the companion bridge locally:

```bash
# coming in Phase 2 — will be a ~30-line Deno script
deno run --allow-net osc-bridge.ts
```

Then connect your OSC controller to port 8080 (WS) or 57120 (UDP).

---

## WebGPU Upgrade Path

The current build uses Three.js WebGL render targets. Every shader pass is
isolated and labelled with `// WGSL:` comments where the WebGPU equivalent
differs. The upgrade to a native WebGPU pipeline (GPURenderPipeline + WGSL)
is Phase 2–3 work and drops in as a renderer swap — the parameter system,
controller system, and UI are all renderer-agnostic.

---

## Credits

Original Image/ine software: **Tom Demeyer**, STEIM Foundation, Amsterdam  
ImOs9 manual: Sher Doruff  
ImWeb: H. Karlsson

This project is a personal reimplementation and artistic continuation.  
It is not affiliated with or endorsed by STEIM.
