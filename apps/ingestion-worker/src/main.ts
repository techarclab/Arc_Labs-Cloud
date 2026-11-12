import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { INGEST_PROBE_TOPIC, INGEST_SHARE_GROUP, INGEST_TOPIC_FILTERS, newConnectionCheck, pgConnectionConfig, SYS_CLIENT_EVENT_FILTERS } from '@arc/shared';
import mqtt from 'mqtt';
import { Pool } from 'pg';
import { loadConfig } from './config';
import { Jobs } from './jobs';
import { Counters, Processor, RateLimiter } from './processor';
import { SubscriptionWatchdog } from './watchdog';

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, svc: 'ingestion-worker', msg, ...extra }));

async function main() {
  const cfg = loadConfig();
  const pgConfig = pgConnectionConfig(cfg.DATABASE_URL, cfg.DATABASE_PASSWORD_FILE);
  const pool = new Pool({ ...pgConfig, max: 10 });
  // Readiness logs in afresh (cached 15 s): warm pooled connections hide refused logins (2026-10-31).
  const canOpenNewConnection = newConnectionCheck(pgConfig);
  const counters = new Counters();
  const processor = new Processor(pool, new RateLimiter(cfg.DEVICE_RATE_PER_SEC, cfg.DEVICE_BURST), counters, cfg.CACHE_TTL_SECONDS);

  const client = mqtt.connect(cfg.MQTT_URL, {
    protocolVersion: cfg.MQTT_PROTOCOL_VERSION,
    clientId: `svc-${cfg.WORKER_ID}`,
    username: cfg.MQTT_SERVICE_USERNAME,
    password: cfg.MQTT_SERVICE_PASSWORD,
    // Persistent session: QoS1 messages queued by the broker while we restart are delivered on reconnect.
    clean: false,
    properties: cfg.MQTT_PROTOCOL_VERSION === 5 ? { sessionExpiryInterval: 3600 } : undefined,
    reconnectPeriod: 2000,
    // Keep retrying after a refused CONNACK (e.g. the API that approves logins is restarting); mqtt.js otherwise
    // stops reconnecting for good and ingestion silently halts.
    reconnectOnConnackError: true,
    ca: cfg.MQTT_CA_FILE ? readFileSync(cfg.MQTT_CA_FILE) : undefined,
  });

  // At-least-once: the PUBACK is only sent after the message is persisted (or deliberately rejected).
  // If the database is down we do not ack, the broker redelivers, and messageId dedupe absorbs repeats.
  const watchdog = new SubscriptionWatchdog(cfg.PROBE_INTERVAL_SECONDS * 1000, cfg.PROBE_STALE_SECONDS * 1000);

  client.handleMessage = (packet, done) => {
    const started = Date.now();
    const topic = packet.topic;
    if (topic === INGEST_PROBE_TOPIC) {
      watchdog.onProbe(Date.now());
      return done();
    }
    const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
    const sys = /^\$SYS\/brokers\/[^/]+\/clients\/[^/]+\/(connected|disconnected)$/.exec(topic);
    const work = sys
      ? processor
          .clientEvent(sys[1] as 'connected' | 'disconnected', payload, (t, p) => client.publish(t, p, { qos: 1 }))
          .then(() => 'client_event')
      : processor.handle(topic, payload);
    work
      .then((outcome) => {
        counters.inc('arc_ingest_processing_ms_sum', Date.now() - started);
        counters.inc('arc_ingest_processed_total');
        if (outcome.startsWith('rejected')) log('warn', 'message rejected', { topic, outcome });
        done();
      })
      .catch((err) => {
        counters.inc('arc_ingest_errors_total');
        log('error', 'processing failed; message will be redelivered', { topic, error: String(err?.message ?? err) });
        // Withhold the ack and force a reconnect so the broker redelivers the unacked message.
        setTimeout(() => client.reconnect(), 1000);
      });
  };

  client.on('connect', (connack) => {
    log('info', 'connected to broker', { sessionPresent: connack.sessionPresent });
    watchdog.onConnect(Date.now());
    // After a forced fresh session (stall recovery), go back to a persistent session for later reconnects.
    client.options.clean = false;
    const filters = cfg.SHARED_SUBSCRIPTION ? INGEST_TOPIC_FILTERS.map((f) => `$share/${INGEST_SHARE_GROUP}/${f}`) : INGEST_TOPIC_FILTERS;
    const subs: Record<string, { qos: 0 | 1 }> = {};
    for (const f of filters) subs[f] = { qos: 1 };
    for (const f of SYS_CLIENT_EVENT_FILTERS) subs[f] = { qos: 0 };
    client.subscribe(subs, (err, granted) => {
      if (err) return log('error', 'subscribe failed', { error: err.message });
      const failed = (granted ?? []).filter((g) => g.qos > 2);
      if (failed.length) log('error', 'subscription denied by broker ACL', { topics: failed.map((g) => g.topic) });
      else log('info', 'subscribed', { topics: Object.keys(subs) });
    });
  });
  client.on('reconnect', () => log('info', 'reconnecting to broker'));
  client.on('error', (err) => log('error', 'mqtt error', { error: err.message }));
  client.on('close', () => {
    watchdog.onDisconnect();
    counters.inc('arc_ingest_disconnects_total');
  });

  // Subscription self-test (DEF-014). A probe goes out every interval; if none has come back through our own
  // subscription for PROBE_STALE_SECONDS while connected, the broker is no longer serving it: reconnect with a fresh
  // session so the subscriptions are created anew. Readiness reports the stall until then.
  const probe = setInterval(() => {
    const now = Date.now();
    if (watchdog.stalled(now)) {
      counters.inc('arc_ingest_stalls_total');
      log('error', 'subscription stalled: no probe received; reconnecting with a fresh session', { silentForMs: watchdog.silenceMs(now) });
      watchdog.onDisconnect();
      client.options.clean = true;
      client.reconnect();
      return;
    }
    if (client.connected) client.publish(INGEST_PROBE_TOPIC, JSON.stringify({ probe: cfg.WORKER_ID, ts: now }), { qos: 1 });
  }, cfg.PROBE_INTERVAL_SECONDS * 1000);
  probe.unref();

  // Rules, notifications, webhooks, command expiry, rollouts and retention.
  const jobs = new Jobs(pool, cfg, counters, log);
  if (cfg.JOBS_ENABLED) {
    await jobs.start();
    log('info', 'background jobs started', { email: cfg.SMTP_URL ? 'enabled' : 'not configured (SMTP_URL)' });
  }

  // Housekeeping: prune the idempotency table.
  const prune = setInterval(() => {
    processor
      .pruneDedupe(cfg.DEDUPE_WINDOW_HOURS)
      .then((n) => n && log('info', 'pruned dedupe rows', { rows: n }))
      .catch((err) => log('error', 'prune failed', { error: err.message }));
  }, 15 * 60 * 1000);

  // Health + Prometheus-style metrics.
  const health = createServer(async (req, res) => {
    if (req.url === '/health/live') return res.writeHead(200).end('ok');
    if (req.url === '/health/ready') {
      const dbOk = await canOpenNewConnection();
      const stalled = watchdog.stalled(Date.now());
      const ok = dbOk && client.connected && !stalled;
      return res
        .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ db: dbOk, mqtt: client.connected, subscription: stalled ? 'stalled' : 'ok' }));
    }
    if (req.url === '/metrics') {
      return res
        .writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        .end(
          counters.toPrometheus() +
            `arc_ingest_mqtt_connected ${client.connected ? 1 : 0}\n` +
            `arc_ingest_probe_silence_seconds ${Math.round(watchdog.silenceMs(Date.now()) / 1000)}\n`,
        );
    }
    res.writeHead(404).end();
  });
  health.listen(cfg.HEALTH_PORT, () => log('info', 'health server listening', { port: cfg.HEALTH_PORT }));

  const shutdown = async (signal: string) => {
    log('info', 'shutting down', { signal });
    clearInterval(prune);
    clearInterval(probe);
    await jobs.stop();
    health.close();
    await new Promise<void>((r) => client.end(false, {}, () => r()));
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log('fatal', 'worker failed to start', { error: String(err?.message ?? err) });
  process.exit(1);
});
