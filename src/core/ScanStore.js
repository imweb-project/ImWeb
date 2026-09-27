/**
 * ImWeb Structured Light — scans in IndexedDB.
 *
 * Stores the DECODED scans (camera → projector correspondence), not the baked
 * textures. The raw scan is the measurement; everything else is a function of
 * it plus settings, so a stored scan can be re-baked with a different step
 * threshold or re-fitted at another grid size without standing in front of
 * the projector again. It is also 14x smaller: every position the decoder
 * emits is a multiple of 1/2 projector px, so x and y pack EXACTLY into
 * Uint16 as 2·x — 3.7 MB for a 1280x720 camera, against ~52 MB for the
 * 1080p texture set.
 *
 * Per-origin, like every other ImWeb store: scans saved on :5173 are not
 * visible on :4173. That is why a scan SLOT param must be group 'global'
 * (never captured by Display States) — a captured id would name nothing on
 * another origin or machine.
 *
 * Two object stores under one id: 'index' (small: name, dates, meta, fit) so
 * a list never loads megabytes, and 'data' (the encoded scans).
 *
 * Every record carries `v`. decodeScan and ScanStore.get are the ONLY readers
 * of stored data; a record from a newer format is refused, not guessed at.
 */

export const SCAN_DB = 'imweb-scans';
export const SCAN_FORMAT = 1;
const INVALID = 0xFFFF;

/** Decoder output → compact, structured-clone-safe record. Throws if a
 *  position is not a multiple of 1/2 or does not fit — the exactness this
 *  format rests on is checked, not assumed. */
export function encodeScan(res) {
  const { camW, camH, projW, projH, x, y, valid } = res;
  const n = camW * camH;
  const xy = new Uint16Array(2 * n).fill(INVALID);
  let nValid = 0;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const a = x[i] * 2;
    const b = y[i] * 2;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= INVALID || b >= INVALID) {
      throw new Error(`encodeScan: position (${x[i]}, ${y[i]}) at pixel ${i} is not a multiple of 1/2 in range`);
    }
    xy[2 * i] = a;
    xy[2 * i + 1] = b;
    nValid++;
  }
  return { v: SCAN_FORMAT, camW, camH, projW, projH, nValid, xy };
}

/** Record → the decoder's output shape (x, y at pixel-centre units, NaN when
 *  invalid), ready for bake / fit. */
export function decodeScan(e) {
  if (!e || e.v !== SCAN_FORMAT) throw new Error(`decodeScan: unsupported scan format ${e?.v}`);
  const { camW, camH, projW, projH, xy } = e;
  const n = camW * camH;
  if (!(xy instanceof Uint16Array) || xy.length !== 2 * n) throw new Error('decodeScan: data does not match its size');
  const x = new Float32Array(n).fill(NaN);
  const y = new Float32Array(n).fill(NaN);
  const valid = new Uint8Array(n);
  let nValid = 0;
  for (let i = 0; i < n; i++) {
    if (xy[2 * i] === INVALID) continue;
    x[i] = xy[2 * i] / 2;
    y[i] = xy[2 * i + 1] / 2;
    valid[i] = 1;
    nValid++;
  }
  return { camW, camH, projW, projH, x, y, valid, nValid };
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
});

export class ScanStore {
  constructor({ idb = globalThis.indexedDB, name = SCAN_DB } = {}) {
    if (!idb) throw new Error('ScanStore: no IndexedDB in this context');
    this.idb = idb;
    this.name = name;
    this._db = null;
  }

  async open() {
    if (this._db) return this._db;
    const r = this.idb.open(this.name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('index')) db.createObjectStore('index', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
    };
    this._db = await req(r);
    return this._db;
  }

  close() {
    this._db?.close();
    this._db = null;
  }

  /**
   * Save a scan set. `scans` maps role → decoder output (e.g. { object,
   * reference }); `fit` is an optional ProjMapMesh.serialize() result. Both
   * stores are written in ONE transaction, so a list can never show an entry
   * whose data is missing. Returns the id.
   */
  async put({ id = null, name = 'Scan', meta = {}, scans, fit = null }) {
    const db = await this.open();
    id = id ?? (globalThis.crypto?.randomUUID?.() ?? `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const encoded = {};
    const sizes = {};
    for (const [role, res] of Object.entries(scans)) {
      encoded[role] = encodeScan(res);
      sizes[role] = { camW: res.camW, camH: res.camH, projW: res.projW, projH: res.projH, nValid: encoded[role].nValid };
    }
    const tx = db.transaction(['index', 'data'], 'readwrite');
    tx.objectStore('index').put({ id, v: SCAN_FORMAT, name, created: Date.now(), meta, sizes, fit });
    tx.objectStore('data').put({ id, v: SCAN_FORMAT, scans: encoded });
    await done(tx);
    return id;
  }

  /** Index entries only — no scan data is read. Newest first. */
  async list() {
    const db = await this.open();
    const all = await req(db.transaction('index').objectStore('index').getAll());
    return all.sort((a, b) => b.created - a.created);
  }

  /** The full set, decoded. Null when the id is unknown. */
  async get(id) {
    const db = await this.open();
    const tx = db.transaction(['index', 'data']);
    const [entry, data] = await Promise.all([req(tx.objectStore('index').get(id)), req(tx.objectStore('data').get(id))]);
    if (!entry || !data) return null;
    if (entry.v !== SCAN_FORMAT || data.v !== SCAN_FORMAT) throw new Error(`ScanStore: scan ${id} is format ${entry.v}/${data.v}, this build reads ${SCAN_FORMAT}`);
    const scans = {};
    for (const [role, e] of Object.entries(data.scans)) scans[role] = decodeScan(e);
    return { ...entry, scans };
  }

  async delete(id) {
    const db = await this.open();
    const tx = db.transaction(['index', 'data'], 'readwrite');
    tx.objectStore('index').delete(id);
    tx.objectStore('data').delete(id);
    await done(tx);
  }
}
