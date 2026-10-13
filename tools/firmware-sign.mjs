#!/usr/bin/env node
/**
 * Firmware signing for ARC Cloud OTA releases (Ed25519).
 *
 *   node tools/firmware-sign.mjs keygen  [dir]                    → private.pem (keep secret!) + public.pem
 *   node tools/firmware-sign.mjs sign <firmware.bin> --key private.pem --device-type esp32 --version 1.2.0 --url https://…/fw.bin
 *
 * `sign` prints the JSON to paste into ARC Cloud (Firmware → New release) or POST to /api/v1/firmware/releases.
 * The signature covers the canonical manifest {deviceType, sha256, sizeBytes, url, version}; ARC Cloud refuses
 * releases whose signature doesn't verify against a registered public key, and devices check the sha256.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (m) => {
  console.error(m);
  process.exit(1);
};

if (cmd === 'keygen') {
  const dir = rest[0] && !rest[0].startsWith('--') ? rest[0] : '.';
  const priv = join(dir, 'firmware-signing-private.pem');
  if (existsSync(priv)) fail(`${priv} already exists — not overwriting.`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(dir, 'firmware-signing-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Wrote ${priv} (KEEP SECRET, never commit) and ${join(dir, 'firmware-signing-public.pem')}.`);
  console.log('Add the PUBLIC key in ARC Cloud: Firmware → Signing keys → Add key.');
} else if (cmd === 'sign') {
  const file = rest[0];
  if (!file || !existsSync(file)) fail('usage: sign <firmware.bin> --key private.pem --device-type T --version V --url https://…');
  const keyFile = opt('key') ?? 'firmware-signing-private.pem';
  const deviceType = opt('device-type');
  const version = opt('version');
  const url = opt('url');
  if (!deviceType || !version || !url) fail('--device-type, --version and --url are required');
  if (!url.startsWith('https://')) fail('--url must be https://');
  const bin = readFileSync(file);
  const manifest = { deviceType, sha256: createHash('sha256').update(bin).digest('hex'), sizeBytes: bin.length, url, version };
  const canonical = JSON.stringify(manifest);
  const signature = sign(null, Buffer.from(canonical), createPrivateKey(readFileSync(keyFile))).toString('base64');
  console.log(JSON.stringify({ ...manifest, signature }, null, 2));
} else {
  fail('commands: keygen [dir] | sign <firmware.bin> --key private.pem --device-type T --version V --url https://…');
}
