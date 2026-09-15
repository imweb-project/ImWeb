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
 * Feedback goes to the third argument: `host:port`, or just `port` on the host
 * of whichever device last sent OSC. Without it, feedback goes back to that
 * device's own address AND port — which only works for apps that listen on the
 * socket they send from. Most controller apps listen on a separate port, so
 * give them the third argument, set to the port the app RECEIVES on.
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

import dgram from 'node:dgram';
import { WebSocketServer } from 'ws';

const UDP_PORT = Number(process.argv[2] ?? 9000);
const WS_PORT  = Number(process.argv[3] ?? 8080);
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
const out = { sent: 0, noTarget: 0, last: '', to: '' };
setInterval(() => {
  if (out.sent) console.log(`[relay] ← imweb  ${out.sent} msg/s → ${out.to}  (last ${out.last})`);
  if (out.noTarget) console.log(`[relay] ← imweb  ${out.noTarget} feedback msg(s) dropped — no device has sent OSC yet; or pass host:port as the 3rd argument`);
  out.sent = 0; out.noTarget = 0;
}, 1000).unref();

const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Set();
wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[relay] ImWeb connected (${req.socket.remoteAddress}) — ${clients.size} client(s)`);
  ws.on('close', () => { clients.delete(ws); console.log(`[relay] client left — ${clients.size} left`); });
  ws.on('error', () => clients.delete(ws));
  // ImWeb's parameter feedback: { address, args } JSON → OSC over UDP.
  ws.on('message', (d) => {
    let m;
    try { m = JSON.parse(String(d)); } catch { return; }
    if (typeof m?.address !== 'string' || !m.address.startsWith('/')) return;
    const host = REPLY?.host ?? lastSender?.address;
    const port = REPLY?.port ?? lastSender?.port;
    if (!host || !port) { out.noTarget++; return; }
    udp.send(encodeOSC(m.address, Array.isArray(m.args) ? m.args : []), port, host, () => {});
    out.sent++; out.last = `${m.address} ${m.args?.[0]}`; out.to = `${host}:${port}`;
  });
});

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
  console.log(`[relay] WebSocket listening on ws://localhost:${WS_PORT}`);
  console.log(REPLY
    ? `[relay] feedback → ${REPLY.host ?? '(last sender host)'}:${REPLY.port}`
    : '[relay] feedback → the last device that sent OSC, at the port it sent from');
  console.log('[relay] point Flic at this machine, UDP port ' + UDP_PORT);
  console.log('[relay] then in ImWeb click the OSC badge and accept ws://localhost:' + WS_PORT);
});
