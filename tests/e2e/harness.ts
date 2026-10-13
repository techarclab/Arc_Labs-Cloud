/**
 * Shared test harness (e2e + load): starts the real API and worker against DATABASE_URL with an
 * in-process Aedes broker wired to the same /internal/mqtt hooks EMQX uses.
 * Originally from the end-to-end check of the V1 data path without Docker:
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

export const ROOT = resolve(__dirname, '../..');
export const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL (an empty database) is required');

export const API = 'http://127.0.0.1:3100';
export const HOOKS = 'http://127.0.0.1:3101';
export const BROKER_PORT = 18830;
export const SECRETS = {
  JWT_SECRET: 'e2e-jwt-secret-0123456789abcdef0123456789',
  INTERNAL_HOOK_TOKEN: 'e2e-internal-hook-token-0123456789',
  MQTT_SERVICE_PASSWORD: 'e2e-service-password-0123456789',
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function http(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function hook(path: string, body: unknown) {
  const res = await fetch(HOOKS + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': SECRETS.INTERNAL_HOOK_TOKEN },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { result: string };
}

export function spawnSvc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const p = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d: Buffer) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`);
  p.stdout!.on('data', out);
  p.stderr!.on('data', (d) => process.stdout.write(`[${name}:err] ${d}`));
  return p;
}

export async function waitFor(fn: () => Promise<boolean>, what: string, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function startBroker(): Promise<{ server: Server; broker: Aedes }> {
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

export function connectDevice(creds: { clientId: string; username: string; password: string }): Promise<MqttClient> {
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

export const pub = (c: MqttClient, topic: string, payload: unknown) =>
  new Promise<void>((r, j) => c.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { qos: 1 }, (e) => (e ? j(e) : r())));

export const telemetry = (metrics: Record<string, unknown>, messageId = randomUUID()) => ({
  schemaVersion: 1,
  messageId,
  timestamp: new Date().toISOString(),
  metrics,
  metadata: { firmwareVersion: '1.0.0' },
});

