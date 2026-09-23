/**
 * ImWeb UI
 * Builds parameter rows, handles tabs, context menu, state dots, signal path.
 * Vanilla JS — no framework. Direct DOM manipulation for sub-ms response.
 */

import { PARAM_TYPE, SOURCES, SOURCE_DISPLAY_ORDER, SLEW_SHAPES,
  NOISE_TYPES, NOISE_FAMILY_TYPES } from '../controls/ParameterSystem.js';
import { recipeMenu, applyRecipe, captureRecipe, saveUserRecipe, deleteUserRecipe,
  NOISE_RECIPES, loadUserRecipes } from '../inputs/NoiseRecipes.js';
import { XMAP_HZ_MIN, XMAP_HZ_MAX } from '../controls/ControllerManager.js';
import { DEFAULT_FX_ORDER } from '../core/Pipeline.js';
import { PROVIDERS } from '../ai/AIFeatures.js';
import { ResponseCurve } from '../state/TableManager.js';
import { ColorPicker } from './ColorPicker.js';
import { mkSelect as _mkSelect } from './components/Select.js';
import { openCtrlPopover as _openCtrlPopover } from './components/CtrlPopover.js';
import { buildParamRow } from './components/ParamRow.js';
import { openGuide } from './Guide.js';
import { setViewportPos } from './layout/LayoutManager.js';
const DEFAULT_FX_ORDER_SP = DEFAULT_FX_ORDER;

// ── Tab switching ──────────────────────────────────────────────────────────────
// initTabs extracted to layout/LayoutManager.js (Phase 2 Task 5);
// re-exported here so the main.js import block is unchanged.
export { initTabs } from './layout/LayoutManager.js';

// ── ParamRow builder ──────────────────────────────────────────────────────────

// buildParamRow extracted to components/ParamRow.js (Phase 2 Task 4);
// re-exported here so main.js and internal call sites are unchanged.
export { buildParamRow };

// ── Layer source button matrix ────────────────────────────────────────────────

// SOURCE_ABBREV removed (Phase 23 Step 1): 13 entries against a 27-entry
// source list, mis-ordered from index 4 onward, and referenced by nothing.
// Source labels come from the SELECT options (ParameterSystem SOURCES).

/**
 * Builds the FG / BG / DS source-selector rows in #layer-params.
 * Each row: a label + one button per source option.
 * Clicking a button sets the param immediately.
 * Buttons stay in sync when the param is driven by a controller.
 * Right-click on any button or label opens the controller context menu.
 */
export function buildLayerButtons(ps, contextMenu) {
  const el = document.getElementById('layer-params');
  if (!el) return;
  el.innerHTML = '';

  // Column captions. The two selects on a layer row are different kinds of
  // thing and used to sit unlabelled side by side, which read as "Background
  // also has a blend mode" — it does not; layer.bg.blend is a SELF-process
  // (Pipeline passes the BG as both uFG and uBG), a tone treatment of one
  // picture rather than a meeting of two. A caption row costs one line for both
  // layers, where a label per select cost a whole row each.
  const head = document.createElement('div');
  head.className = 'param-row layer-col-head';
  // Distinct classes, not :nth-of-type — that counts every <span> in the row,
  // so .param-label is the first one and the captions land a column too far
  // right (they rendered as a single "SOURCEBLEND" over the blend column).
  head.innerHTML =
    '<span class="param-label"></span>' +
    '<span class="layer-col layer-col-source">SOURCE</span>' +
    '<span class="layer-col layer-col-blend">BLEND</span>';
  el.appendChild(head);

  [
    { param: ps.get('layer.fg'), label: 'Foreground', blendParam: ps.get('layer.fg.blend'),
      amtParam: ps.get('layer.fg.blendAmount') },
    { param: ps.get('layer.bg'), label: 'Background', blendParam: ps.get('layer.bg.blend'),
      amtParam: ps.get('layer.bg.blendAmount') },
    { param: ps.get('layer.ds'), label: 'DisplaceSrc' },
  ].forEach(({ param, label, blendParam, amtParam }) => {
    const row = document.createElement('div');
    row.className = 'param-row';
    // Hand-built row: claim the param id the way buildParamRow does, or the `/`
    // search's ⌖ and the guided tour both fail to find the three most-used
    // rows in the instrument.
    row.dataset.paramId = param.id;

    const lbl = document.createElement('span');
    lbl.className = 'param-label';
    lbl.textContent = label;
    lbl.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu?.show(param, e.clientX, e.clientY);
    });
    row.appendChild(lbl);

    // Identity check, not a name test: every source dropdown is registered
    // with the SOURCES array itself, so this reorders exactly those and
    // leaves every other SELECT alone. Values stay true indices.
    const sel = _mkSelect(
      param.options ?? [],
      param.value,
      i => { param.value = i; },
      'source-select',
      param.options === SOURCES ? SOURCE_DISPLAY_ORDER : null
    );
    sel.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu?.show(param, e.clientX, e.clientY);
    });
    param.onChange(v => { sel.value = Math.round(v); });
    row.appendChild(sel);

    // Blend mode rides the layer's own row, under the BLEND caption.
    if (blendParam) {
      const bsel = _mkSelect(
        blendParam.options ?? [],
        Math.round(blendParam.value),
        i => { ps.set(blendParam.id, i); },
        'blend-select'
      );
      // The caption says BLEND for both columns, which is exact for FG and
      // shorthand for BG — the tooltip carries the distinction the column
      // header cannot, and the amount row below spells it out (Self-proc Amt).
      bsel.title = blendParam.label;
      // Shares a row that carries a DIFFERENT param id, so it must claim its
      // own or the `/` search's ⌖ and the guided tour cannot find it. Fine:
      // reveal scrolls to whatever element it matches, and no
      // `.param-row[data-param-id]` query can match this <div>.
      bsel.dataset.paramId = blendParam.id;
      bsel.addEventListener('contextmenu', e => {
        e.preventDefault();
        contextMenu?.show(blendParam, e.clientX, e.clientY);
      });
      blendParam.onChange(v => { bsel.value = Math.round(v); });
      row.appendChild(bsel);
    }

    el.appendChild(row);

    // The blend mode and its amount are one idea — "how these two layers meet,
    // and how much" — so the amount follows its layer here rather than sitting
    // in Layer Color two sections away, where the guided tour's Principle 1
    // pointed at a control that was not on screen. Its own row, not appended to
    // the selector row: it is a slider and wants the full width.
    //
    // Group stays 'fg'/'bg'. The group is what Display States capture and what
    // every saved .imweb/.imstate keys on, so it is deliberately NOT changed to
    // 'layers' to match the new location — that would be a persistence change
    // dressed up as a layout one.
    if (amtParam) el.appendChild(buildParamRow(amtParam, contextMenu));
  });
}

// ── Populate mapping panels ───────────────────────────────────────────────────

export function buildMappingPanels(ps, contextMenu) {
  /**
   * Named params in a stated order, for panels split out of one group.
   *
   * getGroup() returns registration order, which is the order the engine happens
   * to declare things in — fine for a short panel, wrong once a group is sliced
   * into sections that each want their own reading order. Listing the ids also
   * makes a section a deliberate set: a newly registered param does NOT appear
   * anywhere until it is placed, rather than silently landing in whichever
   * section's filter it happens to match.
   */
  const pick = (prefix, keys) => keys.map(k => ps.get(`${prefix}.${k}`)).filter(Boolean);

  const sections = {
    // Camera device select lives with the mirror rows (Layers section);
    // its options are filled after device enumeration in main.js
    'mirror-params':   [ps.get('camera.device'), ...ps.getGroup('mirror')].filter(Boolean),
    'keyer-params':    ps.getGroup('keyer'),
    'displace-params': ps.getGroup('displace').filter(p => !p.id.startsWith('displace.warp')),
    // WarpDrawX/Y/Fade sit with the map editor they drive. They are named
    // displace.warp* so the filter above already excludes them from the
    // generic Displacement panel — no second exclusion list to keep in sync.
    // Rule, not a list: any displace.warp* param except the editor's own
    // WarpMode/WarpAmt belongs here. An explicit id list silently dropped the
    // four params added after it, which is exactly what it was meant to avoid.
    // ...plus displace.warpSlot, appended by id because it is the one warp
    // param NOT in the displace group: it is group 'global' so Display States
    // cannot capture it (slot contents live in per-origin localStorage, so a
    // captured index would recall a different map elsewhere). The rule still
    // governs everything else — this is a stated exception, not a return to
    // the explicit id list that used to drop newly added params.
    'warp-draw-params': [
      ...ps.getGroup('displace').filter(p =>
        p.id.startsWith('displace.warp') && p.id !== 'displace.warp' && p.id !== 'displace.warpamt'),
      ps.get('displace.warpSlot'),
    ].filter(Boolean),
    // output.interlace is excluded by ID, not by rule: it is group 'blend' for
    // persistence, but it is now _FX.interlace — a node in the reorderable
    // chain — so its row belongs with the other effects. Same shape as the
    // displace.warpSlot exception below: a stated exception, appended by id to
    // the section it actually belongs to, not a return to hand-listing.
    'blend-params':    ps.getGroup('blend').filter(p => p.id !== 'output.interlace'),
    'color-params':    ps.getGroup('color'),
    // noise-params-top and noise-params are built by buildNoisePanel()
    'output-params':   ps.getGroup('output').filter(p => p.id !== 'output.resolution' && p.id !== 'output.interp'),
    'buffer-controls': ps.getGroup('buffer'),
    // ...plus each deck's cueSlot/cueStore, appended by id for the same stated
    // reason as displace.warpSlot: they are group 'global' only so Display
    // States cannot capture them (see MovieCues.js), but they belong to the
    // deck, not to the Global panel.
    'clip-params':     [...ps.getGroup('movie'),
      ps.get('movie.len'), ps.get('movie.cueSlot'), ps.get('movie.cueStore')].filter(Boolean),
    'clipB-params':    [...ps.getGroup('movieB'),
      ps.get('movieB.len'), ps.get('movieB.cueSlot'), ps.get('movieB.cueStore')].filter(Boolean),
    'mix-params':      ps.getGroup('mix'),
    'mix2-params':     ps.getGroup('mix2'),
    'mix3-params':     ps.getGroup('mix3'),
    // Phase 24: BG1/BG2 are routable sources (indices 9/10) that had no UI at
    // all — screen.bg1/bg2 are TRIGGERs in group 'screen', which was mapped
    // nowhere. Split one per panel so each BG source owns its own capture
    // trigger. (Sound, the third source without a panel, has no parameters —
    // its Audio In device row is injected from main.js instead.)
    'bg1-params':      [ps.get('screen.bg1')].filter(Boolean),
    'bg2-params':      [ps.get('screen.bg2')].filter(Boolean),
    // NOTE: 'transform-params' is deliberately NOT listed here. It is built
    // explicitly further down this file (the Screen XY toggle, the world-units
    // hint, then a fixed order), and a container filled by both writers renders
    // every row twice. The substring filter this replaced was wrong twice over:
    // it duplicated the whole section, and `id.includes('scale')` also swept in
    // scene3d.clone.scale, clone.scalestep and blob.scale, so CloneScale,
    // ScaleStep and Metaball Scale appeared under Transform as well as under
    // the sections they belong to.
    'camera3d-params': ps.getGroup('scene3d').filter(p => p.id.includes('cam')),
    'material-params': ps.getGroup('scene3d').filter(p => p.id.includes('mat') || p.id.includes('wire') || p.id.includes('depth')),
    'lights-params':   ps.getGroup('lights3d'),
    'draw-params':     ps.getGroup('draw'),
    // Text — one group across four subsections, the same treatment Effects
    // gets. 39 rows in registration order mixed typography, colour, sequencing
    // and transition in one list; the sections are what make it readable.
    // These are pick() lists, so tests/audit-panel-coverage.mjs fails the
    // build if a text.* param lands in no section, in two, or under a dead
    // name — which is what makes it safe to slice the group this way.
    'text-type-params':       pick('text', ['res', 'font', 'weight', 'italic',
                                            'size', 'spacing', 'letterspacing',
                                            'align', 'rotation', 'x', 'y']),
    'text-color-params':      pick('text', ['hue', 'sat', 'opacity',
                                            'outline', 'outlineHue', 'outlineSat',
                                            'shadowBlur', 'shadowX', 'shadowY',
                                            'bg', 'bgOpacity']),
    // Sequencing (which unit is showing, and what steps it) sits with the
    // continuous animation it drives — advancing IS the motion here.
    'text-motion-params':     pick('text', ['mode', 'advance', 'contentIdx',
                                            'progress', 'autoplay', 'rate', 'auto',
                                            'animMode', 'animSpeed', 'animAmt',
                                            'glitchSet',
                                            'scrollX', 'scrollY', 'scrollGap']),
    'text-audio-params':      pick('text', ['audioTarget', 'audioBand',
                                            'audioLo', 'audioHi',
                                            'audioGain', 'audioFocus',
                                            'audioAmt', 'audioSmooth']),
    'text-path-params':       pick('text', ['path', 'pathRadius', 'pathAngle',
                                            'pathSpread', 'pathWidth', 'pathTwist',
                                            'pathUpright', 'pathFlip']),
    'text-transition-params': pick('text', ['anim.in', 'anim.out', 'anim.dur',
                                            'anim.ease', 'stagger', 'staggerFrom']),
    // layer.*.blendAmount is excluded by ID, the same stated exception the
    // output.interlace row above uses: it stays group 'fg'/'bg' for persistence
    // but its row is built by buildLayerButtons() beside the blend mode it
    // scales. Without this filter it renders in both places, and revealParam()
    // takes the first match — so the guided tour would scroll to whichever copy
    // happened to be earlier in the DOM.
    'fg-params':       ps.getGroup('fg').filter(p => p.id !== 'layer.fg.blendAmount'),
    'bg-params':       ps.getGroup('bg').filter(p => p.id !== 'layer.bg.blendAmount'),
    // Effects — one group across five SUBsections of a single panel section,
    // the same treatment Metaballs and Rutt-Etra get. 29 rows in registration
    // order mixed geometry, colour, texture and timing in one flat list; the
    // sections are what make it readable, and the reading order inside each is
    // deliberate (the effect, then the controls that shape it).
    //
    // These are pick() lists, so tests/audit-panel-coverage.mjs fails the build
    // if an effect.* param lands in no section, in two, or under a dead name —
    // which is the whole reason it is safe to slice a group this way.
    // Master row first — the bypass and the reset belong above the thing they
    // act on, not buried in whichever subsection would otherwise claim them.
    'effect-master-params':  pick('effect', ['enable', 'clearall']),
    'effect-geo-params':     pick('effect', ['pixelate', 'kaleidoscope', 'kalerot',
                                             'kalecx', 'kalecy', 'kaleedge',
                                             'quadmirror', 'flip',
                                             'polar', 'polarmode', 'polarrot',
                                             'wavex', 'wavey', 'wavefx', 'wavefy',
                                             'wavephase',
                                             'lens', 'twirl',
                                             // shared by Polar / Wave / Lens
                                             'warpcx', 'warpcy', 'warpedge']),
    'effect-optics-params':  pick('effect', ['edge', 'edge_inv', 'edge_color',
                                             'rgbshift', 'rgbangle',
                                             'sharpen',
                                             'bloom', 'bloomthresh', 'bloomradius',
                                             'bokeh', 'bokehmask', 'bokehradius',
                                             'bokehfocus', 'bokehfeather',
                                             'bokehsmooth',
                                             'bokehblades', 'bokehrotate', 'bokehring',
                                             'bokehhighlight', 'bokehthresh',
                                             'bokehdiscs',
                                             'bokehquality',
                                             'vignette', 'vigradius', 'vigcx', 'vigcy',
                                             'vighue', 'vigtint']),
    'effect-quant-params':   pick('effect', ['posterize', 'solarize', 'solarsoft',
                                             'halftone', 'halfsize', 'halfangle',
                                             'halfmode',
                                             'duotone', 'duohue1', 'duohue2',
                                             'outhue', 'outsat', 'outbright']),
    'effect-texture-params': [
      ...pick('effect', ['grain', 'scanlines', 'scancount']),
      ps.get('output.interlace'),
      ...pick('effect', ['pixelsort', 'psortlen', 'psortthresh', 'psortdir', 'psortmode']),
    ].filter(Boolean),
    'effect-time-params':    pick('effect', ['strobe', 'stroberate', 'strobeduty']),
    // Colour grade — moved out of the Effects list into the section named for it.
    'grade-levels-params':   pick('effect', ['lvblack', 'lvwhite', 'lvgamma']),
    'grade-wb-params':       pick('effect', ['wbtemp', 'wbtint']),
    // glsl.preset is global-group only to escape state capture — its row
    // (badge + dropdown) lives in the GLSL panel, built in main.js
    // Excluded: params that are group 'global' only to dodge Display State
    // capture, and that already have a home in their own feature panel. They
    // are 'global' for persistence reasons, not because they belong here.
    // The four corner positions. #projmap-params has been in index.html all
    // along with nothing building into it, so the only way to set a corner was
    // to drag its handle in the output window — no typed values, no readout of
    // where a corner actually is, and no way to map one to a controller.
    // projmap.active is left out: it already has its own toolbar button
    // (#btn-projmap) right beside this container.
    // projmap.edit is group 'global' (a view state, uncapturable) but belongs
    // HERE beside the corners, not in the auto-built global list — so it is
    // appended by id, the same stated exception glsl.preset and warpSlot use.
    'projmap-params':      ps.getGroup('projmap').filter(p => p.id !== 'projmap.active')
                             .concat(['projmap.edit','projmap.grid','projmap.meshSlot','projmap.meshStore','projmap.meshAllHandles','projmap.meshHandlesClear']
                               .map(id => ps.get(id)).filter(Boolean)),
    'global-params':       ps.getGroup('global').filter(p =>
      p.id !== 'glsl.preset' && p.id !== 'displace.warpSlot' &&
      p.id !== 'noise.recipe' &&
      p.id !== 'projmap.edit' && p.id !== 'projmap.grid' &&
      p.id !== 'projmap.meshSlot' && p.id !== 'projmap.meshStore' &&
      p.id !== 'projmap.meshHandlesClear' && p.id !== 'projmap.meshAllHandles' &&
      // The MIDI mapping-page controls. 'global' so Display States cannot
      // capture them, but they belong beside the monitor in Sources > I/O:
      // binding TRACK -/+ means clicking these rows, and a control you have to
      // hunt for on another tab is missing from the instruction even when it is
      // present in the app (LEARNED 2026-09-03).
      !/^midi\.(page|pagePrev|pageNext|pickup|slew)$/.test(p.id) &&
      !/^movieB?\.(cue(Slot|Store)|len)$/.test(p.id)),
    // particle-params rendered separately below (legacy + v2 split)
    // 'particle-params': ps.getGroup('particle'),
    // Metaballs — one group across six SUBsections of a single panel section,
    // the same treatment Rutt-Etra gets below and for the same reason: 25 rows
    // is unreadable as one list, but it is one source and belongs behind one
    // accordion entry. tests/audit-panel-coverage.mjs picks these up
    // automatically (it scans for pick() calls) and fails if a sdf.* param ends
    // up in no section, in two, or under a name that no longer exists.
    'sdf-shape-params':    pick('sdf', ['active', 'shape', 'shapeB', 'count', 'size',
                                        'opMode', 'opAmount', 'distance', 'speed']),
    // "Space", not "Fold": the section holds domain repetition and surface
    // warp as well as the kaleidoscopic fold, and Fold named only one of three.
    'sdf-space-params':    pick('sdf', ['tile', 'repeat', 'kifsIter', 'kifsAngle',
                                        'kifsScale', 'kifsOffset', 'warp']),
    'sdf-camera-params':   pick('sdf', ['orbitX', 'orbitY', 'camDist',
                                        'moveX', 'moveY', 'moveZ', 'fov']),
    'sdf-material-params': pick('sdf', ['hue', 'sat', 'val', 'ao']),
    'sdf-light-params':    pick('sdf', ['lightAz', 'lightEl']),
    'sdf-glow-params':     pick('sdf', ['glow', 'glowHue', 'glowSat', 'glowVal',
                                        'glowHue2', 'glowSat2', 'glowVal2',
                                        'glowSize', 'glowEnv']),
    'sdf-glass-params':    pick('sdf', ['refract', 'fresnel', 'envAmt', 'selfReflect',
                                        'reflectAmt', 'reflectRange', 'reflectDetail',
                                        'refractSrc']),
    'sdf-video-params':    pick('sdf', ['texSrc', 'texBlend', 'lumaWarp', 'lumaThresh']),
    // Detail and Steps buy sharpness and reach, NOT frame rate — measured, the
    // raymarcher is ~0.3ms of an 18.8ms frame. Kept in their own subsection so
    // they are not mistaken for a look control.
    'sdf-quality-params':  pick('sdf', ['rscale', 'steps', 'depthRange']),
    // Rutt-Etra is one group across four SUBsections of a single panel section
    // (the Warp section's shape) — 19 rows is too long a single list to read,
    // but it is one source and belongs behind one accordion entry. Per the
    // Phase 23 design this needs no ordering or labelling code, only container
    // ids; the nesting lives entirely in index.html.
    // tests/audit-panel-coverage.mjs enforces that every rutt.* param is placed
    // in exactly one of these, since an unplaced one would vanish silently.
    'rutt-scan-params':     pick('rutt', ['active', 'source', 'shape', 'drawMode',
                                          'lines', 'thickness', 'pointSize']),
    'rutt-depth-params':    pick('rutt', ['zgain', 'zcurve', 'zpivot', 'rise', 'fall']),
    'rutt-camera-params':   pick('rutt', ['angle', 'elev', 'dist',
                                          'moveX', 'moveY', 'moveZ']),
    'rutt-phosphor-params': pick('rutt', ['hue', 'sat', 'colorAmt', 'decay', 'bleed']),
    'delay-params':        ps.getGroup('delay'),
    'rgbdelay-params':     ps.getGroup('rgbdelay'),
    'motion-params':       ps.getGroup('motion'),
    'tdisp-params':        ps.getGroup('td'),
    'vectorscope-params':  ps.getGroup('vectorscope'),
    'slitscan-params':     ps.getGroup('slitscan'),
    // Warp Tape (Phase 24 Step 4) — source 22 is routable and its render path
    // is live, so it gets a panel. Still experimental.
    'vwarp-params':        ps.getGroup('vwarp'),
    // 'seq-params' is built by buildSeqParams() — skip here
    // 'layer-params' is owned by buildLayerButtons() — do not render here
    'lut-params':          ps.getGroup('lut'),
    'analog-source-params': ps.getGroup('analog').filter(p => p.id.includes('source') || p.id.includes('crop')),
    'analog-signal-params': ps.getGroup('analog').filter(p => p.id.includes('brightness') || p.id.includes('contrast') || p.id.includes('saturation') || p.id.includes('hue')),
    'analog-crt-params':    ps.getGroup('analog').filter(p => p.id.includes('.crt.')),
    'analog-composite-params': ps.getGroup('analog').filter(p => p.id.includes('.composite.')),
    'analog-rf-params':     ps.getGroup('analog').filter(p => p.id.includes('.rf.')),
    'analog-tuner-params':  ps.getGroup('analog').filter(p => p.id.includes('.tuner.')),

    // Audio. Engine params are deliberately split across two groups: 'global'
    // for anything that allocates, opens a device or relayouts, so a Display
    // State cannot recall it (see ParameterSystem's audio block for why each
    // one would be destructive).
    //
    // `pick()` is therefore reserved for real group members and the 'global'
    // ones are appended by id — the same stated exception warp-draw-params
    // makes for displace.warpSlot. This is not cosmetic: audit-panel-coverage
    // resolves pick(prefix, …) against ps.getGroup(prefix), so routing a
    // 'global' param through pick() reports it as "placed but not registered"
    // — and routing it through a TEMPLATE literal would hide it from that
    // audit entirely, which is worse than failing.
    'audio-engine-params': [
      ps.get('audio.enable'), ps.get('audio.tapeSec'), ps.get('audio.mic'),
      // Monitoring sits directly under Mic: they are the two halves of §8.6's
      // loop, and the answer to "is this dangerous" is only meaningful as a
      // pair. Group 'global', so it is listed explicitly rather than picked.
      ps.get('audio.monitor'),
      ...pick('audio', ['tapSrc', 'glide', 'outGain', 'limitThresh', 'limitRel']),
    ].filter(Boolean),
    'audio-partition-params': [0, 1, 2, 3].flatMap(i => [
      ps.get(`apart${i}.start`), ps.get(`apart${i}.len`),
    ]).filter(Boolean),
    'audio-rec-params':  pick('arec',  ['part', 'start', 'len', 'dynamic', 'unsafe', 'on']),
    // Level sits after Rate and before the two switches: signal order, same as
    // the Voice panel's "source → controls → level" note below — the fader is
    // the last thing the sound passes through, and Unsafe/Run are not chain
    // stages at all.
    // ...plus cueSlot/cueStore, appended by id for the same stated reason the
    // decks' are: they are group 'global', so pick() cannot reach them.
    'audio-play-params': [...pick('aplay', ['part', 'start', 'len', 'pos', 'rate', 'level', 'unsafe', 'on']),
      ps.get('aplay.cueSlot'), ps.get('aplay.cueStore')].filter(Boolean),
    // Signal order, not registration order: source → its own controls → filter
    // → saturator → level, so the row list reads as the chain it is.
    // The spectral writer (§4.5). Destination first, then the musical decision
    // (scale/root/rows), then how the picture is read, then the verb — which is
    // the order the act happens in. `aspec.render` is group 'global' so it
    // cannot be captured by a Display State, and is therefore listed explicitly
    // rather than through pick(), exactly as `audio.enable` is above.
    'audio-spec-params': [
      // `pan`/`panWidth` sit with gamma/floor/level — all four are "how the
      // picture is read", and pan is the one that reads a channel the others
      // throw away. Before the verb, because it changes what Render produces.
      ...pick('aspec', ['part', 'start', 'len', 'unsafe', 'scale', 'root', 'rows',
        'frames', 'gamma', 'floor', 'pan', 'panWidth', 'level']),
      ps.get('aspec.render'), ps.get('aspec.cancel'),
    ].filter(Boolean),
    // The corpus (§4.6). Axes first — they are what the pad above means — then
    // how it is measured, then the verbs. The analysis params and both triggers
    // are group 'global', so they are listed explicitly rather than through
    // pick(), exactly as `audio.enable` and `aspec.render` are.
    'audio-corpus-params': [
      ...pick('acorp', ['xAxis', 'yAxis', 'x', 'y']),
      ps.get('acorp.hop'), ps.get('acorp.window'),
      ps.get('acorp.analyse'), ps.get('acorp.cancel'),
    ].filter(Boolean),
    // `pos` sits next to `part`: it is a POSITION within that partition, and it
    // is the control an LFO gets attached to for time stretch.
    'audio-grain-params': pick('agrain', ['part', 'pos', 'on', 'size', 'rate',
      'pitch', 'spray', 'level', 'unsafe']),
    'audio-voice-params': pick('avoice', ['on', 'src', 'wave', 'pitch', 'fmRatio',
      'fmIndex', 'colour', 'cut', 'res', 'ftype', 'drive', 'level']),
  };

  Object.entries(sections).forEach(([elId, params]) => {
    const el = document.getElementById(elId);
    if (!el || !params.length) return;
    el.innerHTML = '';
    params.forEach(p => el.appendChild(buildParamRow(p, contextMenu)));
  });

  // ── Time Displace: per-mode Scan pos / Scan pos Y / Scan width visibility ──
  // Shear X/Y (0,1) and Noise (6) use neither; Warp Line/Shear Sym/Radial (2-5)
  // use Scan pos + Scan width; Radial (5) alone also uses Scan pos Y.
  // Keyed on mode INDEX, so the Slit→Shear relabel does not affect this.
  {
    const tdEl = document.getElementById('tdisp-params');
    const scanPosRow  = tdEl?.querySelector('[data-param-id="td.scanPosition"]');
    const scanPosYRow = tdEl?.querySelector('[data-param-id="td.scanPosY"]');
    const scanWidthRow = tdEl?.querySelector('[data-param-id="td.scanWidth"]');
    if (scanPosRow && scanPosYRow && scanWidthRow) {
      const SCAN_MODES = [2, 3, 4, 5];
      const RADIAL_MODE = 5;
      const modeParam = ps.get('td.mode');
      const refreshTdScanRows = () => {
        const showScan = SCAN_MODES.includes(modeParam.value);
        scanPosRow.style.display   = showScan ? '' : 'none';
        scanWidthRow.style.display = showScan ? '' : 'none';
        scanPosYRow.style.display  = modeParam.value === RADIAL_MODE ? '' : 'none';
      };
      refreshTdScanRows();
      modeParam.onChange(refreshTdScanRows);
    }
  }

  // ── Material: Clearcoat / Transmit / IOR exist only on Physical ───────────
  // MeshPhysicalMaterial extends MeshStandardMaterial and adds exactly these
  // three; SceneManager applies them under `if (matType === 1 &&
  // isMeshPhysicalMaterial)`. So on every other shader the sliders move, the
  // readouts count, and nothing renders differently — which is also why
  // Standard and Physical look identical until one of them is raised. Reported
  // as "I don't see any difference between Standard and Physical".
  //
  // Dimmed rather than hidden, and left interactive, for the reasons .param-na
  // documents in style.css.
  {
    const matEl = document.getElementById('material-params');
    const typeParam = ps.get('scene3d.mat.type');
    const PHYSICAL = 1;
    const physicalOnly = ['scene3d.mat.clearcoat', 'scene3d.mat.transmit', 'scene3d.mat.ior']
      .map(id => matEl?.querySelector(`[data-param-id="${id}"]`))
      .filter(Boolean);
    if (typeParam && physicalOnly.length) {
      const refreshPhysicalRows = () => {
        const na = typeParam.value !== PHYSICAL;
        for (const r of physicalOnly) {
          r.classList.toggle('param-na', na);
          if (na) r.title = 'Physical shader only — Clearcoat, Transmit and IOR are what Physical adds to Standard. Set Material Shader to Physical.';
          else    r.removeAttribute('title');
        }
      };
      refreshPhysicalRows();
      typeParam.onChange(refreshPhysicalRows);
    }
  }

  // ── Material: what Seamless mapping makes inapplicable ────────────────────
  // Disp. Projection (UV vs Screen) is read only in the UV branch of
  // getDisplacement — the triplanar branch never touches it. So whenever the
  // DISPLACE path resolves to Seamless the control moves and nothing happens,
  // which is how it was found: set to UV, doing nothing, on a seamless object.
  //
  // Blend Sharp is the mirror case: it only means something while Seamless is
  // in play, since it is the triplanar handover exponent.
  //
  // The resolution below mirrors SceneManager.applyParams, which is the source
  // of truth. It reads the same three params, so the two can only disagree if
  // that rule changes — and the cost of drift here is a wrong dim, not a wrong
  // render.
  {
    const matEl = document.getElementById('material-params');
    const mapping = ps.get('scene3d.mat.mapping');
    const texsrc  = ps.get('scene3d.mat.texsrc');
    const dispsrc = ps.get('scene3d.mat.dispsrc');
    const projRow  = matEl?.querySelector('[data-param-id="scene3d.mat.dispTexProj"]');
    const blendRow = matEl?.querySelector('[data-param-id="scene3d.mat.triblend"]');
    if (mapping && texsrc && projRow && blendRow) {
      const NOISE = 6, AUTO = 0, UV = 1, TRI = 2, DISPSRC_TEX_BASE = 2;
      const dispIsTriplanar = () => {
        const m = mapping.value;
        if (m === TRI) return true;
        if (m === UV)  return false;
        const sel = dispsrc?.value ?? 0;
        const idx = sel === 0 ? texsrc.value : sel === 1 ? -1 : sel - DISPSRC_TEX_BASE;
        return idx === NOISE;   // Auto
      };
      const refresh = () => {
        const projNa = dispIsTriplanar();
        projRow.classList.toggle('param-na', projNa);
        if (projNa) projRow.title = 'No effect while the displacement is Seamless — a triplanar projection has no UV to swap for a screen one. Set Mapping to UV.';
        else        projRow.removeAttribute('title');

        const blendNa = mapping.value === UV;
        blendRow.classList.toggle('param-na', blendNa);
        if (blendNa) blendRow.title = 'No effect while Mapping is UV — Blend Sharp is how sharply the three Seamless projections hand over.';
        else         blendRow.removeAttribute('title');
      };
      refresh();
      mapping.onChange(refresh);
      texsrc.onChange(refresh);
      dispsrc?.onChange(refresh);
    }
  }

  // ── Bokeh: Iris does nothing while Blades is Circle ───────────────────────
  // uIris is referenced in exactly one place in BOKEH_GATHER, inside
  // `if (uBlades >= 3.0)` — a circle is rotationally symmetric, so there is
  // genuinely nothing for a rotation to change. Without this the slider moves,
  // the readout counts to 360°, and the picture does not change, which reads as
  // a broken control rather than an inapplicable one. It was reported as one.
  //
  // Dimmed rather than hidden, and left interactive — see .param-na in
  // style.css for why.
  {
    const opticsEl = document.getElementById('effect-optics-params');
    const irisRow  = opticsEl?.querySelector('[data-param-id="effect.bokehrotate"]');
    const bladesParam = ps.get('effect.bokehblades');
    if (irisRow && bladesParam) {
      const CIRCLE = 0;
      const refreshBokehIrisRow = () => {
        const na = bladesParam.value === CIRCLE;
        irisRow.classList.toggle('param-na', na);
        if (na) irisRow.title = 'No effect while Bokeh.Blades is Circle — a circular iris has no orientation. Choose 5, 6 or 8 blades.';
        else    irisRow.removeAttribute('title');
      };
      refreshBokehIrisRow();
      bladesParam.onChange(refreshBokehIrisRow);
    }
  }

  // ── Particle panel: grouped by function ──────────────────────────────────────
  const allParticleP = ps.getGroup('particle');
  const _pById = Object.fromEntries(allParticleP.map(p => [p.id, p]));

  const particleEl = document.getElementById('particle-params');
  if (particleEl) {
    particleEl.innerHTML = '';

    const _sub = (label) => {
      const d = document.createElement('div');
      d.className = 'cp-sub-header';
      d.textContent = label;
      particleEl.appendChild(d);
    };
    const _row = (id) => {
      const p = _pById[id];
      if (p) particleEl.appendChild(buildParamRow(p, contextMenu));
    };

    // ── DISPLAY ──────────────────────────────────────────────────────────────
    _sub('DISPLAY');
    _row('particle.count');
    _row('particle.size');
    _row('particle.trailDecay');
    _row('particle.colorMode');

    // ── EMISSION ─────────────────────────────────────────────────────────────
    _sub('EMISSION');
    _row('particle.spread');
    _row('particle.emitter');
    _row('particle.emitx');
    _row('particle.emity');
    _row('particle.boundaryMode');

    // ── MASK SOURCE ───────────────────────────────────────────────────────────
    _sub('MASK SOURCE');
    _row('particle.masksrc');

    // ── SIMULATION ───────────────────────────────────────────────────────────
    _sub('SIMULATION');
    _row('particle.w.gradient');
    _row('particle.w.flow');
    _row('particle.w.nbody');
    _row('particle.w.ghost');
    _row('particle.fieldStrength');
    _row('particle.inertia');
    _row('particle.lifeDecay');

    // ── FLOW FORMULA ──────────────────────────────────────────────────────────
    _sub('FLOW FORMULA');
    _row('particle.flowFormula');
    _row('particle.lorenz.rho');
    _row('particle.lorenz.sigma');
    _row('particle.lorenz.beta');
    _row('particle.nbody.radius');
    _row('particle.nbody.falloff');
    _row('particle.nbody.mode');

    // ── POINTER ───────────────────────────────────────────────────────────────
    _sub('POINTER');
    _row('particle.ghost.strength');
    _row('particle.ghost.mode');
    _row('particle.ghost.radius');
    _row('particle.ghost.fadetime');

    // ── GHOST NODES ───────────────────────────────────────────────────────────
    _sub('GHOST NODES');
    for (let i = 1; i <= 3; i++) {
      ['on','x','y','mode','strength','radius'].forEach(k => _row(`particle.ng${i}.${k}`));
    }

    // ── ACTIONS ───────────────────────────────────────────────────────────────
    _sub('ACTIONS');
    _row('particle.respawn');
    _row('particle.freeze');
    _row('particle.clearPins');
  }
}

// ── Noise panel — family → type menu, then one section per stage ─────────────
// Sections follow the shader's order (coords → warp → basis/fractal → layer B
// → shape → colour). Each row carries a predicate over the current settings;
// a row that would do nothing for the chosen type is hidden, and a section
// whose rows are all hidden hides its header too.

export function buildNoisePanel(ps, contextMenu) {
  const noiseTop = document.getElementById('noise-params-top');
  const noiseBot = document.getElementById('noise-params');
  if (!noiseTop || !noiseBot) return;

  const v = (id) => ps.get(id).value;
  const T = {                                   // type-index predicates
    fractal:  t => t <= 8,                      // smooth + cells (Curl too)
    cells:    t => t >= 6 && t <= 8,
    grain:    t => t >= 15,
    periodic: t => t === 3 || t === 4,
    flow:     t => t === 4,
    curl:     t => t === 5,
  };
  const usesWidth = t => (T.cells(t) && v('noise.cellOut') === 2)
    || [9, 11, 12, 13, 14].includes(t) || T.grain(t);
  const usesDensity = t => t === 11 || t === 14 || t === 17;
  const usesJitter  = t => t === 6 || t === 11;

  // ── Recipe: a named combination, applied then fully editable ─────────────
  // The row is rebuilt when the user list changes (buildParamRow fixes its
  // option list at construction). Save stores the CURRENT settings under a
  // name; ✕ deletes the selected user recipe (built-ins cannot be deleted).
  const recipeP = ps.get('noise.recipe');
  let recipeKeys = [];
  const recipeWrap = document.createElement('div');
  recipeWrap.className = 'noise-recipe';
  const recipeBtns = document.createElement('div');
  recipeBtns.className = 'noise-recipe-btns';
  const mkBtn = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'import-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', fn);
    recipeBtns.appendChild(b);
    return b;
  };
  function syncRecipes(selectName) {
    const m = recipeMenu();
    recipeKeys = m.keys;
    recipeP.options = m.labels;
    recipeP.displayOrder = m.order;
    recipeP.optionHelp = m.help;
    const i = selectName ? m.keys.findIndex(k => k?.n === selectName) : -1;
    recipeP.value = i > 0 ? i : Math.min(recipeP.value, m.labels.length - 1);
    recipeWrap.querySelector('.param-row')?.remove();
    recipeWrap.prepend(buildParamRow(recipeP, contextMenu));
  }
  mkBtn('Save', 'Save the current noise settings as a recipe', () => {
    const cur = recipeKeys[recipeP.value];
    const name = prompt('Recipe name', cur?.user ? cur.n : '')?.trim();
    if (!name) return;
    if (NOISE_RECIPES[name]) { alert(`"${name}" is a built-in recipe — pick another name.`); return; }
    if (!saveUserRecipe(name, captureRecipe(ps))) { alert('Could not save the recipe (storage full or blocked).'); return; }
    syncRecipes(name);
  });
  mkBtn('✕', 'Delete the selected user recipe', () => {
    const cur = recipeKeys[recipeP.value];
    if (!cur?.user) return;
    if (!confirm(`Delete recipe "${cur.n}"?`)) return;
    deleteUserRecipe(cur.n);
    recipeP.value = 0;
    syncRecipes();
  });
  recipeWrap.appendChild(recipeBtns);
  noiseTop.appendChild(recipeWrap);
  recipeP.onChange(i => {
    const k = recipeKeys[i];
    if (!k) return;
    applyRecipe(ps, k.user ? loadUserRecipes()[k.n] : NOISE_RECIPES[k.n]);
  });
  syncRecipes();

  // ── Family → Type (two-level menu over one noise.type param) ─────────────
  noiseTop.appendChild(buildParamRow(ps.get('noise.family'), contextMenu));
  const typeRow = document.createElement('div');
  typeRow.className = 'param-row select-row';
  typeRow.dataset.paramId = 'noise.type';
  const typeLabel = document.createElement('span');
  typeLabel.className = 'param-label';
  typeLabel.textContent = 'Type';
  const typeCtrl = document.createElement('span');
  typeCtrl.className = 'param-ctrl';
  const typeValueEl = document.createElement('span');
  typeValueEl.className = 'param-value';
  typeRow.append(typeLabel, typeCtrl, typeValueEl);
  noiseTop.appendChild(typeRow);
  noiseTop.appendChild(buildParamRow(ps.get('noise.scale'), contextMenu));
  let typeSel = null;

  function renderTypeMenu() {
    const types = NOISE_FAMILY_TYPES[v('noise.family')] ?? NOISE_FAMILY_TYPES[0];
    const idx = Math.max(0, types.indexOf(v('noise.type')));
    // _mkSelect's option list is fixed at construction, so rebuild — destroy
    // the old instance (incl. its detached .imw-sel-menu) first.
    typeSel?._destroy();
    typeValueEl.innerHTML = '';
    typeSel = _mkSelect(types.map(i => NOISE_TYPES[i]), idx,
      i => ps.set('noise.type', types[i]), 'param-select');
    typeValueEl.appendChild(typeSel);
  }

  // ── Stage sections ────────────────────────────────────────────────────────
  const rows = [];                               // [el, visible()]
  const sections = [];                           // [el, rowEls]
  function section(title, spec) {
    const el = document.createElement('div');
    const hd = document.createElement('div');
    hd.className = 'cp-sub-header';
    hd.textContent = title;
    el.appendChild(hd);
    const mine = [];
    for (const [id, vis] of spec) {
      const r = typeof id === 'string' ? buildParamRow(ps.get(id), contextMenu) : id;
      el.appendChild(r);
      rows.push([r, vis ?? (() => true)]);
      mine.push(r);
    }
    noiseBot.appendChild(el);
    sections.push([el, mine]);
  }
  const notCurl = t => !T.curl(t);
  const fractalOn = t => T.fractal(t) && v('noise.fractal') !== 0;

  // Tile note: shown only when it has something to say — a type that
  // cannot tile, so the seam is explained rather than looking like a bug.
  const tileOn = () => !!v('noise.tile');
  const cantTile = t => t === 2 || t === 7;
  const tileNote = document.createElement('div');
  tileNote.className = 'noise-note';
  const tileNoteVis = t => {
    const bad = [cantTile(t) && NOISE_TYPES[t],
      v('noise.combine') !== 0 && cantTile(v('noise.b.type')) && `B ${NOISE_TYPES[v('noise.b.type')]}`]
      .filter(Boolean);
    tileNote.textContent = bad.length
      ? `${bad.join(' and ')} cannot tile (a slanted grid) — Perlin or Psrd can.` : '';
    return tileOn() && bad.length > 0;
  };
  section('TRANSFORM', [
    ['noise.tile', t => !T.grain(t)],
    [tileNote, tileNoteVis],
    ['noise.rotate', () => !tileOn()], ['noise.stretch', () => !tileOn()],
    ['noise.offsetX'], ['noise.offsetY'],
    ['noise.coords', t => !T.grain(t) && !tileOn()], ['noise.aspect', t => !T.grain(t) && !tileOn()],
  ]);
  section('MOTION', [
    ['noise.speed'], ['noise.driftX', t => !T.grain(t)], ['noise.driftY', t => !T.grain(t)],
    ['noise.seed'],
  ]);
  section('DETAIL', [
    ['noise.fractal',    t => T.fractal(t)],
    ['noise.octaves',    t => fractalOn(t) || T.flow(t)],
    ['noise.lacunarity', t => fractalOn(t) && !T.flow(t)],
    ['noise.gain',       t => fractalOn(t) || T.flow(t)],
  ]);
  section('CELLS', [
    ['noise.cellOut', t => T.cells(t)],
    ['noise.metric',  t => t === 6],
    ['noise.jitter',  usesJitter],
  ]);
  section('PATTERN', [
    ['noise.width', usesWidth], ['noise.density', usesDensity],
  ]);
  section('PERIODIC', [
    ['noise.period.x', T.periodic], ['noise.period.y', T.periodic], ['noise.alpha', T.periodic],
  ]);
  section('WARP', [
    ['noise.warp',      t => !T.grain(t)],
    ['noise.warpMode',  t => !T.grain(t)],
    ['noise.warpScale', t => !T.grain(t) && !T.flow(t)],
  ]);
  const combineOn = () => v('noise.combine') !== 0;
  section('LAYER B', [
    ['noise.combine', notCurl],
    ['noise.amount',    t => notCurl(t) && combineOn()],
    ['noise.b.type',    t => notCurl(t) && combineOn()],
    ['noise.b.fractal', t => notCurl(t) && combineOn() && T.fractal(v('noise.b.type'))],
    ['noise.b.scale',   t => notCurl(t) && combineOn()],
    ['noise.b.speed',   t => notCurl(t) && combineOn()],
  ]);
  section('SHAPE', [
    ['noise.contrast', notCurl], ['noise.brightness', notCurl],
    ['noise.bands', notCurl], ['noise.steps', notCurl], ['noise.gamma', notCurl],
    ['noise.sharpen'], ['noise.invert'],
  ]);
  // The swatches live in index.html; move them under Colour Mode so the
  // colour controls read as one group, and show them only for Two-Tone.
  const swatches = document.getElementById('noise-color-swatches');
  // Full-resolution cost warning. Cost = field evaluations per pixel, in
  // units of one Perlin octave, weighted by what each stage adds. Calibrated
  // 2026-09-23 on a Radeon Pro 5500M at 1279×887 (ms at Full): 4 → 3.8,
  // 8 → 4.6, 26 → 8.3, 30 → 11.1, 78 → 19.5. Above ~20 a single noise pass
  // takes half a 60 fps frame or more; at 512 even 78 was 5.1 ms.
  const HEAVY = 20;
  const resNote = document.createElement('div');
  resNote.className = 'noise-note';
  const basisW = t => (t >= 6 && t <= 8) ? 3 : (t >= 9 && t <= 14) ? 2 : 1;  // cells 27 taps, patterns 9
  const fieldCost = (t, fractal) => (t >= 15) ? 0.3
    : basisW(t) * ((T.fractal(t) && fractal !== 0) || T.flow(t) ? v('noise.octaves') : 1);
  const noiseCost = t => {
    const why = [];
    let c = T.curl(t) ? 3 * fieldCost(1, v('noise.fractal')) : fieldCost(t, v('noise.fractal'));
    if (v('noise.octaves') >= 6 && (T.fractal(t) || T.flow(t)) && v('noise.fractal') !== 0) why.push(`${v('noise.octaves')} octaves`);
    if (basisW(t) === 3 && v('noise.fractal') !== 0 && v('noise.octaves') > 1) why.push('fractal cells');
    if (v('noise.warp') > 0 && !T.grain(t) && !T.flow(t)) {
      const n = [2, 4, 3][v('noise.warpMode')];
      c += n * v('noise.octaves');
      why.push(['Domain', 'Double', 'Curl'][v('noise.warpMode')] + ' warp');
    }
    if (v('noise.combine') !== 0 && !T.curl(t)) {
      const b = fieldCost(v('noise.b.type'), v('noise.b.fractal')) * (v('noise.combine') === 9 ? 2 : 1);
      c += b;
      if (b >= 4) why.push('Layer B');
    }
    if (v('noise.color') === 1 && !T.curl(t)) { c *= 3; why.push('RGB (×3)'); }
    return { c, why };
  };
  const resNoteVis = t => {
    if (v('noise.res') !== 1) return false;
    const { c, why } = noiseCost(t);
    resNote.textContent = `Heavy at Full resolution${why.length ? ` — ${why.join(', ')}` : ''}. `
      + 'Use 512, or lighten these, if the frame rate drops.';
    return c >= HEAVY;
  };
  section('COLOUR', [
    ['noise.color', notCurl],
    ...(swatches ? [[swatches, t => notCurl(t) && v('noise.color') === 0]] : []),
    ['noise.res'],
    [resNote, resNoteVis],
  ]);

  function refresh() {
    const t = v('noise.type');
    for (const [el, vis] of rows) el.style.display = vis(t) ? '' : 'none';
    for (const [el, mine] of sections)
      el.style.display = mine.some(r => r.style.display !== 'none') ? '' : 'none';
    if (swatches && swatches.style.display !== 'none') swatches.style.display = 'flex';
  }

  // Type set from outside (controller, state recall): follow it to its
  // family so the menu can show it. Family set by the user: keep the type
  // valid for the new family.
  ps.get('noise.type').onChange(t => {
    const fam = NOISE_FAMILY_TYPES.findIndex(list => list.includes(t));
    if (fam >= 0 && fam !== v('noise.family')) ps.set('noise.family', fam);
    else {
      const types = NOISE_FAMILY_TYPES[v('noise.family')];
      const idx = types.indexOf(t);
      if (idx >= 0 && typeSel) typeSel.value = idx;
    }
    refresh();
  });
  ps.get('noise.family').onChange(f => {
    const types = NOISE_FAMILY_TYPES[f] ?? NOISE_FAMILY_TYPES[0];
    if (!types.includes(v('noise.type'))) ps.set('noise.type', types[0]);
    renderTypeMenu();
    refresh();
  });
  for (const id of ['noise.fractal', 'noise.cellOut', 'noise.combine', 'noise.color', 'noise.b.type', 'noise.tile',
                    'noise.res', 'noise.octaves', 'noise.warp', 'noise.warpMode', 'noise.b.fractal'])
    ps.get(id).onChange(refresh);

  renderTypeMenu();
  refresh();
}

// ── Sequence params panel ─────────────────────────────────────────────────────

const SEQ_SRC_OPTS = [
  { label: 'Out',  title: 'Output (composite)' },
  { label: 'Cam',  title: 'Camera' },
  { label: 'Mov',  title: 'Movie / Video clip' },
  { label: 'FG',   title: 'Foreground layer source' },
  { label: 'BG',   title: 'Background layer source' },
  { label: 'Buf',  title: 'Stills buffer' },
  { label: 'Draw', title: 'Draw layer' },
];

export function buildSeqParams(ps, contextMenu) {
  const el = document.getElementById('seq-params');
  if (!el) return;
  el.innerHTML = '';

  [1, 2, 3].forEach(n => {
    const card = document.createElement('div');
    card.className = 'seq-card';

    // ── Header row: label + active toggle ──
    const hdr = document.createElement('div');
    hdr.className = 'seq-card-hdr';

    const hdrLabel = document.createElement('span');
    hdrLabel.className = 'seq-card-label';
    hdrLabel.textContent = `Seq ${n}`;

    const activeParam = ps.get(`seq${n}.active`);
    const recBtn = document.createElement('button');
    const setRecBtnState = () => {
      recBtn.textContent = activeParam.value ? '⏺ REC' : '⏺ OFF';
      recBtn.classList.toggle('active', !!activeParam.value);
    };
    setRecBtnState();
    recBtn.title = 'Toggle recording';
    recBtn.className = 'seq-rec-btn';
    recBtn.addEventListener('click', () => {
      activeParam.toggle();
      setRecBtnState();
    });
    activeParam.onChange(setRecBtnState);

    hdr.appendChild(hdrLabel);
    hdr.appendChild(recBtn);
    card.appendChild(hdr);

    // ── Source row: compact buttons ──
    const srcLabel = document.createElement('div');
    srcLabel.className = 'seq-row-label';
    srcLabel.textContent = 'Source';
    card.appendChild(srcLabel);

    const srcRow = document.createElement('div');
    srcRow.className = 'seq-src-row';
    const srcParam = ps.get(`seq${n}.source`);

    SEQ_SRC_OPTS.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.textContent = opt.label;
      btn.title = opt.title;
      btn.className = 'seq-src-btn';
      const refresh = () => btn.classList.toggle('active', srcParam.value === i);
      refresh();
      srcParam.onChange(refresh);
      btn.addEventListener('click', () => {
        srcParam.value = i;
      });
      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        contextMenu?.show(srcParam, e.clientX, e.clientY);
      });
      srcRow.appendChild(btn);
    });
    card.appendChild(srcRow);

    // ── Speed row ──
    const speedParam = ps.get(`seq${n}.speed`);
    card.appendChild(buildParamRow(speedParam, contextMenu));

    // ── Frames row + memory hint ──
    const sizeParam = ps.get(`seq${n}.size`);
    card.appendChild(buildParamRow(sizeParam, contextMenu));

    // Memory estimate (updates live as slider is dragged)
    const memHint = document.createElement('div');
    memHint.className = 'seq-mem-hint';
    const updateMemHint = (frames) => {
      // Approximate: W × H × 4 bytes per frame; use screen size as proxy
      const W = window.innerWidth  || 1280;
      const H = window.innerHeight || 720;
      const mb = Math.round(frames * W * H * 4 / 1024 / 1024);
      const warn = mb > 800;
      memHint.textContent = `≈ ${mb} MB VRAM${warn ? ' ⚠' : ''}`;
      memHint.style.color = warn ? 'var(--red)' : 'var(--text-2)';
    };
    updateMemHint(sizeParam.value);
    sizeParam.onChange(updateMemHint);
    card.appendChild(memHint);

    // ── Mode selector + TimeWarp controls ──
    const modeParam = ps.get(`seq${n}.mode`);
    card.appendChild(buildParamRow(modeParam, contextMenu));

    const twSection = document.createElement('div');
    twSection.className = 'seq-tw-section';
    const refreshTW = () => {
      twSection.style.display = modeParam.value === 1 ? '' : 'none';
    };
    refreshTW();
    modeParam.onChange(refreshTW);

    [`seq${n}.tw.axis`, `seq${n}.tw.flip`, `seq${n}.tw.speed`,
     `seq${n}.tw.mix`, `seq${n}.tw.offset`, `seq${n}.tw.warp`].forEach(id => {
      twSection.appendChild(buildParamRow(ps.get(id), contextMenu));
    });
    card.appendChild(twSection);

    el.appendChild(card);
  });
}

// ── 3D geometry buttons ───────────────────────────────────────────────────────

export function buildGeometryButtons(ps, sceneManager, contextMenu) {
  const el = document.getElementById('geometry-controls');
  if (!el) return;

  // 3D on/off toggle at top of section
  const activeParam = ps.get('scene3d.active');
  const btn3D = document.createElement('button');
  btn3D.className = 'import-btn';
  btn3D.style.cssText = 'margin:0 0 8px 0;';
  const update3DBtn = () => {
    btn3D.textContent = activeParam.value ? '■ 3D Scene On' : '▶ 3D Scene Off';
  };
  update3DBtn();
  btn3D.addEventListener('click', () => {
    activeParam.toggle();
    update3DBtn();
  });
  activeParam.onChange(update3DBtn);
  el.appendChild(btn3D);

  // ── Bundled models ──────────────────────────────────────────────────────
  const BUNDLED_MODELS = [
    '/assets/Harabara-optimized.glb',
  ];
  if (BUNDLED_MODELS.length && sceneManager) {
    const bmLabel = document.createElement('div');
    bmLabel.style.cssText = 'font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em;margin:6px 0 4px 0;';
    bmLabel.textContent = 'Bundled Models';
    el.appendChild(bmLabel);
    const bmRow = document.createElement('div');
    bmRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;';
    BUNDLED_MODELS.forEach(path => {
      const name = path.split('/').pop().replace(/\.[^.]+$/, '');
      const btn = document.createElement('button');
      btn.textContent = name;
      btn.style.cssText = 'background:var(--bg-3);color:var(--text-1);border:none;padding:3px 8px;font-size:11px;cursor:pointer;border-radius:2px;';
      btn.addEventListener('mouseenter', () => { btn.style.color = 'var(--accent)'; });
      btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--text-1)'; });
      btn.addEventListener('click', () => { sceneManager.loadModelFromUrl(path); });
      bmRow.appendChild(btn);
    });
    el.appendChild(bmRow);
  }

  const geoParam = ps.get('scene3d.geo');
  el.appendChild(buildParamRow(geoParam, contextMenu));

  // ── Transform section ────────────────────────────────────────────────────
  const transformEl = document.getElementById('transform-params');
  if (transformEl) {
    // Screen XY toggle — sits above the position rows as a mode switch
    const screenRow = buildParamRow(ps.get('scene3d.pos.screenspace'), contextMenu);
    const hint = document.createElement('div');
    hint.className = 'import-note';
    hint.style.cssText = 'margin:2px 0 6px 0; color:var(--text-2);';
    const updateHint = () => {
      hint.textContent = ps.get('scene3d.pos.screenspace').value
        ? 'X/Y: ±1 = screen edge  ·  Z: world units'
        : 'X/Y/Z: world units  ·  default cam at z=5';
    };
    updateHint();
    ps.get('scene3d.pos.screenspace').onChange(updateHint);
    transformEl.appendChild(screenRow);
    transformEl.appendChild(hint);

    ['scene3d.pos.x','scene3d.pos.y','scene3d.pos.z',
     'scene3d.rot.x','scene3d.rot.y','scene3d.rot.z',
     'scene3d.spin.x','scene3d.spin.y','scene3d.spin.z',
     'scene3d.scale','scene3d.norm',
    ].forEach(id => {
      const p = ps.get(id);
      if (p) transformEl.appendChild(buildParamRow(p, contextMenu));
    });
  }

  // ── Cloner section ───────────────────────────────────────────────────────
  const clonerEl = document.getElementById('cloner-params');
  if (clonerEl) {
    ['scene3d.clone.mode',    'scene3d.clone.count',
     'scene3d.clone.spread',    'scene3d.clone.wave',
     'scene3d.clone.waveshape', 'scene3d.clone.waveamp', 'scene3d.clone.wavefreq',
     'scene3d.clone.twist',   'scene3d.clone.scatter',
     'scene3d.clone.scale',   'scene3d.clone.scalestep',
    ].forEach(id => {
      const p = ps.get(id);
      if (p) clonerEl.appendChild(buildParamRow(p, contextMenu));
    });
  }

  // ── Blob / Morph section ─────────────────────────────────────────────────
  const blobEl = document.getElementById('blob-params');
  if (blobEl) {
    ['scene3d.blob.amount', 'scene3d.blob.scale', 'scene3d.blob.speed',
    ].forEach(id => {
      const p = ps.get(id);
      if (p) blobEl.appendChild(buildParamRow(p, contextMenu));
    });
  }

  // Model import buttons
  const importEl = document.getElementById('model-import');
  if (!importEl) return;

  // Status label — updated by main.js via _refreshModelLabel()
  const modelLabel = document.createElement('div');
  modelLabel.id = 'model-status-label';
  modelLabel.className = 'import-note';
  modelLabel.textContent = 'No model loaded — drop .glb/.obj/.stl/.dae here or use buttons below';
  importEl.appendChild(modelLabel);

  const importBtn = document.createElement('button');
  importBtn.className = 'import-btn';
  importBtn.textContent = '+ Import Model (GLB / OBJ / STL / DAE)';
  const _doImport = async (files) => {
    const modelFile = files.find(f => /\.(glb|gltf|obj|stl|dae)$/i.test(f.name));
    if (!modelFile) return;
    importBtn.textContent = '⏳ Loading…';
    try {
      await sceneManager.loadModel(modelFile, ps, files);
      modelLabel.textContent = `✓ ${modelFile.name} (+${files.length - 1} assets)`;
      modelLabel.style.color = 'var(--green)';
      importBtn.textContent = '+ Import Model';
      importEl.dispatchEvent(new CustomEvent('modelLoaded', { bubbles: true, detail: { name: modelFile.name, files } }));
    } catch (err) {
      console.error('[Import]', err);
      modelLabel.textContent = `✗ Error: ${err.message}`;
      modelLabel.style.color = 'var(--red, #e05)';
      importBtn.textContent = '+ Import Model';
    }
  };

  importBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    // Accept model formats + common texture formats so they survive the file picker filter
    input.accept = '.gltf,.glb,.obj,.stl,.dae,.jpg,.jpeg,.png,.webp,.bmp,.tga,.mtl,.bin';
    input.multiple = true;
    input.onchange = e => _doImport(Array.from(e.target.files));
    input.click();
  });
  importEl.appendChild(importBtn);

  // Folder import — picks entire directory; best for DAE/OBJ + textures
  const folderBtn = document.createElement('button');
  folderBtn.className = 'import-btn';
  folderBtn.textContent = '📁 Import Folder (DAE / OBJ + textures)';
  folderBtn.title = 'Select the folder containing the model and its textures';
  folderBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.onchange = e => _doImport(Array.from(e.target.files));
    input.click();
  });
  importEl.appendChild(folderBtn);

  const clearBtn = document.createElement('button');
  clearBtn.className = 'import-btn';
  clearBtn.textContent = '↩ Back to Geometry';
  clearBtn.title = 'Remove imported model and return to procedural geometry';
  clearBtn.addEventListener('click', () => {
    const geoIdx = ps.get('scene3d.geo').value;
    const geoName = ps.get('scene3d.geo').options[geoIdx] ?? 'Sphere';
    // Clear imported model then force geometry re-select
    sceneManager._importedModelName = null;
    sceneManager._geoKey = null;  // invalidate so setGeometry actually runs
    sceneManager.setGeometry(geoName);
    modelLabel.textContent = 'No model loaded — drop .glb/.obj/.stl/.dae here or use button below';
    modelLabel.style.color = '';
  });
  importEl.appendChild(clearBtn);

  const note = document.createElement('div');
  note.className = 'import-note';
  note.style.marginTop = '4px';
  note.textContent = 'Tip: drag & drop model files anywhere onto the app window';
  importEl.appendChild(note);

  // ── Model size controls (shown when a model is imported) ──────────────────
  const sizeSection = document.createElement('div');
  sizeSection.id = 'model-size-controls';
  sizeSection.style.cssText = 'display:none; margin-top:10px; border-top:1px solid var(--border); padding-top:8px;';

  const sizeLabel = document.createElement('div');
  sizeLabel.className = 'import-note';
  sizeLabel.style.cssText = 'margin-bottom:4px; font-weight:bold; color:var(--text-1);';
  sizeLabel.textContent = 'Model Size';
  sizeSection.appendChild(sizeLabel);
  sizeSection.appendChild(buildParamRow(ps.get('scene3d.norm'), contextMenu));
  sizeSection.appendChild(buildParamRow(ps.get('scene3d.scale'), contextMenu));
  importEl.appendChild(sizeSection);

  // ── Animation controls (shown when model has animations) ──────────────────
  const animSection = document.createElement('div');
  animSection.id = 'model-anim-controls';
  animSection.style.cssText = 'display:none; margin-top:10px; border-top:1px solid var(--border); padding-top:8px;';

  const animLabel = document.createElement('div');
  animLabel.className = 'import-note';
  animLabel.style.cssText = 'margin-bottom:4px; font-weight:bold; color:var(--text-1);';
  animLabel.textContent = 'Animations';
  animSection.appendChild(animLabel);
  animSection.appendChild(buildParamRow(ps.get('scene3d.anim.active'), contextMenu));
  animSection.appendChild(buildParamRow(ps.get('scene3d.anim.select'), contextMenu));
  animSection.appendChild(buildParamRow(ps.get('scene3d.anim.speed'), contextMenu));
  importEl.appendChild(animSection);

  // Show/hide model sections when a model is loaded or cleared
  const refreshModelSections = () => {
    const hasModel = !!sceneManager.importedModelName;
    const hasAnims = hasModel && sceneManager.actions && sceneManager.actions.length > 0;
    sizeSection.style.display = hasModel ? '' : 'none';
    animSection.style.display = hasAnims ? '' : 'none';
  };

  importEl.addEventListener('modelLoaded', refreshModelSections);
  clearBtn.addEventListener('click', refreshModelSections);
}

// ── More models (slots 2–4) ───────────────────────────────────────────────────
// Sits under the main Import block. A tab per slot keeps 33 rows down to 11:
// the tab shows the slot's model name, the body its Import/Clear and its
// placement rows. onImport(i, files) does the loading (main.js owns
// ModelSlots and the ModelStore); refresh() repaints names after any load,
// clear or state recall.
export function buildModelSlotsPanel(ps, contextMenu, slots, { onImport, onClear }) {
  const importEl = document.getElementById('model-import');
  if (!importEl || !slots) return { refresh() {} };

  const wrap = document.createElement('div');
  wrap.className = 'model-slots';
  const hd = document.createElement('div');
  hd.className = 'cp-sub-header';
  hd.textContent = 'MORE MODELS';
  wrap.appendChild(hd);

  const tabs = document.createElement('div');
  tabs.className = 'model-slot-tabs';
  wrap.appendChild(tabs);

  const PREFIXES = ['model2', 'model3', 'model4'];
  let cur = 0;
  const bodies = [], tabBtns = [], statuses = [], rowSets = [], animRows = [], clipLines = [];
  const ANIM_KEYS = ['anim', 'clip', 'animSpeed'];
  PREFIXES.forEach((pre, i) => {
    const tb = document.createElement('button');
    tb.className = 'model-slot-tab';
    tb.addEventListener('click', () => { cur = i; refresh(); });
    tabs.appendChild(tb);
    tabBtns.push(tb);

    const body = document.createElement('div');
    const status = document.createElement('div');
    status.className = 'import-note';
    body.appendChild(status);
    statuses.push(status);

    const btns = document.createElement('div');
    btns.className = 'model-slot-btns';
    const imp = document.createElement('button');
    imp.className = 'import-btn';
    imp.textContent = '+ Import';
    imp.title = `Load a model into Model ${i + 2} (GLB / OBJ / STL / DAE, with its textures)`;
    imp.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.gltf,.glb,.obj,.stl,.dae,.jpg,.jpeg,.png,.webp,.bmp,.tga,.mtl,.bin';
      input.multiple = true;
      input.onchange = async e => {
        imp.textContent = '⏳ Loading…';
        try { await onImport(i, Array.from(e.target.files)); }
        finally { imp.textContent = '+ Import'; refresh(); }
      };
      input.click();
    });
    const clr = document.createElement('button');
    clr.className = 'import-btn';
    clr.textContent = '✕ Clear';
    clr.title = `Remove the model from Model ${i + 2}`;
    clr.addEventListener('click', () => { onClear(i); refresh(); });
    btns.append(imp, clr);
    body.appendChild(btns);

    const rows = document.createElement('div');
    const mine = [];
    const clipLine = document.createElement('div');
    clipLine.className = 'import-note';
    ps.getGroup(pre).forEach(p => {
      const r = buildParamRow(p, contextMenu);
      rows.appendChild(r);
      const key = p.id.slice(pre.length + 1);
      if (ANIM_KEYS.includes(key)) mine.push(r);
      // The clip's name, under the Clip row: the row itself is a number.
      if (key === 'clip') { rows.appendChild(clipLine); p.onChange(() => refresh()); }
    });
    mine.push(clipLine);
    body.appendChild(rows);
    rowSets.push(rows);
    animRows.push(mine);
    clipLines.push(clipLine);

    wrap.appendChild(body);
    bodies.push(body);
  });

  const note = document.createElement('div');
  note.className = 'import-note';
  note.textContent = 'Share the main Material. Tip: ⌥-drop a model file to put it in the first empty slot.';
  wrap.appendChild(note);

  importEl.after(wrap);

  function refresh() {
    const names = slots.names();
    PREFIXES.forEach((_, i) => {
      const n = names[i];
      const short = n ? n.split('/').pop().replace(/\.[^.]+$/, '') : null;
      tabBtns[i].textContent = `M${i + 2}${short ? ' · ' + short : ''}`;
      tabBtns[i].title = n ?? `Model ${i + 2} — empty`;
      tabBtns[i].classList.toggle('active', i === cur);
      tabBtns[i].classList.toggle('loaded', !!n);
      bodies[i].style.display = i === cur ? '' : 'none';
      const miss = slots.missing?.[i];
      statuses[i].textContent = n ? `✓ ${n.split('/').pop()}`
        : miss ? `⚠ ${miss} is not stored in this browser — import it again`
        : 'Empty — import a model';
      statuses[i].style.color = n ? 'var(--green)' : miss ? 'var(--red, #e05)' : '';
      rowSets[i].style.display = n ? '' : 'none';
      // Animation rows only for a model that has clips.
      const ci = slots.clipInfo(i, ps);
      animRows[i].forEach(r => { r.style.display = ci ? '' : 'none'; });
      if (ci) clipLines[i].textContent = `Clip ${ci.index} of ${ci.n}: ${ci.name}`;
    });
  }
  refresh();
  return { refresh };
}

// ── State bar (thumbnail tiles + bank selector) ───────────────────────────────

export class StateBar {
  constructor(presetManager, sceneManager = null) {
    this.pm          = presetManager;
    this.sm          = sceneManager;
    this.neutralEl   = document.getElementById('state-neutral');
    this.gridEl      = document.getElementById('state-grid');
    this.bankBtn     = document.getElementById('bank-name-btn');
    this.bankDropdown= document.getElementById('bank-dropdown');
    this.tiles       = [];
    this._captureThumbFn  = null; // injected from main.js
    this._menuEl          = null;
    this._morphingIndices = new Set(); // tile indices highlighted during morph
    this._build();
    this._wireNeutral();
    this._wireBankBtn();
    this._wirePresetManager();
    this._wireMenu();
    // Paint thumbnails for whichever bank is already active at construction time
    // (presetActivated fires during init(), before StateBar is created)
    this._refresh();
  }

  _build() {
    if (!this.gridEl) return;
    this.gridEl.innerHTML = '';
    this.tiles = [];
    for (let i = 0; i < 32; i++) {
      const tile = document.createElement('button');
      tile.className = 'state-tile state-tile--empty';
      tile.dataset.idx = i;
      const num = document.createElement('span');
      num.className = 'state-tile-num';
      num.textContent = i + 1;
      tile.appendChild(num);
      tile.addEventListener('click', e => {
        // Ctrl+click is the tile's context-menu gesture on a trackpad; macOS
        // still sends this click on the release, and recalling a state from it
        // is a full instrument change nobody asked for.
        if (e.ctrlKey || e.metaKey) return;
        if (this.pm.current?.states[i]) this.pm.recallState(i);
      });
      tile.addEventListener('contextmenu', e => {
        e.preventDefault();
        this._openTileMenu(i, e.clientX, e.clientY);
      });
      this.gridEl.appendChild(tile);
      this.tiles.push(tile);
    }
  }

  _wireNeutral() {
    if (!this.neutralEl) return;
    this.neutralEl.addEventListener('click', () => {
      this.pm.dispatchEvent(new CustomEvent('neutralState'));
    });
  }

  _wireBankBtn() {
    if (!this.bankBtn) return;
    this.bankBtn.addEventListener('click', e => {
      e.stopPropagation();
      const open = !this.bankDropdown.classList.contains('hidden');
      if (open) { this.bankDropdown.classList.add('hidden'); return; }
      this._buildDropdown();
      this.bankDropdown.classList.remove('hidden');
    });
    document.addEventListener('click', () => this.bankDropdown?.classList.add('hidden'));
    this.bankBtn.addEventListener('dblclick', e => {
      e.preventDefault();
      this._startBankRename();
    });
  }

  /**
   * Rebuild the hidden #bank-select MIDI proxy from the live bank set.
   *
   * The options and the value must be written together: setting .value for an
   * index that has no <option> yet is silently dropped and leaves the select
   * empty. This used to live only in _buildDropdown(), which runs when the user
   * OPENS the dropdown, so any bank added since then had no option and the
   * select read "" until the menu was next opened.
   */
  _syncBankSelect() {
    const sel = document.getElementById('bank-select');
    if (!sel) return;
    sel.innerHTML = '';
    this.pm.presets.forEach((bank, i) => {
      if (!bank) return;                    // presets is sparse — skip holes
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = bank.name || `Bank ${i + 1}`;
      sel.appendChild(opt);
    });
    sel.value = String(this.pm.currentIdx); // only valid once options exist
  }

  _buildDropdown() {
    if (!this.bankDropdown) return;
    this.bankDropdown.innerHTML = '';
    this.pm.presets.forEach((bank, i) => {
      if (!bank) return;
      const btn = document.createElement('button');
      btn.className = 'bank-dropdown-item' + (i === this.pm.currentIdx ? ' active' : '');
      btn.textContent = bank.name || `Bank ${i + 1}`;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.pm.activatePreset(i);
        this.bankDropdown.classList.add('hidden');
      });
      this.bankDropdown.appendChild(btn);
    });
    this._syncBankSelect();
    const divider = document.createElement('div');
    divider.className = 'bank-dropdown-divider';
    this.bankDropdown.appendChild(divider);
    const newBtn = document.createElement('button');
    newBtn.className = 'bank-dropdown-item new-bank';
    newBtn.textContent = '+ New Bank';
    newBtn.addEventListener('click', async e => {
      e.stopPropagation();
      await this.pm.createBank();
      this.bankDropdown.classList.add('hidden');
    });
    this.bankDropdown.appendChild(newBtn);
    const importBtn = document.createElement('button');
    importBtn.className = 'bank-dropdown-item new-bank';
    importBtn.textContent = '⬆ Import Bank…';
    importBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.bankDropdown.classList.add('hidden');
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.imbank,application/json';
      inp.addEventListener('change', async () => {
        const file = inp.files[0]; if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          const toast = msg => this.pm.dispatchEvent(new CustomEvent('toast', { detail: { msg } }));
          if (data.__type !== 'imbank') { toast('⚠ Not a valid .imbank file'); return; }
          const idx = this.pm.presets.length;
          const { Preset: P } = await import('../state/Preset.js');
          const bank = P.importBank(data, idx);
          this.pm.presets[idx] = bank;
          await bank.save();
          await this.pm.activatePreset(idx);
          if (data.modelAsset && this.sm) await this.sm.loadModelFromUrl(data.modelAsset);
          toast(`✓ Bank "${bank.name}" imported`);
        } catch (err) {
          this.pm.dispatchEvent(new CustomEvent('toast', { detail: { msg: '⚠ Could not import bank: ' + err.message } }));
        }
      });
      inp.click();
    });
    this.bankDropdown.appendChild(importBtn);

    const divider2 = document.createElement('div');
    divider2.className = 'bank-dropdown-divider';
    this.bankDropdown.appendChild(divider2);

    const openWinBtn = document.createElement('button');
    openWinBtn.className = 'bank-dropdown-item new-bank';
    openWinBtn.textContent = '⊞ Open Banks window';
    openWinBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.bankDropdown.classList.add('hidden');
      // Find and trigger the detach button on the Banks panel section
      const banksSection = document.getElementById('banks-section');
      const detachBtn = banksSection?.querySelector('.section-header-btns button');
      if (detachBtn) detachBtn.click();
    });
    this.bankDropdown.appendChild(openWinBtn);
  }

  _startBankRename() {
    const bank = this.pm.current;
    if (!bank) return;
    const orig = bank.name || `Bank ${this.pm.currentIdx + 1}`;
    const inp = document.createElement('input');
    inp.value = orig;
    inp.style.cssText = 'background:transparent;border:none;color:inherit;font:inherit;outline:none;width:80px;';
    this.bankBtn.innerHTML = '';
    this.bankBtn.appendChild(inp);
    inp.focus(); inp.select();
    const commit = () => this.pm.renameBank(this.pm.currentIdx, inp.value.trim() || orig);
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.value = orig; inp.blur(); }
    });
  }

  _updateBankBtn() {
    if (!this.bankBtn) return;
    this.bankBtn.textContent =
      (this.pm.current?.name || `Bank ${this.pm.currentIdx + 1}`) + ' ▾';
  }

  _wireMenu() {
    const m = document.createElement('div');
    m.id = 'state-tile-menu';
    m.className = 'hidden';
    document.body.appendChild(m);
    this._menuEl = m;
    // pointerdown, and only outside the menu — see ContextMenu._wire. This menu
    // opens from `contextmenu`, which macOS fires on the mousedown of a
    // Ctrl+click, so closing on `click` shut it again on the release. Worse
    // here than elsewhere: the tile's own click handler RECALLS the state, so
    // Ctrl+clicking a tile to rename or overwrite it silently jumped the whole
    // instrument to that state instead.
    document.addEventListener('pointerdown', e => {
      if (!m.contains(e.target)) m.classList.add('hidden');
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') m.classList.add('hidden'); });
  }

  _openTileMenu(idx, x, y) {
    const m = this._menuEl;
    if (!m) return;
    m.innerHTML = '';
    const bank = this.pm.current;
    const hasState = !!bank?.states[idx];

    const addItem = (label, cls, fn) => {
      const btn = document.createElement('button');
      btn.className = 'state-tile-menu-item' + (cls ? ' ' + cls : '');
      btn.textContent = label;
      btn.addEventListener('click', e => { e.stopPropagation(); m.classList.add('hidden'); fn(); });
      m.appendChild(btn);
    };

    const toast = msg => this.pm.dispatchEvent(new CustomEvent('toast', { detail: { msg } }));

    addItem('Save here', '', () => {
      this.pm.saveCurrentState(idx).then(stateIdx => {
        if (this._captureThumbFn && bank?.states[idx]) {
          bank.states[idx].thumbnail = this._captureThumbFn();
          bank.save?.();
          this.pm.dispatchEvent(new CustomEvent('stateSaved',
            { detail: { presetIndex: this.pm.currentIdx, stateIndex: idx } }));
        }
        this._flashTile(idx);
        this._refresh();
      });
    });

    addItem('Import .imstate', '', () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.imstate,application/json';
      inp.addEventListener('change', async () => {
        const file = inp.files[0]; if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          if (data.__type !== 'imstate') { toast('⚠ Not a valid .imstate file'); return; }
          const slotIdx = this.pm.importState(data, idx);
          if (this._captureThumbFn && bank?.states[slotIdx] && !bank.states[slotIdx].thumbnail) {
            bank.states[slotIdx].thumbnail = this._captureThumbFn();
          }
          await bank.save?.();
          this.pm.dispatchEvent(new CustomEvent('stateSaved',
            { detail: { presetIndex: this.pm.currentIdx, stateIndex: slotIdx } }));
          this._flashTile(slotIdx);
          this._refresh();
          toast(`✓ State imported into slot ${slotIdx + 1}`);
        } catch (err) {
          toast('⚠ Could not import state: ' + err.message);
        }
      });
      inp.click();
    });

    if (hasState) {
      addItem('Export .imstate', '', () => {
        const data = this.pm.exportState(idx);
        if (!data) return;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (bank.states[idx]?.name || `State-${idx + 1}`) + '.imstate';
        a.click();
        URL.revokeObjectURL(a.href);
      });
      addItem('Clear', 'danger', async () => {
        bank.removeState(idx);
        await bank.save?.();
        this.pm.dispatchEvent(new CustomEvent('stateSaved',
          { detail: { presetIndex: this.pm.currentIdx, stateIndex: idx } }));
        this._refresh();
      });
    }

    m.classList.remove('hidden');
    const r = m.getBoundingClientRect();
    setViewportPos(m,
      Math.min(x, window.innerWidth - r.width - 8),
      Math.max(8, y - r.height - 4));
  }

  _flashTile(idx) {
    const tile = this.tiles[idx];
    if (!tile) return;
    tile.classList.remove('state-tile--flash');
    void tile.offsetWidth;
    tile.classList.add('state-tile--flash');
    setTimeout(() => tile.classList.remove('state-tile--flash'), 400);
  }

  _refresh() {
    const bank = this.pm.current;
    if (!bank) return;
    this.tiles.forEach((tile, i) => {
      const state = bank.states[i];
      tile.className = 'state-tile';
      if (!state) {
        tile.classList.add('state-tile--empty');
        tile.style.backgroundImage = '';
      } else {
        tile.classList.add('state-tile--stored');
        tile.style.backgroundImage = state.thumbnail ? `url(${state.thumbnail})` : '';
      }
      if (bank.activeState === i) tile.classList.add('state-tile--active');
      if (this._morphingIndices.has(i)) tile.classList.add('state-tile--morphing');
    });
    this._updateBankBtn();
    this._syncBankSelect();
  }

  _wirePresetManager() {
    this.pm.addEventListener('presetActivated', () => this._refresh());
    this.pm.addEventListener('stateSaved',      () => this._refresh());
    this.pm.addEventListener('stateRecalled',   () => this._refresh());
    this.pm.addEventListener('bankRenamed',     () => this._refresh());
    this.pm.addEventListener('morphStarted', e => {
      const { fromIndex, toIndex } = e.detail;
      this._morphingIndices = new Set([fromIndex, toIndex]);
      this._refresh();
    });
    this.pm.addEventListener('morphEnded', () => {
      this._morphingIndices = new Set();
      this._refresh();
    });
  }
}

// ── Signal path display ────────────────────────────────────────────────────────

// Map from fx ID to { label, isActive(p) } for the signal path display
const _FX_NODE_INFO = {
  pixelate:    { label: 'pixel',   isActive: p => p.get('effect.pixelate').value > 1 },
  edge:        { label: 'edge',    isActive: p => p.get('effect.edge').value > 0 },
  rgbshift:    { label: 'rgb»',    isActive: p => p.get('effect.rgbshift').value > 0 },
  kaleidoscope:{ label: 'kale',    isActive: p => p.get('effect.kaleidoscope').value >= 2 },
  quadmirror:  { label: 'mirror',  isActive: p => p.get('effect.quadmirror').value > 0 },
  posterize:   { label: 'poster',  isActive: p => p.get('effect.posterize').value < 32 },
  solarize:    { label: 'solar',   isActive: p => p.get('effect.solarize').value < 100 },
  vignette:    { label: 'vign',    isActive: p => p.get('effect.vignette').value > 0 },
  bokeh:       { label: 'bokeh',   isActive: p => p.get('effect.bokeh').value > 0 },
  bloom:       { label: 'bloom',   isActive: p => p.get('effect.bloom').value > 0 },
  levels:      { label: 'levels',  isActive: p => p.get('effect.lvblack').value > 0 || p.get('effect.lvwhite').value < 100 || p.get('effect.lvgamma').value !== 100 },
  // The only entry that needs more than the params: LUT Amount defaults above
  // zero, so this drew a node for a pass that returns immediately whenever no
  // .cube was loaded. isActive gets the pipeline as a second argument for
  // exactly this — the flow should claim what _FX.lut actually does.
  lut:         { label: 'lut',     isActive: (p, pipe) => (p.get('effect.lutamount')?.value ?? 0) > 0 && (pipe?.lutLoaded ?? false) },
  whitebal:    { label: 'wbal',    isActive: p => (p.get('effect.wbtemp')?.value ?? 0) !== 0 || (p.get('effect.wbtint')?.value ?? 0) !== 0 },
  pixelsort:   { label: 'psort',   isActive: p => p.get('effect.pixelsort').value > 0 },
  grain:       { label: 'grain',   isActive: p => p.get('effect.grain').value > 0 || p.get('effect.scanlines').value > 0 },
  // Every id in DEFAULT_FX_ORDER needs an entry here or it is invisible in the
  // flow AND undraggable — the map is what makes a node exist for the reorder
  // UI, not just what labels it. tests/audit-panel-coverage.mjs enforces it.
  sharpen:     { label: 'sharp',   isActive: p => (p.get('effect.sharpen')?.value ?? 0) > 0 },
  flip:        { label: 'flip',    isActive: p => (p.get('effect.flip')?.value ?? 0) > 0 },
  outhsv:      { label: 'hsv',     isActive: p => (p.get('effect.outhue')?.value ?? 0) !== 0 || (p.get('effect.outsat')?.value ?? 100) !== 100 || (p.get('effect.outbright')?.value ?? 100) !== 100 },
  interlace:   { label: 'ilace',   isActive: p => (p.get('output.interlace')?.value ?? 0) > 0 },
  polar:       { label: 'polar',   isActive: p => (p.get('effect.polar')?.value ?? 0) > 0 },
  wave:        { label: 'wave',    isActive: p => (p.get('effect.wavex')?.value ?? 0) > 0 || (p.get('effect.wavey')?.value ?? 0) > 0 },
  lens:        { label: 'lens',    isActive: p => (p.get('effect.lens')?.value ?? 0) !== 0 || (p.get('effect.twirl')?.value ?? 0) !== 0 },
  halftone:    { label: 'half',    isActive: p => (p.get('effect.halftone')?.value ?? 0) > 0 },
  duotone:     { label: 'duo',     isActive: p => (p.get('effect.duotone')?.value ?? 0) > 0 },
};

export class SignalPath {
  /**
   * @param {object} o
   * @param {object|null} o.audioHost `AudioBinding`, injected (§8.6). Injected
   *   rather than imported for the reason every other audio consumer is: the
   *   binding stays the only module that sees both halves, so this one asks for
   *   a row of nodes and never learns what an AudioContext is. Null-safe — with
   *   no host there is simply no audio row.
   */
  constructor({ ps, pipeline = null, onOrderChange = null, audioHost = null }) {
    this.ps = ps;
    this.pipeline = pipeline;
    this.onOrderChange = onOrderChange;
    this.audioHost = audioHost;
    this.el = document.getElementById('signal-path-display');
    this._fxOrder = pipeline ? [...pipeline.fxOrder] : [...DEFAULT_FX_ORDER_SP];
    this._dragSrc = null;
    this._render();

    // Re-render on sequence changes too
    ['seq1.active','seq1.source','seq1.speed',
     'seq2.active','seq2.source','seq2.speed',
     'seq3.active','seq3.source','seq3.speed',
    ].forEach(id => { ps.get(id)?.onChange(() => this._render()); });

    // Re-render on layer/effect changes
    [
      'layer.fg','layer.bg','layer.ds',
      'keyer.active','keyer.extkey',
      'displace.amount','displace.warp',
      'blend.active','feedback.active','feedback.mode',
      'feedback.hor','feedback.ver','feedback.scale','feedback.rotate','feedback.zoom',
      'feedback.decay','feedback.blur','feedback.hue','feedback.mirror',
      'output.colorshift','output.fade',
      'effect.pixelate','effect.edge','effect.rgbshift','effect.kaleidoscope','effect.posterize','effect.solarize',
      'effect.enable',
      'effect.sharpen','effect.flip','effect.outhue','effect.outsat','effect.outbright','output.interlace',
      'effect.polar','effect.wavex','effect.wavey','effect.lens','effect.twirl',
      'effect.halftone','effect.duotone',
      'effect.vignette','effect.bloom','effect.pixelsort','effect.grain','effect.scanlines','effect.strobe',
      'effect.quadmirror','effect.lvblack','effect.lvwhite','effect.lvgamma',
      'effect.lutamount','effect.wbtemp','effect.wbtint',
      'fg.hue','fg.sat','fg.bright','bg.hue','bg.sat','bg.bright',
      'keyer.chroma',
      // The audio graph (§8.6). Every param that changes a LINK in the drawn
      // row — not every audio param, because the row draws routing, not values.
      // The one change these cannot see is the microphone DEVICE opening or
      // closing, which is not a param at all (`_applyTap` opens it directly and
      // `audio.mic` catches up afterwards); `onLoopState` covers that edge, and
      // main.js drives this from there.
      'audio.enable', 'audio.mic', 'audio.monitor', 'audio.tapeSec',
      'arec.on', 'arec.part', 'arec.unsafe',
      'aplay.on', 'aplay.part', 'aplay.unsafe',
      'agrain.on', 'agrain.part', 'agrain.unsafe',
      'avoice.on',
      // Partition layout, because whether the loop is CARRYING is decided by
      // whether the recorder's and the reader's partitions overlap on the tape
      // — dragging a partition can close the loop without either zone moving.
      'apart0.start', 'apart0.len', 'apart1.start', 'apart1.len',
      'apart2.start', 'apart2.len', 'apart3.start', 'apart3.len',
    ].forEach(id => {
      ps.get(id)?.onChange(() => this._render());
    });

    // The loop bracket is measured in pixels and `.sp-node` flex-shrinks, so a
    // window resize leaves it spanning the wrong two points until the next param
    // change. The layout handler in main.js runs at module scope, before this
    // object exists, so this rides its own listener rather than that one.
    window.addEventListener('resize', () => this._render());
  }

  /**
   * Draw the audio graph, and the loop through the room if it is closed (§8.6).
   *
   * The row is nodes-and-arrows like the video chain above it; the loop is the
   * one thing that cannot be drawn that way, because it returns from the last
   * node to the first. So it is a bracket UNDER the row, measured from the two
   * node centres it joins.
   *
   * **The label is not measured and the line is.** If the measurement comes back
   * degenerate — the strip is `display:none`, or a float/dock has just moved the
   * display and nothing has re-rendered since — the bracket is skipped and the
   * label still says the loop is closed. A safety marking that silently vanishes
   * when a layout query returns zero is worse than no marking at all, so the two
   * are deliberately not on the same failure.
   */
  _renderAudio() {
    if (!this.el) return;
    const { nodes, loop } = this.audioHost
      ? this.audioHost.describeGraph()
      : { nodes: [], loop: null };
    // The strip grows for the audio row and shrinks back when the engine stops.
    // Set on every render rather than only when the row exists: a class that is
    // only ever added is a strip that never shrinks again.
    document.body.classList.toggle('sp-audio', nodes.length > 0);
    if (!nodes.length) return;

    const row = document.createElement('div');
    row.className = 'sp-audio-row';
    nodes.forEach((n, i) => {
      const el = document.createElement('div');
      if (n.type === 'merge') {
        el.className = 'sp-merge';
        el.textContent = '╱';
      } else {
        el.className = `sp-node ${n.type}`;
        el.textContent = n.label;
        if (n.key) el.dataset.spKey = n.key;
      }
      row.appendChild(el);
      if (i < nodes.length - 1 && n.type !== 'merge' && nodes[i + 1].type !== 'merge') {
        const arrow = document.createElement('div');
        arrow.className = 'sp-arrow';
        arrow.textContent = '→';
        row.appendChild(arrow);
      }
    });

    if (loop) {
      const tag = document.createElement('div');
      tag.className = `sp-loop-tag ${loop.carried ? 'live' : 'idle'}`;
      tag.textContent = loop.label;
      tag.title = loop.title;
      row.appendChild(tag);
    }
    this.el.appendChild(row);

    // After the append, so the offsets are real. Reading layout here costs one
    // synchronous reflow on a render that already rebuilt the whole strip, and
    // this runs on param changes rather than per frame.
    if (loop) {
      const from = row.querySelector(`[data-sp-key="${loop.from}"]`);
      const to   = row.querySelector(`[data-sp-key="${loop.to}"]`);
      if (from && to) {
        const a = to.offsetLeft + to.offsetWidth / 2;
        const b = from.offsetLeft + from.offsetWidth / 2;
        if (b > a) {
          const ret = document.createElement('div');
          ret.className = `sp-loop-return ${loop.carried ? 'live' : 'idle'}`;
          ret.style.left = `${a}px`;
          ret.style.width = `${b - a}px`;
          ret.title = loop.title;
          const head = document.createElement('span');
          head.className = 'sp-loop-head';
          head.textContent = '▲';
          ret.appendChild(head);
          row.appendChild(ret);
        }
      }
    }
  }

  _render() {
    if (!this.el) return;
    const p = this.ps;
    const fgSrc   = p.get('layer.fg').displayValue;
    const bgSrc   = p.get('layer.bg').displayValue;
    const dsSrc   = p.get('layer.ds').displayValue;
    const keyerOn  = p.get('keyer.active').value;
    const extKeyOn = p.get('keyer.extkey').value;
    const displOn  = p.get('displace.amount').value > 0;
    const warpOn   = p.get('displace.warp').value > 0;
    const blendOn  = p.get('blend.active').value;
    // Every gate the pipeline actually applies, and every knob that reaches the
    // prev frame. This used to ask about hor/ver/scale only, so a rig driven by
    // FBZoom or FBRotate alone drew as "no feedback" in the flow — and the
    // Feedback toggle itself, which can switch the whole branch off, was not
    // consulted at all.
    const fbOn     = blendOn &&
      p.get('feedback.active').value &&
      p.get('feedback.mode').value > 0 && (
        p.get('feedback.hor').value !== 0 ||
        p.get('feedback.ver').value !== 0 ||
        p.get('feedback.scale').value !== 0 ||
        p.get('feedback.rotate').value !== 0 ||
        p.get('feedback.zoom').value !== 0 ||
        p.get('feedback.decay').value !== 100 ||
        p.get('feedback.blur').value > 0 ||
        p.get('feedback.hue').value !== 0 ||
        p.get('feedback.mirror').value !== 0
      );
    const csOn      = p.get('output.colorshift').value > 0;
    const fadeOn    = p.get('output.fade').value > 0;
    const fgCCon    = p.get('fg.hue').value !== 0 || p.get('fg.sat').value !== 100 || p.get('fg.bright').value !== 100;
    const bgCCon    = p.get('bg.hue').value !== 0 || p.get('bg.sat').value !== 100 || p.get('bg.bright').value !== 100;
    const chromaOn  = p.get('keyer.chroma').value;
    const strobeOn2 = p.get('effect.strobe').value;

    this.el.innerHTML = '';
    const mainRow = document.createElement('div');
    mainRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    this.el.appendChild(mainRow);

    // Build pre-FX fixed nodes
    const fixedNodes = [
      { label: fgSrc,  type: 'source' },
      ...(fgCCon ? [{ label: 'fg-cc',  type: 'active' }] : []),
      { label: '/',    type: 'merge' },
      { label: bgSrc,  type: 'source' },
      ...(bgCCon ? [{ label: 'bg-cc',  type: 'active' }] : []),
      keyerOn  ? { label: extKeyOn ? 'extkey' : 'keyer', type: 'active' } : { label: 'keyer',    type: 'node' },
      ...(chromaOn ? [{ label: 'chroma', type: 'active' }] : []),
      displOn  ? { label: 'displace', type: 'active' }  : { label: 'displace',  type: 'node' },
      warpOn   ? { label: 'warp',     type: 'active' }  : null,
      { label: dsSrc,  type: 'source' },
      blendOn  ? { label: fbOn ? 'blend+fb' : 'blend', type: 'active' } : { label: 'blend', type: 'node' },
      ...(csOn   ? [{ label: 'cshift',  type: 'active' }] : []),
    ].filter(Boolean);

    // Master bypass: the chain does not run, so the flow must not claim it does.
    // Showing the nodes greyed would be worse than showing none — they are still
    // draggable, and a drag that reorders a chain nobody is running invites
    // exactly the confusion this node exists to prevent. One 'fx bypass' node
    // says what is happening and why the picture is plain.
    const fxEnabled = p.get('effect.enable')?.value !== 0;
    const fxNodes = !fxEnabled ? [{ label: 'fx bypass', type: 'node' }] : this._fxOrder
      .map(fxId => {
        const info = _FX_NODE_INFO[fxId];
        if (!info) return null;
        const active = info.isActive(p, this.pipeline);
        if (!active) return null;
        return { label: info.label, type: 'active', fxId, draggable: true };
      })
      .filter(Boolean);

    // Tail nodes (fixed, not draggable)
    const tailNodes = [
      ...(strobeOn2 ? [{ label: 'strobe', type: 'active' }] : []),
      ...(fadeOn    ? [{ label: 'fade',   type: 'active' }] : []),
      { label: '▶ out', type: 'active' },
    ];

    const allNodes = [...fixedNodes, ...fxNodes, ...tailNodes];

    // ── Sequence rows (below main chain) ──────────────────────────────────
    const seqRowEls = [];
    const SEQ_SRC_OPTIONS = ['Output','Camera','Movie','FG','BG','Buffer','Draw'];
    [1,2,3].forEach(n => {
      const active = p.get(`seq${n}.active`)?.value;
      if (!active) return;
      const srcIdx  = p.get(`seq${n}.source`)?.value ?? 0;
      const speed   = (p.get(`seq${n}.speed`)?.value ?? 100);
      const spdLbl  = speed === 100 ? '1×' : (speed / 100).toFixed(1) + '×';

      const row = document.createElement('div');
      row.className = 'sp-seq-row';

      // Source <select>
      const sel = document.createElement('select');
      sel.className = 'sp-seq-source';
      SEQ_SRC_OPTIONS.forEach((opt, i) => {
        const o = document.createElement('option');
        o.value = i; o.textContent = opt;
        sel.appendChild(o);
      });
      sel.value = srcIdx;
      sel.title = `Seq${n} record source`;
      sel.addEventListener('change', e => {
        p.get(`seq${n}.source`).value = parseInt(e.target.value);
      });
      sel.addEventListener('click', e => e.stopPropagation()); // don't trigger drag etc.

      const arrow1 = document.createElement('span');
      arrow1.className = 'sp-arrow'; arrow1.textContent = '→';

      const recNode = document.createElement('span');
      recNode.className = 'sp-node active';
      recNode.textContent = `seq${n} ⏺`;

      const arrow2 = document.createElement('span');
      arrow2.className = 'sp-arrow'; arrow2.textContent = '→';

      const spdNode = document.createElement('span');
      spdNode.className = 'sp-node active';
      spdNode.textContent = spdLbl;

      row.appendChild(sel);
      row.appendChild(arrow1);
      row.appendChild(recNode);
      row.appendChild(arrow2);
      row.appendChild(spdNode);
      seqRowEls.push(row);
    });

    allNodes.forEach((n, i) => {
      const el = document.createElement('div');
      if (n.type === 'merge') {
        el.className = 'sp-merge';
        el.textContent = '╱';
      } else if (n.label === '▶ out') {
        el.className = 'sp-node active';
        el.textContent = n.label;
      } else {
        el.className = `sp-node ${n.type}`;
        el.textContent = n.label;
        if (n.draggable && n.fxId) {
          el.classList.add('draggable');
          el.draggable = true;
          el.dataset.fxId = n.fxId;
          el.addEventListener('dragstart', e => {
            this._dragSrc = n.fxId;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', n.fxId);
          });
          el.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            el.classList.add('drag-over');
          });
          el.addEventListener('dragleave', () => {
            el.classList.remove('drag-over');
          });
          el.addEventListener('drop', e => {
            e.preventDefault();
            el.classList.remove('drag-over');
            const srcId = this._dragSrc;
            const dstId = n.fxId;
            if (!srcId || srcId === dstId) return;
            // Reorder within this._fxOrder: move srcId to position of dstId
            const newOrder = [...this._fxOrder];
            const srcIdx = newOrder.indexOf(srcId);
            const dstIdx = newOrder.indexOf(dstId);
            if (srcIdx === -1 || dstIdx === -1) return;
            newOrder.splice(srcIdx, 1);
            newOrder.splice(dstIdx, 0, srcId);
            this._fxOrder = newOrder;
            if (this.pipeline) this.pipeline.setFxOrder(newOrder);
            if (this.onOrderChange) this.onOrderChange(newOrder);
            this._render();
          });
          el.addEventListener('dragend', () => {
            this._dragSrc = null;
            this.el.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
          });
        }
      }
      mainRow.appendChild(el);

      if (i < allNodes.length - 1 && n.type !== 'merge' && allNodes[i+1].type !== 'merge') {
        const arrow = document.createElement('div');
        arrow.className = 'sp-arrow';
        arrow.textContent = '→';
        mainRow.appendChild(arrow);
      }
    });

    // The audio graph goes directly under the main chain and ABOVE the sequence
    // rows, and the order is not cosmetic: the strip is 60px and three active
    // sequencers already overflow it. The row that can be clipped without
    // consequence is a sequencer's speed; the row that must not be is the one
    // saying the room is a wire.
    this._renderAudio();

    // Append sequence rows below the main chain
    seqRowEls.forEach(row => this.el.appendChild(row));
  }
}

// ── Context menu for parameter controller assignment ───────────────────────────

export class ContextMenu {
  constructor(ps, controllerManager, presetManager = null, tableManager = null) {
    this.ps      = ps;
    this.ctrl    = controllerManager;
    this.presets = presetManager;
    this.tables  = tableManager;
    this.el      = document.getElementById('param-context-menu');
    this._currentParam = null;
    this._tablePopup   = null;
    this._wire();
  }

  show(param, x, y) {
    // A setup act takes no controller (§8.6), and this menu's whole purpose is
    // assigning one. `assign()` refuses regardless, but offering a menu of
    // controller types that all silently do nothing is worse than offering no
    // menu — it reads as the feature being broken rather than absent.
    if (param?.setup) return;
    this._currentParam = param;
    document.getElementById('ctx-param-label').textContent = param.label;

    // Mark current controller type as active
    this.el.querySelectorAll('.menu-item[data-ctrl]').forEach(btn => {
      btn.classList.toggle('active', param.controller?.type === btn.dataset.ctrl);
    });

    // Populate active xController list
    const xmapList = document.getElementById('ctx-xmap-list');
    if (xmapList) {
      xmapList.innerHTML = '';
      (param.xControllers ?? []).forEach((xc, idx) => {
        if (!xc) return;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:2px;padding:1px 6px;';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'flex:1;font-size:10px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const typeShort = xc.type.replace('lfo-', '').replace('sound-', 'snd-').replace('mouse-', 'm-');
        lbl.textContent = `↪ ${typeShort} → ${xc.target}`;
        lbl.title = `${xc.type} → ${xc.target}${xc.hz ? ' @ ' + xc.hz.toFixed(2) + 'Hz' : ''}`;
        const del = document.createElement('button');
        del.className = 'menu-item';
        del.style.cssText = 'padding:0 5px;font-size:11px;line-height:16px;min-width:0;';
        del.textContent = '×';
        const capturedIdx = idx;
        del.addEventListener('click', e => {
          e.stopPropagation();
          this.ctrl.removeX(param.id, capturedIdx);
          this.hide();
        });
        row.append(lbl, del);
        xmapList.appendChild(row);
      });
    }

    // LFO visualizer — draw waveform preview when param has an LFO controller
    const vizCanvas = document.getElementById('ctx-lfo-viz');
    if (vizCanvas) {
      const lfoEntry = this.ctrl.lfos?.get(param.id);
      if (lfoEntry) {
        vizCanvas.style.display = 'block';
        this._drawLFOViz(vizCanvas, lfoEntry.lfo);
      } else {
        vizCanvas.style.display = 'none';
      }
    }

    // x/y are viewport px (a pointer event); the menu is in the UI-scale zoom
    // set, so writing them straight into style.left paints at x × scale.
    setViewportPos(this.el, x, y);
    this.el.classList.remove('hidden');

    // Clamp to viewport — all four edges, after browser has computed menu size.
    // The whole clamp stays in viewport space: gBCR and innerWidth are both
    // already scaled, so the arithmetic is consistent — only the final write
    // crosses back into the element's own coordinates.
    requestAnimationFrame(() => {
      const r   = this.el.getBoundingClientRect();
      const pad = 4;
      let left = x;
      let top  = y;
      if (left + r.width  > window.innerWidth)  left = x - r.width;
      if (top  + r.height > window.innerHeight) top  = y - r.height;
      left = Math.max(pad, Math.min(left, window.innerWidth  - r.width  - pad));
      top  = Math.max(pad, Math.min(top,  window.innerHeight - r.height - pad));
      setViewportPos(this.el, left, top);
    });
  }

  hide() {
    this.el.classList.add('hidden');
    this._currentParam = null;
  }

  _drawLFOViz(canvas, lfo) {
    const W   = canvas.width;
    const H   = canvas.height;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, W, H);

    // Grid centre line
    ctx.strokeStyle = '#2a2a3a';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    // Waveform — sample 2 full cycles across the canvas width
    ctx.strokeStyle = '#e8c840';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    const cycles = 2;
    for (let px = 0; px <= W; px++) {
      const t   = (px / W) * cycles % 1;
      const val = lfo._sample(t); // 0–1
      const py  = H - val * H;
      px === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Current phase marker
    const cx  = ((lfo._t % 1) / cycles) * W;
    ctx.strokeStyle = '#60a0e0';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, H);
    ctx.stroke();

    // Hz label
    const bpmDiv = this._currentParam?.controller?.bpmDiv;
    // Sub-0.01 Hz rates are legal, so 2 decimals would print them all as "0.00".
    const label  = bpmDiv != null ? `÷${1 / bpmDiv}`
                                  : `${lfo.hz.toFixed(lfo.hz < 0.1 ? 3 : 2)}Hz`;
    ctx.fillStyle = '#9090a8';
    ctx.font      = '9px monospace';
    ctx.fillText(label, 4, H - 4);
  }

  _wire() {
    // Close on the next outside gesture — pointerdown, NOT click. The menu is
    // opened from a `contextmenu` event, and macOS fires that on mousedown for
    // Ctrl+click, then still delivers a `click` on release. Closing on click
    // therefore shut the menu the instant the button came back up, so anyone
    // without a right mouse button (trackpad, Ctrl+click) could never reach an
    // item. The opening gesture's own pointerdown has already been dispatched
    // by the time show() runs, so pointerdown can only mean a NEW gesture.
    // The table picker is a body-appended child of this menu, and its buttons
    // read this._currentParam at CLICK time — hiding on its pointerdown would
    // null the param out from under them and make every table assignment a
    // silent no-op.
    document.addEventListener('pointerdown', e => {
      if (this._tablePopup?.contains(e.target)) return;
      if (!this.el.contains(e.target)) this.hide();
    });

    // Touch scroll safety — the menu is a momentum-scroll region
    // (overflow-y:auto). Scroll-hijacked gestures are inherently safe
    // (pointercancel suppresses the click), but on iOS a tap that STOPS a
    // momentum scroll delivers a click to the item under the finger —
    // which here would assign a controller. Swallow any click arriving
    // within 150ms of scroll activity; capture phase beats item handlers.
    // A normal iPad tap micro-drifts and fires scroll events DURING the tap,
    // so gating on "scroll within 150ms of the click" swallowed every tap.
    // Momentum can only be live BEFORE the finger lands — so sample the
    // scroll clock at pointerdown and swallow only that case.
    this._lastScrollT = 0;
    this._stoppedMomentum = false;
    this.el.addEventListener('scroll',
      () => { this._lastScrollT = performance.now(); }, { passive: true });
    this.el.addEventListener('pointerdown', () => {
      this._stoppedMomentum = performance.now() - this._lastScrollT < 100;
    }, true);
    this.el.addEventListener('click', e => {
      if (this._stoppedMomentum) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    // Controller selection
    this.el.querySelectorAll('.menu-item[data-ctrl]').forEach(btn => {
      // iOS Safari tap handling. Items split into two classes:
      //  - prompt items (lfo-*, fixed, midi-*, key, expr) call window.prompt(),
      //    which iOS only authorizes from an UNTAMPERED native click —
      //    preventDefault()+synthetic click makes prompt() return null
      //    silently. So a valid tap must let the native click through.
      //  - direct-assign items (sound/sensors/gamepad/none) are idempotent;
      //    they get a short-fuse synthetic fallback in case the native click
      //    never arrives (the Phase 11 on-device failure mode). A rare
      //    double-fire is harmless: assign() replaces, and hide() nulls
      //    _currentParam after the first.
      // Drag-guard: a scroll release over an item (>10px) is not a tap; iOS
      // sends no click after a real drag, so returning is sufficient.
      const type = btn.dataset.ctrl;
      const needsPrompt = type.startsWith('lfo-') ||
        ['fixed', 'midi-cc', 'midi-note', 'key', 'expr'].includes(type);
      let _tStart = null;
      let _fallbackTimer = null;
      btn.addEventListener('touchstart', e => {
        _tStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }, { passive: true });
      btn.addEventListener('touchend', e => {
        const t = e.changedTouches[0];
        const moved = _tStart
          ? Math.hypot(t.clientX - _tStart.x, t.clientY - _tStart.y)
          : Infinity;
        _tStart = null;
        if (moved > 10) return; // scroll/drag release — not a tap
        if (!needsPrompt) {
          clearTimeout(_fallbackTimer);
          _fallbackTimer = setTimeout(() => btn.click(), 350);
        }
        // no preventDefault — the native click must stay authorized
      }, { passive: true });
      btn.addEventListener('click', () => clearTimeout(_fallbackTimer), true);
      btn.addEventListener('click', () => {
        if (!this._currentParam) return;
        const type = btn.dataset.ctrl;

        if (type === 'none') {
          // Clear the PAGE, not just the projection. Nulling `controller` alone
          // leaves the page entry holding the binding, so "None" would undo
          // itself the moment the desk changed page — the same trap
          // `unmapMIDI` was written to avoid.
          this.ctrl.setPageBinding(this._currentParam.id, null);
        } else if (type === 'midi-cc') {
          const raw = prompt('MIDI CC — enter CC number, or "ch:cc" to filter by channel\n(e.g. "7" or "1:7")', '7');
          if (raw !== null) {
            const parts = raw.split(':');
            const cc = parseInt(parts.length > 1 ? parts[1] : parts[0]);
            const ch = parts.length > 1 ? parseInt(parts[0]) : 0; // 0 = any channel
            // Typed by hand or learned from the desk, it is the same act and it
            // lands in the same place — the current mapping page. Two doors to
            // one binding that disagreed about where it lives is how a mapping
            // survives a page switch on one route and vanishes on the other.
            if (!isNaN(cc)) this.ctrl.setPageBinding(this._currentParam.id, { type: 'midi-cc', cc, ...(ch > 0 && { channel: ch }) });
          }
        } else if (type === 'midi-note') {
          const raw = prompt('MIDI Note — enter note number, or "ch:note"\n(e.g. "60" or "1:60")', '60');
          if (raw !== null) {
            const parts = raw.split(':');
            const note = parseInt(parts.length > 1 ? parts[1] : parts[0]);
            const ch   = parts.length > 1 ? parseInt(parts[0]) : 0;
            if (!isNaN(note)) this.ctrl.setPageBinding(this._currentParam.id, { type: 'midi-note', note, ...(ch > 0 && { channel: ch }) });
          }
        } else if (type.startsWith('lfo-')) {
          const prev = this._currentParam.controller;
          const prevDefault = prev?.beatSync
            ? `${prev.beatDiv ?? 1}b`
            // `+x.toFixed(4)` drops trailing zeros: 0.001 stays "0.001" where
            // toFixed(2) would prefill "0.00", and 0.5 stays "0.5" rather than
            // "0.500". Pressing OK unchanged must never alter the rate.
            : (prev?.hz != null ? String(+prev.hz.toFixed(4)) : '0.5');
          const hzStr = prompt(
            'LFO rate:\n' +
            '  Hz (free): "0.5"  or  "1.5"  (down to 0.001 = one cycle / ~17 min)\n' +
            '  Beat-sync (locks to BPM): "1b" = 1 beat, "2b" = 2 beats, "0.5b" = half beat\n' +
            '  Append phase (0-1) and width (0-1 for square/sh):\n' +
            '  e.g.  "2b 0.25"  or  "0.5 0 0.3"',
            prevDefault
          );
          if (hzStr === null) { this.hide(); return; }
          const parts = hzStr.trim().split(/\s+/);
          const phase = parseFloat(parts[1] ?? '0');
          const width = parseFloat(parts[2] ?? '0.5');

          // Beat-sync: "Nb" or "N/Mb" suffix
          const beatMatch = parts[0].match(/^([\d./]+)b$/i);
          if (beatMatch) {
            const beatDiv = parseFloat(eval(beatMatch[1])); // "1/4" → 0.25
            const bpm = this.ps.get('global.bpm')?.value ?? 120;
            this.ctrl.assign(this._currentParam.id, {
              type,
              hz:       (bpm / 60) / beatDiv, // approximate hz for display
              beatSync: true,
              beatDiv:  isNaN(beatDiv) ? 1 : beatDiv,
              phase:    isNaN(phase) ? 0 : Math.max(0, Math.min(1, phase)),
              width:    isNaN(width) ? 0.5 : Math.max(0, Math.min(1, width)),
            });
          } else {
            const hz = parseFloat(parts[0]);
            this.ctrl.assign(this._currentParam.id, {
              type,
              // Same 0.001 floor the badge popover enforces; 0 or negative
              // would stall or run the phase backwards.
              hz:    isNaN(hz) ? 0.5 : Math.max(0.001, hz),
              phase: isNaN(phase) ? 0 : Math.max(0, Math.min(1, phase)),
              width: isNaN(width) ? 0.5 : Math.max(0, Math.min(1, width)),
              beatSync: false,
            });
          }
        } else if (type === 'fixed') {
          const v = parseFloat(prompt(`Fixed value (${this._currentParam.min}–${this._currentParam.max}):`,
            this._currentParam.value));
          if (!isNaN(v)) this.ctrl.assign(this._currentParam.id, { type: 'fixed', value: v });
        } else if (type === 'key') {
          const k = prompt('Press a key character (e.g. a, 1, Enter, ArrowUp):', this._currentParam.controller?.key ?? '');
          if (k) this.ctrl.assign(this._currentParam.id, { type: 'key', key: k.trim() });
        } else if (type === 'expr') {
          const p    = this._currentParam;
          const prev = p.controller?.expr ?? `sin(t) * ${(p.max - p.min) / 2} + ${p.min + (p.max - p.min) / 2}`;
          const src  = prompt(
            `Expression controller — result sets param value directly.\n` +
            `Variables: t (time in seconds)\n` +
            `Functions: sin cos tan abs floor ceil round mod fract clamp mix pow sqrt noise\n` +
            `Range: ${p.min} – ${p.max}`,
            p.controller?.expr ?? prev
          );
          if (src !== null) this.ctrl.assign(p.id, { type: 'expr', expr: src.trim() });
        } else {
          // The catch-all: sound, sensors, mouse — and the gamepad, which is a
          // physical binding and so belongs in the current mapping page.
          // `setPageBinding` sorts that out by type; everything else it hands
          // straight to assign(), so one call serves the whole branch.
          this.ctrl.setPageBinding(this._currentParam.id, { type });
        }
        this._currentParam?.notify(); // refresh badge label immediately
        this.hide();
        this.presets?.saveCurrentPreset();
      });
    });

    // Options
    this.el.querySelectorAll('.menu-item[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this._currentParam) return;
        const action = btn.dataset.action;
        if (action === 'invert') {
          this._currentParam.invert = !this._currentParam.invert;
          this.hide();
        }
        if (action === 'lock') {
          this._currentParam.locked = !this._currentParam.locked;
          this.hide();
          // Visual indicator on param row
          const row = document.querySelector(`[data-param-id="${this._currentParam.id}"]`);
          row?.classList.toggle('param-locked', this._currentParam.locked);
        }
        if (action === 'show') {
          this._currentParam.feedbackVisible = !this._currentParam.feedbackVisible;
          this.ps.dispatchEvent(new CustomEvent('feedbackToggled', { detail: this._currentParam }));
          this.hide();
        }
        if (action === 'table') {
          this._showTablePicker(btn);
        }
        if (action === 'midi-learn') {
          const paramId = this._currentParam.id;
          this.hide();
          this.ctrl.startMIDILearn(paramId);
        }
        if (action === 'osc-learn') {
          const paramId = this._currentParam.id;
          this.hide();
          this.ctrl.startOSCLearn?.(paramId);
        }
        if (action === 'gamepad-learn') {
          const paramId = this._currentParam.id;
          this.hide();
          this.ctrl.startGamepadLearn?.(paramId);
        }
        if (action === 'slew') {
          const p   = this._currentParam;
          const cur = `${p.slew?.toFixed(3) ?? '0'}${p.slewShape === 'ease' ? ' ease' : ''}`;
          const raw = prompt(
            'Slew time (seconds, 0=instant):\n0.01=very fast, 0.1=smooth, 0.5=slow, 1=very slow\n\n' +
            'Append a curve, e.g. "0.4 bounce":\n' +
            '  any source      lag (default) · ease · elastic\n' +
            '  stepped sources ease2 · expo · bounce · back\n' +
            '(the stepped curves can overshoot; on a sweeping LFO they ripple)\n' +
            'After "elastic" you may add strength and damp: "0.4 elastic 1.5 0.3"',
            cur
          );
          if (raw !== null) {
            const parts = raw.trim().split(/\s+/);
            const v = parseFloat(parts[0]);
            if (!isNaN(v)) {
              p.slew = Math.max(0, v);
              // Unknown word → leave the curve alone rather than silently
              // resetting it to lag, which is what a typo used to do.
              const word = (parts[1] ?? '').toLowerCase();
              if (SLEW_SHAPES.includes(word)) p.slewShape = word;
              const st = parseFloat(parts[2]);
              const dp = parseFloat(parts[3]);
              if (!isNaN(st)) p.slewStrength = Math.max(0.25, Math.min(4, st));
              if (!isNaN(dp)) p.slewDamp = Math.max(0.05, Math.min(1, dp));
              this.hide();
            }
          }
        }
        if (action === 'xmap-hz' || action === 'xmap-amp' || action === 'xmap-value') {
          const target = action === 'xmap-hz' ? 'hz' : action === 'xmap-amp' ? 'amp' : 'value';
          const targetLabel = { hz: 'LFO Hz', amp: 'Amplitude (VCA)', value: 'Value (override)' }[target];
          const typeStr = prompt(
            `X-Map: ${targetLabel}\n\n` +
            'Controller type (+ optional Hz):\n' +
            '  lfo-sine 0.5   lfo-triangle 2   lfo-sawtooth\n' +
            '  lfo-square 1   lfo-sh 0.25\n' +
            '  sound  sound-bass  sound-mid  sound-high\n' +
            '  mouse-x  mouse-y  random 4' +
            (target === 'hz'
              ? `\n\nSweeps the target LFO ${XMAP_HZ_MIN}–${XMAP_HZ_MAX} Hz, logarithmically\n` +
                '(mid-travel ≈ 0.14 Hz). The Hz above is this mapper\'s own rate.'
              : ''),
            'lfo-sine 0.5'
          );
          if (typeStr === null) { this.hide(); return; }
          const parts = typeStr.trim().split(/\s+/);
          const type  = parts[0];
          const hz    = parseFloat(parts[1] ?? '0.5');
          const xIdx  = (this._currentParam.xControllers ?? []).length;
          this.ctrl.assignX(this._currentParam.id, xIdx, {
            type,
            hz:     isNaN(hz) ? 0.5 : hz,
            target,
          });
          this.hide();
          this.presets?.saveCurrentPreset();
        }
        if (action === 'xmap-clear') {
          const p = this._currentParam;
          const id = p.id;
          p.xControllers.forEach((_, idx) => this.ctrl._xLFOs.delete(`${id}:${idx}`));
          p.xControllers = [];
          this.hide();
          this.presets?.saveCurrentPreset();
        }
      });
    });
  }

  _showTablePicker(anchorBtn) {
    // Remove existing popup
    this._tablePopup?.remove();

    const popup = document.createElement('div');
    popup.className = 'table-picker';
    document.body.appendChild(popup);
    this._tablePopup = popup;

    const names = this.tables ? this.tables.getNames() : [];

    // "None" option
    const noneBtn = document.createElement('button');
    noneBtn.className = 'menu-item' + (!this._currentParam?.table ? ' active' : '');
    noneBtn.textContent = '— None —';
    noneBtn.addEventListener('click', () => {
      if (this._currentParam) this._currentParam.table = null;
      popup.remove(); this.hide();
    });
    popup.appendChild(noneBtn);

    // "Follow global slot" option
    const globalBtn = document.createElement('button');
    globalBtn.className = 'menu-item' + (this._currentParam?.table === 'global' ? ' active' : '');
    globalBtn.textContent = '⟳ Follow global slot';
    globalBtn.style.cssText = 'border-top:1px solid var(--border);margin-top:2px;padding-top:4px;color:var(--accent);';
    globalBtn.addEventListener('click', () => {
      if (this._currentParam) this._currentParam.table = 'global';
      popup.remove(); this.hide();
    });
    popup.appendChild(globalBtn);

    names.forEach(name => {
      const btn = document.createElement('button');
      btn.className = 'menu-item' + (this._currentParam?.table === name ? ' active' : '');
      btn.textContent = name;
      btn.addEventListener('click', () => {
        if (this._currentParam) this._currentParam.table = name;
        popup.remove(); this.hide();
      });
      popup.appendChild(btn);
    });

    // Position next to anchor
    const r = anchorBtn.getBoundingClientRect();
    popup.style.cssText = `position:fixed;left:${r.right + 4}px;top:${r.top}px;z-index:3000;
      background:var(--bg-3);border:1px solid var(--border-hi);border-radius:4px;padding:4px;
      box-shadow:0 4px 12px rgba(0,0,0,.5);min-width:110px;`;

    // Close on outside click
    const closeHandler = e => {
      if (!popup.contains(e.target) && e.target !== anchorBtn) {
        popup.remove();
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
  }
}

// ── Feedback overlay (floating parameter values on output canvas) ─────────────

export class FeedbackOverlay {
  constructor(ps) {
    this.ps = ps;
    this.el = document.getElementById('feedback-overlay');
    this.items = new Map(); // paramId → element
    this._nextY = 8;       // auto-stagger Y for default positions

    // Add initially visible items
    ps.getAll().forEach(p => {
      if (!p.feedbackVisible) return;
      this._addItem(p);
    });

    // Wire value updates for all params (even hidden ones — they may become visible)
    ps.getAll().forEach(p => {
      p.onChange(() => this._updateItem(p));
    });

    // Listen for feedbackVisible toggling from context menu
    ps.addEventListener('feedbackToggled', e => {
      const p = e.detail;
      if (p.feedbackVisible && !this.items.has(p.id)) {
        this._addItem(p);
      } else if (!p.feedbackVisible && this.items.has(p.id)) {
        this._removeItem(p);
      }
    });
  }

  _addItem(p) {
    // Auto-stagger if position is still the default
    if (p.feedbackPos.x === 20 && p.feedbackPos.y === 60) {
      p.feedbackPos = { x: 8, y: this._nextY };
    }
    this._nextY += 18;

    const el = document.createElement('div');
    el.className = 'feedback-item';
    el.style.left = `${p.feedbackPos.x}px`;
    el.style.top  = `${p.feedbackPos.y}px`;
    el.textContent = `${p.label}: ${p.displayValue}`;
    this.el.appendChild(el);
    this.items.set(p.id, el);
    this._makeDraggable(el, p);
  }

  _removeItem(p) {
    const el = this.items.get(p.id);
    if (el) {
      el.remove();
      this.items.delete(p.id);
    }
  }

  _updateItem(p) {
    const el = this.items.get(p.id);
    if (el) el.textContent = `${p.label}: ${p.displayValue}`;
  }

  _makeDraggable(el, p) {
    let ox = 0, oy = 0;
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      const parentRect = this.el.getBoundingClientRect();
      ox = e.clientX - (rect.left - parentRect.left);
      oy = e.clientY - (rect.top  - parentRect.top);
      e.stopPropagation();
    });
    el.addEventListener('pointermove', e => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const x = e.clientX - ox;
      const y = e.clientY - oy;
      el.style.left = `${x}px`;
      el.style.top  = `${y}px`;
      p.feedbackPos = { x, y };
    });
    el.addEventListener('pointerup', () => {});
  }
}

// ── Project panel (States list + Bank selector) ───────────────────────────────

export class MemoryPanel {
  constructor(presetManager, sceneManager = null) {
    this.pm = presetManager;
    this.sm = sceneManager;
    this.listEl = document.getElementById('memory-state-list');
    this._captureThumbFn = null;
    this._build();
    this._wireBankControls();
    this._wireImportState();
    this._wireSaveButtons();
    this._buildBankList();
    this.pm.addEventListener('presetActivated', () => { this._build(); this._updateBankName(); this._buildBankList(); });
    this.pm.addEventListener('stateSaved',      () => this._build());
    this.pm.addEventListener('stateRecalled',   () => this._build());
    this.pm.addEventListener('bankRenamed',     () => { this._updateBankName(); this._buildBankList(); });
    this._updateBankName();
  }

  _updateBankName() {
    const el = document.getElementById('current-bank-name');
    if (el) el.textContent = this.pm.current?.name || `Bank ${this.pm.currentIdx + 1}`;
  }

  _build() {
    if (!this.listEl) return;
    this._updateBankName();
    this.listEl.innerHTML = '';
    const bank = this.pm.current;
    if (!bank) return;
    const occupied = bank.states
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !!s);
    if (!occupied.length) {
      const empty = document.createElement('div');
      empty.className = 'memory-empty';
      empty.textContent = 'No states saved in this bank.';
      this.listEl.appendChild(empty);
      return;
    }
    occupied.forEach(({ s: state, i }) => {
      const row = document.createElement('div');
      row.className = 'memory-state-row' + (bank.activeState === i ? ' active' : '');

      const thumb = document.createElement('div');
      thumb.className = 'memory-state-thumb';
      if (state.thumbnail) thumb.style.backgroundImage = `url(${state.thumbnail})`;
      thumb.title = 'Click to capture thumbnail';
      thumb.addEventListener('click', () => this._captureStateThumb(i));
      row.appendChild(thumb);

      const num = document.createElement('span');
      num.className = 'memory-state-num';
      num.textContent = i + 1;
      row.appendChild(num);

      const name = document.createElement('span');
      name.className = 'memory-state-name';
      name.textContent = state.name || `State ${i + 1}`;
      name.title = 'Click to rename';
      name.addEventListener('click', () => this._startRename(name, state, bank));
      row.appendChild(name);

      const recallBtn = document.createElement('button');
      recallBtn.className = 'memory-state-btn';
      recallBtn.textContent = '▶';
      recallBtn.title = `Recall State ${i + 1}`;
      recallBtn.addEventListener('click', () => this.pm.recallState(i));
      row.appendChild(recallBtn);

      const exportBtn = document.createElement('button');
      exportBtn.className = 'memory-state-btn';
      exportBtn.textContent = '⬇';
      exportBtn.title = `Export State ${i + 1} as .imstate`;
      exportBtn.addEventListener('click', () => {
        const data = this.pm.exportState(i);
        if (!data) return;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (state.name || `State-${i + 1}`) + '.imstate';
        a.click();
        URL.revokeObjectURL(a.href);
      });
      row.appendChild(exportBtn);

      const clearBtn = document.createElement('button');
      clearBtn.className = 'memory-state-btn memory-state-btn--danger';
      clearBtn.textContent = '✕';
      clearBtn.title = `Delete State ${i + 1}`;
      clearBtn.addEventListener('click', async () => {
        bank.removeState(i);
        await bank.save?.();
        this.pm.dispatchEvent(new CustomEvent('stateSaved',
          { detail: { presetIndex: this.pm.currentIdx, stateIndex: i } }));
      });
      row.appendChild(clearBtn);

      this.listEl.appendChild(row);
    });
  }

  _wireSaveButtons() {
    const toast = msg => this.pm.dispatchEvent(new CustomEvent('toast', { detail: { msg } }));

    document.getElementById('btn-save-bank')?.addEventListener('click', async () => {
      await this.pm.saveCurrentBank();
      toast(`✓ "${this.pm.current?.name}" saved`);
    });

    document.getElementById('btn-saveas-bank')?.addEventListener('click', async () => {
      const src = this.pm.current;
      if (!src) return;
      const newName = prompt('Name for new bank:', src.name + ' copy');
      if (newName === null) return;
      await this.pm.saveAsBank(newName.trim() || src.name + ' copy');
      toast(`✓ Bank saved as "${newName}"`);
    });
  }

  _buildBankList() {
    const el = document.getElementById('bank-list');
    if (!el) return;
    el.innerHTML = '';
    this.pm.presets.forEach((bank, i) => {
      if (!bank) return;
      const row = document.createElement('div');
      row.className = 'bank-list-item' + (i === this.pm.currentIdx ? ' active' : '');

      const name = document.createElement('span');
      name.className = 'bank-list-name';
      name.textContent = bank.name || `Bank ${i + 1}`;
      name.title = 'Click to rename';
      name.addEventListener('click', () => this._startBankListRename(name, bank, i));
      row.appendChild(name);

      const switchBtn = document.createElement('button');
      switchBtn.className = 'bank-list-switch';
      switchBtn.textContent = '▶';
      switchBtn.title = 'Switch to this bank';
      switchBtn.addEventListener('click', () => this.pm.activatePreset(i));
      row.appendChild(switchBtn);

      el.appendChild(row);
    });
  }

  _startBankListRename(span, bank, i) {
    const orig = bank.name || `Bank ${i + 1}`;
    const inp = document.createElement('input');
    inp.className = 'bank-list-name-input';
    inp.value = orig;
    span.replaceWith(inp);
    inp.focus(); inp.select();
    const commit = () => this.pm.renameBank(i, inp.value.trim() || orig);
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.value = orig; inp.blur(); }
    });
  }

  _wireBankControls() {
    const toast = msg => this.pm.dispatchEvent(new CustomEvent('toast', { detail: { msg } }));

    document.getElementById('btn-new-bank')?.addEventListener('click', async () => {
      await this.pm.createBank();
    });

    document.getElementById('btn-export-bank')?.addEventListener('click', () => {
      const bank = this.pm.current;
      if (!bank) return;
      const data = bank.exportBank(this.sm?.currentModelUrl ?? null);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (bank.name || 'Bank') + '.imbank';
      a.click();
      URL.revokeObjectURL(a.href);
    });

    document.getElementById('btn-import-bank')?.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.imbank,application/json';
      inp.addEventListener('change', async () => {
        const file = inp.files[0]; if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          if (data.__type !== 'imbank') { toast('⚠ Not a valid .imbank file'); return; }
          const { Preset: P } = await import('../state/Preset.js');
          const idx = this.pm.presets.length;
          const bank = P.importBank(data, idx);
          this.pm.presets[idx] = bank;
          await bank.save();
          await this.pm.activatePreset(idx);
          if (data.modelAsset && this.sm) await this.sm.loadModelFromUrl(data.modelAsset);
          toast(`✓ Bank "${bank.name}" imported`);
        } catch (err) { toast('⚠ Import failed: ' + err.message); }
      });
      inp.click();
    });

    document.getElementById('btn-delete-bank')?.addEventListener('click', async () => {
      const bank = this.pm.current;
      if (!bank) return;
      if (this.pm.presets.filter(Boolean).length <= 1) {
        toast('⚠ Cannot delete the last bank'); return;
      }
      if (!confirm(`Delete bank "${bank.name}" and all its states?`)) return;
      const idx = this.pm.currentIdx;
      this.pm.presets[idx] = null;
      const { openDB } = await import('../state/Preset.js');
      const db = await openDB();
      await new Promise(res => {
        const tx = db.transaction('banks', 'readwrite');
        tx.objectStore('banks').delete(idx);
        tx.oncomplete = res;
      });
      const nextIdx = this.pm.presets.findIndex(Boolean);
      if (nextIdx >= 0) await this.pm.activatePreset(nextIdx);
      toast(`✓ Bank deleted`);
    });
  }

  _wireImportState() {
    const toast = msg => this.pm.dispatchEvent(new CustomEvent('toast', { detail: { msg } }));
    document.getElementById('btn-import-state')?.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.imstate,application/json';
      inp.addEventListener('change', async () => {
        const file = inp.files[0]; if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          if (data.__type !== 'imstate') { toast('⚠ Not a valid .imstate file'); return; }
          const slotIdx = this.pm.importState(data, null);
          const bank = this.pm.current;
          await bank?.save();
          this.pm.dispatchEvent(new CustomEvent('stateSaved',
            { detail: { presetIndex: this.pm.currentIdx, stateIndex: slotIdx } }));
          toast(`✓ State imported into slot ${slotIdx + 1}`);
        } catch (err) { toast('⚠ Import failed: ' + err.message); }
      });
      inp.click();
    });
  }

  _captureStateThumb(stateIdx) {
    if (!this._captureThumbFn) return;
    const bank = this.pm.current;
    if (!bank?.states[stateIdx]) return;
    bank.states[stateIdx].thumbnail = this._captureThumbFn();
    bank.save?.();
    this._build();
  }

  _startRename(span, state, bank) {
    const orig = state.name || span.textContent;
    const inp = document.createElement('input');
    inp.className = 'memory-state-name-input';
    inp.value = orig;
    span.replaceWith(inp);
    inp.focus(); inp.select();
    const commit = () => {
      state.name = inp.value.trim() || orig;
      bank.save?.();
      this._build();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { state.name = orig; inp.blur(); }
    });
  }

  _refresh() { this._build(); }
}

// ── Tables editor ────────────────────────────────────────────────────────────

// ── Bézier curve presets (normalized 0-1 anchor coordinates) ─────────────────
// Each entry: [{x,y,rx?,ry?,lx?,ly?,smooth}, ...]
// First anchor: rx/ry = outgoing handle. Last: lx/ly = incoming handle.
const _BEZIER_PRESETS = {
  'Linear':   [ {x:0,y:0,rx:1/3,ry:1/3,smooth:true}, {x:1,y:1,lx:2/3,ly:2/3,smooth:true} ],
  'Ease In':  [ {x:0,y:0,rx:0.42,ry:0,  smooth:true}, {x:1,y:1,lx:0.75,ly:0.5,smooth:true} ],
  'Ease Out': [ {x:0,y:0,rx:0.25,ry:0.5,smooth:true}, {x:1,y:1,lx:0.58,ly:1,  smooth:true} ],
  'S-Curve':  [ {x:0,y:0,rx:0.42,ry:0,  smooth:true}, {x:1,y:1,lx:0.58,ly:1,  smooth:true} ],
  'Exp':      [ {x:0,y:0,rx:0.55,ry:0,  smooth:true}, {x:1,y:1,lx:0.9, ly:0.35,smooth:true} ],
  'Log':      [ {x:0,y:0,rx:0.1, ry:0.65,smooth:true},{x:1,y:1,lx:0.45,ly:1,  smooth:true} ],
  'Invert':   [ {x:0,y:1,rx:1/3,ry:2/3,smooth:true}, {x:1,y:0,lx:2/3,ly:1/3,smooth:true} ],
  'Step': [
    {x:0,    y:0, rx:0.495, ry:0,  smooth:false},
    {x:0.497,y:0, lx:0.492,ly:0,  rx:0.498,ry:0,  smooth:false},
    {x:0.503,y:1, lx:0.502,ly:1,  rx:0.508,ry:1,  smooth:false},
    {x:1,    y:1, lx:0.505,ly:1,  smooth:false},
  ],
};

export class TablesEditor {
  constructor(tableManager, ps = null, ctrl = null, contextMenu = null) {
    this.tm          = tableManager;
    this.ps          = ps;
    this.ctrl        = ctrl;
    this.contextMenu = contextMenu;
    this.canvas  = document.getElementById('table-editor');
    this.listEl  = document.getElementById('tables-list');
    this._current = null;
    this._anchors = [];           // current Bézier anchors (for user tables)
    this._drag    = null;         // active drag: {type,idx,origAnchors}
    this._HIT_R   = 8;            // anchor hit radius (canvas px)
    this._HDL_R   = 6;            // handle hit radius (canvas px)

    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');

    this._buildList();
    this._buildPresets();
    this._wireCanvas();
    this._wireHeader();
    this.tm.addEventListener('change', () => this._buildList());
  }

  // ── Header right-click → controller popover for global.tableSlot ─────────

  _wireHeader() {
    const hdr = document.getElementById('tables-section-header');
    if (!hdr || !this.ps || !this.contextMenu) return;
    hdr.style.cursor = 'context-menu';
    hdr.title = 'Right-click to assign a controller (MIDI, LFO…) to the global Table Slot';

    hdr.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const param = this.ps.get('global.tableSlot');
      if (!param) return;
      // Open the full context menu so the user can pick MIDI Learn, LFO, etc.
      this.contextMenu.show(param, e.clientX, e.clientY);
    });
  }

  // ── Coord helpers ────────────────────────────────────────────────────────

  get _W() { return this.canvas.width;  }
  get _H() { return this.canvas.height; }
  _nx(cx) { return cx / this._W; }
  _ny(cy) { return 1 - cy / this._H; }
  _cx(nx) { return nx * this._W; }
  _cy(ny) { return (1 - ny) * this._H; }

  // ── List ─────────────────────────────────────────────────────────────────

  _buildList() {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';

    this.tm.getNames().forEach((name, idx) => {
      const row = document.createElement('div');
      row.className = 'table-list-row' + (name === this._current ? ' active' : '');

      const idxEl = document.createElement('span');
      idxEl.textContent = idx;
      idxEl.style.cssText = 'font-size:10px;color:var(--text-2);min-width:18px;text-align:right;margin-right:5px;font-family:var(--mono);';
      row.appendChild(idxEl);

      const lbl = document.createElement('span');
      lbl.textContent = name;
      lbl.style.cssText = 'flex:1;font-size:11px;cursor:pointer;';
      lbl.addEventListener('click', () => this._select(name));
      row.appendChild(lbl);

      if (!this.tm.isBuiltin(name)) {
        const del = document.createElement('button');
        del.textContent = '✕';
        del.style.cssText = 'font-size:10px;padding:0 4px;background:none;border:none;color:var(--text-2);cursor:pointer;';
        del.title = 'Delete table';
        del.addEventListener('click', e => {
          e.stopPropagation();
          if (this._current === name) { this._current = null; this._anchors = []; this._draw(); }
          this.tm.delete(name);
        });
        row.appendChild(del);
      }
      this.listEl.appendChild(row);
    });

    const newBtn = document.createElement('button');
    newBtn.className = 'import-btn';
    newBtn.textContent = '+ New Table';
    newBtn.style.cssText = 'margin:6px 0;width:100%;';
    newBtn.addEventListener('click', () => {
      const name = prompt('Table name:', `curve-${Date.now().toString(36).slice(-4)}`);
      if (!name) return;
      const curve = ResponseCurve.fromBezier(ResponseCurve.linearAnchors());
      this.tm.set(name, curve);
      this._select(name);
    });
    this.listEl.appendChild(newBtn);

    if (this._current) this._draw();
  }

  // ── Preset strip ─────────────────────────────────────────────────────────

  _buildPresets() {
    const strip = document.createElement('div');
    strip.id = 'table-preset-strip';
    Object.entries(_BEZIER_PRESETS).forEach(([label, anchors]) => {
      const btn = document.createElement('button');
      btn.className = 'table-preset-btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (!this._current || this.tm.isBuiltin(this._current)) return;
        this._anchors = JSON.parse(JSON.stringify(anchors));
        this._bakeAndSave();
        this._draw();
      });
      strip.appendChild(btn);
    });
    this.canvas?.parentElement?.insertBefore(strip, this.canvas);
    this._presetStrip = strip;
    this._syncPresetStrip();
  }

  _syncPresetStrip() {
    if (!this._presetStrip) return;
    const editable = !!(this._current && !this.tm.isBuiltin(this._current));
    this._presetStrip.querySelectorAll('.table-preset-btn').forEach(b => {
      b.disabled = !editable;
    });
  }

  // ── Select ────────────────────────────────────────────────────────────────

  _select(name) {
    this._current = name;
    this._drag    = null;
    const curve   = this.tm.get(name);

    if (!this.tm.isBuiltin(name)) {
      // User table: use saved control points or default to linear
      this._anchors = curve?.controlPoints
        ? JSON.parse(JSON.stringify(curve.controlPoints))
        : ResponseCurve.linearAnchors();
    } else {
      this._anchors = []; // built-in: display only, no editing
    }

    this._buildList();
    this._syncPresetStrip();
    this._draw();
  }

  // ── Draw ──────────────────────────────────────────────────────────────────

  _draw() {
    if (!this.ctx) return;
    const ctx = this.ctx, W = this._W, H = this._H;

    // Background
    ctx.fillStyle = '#0d0d14';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = '#1e1e2e';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const x = Math.round(W * i / 4) + 0.5, y = Math.round(H * i / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Linear reference diagonal
    ctx.strokeStyle = '#262636';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.stroke();
    ctx.setLineDash([]);

    if (!this._current) return;
    const isBuiltin = this.tm.isBuiltin(this._current);

    if (this._anchors.length >= 2 && !isBuiltin) {
      this._drawBezierPath();
      this._drawHandles();
      this._drawAnchors();
    } else if (isBuiltin) {
      this._drawLUT();
    }
  }

  _drawBezierPath() {
    const ctx = this.ctx, a = this._anchors;
    ctx.strokeStyle = '#e8c840';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this._cx(a[0].x), this._cy(a[0].y));
    for (let i = 0; i < a.length - 1; i++) {
      const a0 = a[i], a1 = a[i + 1];
      const span = a1.x - a0.x;
      const p1x = a0.rx ?? (a0.x + span / 3), p1y = a0.ry ?? a0.y;
      const p2x = a1.lx ?? (a1.x - span / 3), p2y = a1.ly ?? a1.y;
      ctx.bezierCurveTo(
        this._cx(p1x), this._cy(p1y),
        this._cx(p2x), this._cy(p2y),
        this._cx(a1.x), this._cy(a1.y),
      );
    }
    ctx.stroke();
  }

  _drawHandles() {
    const ctx = this.ctx, a = this._anchors;
    ctx.strokeStyle = 'rgba(150,150,180,0.45)';
    ctx.fillStyle   = 'rgba(160,160,200,0.85)';
    ctx.lineWidth   = 1;
    for (let i = 0; i < a.length; i++) {
      const ax = this._cx(a[i].x), ay = this._cy(a[i].y);
      if (i > 0 && a[i].lx != null) {
        const hx = this._cx(a[i].lx), hy = this._cy(a[i].ly);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, Math.PI * 2); ctx.fill();
      }
      if (i < a.length - 1 && a[i].rx != null) {
        const hx = this._cx(a[i].rx), hy = this._cy(a[i].ry);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  _drawAnchors() {
    const ctx = this.ctx, a = this._anchors;
    for (let i = 0; i < a.length; i++) {
      const ax = this._cx(a[i].x), ay = this._cy(a[i].y);
      ctx.beginPath();
      ctx.arc(ax, ay, 5, 0, Math.PI * 2);
      ctx.fillStyle   = (i === 0 || i === a.length - 1) ? '#e8c840' : '#ffffff';
      ctx.strokeStyle = '#0d0d14';
      ctx.lineWidth   = 1.5;
      ctx.fill(); ctx.stroke();
    }
  }

  _drawLUT() {
    const ctx = this.ctx, W = this._W, H = this._H;
    const curve = this.tm.get(this._current);
    if (!curve) return;
    ctx.strokeStyle = '#e8c840';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const steps = 256;
    for (let i = 0; i < steps; i++) {
      const x = i / (steps - 1);
      const y = curve.apply(x);
      i === 0 ? ctx.moveTo(x * W, (1 - y) * H) : ctx.lineTo(x * W, (1 - y) * H);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(136,136,160,0.55)';
    ctx.font = '10px monospace';
    ctx.fillText('built-in (read-only)', 6, H - 6);
  }

  // ── Canvas interaction ────────────────────────────────────────────────────

  _wireCanvas() {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (!this._current || this.tm.isBuiltin(this._current)) return;

      const [cx, cy] = this._toCvs(e);
      const hit = this._hitTest(cx, cy);
      if (hit) {
        this._drag = { ...hit, origAnchors: JSON.parse(JSON.stringify(this._anchors)) };
      } else {
        const nx = Math.max(0.01, Math.min(0.99, this._nx(cx)));
        const ny = Math.max(0,    Math.min(1,    this._ny(cy)));
        this._addAnchor(nx, ny);
        this._bakeAndSave();
        this._draw();
      }
    });

    canvas.addEventListener('pointermove', e => {
      if (!this._drag) return;
      const [cx, cy] = this._toCvs(e);
      this._applyDrag(this._nx(cx), this._ny(cy));
      this._draw();
    });

    canvas.addEventListener('pointerup', () => {
      if (this._drag) { this._drag = null; this._bakeAndSave(); }
    });

    // Right-click anchor → delete (not first/last)
    canvas.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!this._current || this.tm.isBuiltin(this._current)) return;
      const [cx, cy] = this._toCvs(e);
      const hit = this._hitTest(cx, cy);
      if (hit?.type === 'anchor' && hit.idx > 0 && hit.idx < this._anchors.length - 1) {
        this._anchors.splice(hit.idx, 1);
        this._bakeAndSave();
        this._draw();
      }
    });

    // Double-click anchor → toggle smooth/corner
    canvas.addEventListener('dblclick', e => {
      if (!this._current || this.tm.isBuiltin(this._current)) return;
      const [cx, cy] = this._toCvs(e);
      const hit = this._hitTest(cx, cy);
      if (hit?.type === 'anchor') {
        this._anchors[hit.idx].smooth = !this._anchors[hit.idx].smooth;
        this._draw();
      }
    });
  }

  // Convert pointer event to canvas pixel coords (accounting for CSS scaling)
  _toCvs(e) {
    const r = this.canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (this._W / r.width),
      (e.clientY - r.top)  * (this._H / r.height),
    ];
  }

  _hitTest(cx, cy) {
    const a = this._anchors;
    for (let i = 0; i < a.length; i++) {
      if (Math.hypot(cx - this._cx(a[i].x), cy - this._cy(a[i].y)) <= this._HIT_R)
        return { type: 'anchor', idx: i };
    }
    for (let i = 0; i < a.length; i++) {
      if (i > 0 && a[i].lx != null) {
        if (Math.hypot(cx - this._cx(a[i].lx), cy - this._cy(a[i].ly)) <= this._HDL_R)
          return { type: 'lh', idx: i };
      }
      if (i < a.length - 1 && a[i].rx != null) {
        if (Math.hypot(cx - this._cx(a[i].rx), cy - this._cy(a[i].ry)) <= this._HDL_R)
          return { type: 'rh', idx: i };
      }
    }
    return null;
  }

  _applyDrag(nx, ny) {
    const { type, idx, origAnchors } = this._drag;
    const a = this._anchors, orig = origAnchors[idx];

    if (type === 'anchor') {
      let newX;
      if (idx === 0)                 newX = 0;
      else if (idx === a.length - 1) newX = 1;
      else newX = Math.max(a[idx-1].x + 0.01, Math.min(a[idx+1].x - 0.01, nx));

      const newY = Math.max(0, Math.min(1, ny));
      const dx = newX - orig.x, dy = newY - orig.y;
      a[idx].x = newX; a[idx].y = newY;
      if (orig.lx != null) { a[idx].lx = orig.lx + dx; a[idx].ly = orig.ly + dy; }
      if (orig.rx != null) { a[idx].rx = orig.rx + dx; a[idx].ry = orig.ry + dy; }

    } else if (type === 'lh') {
      a[idx].lx = nx; a[idx].ly = ny;
      if (a[idx].smooth && a[idx].rx != null) {
        a[idx].rx = 2 * a[idx].x - nx;
        a[idx].ry = 2 * a[idx].y - ny;
      }
    } else if (type === 'rh') {
      a[idx].rx = nx; a[idx].ry = ny;
      if (a[idx].smooth && a[idx].lx != null) {
        a[idx].lx = 2 * a[idx].x - nx;
        a[idx].ly = 2 * a[idx].y - ny;
      }
    }
  }

  _addAnchor(nx, ny) {
    // Reject if too close to existing anchor
    if (this._anchors.some(a => Math.abs(a.x - nx) < 0.03)) return;
    const insertIdx = this._anchors.findIndex(a => a.x > nx);
    const idx = insertIdx === -1 ? this._anchors.length - 1 : insertIdx;
    const prev = this._anchors[idx - 1] ?? this._anchors[0];
    const next = this._anchors[idx]     ?? this._anchors[this._anchors.length - 1];
    const hspan = (next.x - prev.x) / 4;
    this._anchors.splice(idx, 0, {
      x: nx, y: ny,
      lx: nx - hspan, ly: ny,
      rx: nx + hspan, ry: ny,
      smooth: true,
    });
  }

  _bakeAndSave() {
    if (!this._current || this.tm.isBuiltin(this._current)) return;
    if (this._anchors.length < 2) return;
    this.tm.set(this._current, ResponseCurve.fromBezier(this._anchors));
  }
}

// ── Debug overlay ─────────────────────────────────────────────────────────────

export class DebugOverlay {
  constructor(ps) {
    this.ps  = ps;
    this.el  = null;
    this._fps = 0;
    this._frames = 0;
    this._last = performance.now();
    this._create();
  }

  _create() {
    const el = document.createElement('div');
    el.id = 'debug-overlay';
    el.style.cssText = [
      'position:absolute', 'top:8px', 'left:8px',
      'background:rgba(0,0,0,0.65)', 'color:#0f0',
      'font-family:monospace', 'font-size:11px',
      'line-height:1.5', 'padding:6px 10px',
      'border-radius:4px', 'pointer-events:none',
      'white-space:pre', 'z-index:50', 'display:none',
    ].join(';');
    document.getElementById('canvas-wrap')?.appendChild(el);
    this.el = el;
  }

  tick(fps) {
    const p = this.ps;
    const active = p.get('global.debug')?.value;
    if (!this.el) return;
    this.el.style.display = active ? 'block' : 'none';
    if (!active) return;

    const SNAMES = ['CAM','MOV','BUF','COL','NSE','3D','DRW','OUT','BG1','BG2','COL2','TXT','SND','DEL','SCO','SLI','PAR'];
    const fg  = SNAMES[p.get('layer.fg')?.value] ?? '?';
    const bg  = SNAMES[p.get('layer.bg')?.value] ?? '?';
    const ds  = SNAMES[p.get('layer.ds')?.value] ?? '?';
    const warp = p.get('displace.warp')?.options?.[p.get('displace.warp')?.value] ?? 'off';
    const warpAmt = ((p.get('displace.warpamt')?.value ?? 0)).toFixed(0);
    const blend = p.get('blend.active')?.value ? `${(p.get('blend.amount')?.value ?? 0).toFixed(0)}%` : 'off';
    const keyer = p.get('keyer.active')?.value ? 'on' : 'off';
    const displ = (p.get('displace.amount')?.value ?? 0).toFixed(0);

    this.el.textContent = [
      `FPS  ${fps}`,
      `FG   ${fg}   BG  ${bg}   DS  ${ds}`,
      `Warp ${warp} (${warpAmt}%)   Displ ${displ}%`,
      `Blend ${blend}   Keyer ${keyer}`,
      `BPM  ${(p.get('global.bpm')?.value ?? 0).toFixed(0)}`,
    ].join('\n');
  }
}

// ── FPS display ───────────────────────────────────────────────────────────────

// ── WarpMap Editor ────────────────────────────────────────────────────────────

/**
 * Build the interactive WarpMap editor canvas UI.
 * Mounted inside #warp-editor-container in the Mapping tab.
 *
 * @param {WarpMapEditor} editor
 * @param {ParameterSystem} ps
 */
export function buildWarpEditor(editor, ps, contextMenu, warpMaps = null) {
  const container = document.getElementById('warp-editor-container');
  if (!container) return;

  // WarpMode + WarpAmt param rows at the top of the section
  const warpModeRow = buildParamRow(ps.get('displace.warp'),    contextMenu ?? null);
  const warpAmtRow  = buildParamRow(ps.get('displace.warpamt'), contextMenu ?? null);
  container.appendChild(warpModeRow);
  container.appendChild(warpAmtRow);

  const CW = 288, CH = 200; // canvas display size in px
  // 1.0 = truthful. This was 2.5 "for visual clarity", but control points clamp
  // at ±0.49 and a preset like H-Wave already reaches 0.35, so 2.5× drew nodes
  // up to 1.2 canvas-widths from home — the mesh exploded off-canvas for warps
  // the video renders calmly. It also disagreed with the main-canvas grid
  // overlay, which draws unscaled: two views of one grid must not use two
  // scales, or neither can be trusted as a preview.
  const DISP_SCALE = 1.0;
  // The shader's own displacement gain, from WARP in src/shaders/index.js:
  //   displacement = (warp.rg - 0.5) * uStrength * 0.3
  // uStrength is warpamt/100, and 0.3 is a second, constant factor. Applying
  // only uStrength left both previews drawing 3.33x the displacement the video
  // renders — which reads as "the dots move way more than the picture does".
  // If that literal changes in the shader, it must change here and in the
  // main-canvas overlay in the same commit.
  const WARP_SHADER_GAIN = 0.3;

  // ── Canvas ────────────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width  = CW;
  canvas.height = CH;
  canvas.className = 'warp-canvas';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // ── Controls row ──────────────────────────────────────────────────────────
  const controlRow = document.createElement('div');
  controlRow.className = 'warp-controls';
  container.appendChild(controlRow);

  // Tool Selection
  let activeTool = 'push';
  const tools = ['push', 'smooth', 'erase'];
  const toolGroup = document.createElement('div');
  toolGroup.style.display = 'flex'; toolGroup.style.gap = '2px'; toolGroup.style.marginRight = '8px';
  tools.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'warp-preset-btn';
    btn.textContent = t.toUpperCase();
    btn.style.padding = '2px 5px';
    btn.classList.toggle('active', t === activeTool);
    btn.addEventListener('click', () => {
      activeTool = t;
      toolGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    toolGroup.appendChild(btn);
  });
  controlRow.appendChild(toolGroup);

  // Brush radius — a VIEW of displace.warpDrawRadius, not its own variable.
  // One radius now governs all three drawing surfaces: this editor, the main
  // canvas drag and the WarpDrawX/Y param path. It used to be a local `let`
  // that nothing else could see, which is why dialling it here did nothing to
  // the main canvas. Percent in the param, 0..1 UV on the slider.
  const radiusParam = ps.get('displace.warpDrawRadius');
  // Read at USE time, never cached: a controller can move the param between
  // two pointermove events, and the brush must see the current value.
  const _radius = () => (radiusParam?.value ?? 18) / 100;
  const radiusLabel = document.createElement('span');
  radiusLabel.className = 'warp-ctrl-label';
  radiusLabel.textContent = 'Radius';
  const radiusSlider = document.createElement('input');
  radiusSlider.type = 'range';
  radiusSlider.min = String((radiusParam?.min ?? 2) / 100);
  radiusSlider.max = String((radiusParam?.max ?? 50) / 100);
  radiusSlider.step = '0.01';
  radiusSlider.value = String((radiusParam?.value ?? 18) / 100);
  radiusSlider.className = 'warp-slider';
  radiusSlider.addEventListener('input', () => {
    ps.set('displace.warpDrawRadius', parseFloat(radiusSlider.value) * 100);
  });
  // Follow the param, so an LFO/MIDI controller visibly moves this slider too.
  radiusParam?.onChange(v => {
    const next = String(v / 100);
    if (radiusSlider.value !== next) radiusSlider.value = next;
  });
  // Right-click / Ctrl+click → the same assign menu a param row offers. These
  // are bare <input>/<span>, not a .param-row, so they get no badge for free;
  // wiring contextMenu.show here is what makes the control assignable at all.
  const _assign = (param) => (e) => {
    e.preventDefault(); e.stopPropagation();
    contextMenu?.show(param, e.clientX, e.clientY);
  };
  [radiusLabel, radiusSlider].forEach(el => {
    el.addEventListener('contextmenu', _assign(radiusParam));
    // Windows/Linux Ctrl+click arrives as a plain click; macOS synthesises a
    // contextmenu instead, so both paths are needed for one gesture.
    el.addEventListener('click', e => {
      if (e.ctrlKey || e.metaKey) _assign(radiusParam)(e);
    });
  });
  radiusLabel.title = 'Brush radius — shared with the main canvas and WarpDrawX/Y.\nRight-click or Ctrl+click to assign a controller.';

  // Strength — a VIEW of displace.warpDrawAmt, the param that already scaled
  // main-canvas strength. Deliberately NOT a third knob: the two were always
  // the same quantity expressed twice. The old local scale had unity at 0.015
  // and entered brush() as `strength/0.015`, exactly where the main canvas
  // used `warpDrawAmt/100` — so 0.015 ≡ 100% and the default feel is
  // unchanged; only the top of the range moves (5.3x → 2x, warpDrawAmt's max).
  const strParam = ps.get('displace.warpDrawAmt');
  const _amt = () => (strParam?.value ?? 100) / 100;   // read at USE time
  const strLabel = document.createElement('span');
  strLabel.className = 'warp-ctrl-label';
  strLabel.textContent = 'Strength';
  const strSlider = document.createElement('input');
  strSlider.type = 'range';
  strSlider.min = String(strParam?.min ?? 0);
  strSlider.max = String(strParam?.max ?? 200);
  strSlider.step = '1';
  strSlider.value = String(strParam?.value ?? 100);
  strSlider.className = 'warp-slider';
  strSlider.addEventListener('input', () => {
    ps.set('displace.warpDrawAmt', parseFloat(strSlider.value));
  });
  strParam?.onChange(v => {
    const next = String(v);
    if (strSlider.value !== next) strSlider.value = next;
  });
  [strLabel, strSlider].forEach(el => {
    el.addEventListener('contextmenu', _assign(strParam));
    el.addEventListener('click', e => { if (e.ctrlKey || e.metaKey) _assign(strParam)(e); });
  });
  strLabel.title = 'Brush strength — shared with the main canvas and WarpDrawX/Y.\nRight-click or Ctrl+click to assign a controller.';

  controlRow.append(radiusLabel, radiusSlider, strLabel, strSlider);

  // ── Preset buttons ────────────────────────────────────────────────────────
  const presetRow = document.createElement('div');
  presetRow.className = 'warp-presets';
  container.appendChild(presetRow);

  // Derived from the SELECT options (minus the leading "—" no-op), so the
  // buttons, the param and main.js's recall can never disagree about order —
  // and adding a preset means editing one list, not three.
  const presets = ps.get('displace.warpPreset').options.slice(1);
  presets.forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'warp-preset-btn';
    btn.textContent = name;
    btn.addEventListener('click', (e) => {
      // Ctrl/Cmd+click assigns a controller to displace.warpPreset instead of
      // firing the preset — these buttons are not param rows, so without this
      // there is no way to reach the assign menu from the control you are
      // actually looking at.
      if (e.ctrlKey || e.metaKey) { _assign(ps.get('displace.warpPreset'))(e); return; }
      // Route through displace.warpPreset so the button, a MIDI note and an
      // LFO all reach the same recall in main.js. Re-clicking the SAME preset
      // must still re-fire — Random especially — and setting a param to the
      // value it already holds emits no onChange, so recall directly then.
      const idx = presets.indexOf(name) + 1;
      if (ps.get('displace.warpPreset').value === idx) editor.recallPreset?.(idx);
      else ps.set('displace.warpPreset', idx);
      drawMesh();
    });
    // Nothing else claims right-click on a preset button, so it opens the
    // assign menu too — matching the param-row convention.
    btn.addEventListener('contextmenu', _assign(ps.get('displace.warpPreset')));
    presetRow.appendChild(btn);
  });

  // ── Save / Load slots ─────────────────────────────────────────────────────
  const slotRow = document.createElement('div');
  slotRow.className = 'warp-slots';
  container.appendChild(slotRow);

  function refreshSlots() {
    slotRow.innerHTML = '';
    const slotLabel = document.createElement('span');
    slotLabel.className = 'warp-ctrl-label';
    slotLabel.textContent = 'Slots:';
    slotRow.appendChild(slotLabel);
    // Save buttons 1-16
    for (let i = 1; i <= 16; i++) {
      const btn = document.createElement('button');
      btn.className = 'warp-slot-btn';
      const hasSaved = editor.getSavedSlots().includes(String(i));
      btn.textContent = hasSaved ? `${i}` : `·`;
      btn.title = hasSaved ? `Load slot ${i} (right-click to save)` : `Save to slot ${i}`;
      btn.style.width = '24px';
      btn.style.padding = '3px 0';
      if (hasSaved) btn.style.color = 'var(--accent)';
      btn.addEventListener('click', (e) => {
        // Ctrl/Cmd+click → assign a controller to displace.warpSlot. Right-click
        // is NOT free here (it saves), so unlike the preset buttons this gesture
        // is the only route to the assign menu from a slot.
        if (e.ctrlKey || e.metaKey) { _assign(ps.get('displace.warpSlot'))(e); return; }
        if (hasSaved) {
          // LOADING routes through displace.warpSlot so a click, a MIDI note
          // and an LFO all reach one recall in main.js (which still applies
          // warpSlotFade — beginMorph falls through to load() at 0, so the
          // default stays byte-for-byte the old behaviour). Re-clicking the
          // slot already selected fires no onChange, so recall directly then.
          // SAVING stays local: it writes storage rather than recalling, and
          // has no business moving a controller-visible param.
          if (ps.get('displace.warpSlot').value === i) editor.recallSlot?.(i);
          else ps.set('displace.warpSlot', i);
          drawMesh();
        } else { editor.save(String(i)); refreshSlots(); }
      });
      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        // macOS turns Ctrl+click into a contextmenu event, so "save on
        // right-click" and "assign on Ctrl+click" arrive at the SAME handler.
        // ctrlKey is what separates them: a true right-click (button 2) carries
        // ctrlKey false. Without this branch, Ctrl+click on a slot would
        // silently overwrite it instead of opening the assign menu — a
        // destructive misfire, which is why this is a branch and not a
        // second listener.
        if (e.ctrlKey || e.metaKey) { _assign(ps.get('displace.warpSlot'))(e); return; }
        editor.save(String(i));
        refreshSlots();
      });
      slotRow.appendChild(btn);
    }
  }
  refreshSlots();

  // ── Canvas drawing ────────────────────────────────────────────────────────

  // WARP_CUSTOM_IDX in main.js. displace.warp: 0 = off, 1..8 = the procedural
  // DataTextures from buildWarpMaps(), 9 = the editor's own Custom map.
  const CUSTOM_IDX = 9;

  /**
   * Sample whatever map is ACTUALLY rendering, not always Custom.
   *
   * The editor only ever owns warpMaps[8]; selecting Turb from the dropdown
   * renders warpMaps[6] while this canvas faithfully drew an empty Custom map,
   * so the preview answered a question nobody asked. The procedural maps are
   * 256x256 DataTextures written as (0.5 + d) * 255 with row y at ny =
   * y/(SIZE-1) — the same axis convention as the editor grid — so the same
   * warpedPos formula reads them unchanged.
   */
  function sampleActive(ni, nj) {
    const mode = Math.round(ps.get('displace.warp')?.value ?? 0);
    if (mode === CUSTOM_IDX || !warpMaps) return editor.dispAt(ni, nj);
    if (mode <= 0) return { dx: 0, dy: 0 };
    const tex = warpMaps[mode - 1];
    const img = tex?.image;
    if (!img?.data) return { dx: 0, dy: 0 };
    const N = img.width;
    const px = Math.max(0, Math.min(N - 1, Math.round(ni * (N - 1))));
    const py = Math.max(0, Math.min(N - 1, Math.round(nj * (N - 1))));
    const off = (py * N + px) * 4;
    return { dx: img.data[off] / 255 - 0.5, dy: img.data[off + 1] / 255 - 0.5 };
  }

  /** True when the active map is not the editable Custom one. */
  function isReadOnly() {
    const mode = Math.round(ps.get('displace.warp')?.value ?? 0);
    return !!warpMaps && mode !== CUSTOM_IDX && mode > 0;
  }

  function warpedPos(ni, nj) {
    const { dx, dy } = sampleActive(ni, nj);
    // Negated for the same reason as the brush above: the shader samples at
    // vUv + displacement, so a positive map value pulls content from further
    // along and the picture moves the opposite way. Drawing the mesh at +dx
    // showed the mirror image of what the video actually did. This is a
    // display fix — dispAt and the stored arrays are unchanged, and the dot
    // colouring nearby uses magnitude only, so it is unaffected.
    // Scaled by WarpAmt, because the SHADER is: Pipeline passes
    // uStrength = displace.warpamt/100, so at 50% the video shows half of what
    // the map holds. Drawing the raw map made this preview claim a deformation
    // twice the one on screen — the same class of lie DISP_SCALE=2.5 was, and
    // the same rule applies: a preview that does not apply what the renderer
    // applies cannot be trusted as a preview. The main-canvas grid overlay
    // scales identically; the two views must never use two scales.
    const amt = ((ps.get('displace.warpamt')?.value ?? 100) / 100) * WARP_SHADER_GAIN;
    // Node (ni,nj) is in map space = vUv, y-up. The image appears to move by
    // -(dx,dy), so its displaced position is (ni - dx, nj - dy); converting
    // vUv.y to a y-down canvas gives the 1 - (...) on y. Only y was wrong here:
    // x was already negated correctly.
    return {
      x: (ni - dx * DISP_SCALE * amt) * CW,
      y: (1 - (nj - dy * DISP_SCALE * amt)) * CH,
    };
  }

  // Repaint whenever the grid changes for ANY reason — param-driven strokes,
  // main-canvas drags, temporal decay, slot crossfades — not just local
  // interaction with this little canvas.
  editor.onRebuild = () => drawMesh();
  // onRebuild covers changes to the MAP. WarpAmt changes what the shader does
  // with an unchanged map, so without this the preview would only catch up on
  // the next stroke and the scaling above would read as not working.
  ps.get('displace.warpamt')?.onChange(() => drawMesh());
  // The active map can change without the map DATA changing, so onRebuild does
  // not cover it — without this the preview keeps showing the previous mode.
  ps.get('displace.warp')?.onChange(() => drawMesh());

  function drawMesh() {
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = '#0d0d14';
    ctx.fillRect(0, 0, CW, CH);

    const c = editor.cols, r = editor.rows;

    // Draw mesh lines
    ctx.strokeStyle = 'rgba(140,140,180,0.45)';
    ctx.lineWidth = 0.8;

    // Horizontal lines
    for (let j = 0; j < r; j++) {
      ctx.beginPath();
      for (let i = 0; i < c; i++) {
        const { x, y } = warpedPos(i / (c-1), j / (r-1));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Vertical lines
    for (let i = 0; i < c; i++) {
      ctx.beginPath();
      for (let j = 0; j < r; j++) {
        const { x, y } = warpedPos(i / (c-1), j / (r-1));
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Control point dots at every intersection
    for (let j = 0; j < r; j++) {
      for (let i = 0; i < c; i++) {
        const { dx, dy } = sampleActive(i / (c-1), j / (r-1));
        const mag = Math.sqrt(dx*dx + dy*dy) * 15; // normalize for color
        const { x, y } = warpedPos(i / (c-1), j / (r-1));
        
        ctx.fillStyle = mag > 0.01 
          ? `hsla(${180 - mag * 100}, 80%, 60%, ${0.3 + mag * 0.7})` 
          : 'rgba(140,140,180,0.2)';
        
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Say which map this is when it is not the editable one, so a flat or
    // unfamiliar field reads as "you are looking at Turb" rather than "the
    // editor is broken" — which is exactly how it was reported.
    if (isReadOnly()) {
      const p = ps.get('displace.warp');
      const name = p?.options?.[Math.round(p.value)] ?? '';
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(232,200,64,0.85)';
      ctx.fillText(`${name} — read only (draw to switch to Custom)`, 6, 13);
    }

    // Cursor circle
    if (_hover) {
      ctx.strokeStyle = 'rgba(232,200,64,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(_hover.cx, _hover.cy, _radius() * CW, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── Mouse interaction ─────────────────────────────────────────────────────

  let _drag = false;
  let _lastX = 0, _lastY = 0;
  let _hover = null;
  let _rightBtn = false;

  function evToNorm(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      nx: (e.clientX - rect.left) / rect.width,
      // y-UP, to match the map. Grid row j is stored at nj = j/(rows-1), the
      // packing writes texel row py at ny = (py+0.5)/TEX_SIZE, and the shader
      // reads texture2D(uWarpMap, vUv) with no flip — so this ny IS vUv.y, and
      // vUv.y points up. Handing brush() a raw y-down pointer put every stroke
      // in the vertically mirrored place.
      ny: 1 - (e.clientY - rect.top) / rect.height,
      cx: e.clientX - rect.left,
      cy: e.clientY - rect.top,
    };
  }

  canvas.addEventListener('mousedown', e => {
    e.preventDefault();
    _drag = true;
    _rightBtn = (e.button === 2);
    const { nx, ny } = evToNorm(e);
    _lastX = nx; _lastY = ny;
    // Activate Custom warp mode automatically, but only RAISE WarpAmt when it
    // is zero — this used to force 80% on every mousedown, discarding whatever
    // you had dialled in. The main canvas does the same thing, so both drawing
    // surfaces now behave identically.
    ps.set('displace.warp', 9);
    if (ps.get('displace.warpamt').value === 0) ps.set('displace.warpamt', 80);
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('mousemove', e => {
    const { nx, ny, cx, cy } = evToNorm(e);
    _hover = { cx, cy };
    if (_drag) {
      const ddx = (nx - _lastX);
      const ddy = (ny - _lastY);
      const sign = _rightBtn ? -1 : 1;
      
      if (activeTool === 'push') {
        // Negated to match the main canvas: the WARP shader samples at
        // vUv + displacement, so a positive map value moves content the OTHER
        // way. Without this, dragging left pushed the picture right. Only the
        // INPUT is flipped — stored maps are untouched, so every saved slot and
        // procedural preset renders exactly as before.
        //
        // UNIT direction × distance-proportional strength — the same formula as
        // main.js/_warpStroke. This used to pass the raw per-event delta as the
        // direction, which multiplies the movement in twice: brush() already
        // scales by `strength`, so a 1px step here (~0.0035 UV on a 288px
        // canvas) pushed by 0.0035 × strength instead of 1.0 × strength. That
        // is ~30× weaker than the main canvas and is why this window barely
        // drew. The old comment blamed the canvas being small and dialled the
        // multiplier down to compensate, which made it weaker still — the
        // canvas size is irrelevant once the direction is normalised.
        const mag = Math.hypot(ddx, ddy);
        if (mag > 1e-5) {
          const ux = ddx / mag, uy = ddy / mag;
          // Byte-for-byte the main canvas's formula now (_warpStroke): the same
          // gain, the same per-event ceiling, the same amt multiplier.
          const s = Math.min(mag * 10, 0.4) * _amt();
          // BOTH negated, exactly as main.js/_warpStroke does it. The shader
          // samples vUv + displacement, so apparent motion is -(dx,dy); to push
          // the image along (ux,uy) the map stores (-ux,-uy). uy was previously
          // left positive, which was CORRECT while ny above was y-down — the two
          // errors cancelled in direction and showed up only in placement.
          // Flipping either one alone moves the mirror instead of removing it.
          editor.brush(nx, ny, _radius(), s, -ux * sign, -uy * sign);
        }
      } else if (activeTool === 'smooth') {
        // 0.075 / 0.15 are the old 0.015×5 and 0.015×10 with the unity point
        // folded in, so SMOOTH and ERASE keep their previous feel at 100%.
        editor.smooth(nx, ny, _radius(), 0.075 * _amt());
      } else if (activeTool === 'erase') {
        editor.erase(nx, ny, _radius(), 0.15 * _amt());
      }
      
      _lastX = nx; _lastY = ny;
    }
    drawMesh();
  });

  canvas.addEventListener('mouseup',   () => { _drag = false; });
  canvas.addEventListener('mouseleave', () => { _drag = false; _hover = null; drawMesh(); });

  // Initial draw
  drawMesh();
}

export class Profiler {
  constructor() {
    this.el    = document.getElementById('status-fps');
    this._last = performance.now();
    this._frames = 0;
    this._fps = 0;
    this._cpuTime = 0;
    this._vram = 0;
    this._startTime = 0;
  }

  /** Call at start of render() */
  begin() {
    this._startTime = performance.now();
  }

  /** Call at end of render() */
  end() {
    this._cpuTime += (performance.now() - this._startTime);
  }

  tick(pipeline, sequencerManager) {
    this._frames++;
    const now = performance.now();
    if (now - this._last >= 1000) {
      const duration = now - this._last;
      this._fps = Math.round(this._frames * 1000 / duration);
      const avgCpu = (this._cpuTime / this._frames).toFixed(1);
      
      // Calculate VRAM estimate (MB)
      let bytes = 0;
      if (pipeline) {
        // Approximate VRAM from active render targets
        const targets = [
          pipeline.target1, pipeline.target2, pipeline.noiseTarget,
          pipeline.scene3d?.target, pipeline.scene3d?.depthTarget
        ];
        targets.forEach(t => {
          if (t) bytes += t.width * t.height * 4;
        });
        
        // Include sequencers from the manager if provided
        if (sequencerManager) {
          sequencerManager.sequencers.forEach(s => {
            if (s && s.frames) {
              bytes += s.width * s.height * 4 * s.frames.length;
            }
          });
        }

        // Plus some overhead for stills buffer (16 slots of 1280x720)
        bytes += 1280 * 720 * 4 * 16; 
      }
      const mb = Math.round(bytes / (1024 * 1024));

      if (this.el) {
        this.el.innerHTML = `
          <span title="Frames per second">${this._fps} fps</span>
          <span style="color:var(--text-2);margin:0 4px">|</span>
          <span title="Logic time per frame">${avgCpu}ms CPU</span>
          <span style="color:var(--text-2);margin:0 4px">|</span>
          <span title="Estimated VRAM usage" style="color:${mb > 800 ? 'var(--red)' : 'var(--green)'}">${mb}MB VRAM</span>
        `;
      }

      this._frames = 0;
      this._cpuTime = 0;
      this._last = now;
    }
  }
}

// ── Relative time formatting (for persisted AI connection status) ─────────────

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Help menu ─────────────────────────────────────────────────────────────────

/**
 * Wire the status-bar ? button: a small dropdown holding every route into the
 * documentation, plus About.
 *
 * This is the ONLY persistent help affordance in the app. The first-visit splash
 * offers the tour once and then sets imweb-onboarding-dismissed forever, and the
 * docs links previously lived at the bottom of the AI settings panel — so on a
 * second visit the guide could only be found by already knowing ⇧G.
 *
 * Entries reuse what already exists rather than adding new surfaces: the three
 * manuals go through openDocsViewer, Keyboard Shortcuts opens the same #kb-help
 * overlay the `?` key toggles, and the tour opens the guide PANEL (not a modal —
 * it points at the control panel, so it must not cover it).
 */
export function initHelpMenu() {
  const btn = document.getElementById('btn-help');
  if (!btn) return;

  const menu = document.createElement('div');
  menu.id = 'help-menu';
  menu.className = 'hidden';
  document.body.appendChild(menu);

  const openAbout = () => {
    const modal = document.getElementById('about-modal');
    const ver = document.getElementById('about-version');
    if (ver) ver.textContent = `v${__APP_VERSION__}`;
    modal?.classList.remove('hidden');
  };

  const items = [
    ['Guided Tour', '⇧G', () => openGuide()],
    ['Keyboard Shortcuts', '?', () => document.getElementById('kb-help')?.classList.remove('hidden')],
    ['—'],
    ['Quick Start', '', () => openDocsViewer('docs/ImWeb_Quick_Start.md', 'Quick Start')],
    ['Quick Reference', '', () => openDocsViewer('docs/ImWeb_Quick_Reference.md', 'Quick Reference')],
    ['Full Manual', '', () => openDocsViewer('docs/ImWeb_Full_Manual.md', 'Full Manual')],
    ['—'],
    ['About ImWeb', '', openAbout],
  ];

  for (const [label, accel, run] of items) {
    if (label === '—') {
      const sep = document.createElement('div');
      sep.className = 'help-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const item = document.createElement('button');
    item.className = 'help-menu-item';
    item.innerHTML = `<span>${label}</span><span class="help-menu-accel">${accel}</span>`;
    item.addEventListener('click', () => { closeMenu(); run(); });
    menu.appendChild(item);
  }

  function openMenu() {
    // Anchored to the button each time it opens: the status bar is a wrapping
    // flex row, so the button's x moves as items show and hide (the iPad-only
    // KBD button, the camera flip). A position captured once goes stale.
    const r = btn.getBoundingClientRect();
    menu.classList.remove('hidden');
    // Right-aligned to the button, then clamped: ? is the last item in the bar,
    // so a left-aligned menu would hang off the window edge.
    // gBCR width, not offsetWidth: offsetWidth is element-local and would be
    // half the on-screen width at 2×, against an r.right/innerWidth that are
    // both already scaled — the clamp would use two different rulers.
    const w = menu.getBoundingClientRect().width;
    setViewportPos(menu,
      Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4)),
      r.bottom + 4);
    btn.classList.add('active');
  }
  function closeMenu() {
    menu.classList.add('hidden');
    btn.classList.remove('active');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu();
    else closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) closeMenu();
  });

  const about = document.getElementById('about-modal');
  document.getElementById('about-close')?.addEventListener('click', () =>
    about?.classList.add('hidden'));
  about?.addEventListener('click', (e) => {
    if (e.target === about) about.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();
    about?.classList.add('hidden');
  });
}

// ── In-app Markdown docs viewer ───────────────────────────────────────────────

let _docsViewerWired = false;

/**
 * Fetch a markdown file and render it into the #docs-viewer modal.
 * url — path to the .md file (relative to the site root)
 * title — display title for the modal titlebar
 */
export async function openDocsViewer(url, title) {
  const overlay = document.getElementById('docs-viewer');
  const titleEl = document.getElementById('docs-viewer-title');
  const contentEl = document.getElementById('docs-viewer-content');
  if (!overlay || !titleEl || !contentEl) return;

  if (!_docsViewerWired) {
    document.getElementById('docs-viewer-close')?.addEventListener('click', () => {
      overlay.classList.add('hidden');
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
        overlay.classList.add('hidden');
      }
    });
    _docsViewerWired = true;
  }

  titleEl.textContent = title;
  contentEl.textContent = 'Loading…';
  overlay.classList.remove('hidden');

  try {
    // Retry once bypassing any HTTP/service-worker cache. A bare "Failed to
    // fetch" is a TypeError with no status behind it, and the most common
    // causes here are transient — a dev server restarting under the page, or a
    // service worker whose cache lookup failed. One clean retry turns a dead
    // panel into a slight pause.
    const { marked } = await import('marked');
    let res;
    try {
      res = await fetch(url);
    } catch {
      res = await fetch(url, { cache: 'reload' });
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    contentEl.innerHTML = marked.parse(text);
  } catch (err) {
    // Say what to do, not just what broke — this panel is the only route to the
    // manual, so a dead end here has no fallback for the reader.
    contentEl.textContent =
      `Could not load ${url} — ${err.message}. ` +
      `If the app is running from a local preview, check the server is still up, ` +
      `then reload the page.`;
  }
}

// ── AI Settings Panel ─────────────────────────────────────────────────────────

/**
 * Populate an existing panel element with the multi-provider AI settings UI.
 * ai — AIFeatures instance (getConfig, setActiveProvider, setProviderKey,
 *       setProviderModel, testConnection)
 * panelEl — the container element to populate (replaces its innerHTML)
 */
export function buildAISettingsPanel(ai, panelEl) {
  if (!panelEl) return;

  const cfg = ai.getConfig();

  // ── Helpers ────────────────────────────────────────────────────────────────

  const row = (label, child, note) => {
    const wrap = document.createElement('div');
    wrap.className = 'ai-prov-row';
    if (label) {
      const lbl = document.createElement('span');
      lbl.className = 'ai-prov-label';
      lbl.textContent = label;
      wrap.appendChild(lbl);
    }
    if (child) wrap.appendChild(child);
    if (note) {
      const n = document.createElement('span');
      n.className = 'ai-prov-note';
      n.textContent = note;
      wrap.appendChild(n);
    }
    return wrap;
  };

  const makeSelect = (opts, current, onChange) => {
    const sel = document.createElement('select');
    sel.className = 'ai-prov-select';
    opts.forEach(({ value, label }) => {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = label;
      if (value === current) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  };

  // ── Build UI ───────────────────────────────────────────────────────────────

  panelEl.innerHTML = '';

  // Header
  const hdr = document.createElement('div');
  hdr.className = 'ai-settings-hdr';
  hdr.textContent = 'SETTINGS';
  panelEl.appendChild(hdr);

  // Status line
  const statusEl = document.createElement('div');
  statusEl.className = 'ai-key-status';
  panelEl.appendChild(statusEl);

  // Provider selector
  const provSel = makeSelect(
    Object.values(PROVIDERS).map(p => ({ value: p.id, label: p.name })),
    cfg.activeProvider,
    id => {
      ai.setActiveProvider(id);
      refreshProviderUI(id);
    }
  );
  panelEl.appendChild(row('Provider', provSel));

  // Provider-specific fields (key, model, link) — rebuilt on provider change
  const provFields = document.createElement('div');
  panelEl.appendChild(provFields);

  // Test + status
  const testBtn = document.createElement('button');
  testBtn.className = 'import-btn';
  testBtn.textContent = '⟳ Test connection';
  testBtn.style.marginTop = '8px';
  testBtn.addEventListener('click', async () => {
    const providerId = ai.getConfig().activeProvider;
    // Name exactly what is being tested — provider + model from the saved
    // config — so a mismatch with what the user thinks is in the box is
    // immediately visible (e.g. localStorage split across dev-server ports).
    const testedModel = ai.getConfig().providers[providerId]?.model
      ?? PROVIDERS[providerId]?.defaultModel ?? '?';
    testBtn.disabled = true;
    testBtn.textContent = '⏳ Testing…';
    statusEl.textContent = '';
    statusEl.className = 'ai-key-status';
    try {
      await ai.testConnection();
      statusEl.textContent = `✓ Connected — ${testedModel} @ ${providerId}`;
      statusEl.className = 'ai-key-status ok';
      ai.setProviderTestResult(providerId, { ok: true, message: `Connected (${testedModel})` });
    } catch (err) {
      statusEl.textContent = `✗ ${testedModel} @ ${providerId}: ${err.message}`;
      statusEl.className = 'ai-key-status error';
      ai.setProviderTestResult(providerId, { ok: false, message: err.message });
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '⟳ Test connection';
    }
  });
  panelEl.appendChild(testBtn);

  // ── Token usage ───────────────────────────────────────────────────────────
  // Counts come from the provider's own usage fields, never estimated here:
  // a chars/4 guess cannot see thinking tokens, which are billed as output and
  // are most of the spend on a shader refine. Cost is shown only where the rate
  // is known (see RATES in AIFeatures.js) — an unpriced model gets a dash
  // rather than a confident wrong number.
  const usageHdr = document.createElement('div');
  usageHdr.className = 'ai-settings-hdr';
  usageHdr.style.marginTop = '10px';
  usageHdr.textContent = 'TOKENS USED';
  panelEl.appendChild(usageHdr);

  const usageEl = document.createElement('div');
  usageEl.className = 'ai-usage';
  panelEl.appendChild(usageEl);

  const fmt = (n) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  // null = no published rate (a dash, never a number). Exact zero is a real
  // zero — free local inference, or nothing spent yet — and must not render as
  // "<$0.01", which reads as "a little" where the truth is "none".
  const money = (c) =>
    c === null ? '—' : c === 0 ? '$0.00' : c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`;

  function refreshUsage() {
    const { session, totals, last } = ai.getUsage();
    const rows = [];
    const cfg = ai.getConfig();
    const active = cfg.activeProvider;
    const activeModel = cfg.providers[active]?.model ?? '?';

    if (!session.calls && !Object.keys(totals).length) {
      usageEl.textContent = 'No AI calls yet.';
      return;
    }
    // Session first — "since this page loaded" is the number you act on during
    // a session; the all-time total is the one you act on about the bill.
    rows.push(
      `<div class="ai-usage-row"><span>This session</span>` +
      `<span>${fmt(session.in)} in · ${fmt(session.out)} out · ${session.calls} call${session.calls === 1 ? '' : 's'}` +
      ` · ${money(ai.usageCost(active, activeModel, session.in, session.out))}</span></div>`,
    );
    if (last) {
      rows.push(
        `<div class="ai-usage-row dim"><span>Last call</span>` +
        `<span>${fmt(last.in)} in · ${fmt(last.out)} out · ${relTime(last.ts)}</span></div>`,
      );
    }
    let allIn = 0, allOut = 0, allCost = 0, anyUnpriced = false;
    for (const [key, v] of Object.entries(totals)) {
      const [prov, ...rest] = key.split(':');
      const model = rest.join(':');
      const c = ai.usageCost(prov, model, v.in, v.out);
      if (c === null) anyUnpriced = true; else allCost += c;
      allIn += v.in; allOut += v.out;
      rows.push(
        `<div class="ai-usage-row dim"><span>${model}</span>` +
        `<span>${fmt(v.in)} in · ${fmt(v.out)} out · ${money(c)}</span></div>`,
      );
    }
    rows.push(
      `<div class="ai-usage-row total"><span>All time</span>` +
      `<span>${fmt(allIn)} in · ${fmt(allOut)} out · ${money(allCost)}${anyUnpriced ? '+' : ''}</span></div>`,
    );
    if (anyUnpriced) {
      rows.push('<div class="ai-usage-note">— = no published rate on file for that model; its tokens are counted but not priced.</div>');
    }
    usageEl.innerHTML = rows.join('');
  }
  refreshUsage();

  const usageBtnRow = document.createElement('div');
  usageBtnRow.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
  const usageRefreshBtn = document.createElement('button');
  usageRefreshBtn.className = 'import-btn';
  usageRefreshBtn.textContent = '⟳ Refresh';
  usageRefreshBtn.style.flex = '1';
  usageRefreshBtn.addEventListener('click', refreshUsage);
  const usageResetBtn = document.createElement('button');
  usageResetBtn.className = 'import-btn';
  usageResetBtn.textContent = 'Reset';
  usageResetBtn.title = 'Clear the stored token totals for this origin';
  usageResetBtn.addEventListener('click', () => { ai.resetUsage(); refreshUsage(); });
  usageBtnRow.append(usageRefreshBtn, usageResetBtn);
  panelEl.appendChild(usageBtnRow);

  // AI sub-header
  const aiHdr = document.createElement('div');
  aiHdr.className = 'ai-settings-hdr';
  aiHdr.style.marginTop = '10px';
  aiHdr.textContent = 'AI PROVIDER';
  panelEl.insertBefore(aiHdr, testBtn);

  // Storage note
  const note = document.createElement('div');
  note.className = 'ai-settings-note';
  note.textContent = 'Keys stored in browser localStorage only.';
  panelEl.appendChild(note);

  // ── AI Performance section ────────────────────────────────────────────────
  const perfHdr = document.createElement('div');
  perfHdr.className = 'ai-settings-hdr';
  perfHdr.style.marginTop = '10px';
  perfHdr.textContent = 'AI PERFORMANCE';
  panelEl.appendChild(perfHdr);

  const narrCfg = cfg.narrator ?? { interval: 10000, length: 'medium' };
  const coachCfg = cfg.coach ?? { interval: 45000 };

  // ── Narrator / Coach on-off, beside their own settings ────────────────────
  // Until now the only way to run either was an unlabelled glyph in the status
  // bar (𝔸 and ⬡), while everything that configures them lived here. These
  // buttons DELEGATE to those toolbar buttons rather than keeping their own
  // idea of on-ness: one source of truth, so the two can never disagree about
  // whether the narrator is running.
  const runRow = document.createElement('div');
  runRow.className = 'ai-run-row';
  const runBtn = (label, btnId, title) => {
    const b = document.createElement('button');
    b.className = 'import-btn ai-run-btn';
    b.textContent = label;
    b.title = title;
    const target = () => document.getElementById(btnId);
    b.addEventListener('click', () => target()?.click());
    // Mirror the toolbar button's state instead of tracking our own.
    const sync = () => b.classList.toggle('active', !!target()?.classList.contains('active'));
    sync();
    const t = target();
    if (t) new MutationObserver(sync).observe(t, { attributes: true, attributeFilter: ['class'] });
    return b;
  };
  runRow.append(
    runBtn('𝔸 Narrator', 'btn-ai-narrator',
      'Start/stop the live narration overlay (also the 𝔸 button in the status bar, or press n)'),
    runBtn('⬡ Coach', 'btn-ai-coach',
      'Start/stop performance suggestions (also the ⬡ button in the status bar)'),
  );
  panelEl.appendChild(row('Run', runRow));
  const runNote = document.createElement('div');
  runNote.className = 'ai-settings-note';
  runNote.textContent =
    'Both only speak when the patch or the picture has actually changed.';
  panelEl.appendChild(runNote);

  // ── Coach log ─────────────────────────────────────────────────────────────
  // The toast over the canvas flashes for 2.5s and fades — right for a
  // performance, but a suggestion you glanced away from was gone for good.
  // This is where it is kept.
  const coachHdr = document.createElement('div');
  coachHdr.className = 'ai-settings-hdr';
  coachHdr.style.marginTop = '10px';
  coachHdr.textContent = 'COACH SUGGESTIONS';
  panelEl.appendChild(coachHdr);

  const coachLogEl = document.createElement('div');
  coachLogEl.className = 'ai-coach-log';
  panelEl.appendChild(coachLogEl);

  function refreshCoachLog() {
    const log = ai.getCoachLog();
    if (!log.length) {
      coachLogEl.textContent = 'Nothing yet — start the Coach above.';
      coachLogEl.classList.add('empty');
      return;
    }
    coachLogEl.classList.remove('empty');
    coachLogEl.replaceChildren(...log.map((e) => {
      const row = document.createElement('div');
      row.className = 'ai-coach-log-row';
      const txt = document.createElement('span');
      txt.className = 'ai-coach-log-text';
      // textContent, never innerHTML: this string came from a model.
      txt.textContent = e.text;
      const when = document.createElement('span');
      when.className = 'ai-coach-log-when';
      when.textContent = relTime(e.ts);
      row.append(txt, when);
      return row;
    }));
  }
  refreshCoachLog();
  // The panel is rebuilt on open, but a suggestion can land while it is
  // already open — main.js fires this without needing to know the panel exists.
  document.addEventListener('imweb-coach', refreshCoachLog);

  const coachClearBtn = document.createElement('button');
  coachClearBtn.className = 'import-btn';
  coachClearBtn.textContent = 'Clear suggestions';
  coachClearBtn.style.cssText = 'margin-top:6px;width:100%;';
  coachClearBtn.addEventListener('click', () => { ai.clearCoachLog(); refreshCoachLog(); });
  panelEl.appendChild(coachClearBtn);

  panelEl.appendChild(row('Narrator interval', makeSelect(
    [5000, 10000, 15000, 30000, 60000].map(v => ({ value: String(v), label: `${v / 1000}s` })),
    String(narrCfg.interval),
    v => ai.setNarratorInterval(Number(v))
  )));

  panelEl.appendChild(row('Narrator length', makeSelect(
    [['short', 'Short'], ['medium', 'Medium'], ['long', 'Long']].map(([value, label]) => ({ value, label })),
    narrCfg.length,
    v => ai.setNarratorLength(v)
  )));

  panelEl.appendChild(row('Coach interval', makeSelect(
    [15000, 30000, 45000, 60000, 120000].map(v => ({ value: String(v), label: `${v / 1000}s` })),
    String(coachCfg.interval),
    v => ai.setCoachInterval(Number(v))
  )));

  // ── Canvas vision ─────────────────────────────────────────────────────────
  // Off by default and shown with its cost, because the narrator fires on a
  // timer: left on over an idle patch it spends real money describing a frame
  // that has not changed. The checkbox is the honest place to say so.
  const visCfg = cfg.vision ?? { narrator: false, coach: false };
  const visionToggle = (label, which, title) => {
    const wrap = document.createElement('label');
    wrap.className = 'ai-vision-toggle';
    wrap.title = title;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!visCfg[which];
    cb.addEventListener('change', () => ai.setVision(which, cb.checked));
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(cb, span);
    return wrap;
  };
  const visRow = document.createElement('div');
  visRow.className = 'ai-vision-row';
  visRow.append(
    visionToggle('Narrator sees canvas', 'narrator',
      'Send the current output frame with each narration — it describes the picture instead of the patch.'),
    visionToggle('Coach sees canvas', 'coach',
      'Send the current output frame with each coaching tip — it can judge the image, not just your recent edits.'),
  );
  panelEl.appendChild(row('Canvas vision', visRow));
  const visNote = document.createElement('div');
  visNote.className = 'ai-settings-note';
  visNote.textContent =
    'Sends a 512px JPEG of the output — roughly 1k extra input tokens per call. Needs a vision-capable model.';
  panelEl.appendChild(visNote);

  // The DOCUMENTATION block that used to sit here moved to the Help menu
  // (buildHelpMenu, below). It was the only persistent route to the manual and
  // the tour, and it was inside the AI provider panel — nobody configuring an
  // API key is looking for the guided tour, and nobody looking for the guided
  // tour opens the AI settings.

  const prepHdr = document.createElement('div');
  prepHdr.className = 'ai-settings-hdr';
  prepHdr.style.marginTop = '10px';
  prepHdr.textContent = 'VIDEO PREP';
  panelEl.appendChild(prepHdr);

  const prepNote = document.createElement('div');
  prepNote.className = 'ai-settings-note';
  prepNote.style.lineHeight = '1.6';
  prepNote.innerHTML =
    'For frame-accurate scrubbing, convert clips with:<br>' +
    '<code style="color:var(--accent)">node imweb-prep.js</code><br>' +
    'Drop raw files in <code style="color:var(--accent)">_raw_videos/</code><br>' +
    'Output: H.264 All-Intra, yuv420p, no audio, even dimensions.';
  panelEl.appendChild(prepNote);

  // ── Per-provider fields renderer ───────────────────────────────────────────

  // Live model lists fetched from each provider's API, cached for this panel
  const fetchedModels = {};

  function refreshProviderUI(providerId) {
    const pDef  = PROVIDERS[providerId];
    const pCfg  = ai.getConfig().providers[providerId] ?? {};
    provFields.innerHTML = '';

    // Key / Base URL field
    const keyWrap = document.createElement('div');
    keyWrap.className = 'ai-prov-row';
    keyWrap.style.flexWrap = 'wrap';
    keyWrap.style.gap = '4px';

    const keyLbl = document.createElement('span');
    keyLbl.className = 'ai-prov-label';
    keyLbl.textContent = pDef.keyLabel;
    keyWrap.appendChild(keyLbl);

    const keyInput = document.createElement('input');
    keyInput.type        = pDef.needsKey ? 'password' : 'text';
    keyInput.className   = 'ai-key-input';
    keyInput.placeholder = pDef.keyPlaceholder;
    keyInput.value       = pCfg.apiKey ?? '';
    keyInput.style.flex  = '1';
    keyWrap.appendChild(keyInput);

    if (pDef.needsKey) {
      // Show/hide toggle
      const toggle = document.createElement('button');
      toggle.className   = 'import-btn';
      toggle.textContent = '👁';
      toggle.title       = 'Show/hide key';
      toggle.style.cssText = 'padding:2px 6px;min-width:0;font-size:12px;';
      toggle.addEventListener('click', () => {
        keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
      });
      keyWrap.appendChild(toggle);

      // Clear key
      const clearBtn = document.createElement('button');
      clearBtn.className   = 'import-btn';
      clearBtn.textContent = '✕';
      clearBtn.title       = 'Clear key';
      clearBtn.style.cssText = 'padding:2px 6px;min-width:0;font-size:12px;';
      clearBtn.addEventListener('click', () => {
        keyInput.value = '';
        ai.setProviderKey(providerId, '');
        updateStatusFromKey(providerId);
      });
      keyWrap.appendChild(clearBtn);
    }

    // Save key on blur or Enter
    const saveKey = () => {
      ai.setProviderKey(providerId, keyInput.value.trim());
      updateStatusFromKey(providerId);
    };
    keyInput.addEventListener('blur', saveKey);
    keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') { saveKey(); keyInput.blur(); } });

    provFields.appendChild(keyWrap);

    // "Get API key" link
    const link = document.createElement('a');
    link.className   = 'ai-prov-link';
    link.textContent = pDef.keyUrlLabel;
    link.href        = pDef.keyUrl;
    link.target      = '_blank';
    link.rel         = 'noopener noreferrer';
    provFields.appendChild(link);

    // Model selector — union of static defaults and any live-fetched list
    const baseModels = fetchedModels[providerId] ?? pDef.models;
    const modelOpts = [...new Set([...baseModels, pDef.defaultModel])].map(m => ({ value: m, label: m }));
    const customModel = pCfg.model && !modelOpts.find(o => o.value === pCfg.model)
      ? pCfg.model : null;
    if (customModel) modelOpts.push({ value: customModel, label: `${customModel} (custom)` });
    modelOpts.push({ value: '__custom__', label: 'Custom…' });

    const modelSel = makeSelect(modelOpts, pCfg.model ?? pDef.defaultModel, val => {
      if (val === '__custom__') {
        const m = prompt('Enter model name:', pCfg.model ?? pDef.defaultModel);
        if (m) {
          ai.setProviderModel(providerId, m.trim());
          refreshProviderUI(providerId); // rebuild with new custom model in list
        } else {
          modelSel.value = pCfg.model ?? pDef.defaultModel;
        }
      } else {
        ai.setProviderModel(providerId, val);
      }
    });
    const modelRow = row('Model', modelSel);

    // Refresh models — fetch the live list from the provider's API
    const refreshBtn = document.createElement('button');
    refreshBtn.className   = 'import-btn';
    refreshBtn.textContent = '⟳';
    refreshBtn.title       = 'Refresh model list from provider';
    refreshBtn.style.cssText = 'padding:2px 6px;min-width:0;font-size:12px;margin-left:4px;';
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '⏳';
      try {
        const models = await ai.fetchModels(providerId);
        if (!models.length) throw new Error('No models returned');
        fetchedModels[providerId] = models;
        refreshProviderUI(providerId); // rebuild with the fetched model list
        return;
      } catch (err) {
        statusEl.textContent = `✗ ${err.message}`;
        statusEl.className = 'ai-key-status error';
      }
      refreshBtn.disabled = false;
      refreshBtn.textContent = '⟳';
    });
    modelRow.appendChild(refreshBtn);
    provFields.appendChild(modelRow);

    updateStatusFromKey(providerId);
  }

  function updateStatusFromKey(providerId) {
    const pDef = PROVIDERS[providerId];
    const pCfg = ai.getConfig().providers[providerId] ?? {};
    let text, cls;
    if (!pDef.needsKey) {
      text = `Ollama at ${pCfg.apiKey || 'http://localhost:11434'}`;
      cls = 'ai-key-status';
    } else if (pCfg.apiKey) {
      text = `Key set: ${pCfg.apiKey.slice(0, 8)}…`;
      cls = 'ai-key-status ok';
    } else {
      text = 'No key set';
      cls = 'ai-key-status';
    }
    if (pCfg.lastTest) {
      const rel = relTime(pCfg.lastTest.ts);
      if (pCfg.lastTest.ok) {
        text += ` · ✓ Connected (${rel})`;
      } else {
        text += ` · ✗ ${pCfg.lastTest.message} (${rel})`;
        cls = 'ai-key-status error';
      }
    }
    statusEl.textContent = text;
    statusEl.className = cls;
  }

  // Initial render
  refreshProviderUI(cfg.activeProvider);
}

// ── Movie Library UI ───────────────────────────────────────────────────────────

/** Private drag type for Library rows — lets file-drop handlers ignore us. */
export const ENTRY_MIME = 'application/x-imweb-movie-entry';

/**
 * Build the Movie Library panel — the catalogue of every clip that exists,
 * versus a deck's rack, which is the handful currently loaded.
 *
 * Rows scan lazily via IntersectionObserver: a catalogue of a hundred clips
 * costs a hundred strings at boot, and only the rows you actually look at pay
 * for a metadata read. Nothing here holds a <video>; loading into a deck is what
 * allocates one.
 *
 * @param {object}   movieLibrary  MovieLibrary singleton
 * @param {Function} onLoad        (entry, deck:'A'|'B') → Promise, performs the load
 * @returns {{ refreshMovieLibrary: Function }}
 */
export function buildMovieLibrary(movieLibrary, onLoad) {
  const container = document.getElementById('movie-library');
  if (!container) return { refreshMovieLibrary: () => {} };
  container.innerHTML = '';

  const filterRow = document.createElement('div');
  filterRow.className = 'movie-lib-filter';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Filter clips…';
  search.className = 'movie-lib-search';
  const count = document.createElement('span');
  count.className = 'movie-lib-count';
  filterRow.appendChild(search);
  filterRow.appendChild(count);
  container.appendChild(filterRow);

  const list = document.createElement('div');
  list.className = 'movie-lib-list';
  container.appendChild(list);

  // One observer for the whole list: when a row becomes visible, scan its entry
  // and repaint just that row. Rows already scanned unobserve themselves.
  const io = new IntersectionObserver(
    (records) => {
      for (const r of records) {
        if (!r.isIntersecting) continue;
        const row = r.target;
        io.unobserve(row);
        const entry = row._entry;
        if (!entry || entry.duration != null) continue;
        movieLibrary.scan(entry).then(() => _paintRow(row, entry));
      }
    },
    { root: list, rootMargin: '120px' },
  );

  function _fmtDur(d) {
    if (d == null) return '…';
    return d >= 60 ? `${Math.floor(d / 60)}m${Math.round(d % 60)}s` : `${d.toFixed(1)}s`;
  }

  function _paintRow(row, entry) {
    const thumb = row.querySelector('.movie-lib-thumb');
    const meta = row.querySelector('.movie-lib-meta');
    if (entry.thumbnail) {
      thumb.style.backgroundImage = `url(${entry.thumbnail})`;
      thumb.textContent = '';
    } else if (entry.scanError) {
      thumb.textContent = '⚠';
    }
    meta.textContent = entry.scanError
      ? entry.scanError
      : `${_fmtDur(entry.duration)} · ${entry.origin}`;
  }

  function refreshMovieLibrary() {
    const q = search.value.trim().toLowerCase();
    const shown = movieLibrary.entries.filter(
      (e) => !q || e.name.toLowerCase().includes(q),
    );
    count.textContent = `${shown.length}/${movieLibrary.size}`;
    list.innerHTML = '';
    shown.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'movie-lib-item';
      row._entry = entry;

      // Drag a row onto the Movie A / Movie B panel to rack it. The id travels
      // on a private MIME type rather than text/plain so the page's file-drop
      // handler can tell an internal drag from a dropped file.
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(ENTRY_MIME, entry.id);
        e.dataTransfer.effectAllowed = 'copy';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));

      const thumb = document.createElement('div');
      thumb.className = 'movie-lib-thumb';
      thumb.textContent = '▶';

      const info = document.createElement('div');
      info.className = 'movie-lib-info';
      const nameLine = document.createElement('div');
      nameLine.className = 'movie-lib-name';
      nameLine.textContent = entry.name.replace(/\.[^/.]+$/, '');
      nameLine.title = entry.name;
      const meta = document.createElement('div');
      meta.className = 'movie-lib-meta';
      info.appendChild(nameLine);
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'movie-lib-actions';
      for (const deck of ['A', 'B']) {
        const btn = document.createElement('button');
        btn.className = 'movie-lib-load';
        btn.textContent = `→${deck}`;
        btn.title = `Load into Deck ${deck}'s rack`;
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          btn.disabled = true;
          const was = btn.textContent;
          btn.textContent = '…';
          try {
            await onLoad(entry, deck);
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = was; btn.disabled = false; }, 900);
          } catch (err) {
            btn.textContent = '✕';
            btn.title = err.message;
            setTimeout(() => { btn.textContent = was; btn.disabled = false; }, 1600);
          }
        });
        actions.appendChild(btn);
      }

      // Remove from the catalogue. Deliberately NOT a deck operation: a clip
      // already racked keeps its own <video> and keeps playing, exactly as
      // Clear unloads a rack without deleting the entry. Nothing on disk is
      // touched, and a preloaded entry returns from the manifest on reload.
      const del = document.createElement('button');
      del.className = 'movie-lib-del';
      del.textContent = '✕';
      del.title = 'Remove from Library (does not delete the file or stop a racked clip)';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        movieLibrary.remove(entry.id);
        refreshMovieLibrary();
      });
      actions.appendChild(del);

      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(actions);
      list.appendChild(row);

      _paintRow(row, entry);
      if (entry.duration == null && !entry.scanError) io.observe(row);
    });
  }

  search.addEventListener('input', refreshMovieLibrary);
  refreshMovieLibrary();
  return { refreshMovieLibrary };
}

// ── Clip Library UI ────────────────────────────────────────────────────────────

/**
 * Build the Clip Library bank grid UI.
 * Returns { refreshClipGrid } so callers can trigger a refresh after record/recall/delete.
 *
 * @param {object} ps            ParameterSystem
 * @param {object} clipLibrary   ClipLibrary singleton
 * @param {object} movieInput    MovieInput instance
 * @param {object} contextMenu   ContextMenu (for buildParamRow)
 */
export function buildClipLibrary(ps, clipLibrary, movieInput, contextMenu, deckB = null) {
  const container = document.getElementById('clip-library');
  if (!container) return { refreshClipGrid: () => {} };
  container.innerHTML = '';

  // ── Header row: title + REC button + SRC dropdown ──
  const header = document.createElement('div');
  header.className = 'clip-lib-header';

  const title = document.createElement('span');
  title.className = 'clip-lib-title';
  title.textContent = 'Clip Library';

  const recBtn = document.createElement('button');
  recBtn.className = 'clip-rec-btn';
  recBtn.textContent = '● REC';
  recBtn.title = 'Record output for clip.duration seconds into selected bank/slot';

  const srcParam = ps.get('clip.recordSrc');
  const srcSel = document.createElement('select');
  srcSel.style.cssText = 'font-family:var(--mono);font-size:10px;background:var(--bg-4);color:var(--text-1);border:1px solid var(--border);border-radius:3px;padding:1px 4px;cursor:pointer;';
  srcParam.options.forEach((opt, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = opt;
    srcSel.appendChild(o);
  });
  srcSel.value = srcParam.value;
  srcSel.addEventListener('change', () => ps.set('clip.recordSrc', +srcSel.value));
  srcParam.onChange(v => { srcSel.value = v; });

  header.appendChild(title);
  header.appendChild(recBtn);
  header.appendChild(srcSel);
  container.appendChild(header);

  // ── Deck target toggle: recall routes to Deck A or Deck B ──
  // UI-local state (NOT a param): deck routing must never be flipped by a
  // state recall or morph. Defaults to A each launch. ⇧-click stays a
  // hardware override that always routes to B regardless of the toggle.
  let _targetDeckB = false;
  const deckRow = document.createElement('div');
  deckRow.className = 'clip-lib-bank-row';
  const deckLabel = document.createElement('span');
  deckLabel.textContent = 'Target:';
  deckLabel.style.cssText = 'font-family:var(--mono);font-size:10px;color:var(--text-2);align-self:center;padding:0 4px;';
  deckRow.appendChild(deckLabel);
  const deckBtns = ['A', 'B'].map((name, i) => {
    const btn = document.createElement('button');
    btn.className = 'clip-bank-btn';
    btn.textContent = name;
    btn.title = `Load tapped clips into Deck ${name}`;
    btn.addEventListener('click', () => {
      _targetDeckB = i === 1;
      deckBtns.forEach((b, j) => b.classList.toggle('active', (j === 1) === _targetDeckB));
      container.dataset.deckTarget = _targetDeckB ? 'B' : 'A';
    });
    deckRow.appendChild(btn);
    return btn;
  });
  deckBtns[0].classList.add('active');
  container.dataset.deckTarget = 'A';
  if (deckB?.input) container.appendChild(deckRow); // only when Deck B exists

  // Duration param row (reuse buildParamRow for drag/dblclick)
  const durParam = ps.get('clip.duration');
  container.appendChild(buildParamRow(durParam, contextMenu));

  // ── Bank row ──
  const bankRow = document.createElement('div');
  bankRow.className = 'clip-lib-bank-row';
  const bankParam = ps.get('clip.bank');
  const bankBtns  = [];
  for (let b = 0; b < 8; b++) {
    const btn = document.createElement('button');
    btn.className = 'clip-bank-btn';
    btn.textContent = String(b);
    btn.title = `Bank ${b}`;
    const refresh = () => btn.classList.toggle('active', bankParam.value === b);
    refresh();
    bankParam.onChange(refresh);
    btn.addEventListener('click', () => {
      ps.set('clip.bank', b);
      renderSlotGrid();
    });
    bankBtns.push(btn);
    bankRow.appendChild(btn);
  }
  container.appendChild(bankRow);

  // ── Slot grid ──
  const slotGrid = document.createElement('div');
  slotGrid.className = 'clip-slot-grid';
  container.appendChild(slotGrid);

  // Status label
  const statusEl = document.createElement('div');
  statusEl.className = 'clip-lib-status';
  container.appendChild(statusEl);

  // manifest cache: Map<slotIndex, { duration, thumbnail }>
  let _manifest = new Map();

  async function refreshClipGrid() {
    try {
      const entries = await clipLibrary.getManifest();
      _manifest = new Map(entries.map(e => [e.slotIndex, e]));
      _updateSlotClasses();
    } catch (e) { console.warn('[ClipLib] manifest fetch failed:', e); }
  }

  function _updateSlotClasses() {
    const bank     = bankParam.value;
    const slotParam = ps.get('clip.slot');
    slotGrid.querySelectorAll('.clip-slot').forEach((btn, i) => {
      const globalIdx = bank * 16 + i;
      const info      = _manifest.get(globalIdx);
      btn.classList.toggle('filled', !!info);
      btn.classList.toggle('active', slotParam.value === i && bankParam.value === bank);
      if (info?.thumbnail) {
        btn.style.backgroundImage = `url('${info.thumbnail}')`;
        btn.style.color = 'transparent'; // hide number when thumbnail shows
        btn.title = `Slot ${String(i).padStart(2,'0')} — ${info.duration.toFixed(1)}s`;
      } else {
        btn.style.backgroundImage = '';
        btn.style.color = '';
        btn.title = `Slot ${String(i).padStart(2,'0')} — empty`;
      }
    });
  }

  function renderSlotGrid() {
    slotGrid.innerHTML = '';
    const bank = bankParam.value;
    for (let i = 0; i < 16; i++) {
      const btn = document.createElement('button');
      btn.className = 'clip-slot';
      btn.textContent = String(i).padStart(2, '0');
      /**
       * Map-mode target. The Clip Library is a custom widget, not parameter
       * rows, so map mode had nothing here to click and `clip.slot` — the one
       * SELECT a pad bank most obviously wants — was unmappable. Rather than
       * teach the map-mode handler about this widget, the widget declares what
       * it stands for and the handler honours it generically; any other custom
       * surface becomes mappable the same way, by tagging.
       */
      btn.dataset.paramId  = 'clip.slot';
      btn.dataset.optIndex = String(i);

      // Left-click → select + recall into the target deck (toggle above);
      // ⇧-click → hardware override, always Deck B
      btn.addEventListener('click', async (e) => {
        const toDeckB = (e.shiftKey || _targetDeckB) && deckB?.input;
        ps.set('clip.bank', bank);
        ps.set('clip.slot', i);
        const globalIdx = bank * 16 + i;
        const info = _manifest.get(globalIdx);
        if (!info) { statusEl.textContent = `Slot ${String(i).padStart(2,'0')} — empty`; return; }
        try {
          const result = await clipLibrary.recall(globalIdx);
          if (result) {
            const deck   = toDeckB ? deckB.input : movieInput;
            const active = toDeckB ? 'movieB.active' : 'movie.active';
            const idx = await deck.addClip(result.blobUrl);
            if (idx >= 0) { deck.selectClip(idx); ps.set(active, 1); }
            if (toDeckB) deckB.onLoad?.();
            statusEl.textContent = `▶ Bank ${bank} · Slot ${String(i).padStart(2,'0')} · ${result.duration.toFixed(1)}s${toDeckB ? ' → Deck B' : ''}`;
          }
        } catch (err) { console.error('[ClipLib] recall failed:', err); }
        _updateSlotClasses();
      });

      // Right-click → delete
      btn.addEventListener('contextmenu', async e => {
        e.preventDefault();
        const globalIdx = bank * 16 + i;
        if (!_manifest.has(globalIdx)) return;
        if (!confirm(`Delete clip at Bank ${bank} Slot ${i}?`)) return;
        await clipLibrary.delete(globalIdx);
        await refreshClipGrid();
        renderSlotGrid();
        statusEl.textContent = `Deleted Bank ${bank} · Slot ${i}`;
      });

      slotGrid.appendChild(btn);
    }
    _updateSlotClasses();
  }

  // Wire REC button
  let _recActive = false;
  recBtn.addEventListener('click', () => {
    if (_recActive) return;
    ps.set('clip.record', 1);
  });

  // Keep REC button pulsing while recording (driven by clip.record onChange cycle)
  // We expose a setRecording(bool) for main.js to call
  function setRecording(active) {
    _recActive = active;
    recBtn.classList.toggle('recording', active);
    const bank      = bankParam.value;
    const slotParam = ps.get('clip.slot');
    slotGrid.querySelectorAll('.clip-slot').forEach((btn, i) => {
      btn.classList.toggle('recording', active && slotParam.value === i);
    });
  }

  // Slot param onChange → refresh active highlight
  ps.get('clip.slot').onChange(() => _updateSlotClasses());
  bankParam.onChange(() => { renderSlotGrid(); });

  // Initial render
  renderSlotGrid();
  refreshClipGrid(); // async, non-blocking

  return { refreshClipGrid, setRecording };
}

// ── Palette section (FG/BG HSV pickers + named presets) ──────────────────────
//
// opts:
//   presets  Array<{name, fgH,fgS,fgV, bgH,bgS,bgV}>  initial preset list
//   onSave   (name) => void
//   onDelete (index) => void
//   onLoad   (preset) => void
//
// Returns: { fgPicker, bgPicker, refreshPresets(presets) }

export function buildPaletteSection(container, ps, contextMenu, opts = {}) {
  const { presets = [], onSave, onDelete, onLoad } = opts;

  // ── FG / BG tab switcher ───────────────────────────────────────────────────
  const tabRow = document.createElement('div');
  tabRow.className = 'cp-tab-row';

  const mkTab = (label, active) => {
    const b = document.createElement('button');
    b.className = 'cp-tab' + (active ? ' cp-tab-active' : '');
    b.textContent = label;
    tabRow.appendChild(b);
    return b;
  };
  const fgBtn = mkTab('FG', true);
  const bgBtn = mkTab('BG', false);
  container.appendChild(tabRow);

  // ── Panels ─────────────────────────────────────────────────────────────────
  const mkPanel = (visible) => {
    const p = document.createElement('div');
    p.className = 'cp-panel';
    if (!visible) p.style.display = 'none';
    container.appendChild(p);
    return p;
  };
  const fgPanel = mkPanel(true);
  const bgPanel = mkPanel(false);

  // ── Build FG picker ────────────────────────────────────────────────────────
  const fgWrap = document.createElement('div');
  fgWrap.className = 'cp-picker-wrap';
  fgPanel.appendChild(fgWrap);

  let _fgBusy = false;
  const fgPicker = new ColorPicker(fgWrap, {
    h: ps.get('palette.fg.hue').value,
    s: ps.get('palette.fg.sat').value,
    v: ps.get('palette.fg.val').value,
    onChange: (h, s, v) => {
      _fgBusy = true;
      ps.set('palette.fg.hue', h);
      ps.set('palette.fg.sat', s);
      ps.set('palette.fg.val', v);
      _fgBusy = false;
    },
  });

  // ps → picker (MIDI/LFO → visual sync)
  const fgSync = () => {
    if (_fgBusy) return;
    fgPicker.setHSV(
      ps.get('palette.fg.hue').value,
      ps.get('palette.fg.sat').value,
      ps.get('palette.fg.val').value,
    );
  };
  ['palette.fg.hue', 'palette.fg.sat', 'palette.fg.val'].forEach(id =>
    ps.get(id).onChange(fgSync));

  // Param rows — controller badge access (MIDI / LFO assignment)
  const fgRows = document.createElement('div');
  fgRows.className = 'cp-param-rows';
  ps.getGroup('palettefg').forEach(p => { const row = buildParamRow(p, contextMenu); fgRows.appendChild(row); });
  fgPanel.appendChild(fgRows);

  // ── Build BG picker ────────────────────────────────────────────────────────
  const bgWrap = document.createElement('div');
  bgWrap.className = 'cp-picker-wrap';
  bgPanel.appendChild(bgWrap);

  let _bgBusy = false;
  const bgPicker = new ColorPicker(bgWrap, {
    h: ps.get('palette.bg.hue').value,
    s: ps.get('palette.bg.sat').value,
    v: ps.get('palette.bg.val').value,
    onChange: (h, s, v) => {
      _bgBusy = true;
      ps.set('palette.bg.hue', h);
      ps.set('palette.bg.sat', s);
      ps.set('palette.bg.val', v);
      _bgBusy = false;
    },
  });

  const bgSync = () => {
    if (_bgBusy) return;
    bgPicker.setHSV(
      ps.get('palette.bg.hue').value,
      ps.get('palette.bg.sat').value,
      ps.get('palette.bg.val').value,
    );
  };
  ['palette.bg.hue', 'palette.bg.sat', 'palette.bg.val'].forEach(id =>
    ps.get(id).onChange(bgSync));

  const bgRows = document.createElement('div');
  bgRows.className = 'cp-param-rows';
  ps.getGroup('palettebg').forEach(p => { const row = buildParamRow(p, contextMenu); bgRows.appendChild(row); });
  bgPanel.appendChild(bgRows);

  // ── Tab switching ──────────────────────────────────────────────────────────
  fgBtn.addEventListener('click', () => {
    fgBtn.classList.add('cp-tab-active');
    bgBtn.classList.remove('cp-tab-active');
    fgPanel.style.display = '';
    bgPanel.style.display = 'none';
    // Force re-render after panel becomes visible
    requestAnimationFrame(() => fgPicker._render());
  });
  bgBtn.addEventListener('click', () => {
    bgBtn.classList.add('cp-tab-active');
    fgBtn.classList.remove('cp-tab-active');
    bgPanel.style.display = '';
    fgPanel.style.display = 'none';
    requestAnimationFrame(() => bgPicker._render());
  });

  // ── Preset area ────────────────────────────────────────────────────────────
  const presetArea = document.createElement('div');
  presetArea.className = 'cp-preset-area';
  container.appendChild(presetArea);

  const presetHeader = document.createElement('div');
  presetHeader.className = 'cp-preset-header';
  presetHeader.textContent = 'Saved Palettes';
  presetArea.appendChild(presetHeader);

  const saveRow = document.createElement('div');
  saveRow.className = 'cp-preset-save-row';

  const nameInp = document.createElement('input');
  nameInp.className = 'cp-preset-name-inp';
  nameInp.type = 'text';
  nameInp.placeholder = 'name…';
  nameInp.maxLength = 32;

  const saveBtn = document.createElement('button');
  saveBtn.className = 'cp-preset-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    const name = nameInp.value.trim();
    if (!name) { nameInp.focus(); return; }
    if (onSave) onSave(name);
    nameInp.value = '';
  });
  // Enter key in name field also saves
  nameInp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
  });

  saveRow.append(nameInp, saveBtn);
  presetArea.appendChild(saveRow);

  const list = document.createElement('div');
  list.className = 'cp-preset-list';
  presetArea.appendChild(list);

  let _activeIdx = -1;

  function refreshPresets(prs) {
    list.innerHTML = '';
    if (!prs.length) {
      const hint = document.createElement('div');
      hint.className = 'cp-preset-empty';
      hint.textContent = 'No saved palettes';
      list.appendChild(hint);
      return;
    }
    prs.forEach((pr, i) => {
      const chip = document.createElement('button');
      chip.className = 'cp-preset-chip' + (i === _activeIdx ? ' active' : '');
      chip.textContent = pr.name;
      chip.title = `FG  H${Math.round(pr.fgH)}° S${Math.round(pr.fgS)}% V${Math.round(pr.fgV)}%\nBG  H${Math.round(pr.bgH)}° S${Math.round(pr.bgS)}% V${Math.round(pr.bgV)}%\nRight-click to delete`;

      chip.addEventListener('click', () => {
        _activeIdx = i;
        if (onLoad) onLoad(pr);
        list.querySelectorAll('.cp-preset-chip').forEach((c, j) =>
          c.classList.toggle('active', j === i));
      });

      chip.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (confirm(`Delete palette "${pr.name}"?`)) {
          if (i === _activeIdx) _activeIdx = -1;
          if (onDelete) onDelete(i);
        }
      });

      list.appendChild(chip);
    });
  }

  refreshPresets(presets);

  return { fgPicker, bgPicker, refreshPresets };
}

// ── AnalogTV preset section ───────────────────────────────────────────────
//
// opts:
//   presets  Array<{name, values: {paramId: value, ...}}>  user-saved presets
//   onSave   (name) => void
//   onDelete (index) => void
//   onLoad   (preset) => void
//
// Returns: { refreshPresets(presets) }

export function buildAnalogPresetBar(container, ps, opts = {}) {
  const { presets = [], builtinPresets = [], onSave, onDelete, onLoad } = opts;

  const area = document.createElement('div');
  area.className = 'atv-preset-area';
  container.appendChild(area);

  // ── Built-in presets header ───────────────────────────────────────────
  const builtinHeader = document.createElement('div');
  builtinHeader.className = 'atv-preset-header';
  builtinHeader.textContent = 'Built-in Presets';
  area.appendChild(builtinHeader);

  const builtinRow = document.createElement('div');
  builtinRow.className = 'atv-preset-row';
  area.appendChild(builtinRow);

  builtinPresets.forEach(pr => {
    const chip = document.createElement('button');
    chip.className = 'atv-preset-chip';
    chip.textContent = pr.name;
    chip.title = pr.name;
    chip.addEventListener('click', () => onLoad(pr));
    builtinRow.appendChild(chip);
  });

  // ── Separator ─────────────────────────────────────────────────────────
  const sep = document.createElement('div');
  sep.className = 'atv-preset-sep';
  area.appendChild(sep);

  // ── User presets header ───────────────────────────────────────────────
  const userHeader = document.createElement('div');
  userHeader.className = 'atv-preset-header';
  userHeader.textContent = 'Saved Presets';
  area.appendChild(userHeader);

  const saveRow = document.createElement('div');
  saveRow.className = 'atv-preset-save-row';

  const nameInp = document.createElement('input');
  nameInp.className = 'atv-preset-name-inp';
  nameInp.type = 'text';
  nameInp.placeholder = 'name...';
  nameInp.maxLength = 32;

  const saveBtn = document.createElement('button');
  saveBtn.className = 'atv-preset-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    const name = nameInp.value.trim();
    if (!name) { nameInp.focus(); return; }
    if (onSave) onSave(name);
    nameInp.value = '';
  });
  nameInp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
  });

  saveRow.append(nameInp, saveBtn);
  area.appendChild(saveRow);

  const list = document.createElement('div');
  list.className = 'atv-preset-list';
  area.appendChild(list);

  let _activeIdx = -1;

  function refreshPresets(prs) {
    list.innerHTML = '';
    if (!prs.length) {
      const hint = document.createElement('div');
      hint.className = 'atv-preset-empty';
      hint.textContent = 'No saved presets';
      list.appendChild(hint);
      return;
    }
    prs.forEach((pr, i) => {
      const chip = document.createElement('button');
      chip.className = 'atv-preset-chip' + (i === _activeIdx ? ' active' : '');
      chip.textContent = pr.name;
      chip.title = pr.name + '\nRight-click to delete';

      chip.addEventListener('click', () => {
        _activeIdx = i;
        if (onLoad) onLoad(pr);
        list.querySelectorAll('.atv-preset-chip').forEach((c, j) =>
          c.classList.toggle('active', j === i));
      });

      chip.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (confirm(`Delete preset "${pr.name}"?`)) {
          if (i === _activeIdx) _activeIdx = -1;
          if (onDelete) onDelete(i);
        }
      });

      list.appendChild(chip);
    });
  }

  refreshPresets(presets);

  return { refreshPresets };
}
