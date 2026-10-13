import { ApiTags } from '@nestjs/swagger';
import { Doc } from '../common/docs';
import { Body, Controller, ForbiddenException, Get, Param, Patch } from '@nestjs/common';
import { computeConnectivity } from '@arc/shared';
import { z } from 'zod';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { mapAlert } from '../common/events';
import { actor, AuthUser, CurrentUser, parse, Uuid } from '../common/http';
import { Db } from '../db/db.service';

/** Named plans. Platform admins assign them; limits can also be set individually. */
export const PLANS: Record<string, { maxDevices: number; maxProjects: number; maxRules: number; maxApiKeys: number; maxWebhooks: number; retentionDays: number }> = {
  free: { maxDevices: 50, maxProjects: 20, maxRules: 100, maxApiKeys: 20, maxWebhooks: 10, retentionDays: 90 },
  pro: { maxDevices: 1000, maxProjects: 200, maxRules: 2000, maxApiKeys: 200, maxWebhooks: 50, retentionDays: 365 },
  enterprise: { maxDevices: 100000, maxProjects: 5000, maxRules: 50000, maxApiKeys: 1000, maxWebhooks: 200, retentionDays: 1825 },
};

const settingsBody = z.object({ retentionDays: z.number().int().min(1).max(3650) });
const planBody = z.object({
  plan: z.enum(Object.keys(PLANS) as [string, ...string[]]),
  maxDevices: z.number().int().min(1).max(1_000_000).optional(),
  maxProjects: z.number().int().min(1).max(100_000).optional(),
  maxRules: z.number().int().min(1).max(1_000_000).optional(),
  maxApiKeys: z.number().int().min(1).max(10_000).optional(),
  maxWebhooks: z.number().int().min(1).max(10_000).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});

@ApiTags('Organizations')
@Controller('api/v1/organizations')
export class OrgOpsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** Home screen: devices by state, alerts, activity and channel shortcuts. */
  @Doc('Overview')
  @Get(':id/overview')
  async overview(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    await this.access.requireOrg(user, id, 'viewer');
    const devices = await this.db.query(
      `SELECT d.id, d.project_id, d.lifecycle_status, d.last_seen_at, d.last_connected_at, d.last_disconnected_at, d.expected_interval_seconds
       FROM devices d WHERE d.organization_id = $1`,
      [id],
    );
    const byState: Record<string, number> = { online: 0, offline: 0, never_seen: 0, inactive: 0 };
    const perProject: Record<string, { online: number; total: number }> = {};
    for (const d of devices) {
      const c = computeConnectivity({
        now: new Date(),
        lastSeenAt: d.last_seen_at,
        lastConnectedAt: d.last_connected_at,
        lastDisconnectedAt: d.last_disconnected_at,
        expectedIntervalSeconds: d.expected_interval_seconds,
      });
      const key = ['revoked', 'retired', 'suspended'].includes(d.lifecycle_status) ? 'inactive' : c.status === 'unknown' ? 'never_seen' : c.status;
      byState[key] = (byState[key] ?? 0) + 1;
      perProject[d.project_id] ??= { online: 0, total: 0 };
      perProject[d.project_id].total++;
      if (c.status === 'online') perProject[d.project_id].online++;
    }
    const projects = await this.db.query('SELECT id, name, description FROM projects WHERE organization_id = $1 ORDER BY name', [id]);
    const alertCounts = await this.db.one(
      `SELECT count(*) FILTER (WHERE status = 'triggered')::int AS triggered, count(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
              count(*) FILTER (WHERE status = 'triggered' AND severity = 'critical')::int AS critical
       FROM alerts WHERE organization_id = $1`,
      [id],
    );
    const recentAlerts = await this.db.query(
      `SELECT a.*, d.display_name AS device_name, p.name AS project_name FROM alerts a
       JOIN devices d ON d.id = a.device_id JOIN projects p ON p.id = a.project_id
       WHERE a.organization_id = $1 ORDER BY (a.status = 'resolved'), a.triggered_at DESC LIMIT 6`,
      [id],
    );
    const activity = await this.db.query(
      `SELECT date_trunc('hour', ts) AS hour, count(DISTINCT message_id)::int AS messages FROM telemetry_measurements
       WHERE organization_id = $1 AND ts > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`,
      [id],
    );
    return {
      devices: { total: devices.length, ...byState },
      alerts: alertCounts,
      recentAlerts: recentAlerts.map(mapAlert),
      activity: activity.map((a) => ({ hour: a.hour, messages: a.messages })),
      projects: projects.map((p) => ({ id: p.id, name: p.name, description: p.description, devices: perProject[p.id]?.total ?? 0, online: perProject[p.id]?.online ?? 0 })),
    };
  }

  /** Plan, limits and usage, plus simple analytics (messages per day, busiest devices). */
  @Doc('Usage')
  @Get(':id/usage')
  async usage(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    await this.access.requireOrg(user, id, 'viewer');
    const o = await this.db.one('SELECT * FROM organizations WHERE id = $1', [id]);
    const used = await this.db.one(
      `SELECT
        (SELECT count(*)::int FROM devices WHERE organization_id = $1 AND lifecycle_status NOT IN ('revoked','retired')) AS devices,
        (SELECT count(*)::int FROM projects WHERE organization_id = $1) AS projects,
        (SELECT count(*)::int FROM alert_rules WHERE organization_id = $1) AS rules,
        (SELECT count(*)::int FROM api_keys WHERE organization_id = $1 AND revoked_at IS NULL) AS api_keys,
        (SELECT count(*)::int FROM webhooks WHERE organization_id = $1) AS webhooks`,
      [id],
    );
    const daily = await this.db.query(
      `SELECT date_trunc('day', ts) AS day, count(DISTINCT message_id)::int AS messages, count(*)::int AS measurements
       FROM telemetry_measurements WHERE organization_id = $1 AND ts > now() - interval '30 days' GROUP BY 1 ORDER BY 1`,
      [id],
    );
    const top = await this.db.query(
      `SELECT t.device_id, d.display_name, p.name AS project_name, count(DISTINCT t.message_id)::int AS messages
       FROM telemetry_measurements t JOIN devices d ON d.id = t.device_id JOIN projects p ON p.id = t.project_id
       WHERE t.organization_id = $1 AND t.ts > now() - interval '7 days' GROUP BY 1, 2, 3 ORDER BY messages DESC LIMIT 10`,
      [id],
    );
    const alerts = await this.db.query(
      `SELECT severity, count(*)::int AS n FROM alerts WHERE organization_id = $1 AND triggered_at > now() - interval '30 days' GROUP BY 1`,
      [id],
    );
    const rejected = await this.db.one(`SELECT count(*)::int AS n FROM rejected_messages WHERE organization_id = $1 AND received_at > now() - interval '7 days'`, [id]);
    return {
      plan: o.plan,
      retentionDays: o.retention_days,
      limits: { devices: o.max_devices, projects: o.max_projects, rules: o.max_rules, apiKeys: o.max_api_keys, webhooks: o.max_webhooks },
      used: { devices: used.devices, projects: used.projects, rules: used.rules, apiKeys: used.api_keys, webhooks: used.webhooks },
      messagesPerDay: daily.map((d) => ({ day: d.day, messages: d.messages, measurements: d.measurements })),
      topDevices: top.map((t) => ({ deviceId: t.device_id, name: t.display_name, projectName: t.project_name, messages: t.messages })),
      alertsBySeverity30d: Object.fromEntries(alerts.map((a) => [a.severity, a.n])),
      rejected7d: rejected?.n ?? 0,
      plans: PLANS,
    };
  }

  /** Organization admins choose how long telemetry is kept (up to the plan's retention). */
  @Doc('Settings', { body: settingsBody })
  @Patch(':id/settings')
  async settings(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    await this.access.requireOrg(user, id, 'org_admin');
    const input = parse(settingsBody, body);
    const o = await this.db.one('SELECT plan FROM organizations WHERE id = $1', [id]);
    const cap = PLANS[o.plan]?.retentionDays ?? 3650;
    if (input.retentionDays > cap && !user.isPlatformAdmin) {
      throw new ForbiddenException({ code: 'quota_exceeded', message: `Your ${o.plan} plan keeps data for up to ${cap} days.` });
    }
    await this.db.query('UPDATE organizations SET retention_days = $2 WHERE id = $1', [id, input.retentionDays]);
    await this.audit.record({ ...actor(user), organizationId: id, action: 'organization.settings', resourceType: 'organization', resourceId: id, metadata: input });
    return { retentionDays: input.retentionDays };
  }

  /** Platform admins (ARC LABS staff) assign a plan and limits. */
  @Doc('Plan', { body: planBody })
  @Patch(':id/plan')
  async plan(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    if (!user.isPlatformAdmin || user.scope) throw new ForbiddenException({ code: 'platform_admin_only' });
    const input = parse(planBody, body);
    const p = PLANS[input.plan];
    const v = {
      maxDevices: input.maxDevices ?? p.maxDevices,
      maxProjects: input.maxProjects ?? p.maxProjects,
      maxRules: input.maxRules ?? p.maxRules,
      maxApiKeys: input.maxApiKeys ?? p.maxApiKeys,
      maxWebhooks: input.maxWebhooks ?? p.maxWebhooks,
      retentionDays: input.retentionDays ?? p.retentionDays,
    };
    await this.db.query(
      `UPDATE organizations SET plan = $2, max_devices = $3, max_projects = $4, max_rules = $5, max_api_keys = $6, max_webhooks = $7, retention_days = $8 WHERE id = $1`,
      [id, input.plan, v.maxDevices, v.maxProjects, v.maxRules, v.maxApiKeys, v.maxWebhooks, v.retentionDays],
    );
    await this.audit.record({ ...actor(user), organizationId: id, action: 'organization.plan', resourceType: 'organization', resourceId: id, metadata: { plan: input.plan, ...v } });
    return { plan: input.plan, ...v };
  }
}

/** ARC LABS staff (PLATFORM_ADMIN_EMAILS or users.is_platform_admin): every customer organization at a glance. */
@ApiTags('Platform administration')
@Controller('api/v1/platform')
export class PlatformController {
  constructor(private readonly db: Db) {}

  @Doc('Organizations')
  @Get('organizations')
  async organizations(@CurrentUser() user: AuthUser) {
    if (!user.isPlatformAdmin || user.scope) throw new ForbiddenException({ code: 'platform_admin_only' });
    const rows = await this.db.query(
      `SELECT o.id, o.name, o.slug, o.plan, o.retention_days, o.max_devices, o.max_projects, o.max_rules, o.max_api_keys, o.max_webhooks, o.created_at,
         (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = o.id) AS members,
         (SELECT count(*)::int FROM devices d WHERE d.organization_id = o.id AND d.lifecycle_status NOT IN ('revoked','retired')) AS devices,
         (SELECT count(*)::int FROM projects p WHERE p.organization_id = o.id) AS projects,
         (SELECT max(d.last_seen_at) FROM devices d WHERE d.organization_id = o.id) AS last_data_at,
         (SELECT u.email FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = o.id AND m.role = 'org_admin' ORDER BY m.joined_at LIMIT 1) AS owner_email
       FROM organizations o ORDER BY o.created_at DESC`,
    );
    return {
      items: rows.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan: o.plan,
        retentionDays: o.retention_days,
        limits: { devices: o.max_devices, projects: o.max_projects, rules: o.max_rules, apiKeys: o.max_api_keys, webhooks: o.max_webhooks },
        members: o.members,
        devices: o.devices,
        projects: o.projects,
        ownerEmail: o.owner_email,
        lastDataAt: o.last_data_at,
        createdAt: o.created_at,
      })),
      plans: PLANS,
    };
  }
}
