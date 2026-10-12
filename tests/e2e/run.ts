/**
 * End-to-end check of the V1 data path without Docker:
 *   API (real) + ingestion worker (real) + Postgres (DATABASE_URL, empty DB)
 *   + an in-process Aedes broker that calls the SAME /internal/mqtt hooks EMQX uses
 *     and emits EMQX-shaped $SYS client events.
 *
 *   DATABASE_URL=postgres://... npm run test:e2e
 */
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:net';
import { resolve } from 'node:path';
import { Aedes } from 'aedes';
import mqtt, { MqttClient } from 'mqtt';

const ROOT = resolve(__dirname, '../..');
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL (an empty database) is required');

const API = 'http://127.0.0.1:3100';
const HOOKS = 'http://127.0.0.1:3101';
const BROKER_PORT = 18830;
const SECRETS = {
  JWT_SECRET: 'e2e-jwt-secret-0123456789abcdef0123456789',
  INTERNAL_HOOK_TOKEN: 'e2e-internal-hook-token-0123456789',
  MQTT_SERVICE_PASSWORD: 'e2e-service-password-0123456789',
};

const results: { name: string; ok: boolean; err?: string }[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function hook(path: string, body: unknown) {
  const res = await fetch(HOOKS + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': SECRETS.INTERNAL_HOOK_TOKEN },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { result: string };
}

function spawnSvc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const p = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d: Buffer) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`);
  p.stdout!.on('data', out);
  p.stderr!.on('data', (d) => process.stdout.write(`[${name}:err] ${d}`));
  return p;
}

async function waitFor(fn: () => Promise<boolean>, what: string, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function startBroker(): Promise<{ server: Server; broker: Aedes }> {
  const broker = await Aedes.createBroker({ id: 'e2e' });
  broker.authenticate = (client, username, password, cb) => {
    (client as any)._arcUser = username; // EMQX passes ${username} to the authz hook; mirror that
    hook('/internal/mqtt/authenticate', { username, password: password?.toString() ?? '', clientid: client.id })
      .then((r) => {
        if (r.result === 'allow') return cb(null, true);
        const e: any = new Error('denied');
        e.returnCode = 5;
        cb(e, false);
      })
      .catch((err) => cb(err, false));
  };
  const authz = (client: any, action: string, topic: string, cb: (e: Error | null) => void) =>
    hook('/internal/mqtt/authorize', { username: client?.id ? (client as any)._arcUser ?? client.id : '', clientid: client?.id, topic, action })
      .then((r) => cb(r.result === 'allow' ? null : new Error('not authorized')))
      .catch((e) => cb(e));
  broker.authorizePublish = (client, packet, cb) => authz(client, 'publish', packet.topic, cb);
  broker.authorizeSubscribe = (client, sub, cb) =>
    authz(client, 'subscribe', sub.topic, (e) => (e ? cb(e, null) : cb(null, sub)));
  // Emulate EMQX system client events.
  broker.on('client', (c) => {
    if ((c as any).id?.startsWith('svc-')) return;
    broker.publish({ topic: `$SYS/brokers/e2e/clients/${c.id}/connected`, payload: Buffer.from(JSON.stringify({ clientid: c.id, username: c.id, connected_at: Date.now(), ipaddress: '127.0.0.1' })), qos: 0, retain: false, cmd: 'publish', dup: false }, () => undefined);
  });
  broker.on('clientDisconnect', (c) => {
    if ((c as any).id?.startsWith('svc-')) return;
    broker.publish({ topic: `$SYS/brokers/e2e/clients/${c.id}/disconnected`, payload: Buffer.from(JSON.stringify({ clientid: c.id, username: c.id, disconnected_at: Date.now(), reason: 'normal' })), qos: 0, retain: false, cmd: 'publish', dup: false }, () => undefined);
  });
  const server = createServer(broker.handle);
  await new Promise<void>((r) => server.listen(BROKER_PORT, r));
  return { server, broker };
}

function connectDevice(creds: { clientId: string; username: string; password: string }): Promise<MqttClient> {
  return new Promise((resolveP, reject) => {
    const c = mqtt.connect(`mqtt://127.0.0.1:${BROKER_PORT}`, {
      protocolVersion: 4,
      clientId: creds.clientId,
      username: creds.username,
      password: creds.password,
      reconnectPeriod: 0,
      connectTimeout: 5000,
    });
    c.once('connect', () => resolveP(c));
    c.once('error', (e) => {
      c.end(true);
      reject(e);
    });
  });
}

const pub = (c: MqttClient, topic: string, payload: unknown) =>
  new Promise<void>((r, j) => c.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { qos: 1 }, (e) => (e ? j(e) : r())));

const telemetry = (metrics: Record<string, unknown>, messageId = randomUUID()) => ({
  schemaVersion: 1,
  messageId,
  timestamp: new Date().toISOString(),
  metrics,
  metadata: { firmwareVersion: '1.0.0' },
});

async function main() {
  const procs: ChildProcess[] = [];
  const { server, broker } = await startBroker();
  try {
    const env = {
      ...SECRETS,
      DATABASE_URL: DB!,
      PORT: '3100',
      INTERNAL_PORT: '3101',
      RUN_MIGRATIONS: 'true',
      MQTT_PUBLIC_HOST: '127.0.0.1',
      MQTT_PUBLIC_PORT: String(BROKER_PORT),
      MQTT_URL: `mqtt://127.0.0.1:${BROKER_PORT}`,
      HTTP_PUBLIC_URL: API.replace('/api/v1', ''),
      NODE_ENV: 'test',
    };
    procs.push(spawnSvc('api', 'apps/api/dist/main.js', env));
    await waitFor(async () => (await fetch(`${API}/health/ready`)).ok, 'API');
    procs.push(
      spawnSvc('worker', 'apps/ingestion-worker/dist/main.js', {
        DATABASE_URL: DB!,
        MQTT_URL: `mqtt://127.0.0.1:${BROKER_PORT}`,
        MQTT_PROTOCOL_VERSION: '4',
        SHARED_SUBSCRIPTION: 'false',
        MQTT_SERVICE_PASSWORD: SECRETS.MQTT_SERVICE_PASSWORD,
        HEALTH_PORT: '19100',
        CACHE_TTL_SECONDS: '1',
      }),
    );
    await waitFor(async () => (await fetch('http://127.0.0.1:19100/health/ready')).ok, 'worker');
    await sleep(500);

    console.log('\nIdentity & tenancy');
    const a = await http('POST', '/api/v1/auth/register', undefined, { email: 'alice@arclabs.test', displayName: 'Alice', password: 'correct-horse-battery' });
    const b = await http('POST', '/api/v1/auth/register', undefined, { email: 'bob@other.test', displayName: 'Bob', password: 'correct-horse-staple' });
    const tA = a.body.accessToken as string;
    const tB = b.body.accessToken as string;
    await check('users register and receive tokens', () => {
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
    });
    await check('weak password and duplicate email rejected', async () => {
      assert.equal((await http('POST', '/api/v1/auth/register', undefined, { email: 'x@y.test', displayName: 'X', password: 'short' })).status, 400);
      assert.equal((await http('POST', '/api/v1/auth/register', undefined, { email: 'ALICE@arclabs.test', displayName: 'A', password: 'correct-horse-battery' })).status, 409);
    });
    await check('login works; wrong password gets 401', async () => {
      assert.equal((await http('POST', '/api/v1/auth/login', undefined, { email: 'alice@arclabs.test', password: 'correct-horse-battery' })).status, 200);
      assert.equal((await http('POST', '/api/v1/auth/login', undefined, { email: 'alice@arclabs.test', password: 'nope-nope-nope' })).status, 401);
    });
    await check('unauthenticated requests get 401', async () => {
      assert.equal((await http('GET', '/api/v1/organizations')).status, 401);
    });

    const orgA = (await http('POST', '/api/v1/organizations', tA, { name: 'ARC Labs', slug: 'arc-labs' })).body;
    const orgB = (await http('POST', '/api/v1/organizations', tB, { name: 'Other Co', slug: 'other-co' })).body;
    const proj = (await http('POST', '/api/v1/projects', tA, { organizationId: orgA.id, name: 'Greenhouse', timezone: 'Asia/Kolkata' })).body;
    await check('org + project created', () => {
      assert.ok(orgA.id && orgB.id && proj.id);
    });
    await check('metric definitions set', async () => {
      const r = await http('PUT', `/api/v1/projects/${proj.id}/metric-definitions`, tA, {
        metrics: [
          { metricKey: 'temperatureC', label: 'Temperature', unit: '°C', minValue: -40, maxValue: 85 },
          { metricKey: 'humidityPct', label: 'Humidity', unit: '%', minValue: 0, maxValue: 100 },
        ],
      });
      assert.equal(r.status, 200);
    });

    console.log('\nProvisioning');
    const created = await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'ESP32 Greenhouse 1', deviceType: 'esp32', tags: ['greenhouse'], expectedIntervalSeconds: 10 });
    const dev = created.body.device;
    const creds = created.body.credentials;
    await check('device registered with unique credential returned once', async () => {
      assert.equal(created.status, 201);
      assert.equal(creds.username, dev.id);
      assert.equal(creds.topics.telemetry, `arc/v1/${orgA.id}/${proj.id}/${dev.id}/telemetry`);
      assert.ok(creds.password.length >= 40);
      const again = await http('GET', `/api/v1/devices/${dev.id}`, tA);
      assert.equal(JSON.stringify(again.body).includes(creds.password), false);
      assert.equal(again.body.connectivity.status, 'unknown');
    });
    await check('credential stored as scrypt hash, not plaintext', async () => {
      const { Client } = await import('pg');
      const c = new Client({ connectionString: DB });
      await c.connect();
      const row = (await c.query('SELECT secret_hash FROM device_credentials WHERE device_id = $1', [dev.id])).rows[0];
      await c.end();
      assert.ok(row.secret_hash.startsWith('scrypt$'));
      assert.ok(!row.secret_hash.includes(creds.password));
    });

    console.log('\nMQTT auth & ACL (via broker hooks)');
    await check('wrong password rejected', async () => {
      await assert.rejects(connectDevice({ ...creds, password: 'wrong' }));
    });
    await check('clientid must equal username', async () => {
      await assert.rejects(connectDevice({ ...creds, clientId: randomUUID() }));
    });
    await check('hooks require the internal token', async () => {
      const r = await fetch(`${HOOKS}/internal/mqtt/authenticate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 401);
    });
    await check('ACL: own telemetry allowed; other device / other tenant / cmd / subscribe denied', async () => {
      const t = (topic: string, action = 'publish') => hook('/internal/mqtt/authorize', { username: dev.id, clientid: dev.id, topic, action });
      assert.equal((await t(creds.topics.telemetry)).result, 'allow');
      assert.equal((await t(creds.topics.state)).result, 'allow');
      assert.equal((await t(`arc/v1/${orgA.id}/${proj.id}/${randomUUID()}/telemetry`)).result, 'deny');
      assert.equal((await t(`arc/v1/${orgB.id}/${proj.id}/${dev.id}/telemetry`)).result, 'deny');
      assert.equal((await t(`arc/v1/${orgA.id}/${proj.id}/${dev.id}/cmd-ack`)).result, 'deny');
      assert.equal((await t('#', 'subscribe')).result, 'deny');
    });

    console.log('\nIngestion');
    const device = await connectDevice(creds);
    const dupId = randomUUID();
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 29.4, humidityPct: 61 }, dupId));
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 29.6, humidityPct: 60.5 }, dupId)); // duplicate
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 29.8, humidityPct: 60 }));
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 30.1, humidityPct: 59.5 }));
    await pub(device, creds.topics.telemetry, '{not-json');
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 'hot' }));
    await pub(device, creds.topics.telemetry, telemetry({ pressureHpa: 1012 })); // not defined for project
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 140 })); // out of range
    await pub(device, creds.topics.state, { schemaVersion: 1, state: { firmwareVersion: '1.0.0', uptimeS: 42 } });
    await sleep(1500);

    await check('valid messages persisted once (duplicate messageId ignored)', async () => {
      const r = await http('GET', `/api/v1/devices/${dev.id}/telemetry?metric=temperatureC,humidityPct`, tA);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.series.temperatureC.map((p: any) => p.value), [29.4, 29.8, 30.1]);
      assert.equal(r.body.series.humidityPct.length, 3);
    });
    await check('latest values endpoint', async () => {
      const r = await http('GET', `/api/v1/devices/${dev.id}/telemetry/latest`, tA);
      const temp = r.body.items.find((i: any) => i.metric === 'temperatureC');
      assert.equal(temp.value, 30.1);
    });
    await check('aggregated history (1m buckets)', async () => {
      const r = await http('GET', `/api/v1/devices/${dev.id}/telemetry?metric=temperatureC&bucket=1m&agg=max`, tA);
      assert.equal(r.status, 200);
      assert.ok(r.body.series.temperatureC.length >= 1);
      assert.equal(Math.max(...r.body.series.temperatureC.map((p: any) => p.value)), 30.1);
    });
    await check('invalid payloads rejected and logged with reasons', async () => {
      const r = await http('GET', `/api/v1/organizations/${orgA.id}/rejected-messages`, tA);
      const reasons = r.body.items.map((i: any) => i.reason).sort();
      assert.deepEqual(reasons, ['invalid_json', 'metric_not_allowed', 'schema_invalid', 'value_out_of_range']);
    });
    await check('device is online, active, with state + firmware + events', async () => {
      const s = await http('GET', `/api/v1/devices/${dev.id}/state`, tA);
      assert.equal(s.body.connectivity.status, 'online');
      assert.equal(s.body.reportedState.uptimeS, 42);
      assert.equal(s.body.firmwareVersion, '1.0.0');
      const d = await http('GET', `/api/v1/devices/${dev.id}`, tA);
      assert.equal(d.body.lifecycleStatus, 'active');
      const ev = await http('GET', `/api/v1/devices/${dev.id}/events`, tA);
      const types = ev.body.items.map((e: any) => e.type);
      for (const t of ['provisioned', 'first_message', 'connected']) assert.ok(types.includes(t), `missing event ${t}: ${types}`);
    });
    await check('publishing to another device topic is blocked by the broker', async () => {
      const otherTopic = `arc/v1/${orgA.id}/${proj.id}/${randomUUID()}/telemetry`;
      const closed = new Promise<void>((r) => device.once('close', () => r()));
      device.publish(otherTopic, JSON.stringify(telemetry({ temperatureC: 1 })), { qos: 0 });
      await Promise.race([closed, sleep(3000).then(() => { throw new Error('connection not closed'); })]);
    });
    await sleep(800);
    await check('broker disconnect marks device offline', async () => {
      const s = await http('GET', `/api/v1/devices/${dev.id}/state`, tA);
      assert.equal(s.body.connectivity.status, 'offline');
      assert.equal(s.body.connectivity.source, 'broker_event');
    });

    console.log('\nTenant isolation & RBAC');
    await check('other tenant cannot see device, telemetry, project or org (404)', async () => {
      for (const p of [`/api/v1/devices/${dev.id}`, `/api/v1/devices/${dev.id}/telemetry?metric=temperatureC`, `/api/v1/devices/${dev.id}/telemetry/latest`, `/api/v1/projects/${proj.id}`, `/api/v1/organizations/${orgA.id}`, `/api/v1/devices?projectId=${proj.id}`, `/api/v1/organizations/${orgA.id}/rejected-messages`]) {
        assert.equal((await http('GET', p, tB)).status, 404, p);
      }
    });
    await check('other tenant cannot create devices in, or rotate devices of, another org', async () => {
      assert.equal((await http('POST', '/api/v1/devices', tB, { projectId: proj.id, displayName: 'evil' })).status, 404);
      assert.equal((await http('POST', `/api/v1/devices/${dev.id}/rotate-credentials`, tB)).status, 404);
      assert.equal((await http('POST', `/api/v1/devices/${dev.id}/revoke`, tB, {})).status, 404);
    });
    await check('viewer can read but not provision or revoke (403)', async () => {
      assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/members`, tA, { email: 'bob@other.test', role: 'viewer' })).status, 201);
      assert.equal((await http('GET', `/api/v1/devices/${dev.id}`, tB)).status, 200);
      assert.equal((await http('POST', '/api/v1/devices', tB, { projectId: proj.id, displayName: 'nope' })).status, 403);
      assert.equal((await http('POST', `/api/v1/devices/${dev.id}/revoke`, tB, {})).status, 403);
    });
    await check('cannot remove the last org admin', async () => {
      const me = (await http('GET', '/api/v1/auth/me', tA)).body.user;
      assert.equal((await http('DELETE', `/api/v1/organizations/${orgA.id}/members/${me.id}`, tA)).status, 409);
    });

    console.log('\nCredential lifecycle');
    await check('rotation: old password stops working, new one works', async () => {
      const r = await http('POST', `/api/v1/devices/${dev.id}/rotate-credentials`, tA);
      assert.equal(r.status, 200);
      await assert.rejects(connectDevice(creds));
      const c = await connectDevice(r.body.credentials);
      await pub(c, creds.topics.telemetry, telemetry({ temperatureC: 31 }));
      c.end();
      creds.password = r.body.credentials.password;
    });
    await check('revocation blocks connection and ACL', async () => {
      assert.equal((await http('POST', `/api/v1/devices/${dev.id}/revoke`, tA, { reason: 'e2e' })).status, 200);
      await assert.rejects(connectDevice(creds));
      assert.equal((await hook('/internal/mqtt/authorize', { username: dev.id, topic: creds.topics.telemetry, action: 'publish' })).result, 'deny');
    });
    await check('audit log records provisioning, rotation and revocation', async () => {
      const r = await http('GET', `/api/v1/organizations/${orgA.id}/audit-logs`, tA);
      const actions = r.body.items.map((i: any) => i.action);
      for (const a of ['device.create', 'device.credentials.rotate', 'device.revoke', 'member.upsert']) assert.ok(actions.includes(a), a);
    });
    console.log('\nChannels: fields, HTTP API, controls, feeds, dashboards');
    const httpUrl = (q: string) => `${API}/api/v1/update?${q}`;
    await check('fields get numbers and control kinds', async () => {
      const r = await http('PUT', `/api/v1/projects/${proj.id}/fields`, tA, {
        metrics: [
          { metricKey: 'temperatureC', label: 'Temperature', unit: '°C', minValue: -40, maxValue: 85 },
          { metricKey: 'humidityPct', label: 'Humidity', unit: '%', minValue: 0, maxValue: 100 },
          { metricKey: 'relay', label: 'Relay', kind: 'control', minValue: 0, maxValue: 1, step: 1, decimals: 0 },
          { metricKey: 'brightness', label: 'Brightness', kind: 'control', minValue: 0, maxValue: 100, position: 6 },
        ],
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.items.map((f: any) => [f.metricKey, f.position, f.kind]), [
        ['temperatureC', 1, 'data'], ['humidityPct', 2, 'data'], ['relay', 3, 'control'], ['brightness', 6, 'control'],
      ]);
    });
    const dev2 = (await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'HTTP board', expectedIntervalSeconds: 15 })).body;
    const key2 = dev2.credentials.http.apiKey as string;
    await check('HTTP update maps field1/field2 to channel fields', async () => {
      const r = await fetch(httpUrl(`api_key=${encodeURIComponent(key2)}&field1=24.5&field2=55`));
      const body = await r.json();
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.deepEqual(body.values, { temperatureC: 24.5, humidityPct: 55 });
      const latest = await http('GET', `/api/v1/devices/${dev2.device.id}/telemetry/latest`, tA);
      assert.equal(latest.body.items.find((i: any) => i.metric === 'temperatureC').value, 24.5);
      const d = await http('GET', `/api/v1/devices/${dev2.device.id}`, tA);
      assert.equal(d.body.lifecycleStatus, 'active');
      assert.equal(d.body.connectivity.status, 'online');
    });
    await check('HTTP update: POST JSON, rejects bad key, non-numbers, unknown fields, out of range', async () => {
      await sleep(1100);
      const post = await fetch(`${API}/api/v1/update`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key2 }, body: JSON.stringify({ humidityPct: 57 }) });
      assert.equal(post.status, 200);
      assert.equal((await fetch(httpUrl('api_key=not-a-real-key-123456&field1=1'))).status, 401);
      await sleep(1100);
      assert.equal((await fetch(httpUrl(`api_key=${key2}&field1=hot`))).status, 400);
      await sleep(1100);
      assert.equal((await fetch(httpUrl(`api_key=${key2}&pressureHpa=1000`))).status, 400);
      await sleep(1100);
      assert.equal((await fetch(httpUrl(`api_key=${key2}&field1=500`))).status, 400);
    });
    await check('HTTP update is rate limited per device', async () => {
      await sleep(5200);
      const codes = [];
      for (let i = 0; i < 8; i++) codes.push((await fetch(httpUrl(`api_key=${key2}&field2=${50 + i}`))).status);
      assert.ok(codes.includes(429), String(codes));
    });

    const c2 = dev2.credentials;
    const cmdTopic = c2.topics.commands as string;
    const board = await connectDevice(c2);
    const received: any[] = [];
    board.on('message', (t, p) => t === cmdTopic && received.push(JSON.parse(p.toString())));
    await check('device can subscribe to its own control topic only', async () => {
      const ok = await new Promise<any>((r) => board.subscribe(cmdTopic, { qos: 1 }, (e, g) => r(e ?? g)));
      assert.ok(Array.isArray(ok) && ok[0].qos !== 128, JSON.stringify(ok));
      assert.equal((await hook('/internal/mqtt/authorize', { username: dev2.device.id, topic: cmdTopic.replace(dev2.device.id, randomUUID()), action: 'subscribe' })).result, 'deny');
    });
    await check('setting a control pushes it to the device over MQTT (and clamps to max)', async () => {
      const r1 = await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, tA, { field: 'relay', value: 1 });
      const r2 = await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, tA, { field: 'brightness', value: 150 });
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.equal(r1.body.pushedOverMqtt, true);
      assert.equal(r2.body.value, 100);
      await sleep(600);
      assert.deepEqual(received.map((m) => [m.field, m.value]), [['relay', 1], ['brightness', 100]]);
    });
    await check('controls: data fields and viewers are refused', async () => {
      assert.equal((await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, tA, { field: 'temperatureC', value: 1 })).status, 400);
      assert.equal((await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, tB, { field: 'relay', value: 0 })).status, 403);
    });
    await check('HTTP devices poll control values (JSON and plain text by field number)', async () => {
      const j = await (await fetch(`${API}/api/v1/controls?api_key=${key2}`)).json();
      assert.deepEqual(j, { relay: 1, brightness: 100 });
      assert.equal(await (await fetch(`${API}/api/v1/controls?api_key=${key2}&field=field3`)).text(), '1');
      assert.equal(await (await fetch(`${API}/api/v1/controls?api_key=${key2}&field=brightness`)).text(), '100');
    });
    await check('control values are re-sent when the device reconnects', async () => {
      board.end(true);
      await sleep(300);
      const again = await connectDevice(c2);
      const got: any[] = [];
      again.on('message', (t, p) => got.push(JSON.parse(p.toString())));
      await new Promise((r) => again.subscribe(cmdTopic, { qos: 1 }, r));
      await sleep(2800);
      again.end(true);
      assert.deepEqual(got.map((m) => m.field).sort(), ['brightness', 'relay']);
    });
    await check('channel feeds: JSON and CSV with the read key, refused with a wrong key', async () => {
      const p = (await http('GET', `/api/v1/projects/${proj.id}`, tA)).body;
      assert.match(p.readApiKey, /^[A-Z0-9]{16}$/);
      const j = await (await fetch(`${API}/api/v1/channels/${proj.id}/feeds.json?api_key=${p.readApiKey}&results=50&device=${dev2.device.id}`)).json();
      assert.equal(j.channel.field1, 'Temperature');
      assert.ok(j.feeds.some((f: any) => f.field1 === 24.5 && f.field2 === 55), JSON.stringify(j.feeds.slice(0, 3)));
      const csv = await (await fetch(`${API}/api/v1/channels/${proj.id}/feeds.csv?api_key=${p.readApiKey}`)).text();
      assert.match(csv.split('\n')[0], /^created_at,device_id,device_name,Temperature \(°C\),Humidity \(%\)/);
      assert.equal((await fetch(`${API}/api/v1/channels/${proj.id}/feeds.json?api_key=WRONGWRONGWRONG1`)).status, 401);
      const viaToken = await fetch(`${API}/api/v1/channels/${proj.id}/feeds.json`, { headers: { authorization: `Bearer ${tA}` } });
      assert.equal(viaToken.status, 200);
    });
    await check('dashboard layout saves and loads; viewers cannot change it', async () => {
      const widgets = [
        { id: 'w1', type: 'gauge', title: 'Temperature', field: 'temperatureC', size: 'm', options: { min: 0, max: 50 } },
        { id: 'w2', type: 'switch', title: 'Pump', field: 'relay', size: 's', options: {} },
      ];
      assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/dashboard`, tA, { widgets })).status, 200);
      const g = await http('GET', `/api/v1/projects/${proj.id}/dashboard`, tB);
      assert.equal(g.body.widgets.length, 2);
      assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/dashboard`, tB, { widgets: [] })).status, 403);
    });

    await check('worker exposes metrics', async () => {
      const m = await (await fetch('http://127.0.0.1:19100/metrics')).text();
      assert.match(m, /arc_ingest_accepted_total 4/);
      assert.match(m, /arc_ingest_duplicates_total 1/);
    });
  } finally {
    for (const p of procs) p.kill('SIGTERM');
    await new Promise((r) => broker.close(() => r(null)));
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
