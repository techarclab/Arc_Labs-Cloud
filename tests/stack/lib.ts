/**
 * Helpers for the production-stack tests (tests/stack/run.ts). Everything goes through the public surfaces only,
 * as a customer or a device would: HTTPS through Caddy, MQTT over TLS on 8883. The one exception is test setup
 * that has no public path (confirming an email address): a psql command in the PostgreSQL container.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mqtt, { IClientOptions, MqttClient } from 'mqtt';

export const ROOT = resolve(__dirname, '../..');
export const OUT = resolve(ROOT, 'tests/stack/out');
export const API_HOST = 'api.arc.test';
export const MQTT_HOST = 'mqtt.arc.test';
export const API = `https://${API_HOST}`;
export const CA = readFileSync(resolve(OUT, 'ca.crt'));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTPS API (through Caddy, which sets the 300 requests/min/IP limit; stay under it) ----------
let lastCall = 0;
const MIN_GAP_MS = 220; // ≈ 270 requests/min

export async function http(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(API + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 6) {
      await sleep(10_000);
      continue;
    }
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

export async function eventually<T>(fn: () => Promise<T | false | undefined | null>, what: string, timeoutMs = 30_000, everyMs = 1000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
}

// ---------- Docker (the stack's containers, named by docker compose project "arc-cloud") ----------
export function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Test setup only: SQL as the PostgreSQL superuser inside the container (no published port, as in production). */
export function sql(statement: string): string {
  return docker('exec', '-u', 'postgres', 'arc-cloud-postgres-1', 'psql', '-d', 'arc_cloud', '-v', 'ON_ERROR_STOP=1', '-tAc', statement).trim();
}

// ---------- MQTT over TLS ----------
export interface Creds {
  clientId: string;
  username: string;
  password: string;
  /** As returned by POST /api/v1/devices (credentials.topics). */
  topics: { telemetry: string; state: string; commands: string; commandAcks: string };
}

export function mqttOptions(creds: Partial<Creds>, extra: IClientOptions = {}): IClientOptions {
  return {
    host: MQTT_HOST,
    port: 8883,
    protocol: 'mqtts',
    ca: CA,
    servername: MQTT_HOST,
    rejectUnauthorized: true,
    protocolVersion: 4,
    clientId: creds.clientId,
    username: creds.username,
    password: creds.password,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
    ...extra,
  };
}

/** Connects once; rejects with the broker's refusal (CONNACK code) or a network error. */
export function connect(creds: Partial<Creds>, extra: IClientOptions = {}): Promise<MqttClient> {
  return new Promise((resolveP, reject) => {
    const c = mqtt.connect(mqttOptions(creds, extra));
    const fail = (e: Error) => {
      c.end(true);
      reject(e);
    };
    c.once('connect', () => resolveP(c));
    c.once('error', fail);
    c.once('close', () => fail(new Error('connection closed before CONNACK')));
  });
}

/** Resolves when the broker closes the connection (EMQX `deny_action = disconnect`), or false after `ms`. */
export function closedWithin(c: MqttClient, ms: number): Promise<boolean> {
  return new Promise((r) => {
    if (!c.connected) return r(true);
    const t = setTimeout(() => r(false), ms);
    c.once('close', () => {
      clearTimeout(t);
      r(true);
    });
  });
}

export const end = (c: MqttClient | null | undefined) => new Promise<void>((r) => (c ? c.end(true, {}, () => r()) : r()));

export const publish = (c: MqttClient, topic: string, payload: unknown, opts: mqtt.IClientPublishOptions = {}) =>
  new Promise<void>((r, j) => c.publish(topic, typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload), { qos: 1, ...opts }, (e) => (e ? j(e) : r())));

export const subscribe = (c: MqttClient, topic: string) =>
  new Promise<number>((r, j) => c.subscribe(topic, { qos: 1 }, (e, granted) => (e ? j(e) : r(granted?.[0]?.qos ?? -1))));

let seq = 0;
export const telemetry = (metrics: Record<string, number>) => ({
  schemaVersion: 1,
  messageId: `stack-${process.pid}-${++seq}`,
  timestamp: new Date().toISOString(),
  metrics,
});

/**
 * A simulated board that reconnects by itself the way the ArcCloud library does (back-off with jitter), or all at
 * the same instant when `jitter` is false (worst case: firmware without jitter after a broker restart).
 */
export class SimDevice {
  client: MqttClient | null = null;
  connects = 0;
  refusals = 0;
  lastConnectedAt = 0;
  readonly controls: { field: string; value: number }[] = [];
  private stopped = false;
  private failures = 0;

  constructor(readonly creds: Creds, private readonly opts: { jitter: boolean; baseMs?: number; maxMs?: number } = { jitter: true }) {}

  start(): Promise<void> {
    this.stopped = false;
    return new Promise((resolveFirst) => {
      const attempt = () => {
        if (this.stopped) return;
        const c = mqtt.connect(mqttOptions(this.creds));
        let opened = false;
        c.on('connect', () => {
          opened = true;
          this.client = c;
          this.connects++;
          this.failures = 0;
          this.lastConnectedAt = Date.now();
          c.subscribe(this.creds.topics.commands, { qos: 1 });
          resolveFirst();
        });
        c.on('message', (_t, buf) => {
          try {
            const m = JSON.parse(buf.toString());
            if (typeof m.field === 'string') this.controls.push({ field: m.field, value: m.value });
          } catch {
            /* not JSON: ignore */
          }
        });
        c.on('error', () => undefined);
        c.on('close', () => {
          if (this.client === c) this.client = null;
          if (!opened) this.refusals++;
          c.removeAllListeners();
          c.end(true);
          if (this.stopped) return;
          this.failures++;
          setTimeout(attempt, this.delay());
        });
      };
      attempt();
    });
  }

  private delay(): number {
    const base = this.opts.baseMs ?? 1000;
    const max = this.opts.maxMs ?? 30_000;
    if (!this.opts.jitter) return base;
    const exp = Math.min(max, base * 2 ** Math.min(this.failures - 1, 10));
    return exp / 2 + Math.random() * (exp / 2);
  }

  get connected() {
    return !!this.client?.connected;
  }

  async stop() {
    this.stopped = true;
    await end(this.client);
    this.client = null;
  }
}
