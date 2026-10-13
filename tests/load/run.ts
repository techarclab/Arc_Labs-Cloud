/**
 * Load test: N simulated devices publishing over MQTT through the real API + worker.
 *
 *   DATABASE_URL=postgres://…/empty_db LOAD_DEVICES=200 LOAD_RATE=1 LOAD_SECONDS=60 npm run test:load
 *
 * Reports ingest throughput, end-to-end latency (device timestamp → stored) and rejects,
 * and writes the result to docs/operations/load-test-results.md.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChildProcess } from 'node:child_process';
import { MqttClient } from 'mqtt';
import { API, BROKER_PORT, connectDevice, DB, http, ROOT, SECRETS, sleep, spawnSvc, startBroker, waitFor } from '../e2e/harness';

const DEVICES = Number(process.env.LOAD_DEVICES ?? 100);
const RATE = Number(process.env.LOAD_RATE ?? 1); // messages per device per second
const SECONDS = Number(process.env.LOAD_SECONDS ?? 30);

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

async function main() {
  const procs: ChildProcess[] = [];
  const { server, broker } = await startBroker();
  const clients: MqttClient[] = [];
  try {
    procs.push(
      spawnSvc('api', 'apps/api/dist/main.js', {
        ...SECRETS, DATABASE_URL: DB!, PORT: '3100', INTERNAL_PORT: '3101', RUN_MIGRATIONS: 'true',
        MQTT_PUBLIC_HOST: '127.0.0.1', MQTT_PUBLIC_PORT: String(BROKER_PORT), NODE_ENV: 'test',
      }),
    );
    await waitFor(async () => (await fetch(`${API}/health/ready`)).ok, 'API');
    procs.push(
      spawnSvc('worker', 'apps/ingestion-worker/dist/main.js', {
        DATABASE_URL: DB!, MQTT_URL: `mqtt://127.0.0.1:${BROKER_PORT}`, MQTT_PROTOCOL_VERSION: '4', SHARED_SUBSCRIPTION: 'false',
        MQTT_SERVICE_PASSWORD: SECRETS.MQTT_SERVICE_PASSWORD, HEALTH_PORT: '19100',
      }),
    );
    await waitFor(async () => (await fetch('http://127.0.0.1:19100/health/ready')).ok, 'worker');

    const u = await http('POST', '/api/v1/auth/register', undefined, { email: `load-${Date.now()}@arclabs.test`, displayName: 'Load', password: 'load-test-password-123' });
    const t = u.body.accessToken;
    const org = (await http('POST', '/api/v1/organizations', t, { name: 'Load test', slug: `load-${Date.now()}` })).body;
    await sql(`UPDATE organizations SET plan = 'enterprise', max_devices = 100000 WHERE id = $1`, [org.id]);
    const proj = (await http('POST', '/api/v1/projects', t, { organizationId: org.id, name: 'Load' })).body;
    await http('PUT', `/api/v1/projects/${proj.id}/fields`, t, { metrics: [{ metricKey: 'temperatureC', label: 'T', minValue: -50, maxValue: 150 }, { metricKey: 'humidityPct', label: 'H', minValue: 0, maxValue: 100 }] });
    await http('POST', '/api/v1/rules', t, { projectId: proj.id, name: 'Hot', ruleType: 'threshold', metricKey: 'temperatureC', operator: '>', threshold: 99 });

    console.log(`Provisioning ${DEVICES} devices…`);
    const creds: any[] = [];
    for (let i = 0; i < DEVICES; i++) {
      creds.push((await http('POST', '/api/v1/devices', t, { projectId: proj.id, displayName: `Load ${i + 1}`, expectedIntervalSeconds: Math.max(1, Math.round(1 / RATE)) })).body.credentials);
    }
    console.log('Connecting…');
    const c0 = Date.now();
    for (let i = 0; i < creds.length; i += 25) clients.push(...(await Promise.all(creds.slice(i, i + 25).map((c) => connectDevice(c)))));
    const connectSecs = (Date.now() - c0) / 1000;

    console.log(`Publishing ${RATE}/s per device for ${SECONDS}s…`);
    let sent = 0;
    const started = Date.now();
    const timers = clients.map((c, i) =>
      setInterval(() => {
        const msg = { schemaVersion: 1, messageId: randomUUID(), timestamp: new Date().toISOString(), metrics: { temperatureC: 20 + Math.random() * 10, humidityPct: 40 + Math.random() * 20 } };
        c.publish(creds[i].topics.telemetry, JSON.stringify(msg), { qos: 1 });
        sent++;
      }, 1000 / RATE),
    );
    await sleep(SECONDS * 1000);
    timers.forEach(clearInterval);
    const publishSecs = (Date.now() - started) / 1000;

    // Drain: wait until stored count stops changing.
    let stored = 0;
    for (let i = 0; i < 60; i++) {
      const n = (await sql('SELECT count(DISTINCT message_id)::int AS n FROM telemetry_measurements WHERE project_id = $1', [proj.id]))[0].n;
      if (n >= sent || (i > 3 && n === stored)) {
        stored = n;
        break;
      }
      stored = n;
      await sleep(1000);
    }
    const lat = (
      await sql(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
                percentile_cont(0.99) WITHIN GROUP (ORDER BY ms) AS p99, max(ms) AS max,
                min(received_at) AS first, max(received_at) AS last
         FROM (SELECT DISTINCT ON (message_id) message_id, received_at, extract(epoch FROM (received_at - ts)) * 1000 AS ms
               FROM telemetry_measurements WHERE project_id = $1) s`,
        [proj.id],
      )
    )[0];
    const rejected = (await sql('SELECT count(*)::int AS n FROM rejected_messages WHERE organization_id = $1', [org.id]))[0].n;
    const ingestSecs = (new Date(lat.last).getTime() - new Date(lat.first).getTime()) / 1000;
    const metrics = await (await fetch('http://127.0.0.1:19100/metrics')).text();
    const errors = /arc_ingest_errors_total (\d+)/.exec(metrics)?.[1] ?? '0';

    const report = {
      date: new Date().toISOString(),
      devices: DEVICES,
      ratePerDevice: RATE,
      seconds: SECONDS,
      connectSeconds: connectSecs.toFixed(1),
      sent,
      stored,
      lost: sent - stored,
      rejected,
      processingErrors: Number(errors),
      throughputPerSec: (stored / Math.max(ingestSecs, publishSecs)).toFixed(1),
      latencyMs: { p50: Math.round(lat.p50), p95: Math.round(lat.p95), p99: Math.round(lat.p99), max: Math.round(lat.max) },
    };
    console.log(JSON.stringify(report, null, 2));
    const dir = resolve(ROOT, 'docs/operations');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = resolve(dir, 'load-test-results.md');
    if (!existsSync(file)) {
      writeFileSync(
        file,
        '# Load test results\n\nProduced by `npm run test:load` (tests/load/run.ts): real API + ingestion worker + PostgreSQL, devices over MQTT through a broker that calls the same auth/ACL hooks as EMQX. Latency is device timestamp → row stored.\n\n| Date (UTC) | Devices | Msg/s per device | Duration | Sent | Stored | Lost | Rejected | Throughput (msg/s) | p50 | p95 | p99 | max |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n',
      );
    }
    const L = report.latencyMs;
    appendFileSync(file, `| ${report.date.slice(0, 16).replace('T', ' ')} | ${DEVICES} | ${RATE} | ${SECONDS}s | ${sent} | ${stored} | ${report.lost} | ${rejected} | ${report.throughputPerSec} | ${L.p50} ms | ${L.p95} ms | ${L.p99} ms | ${L.max} ms |\n`);
    const pass = report.lost === 0 && rejected === 0 && report.processingErrors === 0;
    console.log(pass ? 'PASS: no messages lost or rejected' : 'FAIL: see numbers above');
    process.exitCode = pass ? 0 : 1;
  } finally {
    for (const c of clients) c.end(true);
    for (const p of procs) p.kill('SIGTERM');
    await new Promise((r) => broker.close(() => r(null)));
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
