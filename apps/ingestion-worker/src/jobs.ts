import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { compare, computeConnectivity, decide, Operator } from '@arc/shared';
import nodemailer, { Transporter } from 'nodemailer';
import { Pool, PoolClient } from 'pg';
import type { WorkerConfig } from './config';
import type { Counters } from './processor';

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/** Webhook/email retry schedule (seconds after each failed attempt). */
export const BACKOFF = [30, 120, 600, 1800, 7200, 21600];

export function signWebhook(secret: string, body: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function isPrivate(addr: string) {
  return (
    /^(10\.|127\.|169\.254\.|192\.168\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(addr) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(addr) ||
    /^(::1|fc|fd|fe80)/i.test(addr)
  );
}

const fmtDuration = (s: number) => (s >= 3600 ? `${Math.round(s / 360) / 10} h` : s >= 60 ? `${Math.round(s / 6) / 10} min` : `${s} s`);

function alertJson(a: any) {
  return {
    id: a.id,
    organizationId: a.organization_id,
    projectId: a.project_id,
    deviceId: a.device_id,
    ruleId: a.rule_id,
    ruleName: a.rule_name,
    ruleType: a.rule_type,
    severity: a.severity,
    status: a.status,
    message: a.message,
    value: a.value,
    triggeredAt: a.triggered_at,
    resolvedAt: a.resolved_at,
    resolution: a.resolution,
  };
}

/**
 * Background jobs that run inside the worker process:
 * rules evaluation, notification/webhook delivery, command expiry, OTA rollout tracking
 * and data retention. Each job holds a Postgres advisory lock while it runs, so several
 * worker replicas never do the same job twice.
 */
export class Jobs {
  private timers: NodeJS.Timeout[] = [];
  private listener: PoolClient | null = null;
  private pendingProjects = new Set<string>();
  private pendingTimer: NodeJS.Timeout | null = null;
  private mailer: Transporter | null = null;
  stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: WorkerConfig,
    private readonly counters: Counters,
    private readonly log: Log,
  ) {
    if (cfg.SMTP_URL) this.mailer = nodemailer.createTransport(cfg.SMTP_URL);
  }

  async start() {
    this.every('rules', this.cfg.RULES_INTERVAL_SECONDS * 1000, () => this.evaluateRules());
    const c = this.cfg;
    this.every('deliveries', c.DELIVERIES_INTERVAL_SECONDS * 1000, () => this.deliver());
    this.every('commands', c.COMMANDS_INTERVAL_SECONDS * 1000, () => this.expireCommands());
    this.every('rollouts', c.ROLLOUTS_INTERVAL_SECONDS * 1000, () => this.trackRollouts());
    this.every('retention', c.RETENTION_INTERVAL_SECONDS * 1000, () => this.retention(), Math.min(60_000, c.RETENTION_INTERVAL_SECONDS * 1000));
    await this.listen();
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.listener) {
      this.listener.release();
      this.listener = null;
    }
  }

  /** Telemetry from either path (MQTT worker, HTTP API) wakes the rules engine for that channel. */
  private async listen() {
    try {
      const c = await this.pool.connect();
      this.listener = c;
      c.on('notification', (n) => {
        if (n.channel !== 'arc_telemetry' || !n.payload) return;
        this.pendingProjects.add(n.payload);
        this.pendingTimer ??= setTimeout(() => {
          this.pendingTimer = null;
          const projects = [...this.pendingProjects];
          this.pendingProjects.clear();
          void this.locked('rules', () => this.evaluateRules(projects)).catch((e) => this.log('error', 'rules (notify) failed', { error: e.message }));
        }, 500);
      });
      c.on('error', (e) => this.log('warn', 'listener connection lost', { error: e.message }));
      await c.query('LISTEN arc_telemetry');
    } catch (e: any) {
      this.log('warn', 'LISTEN failed; rules run on the timer only', { error: e.message });
    }
  }

  private every(name: string, ms: number, fn: () => Promise<unknown>, firstDelay = 1000) {
    const run = () => {
      if (this.stopped) return;
      void this.locked(name, fn).catch((e) => {
        this.counters.inc(`arc_jobs_errors_total|${name}`);
        this.log('error', `job ${name} failed`, { error: e.message });
      });
    };
    setTimeout(run, firstDelay);
    this.timers.push(setInterval(run, ms));
  }

  /** Runs fn while holding a cluster-wide advisory lock for `name`; skips if another worker has it. */
  async locked<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const c = await this.pool.connect();
    try {
      const got = (await c.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`arc-job:${name}`])).rows[0].ok;
      if (!got) return undefined;
      try {
        return await fn();
      } finally {
        await c.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`arc-job:${name}`]).catch(() => undefined);
      }
    } finally {
      c.release();
    }
  }

  // =====================================================================================
  // Rules engine
  // =====================================================================================

  async evaluateRules(projectIds?: string[]): Promise<number> {
    const rules = (
      await this.pool.query(
        `SELECT r.*, p.name AS project_name FROM alert_rules r JOIN projects p ON p.id = r.project_id
         WHERE r.enabled AND ($1::uuid[] IS NULL OR r.project_id = ANY($1))`,
        [projectIds ?? null],
      )
    ).rows;
    let actions = 0;
    const now = new Date();
    for (const rule of rules) {
      const devices = (
        await this.pool.query(
          `SELECT id, display_name, organization_id, project_id, lifecycle_status, last_seen_at, last_connected_at, last_disconnected_at, expected_interval_seconds
           FROM devices WHERE project_id = $1 AND ($2::uuid IS NULL OR id = $2) AND lifecycle_status IN ('provisioned', 'active', 'maintenance')`,
          [rule.project_id, rule.device_id],
        )
      ).rows;
      if (!devices.length) continue;

      // Current condition per device.
      const observed = new Map<string, { breached: boolean; value: number | null; message: string } | null>();
      if (rule.rule_type === 'threshold') {
        const latest = (
          await this.pool.query(
            `SELECT DISTINCT ON (device_id) device_id, metric_value, ts FROM telemetry_measurements
             WHERE project_id = $1 AND metric_key = $2 AND ts > now() - interval '1 day' AND device_id = ANY($3)
             ORDER BY device_id, ts DESC`,
            [rule.project_id, rule.metric_key, devices.map((d) => d.id)],
          )
        ).rows;
        const byDevice = new Map(latest.map((l) => [l.device_id, l]));
        const def = (
          await this.pool.query('SELECT label, unit FROM metric_definitions WHERE project_id = $1 AND metric_key = $2', [rule.project_id, rule.metric_key])
        ).rows[0] as { label: string | null; unit: string | null } | undefined;
        const name = def?.label || rule.metric_key;
        const unit = def?.unit ? ` ${def.unit}` : '';
        for (const d of devices) {
          const l = byDevice.get(d.id);
          if (!l) {
            observed.set(d.id, null); // no recent data: leave the alert state as it is
            continue;
          }
          const v = Number(l.metric_value);
          observed.set(d.id, {
            breached: compare(v, rule.operator as Operator, Number(rule.threshold)),
            value: v,
            message: `${name} is ${v}${unit} (alert when ${rule.operator} ${Number(rule.threshold)}${unit})`,
          });
        }
      } else {
        for (const d of devices) {
          if (!d.last_seen_at && !d.last_connected_at) {
            observed.set(d.id, null); // never reported: nothing to compare yet
            continue;
          }
          if (rule.rule_type === 'stale') {
            // Connected but no reading yet: count from the connection, not "forever".
            const since = d.last_seen_at ?? d.last_connected_at;
            const ageS = since ? Math.round((now.getTime() - new Date(since).getTime()) / 1000) : Infinity;
            observed.set(d.id, { breached: ageS > rule.stale_seconds, value: Number.isFinite(ageS) ? ageS : null, message: `No data for ${Number.isFinite(ageS) ? fmtDuration(ageS) : 'a long time'} (limit ${fmtDuration(rule.stale_seconds)})` });
          } else {
            const c = computeConnectivity({
              now,
              lastSeenAt: d.last_seen_at,
              lastConnectedAt: d.last_connected_at,
              lastDisconnectedAt: d.last_disconnected_at,
              expectedIntervalSeconds: d.expected_interval_seconds,
            });
            observed.set(d.id, { breached: c.status === 'offline', value: null, message: c.source === 'broker_event' ? 'Device disconnected from the broker' : 'Device stopped reporting' });
          }
        }
      }

      const active = new Map(
        (await this.pool.query(`SELECT * FROM alerts WHERE rule_id = $1 AND status <> 'resolved'`, [rule.id])).rows.map((a) => [a.device_id, a]),
      );
      const lastResolved = new Map(
        (
          await this.pool.query(`SELECT device_id, max(resolved_at) AS at FROM alerts WHERE rule_id = $1 AND status = 'resolved' GROUP BY device_id`, [rule.id])
        ).rows.map((r) => [r.device_id, new Date(r.at)]),
      );
      const states = new Map(
        (await this.pool.query('SELECT device_id, breach_since FROM alert_rule_state WHERE rule_id = $1', [rule.id])).rows.map((s) => [s.device_id, new Date(s.breach_since)]),
      );

      for (const d of devices) {
        const o = observed.get(d.id);
        if (!o) continue;
        const decision = decide({
          breached: o.breached,
          hasActiveAlert: active.has(d.id),
          breachSince: states.get(d.id) ?? null,
          forSeconds: rule.for_seconds,
          lastResolvedAt: lastResolved.get(d.id) ?? null,
          cooldownSeconds: rule.cooldown_seconds,
          now,
        });
        if (!o.breached && states.has(d.id)) await this.pool.query('DELETE FROM alert_rule_state WHERE rule_id = $1 AND device_id = $2', [rule.id, d.id]);
        if (decision === 'pending' && !states.has(d.id)) {
          await this.pool.query('INSERT INTO alert_rule_state (rule_id, device_id, breach_since) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [rule.id, d.id, now]);
        } else if (decision === 'trigger') {
          if (await this.trigger(rule, d, o)) actions++;
        } else if (decision === 'resolve') {
          if (await this.recover(rule, active.get(d.id), d)) actions++;
        }
      }
    }
    this.counters.inc('arc_rules_evaluations_total');
    return actions;
  }

  private async trigger(rule: any, device: any, o: { value: number | null; message: string }): Promise<boolean> {
    return this.tx(async (c) => {
      const a = (
        await c.query(
          `INSERT INTO alerts (organization_id, project_id, device_id, rule_id, rule_name, rule_type, severity, message, value)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING *`,
          [rule.organization_id, rule.project_id, device.id, rule.id, rule.name, rule.rule_type, rule.severity, o.message, o.value],
        )
      ).rows[0];
      await c.query('DELETE FROM alert_rule_state WHERE rule_id = $1 AND device_id = $2', [rule.id, device.id]);
      if (!a) return false; // another evaluation already opened it (deduplication)
      await c.query(`INSERT INTO alert_events (alert_id, event, actor_type, note) VALUES ($1, 'triggered', 'system', $2)`, [a.id, o.message]);
      await c.query('SELECT arc_emit_event($1, $2, $3)', [a.organization_id, 'alert.triggered', JSON.stringify({ ...alertJson(a), deviceName: device.display_name, projectName: rule.project_name })]);
      await this.queueEmails(c, rule, a, device, 'triggered');
      this.counters.inc('arc_alerts_triggered_total');
      return true;
    });
  }

  private async recover(rule: any, alert: any, device: any): Promise<boolean> {
    if (!alert) return false;
    return this.tx(async (c) => {
      const a = (
        await c.query(
          `UPDATE alerts SET status = 'resolved', resolved_at = now(), resolution = 'recovered', updated_at = now() WHERE id = $1 AND status <> 'resolved' RETURNING *`,
          [alert.id],
        )
      ).rows[0];
      if (!a) return false;
      await c.query(`INSERT INTO alert_events (alert_id, event, actor_type, note) VALUES ($1, 'resolved', 'system', 'Condition cleared')`, [a.id]);
      await c.query('SELECT arc_emit_event($1, $2, $3)', [a.organization_id, 'alert.resolved', JSON.stringify({ ...alertJson(a), deviceName: device.display_name, projectName: rule.project_name })]);
      await this.queueEmails(c, rule, a, device, 'resolved');
      this.counters.inc('arc_alerts_recovered_total');
      return true;
    });
  }

  private async queueEmails(c: PoolClient, rule: any, a: any, device: any, kind: 'triggered' | 'resolved') {
    if (!rule.notify_emails?.length) return;
    const link = this.cfg.CONSOLE_URL ? `${this.cfg.CONSOLE_URL.replace(/\/+$/, '')}/o/${a.organization_id}/alerts/${a.id}` : '';
    const subject =
      kind === 'triggered'
        ? `[ARC Cloud] ${a.severity.toUpperCase()}: ${rule.name} — ${device.display_name}`
        : `[ARC Cloud] Resolved: ${rule.name} — ${device.display_name}`;
    const text = [
      kind === 'triggered' ? `Alert "${rule.name}" triggered for ${device.display_name} (${rule.project_name}).` : `Alert "${rule.name}" for ${device.display_name} recovered.`,
      '',
      a.message,
      `Time: ${new Date(kind === 'triggered' ? a.triggered_at : a.resolved_at).toISOString()}`,
      link ? `\nOpen: ${link}` : '',
    ].join('\n');
    for (const to of rule.notify_emails) {
      await c.query(
        `INSERT INTO deliveries (organization_id, kind, alert_id, recipient, event_type, payload) VALUES ($1, 'email', $2, $3, $4, $5)`,
        [a.organization_id, a.id, to, `alert.${kind}`, { subject, text }],
      );
    }
  }

  // =====================================================================================
  // Deliveries (email + webhooks) with retries
  // =====================================================================================

  async deliver(): Promise<number> {
    // Lease a batch: due rows get a 2-minute lease so a crash doesn't lose them.
    const batch = (
      await this.pool.query(
        `UPDATE deliveries SET next_attempt_at = now() + interval '2 minutes', attempts = attempts + 1
         WHERE id IN (SELECT id FROM deliveries WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 25 FOR UPDATE SKIP LOCKED)
         RETURNING deliveries.*, (SELECT secret FROM webhooks w WHERE w.id = deliveries.webhook_id) AS secret`,
      )
    ).rows;
    await Promise.all(batch.map((d) => this.deliverOne(d)));
    return batch.length;
  }

  private async deliverOne(d: any) {
    let ok = false;
    let code: number | null = null;
    let error: string | null = null;
    let skipped = false;
    try {
      if (d.kind === 'email') {
        if (!this.mailer) {
          skipped = true;
          error = 'Email is not set up on this server (SMTP_URL).';
        } else {
          await this.mailer.sendMail({ from: this.cfg.MAIL_FROM, to: d.recipient, subject: d.payload.subject, text: d.payload.text });
          ok = true;
        }
      } else {
        const body = JSON.stringify(d.payload);
        const url = new URL(d.recipient);
        if (!this.cfg.ALLOW_PRIVATE_WEBHOOKS) {
          const host = url.hostname.replace(/^\[|\]$/g, '');
          const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
          if (addrs.some(isPrivate)) throw new Error('refusing to call a private network address');
        }
        const ts = Math.floor(Date.now() / 1000);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'ARC-Cloud-Webhooks/1.0',
            'x-arc-event': d.event_type,
            'x-arc-delivery': String(d.id),
            'x-arc-signature': `t=${ts},v1=${signWebhook(d.secret ?? '', body, ts)}`,
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        code = res.status;
        ok = res.status >= 200 && res.status < 300;
        if (!ok) error = `HTTP ${res.status}`;
        await res.body?.cancel().catch(() => undefined);
      }
    } catch (e: any) {
      error = String(e?.cause?.code ?? e?.message ?? e).slice(0, 300);
    }

    if (ok) {
      await this.pool.query(`UPDATE deliveries SET status = 'sent', sent_at = now(), response_code = $2, last_error = NULL WHERE id = $1`, [d.id, code]);
      if (d.webhook_id) await this.pool.query('UPDATE webhooks SET last_success_at = now(), consecutive_failures = 0 WHERE id = $1', [d.webhook_id]);
      if (d.alert_id) await this.pool.query(`INSERT INTO alert_events (alert_id, event, actor_type, note) VALUES ($1, 'notified', 'system', $2)`, [d.alert_id, `${d.kind} → ${d.recipient}`]);
      this.counters.inc(`arc_deliveries_sent_total|${d.kind}`);
      return;
    }
    if (skipped) {
      await this.pool.query(`UPDATE deliveries SET status = 'skipped', last_error = $2 WHERE id = $1`, [d.id, error]);
      this.counters.inc(`arc_deliveries_skipped_total|${d.kind}`);
      return;
    }
    const final = d.attempts >= BACKOFF.length + 1;
    await this.pool.query(
      `UPDATE deliveries SET status = $2, last_error = $3, response_code = $4, next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1`,
      [d.id, final ? 'failed' : 'pending', error, code, BACKOFF[Math.min(d.attempts - 1, BACKOFF.length - 1)]],
    );
    if (d.webhook_id) await this.pool.query('UPDATE webhooks SET last_failure_at = now(), consecutive_failures = consecutive_failures + 1 WHERE id = $1', [d.webhook_id]);
    this.counters.inc(`arc_deliveries_${final ? 'failed' : 'retried'}_total|${d.kind}`);
    if (final) this.log('warn', 'delivery failed permanently', { id: d.id, kind: d.kind, error });
  }

  // =====================================================================================
  // Commands & OTA rollouts
  // =====================================================================================

  async expireCommands(): Promise<number> {
    const rows = (
      await this.pool.query(
        `UPDATE commands SET status = 'expired', completed_at = now() WHERE status IN ('queued', 'published') AND expires_at <= now() RETURNING *`,
      )
    ).rows;
    for (const r of rows) {
      await this.pool.query('SELECT arc_emit_event($1, $2, $3)', [
        r.organization_id,
        'command.updated',
        JSON.stringify({ id: r.id, deviceId: r.device_id, name: r.name, status: r.status, expiresAt: r.expires_at }),
      ]);
    }
    if (rows.length) this.counters.inc('arc_commands_expired_total', rows.length);
    return rows.length;
  }

  async trackRollouts(): Promise<number> {
    let changed = 0;
    changed += (
      await this.pool.query(
        `UPDATE firmware_rollout_devices rd SET status = 'succeeded', detail = 'now on ' || r.version, updated_at = now()
         FROM firmware_rollouts o, firmware_releases r, devices d
         WHERE rd.rollout_id = o.id AND r.id = o.release_id AND d.id = rd.device_id AND rd.status IN ('pending', 'sent') AND d.firmware_version = r.version`,
      )
    ).rowCount ?? 0;
    changed += (
      await this.pool.query(
        `UPDATE firmware_rollout_devices rd SET status = 'failed', detail = c.status || COALESCE(': ' || c.error, ''), updated_at = now()
         FROM commands c WHERE c.id = rd.command_id AND rd.status = 'sent' AND c.status IN ('failed', 'expired')`,
      )
    ).rowCount ?? 0;
    // Acknowledged but the device never reported the new version within 30 minutes → failed.
    changed += (
      await this.pool.query(
        `UPDATE firmware_rollout_devices rd SET status = 'failed', detail = 'device did not report the new version', updated_at = now()
         FROM commands c WHERE c.id = rd.command_id AND rd.status = 'sent' AND c.status = 'acknowledged' AND c.completed_at < now() - interval '30 minutes'`,
      )
    ).rowCount ?? 0;
    const done = (
      await this.pool.query(
        `UPDATE firmware_rollouts o SET status = 'completed', updated_at = now()
         WHERE o.status = 'active' AND o.percent = 100
           AND NOT EXISTS (SELECT 1 FROM firmware_rollout_devices rd WHERE rd.rollout_id = o.id AND rd.status IN ('pending', 'sent'))
           AND EXISTS (SELECT 1 FROM firmware_rollout_devices rd WHERE rd.rollout_id = o.id)
         RETURNING o.id, o.organization_id`,
      )
    ).rows;
    for (const o of done) await this.pool.query('SELECT arc_emit_event($1, $2, $3)', [o.organization_id, 'firmware.rollout_updated', JSON.stringify({ rolloutId: o.id, status: 'completed' })]);
    return changed + done.length;
  }

  // =====================================================================================
  // Retention
  // =====================================================================================

  async retention(): Promise<number> {
    let deleted = 0;
    const orgs = (await this.pool.query('SELECT id, retention_days FROM organizations')).rows;
    for (const o of orgs) {
      // Delete in one-day slices from the oldest data so each statement stays small.
      for (let i = 0; i < 400 && !this.stopped; i++) {
        const res = await this.pool.query(
          `WITH bounds AS (
             SELECT min(ts) AS oldest FROM telemetry_measurements WHERE organization_id = $1 AND ts < now() - make_interval(days => $2)
           )
           DELETE FROM telemetry_measurements t USING bounds
           WHERE t.organization_id = $1 AND bounds.oldest IS NOT NULL
             AND t.ts < LEAST(bounds.oldest + interval '1 day', now() - make_interval(days => $2))`,
          [o.id, o.retention_days],
        );
        if (!res.rowCount) break;
        deleted += res.rowCount;
      }
    }
    const housekeeping = [
      `DELETE FROM rejected_messages WHERE received_at < now() - interval '30 days'`,
      `DELETE FROM deliveries WHERE status <> 'pending' AND created_at < now() - interval '30 days'`,
      `DELETE FROM commands WHERE status NOT IN ('queued', 'published') AND created_at < now() - interval '90 days'`,
      `DELETE FROM alerts WHERE status = 'resolved' AND resolved_at < now() - interval '365 days'`,
      `DELETE FROM device_events WHERE event_time < now() - interval '365 days'`,
    ];
    for (const sql of housekeeping) deleted += (await this.pool.query(sql)).rowCount ?? 0;
    if (deleted) this.log('info', 'retention removed old rows', { rows: deleted });
    this.counters.inc('arc_retention_deleted_total', deleted);
    return deleted;
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
