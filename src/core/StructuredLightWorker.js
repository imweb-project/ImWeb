/**
 * ImWeb Structured Light — the scan Worker. A shell: all behaviour is in
 * StructuredLightHost.js, where node can test it. Create with
 *   new Worker(new URL('./StructuredLightWorker.js', import.meta.url), { type: 'module' })
 * and speak the protocol documented there. Scans are stored from here
 * (IndexedDB exists in workers), so the correspondence arrays never have to
 * cross to the main thread.
 */

import { createScanHost } from './StructuredLightHost.js';
import { ScanStore } from './ScanStore.js';

// globalThis, not `self`: the same object in a worker, and a name the
// src/core identifier audit already knows.
const host = createScanHost({
  post: (msg, transfer = []) => globalThis.postMessage(msg, transfer),
  store: globalThis.indexedDB ? new ScanStore() : null,
});

globalThis.onmessage = (e) => { host.handle(e.data); };
