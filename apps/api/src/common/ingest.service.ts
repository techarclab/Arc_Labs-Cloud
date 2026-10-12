import { Injectable } from '@nestjs/common';
import { MetricRule } from '@arc/shared';
import { Db } from '../db/db.service';

export interface IngestDevice {
  id: string;
  organization_id: string;
  project_id: string;
  lifecycle_status: string;
}

export const INGESTIBLE = ['provisioned', 'active', 'maintenance'];

/**
 * Stores telemetry that arrives over HTTP (the MQTT path is handled by the ingestion worker
 * with the same rules): idempotent by messageId, updates last_seen, and marks the device
 * active on its first message.
 */
@Injectable()
export class IngestService {
  constructor(private readonly db: Db) {}

  async metricRules(projectId: string): Promise<(MetricRule & { position: number })[]> {
    const rows = await this.db.query('SELECT metric_key, min_value, max_value, position FROM metric_definitions WHERE project_id = $1', [projectId]);
    return rows.map((r) => ({ metricKey: r.metric_key, minValue: r.min_value, maxValue: r.max_value, position: r.position }));
  }

  async rejected(device: IngestDevice | null, source: string, reason: string, detail: string, excerpt: string) {
    await this.db.query(
      `INSERT INTO rejected_messages (organization_id, device_id, topic, reason, detail, payload_excerpt) VALUES ($1, $2, $3, $4, $5, $6)`,
      [device?.organization_id ?? null, device?.id ?? null, source.slice(0, 256), reason, detail.slice(0, 500), excerpt.slice(0, 512)],
    );
  }

  /** Returns false when the messageId was already stored. */
  async write(device: IngestDevice, metrics: Record<string, number>, ts: Date, receivedAt: Date, messageId: string, firmware: string | null): Promise<boolean> {
    return this.db.tx(async (c) => {
      const fresh = await c.query('INSERT INTO ingested_messages (device_id, message_id, received_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [device.id, messageId, receivedAt]);
      if (fresh.rowCount === 0) return false;
      const values: string[] = [];
      const params: unknown[] = [device.organization_id, device.project_id, device.id, ts, receivedAt, messageId];
      for (const [k, v] of Object.entries(metrics)) {
        params.push(k, v);
        values.push(`($1, $2, $3, $${params.length - 1}, $${params.length}, $4, $5, $6)`);
      }
      await c.query(
        `INSERT INTO telemetry_measurements (organization_id, project_id, device_id, metric_key, metric_value, ts, received_at, message_id) VALUES ${values.join(', ')}`,
        params,
      );
      const prev = (
        await c.query(
          `WITH prev AS (SELECT id, lifecycle_status FROM devices WHERE id = $1 FOR UPDATE)
           UPDATE devices d SET
             last_seen_at = GREATEST(COALESCE(d.last_seen_at, $2), $2),
             firmware_version = COALESCE($3, d.firmware_version),
             lifecycle_status = CASE WHEN d.lifecycle_status = 'provisioned' THEN 'active' ELSE d.lifecycle_status END
           FROM prev WHERE d.id = prev.id RETURNING prev.lifecycle_status AS previous_status`,
          [device.id, receivedAt, firmware],
        )
      ).rows[0];
      if (prev?.previous_status === 'provisioned') {
        await c.query(`INSERT INTO device_events (organization_id, device_id, event_type, event_time, details) VALUES ($1, $2, 'first_message', $3, '{"via":"http"}')`, [
          device.organization_id,
          device.id,
          receivedAt,
        ]);
      }
      return true;
    });
  }
}
