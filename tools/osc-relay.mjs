#!/usr/bin/env node
/**
 * OSC → WebSocket relay for ImWeb.
 *
 * A browser cannot open a UDP socket, so it cannot receive OSC directly. This
 * sits in the middle: UDP OSC in, JSON over WebSocket out, in the exact shape
 * OSCBridge._dispatch expects — { address, args }.
 *
 *   Flic / TouchOSC / Max  --UDP OSC-->  this relay  --WebSocket-->  ImWeb
 *
 * Run:   node tools/osc-relay.mjs            (UDP 9000, WS 8080)
 *        node tools/osc-relay.mjs 9000 8080  (explicit)
 *
 * Then in ImWeb click the OSC badge in the status bar and accept
 * ws://localhost:8080.
 *
 * Addresses ImWeb understands (see src/io/OSCBridge.js):
 *   /imweb/<paramId>      <0..1>   set a parameter, NORMALISED (not raw units)
 *   /imweb/trigger/<id>            fire a TRIGGER parameter
 *   /imweb/preset/<n>              recall preset n
 *
 * A TOGGLE takes >0.5 as on. A button that sends no argument counts as 1 here,
 * which is what makes a bare Flic click work on a toggle.
 *
 * No dependencies beyond `ws`, which the project already has. The OSC parser
 * below is deliberately small: it reads the address and the args named in the
 * type tag, which is all ImWeb consumes.
 */

import dgram from 'node:dgram';
import { WebSocketServer } from 'ws';

const UDP_PORT = Number(process.argv[2] ?? 9000);
const WS_PORT  = Number(process.argv[3] ?? 8080);

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

// ── Relay ───────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Set();
wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[relay] ImWeb connected (${req.socket.remoteAddress}) — ${clients.size} client(s)`);
  ws.on('close', () => { clients.delete(ws); console.log(`[relay] client left — ${clients.size} left`); });
  ws.on('error', () => clients.delete(ws));
  // ImWeb also SENDS parameter changes out; log them so a round trip is visible.
  ws.on('message', (d) => { try { console.log('[relay] ← imweb', String(d).slice(0, 120)); } catch {} });
});

const udp = dgram.createSocket('udp4');
udp.on('message', (buf, rinfo) => {
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
  console.log('[relay] point Flic at this machine, UDP port ' + UDP_PORT);
  console.log('[relay] then in ImWeb click the OSC badge and accept ws://localhost:' + WS_PORT);
});
