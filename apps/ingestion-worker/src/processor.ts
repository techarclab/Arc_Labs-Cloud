import {
  buildTopic,
  controlMessage,
  MetricRule,
  parseTopic,
  RejectReason,
  validateState,
  validateTelemetry,
} from '@arc/shared';
import { Pool } from 'pg';

export interface DeviceRecord {
  id: string;
  organization_id: string;
  project_id: string;
  lifecycle_status: string;
}

export type Outcome =
  | 'accepted'
  | 'duplicate'
  | `rejected:${RejectReason | 'unknown_device' | 'topic_mismatch' | 'device_inactive' | 'bad_topic' | 'rate_limited'}`;

const INGESTIBLE = new Set(['provisioned', 'active', 'maintenance']);

class TtlCache<V> {
  private readonly map = new Map<string, { v: V; exp: number }>();
  constructor(private readonly ttlMs: number, private readonly max = 50_000) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    return e.v;
  }
  set(k: string, v: V) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(k, { v, exp: Date.now() + this.ttlMs });
  }
}

/** Simple per-device token bucket (per worker instance). */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly ratePerSec: number, private readonly burst: number) {}
  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.ratePerSec);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 100_000) this.buckets.clear();
    return ok;
  }
}

export class Counters {
  readonly values = new Map<string, number>();
  inc(name: string, by = 1) {
    this.values.set(name, (this.values.get(name) ?? 0) + by);
  }
  toPrometheus(): string {
    const lines: string[] = [];
    for (const [k, v] of this.values) {
      const [name, label] = k.split('|');
      lines.push(label ? `${name}{reason="${label}"} ${v}` : `${name} ${v}`);
    }
    return lines.join('\n') + '\n';
  }
}

export class Processor {
  private readonly devices: TtlCache<DeviceRecord | null>;
  private readonly rules: TtlCache<MetricRule[]>;

  constructor(
    private readonly pool: Pool,
    private readonly limiter: RateLimiter,
    private readonly counters: Counters,
    cacheTtlSeconds: number,
  ) {
    this.devices = new TtlCache(cacheTtlSeconds * 1000);
    this.rules = new TtlCache(cacheTtlSeconds * 1000);
  }

  /**
   * Handles one device message. Returns the outcome; never throws for bad input.
   * Database errors DO throw so the caller withholds the MQTT ack and the broker redelivers.
   */
  async handle(topic: string, payload: Buffer, receivedAt = new Date()): Promise<Outcome> {
    const parsed = parseTopic(topic);
    if (!parsed || (parsed.channel !== 'telemetry' && parsed.channel !== 'state')) {
      return this.reject(null, topic, 'bad_topic', 'topic outside convention', payload);
    }

    const device = await this.device(parsed.deviceId);
    if (!device) return this.reject(null, topic, 'unknown_device', parsed.deviceId, payload);
    // Defense in depth: the broker ACL already enforces this; never trust the topic alone.
    if (device.organization_id !== parsed.orgId || device.project_id !== parsed.projectId) {
      return this.reject(device, topic, 'topic_mismatch', 'topic org/project does not match device', payload);
    }
    if (!INGESTIBLE.has(device.lifecycle_status)) {
      return this.reject(device, topic, 'device_inactive', device.lifecycle_status, payload);
    }
    if (!this.limiter.take(device.id)) {
      return this.reject(device, topic, 'rate_limited', 'per-device message rate exceeded', payload, false);
    }

    return parsed.channel === 'telemetry'
      ? this.telemetry(device, topic, payload, receivedAt)
      : this.state(device, topic, payload, receivedAt);
  }

  private async telemetry(device: DeviceRecord, topic: string, payload: Buffer, receivedAt: Date): Promise<Outcome> {
    const rules = await this.metricRules(device.project_id);
    const v = validateTelemetry(payload, { now: receivedAt, metricRules: rules });
    if (!v.ok) return this.reject(device, topic, v.reason, v.detail, payload);
    for (const w of v.warnings) this.counters.inc(`arc_ingest_warnings_total|${w}`);

    const ts = v.deviceTime ?? receivedAt;
    const metrics = Object.entries(v.value.metrics);
    const firmware = typeof v.value.metadata?.firmwareVersion === 'string' ? v.value.metadata.firmwareVersion : null;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const fresh = await client.query(
        'INSERT INTO ingested_messages (device_id, message_id, received_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [device.id, v.value.messageId, receivedAt],
      );
      if (fresh.rowCount === 0) {
        await client.query('ROLLBACK');
        this.counters.inc('arc_ingest_duplicates_total');
        return 'duplicate';
      }

      // One multi-row insert per message.
      const values: string[] = [];
      const params: unknown[] = [device.organization_id, device.project_id, device.id, ts, receivedAt, v.value.messageId];
      for (const [key, value] of metrics) {
        params.push(key, value);
        values.push(`($1, $2, $3, $${params.length - 1}, $${params.length}, $4, $5, $6)`);
      }
      await client.query(
        `INSERT INTO telemetry_measurements (organization_id, project_id, device_id, metric_key, metric_value, ts, received_at, message_id)
         VALUES ${values.join(', ')}`,
        params,
      );
      await this.touch(client, device, receivedAt, firmware);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    this.counters.inc('arc_ingest_accepted_total');
    this.counters.inc('arc_ingest_measurements_total', metrics.length);
    return 'accepted';
  }

  private async state(device: DeviceRecord, topic: string, payload: Buffer, receivedAt: Date): Promise<Outcome> {
    const v = validateState(payload, { now: receivedAt });
    if (!v.ok) return this.reject(device, topic, v.reason, v.detail, payload);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE devices SET reported_state = $2 WHERE id = $1', [device.id, v.value.state]);
      const fw = typeof v.value.state.firmwareVersion === 'string' ? v.value.state.firmwareVersion : null;
      await this.touch(client, device, receivedAt, fw);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    this.counters.inc('arc_ingest_state_total');
    return 'accepted';
  }

  /** last_seen, firmware, and provisioned → active on first message. */
  private async touch(client: { query: Pool['query'] }, device: DeviceRecord, at: Date, firmware: string | null) {
    const res = await client.query(
      `WITH prev AS (SELECT id, lifecycle_status, firmware_version FROM devices WHERE id = $1 FOR UPDATE)
       UPDATE devices d SET
         last_seen_at = GREATEST(COALESCE(d.last_seen_at, $2), $2),
         firmware_version = COALESCE($3, d.firmware_version),
         lifecycle_status = CASE WHEN d.lifecycle_status = 'provisioned' THEN 'active' ELSE d.lifecycle_status END
       FROM prev WHERE d.id = prev.id
       RETURNING prev.lifecycle_status AS previous_status, prev.firmware_version AS previous_firmware`,
      [device.id, at, firmware],
    );
    const prev = res.rows[0];
    if (prev?.previous_status === 'provisioned') {
      await client.query(
        `INSERT INTO device_events (organization_id, device_id, event_type, event_time, details) VALUES ($1, $2, 'first_message', $3, '{}')`,
        [device.organization_id, device.id, at],
      );
      device.lifecycle_status = 'active';
    }
    if (firmware && prev?.previous_firmware && prev.previous_firmware !== firmware) {
      await client.query(
        `INSERT INTO device_events (organization_id, device_id, event_type, event_time, details) VALUES ($1, $2, 'firmware_changed', $3, $4)`,
        [device.organization_id, device.id, at, { from: prev.previous_firmware, to: firmware }],
      );
    }
  }

  /**
   * Broker $SYS client events → connection timestamps for online/offline.
   * On connect, current control values are re-sent so a rebooted device gets its switch/slider state back.
   */
  async clientEvent(kind: 'connected' | 'disconnected', payload: Buffer, publish?: (topic: string, payload: string) => void): Promise<void> {
    let data: any;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }
    const clientId: string | undefined = data?.clientid;
    if (!clientId || !/^[0-9a-f-]{36}$/i.test(clientId) || data.username !== clientId) return;
    const atMs = Number(kind === 'connected' ? data.connected_at : data.disconnected_at) || Date.now();
    const at = new Date(atMs);
    const column = kind === 'connected' ? 'last_connected_at' : 'last_disconnected_at';
    const res = await this.pool.query(
      `UPDATE devices SET ${column} = GREATEST(COALESCE(${column}, $2), $2) WHERE id = $1 RETURNING organization_id, project_id`,
      [clientId, at],
    );
    if (res.rowCount) {
      await this.pool.query(
        'INSERT INTO device_events (organization_id, device_id, event_type, event_time, details) VALUES ($1, $2, $3, $4, $5)',
        [res.rows[0].organization_id, clientId, kind, at, kind === 'disconnected' ? { reason: data.reason ?? null } : { ipaddress: data.ipaddress ?? null }],
      );
      this.counters.inc(`arc_ingest_client_events_total|${kind}`);
      if (kind === 'connected' && publish) {
        const controls = await this.pool.query('SELECT field_key, value FROM control_values WHERE device_id = $1', [clientId]);
        if (controls.rowCount) {
          const topic = buildTopic({ orgId: res.rows[0].organization_id, projectId: res.rows[0].project_id, deviceId: clientId }, 'cmd');
          // Give the device a moment to subscribe after connecting.
          setTimeout(() => {
            for (const c of controls.rows) publish(topic, controlMessage(c.field_key, c.value));
            this.counters.inc('arc_ingest_controls_resent_total', controls.rowCount ?? 0);
          }, 2000);
        }
      }
    }
  }

  async pruneDedupe(windowHours: number): Promise<number> {
    const res = await this.pool.query(`DELETE FROM ingested_messages WHERE received_at < now() - make_interval(hours => $1)`, [windowHours]);
    return res.rowCount ?? 0;
  }

  private async device(id: string): Promise<DeviceRecord | null> {
    const cached = this.devices.get(id);
    if (cached !== undefined) return cached;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const res = await this.pool.query('SELECT id, organization_id, project_id, lifecycle_status FROM devices WHERE id = $1', [id]);
    const d: DeviceRecord | null = res.rows[0] ?? null;
    this.devices.set(id, d);
    return d;
  }

  private async metricRules(projectId: string): Promise<MetricRule[]> {
    const cached = this.rules.get(projectId);
    if (cached) return cached;
    const res = await this.pool.query('SELECT metric_key, min_value, max_value FROM metric_definitions WHERE project_id = $1', [projectId]);
    const rules = res.rows.map((r) => ({ metricKey: r.metric_key, minValue: r.min_value, maxValue: r.max_value }));
    this.rules.set(projectId, rules);
    return rules;
  }

  private async reject(
    device: DeviceRecord | null,
    topic: string,
    reason: string,
    detail: string,
    payload: Buffer,
    persist = true,
  ): Promise<Outcome> {
    this.counters.inc(`arc_ingest_rejected_total|${reason}`);
    // Rate-limited messages are counted only, so a flooding device cannot flood the database too.
    if (persist) {
      await this.pool.query(
        `INSERT INTO rejected_messages (organization_id, device_id, topic, reason, detail, payload_excerpt) VALUES ($1, $2, $3, $4, $5, $6)`,
        [device?.organization_id ?? null, device?.id ?? null, topic.slice(0, 256), reason, detail.slice(0, 500), payload.subarray(0, 512).toString('utf8').replace(/\u0000/g, '')],
      );
    }
    return `rejected:${reason}` as Outcome;
  }
}
