/**
 * Seeds the CI stack for an authenticated security scan: an organization admin with a channel, fields, a command
 * type and a device, so ZAP's requests reach real handlers instead of 404s. Writes the admin's access token to
 * tests/stack/out/zap-token (never printed). CI only: run after tests/stack/up.sh.
 *
 *   NODE_EXTRA_CA_CERTS=tests/stack/out/ca.crt npx tsx tests/stack/seed.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { http, OUT, sql } from './lib';

async function main() {
  const email = 'zap-admin@arc.test';
  const reg = await http('POST', '/api/v1/auth/register', undefined, { email, displayName: 'ZAP', password: 'zap-scan-password-1', ageGroup: 'adult', acceptTerms: true });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  const t = reg.body.accessToken as string;
  const org = (await http('POST', '/api/v1/organizations', t, { name: 'ZAP Org', slug: 'zap-org' })).body;
  const proj = (await http('POST', '/api/v1/projects', t, { organizationId: org.id, name: 'ZAP channel', timezone: 'Asia/Kolkata' })).body;
  await http('PUT', `/api/v1/projects/${proj.id}/fields`, t, { metrics: [{ metricKey: 'temperature', label: 'T', minValue: -40, maxValue: 85 }, { metricKey: 'led1', label: 'LED', kind: 'control', minValue: 0, maxValue: 1 }] });
  await http('PUT', `/api/v1/projects/${proj.id}/command-types/blink`, t, { params: [{ key: 'seconds', type: 'number', min: 1, max: 10, required: true }], ttlSeconds: 120 });
  const dev = (await http('POST', '/api/v1/devices', t, { projectId: proj.id, displayName: 'ZAP board' })).body;
  assert.ok(dev.device?.id, JSON.stringify(dev));
  writeFileSync(resolve(OUT, 'zap-token'), t, { mode: 0o600 });
  console.log(`seeded: organization ${org.id}, channel ${proj.id}, device ${dev.device.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
