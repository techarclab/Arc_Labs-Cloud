import { Queryable } from '../db/db.service';

/**
 * Fans an event out to the organization's subscribed webhooks (rows in `deliveries`,
 * sent by the worker with retries). Call inside the same transaction as the change.
 */
export async function emitEvent(q: Queryable, organizationId: string, type: string, data: Record<string, unknown>): Promise<void> {
  await q.query('SELECT arc_emit_event($1, $2, $3)', [organizationId, type, JSON.stringify(data)]);
}

export const WEBHOOK_EVENTS = [
  'alert.triggered',
  'alert.acknowledged',
  'alert.resolved',
  'device.connected',
  'device.disconnected',
  'device.created',
  'device.revoked',
  'command.updated',
  'firmware.rollout_updated',
  'telemetry.received',
] as const;

export function mapAlert(a: any) {
  return {
    id: a.id,
    organizationId: a.organization_id,
    projectId: a.project_id,
    deviceId: a.device_id,
    deviceName: a.device_name ?? undefined,
    projectName: a.project_name ?? undefined,
    ruleId: a.rule_id,
    ruleName: a.rule_name,
    ruleType: a.rule_type,
    severity: a.severity,
    status: a.status,
    message: a.message,
    value: a.value,
    triggeredAt: a.triggered_at,
    acknowledgedAt: a.acknowledged_at,
    acknowledgedBy: a.acknowledged_by_name ?? a.acknowledged_by ?? null,
    resolvedAt: a.resolved_at,
    resolvedBy: a.resolved_by_name ?? a.resolved_by ?? null,
    resolution: a.resolution,
  };
}
