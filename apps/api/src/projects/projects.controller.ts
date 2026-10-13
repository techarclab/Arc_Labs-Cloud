import { ApiTags } from '@nestjs/swagger';
import { Doc } from '../common/docs';
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { actor, AuthUser, CurrentUser, parse, userRef, Uuid } from '../common/http';
import { Db } from '../db/db.service';

const createBody = z.object({
  organizationId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  timezone: z.string().max(64).default('Asia/Kolkata'),
});
const updateBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    timezone: z.string().max(64),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
const listQuery = z.object({ organizationId: z.uuid() });
const fieldSchema = z
  .object({
    metricKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'use letters, digits and _ (start with a letter)'),
    label: z.string().trim().min(1).max(120),
    unit: z.string().max(32).default(''),
    minValue: z.number().finite().nullable().default(null),
    maxValue: z.number().finite().nullable().default(null),
    position: z.number().int().min(1).max(32).optional(),
    kind: z.enum(['data', 'control']).default('data'),
    decimals: z.number().int().min(0).max(6).default(2),
    step: z.number().positive().finite().nullable().default(null),
  });
const fieldsBody = z.object({ metrics: z.array(fieldSchema).max(32) });

const widgetSchema = z.object({
  id: z.string().min(1).max(64),
  // Widget types live in the console's registry; the API only checks the shape.
  type: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  title: z.string().max(80).default(''),
  field: z.union([z.literal(''), z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)]).default(''),
  size: z.enum(['s', 'm', 'l', 'xl']).default('m'),
  options: z
    .record(z.string().max(32), z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]))
    .refine((o) => Object.keys(o).length <= 24, 'too many options')
    .default({}),
});
const dashboardBody = z.object({ widgets: z.array(widgetSchema).max(64) });

const mapField = (r: any) => ({
  metricKey: r.metric_key,
  label: r.label,
  unit: r.unit,
  minValue: r.min_value,
  maxValue: r.max_value,
  position: r.position,
  kind: r.kind,
  decimals: r.decimals,
  step: r.step,
});

const mapProject = (p: any) => ({
  id: p.id,
  organizationId: p.organization_id,
  name: p.name,
  description: p.description,
  timezone: p.timezone,
  readApiKey: p.read_api_key,
  createdAt: p.created_at,
});

const newReadKey = () => randomBytes(12).toString('base64url').replace(/[-_]/g, 'X').slice(0, 16).toUpperCase();

@ApiTags('Channels (projects)')
@Controller('api/v1/projects')
export class ProjectsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Doc('Create', { body: createBody })
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(createBody, body);
    await this.access.requireOrg(user, input.organizationId, 'org_admin');
    await this.access.requireQuota(input.organizationId, 'projects');
    await this.assertTimezone(input.timezone);
    const project = await this.db.one(
      'INSERT INTO projects (organization_id, name, description, timezone, read_api_key) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [input.organizationId, input.name, input.description, input.timezone, newReadKey()],
    );
    await this.audit.record({ ...actor(user), organizationId: input.organizationId, action: 'project.create', resourceType: 'project', resourceId: project.id });
    return mapProject(project);
  }

  @Doc('List', { query: listQuery })
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: unknown) {
    const { organizationId } = parse(listQuery, q);
    await this.access.requireOrg(user, organizationId, 'viewer', { allowRestricted: true });
    const rows = await this.db.query(
      `SELECT p.*, (SELECT count(*)::int FROM devices d WHERE d.project_id = p.id) AS device_count
       FROM projects p WHERE p.organization_id = $1 AND ($2::uuid[] IS NULL OR p.id = ANY($2)) ORDER BY p.name`,
      [organizationId, user.scope?.projectIds ?? null],
    );
    return { items: rows.map((r) => ({ ...mapProject(r), deviceCount: r.device_count })) };
  }

  @Doc('Get')
  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    return mapProject(await this.access.requireProject(user, id, 'viewer'));
  }

  @Doc('Update', { body: updateBody })
  @Patch(':id')
  async update(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const project = await this.access.requireProject(user, id, 'engineer');
    const input = parse(updateBody, body);
    if (input.timezone) await this.assertTimezone(input.timezone);
    const updated = await this.db.one(
      `UPDATE projects SET name = COALESCE($2, name), description = COALESCE($3, description), timezone = COALESCE($4, timezone)
       WHERE id = $1 RETURNING *`,
      [id, input.name ?? null, input.description ?? null, input.timezone ?? null],
    );
    await this.audit.record({ ...actor(user), organizationId: project.organization_id, action: 'project.update', resourceType: 'project', resourceId: id, metadata: input });
    return mapProject(updated);
  }

  /** Fields (ThingSpeak "fields", Blynk "datastreams"). `metric-definitions` is kept as an alias. */
  @Doc('Fields')
  @Get([':id/fields', ':id/metric-definitions'])
  async fields(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    await this.access.requireProject(user, id, 'viewer');
    const rows = await this.db.query('SELECT * FROM metric_definitions WHERE project_id = $1 ORDER BY position', [id]);
    return { items: rows.map(mapField) };
  }

  /**
   * Replaces the channel's fields. When the list is non-empty, devices may only send these
   * field names (or field1…fieldN over HTTP), and values outside min/max are rejected.
   * Empty list = accept any numeric reading.
   */
  @Doc('Set fields', { body: fieldsBody })
  @Put([':id/fields', ':id/metric-definitions'])
  async setFields(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const project = await this.access.requireProject(user, id, 'engineer');
    const { metrics } = parse(fieldsBody, body);
    const keys = new Set<string>();
    const used = new Set<number>(metrics.filter((m) => m.position).map((m) => m.position!));
    let next = 1;
    for (const m of metrics) {
      if (keys.has(m.metricKey)) throw new BadRequestException({ code: 'duplicate_field', message: `Field name "${m.metricKey}" is used twice.` });
      if (/^field\d+$/.test(m.metricKey) && Number(m.metricKey.slice(5)) !== (m.position ?? -1) && m.position !== undefined) {
        throw new BadRequestException({ code: 'reserved_name', message: `"${m.metricKey}" can only be the name of field number ${m.metricKey.slice(5)}.` });
      }
      if (m.minValue !== null && m.maxValue !== null && m.minValue > m.maxValue) {
        throw new BadRequestException({ code: 'invalid_range', message: `"${m.label}": min is greater than max.` });
      }
      keys.add(m.metricKey);
      if (!m.position) {
        while (used.has(next)) next++;
        m.position = next;
        used.add(next);
      }
    }
    if (used.size !== metrics.length) throw new BadRequestException({ code: 'duplicate_position', message: 'Two fields have the same field number.' });
    const rows = await this.db.tx(async (c) => {
      await c.query('DELETE FROM metric_definitions WHERE project_id = $1', [id]);
      for (const m of metrics) {
        await c.query(
          `INSERT INTO metric_definitions (project_id, metric_key, label, unit, min_value, max_value, position, kind, decimals, step)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, m.metricKey, m.label, m.unit, m.minValue, m.maxValue, m.position, m.kind, m.decimals, m.step],
        );
      }
      await this.audit.record({ ...actor(user), organizationId: project.organization_id, action: 'project.metric_definitions.set', resourceType: 'project', resourceId: id, metadata: { count: metrics.length } }, c);
      return (await c.query('SELECT * FROM metric_definitions WHERE project_id = $1 ORDER BY position', [id])).rows;
    });
    return { items: rows.map(mapField) };
  }

  @Doc('Regenerate read key')
  @Post(':id/read-key')
  @HttpCode(200)
  async regenerateReadKey(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const project = await this.access.requireProject(user, id, 'org_admin');
    const updated = await this.db.one('UPDATE projects SET read_api_key = $2 WHERE id = $1 RETURNING *', [id, newReadKey()]);
    await this.audit.record({ ...actor(user), organizationId: project.organization_id, action: 'project.read_key.regenerate', resourceType: 'project', resourceId: id });
    return mapProject(updated);
  }

  @Doc('Dashboard')
  @Get(':id/dashboard')
  async dashboard(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    await this.access.requireProject(user, id, 'viewer');
    const row = await this.db.one('SELECT widgets, updated_at FROM dashboards WHERE project_id = $1', [id]);
    return { widgets: row?.widgets ?? [], updatedAt: row?.updated_at ?? null };
  }

  @Doc('Save dashboard', { body: dashboardBody })
  @Put(':id/dashboard')
  async saveDashboard(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const project = await this.access.requireProject(user, id, 'engineer');
    const { widgets } = parse(dashboardBody, body);
    const ids = new Set(widgets.map((w) => w.id));
    if (ids.size !== widgets.length) throw new BadRequestException({ code: 'duplicate_widget' });
    const row = await this.db.one(
      `INSERT INTO dashboards (project_id, widgets, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (project_id) DO UPDATE SET widgets = EXCLUDED.widgets, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING widgets, updated_at`,
      [id, JSON.stringify(widgets), userRef(user)],
    );
    await this.audit.record({ ...actor(user), organizationId: project.organization_id, action: 'project.dashboard.save', resourceType: 'project', resourceId: id, metadata: { widgets: widgets.length } });
    return { widgets: row.widgets, updatedAt: row.updated_at };
  }

  private async assertTimezone(tz: string) {
    const ok = await this.db.one('SELECT 1 FROM pg_timezone_names WHERE name = $1', [tz]);
    if (!ok) throw new BadRequestException({ code: 'invalid_timezone' });
  }
}
