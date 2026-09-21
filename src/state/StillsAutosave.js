/**
 * ImWeb Stills Autosave
 *
 * Keeps PROTECTED still frames across a page reload, in IndexedDB.
 *
 * Why this exists. The stills buffer lives in WebGLRenderTargets, so a reload
 * empties it. ProjectFile persists protected slots, but only when a project is
 * exported — and a reload is not an export. A still captured for a performance
 * therefore survived only as long as the tab did, which is how a warp test
 * image disappeared mid-session with nothing having gone wrong.
 *
 * Scope is deliberately the same as ProjectFile's: PROTECTED slots only.
 * Protection is opt-in and already meaningful, so it doubles as "keep this",
 * and it keeps the stored size bounded — a pinned frame is a couple of hundred
 * KB of JPEG at 1280 wide, and an unpinned one costs nothing.
 *
 * The diff is a cheap SIGNATURE, never a re-encode. Comparing the actual
 * frames would mean a GPU readback plus JPEG encode per slot per tick just to
 * discover that nothing changed; StillsBuffer.revision bumps whenever a slot's
 * pixels change, so the signature is that counter plus the slot layout.
 *
 * Shape follows MappingAutosave: interval tick, plus pagehide and
 * visibilitychange so a tab closed or backgrounded between ticks does not lose
 * the last capture.
 */

import { openDB } from './Preset.js';

const STORE    = 'stills';
const RECORD   = 'autosave';
const TICK_MS  = 4000;

export class StillsAutosave {
  /**
   * @param {StillsBuffer} buffer
   * @param {object} [opts]
   * @param {number} [opts.maxWidth] passed to exportFrame
   * @param {(msg: string) => void} [opts.onStatus]
   */
  constructor(buffer, { maxWidth = 1280, onStatus = null } = {}) {
    this.buffer   = buffer;
    this.maxWidth = maxWidth;
    this.onStatus = onStatus;
    this._last    = null;
    this._timer   = null;
    this._busy    = false;
    this._onHide  = () => { this.flush(); };
  }

  /**
   * frameCount | protected slots | pixel revision.
   *
   * Protection changes show up directly in the list, so pinning an already
   * captured slot is picked up without the buffer having to signal it.
   */
  _signature() {
    const b = this.buffer;
    const prot = [...b._protected].sort((x, y) => x - y).join(',');
    return `${b.frameCount}|${prot}|${b.revision}`;
  }

  /** Write protected slots if anything changed. Returns true if it wrote. */
  async flush() {
    if (this._busy) return false;
    const sig = this._signature();
    if (sig === this._last) return false;
    this._busy = true;
    try {
      const b = this.buffer;
      const frames = {};
      for (const idx of b._protected) {
        const url = b.exportFrame(idx, this.maxWidth);
        if (url) frames[idx] = url;
      }
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({
          id: RECORD,
          frameCount: b.frameCount,
          protected: [...b._protected],
          frames,
          savedAt: Date.now(),
        });
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
      });
      this._last = sig;
      return true;
    } catch (e) {
      // Quota, a blocked store, a private window. Never break the instrument
      // over a failed autosave; the next tick tries again.
      console.warn('[StillsAutosave] save failed', e);
      return false;
    } finally {
      this._busy = false;
    }
  }

  /**
   * Restore protected slots. Call once at boot, before start().
   * @returns {Promise<number>} how many frames came back
   */
  async restore() {
    try {
      const db = await openDB();
      const rec = await new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(RECORD);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error);
      });
      if (!rec) return 0;

      if (rec.frameCount && rec.frameCount !== this.buffer.frameCount) {
        this.buffer.setFrameCount(rec.frameCount);
      }
      if (Array.isArray(rec.protected)) {
        this.buffer._protected.clear();
        rec.protected.forEach(i => this.buffer._protected.add(i));
      }

      let n = 0;
      for (const k of Object.keys(rec.frames ?? {})) {
        // importFrame resolves false rather than throwing, and leaves
        // _hasFrame false on failure — a slot must never claim a still whose
        // pixels did not come back.
        if (await this.buffer.importFrame(Number(k), rec.frames[k])) n++;
      }

      // Adopt the restored state as the baseline, so the first tick does not
      // immediately re-encode and rewrite everything we just read.
      this._last = this._signature();

      if (n && this.onStatus) {
        // Name the origin: IndexedDB is per-origin, and "my stills vanished"
        // has meant "different port" before.
        this.onStatus(`${n} still${n === 1 ? '' : 's'} restored from ${location.origin}`);
      }
      return n;
    } catch (e) {
      console.warn('[StillsAutosave] restore failed', e);
      return 0;
    }
  }

  /** Begin watching. Idempotent. */
  start() {
    if (this._timer) return;
    if (this._last === null) this._last = this._signature();
    this._timer = setInterval(() => this.flush(), TICK_MS);
    addEventListener('pagehide', this._onHide);
    addEventListener('visibilitychange', this._onHide);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    removeEventListener('pagehide', this._onHide);
    removeEventListener('visibilitychange', this._onHide);
  }

  /** Forget the saved stills. Live frames are untouched. */
  async clear() {
    try {
      const db = await openDB();
      await new Promise(resolve => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(RECORD);
        tx.oncomplete = resolve;
        tx.onerror    = resolve;
      });
      this._last = null;
    } catch { /* nothing to do */ }
  }
}
