/**
 * Production-stack tests: the real EMQX 5.8 image and config (Dockerfile.emqx + infra/emqx/base.hocon.tpl), the
 * production compose file, Caddy, API, worker and PostgreSQL, started by tests/stack/up.sh. The end-to-end suite
 * (tests/e2e) covers the application logic with a stand-in broker; this suite covers what only the real broker
 * decides: the TLS listener, the authentication/authorization hooks as EMQX calls them, listener and protocol
 * limits, EMQX's own client events, the management API, and restarts.
 *
 *   bash tests/stack/up.sh && NODE_EXTRA_CA_CERTS=tests/stack/out/ca.crt npx tsx tests/stack/run.ts   (STACK_DEVICES=200)
 *
 * Writes tests/stack/out/results.json and results.md (evidence for docs/operations/).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { resolve } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { MqttClient } from 'mqtt';
import {
  API, CA, closedWithin, connect, Creds, docker, end, eventually, http, MQTT_HOST, OUT, publish, SimDevice, sleep, sql, subscribe, telemetry,
} from './lib';

const N = Number(process.env.STACK_DEVICES ?? 200);
const results: { name: string; ok: boolean; ms: number; err?: string }[] = [];
const measurements: Record<string, string | number> = {};
const note = (k: string, v: string | number) => {
  measurements[k] = v;
  console.log(`      · ${k}: ${v}`);
};

async function check(name: string, fn: () => Promise<void> | void) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err: any) {
    results.push({ name, ok: false, ms: Date.now() - t0, err: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const status = async (t: string, id: string) => (await http('GET', `/api/v1/devices/${id}`, t)).body?.connectivity?.status as string;
const latest = async (t: string, id: string, metric: string) =>
  (await http('GET', `/api/v1/devices/${id}/telemetry/latest`, t)).body?.items?.find((i: any) => i.metric === metric)?.value as number | undefined;
const deepOk = async () => (await fetch(`${API}/health/deep`)).status === 200;

/** TCP connect to 127.0.0.1:port; true when something accepts. */
const portOpen = (port: number) =>
  new Promise<boolean>((r) => {
    const s = netConnect({ host: '127.0.0.1', port, timeout: 2000 });
    s.once('connect', () => (s.destroy(), r(true)));
    s.once('error', () => r(false));
    s.once('timeout', () => (s.destroy(), r(false)));
  });

/** TLS handshake with the MQTT listener; returns the negotiated protocol and the peer certificate's SANs. */
const handshake = (opts: { minVersion?: any; maxVersion?: any } = {}) =>
  new Promise<{ protocol: string | null; san: string }>((r, j) => {
    const s = tlsConnect({ host: MQTT_HOST, port: 8883, servername: MQTT_HOST, ca: CA, ...opts }, () => {
      const out = { protocol: s.getProtocol(), san: s.getPeerCertificate().subjectaltname ?? '' };
      s.end();
      r(out);
    });
    s.once('error', j);
  });

async function main() {
  if (!process.env.NODE_EXTRA_CA_CERTS) throw new Error('set NODE_EXTRA_CA_CERTS=tests/stack/out/ca.crt (Caddy\'s root, written by up.sh) so HTTPS calls trust the stack');
  console.log(`Production stack: EMQX ${docker('exec', 'arc-cloud-emqx-1', 'emqx', 'ctl', 'broker').match(/version\s*:\s*(\S+)/)?.[1] ?? '?'}, ${N} simulated devices\n`);

  // ---------- Setup through the public API ----------
  const adminEmail = 'platform-admin@arc.test'; // listed in PLATFORM_ADMIN_EMAILS by up.sh (needed to move the org to Pro)
  const reg = await http('POST', '/api/v1/auth/register', undefined, { email: adminEmail, displayName: 'Stack Admin', password: 'stack-test-password-1', ageGroup: 'adult', acceptTerms: true });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${adminEmail}'`); // no SMTP in CI
  const t = reg.body.accessToken as string;
  const org = (await http('POST', '/api/v1/organizations', t, { name: 'Stack Test', slug: 'stack-test' })).body;
  assert.ok(org.id, JSON.stringify(org));
  assert.equal((await http('PATCH', `/api/v1/organizations/${org.id}/plan`, t, { plan: 'pro' })).status, 200);
  const proj = (await http('POST', '/api/v1/projects', t, { organizationId: org.id, name: 'Stack', timezone: 'Asia/Kolkata' })).body;
  const fields = await http('PUT', `/api/v1/projects/${proj.id}/fields`, t, {
    metrics: [
      { metricKey: 'temperature', label: 'Temperature', unit: '°C', minValue: -40, maxValue: 85 },
      { metricKey: 'seq', label: 'Sequence', minValue: 0, maxValue: 1e9 },
      { metricKey: 'led1', label: 'LED 1', kind: 'control', minValue: 0, maxValue: 1, step: 1, decimals: 0 },
    ],
  });
  assert.equal(fields.status, 200, JSON.stringify(fields.body));
  assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/command-types/blink`, t, { params: [{ key: 'seconds', type: 'number', min: 1, max: 10, required: true }], ttlSeconds: 600 })).status, 200);

  const newDevice = async (name: string, interval = 10): Promise<{ id: string; creds: Creds }> => {
    const r = await http('POST', '/api/v1/devices', t, { projectId: proj.id, displayName: name, deviceType: 'esp32', expectedIntervalSeconds: interval });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.device.id, creds: r.body.credentials };
  };
  const dev = await newDevice('Probe');
  const other = await newDevice('Neighbour');
  const ackTopic = dev.creds.topics.telemetry.replace(/telemetry$/, 'cmd-ack');

  // ---------- 1. What the server exposes ----------
  console.log('Exposure (as on the Oracle VM)');
  await check('only 80, 443 and 8883 are published on the host', async () => {
    const published = new Set<number>();
    for (const line of docker('ps', '--filter', 'label=com.docker.compose.project=arc-cloud', '--format', '{{.Ports}}').split('\n')) {
      for (const m of line.matchAll(/:(\d+)->/g)) published.add(Number(m[1]));
    }
    assert.deepEqual([...published].sort((a, b) => a - b), [80, 443, 8883]);
    for (const p of [1883, 18083, 5432, 3000, 3001]) assert.equal(await portOpen(p), false, `port ${p} must not be reachable from outside`);
  });

  // ---------- 2. TLS listener ----------
  console.log('\nTLS listener (listeners.ssl.default)');
  await check('TLS 1.3 by default and TLS 1.2 accepted; certificate for the MQTT host name, issued through arc-cert-sync', async () => {
    const v13 = await handshake();
    assert.equal(v13.protocol, 'TLSv1.3');
    assert.ok(v13.san.includes(`DNS:${MQTT_HOST}`), v13.san);
    assert.equal((await handshake({ maxVersion: 'TLSv1.2' })).protocol, 'TLSv1.2');
    note('tls_san', v13.san);
  });
  await check('plain (unencrypted) MQTT on 8883 is refused', async () => {
    const got = await new Promise<string>((r) => {
      const s = netConnect({ host: '127.0.0.1', port: 8883 }, () => {
        // MQTT 3.1.1 CONNECT, client id "x", clean session
        s.write(Buffer.from([0x10, 0x0d, 0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c, 0x00, 0x01, 0x78]));
      });
      s.once('data', (d) => (s.destroy(), r(d[0] === 0x20 ? 'connack' : 'other')));
      s.once('close', () => r('closed'));
      s.once('error', () => r('closed'));
      setTimeout(() => (s.destroy(), r('timeout')), 5000);
    });
    assert.notEqual(got, 'connack', 'the TLS listener answered a plain MQTT CONNECT');
  });

  // ---------- 3. Authentication (EMQX → POST /internal/mqtt/authenticate) ----------
  console.log('\nAuthentication hook');
  await check('valid device credentials connect (MQTT 3.1.1 and 5)', async () => {
    await end(await connect(dev.creds));
    await end(await connect(dev.creds, { protocolVersion: 5 }));
  });
  await check('wrong password, unknown device, empty password and client id ≠ username are refused', async () => {
    await assert.rejects(connect({ ...dev.creds, password: 'wrong-password-wrong-password' }));
    await assert.rejects(connect({ ...dev.creds, clientId: randomUUID(), username: undefined }));
    const ghost = randomUUID();
    await assert.rejects(connect({ ...dev.creds, clientId: ghost, username: ghost }));
    await assert.rejects(connect({ ...dev.creds, password: '' }));
    await assert.rejects(connect({ ...dev.creds, clientId: other.id }), 'another device id as client id');
  });
  await check('a second connection with the same client id takes over; the first is closed', async () => {
    const first = await connect(dev.creds);
    const second = await connect(dev.creds);
    assert.equal(await closedWithin(first, 5000), true, 'first session still open');
    assert.equal(second.connected, true);
    await end(first);
    await end(second);
  });

  // ---------- 4. Authorization (EMQX → POST /internal/mqtt/authorize, deny_action = disconnect) ----------
  console.log('\nTopic permissions');
  await check('own telemetry is accepted, stored and marks the device online (EMQX client events)', async () => {
    const c = await connect(dev.creds);
    await publish(c, dev.creds.topics.telemetry, telemetry({ temperature: 21.5, seq: 1 }));
    await eventually(async () => (await latest(t, dev.id, 'temperature')) === 21.5, 'reading stored');
    await eventually(async () => (await status(t, dev.id)) === 'online', 'online');
    await end(c);
    await eventually(async () => (await status(t, dev.id)) === 'offline', 'offline after a clean disconnect', 20_000);
  });
  await check('own cmd topic: subscribe granted at QoS 1', async () => {
    const c = await connect(dev.creds);
    assert.equal(await subscribe(c, dev.creds.topics.cmd), 1);
    await end(c);
  });
  await check("publishing to another device's topic disconnects the client and stores nothing", async () => {
    const c = await connect(dev.creds);
    c.publish(other.creds.topics.telemetry, JSON.stringify(telemetry({ temperature: 66 })), { qos: 1 });
    assert.equal(await closedWithin(c, 5000), true, 'still connected after a denied publish');
    await end(c);
    await sleep(1500);
    assert.equal(await latest(t, other.id, 'temperature'), undefined);
  });
  await check('publishing on its own cmd topic (cloud → device only) disconnects the client', async () => {
    const c = await connect(dev.creds);
    c.publish(dev.creds.topics.cmd, '{}', { qos: 1 });
    assert.equal(await closedWithin(c, 5000), true);
    await end(c);
  });
  await check("wildcard and other devices' subscriptions are refused", async () => {
    for (const topic of ['#', `arc/v1/${org.id}/#`, other.creds.topics.cmd]) {
      const c = await connect(dev.creds);
      let refused = false;
      try {
        refused = (await subscribe(c, topic)) === 128;
      } catch {
        refused = true;
      }
      refused ||= await closedWithin(c, 3000);
      assert.equal(refused, true, `subscription to ${topic} was granted`);
      await end(c);
    }
  });

  // ---------- 5. Protocol limits (mqtt { … } in base.hocon) ----------
  console.log('\nProtocol and listener limits');
  await check('packets over 16 KB (max_packet_size) close the connection; nothing stored', async () => {
    const c = await connect(dev.creds);
    const big = JSON.stringify({ ...telemetry({ temperature: 77 }), metadata: { pad: 'x'.repeat(17 * 1024) } });
    c.publish(dev.creds.topics.telemetry, big, { qos: 1 });
    assert.equal(await closedWithin(c, 5000), true);
    await end(c);
    await sleep(1500);
    assert.notEqual(await latest(t, dev.id, 'temperature'), 77);
  });
  await check('client ids over 64 characters (max_clientid_len) are refused', async () => {
    await assert.rejects(connect({ ...dev.creds, clientId: 'x'.repeat(65) }));
  });
  await check('retained messages are refused (retain_available = false)', async () => {
    const c = await connect(dev.creds, { protocolVersion: 5 });
    c.publish(dev.creds.topics.telemetry, JSON.stringify(telemetry({ temperature: 1 })), { qos: 1, retain: true });
    assert.equal(await closedWithin(c, 5000), true, 'a retained publish was accepted');
    await end(c);
  });
  await check('listener connection limit as configured (100000) and 1 GB memory cap', async () => {
    const listeners = docker('exec', 'arc-cloud-emqx-1', 'emqx', 'ctl', 'listeners');
    const ssl = listeners.split(/\n(?=\S)/).find((b) => b.startsWith('ssl:default')) ?? '';
    note('emqx_listener_ssl', ssl.replace(/\s+/g, ' ').trim());
    assert.match(ssl, /max_conns\s*:\s*100000/);
    const mem = docker('inspect', '-f', '{{.HostConfig.Memory}}', 'arc-cloud-emqx-1').trim();
    assert.equal(mem, String(1024 ** 3));
  });

  // ---------- 6. Commands, controls and the management API ----------
  console.log('\nControls, commands and live revocation');
  await check('a dashboard switch reaches the device; current values are re-sent after reconnecting', async () => {
    const sim = new SimDevice(dev.creds);
    await sim.start();
    await sleep(2500); // the re-send after connect lands ~2 s later
    sim.controls.length = 0;
    assert.equal((await http('POST', `/api/v1/devices/${dev.id}/controls`, t, { field: 'led1', value: 1 })).status, 200);
    await eventually(async () => sim.controls.some((m) => m.field === 'led1' && m.value === 1), 'control delivered', 10_000, 200);
    await sim.stop();
    sim.controls.length = 0;
    await sim.start();
    await eventually(async () => sim.controls.some((m) => m.field === 'led1' && m.value === 1), 'control re-sent after reconnect', 15_000, 200);
    await sim.stop();
  });
  await check('a command sent while the device is offline is delivered when it connects (worker re-delivery) and acknowledged', async () => {
    const sent = await http('POST', `/api/v1/devices/${dev.id}/commands`, t, { name: 'blink', payload: { seconds: 2 } });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const c = await connect(dev.creds);
    const got = new Promise<any>((r) => c.on('message', (_t, b) => { const m = JSON.parse(b.toString()); if (m.commandId === sent.body.id) r(m); }));
    await subscribe(c, dev.creds.topics.cmd);
    const msg = await Promise.race([got, sleep(20_000).then(() => { throw new Error('command not delivered'); })]);
    assert.deepEqual(msg.payload, { seconds: 2 });
    await publish(c, ackTopic, { commandId: sent.body.id, status: 'ok' });
    await eventually(async () => (await http('GET', `/api/v1/commands/${sent.body.id}`, t)).body.status === 'acknowledged', 'acknowledged');
    await end(c);
  });
  await check('rotation cuts the live session through the EMQX management API; old password refused, new one works', async () => {
    const live = await connect(dev.creds);
    const t0 = Date.now();
    const r = await http('POST', `/api/v1/devices/${dev.id}/rotate-credentials`, t);
    assert.equal(r.status, 200);
    assert.equal(await closedWithin(live, 5000), true, 'session still open 5 s after rotation (the 30 s ACL cache would be the only limit)');
    note('rotation_disconnect_ms', Date.now() - t0);
    await end(live);
    await assert.rejects(connect(dev.creds));
    dev.creds = { ...dev.creds, password: r.body.credentials.password };
    await end(await connect(dev.creds));
  });
  await check('revocation cuts the live session and blocks reconnecting', async () => {
    const victim = await newDevice('Revoked');
    const live = await connect(victim.creds);
    assert.equal((await http('POST', `/api/v1/devices/${victim.id}/revoke`, t, { reason: 'stack test' })).status, 200);
    assert.equal(await closedWithin(live, 5000), true);
    await end(live);
    await assert.rejects(connect(victim.creds));
  });

  // ---------- 7. Restarts and many devices at once ----------
  console.log(`\nRestarts and ${N} devices`);
  const fleet: { id: string; creds: Creds }[] = [];
  for (let i = 0; i < N; i++) fleet.push(await newDevice(`Fleet ${i + 1}`, 15));
  const fleetIds = fleet.map((d) => `'${d.id}'`).join(',');
  const onlineCount = () => Number(sql(`SELECT count(*) FROM devices WHERE id IN (${fleetIds}) AND last_connected_at IS NOT NULL AND (last_disconnected_at IS NULL OR last_disconnected_at < last_connected_at)`));
  let sims: SimDevice[] = [];
  const allConnected = () => sims.every((s) => s.connected);

  await check(`${N} devices connect at the same moment`, async () => {
    sims = fleet.map((d) => new SimDevice(d.creds, { jitter: true }));
    const t0 = Date.now();
    await Promise.race([Promise.all(sims.map((s) => s.start())), sleep(120_000).then(() => { throw new Error(`${sims.filter((s) => s.connected).length}/${N} connected after 120 s`); })]);
    note('connect_all_ms', Date.now() - t0);
    note('connect_refusals', sims.reduce((n, s) => n + s.refusals, 0));
    await eventually(async () => onlineCount() === N, `${N} devices recorded online`, 60_000);
    note('emqx_memory_after_connect', docker('stats', '--no-stream', '--format', '{{.MemUsage}}', 'arc-cloud-emqx-1').trim());
  });

  const sendRound = async (round: number) => {
    await Promise.all(sims.map((s) => (s.client ? publish(s.client, s.creds.topics.telemetry, telemetry({ seq: round, temperature: 20 })) : undefined)));
  };
  const storedRound = (round: number) => Number(sql(`SELECT count(DISTINCT device_id) FROM telemetry_measurements WHERE device_id IN (${fleetIds}) AND metric_key = 'seq' AND metric_value = ${round}`));

  await check('worker restart: readings sent while the worker is down are stored when it is back (persistent session)', async () => {
    docker('stop', 'arc-cloud-worker-1');
    await sendRound(1001);
    await sleep(2000);
    docker('start', 'arc-cloud-worker-1');
    await eventually(async () => storedRound(1001) === N, `all ${N} readings from the outage stored`, 90_000, 2000);
  });

  await check('API restart: connected devices stay connected and keep storing data; the API reconnects to the broker', async () => {
    docker('restart', 'arc-cloud-api-1');
    await sleep(1000);
    assert.equal(allConnected(), true, 'devices were dropped by an API restart');
    await sendRound(1002);
    await eventually(async () => storedRound(1002) === N, 'readings stored while the API restarts', 60_000, 2000);
    await eventually(deepOk, '/health/deep after API restart', 120_000, 2000);
  });

  const brokerRestart = async (label: string, jitter: boolean) => {
    for (const s of sims) await s.stop();
    sims = fleet.map((d) => new SimDevice(d.creds, jitter ? { jitter: true } : { jitter: false, baseMs: 1000 }));
    await Promise.race([Promise.all(sims.map((s) => s.start())), sleep(120_000).then(() => { throw new Error('fleet did not connect before the restart'); })]);
    const t0 = Date.now();
    docker('restart', 'arc-cloud-emqx-1');
    const back = await eventually(async () => allConnected() && Date.now(), `${N} devices reconnected (${label})`, 300_000, 500);
    const refusals = sims.reduce((n, s) => n + s.refusals, 0);
    note(`${label}_reconnect_all_ms`, back - t0);
    note(`${label}_refused_attempts`, refusals);
    await eventually(deepOk, `API back on the broker (${label})`, 120_000, 2000);
    await eventually(async () => onlineCount() === N, `${N} devices recorded online (${label})`, 120_000, 2000);
    const round = jitter ? 1003 : 1004;
    await sendRound(round);
    await eventually(async () => storedRound(round) === N, `readings after the restart stored (${label})`, 60_000, 2000);
  };
  await check(`EMQX restart: ${N} devices reconnect with back-off and jitter (ArcCloud library behaviour), API and worker recover, data flows`, () => brokerRestart('jitter', true));
  await check(`EMQX restart: ${N} devices reconnect all at once, every second, no jitter (worst case)`, () => brokerRestart('herd', false));
  await check('after an EMQX restart, a device that never comes back is shown offline within interval × 3 + 30 s', async () => {
    const lost = await newDevice('Never returns', 10);
    const c = await connect(lost.creds);
    await publish(c, lost.creds.topics.telemetry, telemetry({ temperature: 5 }));
    await eventually(async () => (await status(t, lost.id)) === 'online', 'online');
    c.removeAllListeners();
    docker('restart', 'arc-cloud-emqx-1');
    c.end(true);
    await eventually(deepOk, 'API back on the broker', 120_000, 2000);
    const t0 = Date.now();
    await eventually(async () => (await status(t, lost.id)) === 'offline', 'offline', 90_000, 3000);
    note('lost_device_offline_after_ms', Date.now() - t0);
  });

  for (const s of sims) await s.stop();

  // ---------- Evidence ----------
  const failed = results.filter((r) => !r.ok);
  const when = new Date().toISOString();
  const emqxVersion = docker('exec', 'arc-cloud-emqx-1', 'emqx', 'ctl', 'broker').match(/version\s*:\s*(\S+)/)?.[1] ?? '?';
  const arch = docker('info', '--format', '{{.Architecture}}').trim();
  writeFileSync(resolve(OUT, 'results.json'), JSON.stringify({ when, emqxVersion, arch, devices: N, results, measurements }, null, 2));
  const md = [
    `# Production-stack test run, ${when}`,
    '',
    `EMQX ${emqxVersion} · ${arch} · ${N} simulated devices · ${results.length - failed.length}/${results.length} passed`,
    '',
    '| # | Check | Result | Time |',
    '|---|---|---|---|',
    ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? 'pass' : `**FAIL**: ${r.err?.replace(/\|/g, '/').slice(0, 300)}`} | ${(r.ms / 1000).toFixed(1)} s |`),
    '',
    '## Measurements',
    '',
    '| Measurement | Value |',
    '|---|---|',
    ...Object.entries(measurements).map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '/')} |`),
    '',
  ].join('\n');
  writeFileSync(resolve(OUT, 'results.md'), md);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
