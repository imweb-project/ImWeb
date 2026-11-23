# Organic creatures for ImWeb: brainstorm handoff

Brainstorm session in Claude chat, 2026-11-22. This is input for a planning session, not a spec.

## The idea

Non-human 3D organic lifeforms with their own skeletons. Each creature has a built-in movement library of **54 loopable segments that together make one continuous whole**. Users can interact with them. The human mocap behind the existing 2D figures is a separate thing and may be added later as a modulation layer.

## Decided by Haraldur

- 3D, not 2D.
- Each creature has its own built-in movements, independent of human mocap.
- 54 loopable segments of one whole.
- Mocap comes later, as an addition.
- Keep all four visual directions from the reference images:
  - liquid metal / blobs
  - lace / perforation
  - cloned arrays (fins, membrane)
  - glass strands

## Proposed model (from the session; challenge it in planning)

**Skeleton = motion, skin = look.** One rig can wear different skins:

- smooth formula surfaces (superformula, harmonics, log-spiral shell)
- Worley lace through `discard`
- instanced fins along limbs
- SDF chrome

**State-space choreography:**

- Each creature has a state vector of roughly 20–40 params: gait, amplitudes, phase lags, active limbs, body shape.
- The whole is a closed path through 54 waypoints.
- A segment is one waypoint held while its oscillators keep running, so it loops seamlessly.
- A transition interpolates the state across one loop cycle. That allows any-to-any jumps as well as playing in order.

**Seamless loop rules:**

- One global phase clock.
- All frequencies are integer harmonics of the base loop length.
- Frequencies change only at loop boundaries. Amplitudes and weights can change at any time.
- Loop-safe noise: sample noise along a circle in noise space.
- Springs and secondary motion are OK. Under periodic forcing they converge to a periodic motion after a short warm-up.

**Variety:**

- Central pattern generators (coupled oscillators). Changing the coupling changes the gait qualitatively: synchronous pulse, travelling wave, alternating, rotary.
- One possible grid: 6 gaits x 3 energy levels (rest / active / agitated) x 3 body states (contracted / neutral / bloomed) = 54.
- Group movements by function so the user has a grammar: getting around, reacting, resting, display.

**Tool roles:**

- Body and skin can come from Blender or C4D (optional).
- Skeleton and motion are procedural in code.
- glTF `SkinnedMesh` / `AnimationMixer` only if hand-authored clips are ever needed.
- C4D XPresso is a useful mental model only: the user-data panel works as a prototype of ImWeb's `ParameterSystem`.

## Riskiest assumptions

1. Procedural primitives have enough character, so the 54 segments don't feel like "the same creature at a different speed".
2. The 54 segments read as one creature's life with an arc. The order of the waypoints is the choreography, and that is an artistic decision.
3. Performance: a skinned creature plus a skin shader holds 60 fps on the Intel MacBook Pro's integrated GPU.

## Open questions for the planning session

- Who is the user: a performer on MIDI or controllers, or a gallery visitor (the creature reacts on its own)? Not answered yet; it changes the control design.
- Where does a creature live in ImWeb? A new `src/scene3d/` object next to `HypercubeObject` / `HypercubeInstancer`? How does its render reach the pipeline (a source slot)? The invariant applies: source-slot lists are append-only.
- Parameters: how many to expose? Registration uses `ps.register({id:...})`, single-object form only.
- Segment triggering: ClipLibrary is 8 banks x 16 slots on MIDI notes. 54 doesn't fit that grid; 48 or 64 would.
- Does ImWeb load glTF or `SkinnedMesh` today? Not checked.
- Skin approach: per-frame CPU tube rebuild (as in the prototype) vs bone matrices or a curve texture on the GPU (better at 60 fps).
- Later: the mocap modulation interface (e.g. mocap breathing drives the bell pulse).

## Prototype

`creature-prototype.html` in this folder is a standalone version of the chat prototype. It loads Three.js r128 from a CDN, so open it in a browser.

- Four skeleton types: starfish (radial), jellyfish (radial with a bell), tentacles (chains), ring (closed).
- Bones use forward kinematics: per bone `pitch, yaw += A * sin(2*pi*h*t/T - k*i)`.
- Skin is a tapered tube with a parallel-transport frame.
- It is a sketch, not production code. The tubes are rebuilt on the CPU every frame.

## Suggested next step

Build one creature (the jellyfish, which has the most parts to vary) as a standalone prototype before touching ImWeb:

- the 6 x 3 x 3 state grid
- a 54-segment navigator: play the whole in order, loop one segment, jump between segments

It tests riskiest assumptions 1 and 2 cheaply.

## Parked

- Raymarched SDF metaball creatures in a pure fragment shader. The topology changes every frame, so a mesh pipeline can't carry them.
- The morph-between-families idea: shared grid topology makes any shape a morph target of any other.
- Glass / transmission materials: expensive on an integrated GPU. A chrome matcap is cheap.

---

## Prompt for Claude Code (plan mode, no edits)

```
PLAN MODE: no file edits in this session.

Context: read creature-brainstorm-handoff.md and creature-prototype.html
(from ~/Claude/Projects/ImWeb/). We are planning procedural 3D creatures
for ImWeb: own skeletons, 54 loopable movement segments forming one whole.

BEFORE (recon in ~/Documents/GitHub/ImWeb, report findings with file:line):
1. How 3D objects are built and fed into the pipeline: src/scene3d/SceneManager.js,
   HypercubeObject.js, HypercubeInstancer.js, HypercubeUI.js. How does a 3D
   scene become a source slot?
2. ParameterSystem registration pattern and how 3D object params are
   exposed and serialized (Preset.js, ProjectFile.js).
3. ClipLibrary MIDI note mapping: could the same bank/slot model trigger
   creature movement segments?
4. grep for GLTFLoader, SkinnedMesh, AnimationMixer, InstancedMesh, morphTarget.
5. Current 60fps budget: where is per-frame CPU work done for 3D objects?

TASK: propose 2-3 architecture options for a CreatureObject (procedural
skeleton + state-space choreography + swappable skins), with trade-offs
for performance on the Intel iGPU, fit with existing invariants, and the
size of a first standalone prototype vs in-app integration.

ACCEPTANCE: a written plan with recon evidence, options, a recommendation,
and open questions for me. No code changes.
```
