#!/usr/bin/env node
/**
 * OSC → WebSocket relay for ImWeb.
 *
 * A browser cannot open a UDP socket, so it cannot speak OSC directly. This
 * sits in the middle, both ways: UDP OSC in → JSON over WebSocket, in the exact
 * shape OSCBridge._dispatch expects — { address, args } — and ImWeb's
 * parameter feedback → OSC over UDP back out.
 *
 *   Flic / TouchOSC / Max  <--UDP OSC-->  this relay  <--WebSocket-->  ImWeb
 *
 * Run:   node tools/osc-relay.mjs                             (UDP 9000, WS 8080)
 *        node tools/osc-relay.mjs 9000 8080                   (explicit)
 *        node tools/osc-relay.mjs 9000 8080 192.168.1.20:9001 (feedback target)
 *
 * Then in ImWeb click the OSC badge in the status bar and accept
 * ws://localhost:8080.
 *
 * ImWeb Remote: the same port also serves the phone/iPad remote page
 * (tools/remote/). Open the http://<this Mac's address>:8080/ printed at start
 * in Safari on a device on the same Wi-Fi. Browser clients are relayed to each
 * other, so the remote and ImWeb talk through here exactly like an OSC device.
 *
 * Feedback goes to the third argument: `host:port`, or just `port` on the host
 * of whichever device last sent OSC. Without it, feedback goes back to that
 * device's own address AND port — which only works for apps that listen on the
 * socket they send from. Most controller apps listen on a separate port, so
 * give them the third argument, set to the port the app RECEIVES on.
 *
 * Tilt: the Remote's Tilt button reads the device's motion sensors, which
 * browsers give only to an https page with a certificate the device trusts.
 * `node tools/remote-cert.mjs` makes one; from then on this relay also serves
 * the Remote at https on the WebSocket port + 363 (8443 for 8080) and prints
 * the address. Without a certificate nothing changes.
 *
 * Addresses ImWeb understands (see src/io/OSCBridge.js):
 *   /imweb/<paramId>      <0..1>   set a parameter, NORMALISED (not raw units);
 *                                  a TOGGLE takes >0.5 as on
 *   /imweb/toggle/<id>             flip a TOGGLE on the press
 *   /imweb/trigger/<id>            fire a TRIGGER on the press
 *   /imweb/preset/<n>              recall preset n
 * and ImWeb sends back /imweb/<paramId> <0..1> for every change.
 *
 * A button that sends no argument counts as 1 here. Point a Flic at
 * /imweb/toggle/<id> to flip a toggle per click — /imweb/<id> would only ever
 * turn it on.
 *
 * No dependencies beyond `ws`, which the project already has. The OSC codec
 * below is deliberately small: it reads the address and the args named in the
 * type tag, and writes floats and strings, which is all ImWeb exchanges.
 */

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const UDP_PORT = Number(process.argv[2] ?? 9000);
const WS_PORT  = Number(process.argv[3] ?? 8080);
const TLS_PORT = WS_PORT + 363;   // the Remote's secure address, when a certificate exists
// tools/remote-cert.mjs writes here. No certificate → no secure address, and
// everything else is exactly as it was.
const CERT_DIR = process.env.IMWEB_REMOTE_CERT || fileURLToPath(new URL('./.remote-cert/', import.meta.url));
const TLS = (() => {
  const f = (n) => readFileSync(path.join(CERT_DIR, n));
  try { return { key: f('server.key'), cert: f('server.crt'), ca: f('ca.crt') }; } catch { return null; }
})();
// Feedback target: "host:port", "port" (on the last sender's host), or absent
// (the last sender's own address and port).
const REPLY = (() => {
  const a = process.argv[4];
  if (!a) return null;
  const [host, p] = a.includes(':') ? a.split(':') : [null, a];
  const port = Number(p);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[relay] bad feedback target "${a}" — use host:port or port`);
    process.exit(1);
  }
  return { host: host || null, port };
})();
let lastSender = null; // { address, port } of the last device that sent OSC

// ── Minimal OSC 1.0 decoding ────────────────────────────────────────────────
// Strings are null-terminated and padded to a multiple of 4; ints and floats
// are 32-bit big-endian. Anything in the type tag we do not handle is skipped
// rather than throwing, so an unexpected argument cannot take the relay down
// mid-performance.
function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('utf8', off, end);
  return [str, off + Math.ceil((end - off + 1) / 4) * 4];
}

function decodeOSC(buf) {
  try {
    if (buf.toString('utf8', 0, 8) === '#bundle\0') {
      // Bundle: 8-byte tag + 8-byte timetag, then size-prefixed elements.
      const out = [];
      let off = 16;
      while (off + 4 <= buf.length) {
        const size = buf.readInt32BE(off); off += 4;
        if (size <= 0 || off + size > buf.length) break;
        const msg = decodeOSC(buf.subarray(off, off + size));
        if (msg) out.push(...msg);
        off += size;
      }
      return out;
    }
    let [address, off] = readString(buf, 0);
    if (!address.startsWith('/')) return null;
    const args = [];
    if (off < buf.length) {
      let tags;
      [tags, off] = readString(buf, off);
      for (const t of tags.slice(1)) {            // slice(1) drops the leading ','
        if (t === 'i') { args.push(buf.readInt32BE(off));   off += 4; }
        else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
        else if (t === 's') { const [s, n] = readString(buf, off); args.push(s); off = n; }
        else if (t === 'T') args.push(1);
        else if (t === 'F') args.push(0);
        else if (t === 'd') { args.push(buf.readDoubleBE(off)); off += 8; }
        else if (t === 'N' || t === 'I') args.push(1);
        // Unknown tag: stop reading args rather than guess a width and
        // misalign everything after it.
        else break;
      }
    }
    return [{ address, args }];
  } catch {
    return null; // a malformed packet is dropped, never fatal
  }
}

// ── Minimal OSC 1.0 encoding (feedback) ─────────────────────────────────────
// Numbers go out as float32 — ImWeb's feedback is normalised 0..1, and faders
// and toggle widgets accept a float. Strings are 's'. Anything else is dropped.
function oscString(s) {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]); // ≥1 null, padded to 4
}

function encodeOSC(address, args) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (typeof a === 'number' && Number.isFinite(a)) {
      const b = Buffer.alloc(4); b.writeFloatBE(a); parts.push(b); tags += 'f';
    } else if (typeof a === 'string') {
      parts.push(oscString(a)); tags += 's';
    }
  }
  return Buffer.concat([oscString(address), oscString(tags), ...parts]);
}

// ── Relay ───────────────────────────────────────────────────────────────────
// Feedback is batched in ImWeb but still steady (a running LFO sends 20 msg/s),
// so it is summarised once a second rather than logged per message.
const out = { sent: 0, noTarget: 0, last: '', to: '', peer: 0, peerLast: '' };
setInterval(() => {
  if (out.sent) console.log(`[relay] ← imweb  ${out.sent} msg/s → ${out.to}  (last ${out.last})`);
  if (out.peer) console.log(`[relay] browser ↔ browser  ${out.peer} msg/s  (last ${out.peerLast})`);
  out.peer = 0;
  if (out.noTarget) console.log(`[relay] ← imweb  ${out.noTarget} feedback msg(s) dropped — no device has sent OSC yet; or pass host:port as the 3rd argument`);
  out.sent = 0; out.noTarget = 0;
}, 1000).unref();

// ── ImWeb Remote page ───────────────────────────────────────────────────────
// The phone/iPad remote (tools/remote/) is served from HERE, over plain http on
// the WebSocket port, rather than from Vite. Two reasons, both Safari: the dev
// server is https with a self-signed certificate (a warning page on every
// phone), and an https page may not open a plain ws:// socket to the Mac. Same
// origin as the socket, so the page simply dials ws://<the host it came from>.
// A fixed list of files — nothing else on disk is reachable through this.
const REMOTE_DIR = fileURLToPath(new URL('./remote/', import.meta.url));
const REMOTE_FILES = {
  '/':           ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/remote.js':  ['remote.js',  'text/javascript; charset=utf-8'],
  '/remote.css': ['remote.css', 'text/css; charset=utf-8'],
};
const servePage = async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  // The certificate authority's PUBLIC half, so a phone can fetch and trust it.
  // Its key is never served: this and REMOTE_FILES are all that is reachable.
  if (url === '/ca.crt' && TLS) {
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Cache-Control': 'no-store' }).end(TLS.ca);
    return;
  }
  const f = REMOTE_FILES[url];
  if (!f) { res.writeHead(404).end('not found'); return; }
  try {
    const body = await readFile(REMOTE_DIR + f[0]);
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(500).end('remote page missing'); }
};
const server = http.createServer(servePage);

const clients = new Set();
// One room, two doors: a browser on the plain port and one on the secure port
// are peers like any others (ImWeb on ws://localhost, the phone on wss://).
const onClient = (ws, req) => {
  clients.add(ws);
  console.log(`[relay] browser connected (${req.socket.remoteAddress}) — ${clients.size} client(s)`);
  ws.on('close', () => { clients.delete(ws); console.log(`[relay] client left — ${clients.size} left`); });
  ws.on('error', () => clients.delete(ws));
  ws.on('message', (d) => {
    let m;
    try { m = JSON.parse(String(d)); } catch { return; }
    if (typeof m?.address !== 'string' || !m.address.startsWith('/')) return;
    // Browser to browser: ImWeb's feedback reaches the remote page, and the
    // remote's moves reach ImWeb. Never back to the sender — that would be an
    // echo of its own move.
    const line = JSON.stringify({ address: m.address, args: Array.isArray(m.args) ? m.args : [] });
    let peers = 0;
    for (const c of clients) {
      if (c === ws || c.readyState !== 1) continue;
      try { c.send(line); peers++; } catch {}
    }
    if (peers) { out.peer++; out.peerLast = `${m.address} ${String(m.args?.[0] ?? '').slice(0, 24)}`; }
    // The remote's own vocabulary means nothing to a hardware OSC device.
    if (m.address.startsWith('/imweb/remote/')) return;
    // Out to UDP (Flic, TouchOSC, Max). With no device yet, it is only a drop
    // worth reporting when no browser peer took the message either.
    const host = REPLY?.host ?? lastSender?.address;
    const port = REPLY?.port ?? lastSender?.port;
    if (!host || !port) { if (!peers) out.noTarget++; return; }
    udp.send(encodeOSC(m.address, Array.isArray(m.args) ? m.args : []), port, host, () => {});
    out.sent++; out.last = `${m.address} ${m.args?.[0]}`; out.to = `${host}:${port}`;
  });
};
new WebSocketServer({ server }).on('connection', onClient);

/** Addresses a phone on the same network can reach this Mac at. */
function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${WS_PORT}/`);
  }
  return urls;
}
server.on('error', (e) => { console.error(`[relay] port ${WS_PORT}:`, e.message); process.exit(1); });
server.listen(WS_PORT, () => {
  console.log(`[relay] Remote page  http://localhost:${WS_PORT}/`);
  for (const u of lanUrls()) console.log(`[relay]   on the phone/iPad: ${u}`);
  if (!TLS) console.log('[relay]   (for the Tilt button: node tools/remote-cert.mjs, then restart)');
});

// The secure address — only with a certificate from tools/remote-cert.mjs. A
// port already in use costs the Tilt button, never the relay.
if (TLS) {
  const secure = https.createServer({ key: TLS.key, cert: TLS.cert }, servePage);
  new WebSocketServer({ server: secure }).on('connection', onClient);
  secure.on('error', (e) => console.error(`[relay] secure port ${TLS_PORT}: ${e.message} — Tilt will not work, the rest does`));
  secure.listen(TLS_PORT, () => {
    // The names the certificate was made for are the only ones a phone accepts.
    const names = String(new crypto.X509Certificate(TLS.cert).subjectAltName ?? '')
      .split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/, ''))
      .filter((n) => n && n !== 'localhost' && n !== '127.0.0.1');
    const live = new Set(lanUrls().map((u) => new URL(u).hostname));
    console.log('[relay] Remote with Tilt (secure):');
    for (const n of names) {
      if (/^[0-9.]+$/.test(n) && !live.has(n)) continue;   // an address this Mac no longer has
      console.log(`[relay]   https://${n}:${TLS_PORT}/`);
    }
    if ([...live].some((a) => !names.includes(a))) {
      console.log('[relay]   (this Mac has a new address — use the .local name, or run node tools/remote-cert.mjs again)');
    }
    console.log(`[relay]   first time on a device: open  http://${[...live][0] ?? 'localhost'}:${WS_PORT}/ca.crt  there and trust it`);
    console.log('[relay]   iPhone/iPad: Allow → Settings → Profile Downloaded → Install, then');
    console.log('[relay]                Settings → General → About → Certificate Trust Settings → switch it on');
    console.log('[relay]   Android:     Settings → Security → Install a certificate → CA certificate');
  });
}

const udp = dgram.createSocket('udp4');
udp.on('message', (buf, rinfo) => {
  lastSender = { address: rinfo.address, port: rinfo.port };
  const msgs = decodeOSC(buf);
  if (!msgs?.length) { console.log(`[relay] unparseable packet from ${rinfo.address}`); return; }
  for (const m of msgs) {
    // A bare button press carries no argument. ImWeb reads args[0] and a
    // missing one parses as NaN, which its dispatcher drops — so a plain Flic
    // click would do nothing at all. Default it to 1: "the button fired".
    if (!m.args.length) m.args = [1];
    const line = JSON.stringify(m);
    console.log(`[relay] ${rinfo.address} → ${line}`);
    if (!clients.size) console.log('[relay]   (no ImWeb connected — click the OSC badge in the status bar)');
    for (const ws of clients) { try { ws.send(line); } catch {} }
  }
});
udp.on('error', (e) => { console.error('[relay] UDP error:', e.message); process.exit(1); });
udp.bind(UDP_PORT, () => {
  console.log(`[relay] OSC/UDP  listening on ${UDP_PORT}`);
  console.log(`[relay] WebSocket listening on ws://localhost:${WS_PORT} (and the Remote page, same port)`);
  console.log(REPLY
    ? `[relay] feedback → ${REPLY.host ?? '(last sender host)'}:${REPLY.port}`
    : '[relay] feedback → the last device that sent OSC, at the port it sent from');
  console.log('[relay] point Flic at this machine, UDP port ' + UDP_PORT);
  console.log('[relay] then in ImWeb click the OSC badge and accept ws://localhost:' + WS_PORT);
});
