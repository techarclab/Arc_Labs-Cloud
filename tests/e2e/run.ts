/**
 * End-to-end checks for every phase (DATABASE_URL=postgres://… empty DB):  npm run test:e2e
 */
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MqttClient } from 'mqtt';
import {
  ROOT,
  DB,
  API,
  HOOKS,
  BROKER_PORT,
  SECRETS,
  sleep,
  http,
  hook,
  spawnSvc,
  waitFor,
  startBroker,
  connectDevice,
  pub,
  telemetry,
} from './harness';

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

async function main() {
  const procs: ChildProcess[] = [];
  const { server, broker } = await startBroker();
  const sinks = await startSinks();
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
      ALLOW_PRIVATE_WEBHOOKS: 'true',
      CONSOLE_URL: 'http://console.test',
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
        RULES_INTERVAL_SECONDS: '2',
        DELIVERIES_INTERVAL_SECONDS: '1',
        COMMANDS_INTERVAL_SECONDS: '1',
        ROLLOUTS_INTERVAL_SECONDS: '1',
        RETENTION_INTERVAL_SECONDS: '2',
        SMTP_URL: `smtp://127.0.0.1:${SMTP_PORT}/?ignoreTLS=true`,
        MAIL_FROM: 'ARC Cloud <alerts@arclabs.test>',
        CONSOLE_URL: 'http://console.test',
        ALLOW_PRIVATE_WEBHOOKS: 'true',
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
    await check('ACL: own telemetry/state/cmd-ack allowed; other device / other tenant / publishing cmd / wildcard subscribe denied', async () => {
      const t = (topic: string, action = 'publish') => hook('/internal/mqtt/authorize', { username: dev.id, clientid: dev.id, topic, action });
      assert.equal((await t(creds.topics.telemetry)).result, 'allow');
      assert.equal((await t(creds.topics.state)).result, 'allow');
      assert.equal((await t(`arc/v1/${orgA.id}/${proj.id}/${randomUUID()}/telemetry`)).result, 'deny');
      assert.equal((await t(`arc/v1/${orgB.id}/${proj.id}/${dev.id}/telemetry`)).result, 'deny');
      assert.equal((await t(`arc/v1/${orgA.id}/${proj.id}/${dev.id}/cmd-ack`)).result, 'allow');
      assert.equal((await t(`arc/v1/${orgA.id}/${proj.id}/${dev.id}/cmd`)).result, 'deny');
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

    await phases4to7({ tA, tB, orgA, orgB, proj, dev2, key2, sinks });
  } finally {
    for (const p of procs) p.kill('SIGTERM');
    await new Promise((r) => broker.close(() => r(null)));
    server.close();
    await sinks.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------------------------
// Phases 4–7 (rules & alerts, integrations, hardening, commands & OTA)
// ---------------------------------------------------------------------------------------

const SMTP_PORT = 18925;
const SINK_PORT = 18926;
const SINK = `http://127.0.0.1:${SINK_PORT}`;

interface Sinks {
  emails: { to: string; raw: string }[];
  hooks: { path: string; headers: Record<string, string>; body: string }[];
  close: () => Promise<void>;
}

async function startSinks(): Promise<Sinks> {
  const { SMTPServer } = await import('smtp-server');
  const { createServer: createHttp } = await import('node:http');
  const emails: Sinks['emails'] = [];
  const hooks: Sinks['hooks'] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (d) => (raw += d));
      stream.on('end', () => {
        for (const r of session.envelope.rcptTo) emails.push({ to: r.address, raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  const web = createHttp((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hooks.push({ path: req.url ?? '', headers: req.headers as Record<string, string>, body });
      res.writeHead(req.url?.startsWith('/fail') ? 500 : 204).end();
    });
  });
  await new Promise<void>((r) => web.listen(SINK_PORT, '127.0.0.1', r));
  return {
    emails,
    hooks,
    close: async () => {
      await new Promise<void>((r) => smtp.close(() => r()));
      await new Promise<void>((r) => web.close(() => r()));
    },
  };
}

async function sql(text: string, params: unknown[] = []) {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

async function eventually<T>(fn: () => Promise<T | undefined | null | false>, what: string, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`);
}

async function phases4to7(ctx: { tA: string; tB: string; orgA: any; orgB: any; proj: any; dev2: any; key2: string; sinks: Sinks }) {
  const { tA, tB, orgA, orgB, proj, dev2, key2, sinks } = ctx;
  const { createHmac, generateKeyPairSync, sign, createHash } = await import('node:crypto');
  const httpSend = async (q: string) => {
    await sleep(1100); // per-device HTTP rate limit (1/s)
    const r = await fetch(`${API}/api/v1/update?api_key=${encodeURIComponent(key2)}&${q}`);
    assert.equal(r.status, 200, await r.text());
  };
  const activeAlerts = async (ruleId: string) =>
    (await http('GET', `/api/v1/alerts?organizationId=${orgA.id}&status=active`, tA)).body.items.filter((a: any) => a.ruleId === ruleId);

  console.log('\nRules & alerts (phase 4)');
  const hook = await http('POST', '/api/v1/webhooks', tA, { organizationId: orgA.id, name: 'Ops', url: `${SINK}/hook`, events: ['alert.triggered', 'alert.resolved', 'command.updated'] });
  let rule: any;
  await check('rules: validation, roles and creation', async () => {
    assert.equal(hook.status, 201, JSON.stringify(hook.body));
    assert.match(hook.body.secret, /^whsec_/);
    assert.equal((await http('POST', '/api/v1/rules', tA, { projectId: proj.id, name: 'Bad', ruleType: 'threshold', metricKey: 'temperatureC' })).status, 400);
    assert.equal((await http('POST', '/api/v1/rules', tB, { projectId: proj.id, name: 'Hot', ruleType: 'offline' })).status, 403);
    const r = await http('POST', '/api/v1/rules', tA, {
      projectId: proj.id, name: 'Too hot', ruleType: 'threshold', metricKey: 'temperatureC', operator: '>', threshold: 30,
      severity: 'critical', cooldownSeconds: 0, notifyEmails: ['alice@arclabs.test'],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    rule = r.body;
  });
  await check('threshold breach triggers one alert (deduplicated) with email + signed webhook', async () => {
    await httpSend('field1=35');
    const [a] = await eventually(async () => (await activeAlerts(rule.id)).length === 1 && activeAlerts(rule.id), 'alert');
    assert.equal(a.status, 'triggered');
    assert.equal(a.severity, 'critical');
    assert.equal(a.value, 35);
    await httpSend('field1=36');
    await sleep(2500);
    assert.equal((await activeAlerts(rule.id)).length, 1, 'still one active alert');
    const email = await eventually(async () => sinks.emails.find((e) => e.to === 'alice@arclabs.test'), 'email');
    assert.match(email.raw, /CRITICAL(:|=3A)[ _]Too[ _]hot/);
    assert.match(email.raw, /Temperature is 35/);
    const wh = await eventually(async () => sinks.hooks.find((h) => h.headers['x-arc-event'] === 'alert.triggered'), 'webhook');
    const [, t, v1] = /t=(\d+),v1=([0-9a-f]+)/.exec(wh.headers['x-arc-signature'])!;
    assert.equal(createHmac('sha256', hook.body.secret).update(`${t}.${wh.body}`).digest('hex'), v1, 'valid HMAC signature');
    assert.equal(JSON.parse(wh.body).data.ruleName, 'Too hot');
  });
  let alertId = '';
  await check('acknowledge: viewer refused; engineer/admin records history', async () => {
    const [a] = await activeAlerts(rule.id);
    alertId = a.id;
    assert.equal((await http('POST', `/api/v1/alerts/${a.id}/acknowledge`, tB, {})).status, 403);
    const ack = await http('POST', `/api/v1/alerts/${a.id}/acknowledge`, tA, { note: 'Opening the vents' });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.status, 'acknowledged');
    assert.equal((await http('POST', `/api/v1/alerts/${a.id}/acknowledge`, tA, {})).status, 409);
    const d = await eventually(async () => {
      const r = (await http('GET', `/api/v1/alerts/${a.id}`, tA)).body;
      return r.notifications.some((n: any) => n.status === 'sent') && r;
    }, 'notification recorded');
    assert.deepEqual(d.history.map((h: any) => h.event).filter((e: string) => e !== 'notified'), ['triggered', 'acknowledged']);
    assert.equal(d.notifications.find((n: any) => n.kind === 'email').recipient, 'alice@arclabs.test');
  });
  await check('recovery resolves the alert automatically', async () => {
    await httpSend('field1=22');
    const a = await eventually(async () => {
      const r = (await http('GET', `/api/v1/alerts/${alertId}`, tA)).body;
      return r.status === 'resolved' && r;
    }, 'recovery');
    assert.equal(a.resolution, 'recovered');
    await eventually(async () => sinks.hooks.some((h) => h.headers['x-arc-event'] === 'alert.resolved'), 'resolved webhook');
  });
  await check('manual resolve with audit; cooldown suppresses re-trigger', async () => {
    await httpSend('field1=41');
    const [a] = await eventually(async () => (await activeAlerts(rule.id)).length === 1 && activeAlerts(rule.id), 'second alert');
    const res = await http('POST', `/api/v1/alerts/${a.id}/resolve`, tA, { note: 'fixed' });
    assert.equal(res.body.resolution, 'manual');
    assert.equal((await http('PATCH', `/api/v1/rules/${rule.id}`, tA, { cooldownSeconds: 3600 })).status, 200);
    await httpSend('field1=42');
    await sleep(3000);
    assert.equal((await activeAlerts(rule.id)).length, 0, 'cooldown holds');
    const audit = await http('GET', `/api/v1/organizations/${orgA.id}/audit-logs`, tA);
    assert.ok(audit.body.items.some((e: any) => e.action === 'alert.resolve'));
  });

  // MQTT device for offline rules, commands and OTA.
  const d3 = (await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'Pump controller', deviceType: 'esp32-pump', expectedIntervalSeconds: 5 })).body;
  const d4 = (await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'Pump controller 2', deviceType: 'esp32-pump', expectedIntervalSeconds: 5 })).body;
  const received: any[] = [];
  const connect3 = async () => {
    const c = await connectDevice(d3.credentials);
    await new Promise<void>((r, j) => c.subscribe(d3.credentials.topics.commands, { qos: 1 }, (e) => (e ? j(e) : r())));
    c.on('message', (_t, p) => received.push(JSON.parse(p.toString())));
    return c;
  };
  await check('offline rule alerts when a device disconnects', async () => {
    const off = await http('POST', '/api/v1/rules', tA, { projectId: proj.id, deviceId: d3.device.id, name: 'Pump offline', ruleType: 'offline', severity: 'warning' });
    assert.equal(off.status, 201);
    const c = await connect3();
    await pub(c, d3.credentials.topics.telemetry, telemetry({ temperatureC: 20 }));
    await sleep(1000);
    await new Promise<void>((r) => c.end(false, {}, () => r()));
    const [a] = await eventually(async () => {
      const l = await activeAlerts(off.body.id);
      return l.length === 1 && l;
    }, 'offline alert');
    assert.equal(a.deviceId, d3.device.id);
    assert.match(a.message, /disconnected/i);
  });

  await check('stale rule: waits for silence after connecting, alerts once readings stop, recovers', async () => {
    const d5 = (await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'Quiet sensor', expectedIntervalSeconds: 5 })).body;
    const st = await http('POST', '/api/v1/rules', tA, { projectId: proj.id, deviceId: d5.device.id, name: 'Quiet', ruleType: 'stale', staleSeconds: 60, severity: 'warning', cooldownSeconds: 0 });
    assert.equal(st.status, 201, JSON.stringify(st.body));
    const c = await connectDevice(d5.credentials);
    await sleep(5000); // several rule passes: connected, no reading yet, under the limit → no alert
    assert.equal((await activeAlerts(st.body.id)).length, 0, 'no alert right after connecting');
    await sql(`UPDATE devices SET last_seen_at = now() - interval '5 minutes', last_connected_at = now() - interval '5 minutes' WHERE id = $1`, [d5.device.id]);
    const [a] = await eventually(async () => {
      const l = await activeAlerts(st.body.id);
      return l.length === 1 && l;
    }, 'stale alert');
    assert.match(a.message, /No data for/);
    await pub(c, d5.credentials.topics.telemetry, telemetry({ temperatureC: 21 }));
    await eventually(async () => (await activeAlerts(st.body.id)).length === 0, 'stale alert recovers');
    await new Promise<void>((r) => c.end(false, {}, () => r()));
  });

  console.log('\nAPI keys, service accounts, webhooks, ARC LMS (phase 5)');
  const proj2 = (await http('POST', '/api/v1/projects', tA, { organizationId: orgA.id, name: 'Cold store' })).body;
  await check('scoped API key: channel-limited, read-only, revocable', async () => {
    const k = await http('POST', '/api/v1/api-keys', tA, { organizationId: orgA.id, name: 'Grafana', role: 'viewer', projectIds: [proj.id] });
    assert.equal(k.status, 201, JSON.stringify(k.body));
    assert.match(k.body.secret, /^arc_sk_/);
    const key = k.body.secret;
    assert.equal((await http('GET', `/api/v1/devices?projectId=${proj.id}`, key)).status, 200);
    assert.equal((await http('GET', `/api/v1/devices/${dev2.device.id}/telemetry/latest`, key)).status, 200);
    assert.equal((await http('GET', `/api/v1/projects/${proj2.id}`, key)).status, 404, 'other channel hidden');
    assert.equal((await http('GET', `/api/v1/projects?organizationId=${orgA.id}`, key)).body.items.length, 1);
    assert.equal((await http('GET', `/api/v1/organizations/${orgB.id}`, key)).status, 404, 'other tenant hidden');
    assert.equal((await http('POST', '/api/v1/devices', key, { projectId: proj.id, displayName: 'x' })).status, 403, 'viewer key cannot write');
    assert.equal((await http('GET', `/api/v1/organizations/${orgA.id}/members`, key)).status, 404, 'restricted key cannot list members');
    assert.equal((await http('POST', '/api/v1/organizations', key, { name: 'Nope', slug: 'nope-co' })).status, 403);
    assert.equal((await http('POST', '/api/v1/api-keys', key, { organizationId: orgA.id, name: 'escalate', role: 'engineer' })).status, 403);
    assert.equal((await http('GET', `/api/v1/api-keys?organizationId=${orgA.id}`, tB)).status, 403, 'viewer cannot list keys');
    const list = await http('GET', `/api/v1/api-keys?organizationId=${orgA.id}`, tA);
    assert.ok(list.body.items[0].lastUsedAt, 'last used recorded');
    assert.ok(!JSON.stringify(list.body).includes(key), 'secret never listed');
    assert.equal((await http('DELETE', `/api/v1/api-keys/${k.body.id}`, tA)).status, 204);
    assert.equal((await http('GET', `/api/v1/devices?projectId=${proj.id}`, key)).status, 401);
  });
  let svcToken = '';
  await check('service account: OAuth2 client-credentials token', async () => {
    const sa = await http('POST', '/api/v1/api-keys', tA, { organizationId: orgA.id, name: 'ARC LMS', kind: 'service_account', role: 'viewer' });
    assert.equal(sa.status, 201);
    assert.equal((await http('POST', '/api/v1/oauth/token', undefined, { grant_type: 'client_credentials', client_id: sa.body.id, client_secret: 'arc_sk_wrong-wrong-wrong' })).status, 401);
    const form = await fetch(`${API}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: sa.body.id, client_secret: sa.body.secret }),
    });
    const tok = await form.json();
    assert.equal(form.status, 200, JSON.stringify(tok));
    assert.equal(tok.token_type, 'Bearer');
    svcToken = tok.access_token;
    assert.equal((await http('GET', `/api/v1/devices?projectId=${proj2.id}`, svcToken)).status, 200);
    assert.equal((await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, svcToken, { field: 'relay', value: 1 })).status, 403);
  });
  await check('webhooks: test delivery, delivery log, retries on failure', async () => {
    const t = await http('POST', `/api/v1/webhooks/${hook.body.id}/test`, tA);
    assert.equal(t.status, 202);
    await eventually(async () => sinks.hooks.some((h) => h.headers['x-arc-event'] === 'webhook.test'), 'test delivery');
    const log = await http('GET', `/api/v1/webhooks/${hook.body.id}/deliveries`, tA);
    assert.ok(log.body.items.some((d: any) => d.eventType === 'webhook.test' && d.status === 'sent' && d.responseCode === 204));
    const bad = await http('POST', '/api/v1/webhooks', tA, { organizationId: orgA.id, name: 'Broken', url: `${SINK}/fail`, events: ['*'] });
    await http('POST', `/api/v1/webhooks/${bad.body.id}/test`, tA);
    const d = await eventually(async () => {
      const items = (await http('GET', `/api/v1/webhooks/${bad.body.id}/deliveries`, tA)).body.items;
      return items[0]?.attempts >= 1 && items[0].lastError && items[0];
    }, 'failed attempt');
    assert.equal(d.status, 'pending', 'scheduled for retry');
    assert.equal(d.responseCode, 500);
    assert.ok(new Date(d.nextAttemptAt).getTime() > Date.now() + 10_000, 'backoff applied');
    assert.equal((await http('POST', '/api/v1/webhooks', tB, { organizationId: orgA.id, name: 'x', url: `${SINK}/x`, events: ['*'] })).status, 403);
    await http('DELETE', `/api/v1/webhooks/${bad.body.id}`, tA);
  });
  await check('ARC LMS: learner token limited to linked devices, read-only, revocable', async () => {
    const link = await http('POST', '/api/v1/lms/links', tA, { projectId: proj.id, lmsRef: 'iot-101/lab-3', title: 'Lab 3: sensors', deviceIds: [dev2.device.id], maxTokenMinutes: 60 });
    assert.equal(link.status, 201, JSON.stringify(link.body));
    const lt = await http('POST', `/api/v1/lms/links/${link.body.id}/learner-tokens`, svcToken, { learnerRef: 'student-42', minutes: 600 });
    assert.equal(lt.status, 201, JSON.stringify(lt.body));
    assert.equal(lt.body.expiresIn, 3600, 'capped at the link maximum');
    assert.match(lt.body.viewerUrl, /^http:\/\/console\.test\/lab#/);
    const learner = lt.body.accessToken;
    assert.equal((await http('GET', `/api/v1/devices/${dev2.device.id}/telemetry/latest`, learner)).status, 200);
    assert.equal((await http('GET', `/api/v1/devices/${d3.device.id}`, learner)).status, 404, 'unlinked device hidden');
    const list = await http('GET', `/api/v1/devices?projectId=${proj.id}`, learner);
    assert.deepEqual(list.body.items.map((d: any) => d.id), [dev2.device.id]);
    assert.equal((await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, learner, { field: 'relay', value: 1 })).status, 403);
    assert.equal((await http('POST', `/api/v1/lms/links/${link.body.id}/learner-tokens`, learner, { learnerRef: 'x' })).status, 404, 'learners cannot mint tokens');
    assert.ok(JSON.stringify((await http('GET', `/api/v1/auth/me`, learner)).body).includes('student-42'));
    assert.equal((await http('DELETE', `/api/v1/lms/links/${link.body.id}`, tA)).status, 204);
    assert.equal((await http('GET', `/api/v1/devices/${dev2.device.id}/telemetry/latest`, learner)).status, 401, 'revoked link ends access');
    const audit = await http('GET', `/api/v1/organizations/${orgA.id}/audit-logs`, tA);
    assert.ok(audit.body.items.some((e: any) => e.action === 'lms.learner_token'), 'cross-platform access logged');
  });
  await check('OpenAPI documentation is published', async () => {
    const spec = await (await fetch(`${API}/api/openapi.json`)).json();
    for (const p of ['/api/v1/rules', '/api/v1/alerts/{id}/acknowledge', '/api/v1/api-keys', '/api/v1/webhooks', '/api/v1/oauth/token', '/api/v1/devices/{id}/commands', '/api/v1/firmware/releases']) {
      assert.ok(spec.paths[p], `missing ${p}`);
    }
    assert.ok(spec.paths['/api/v1/rules'].post.requestBody, 'request bodies documented');
    assert.equal((await fetch(`${API}/api/docs`)).status, 200);
  });

  console.log('\nCommands & OTA (phase 7)');
  await check('command allow-list: admin defines, others refused, reserved names blocked', async () => {
    assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/command-types/blink`, tB, { params: [] })).status, 403);
    assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/command-types/ota.update`, tA, { params: [] })).status, 400);
    const t = await http('PUT', `/api/v1/projects/${proj.id}/command-types/blink`, tA, {
      description: 'Blink the LED', params: [{ key: 'seconds', type: 'number', min: 1, max: 10, required: true }], ttlSeconds: 120,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal((await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'reboot' })).status, 400);
    assert.equal((await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 99 } })).status, 400);
    assert.equal((await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tB, { name: 'blink', payload: { seconds: 2 } })).status, 403);
  });
  let c3: MqttClient | null = null;
  await check('MQTT command: queued while offline, delivered on reconnect, acknowledged by device', async () => {
    const sent = await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 2 } });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    c3 = await connect3();
    const msg = await eventually(async () => received.find((m) => m.commandId === sent.body.id), 'command delivered');
    assert.deepEqual(msg.payload, { seconds: 2 });
    assert.equal((await http('GET', `/api/v1/commands/${sent.body.id}`, tA)).body.status !== 'acknowledged', true, 'not acknowledged before the device says so');
    await pub(c3, d3.credentials.topics.telemetry.replace(/telemetry$/, 'cmd-ack'), { commandId: sent.body.id, status: 'ok', result: { blinked: true } });
    const done = await eventually(async () => {
      const r = (await http('GET', `/api/v1/commands/${sent.body.id}`, tA)).body;
      return r.status === 'acknowledged' && r;
    }, 'ack');
    assert.deepEqual(done.result, { blinked: true });
    await eventually(async () => sinks.hooks.some((h) => h.headers['x-arc-event'] === 'command.updated' && JSON.parse(h.body).data.status === 'acknowledged'), 'command webhook');
  });
  await check('commands expire when not acknowledged; failures recorded', async () => {
    const s1 = await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 1 } });
    await sql(`UPDATE commands SET expires_at = now() - interval '1 second' WHERE id = $1`, [s1.body.id]);
    await eventually(async () => (await http('GET', `/api/v1/commands/${s1.body.id}`, tA)).body.status === 'expired', 'expired');
    const s2 = await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 1 } });
    await pub(c3!, d3.credentials.topics.telemetry.replace(/telemetry$/, 'cmd-ack'), { commandId: s2.body.id, status: 'error', error: 'LED broken' });
    const f = await eventually(async () => {
      const r = (await http('GET', `/api/v1/commands/${s2.body.id}`, tA)).body;
      return r.status === 'failed' && r;
    }, 'failed');
    assert.equal(f.error, 'LED broken');
  });
  await check('HTTP device: fetch next command and acknowledge it', async () => {
    const s = await http('POST', `/api/v1/devices/${dev2.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 3 } });
    await sleep(1100);
    const next = await fetch(`${API}/api/v1/commands/next?api_key=${encodeURIComponent(key2)}`);
    const body = await next.json();
    assert.equal(body.commandId, s.body.id);
    const ack = await fetch(`${API}/api/v1/commands/${s.body.id}/ack?api_key=${encodeURIComponent(key2)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"status":"ok"}' });
    assert.equal(ack.status, 200);
    assert.equal((await http('GET', `/api/v1/commands/${s.body.id}`, tA)).body.status, 'acknowledged');
    await sleep(1100);
    assert.equal((await fetch(`${API}/api/v1/commands/next?api_key=${encodeURIComponent(key2)}`)).status, 204);
    const again = await fetch(`${API}/api/v1/commands/${s.body.id}/ack?api_key=${encodeURIComponent(key2)}`, { method: 'POST' });
    assert.equal(again.status, 404, 'cannot ack twice');
  });
  await check('OTA: unsigned/mis-signed releases refused; signed staged rollout completes', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const key = await http('POST', '/api/v1/firmware/signing-keys', tA, { organizationId: orgA.id, name: 'Release key', publicKeyPem: pem });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const m = { deviceType: 'esp32-pump', version: '2.0.0', url: 'https://firmware.arclabs.test/pump-2.0.0.bin', sha256: createHash('sha256').update('fw').digest('hex'), sizeBytes: 1048576 };
    const canonical = JSON.stringify({ deviceType: m.deviceType, sha256: m.sha256, sizeBytes: m.sizeBytes, url: m.url, version: m.version });
    const signature = sign(null, Buffer.from(canonical), privateKey).toString('base64');
    const badSig = sign(null, Buffer.from(canonical.replace('2.0.0', '2.0.1')), privateKey).toString('base64');
    assert.equal((await http('POST', '/api/v1/firmware/releases', tA, { organizationId: orgA.id, ...m, signature: badSig, signingKeyId: key.body.id })).status, 400);
    const rel = await http('POST', '/api/v1/firmware/releases', tA, { organizationId: orgA.id, ...m, signature, signingKeyId: key.body.id });
    assert.equal(rel.status, 201, JSON.stringify(rel.body));
    const ro = await http('POST', '/api/v1/firmware/rollouts', tA, { releaseId: rel.body.id, projectId: proj.id, percent: 50 });
    assert.equal(ro.status, 201, JSON.stringify(ro.body));
    assert.equal(ro.body.devices.length, 1, '50% of 2 devices');
    // Whichever device was picked: if it's d3, it receives the OTA command over MQTT.
    const widen = await http('PATCH', `/api/v1/firmware/rollouts/${ro.body.id}`, tA, { percent: 100 });
    assert.equal(widen.body.devices.length, 2);
    const ota = await eventually(async () => received.find((x) => x.name === 'ota.update'), 'OTA command');
    assert.equal(ota.payload.version, '2.0.0');
    assert.equal(ota.payload.signature, signature);
    await pub(c3!, d3.credentials.topics.telemetry.replace(/telemetry$/, 'cmd-ack'), { commandId: ota.commandId, status: 'ok' });
    await pub(c3!, d3.credentials.topics.telemetry, { ...telemetry({ temperatureC: 21 }), metadata: { firmwareVersion: '2.0.0' } });
    // d4 updates over the same rails (simulate its report).
    await sql(`UPDATE devices SET firmware_version = '2.0.0' WHERE id = $1`, [d4.device.id]);
    const final = await eventually(async () => {
      const r = (await http('GET', `/api/v1/firmware/rollouts/${ro.body.id}`, tA)).body;
      return r.status === 'completed' && r;
    }, 'rollout completed');
    assert.deepEqual(final.devices.map((d: any) => d.status), ['succeeded', 'succeeded']);
  });

  console.log('\nHardening (phase 6)');
  await check('quotas enforced from the organization plan', async () => {
    await sql('UPDATE organizations SET max_devices = 1 WHERE id = $1', [orgA.id]);
    const r = await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'Over quota' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'quota_exceeded');
    await sql('UPDATE organizations SET max_devices = 50 WHERE id = $1', [orgA.id]);
  });
  await check('retention removes telemetry older than the organization setting', async () => {
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/settings`, tB, { retentionDays: 30 })).status, 403);
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/settings`, tA, { retentionDays: 5000 })).status, 400);
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/settings`, tA, { retentionDays: 365 })).status, 403, 'above the free plan');
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/settings`, tA, { retentionDays: 30 })).status, 200);
    await sql(
      `INSERT INTO telemetry_measurements (organization_id, project_id, device_id, metric_key, metric_value, ts, received_at, message_id)
       VALUES ($1, $2, $3, 'temperatureC', 1, now() - interval '40 days', now() - interval '40 days', 'old-msg')`,
      [orgA.id, proj.id, dev2.device.id],
    );
    await eventually(async () => (await sql(`SELECT 1 FROM telemetry_measurements WHERE message_id = 'old-msg'`)).length === 0, 'old row purged');
    assert.ok((await sql('SELECT count(*)::int AS n FROM telemetry_measurements WHERE organization_id = $1', [orgA.id]))[0].n > 0, 'recent data kept');
  });
  await check('plans: only platform admins change limits', async () => {
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/plan`, tA, { plan: 'pro' })).status, 403);
    await sql(`UPDATE users SET is_platform_admin = true WHERE email = 'alice@arclabs.test'`);
    const p = await http('PATCH', `/api/v1/organizations/${orgA.id}/plan`, tA, { plan: 'pro' });
    assert.equal(p.status, 200);
    assert.equal(p.body.maxDevices, 1000);
    const all = await http('GET', '/api/v1/platform/organizations', tA);
    assert.equal(all.status, 200);
    assert.ok(all.body.items.some((o: any) => o.id === orgA.id && o.plan === 'pro' && o.ownerEmail === 'alice@arclabs.test'));
    assert.ok(all.body.items.some((o: any) => o.id === orgB.id), 'sees every organization');
    await sql(`UPDATE users SET is_platform_admin = false WHERE email = 'alice@arclabs.test'`);
    assert.equal((await http('GET', '/api/v1/platform/organizations', tA)).status, 403);
  });
  await check('overview and usage analytics', async () => {
    const o = await http('GET', `/api/v1/organizations/${orgA.id}/overview`, tB);
    assert.equal(o.status, 200);
    assert.ok(o.body.devices.total >= 4);
    assert.ok(o.body.recentAlerts.length >= 1);
    assert.ok(o.body.projects.some((p: any) => p.name === 'Greenhouse'));
    const u = await http('GET', `/api/v1/organizations/${orgA.id}/usage`, tA);
    assert.equal(u.body.plan, 'pro');
    assert.ok(u.body.used.devices >= 3);
    assert.ok(u.body.messagesPerDay.length >= 1);
    assert.ok(u.body.topDevices.length >= 1);
  });
  await check('worker exposes job metrics', async () => {
    const m = await (await fetch('http://127.0.0.1:19100/metrics')).text();
    assert.match(m, /arc_alerts_triggered_total \d+/);
    assert.match(m, /arc_deliveries_sent_total\{reason="webhook"\} \d+/);
    assert.match(m, /arc_deliveries_retried_total\{reason="webhook"\} \d+/);
  });
  await check('custom HTML/CSS board widgets save with long options', async () => {
    const html = '<div class="hero">{{temperatureC}}</div>'.repeat(200);
    const widgets = [{ id: 'cb1', type: 'custom', title: 'My board', field: '', size: 'l', options: { template: 'hero', html, css: '.hero{color:red}', height: 240 } }];
    assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/dashboard`, tA, { widgets })).status, 200);
    assert.equal((await http('GET', `/api/v1/projects/${proj.id}/dashboard`, tA)).body.widgets[0].options.html.length, html.length);
    const huge = { ...widgets[0], options: { html: 'x'.repeat(20001) } };
    assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/dashboard`, tA, { widgets: [huge] })).status, 400);
  });
  await check('delete channel: admins only, name must match, removes devices and readings', async () => {
    const scrap = (await http('POST', '/api/v1/projects', tA, { organizationId: orgA.id, name: 'Scrap bench' })).body;
    await http('PUT', `/api/v1/projects/${scrap.id}/fields`, tA, { metrics: [{ metricKey: 'temp', label: 'Temp', position: 1 }, { metricKey: 'led', label: 'LED', kind: 'control', position: 2, minValue: 0, maxValue: 1 }] });
    const d = (await http('POST', '/api/v1/devices', tA, { projectId: scrap.id, displayName: 'Scrap ESP32' })).body;
    const k = d.credentials.http.apiKey as string;
    assert.equal((await fetch(`${API}/api/v1/update?api_key=${encodeURIComponent(k)}&field1=21.5`)).status, 200);
    const scoped = await http('POST', '/api/v1/api-keys', tA, { organizationId: orgA.id, name: 'scrap only', role: 'viewer', projectIds: [scrap.id] });
    assert.equal((await http('DELETE', `/api/v1/projects/${scrap.id}`, tB, { confirmName: 'Scrap bench' })).status, 403, 'viewer');
    assert.equal((await http('DELETE', `/api/v1/projects/${scrap.id}`, tA, { confirmName: 'Scrap' })).status, 400, 'wrong name');
    assert.equal((await http('DELETE', `/api/v1/projects/${scrap.id}`, scoped.body.secret, { confirmName: 'Scrap bench' })).status, 403, 'API key');
    const del = await http('DELETE', `/api/v1/projects/${scrap.id}`, tA, { confirmName: 'Scrap bench' });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.devices, 1);
    assert.equal((await http('GET', `/api/v1/projects/${scrap.id}`, tA)).status, 404);
    assert.equal((await http('GET', `/api/v1/devices/${d.device.id}`, tA)).status, 404);
    assert.equal((await fetch(`${API}/api/v1/update?api_key=${encodeURIComponent(k)}&field1=22`)).status, 401, 'device key stops working');
    assert.equal(Number((await sql(`SELECT count(*) FROM telemetry_measurements WHERE project_id = '${scrap.id}'`))[0].count), 0);
    assert.ok((await sql(`SELECT revoked_at FROM api_keys WHERE id = '${scoped.body.id}'`))[0].revoked_at, 'channel-only key revoked');
    assert.ok((await http('GET', `/api/v1/organizations/${orgA.id}/audit-logs?limit=5`, tA)).body.items.some((e: any) => e.action === "project.delete"));
  });
  if (c3) await new Promise<void>((r) => c3!.end(false, {}, () => r()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
