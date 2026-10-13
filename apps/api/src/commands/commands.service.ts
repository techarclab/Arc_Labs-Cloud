import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../db/db.service';
import { emitEvent } from '../common/events';
import { MqttPublisher } from '../common/mqtt-publisher.service';

export function mapCommand(c: any) {
  return {
    id: c.id,
    deviceId: c.device_id,
    deviceName: c.device_name ?? undefined,
    name: c.name,
    payload: c.payload,
    status: c.status,
    requestedBy: c.requested_label,
    createdAt: c.created_at,
    expiresAt: c.expires_at,
    publishedAt: c.published_at,
    completedAt: c.completed_at,
    result: c.result,
    error: c.error,
  };
}

/**
 * Command lifecycle: queued → published → acknowledged | failed, or → expired.
 * A command is only "acknowledged" when the device confirms it (MQTT cmd-ack or HTTP ack).
 */
@Injectable()
export class CommandsService {
  constructor(
    private readonly db: Db,
    private readonly mqtt: MqttPublisher,
  ) {}

  async create(
    q: Queryable,
    device: { id: string; organization_id: string; project_id: string },
    name: string,
    payload: Record<string, unknown>,
    ttlSeconds: number,
    requestedBy: string | null,
    requestedLabel: string,
  ) {
    const c = (
      await q.query(
        `INSERT INTO commands (organization_id, project_id, device_id, name, payload, expires_at, requested_by, requested_label)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7, $8) RETURNING *`,
        [device.organization_id, device.project_id, device.id, name, payload, ttlSeconds, requestedBy, requestedLabel],
      )
    ).rows[0];
    await emitEvent(q, device.organization_id, 'command.updated', mapCommand(c));
    return c;
  }

  /** Pushes a queued command over MQTT (after the creating transaction commits). Returns the row. */
  async publish(c: any): Promise<any> {
    const ok = await this.mqtt.publishCommand(
      { id: c.device_id, organization_id: c.organization_id, project_id: c.project_id },
      { id: c.id, name: c.name, payload: c.payload, expiresAt: new Date(c.expires_at) },
    );
    if (!ok) return c;
    return this.db.tx(async (t) => {
      const r = (await t.query(`UPDATE commands SET status = 'published', published_at = now() WHERE id = $1 AND status = 'queued' RETURNING *`, [c.id])).rows[0];
      if (r) await emitEvent(t, r.organization_id, 'command.updated', mapCommand(r));
      return r ?? c;
    });
  }

  /** Applies a device acknowledgement. Ignores unknown, foreign or already-finished commands. */
  async ack(deviceId: string, commandId: string, status: 'ok' | 'error', result?: unknown, error?: string) {
    return this.db.tx(async (t) => {
      const r = (
        await t.query(
          `UPDATE commands SET status = $3, completed_at = now(), result = $4, error = $5,
             published_at = COALESCE(published_at, now())
           WHERE id = $1 AND device_id = $2 AND status IN ('queued', 'published') AND expires_at > now() RETURNING *`,
          [commandId, deviceId, status === 'ok' ? 'acknowledged' : 'failed', result ?? null, status === 'error' ? error ?? 'device reported an error' : null],
        )
      ).rows[0];
      if (r) await emitEvent(t, r.organization_id, 'command.updated', mapCommand(r));
      return r ?? null;
    });
  }
}
