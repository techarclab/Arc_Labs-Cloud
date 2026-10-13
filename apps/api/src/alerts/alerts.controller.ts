import { ApiTags } from '@nestjs/swagger';
import { Doc } from '../common/docs';
import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { OPERATORS } from '@arc/shared';
import { z } from 'zod';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { emitEvent, mapAlert } from '../common/events';
import { actor, AuthUser, CurrentUser, pageQuery, parse, userRef, Uuid } from '../common/http';
import { Db } from '../db/db.service';

const ruleBody = z
  .object({
    projectId: z.uuid(),
    deviceId: z.uuid().nullable().optional(),
    name: z.string().trim().min(1).max(120),
    ruleType: z.enum(['threshold', 'stale', 'offline']),
    metricKey: z.string().trim().min(1).max(64).optional(),
    operator: z.enum(OPERATORS as unknown as [string, ...string[]]).optional(),
    threshold: z.number().finite().optional(),
    forSeconds: z.number().int().min(0).max(86400).default(0),
    staleSeconds: z.number().int().min(30).max(604800).optional(),
    severity: z.enum(['info', 'warning', 'critical']).default('warning'),
    cooldownSeconds: z.number().int().min(0).max(86400).default(300),
    notifyEmails: z.array(z.email().max(254)).max(20).default([]),
    enabled: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    if (r.ruleType === 'threshold' && (r.metricKey === undefined || r.operator === undefined || r.threshold === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'threshold rules need metricKey, operator and threshold', path: ['metricKey'] });
    }
    if (r.ruleType === 'stale' && r.staleSeconds === undefined) {
      ctx.addIssue({ code: 'custom', message: 'stale rules need staleSeconds', path: ['staleSeconds'] });
    }
  });

const ruleUpdate = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  operator: z.enum(OPERATORS as unknown as [string, ...string[]]).optional(),
  threshold: z.number().finite().optional(),
  forSeconds: z.number().int().min(0).max(86400).optional(),
  staleSeconds: z.number().int().min(30).max(604800).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
  notifyEmails: z.array(z.email().max(254)).max(20).optional(),
  enabled: z.boolean().optional(),
});

const alertList = pageQuery.extend({
  organizationId: z.uuid(),
  projectId: z.uuid().optional(),
  deviceId: z.uuid().optional(),
  status: z.string().regex(/^(triggered|acknowledged|resolved|active)(,(triggered|acknowledged|resolved|active))*$/).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
});

const noteBody = z.object({ note: z.string().trim().max(500).optional() });

export function mapRule(r: any) {
  return {
    id: r.id,
    organizationId: r.organization_id,
    projectId: r.project_id,
    deviceId: r.device_id,
    name: r.name,
    ruleType: r.rule_type,
    metricKey: r.metric_key,
    operator: r.operator,
    threshold: r.threshold,
    forSeconds: r.for_seconds,
    staleSeconds: r.stale_seconds,
    severity: r.severity,
    cooldownSeconds: r.cooldown_seconds,
    notifyEmails: r.notify_emails,
    enabled: r.enabled,
    activeAlerts: r.active_alerts ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@ApiTags('Rules & alerts')
@Controller('api/v1')
export class AlertsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  // ---------------- rules ----------------

  @Doc('List rules', { query: z.object({ projectId: z.uuid() }) })
  @Get('rules')
  async listRules(@CurrentUser() user: AuthUser, @Query() q: unknown) {
    const { projectId } = parse(z.object({ projectId: z.uuid() }), q);
    await this.access.requireProject(user, projectId, 'viewer');
    const rows = await this.db.query(
      `SELECT r.*, (SELECT count(*)::int FROM alerts a WHERE a.rule_id = r.id AND a.status <> 'resolved') AS active_alerts
       FROM alert_rules r WHERE r.project_id = $1 ORDER BY r.name`,
      [projectId],
    );
    return { items: rows.map(mapRule) };
  }

  @Doc('Create rule', { body: ruleBody })
  @Post('rules')
  async createRule(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(ruleBody, body);
    const project = await this.access.requireProject(user, input.projectId, 'engineer');
    if (input.deviceId) {
      const d = await this.db.one('SELECT id FROM devices WHERE id = $1 AND project_id = $2', [input.deviceId, project.id]);
      if (!d) throw new NotFoundException({ code: 'device_not_in_channel' });
    }
    await this.access.requireQuota(project.organization_id, 'rules');
    const rule = await this.db.tx(async (c) => {
      const r = (
        await c.query(
          `INSERT INTO alert_rules (organization_id, project_id, device_id, name, rule_type, metric_key, operator, threshold, for_seconds,
             stale_seconds, severity, cooldown_seconds, notify_emails, enabled, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [
            project.organization_id,
            project.id,
            input.deviceId ?? null,
            input.name,
            input.ruleType,
            input.ruleType === 'threshold' ? input.metricKey : null,
            input.ruleType === 'threshold' ? input.operator : null,
            input.ruleType === 'threshold' ? input.threshold : null,
            input.forSeconds,
            input.ruleType === 'stale' ? input.staleSeconds : null,
            input.severity,
            input.cooldownSeconds,
            input.notifyEmails,
            input.enabled,
            userRef(user),
          ],
        )
      ).rows[0];
      await this.audit.record({ ...actor(user), organizationId: project.organization_id, action: 'rule.create', resourceType: 'alert_rule', resourceId: r.id, metadata: { name: r.name, type: r.rule_type } }, c);
      return r;
    });
    return mapRule(rule);
  }

  @Doc('Get rule')
  @Get('rules/:id')
  async getRule(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    return mapRule(await this.rule(user, id, 'viewer'));
  }

  @Doc('Update rule', { body: ruleUpdate })
  @Patch('rules/:id')
  async updateRule(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const rule = await this.rule(user, id, 'engineer');
    const input = parse(ruleUpdate, body);
    const cols: Record<string, unknown> = {
      name: input.name,
      operator: rule.rule_type === 'threshold' ? input.operator : undefined,
      threshold: rule.rule_type === 'threshold' ? input.threshold : undefined,
      for_seconds: input.forSeconds,
      stale_seconds: rule.rule_type === 'stale' ? input.staleSeconds : undefined,
      severity: input.severity,
      cooldown_seconds: input.cooldownSeconds,
      notify_emails: input.notifyEmails,
      enabled: input.enabled,
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(cols)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    if (!sets.length) return mapRule(rule);
    const updated = await this.db.tx(async (c) => {
      const r = (await c.query(`UPDATE alert_rules SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params)).rows[0];
      // A changed or disabled rule closes its open alerts; the engine re-evaluates with the new settings.
      const conditionChanged = ['operator', 'threshold', 'for_seconds', 'stale_seconds', 'enabled'].some((k) => cols[k] !== undefined);
      if (conditionChanged) {
        await this.closeAlerts(c, id, 'rule_changed', user);
        await c.query('DELETE FROM alert_rule_state WHERE rule_id = $1', [id]);
      }
      await this.audit.record({ ...actor(user), organizationId: r.organization_id, action: 'rule.update', resourceType: 'alert_rule', resourceId: id, metadata: input }, c);
      return r;
    });
    return mapRule(updated);
  }

  @Doc('Delete rule')
  @Delete('rules/:id')
  @HttpCode(204)
  async deleteRule(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const rule = await this.rule(user, id, 'engineer');
    await this.db.tx(async (c) => {
      await this.closeAlerts(c, id, 'rule_changed', user);
      await c.query('DELETE FROM alert_rules WHERE id = $1', [id]);
      await this.audit.record({ ...actor(user), organizationId: rule.organization_id, action: 'rule.delete', resourceType: 'alert_rule', resourceId: id, metadata: { name: rule.name } }, c);
    });
  }

  // ---------------- alerts ----------------

  @Doc('List alerts', { query: alertList })
  @Get('alerts')
  async listAlerts(@CurrentUser() user: AuthUser, @Query() q: unknown) {
    const input = parse(alertList, q);
    if (input.projectId) await this.access.requireProject(user, input.projectId, 'viewer');
    else await this.access.requireOrg(user, input.organizationId, 'viewer');
    const params: unknown[] = [input.organizationId];
    let where = 'a.organization_id = $1';
    if (input.projectId) {
      params.push(input.projectId);
      where += ` AND a.project_id = $${params.length}`;
    }
    if (input.deviceId) {
      params.push(input.deviceId);
      where += ` AND a.device_id = $${params.length}`;
    }
    if (user.scope?.deviceIds) {
      params.push(user.scope.deviceIds);
      where += ` AND a.device_id = ANY($${params.length})`;
    }
    if (input.status) {
      const s = input.status.split(',').flatMap((x) => (x === 'active' ? ['triggered', 'acknowledged'] : [x]));
      params.push(s);
      where += ` AND a.status = ANY($${params.length})`;
    }
    if (input.severity) {
      params.push(input.severity);
      where += ` AND a.severity = $${params.length}`;
    }
    const counts = await this.db.one(
      `SELECT count(*) FILTER (WHERE status = 'triggered')::int AS triggered, count(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
              count(*)::int AS total FROM alerts a WHERE ${where}`,
      params,
    );
    params.push(input.limit, input.offset);
    const rows = await this.db.query(
      `SELECT a.*, d.display_name AS device_name, p.name AS project_name, ua.display_name AS acknowledged_by_name, ur.display_name AS resolved_by_name
       FROM alerts a JOIN devices d ON d.id = a.device_id JOIN projects p ON p.id = a.project_id
       LEFT JOIN users ua ON ua.id = a.acknowledged_by LEFT JOIN users ur ON ur.id = a.resolved_by
       WHERE ${where} ORDER BY (a.status = 'resolved'), a.triggered_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows.map(mapAlert), counts, limit: input.limit, offset: input.offset };
  }

  @Doc('Get alert')
  @Get('alerts/:id')
  async getAlert(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const a = await this.alert(user, id, 'viewer');
    const history = await this.db.query(
      `SELECT e.event, e.actor_type, e.note, e.created_at, u.display_name FROM alert_events e
       LEFT JOIN users u ON e.actor_type = 'user' AND u.id::text = e.actor_id WHERE e.alert_id = $1 ORDER BY e.created_at, e.id`,
      [id],
    );
    const deliveries = await this.db.query(
      `SELECT id, kind, recipient, event_type, status, attempts, last_error, response_code, created_at, sent_at, next_attempt_at
       FROM deliveries WHERE alert_id = $1 ORDER BY id`,
      [id],
    );
    return {
      ...mapAlert(a),
      history: history.map((h) => ({ event: h.event, actor: h.actor_type === 'user' ? h.display_name ?? 'someone' : h.actor_type, note: h.note, at: h.created_at })),
      notifications: deliveries.map((d) => ({
        id: d.id,
        kind: d.kind,
        recipient: d.recipient,
        eventType: d.event_type,
        status: d.status,
        attempts: d.attempts,
        lastError: d.last_error,
        responseCode: d.response_code,
        createdAt: d.created_at,
        sentAt: d.sent_at,
        nextAttemptAt: d.status === 'pending' ? d.next_attempt_at : null,
      })),
    };
  }

  @Doc('Acknowledge', { body: noteBody })
  @Post('alerts/:id/acknowledge')
  @HttpCode(200)
  async acknowledge(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const a = await this.alert(user, id, 'engineer');
    const { note } = parse(noteBody, body ?? {});
    if (a.status !== 'triggered') throw new ConflictException({ code: 'not_triggered', message: `This alert is already ${a.status}.` });
    const updated = await this.db.tx(async (c) => {
      const r = (
        await c.query(
          `UPDATE alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2, updated_at = now() WHERE id = $1 AND status = 'triggered' RETURNING *`,
          [id, userRef(user)],
        )
      ).rows[0];
      if (!r) throw new ConflictException({ code: 'not_triggered' });
      await this.event(c, id, 'acknowledged', user, note);
      await emitEvent(c, r.organization_id, 'alert.acknowledged', mapAlert(r));
      await this.audit.record({ ...actor(user), organizationId: r.organization_id, action: 'alert.acknowledge', resourceType: 'alert', resourceId: id }, c);
      return r;
    });
    return mapAlert(await this.alert(user, updated.id, 'viewer'));
  }

  @Doc('Resolve', { body: noteBody })
  @Post('alerts/:id/resolve')
  @HttpCode(200)
  async resolve(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const a = await this.alert(user, id, 'engineer');
    const { note } = parse(noteBody, body ?? {});
    if (a.status === 'resolved') throw new ConflictException({ code: 'already_resolved', message: 'This alert is already resolved.' });
    const updated = await this.db.tx(async (c) => {
      const r = (
        await c.query(
          `UPDATE alerts SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution = 'manual', updated_at = now() WHERE id = $1 AND status <> 'resolved' RETURNING *`,
          [id, userRef(user)],
        )
      ).rows[0];
      if (!r) throw new ConflictException({ code: 'already_resolved' });
      await this.event(c, id, 'resolved', user, note);
      await emitEvent(c, r.organization_id, 'alert.resolved', mapAlert(r));
      await this.audit.record({ ...actor(user), organizationId: r.organization_id, action: 'alert.resolve', resourceType: 'alert', resourceId: id }, c);
      return r;
    });
    return mapAlert(await this.alert(user, updated.id, 'viewer'));
  }

  // ---------------- helpers ----------------

  private async rule(user: AuthUser, id: string, min: 'viewer' | 'engineer') {
    const r = await this.db.one('SELECT * FROM alert_rules WHERE id = $1', [id]);
    if (!r) throw new NotFoundException({ code: 'not_found' });
    await this.access.requireProject(user, r.project_id, min);
    return r;
  }

  private async alert(user: AuthUser, id: string, min: 'viewer' | 'engineer') {
    const a = await this.db.one(
      `SELECT a.*, d.display_name AS device_name, p.name AS project_name, ua.display_name AS acknowledged_by_name, ur.display_name AS resolved_by_name
       FROM alerts a JOIN devices d ON d.id = a.device_id JOIN projects p ON p.id = a.project_id
       LEFT JOIN users ua ON ua.id = a.acknowledged_by LEFT JOIN users ur ON ur.id = a.resolved_by WHERE a.id = $1`,
      [id],
    );
    if (!a) throw new NotFoundException({ code: 'not_found' });
    await this.access.requireDevice(user, a.device_id, min);
    return a;
  }

  private async event(c: { query: Db['pool']['query'] }, alertId: string, event: string, user: AuthUser, note?: string) {
    const act = actor(user);
    await c.query('INSERT INTO alert_events (alert_id, event, actor_type, actor_id, note) VALUES ($1, $2, $3, $4, $5)', [alertId, event, act.actorType, act.actorId, note || null]);
  }

  private async closeAlerts(c: { query: Db['pool']['query'] }, ruleId: string, resolution: 'rule_changed', user: AuthUser) {
    const closed = await c.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = now(), resolution = $2, updated_at = now() WHERE rule_id = $1 AND status <> 'resolved' RETURNING *`,
      [ruleId, resolution],
    );
    for (const r of closed.rows) {
      await this.event(c, r.id, 'resolved', user, 'Rule changed or removed');
      await emitEvent(c, r.organization_id, 'alert.resolved', mapAlert(r));
    }
  }
}
