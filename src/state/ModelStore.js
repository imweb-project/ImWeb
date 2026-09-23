/**
 * ModelStore — keeps imported 3D model files in IndexedDB so a model you
 * dragged in (or picked with Import) survives a reload and comes back when a
 * state that used it is recalled.
 *
 * Why this exists. States record a dropped model by FILE NAME only
 * (mediaRefs.scene3d); the bytes were never kept, so on reload the scene
 * showed a neutral placeholder and asked for the file again. URL models
 * (/assets/…) never had the problem — they can be fetched again.
 *
 * Records live in the shared DB's 'assets' store (registered long ago, unused
 * until now — no schema bump), keyed `model:<file name>`: the same name the
 * state already records, so recall needs no new field. The model file is kept
 * with its companions (.bin, .mtl, textures) because a .gltf or .obj is not
 * loadable without them. A newer import under the same name replaces the old.
 *
 * Per-origin, like every IndexedDB store here: a model saved on :5173 is not
 * on :4173. A .imweb export still carries only the URL, not these bytes.
 */

import { openDB } from './Preset.js';

const STORE = 'assets';
const key = name => `model:${name}`;

// Names held, kept in memory so recall can ask SYNCHRONOUSLY whether a model
// will come back by itself (the missing-media toast fires before any async
// restore could finish). Filled once at boot by initModelStore().
const _known = new Set();
export const hasStoredModel = name => _known.has(name);

/** Read the stored model names. Call once at boot, before the first recall. */
export async function initModelStore() {
  try {
    const db = await openDB();
    const keys = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror   = () => reject(req.error);
    });
    for (const k of keys) if (typeof k === 'string' && k.startsWith('model:')) _known.add(k.slice(6));
  } catch (e) {
    console.warn('[ModelStore] init failed', e);
  }
}

const KEEP = /\.(glb|gltf|obj|stl|dae|bin|mtl|png|jpe?g|webp|bmp|tga|ktx2)$/i;
export const MODEL_FILE = /\.(glb|gltf|obj|stl|dae)$/i;

/** Store the model file and its companions. Resolves false on any failure. */
export async function saveModelFiles(modelName, files) {
  try {
    const kept = files.filter(f => KEEP.test(f.name));
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        hash: key(modelName),
        kind: 'model',
        name: modelName,
        files: kept.map(f => ({ name: f.name, type: f.type, blob: f })),
        savedAt: Date.now(),
      });
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
    _known.add(modelName);
    return true;
  } catch (e) {
    // Quota or a blocked store: the model still loaded, it just won't persist.
    console.warn('[ModelStore] save failed', e);
    return false;
  }
}

/** The stored files as File objects, or null if this model was never kept. */
export async function loadModelFiles(modelName) {
  try {
    const db = await openDB();
    const rec = await new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key(modelName));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
    if (!rec?.files?.length) return null;
    return rec.files.map(f => new File([f.blob], f.name, { type: f.type }));
  } catch (e) {
    console.warn('[ModelStore] load failed', e);
    return null;
  }
}
