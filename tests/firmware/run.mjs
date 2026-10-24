#!/usr/bin/env node
/**
 * Cross-checks the device-side OTA verification (C, mbedTLS) against the signing tool and the API (Node).
 * A mismatch here (DER vs raw signatures, hashing, manifest bytes) would make every real device refuse
 * every update, so this runs in CI.
 *
 *   node tests/firmware/run.mjs        (needs g++ and mbedTLS headers/libs: apt-get install libmbedtls-dev)
 *
 * Optional: MBEDTLS_DIR=/path/to/mbedtls (with include/ and library/) to build against a source tree.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const SKETCHES = ['arc_device', 'arc_http'];
const tmp = mkdtempSync(join(tmpdir(), 'arc-ota-'));
const bin = join(tmp, 'ota_verify_host');
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
};

// 1. Every sketch carries identical copies of the shared OTA headers.
for (const f of ['arc_ota.h', 'arc_ota_verify.h']) {
  const copies = SKETCHES.map((s) => readFileSync(join(ROOT, 'firmware/esp32-arduino', s, f), 'utf8'));
  check(`${f} identical in ${SKETCHES.join(', ')}`, () => copies.forEach((c) => assert.equal(c, copies[0])));
}

// 2. Build the host binary from the firmware header.
const mb = process.env.MBEDTLS_DIR;
const args = [
  '-std=c++17', '-O1', '-Wall', '-Werror',
  `-I${join(ROOT, 'firmware/esp32-arduino/arc_device')}`,
  ...(mb ? [`-I${join(mb, 'include')}`] : []),
  join(ROOT, 'tests/firmware/ota_verify_host.cpp'),
  '-o', bin,
  ...(mb ? [`-L${join(mb, 'library')}`] : []),
  '-lmbedcrypto',
];
execFileSync('g++', args, { stdio: 'inherit' });

const run = (...a) => spawnSync(bin, a, { encoding: 'utf8' });
const write = (name, data) => {
  const p = join(tmp, name);
  writeFileSync(p, data);
  return p;
};

// 3. Keys from the real signing tool.
execFileSync(process.execPath, [join(ROOT, 'tools/firmware-sign.mjs'), 'keygen', tmp], { stdio: 'ignore' });
const pubPem = join(tmp, 'firmware-signing-public.pem');
const privPem = join(tmp, 'firmware-signing-private.pem');
const fw = write('fw.bin', Buffer.alloc(4096, 7));
const out = JSON.parse(
  execFileSync(process.execPath, [join(ROOT, 'tools/firmware-sign.mjs'), 'sign', fw, '--key', privPem, '--device-type', 'esp32', '--version', '1.2.3', '--url', 'https://fw.example.com/a/b-1.2.3.bin'], { encoding: 'utf8' }),
);
// The exact string the API puts in the OTA command (canonicalManifest in firmware.controller.ts).
const canonical = JSON.stringify({ deviceType: out.deviceType, sha256: out.sha256, sizeBytes: out.sizeBytes, url: out.url, version: out.version });
const manifest = write('manifest.json', canonical);
const sig = write('sig.b64', out.signature);

check('signing tool emits ECDSA P-256 by default', () => assert.equal(out.algorithm, 'ecdsa-p256'));
check('firmware accepts a manifest signed by firmware-sign.mjs', () => {
  const r = run('verify', pubPem, manifest, sig);
  assert.equal(r.stdout.trim(), 'OK', r.stdout + r.stderr);
});
check('firmware rejects a tampered manifest (url changed)', () => {
  const r = run('verify', pubPem, write('m2.json', canonical.replace('fw.example.com', 'evil.example.com')), sig);
  assert.match(r.stdout, /signature check failed/);
});
check('firmware rejects a tampered manifest (version bumped)', () => {
  const r = run('verify', pubPem, write('m3.json', canonical.replace('1.2.3', '9.9.9')), sig);
  assert.match(r.stdout, /signature check failed/);
});
check('firmware rejects a signature from a different key', () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const s2 = sign('sha256', Buffer.from(canonical), { key: other.privateKey, dsaEncoding: 'der' }).toString('base64');
  const r = run('verify', pubPem, manifest, write('s2.b64', s2));
  assert.match(r.stdout, /signature check failed/);
});
check('firmware rejects an Ed25519 public key', () => {
  const ed = generateKeyPairSync('ed25519');
  const r = run('verify', write('ed.pem', ed.publicKey.export({ type: 'spki', format: 'pem' })), manifest, sig);
  assert.match(r.stdout, /not a valid PEM key|must be ECDSA P-256/);
});
check('firmware rejects a non-P-256 EC key (P-384)', () => {
  const k = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const r = run('verify', write('p384.pem', k.publicKey.export({ type: 'spki', format: 'pem' })), manifest, sig);
  assert.match(r.stdout, /must be ECDSA P-256|signature check failed/);
});
check('firmware rejects garbage signature encoding', () => {
  const r = run('verify', pubPem, manifest, write('bad.b64', '!!!not-base64!!!'));
  assert.match(r.stdout, /bad signature encoding/);
});
check('manifest sha256 matches the image', () => assert.equal(out.sha256, createHash('sha256').update(readFileSync(fw)).digest('hex')));
check('raw (r||s) signatures are rejected: firmware expects DER, as the API stores', () => {
  const raw = sign('sha256', Buffer.from(canonical), { key: createPrivateKey(readFileSync(privPem)), dsaEncoding: 'ieee-p1363' }).toString('base64');
  const r = run('verify', pubPem, manifest, write('raw.b64', raw));
  assert.notEqual(r.stdout.trim(), 'OK');
});
check('version comparison table', () => {
  const r = run('versions');
  assert.equal(r.status, 0, r.stdout);
});

console.log(failures ? `\n${failures} firmware check(s) failed` : '\nall firmware checks passed');
process.exit(failures ? 1 : 0);
