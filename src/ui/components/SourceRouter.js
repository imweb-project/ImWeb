/**
 * Source router — a floating grid of small live pictures, one per source and
 * mix bus. Click a picture to send that source to a layer.
 *
 * A VIEW of layer.fg / layer.bg / layer.ds: a click is `ps.set('layer.x', i)`,
 * exactly what the Layers dropdown writes, and the FG/BG/DS marks on the
 * tiles are read back from those params.
 *
 * HOW THE PICTURES ARE MADE. While the window is open — and only then — the
 * render loop calls tick() after the frame is drawn. A few times a second it
 * draws every source texture that exists into one small atlas target, reads
 * the atlas back once, and paints it to a 2D canvas the tiles sit over. One
 * readback for the whole grid, not one per tile.
 *
 * WHAT A PICTURE MEANS. A source nothing routes is not rendered by the
 * engine, and the router does not force it to be — that would cost a full
 * render of every source for a thumbnail. So an unused source shows its last
 * picture, or none, and its tile is dimmed (`idle`). Route it and it wakes.
 *
 * The atlas is written, never sampled, so there is no feedback path here.
 */
import * as THREE from 'three';
import { SOURCES, SOURCE_DISPLAY_ORDER } from '../../controls/ParameterSystem.js';
import { makeFloating } from './FloatingWindow.js';

const COLS = 8;
const TILE_W = 112;
const TILE_H = 63;
const TICK_MS = 200;
const LAYERS = [
  { key: 'fg', id: 'layer.fg', label: 'FG' },
  { key: 'bg', id: 'layer.bg', label: 'BG' },
  { key: 'ds', id: 'layer.ds', label: 'DS' },
];

export class SourceRouter {
  constructor(ps) {
    this.ps = ps;
    // Same order as the Layers dropdown; headers are dropdown furniture.
    this.order = SOURCE_DISPLAY_ORDER.filter(e => typeof e === 'number');
    this.rows = Math.ceil(this.order.length / COLS);
    this.target = 'fg';
    this._last = 0;
    this._gl = null; // built on first tick — no VRAM unless the window is used

    const W = COLS * TILE_W, H = this.rows * TILE_H;
    this.el = document.createElement('div');
    this.el.id = 'source-router';
    this.el.className = 'hidden';

    const bar = document.createElement('div');
    bar.id = 'source-router-titlebar';
    bar.title = 'Drag to move';
    const title = document.createElement('span');
    title.textContent = 'Router';
    const targets = document.createElement('span');
    targets.className = 'router-targets';
    this._targetBtns = LAYERS.map(l => {
      const b = document.createElement('button');
      b.textContent = l.label;
      b.title = `A click sends the source to ${this.ps.get(l.id)?.label ?? l.label}`;
      b.addEventListener('click', () => { this.target = l.key; this._paintMarks(); });
      targets.appendChild(b);
      return b;
    });
    const hint = document.createElement('span');
    hint.className = 'router-hint';
    hint.textContent = '⇧ click = BG · ⌥ click = DS';
    const close = document.createElement('button');
    close.className = 'router-close';
    close.textContent = '✕';
    close.title = 'Close (R)';
    close.addEventListener('click', () => this.toggle(false));
    bar.append(title, targets, hint, close);

    const body = document.createElement('div');
    body.className = 'router-body';
    body.style.aspectRatio = `${W} / ${H}`;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this._ctx = this.canvas.getContext('2d');
    const grid = document.createElement('div');
    grid.className = 'router-grid';
    grid.style.gridTemplateColumns = `repeat(${COLS}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${this.rows}, 1fr)`;
    this._tiles = this.order.map(idx => {
      const t = document.createElement('button');
      t.className = 'router-tile idle';
      const name = document.createElement('span');
      name.className = 'router-name';
      name.textContent = SOURCES[idx];
      const marks = document.createElement('span');
      marks.className = 'router-marks';
      t.append(marks, name);
      t.addEventListener('click', e => {
        if (e.ctrlKey || e.metaKey) return;
        const key = e.altKey ? 'ds' : e.shiftKey ? 'bg' : this.target;
        this.ps.set(`layer.${key}`, idx);
      });
      grid.appendChild(t);
      return { el: t, marks, idx };
    });
    body.append(this.canvas, grid);
    this.el.append(bar, body);
    document.body.appendChild(this.el);

    this._win = makeFloating(this.el, bar, 'imweb.routerGeom', {
      isHidden: () => this.el.classList.contains('hidden'),
      defaultPos: (w, h, vw) => ({ x: Math.max(8, (vw - w) / 2), y: 70 }),
    });
    LAYERS.forEach(l => ps.get(l.id)?.onChange(() => this._paintMarks()));
    this._paintMarks();
  }

  get open() { return !this.el.classList.contains('hidden'); }

  toggle(on = !this.open) {
    const was = this.open;
    this.el.classList.toggle('hidden', !on);
    if (on && !was) { this._win?.place(); this._last = 0; }
  }

  _paintMarks() {
    this._targetBtns.forEach((b, i) => b.classList.toggle('active', LAYERS[i].key === this.target));
    const at = LAYERS.map(l => this.ps.get(l.id)?.value);
    for (const t of this._tiles) {
      const m = LAYERS.filter((l, i) => at[i] === t.idx).map(l => l.label);
      t.marks.textContent = m.join(' ');
      t.el.classList.toggle('routed', m.length > 0);
    }
  }

  _build() {
    const W = COLS * TILE_W, H = this.rows * TILE_H;
    const rt = new THREE.WebGLRenderTarget(W, H, {
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    rt.scissorTest = true;
    const mat = new THREE.ShaderMaterial({
      uniforms: { t: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      // Opaque on purpose: Text and Draw are transparent where empty, and a
      // thumbnail that is see-through reads as a broken tile.
      fragmentShader: 'uniform sampler2D t; varying vec2 vUv; void main(){ vec4 c = texture2D(t, vUv); gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), 1.0); }',
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    const flip = document.createElement('canvas');
    flip.width = W; flip.height = H;
    this._gl = {
      rt, mat, scene, cam: new THREE.Camera(),
      pixels: new Uint8Array(W * H * 4),
      prevClear: new THREE.Color(),
      image: new ImageData(W, H),
      flip, flipCtx: flip.getContext('2d'),
    };
  }

  /**
   * @param renderer THREE.WebGLRenderer
   * @param texFor   (sourceIdx) => THREE.Texture | null — null: no picture
   * @param used     (sourceIdx) => boolean — is the engine rendering it
   * @param now      performance.now() of this frame
   */
  tick(renderer, texFor, used, now) {
    if (!this.open || now - this._last < TICK_MS) return;
    this._last = now;
    if (!this._gl) this._build();
    const g = this._gl;
    const W = COLS * TILE_W, H = this.rows * TILE_H;

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(g.prevClear);
    renderer.autoClear = false;
    g.rt.viewport.set(0, 0, W, H);
    g.rt.scissor.set(0, 0, W, H);
    renderer.setRenderTarget(g.rt);
    renderer.setClearColor(0x0a0a0b, 1);
    renderer.clear(true, false, false);
    this._tiles.forEach((t, i) => {
      const tex = texFor(t.idx);
      t.el.classList.toggle('idle', !used(t.idx));
      t.el.classList.toggle('blank', !tex);
      if (!tex) return;
      // GL rows run bottom-up; the readback is flipped once at the end, so
      // tile row 0 is drawn at the TOP of the target here.
      const x = (i % COLS) * TILE_W;
      const y = (this.rows - 1 - Math.floor(i / COLS)) * TILE_H;
      g.rt.viewport.set(x, y, TILE_W, TILE_H);
      g.rt.scissor.set(x, y, TILE_W, TILE_H);
      renderer.setRenderTarget(g.rt); // re-bind so the new viewport applies
      g.mat.uniforms.t.value = tex;
      renderer.render(g.scene, g.cam);
    });
    renderer.readRenderTargetPixels(g.rt, 0, 0, W, H, g.pixels);
    g.mat.uniforms.t.value = null;
    // Everything borrowed from the renderer goes back as it was found.
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(g.prevClear, prevAlpha);
    renderer.autoClear = prevAuto;

    g.image.data.set(g.pixels);
    g.flipCtx.putImageData(g.image, 0, 0);
    this._ctx.save();
    this._ctx.setTransform(1, 0, 0, -1, 0, H);
    this._ctx.drawImage(g.flip, 0, 0);
    this._ctx.restore();
  }
}
