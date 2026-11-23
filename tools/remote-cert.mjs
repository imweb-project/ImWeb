#!/usr/bin/env node
/**
 * A certificate for ImWeb Remote's secure address.
 *
 * Phones give their motion sensors (the Remote's Tilt button) only to an https
 * page, and only to one whose certificate they trust. This makes both halves:
 *
 *   ca.crt / ca.key        your own certificate authority — install ca.crt on
 *                          each phone/iPad ONCE; it is good for ten years
 *   server.crt / server.key  the relay's certificate, signed by it, naming this
 *                          Mac (its .local name and its current addresses)
 *
 * Run:   node tools/remote-cert.mjs          (then restart the relay)
 *
 * Run it again when the Mac's address changes and you open the Remote by
 * number rather than by its .local name: the authority is kept, only the
 * relay's certificate is remade, so the phones need nothing new.
 *
 * Everything lands in tools/.remote-cert/ (git-ignored — ca.key can sign for
 * any site as far as your phone is concerned; it never leaves this Mac).
 * Needs `openssl`, which every Mac has.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = process.env.IMWEB_REMOTE_CERT || fileURLToPath(new URL('./.remote-cert/', import.meta.url));
const f = (n) => path.join(DIR, n);
const ssl = (...args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });

/** This Mac's Bonjour name — the address that survives a change of network. */
function localName() {
  try { return `${execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim()}.local`; }
  catch { const h = os.hostname(); return h.includes('.') ? h : `${h}.local`; }
}
const ips = Object.values(os.networkInterfaces()).flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
const name = localName();

mkdirSync(DIR, { recursive: true });

if (!existsSync(f('ca.crt')) || !existsSync(f('ca.key'))) {
  writeFileSync(f('ca.cnf'), [
    '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no',
    '[dn]', `CN=ImWeb Remote (${name.replace(/\.local$/, '')})`, 'O=ImWeb',
    '[v3]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier=hash', '',
  ].join('\n'));
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
    '-keyout', f('ca.key'), '-out', f('ca.crt'), '-config', f('ca.cnf'));
  chmodSync(f('ca.key'), 0o600);
  console.log('[cert] made a new certificate authority — install it on each device (below)');
} else {
  console.log('[cert] keeping the certificate authority your devices already trust');
}

// The relay's own certificate. 800 days: iOS refuses a server certificate
// valid for more than 825, whoever signed it.
const san = [`DNS:${name}`, 'DNS:localhost', 'IP:127.0.0.1', ...ips.map((a) => `IP:${a}`)].join(',');
writeFileSync(f('server.cnf'), [
  '[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', `CN=${name}`, 'O=ImWeb',
  '[v3]', 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
  'extendedKeyUsage=serverAuth', `subjectAltName=${san}`, '',
].join('\n'));
ssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
  '-keyout', f('server.key'), '-out', f('server.csr'), '-config', f('server.cnf'));
ssl('x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial',
  '-out', f('server.crt'), '-days', '800', '-sha256', '-extfile', f('server.cnf'), '-extensions', 'v3');
chmodSync(f('server.key'), 0o600);

console.log(`[cert] relay certificate for: ${name}${ips.length ? `, ${ips.join(', ')}` : ''}`);
console.log(`[cert] written to ${DIR}`);
console.log('[cert] now restart the relay (node tools/osc-relay.mjs) — it prints the secure address');
console.log('[cert] and, the first time, how to make each device trust it.');
