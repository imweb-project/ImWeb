// Bundle the scan Worker, serve it with tools/procam/worker-check.html from a
// temp dir on a free port, run it in headless Chrome for Testing
// (tools/nca/cdp-run.mjs), print the steps, clean up. Nothing touches the
// app's ports or storage: the page's origin is a random localhost port.
//   node tools/procam/worker-check.mjs
import { mkdtempSync, rmSync, copyFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(join(tmpdir(), 'procam-worker-'));
let server = null;
let failed = false;
try {
  execFileSync(join(root, 'node_modules/.bin/rolldown'),
    [join(root, 'src/core/StructuredLightWorker.js'), '--format', 'esm', '--file', join(dir, 'worker.js')], { stdio: 'ignore' });
  copyFileSync(join(root, 'tools/procam/worker-check.html'), join(dir, 'check.html'));
  symlinkSync(join(root, 'src'), join(dir, 'src'));
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
  server = createServer((req, res) => {
    const p = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(dir) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/check.html`;
  const outText = await new Promise((res, rej) => {
    import('node:child_process').then(({ execFile }) =>
      execFile('node', [join(root, 'tools/nca/cdp-run.mjs'), url, '120000'], { maxBuffer: 1 << 24 },
        (e, stdout) => (e ? rej(e) : res(stdout))));
  });
  const r = JSON.parse(outText.split('\n')[0]);
  for (const [k, v] of r.steps) console.log(`  ${k}: ${JSON.stringify(v)}`);
  console.log(`  VideoFrame format: ${r.videoFrameFormat}`);
  if (r.error) { console.error(`  ERROR ${r.error}`); failed = true; }
  const step = Object.fromEntries(r.steps);
  const ok = step.object?.nValid === 64 * 48 && step.reference?.nValid === 64 * 48
    && step['fit identity max err (window fraction)'] === 0
    && step['refit bit-identical after reload in a new worker'] === true && step.list2 === 0
    && step['stream probe']?.type === 'latency';
  console.log(ok && !failed ? '\nall passed' : '\nFAILED');
  failed = failed || !ok;
} finally {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
