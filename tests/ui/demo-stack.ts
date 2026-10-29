/**
 * Starts a local demo stack (real API + worker + in-process MQTT broker) on an empty database and
 * seeds realistic data: devices sending readings, a rule with an open alert, commands, webhooks,
 * keys, an ARC LMS link and a firmware rollout. Used to review and screenshot the console.
 *
 *   DATABASE_URL=postgres://… npx tsx tests/ui/demo-stack.ts      (then: ARC_API_ORIGIN=http://127.0.0.1:3100 npm run dev -w @arc/console)
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { API, BROKER_PORT, connectDevice, DB, http, pub, SECRETS, sleep, spawnSvc, startBroker, telemetry, waitFor } from '../e2e/harness';

async function main() {
  await startBroker();
  spawnSvc('api', 'apps/api/dist/main.js', {
    ...SECRETS, DATABASE_URL: DB!, PORT: '3100', INTERNAL_PORT: '3101', RUN_MIGRATIONS: 'true',
    MQTT_PUBLIC_HOST: '127.0.0.1', MQTT_PUBLIC_PORT: String(BROKER_PORT), MQTT_URL: `mqtt://127.0.0.1:${BROKER_PORT}`,
    HTTP_PUBLIC_URL: API, ALLOW_PRIVATE_WEBHOOKS: 'true', CONSOLE_URL: 'http://127.0.0.1:3002', CORS_ORIGINS: 'http://127.0.0.1:3002', PLATFORM_ADMIN_EMAILS: 'admin@arclabs.test',
  });
  await waitFor(async () => (await fetch(`${API}/health/ready`)).ok, 'API', 60000);
  spawnSvc('worker', 'apps/ingestion-worker/dist/main.js', {
    DATABASE_URL: DB!, MQTT_URL: `mqtt://127.0.0.1:${BROKER_PORT}`, MQTT_PROTOCOL_VERSION: '4', SHARED_SUBSCRIPTION: 'false',
    MQTT_SERVICE_PASSWORD: SECRETS.MQTT_SERVICE_PASSWORD, HEALTH_PORT: '19100', RULES_INTERVAL_SECONDS: '3', DELIVERIES_INTERVAL_SECONDS: '2',
    COMMANDS_INTERVAL_SECONDS: '2', ROLLOUTS_INTERVAL_SECONDS: '2', CONSOLE_URL: 'http://127.0.0.1:3002', ALLOW_PRIVATE_WEBHOOKS: 'true',
  });
  await waitFor(async () => (await fetch('http://127.0.0.1:19100/health/ready')).ok, 'worker', 60000);

  const a = await http('POST', '/api/v1/auth/register', undefined, { email: 'admin@arclabs.test', displayName: 'Sai (Admin)', password: 'demo-password-123', acceptTerms: true });
  const t = a.body.accessToken as string;
  const v = await http('POST', '/api/v1/auth/register', undefined, { email: 'viewer@arclabs.test', displayName: 'Vik (Viewer)', password: 'demo-password-123', acceptTerms: true });
  const org = (await http('POST', '/api/v1/organizations', t, { name: 'ARC LABS', slug: 'arc-labs' })).body;
  await http('POST', `/api/v1/organizations/${org.id}/members`, t, { email: 'viewer@arclabs.test', role: 'viewer' });
  const proj = (await http('POST', '/api/v1/projects', t, { organizationId: org.id, name: 'Greenhouse', description: 'Bay 1 climate monitoring', timezone: 'Asia/Kolkata' })).body;
  const proj2 = (await http('POST', '/api/v1/projects', t, { organizationId: org.id, name: 'Water tanks', timezone: 'Asia/Kolkata' })).body;
  await http('PUT', `/api/v1/projects/${proj.id}/metric-definitions`, t, {
    metrics: [
      { metricKey: 'temperatureC', label: 'Temperature', unit: '°C', minValue: -40, maxValue: 85 },
      { metricKey: 'humidityPct', label: 'Humidity', unit: '%', minValue: 0, maxValue: 100 },
    ],
  });
  const devs = [];
  for (const [name, type] of [['ESP32 Bay 1', 'esp32'], ['ESP32 Bay 2', 'esp32'], ['Pump controller', 'esp32']] as const) {
    devs.push((await http('POST', '/api/v1/devices', t, { projectId: proj.id, displayName: name, deviceType: type, expectedIntervalSeconds: 5 })).body);
  }
  await http('POST', '/api/v1/devices', t, { projectId: proj2.id, displayName: 'Tank sensor', deviceType: 'esp32', expectedIntervalSeconds: 10 });

  await http('PUT', `/api/v1/projects/${proj.id}/command-types/reboot`, t, { description: 'Restarts the device', ttlSeconds: 300 });
  await http('PUT', `/api/v1/projects/${proj.id}/command-types/set_interval`, t, { description: 'Change how often readings are sent', params: [{ key: 'seconds', type: 'number', min: 5, max: 3600, required: true }], ttlSeconds: 3600 });
  await http('POST', '/api/v1/rules', t, { projectId: proj.id, name: 'Greenhouse too hot', ruleType: 'threshold', metricKey: 'temperatureC', operator: '>', threshold: 31, forSeconds: 0, severity: 'critical', cooldownSeconds: 300, notifyEmails: ['ops@arclabs.test'] });
  await http('POST', '/api/v1/rules', t, { projectId: proj.id, name: 'No data from a bay', ruleType: 'stale', staleSeconds: 600, severity: 'warning' });
  await http('POST', '/api/v1/rules', t, { projectId: proj.id, deviceId: devs[2].device.id, name: 'Pump offline', ruleType: 'offline', severity: 'warning' });
  await http('POST', '/api/v1/webhooks', t, { organizationId: org.id, name: 'Ops channel', url: 'http://127.0.0.1:9/hook', events: ['alert.triggered', 'alert.resolved'] });
  await http('POST', '/api/v1/api-keys', t, { organizationId: org.id, name: 'Reporting script', role: 'viewer', projectIds: [proj.id], expiresInDays: 365 });
  await http('POST', '/api/v1/api-keys', t, { organizationId: org.id, name: 'ARC LMS server', kind: 'service_account', role: 'viewer' });
  const link = (await http('POST', '/api/v1/lms/links', t, { projectId: proj.id, lmsRef: 'iot101/lab-3', title: 'IoT 101 · Lab 3: Temperature logging', maxTokenMinutes: 240 })).body;

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = (await http('POST', '/api/v1/firmware/signing-keys', t, { organizationId: org.id, name: 'Release key 2026', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) })).body;
  const bin = Buffer.alloc(812_000, 7);
  const m = { deviceType: 'esp32', version: '1.3.0', url: 'https://example.com/fw/arc-esp32-1.3.0.bin', sha256: createHash('sha256').update(bin).digest('hex'), sizeBytes: bin.length };
  const signature = sign(null, Buffer.from(JSON.stringify({ deviceType: m.deviceType, sha256: m.sha256, sizeBytes: m.sizeBytes, url: m.url, version: m.version })), privateKey).toString('base64');
  const rel = (await http('POST', '/api/v1/firmware/releases', t, { organizationId: org.id, ...m, signature, signingKeyId: key.id, notes: 'Faster Wi-Fi reconnect, DHT22 fix' })).body;

  // Devices: connect, send readings, auto-acknowledge commands (OTA reports success).
  const clients = [];
  const fw = new Map<string, string>();
  for (const [i, d] of devs.entries()) {
    if (i === 2) continue; // pump stays offline → offline/stale alerts
    const c = await connectDevice(d.credentials);
    const ackTopic = d.credentials.topics.telemetry.replace(/telemetry$/, 'cmd-ack');
    c.subscribe(d.credentials.topics.commands);
    c.on('message', (_topic, buf) => {
      const cmd = JSON.parse(buf.toString());
      if (cmd.commandId) setTimeout(() => void pub(c, ackTopic, { commandId: cmd.commandId, status: 'ok', result: cmd.name === 'ota.update' ? { installed: cmd.payload?.version } : { done: true } }), 1500);
      if (cmd.name === 'ota.update')
        setTimeout(() => {
          fw.set(d.device.id, cmd.payload.version);
          void pub(c, d.credentials.topics.state, { schemaVersion: 1, state: { firmwareVersion: cmd.payload.version } });
        }, 2500);
    });
    clients.push({ c, d, i });
  }
  let n = 0;
  setInterval(() => {
    n++;
    for (const { c, d, i } of clients) {
      const temp = 26 + i * 2 + Math.sin(n / 6) * 2.5 + (i === 1 && n > 4 ? 4 : 0);
      const msg = telemetry({ temperatureC: +temp.toFixed(2), humidityPct: +(58 + Math.cos(n / 5) * 6).toFixed(1) });
      void pub(c, d.credentials.topics.telemetry, { ...msg, metadata: { firmwareVersion: fw.get(d.device.id) ?? '1.0.0' } });
    }
  }, 2000);
  await sleep(12000);
  await http('POST', `/api/v1/devices/${devs[0].device.id}/commands`, t, { name: 'set_interval', payload: { seconds: 30 } });
  await http('POST', '/api/v1/firmware/rollouts', t, { releaseId: rel.id, projectId: proj.id, percent: 50 });

  const lt = (await http('POST', `/api/v1/lms/links/${link.id}/learner-tokens`, t, { learnerRef: 'student-42', minutes: 60 })).body;
  writeFileSync('/tmp/arc-demo.json', JSON.stringify({ token: t, viewerToken: v.body.accessToken, orgId: org.id, projectId: proj.id, deviceId: devs[0].device.id, labToken: lt.accessToken }, null, 1));
  console.log('DEMO READY');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
