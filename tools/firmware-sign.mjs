#!/usr/bin/env node
/**
 * Firmware signing for ARC Cloud OTA releases.
 *
 *   node tools/firmware-sign.mjs keygen [dir] [--alg p256|ed25519]   → firmware-signing-private.pem (SECRET) + firmware-signing-public.pem
 *   node tools/firmware-sign.mjs sign <firmware.bin> --key firmware-signing-private.pem --device-type esp32 --version 1.2.0 --url https://…/fw.bin
 *   node tools/firmware-sign.mjs header [firmware-signing-public.pem]  → the OTA_PUBLIC_KEY_PEM block to paste into config.h
 *
 * Default algorithm: ECDSA P-256 / SHA-256 (DER signature). The ESP32 firmware verifies it on the device with
 * the mbedTLS in the Arduino core, so a compromised server, broker or network path cannot push an image you
 * did not sign. Ed25519 is still accepted by the server for older keys, but the reference firmware can't verify it.
 *
 * The signature covers the canonical manifest {deviceType, sha256, sizeBytes, url, version} (keys in that order).
 * Keep the private key offline (password manager / hardware token / CI secret), never in the repo.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = () => rest.find((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
const fail = (m) => {
  console.error(m);
  process.exit(1);
};

/** Must match canonicalManifest() in apps/api/src/firmware/firmware.controller.ts. */
export const canonicalManifest = (m) =>
  JSON.stringify({ deviceType: m.deviceType, sha256: m.sha256, sizeBytes: m.sizeBytes, url: m.url, version: m.version });

function algorithmOf(key) {
  if (key.asymmetricKeyType === 'ed25519') return 'ed25519';
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') return 'ecdsa-p256';
  fail(`Unsupported key type ${key.asymmetricKeyType}; use an ECDSA P-256 key (keygen).`);
}

if (cmd === 'keygen') {
  const dir = positional() ?? '.';
  const alg = (opt('alg') ?? 'p256').toLowerCase();
  if (!['p256', 'ed25519'].includes(alg)) fail('--alg must be p256 (default) or ed25519');
  const priv = join(dir, 'firmware-signing-private.pem');
  if (existsSync(priv)) fail(`${priv} already exists — not overwriting.`);
  const { publicKey, privateKey } = alg === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(dir, 'firmware-signing-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Wrote ${priv} (KEEP SECRET, never commit) and ${join(dir, 'firmware-signing-public.pem')} (${alg === 'p256' ? 'ECDSA P-256' : 'Ed25519'}).`);
  console.log('1. Add the PUBLIC key in ARC Cloud: Firmware → Signing keys → Add key.');
  console.log('2. Put it in the device firmware:  node tools/firmware-sign.mjs header firmware-signing-public.pem');
  if (alg === 'ed25519') console.log('WARNING: Ed25519 signatures are verified by the server only; the reference ESP32 firmware needs a P-256 key.');
} else if (cmd === 'sign') {
  const file = positional();
  if (!file || !existsSync(file)) fail('usage: sign <firmware.bin> --key private.pem --device-type T --version V --url https://…');
  const keyFile = opt('key') ?? 'firmware-signing-private.pem';
  const deviceType = opt('device-type');
  const version = opt('version');
  const url = opt('url');
  if (!deviceType || !version || !url) fail('--device-type, --version and --url are required');
  if (!url.startsWith('https://')) fail('--url must be https://');
  if (!/^\d+\.\d+\.\d+([-+][A-Za-z0-9.]+)?$/.test(version)) fail('--version must be MAJOR.MINOR.PATCH (devices refuse downgrades by comparing these numbers)');
  const bin = readFileSync(file);
  const manifest = { deviceType, sha256: createHash('sha256').update(bin).digest('hex'), sizeBytes: bin.length, url, version };
  const canonical = canonicalManifest(manifest);
  const key = createPrivateKey(readFileSync(keyFile));
  const alg = algorithmOf(key);
  const signature = (alg === 'ed25519' ? sign(null, Buffer.from(canonical), key) : sign('sha256', Buffer.from(canonical), { key, dsaEncoding: 'der' })).toString('base64');
  // Self-check before anything is published.
  const pub = createPublicKey(key);
  const ok = alg === 'ed25519' ? verify(null, Buffer.from(canonical), pub, Buffer.from(signature, 'base64')) : verify('sha256', Buffer.from(canonical), { key: pub, dsaEncoding: 'der' }, Buffer.from(signature, 'base64'));
  if (!ok) fail('internal error: signature did not verify');
  console.log(JSON.stringify({ ...manifest, signature, algorithm: alg }, null, 2));
} else if (cmd === 'header') {
  const file = positional() ?? 'firmware-signing-public.pem';
  if (!existsSync(file)) fail(`${file} not found`);
  const pub = createPublicKey(readFileSync(file));
  if (algorithmOf(pub) !== 'ecdsa-p256') fail('The firmware verifies ECDSA P-256 keys only. Generate one with: keygen --alg p256');
  const pem = pub.export({ type: 'spki', format: 'pem' }).toString().trim();
  console.log(`// OTA signing PUBLIC key (ECDSA P-256). Images not signed by the matching private key are refused.\nstatic const char OTA_PUBLIC_KEY_PEM[] = R"PEM(\n${pem}\n)PEM";`);
} else {
  fail('commands: keygen [dir] [--alg p256|ed25519] | sign <firmware.bin> --key private.pem --device-type T --version V --url https://… | header [public.pem]');
}
