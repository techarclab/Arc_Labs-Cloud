import { ApiTags } from '@nestjs/swagger';
import { Doc } from '../common/docs';
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { buildTopic, computeConnectivity } from '@arc/shared';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { loadConfig } from '../config';
import { AccessService } from '../common/access.service';
import { BrokerAdmin } from '../common/broker-admin.service';
import { AuditService } from '../common/audit.service';
import { apiKeyHash, generateSecret, hashSecret } from '../common/crypto';
import { MqttPublisher } from '../common/mqtt-publisher.service';
import { emitEvent } from '../common/events';
import { actor, AuthUser, CurrentUser, pageQuery, parse, userRef, Uuid } from '../common/http';
import { Db } from '../db/db.service';

const tag = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

const createBody = z.object({
  projectId: z.uuid(),
  displayName: z.string().trim().min(1).max(120),
  deviceType: z.string().max(64).default('generic'),
  model: z.string().max(120).default(''),
  tags: z.array(tag).max(32).default([]),
  metadata: z.record(z.string().max(64), z.unknown()).default({}),
  expectedIntervalSeconds: z.number().int().min(1).max(86400).default(60),
});

const updateBody = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    deviceType: z.string().max(64),
    model: z.string().max(120),
    tags: z.array(tag).max(32),
    metadata: z.record(z.string().max(64), z.unknown()),
    expectedIntervalSeconds: z.number().int().min(1).max(86400),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

const listQuery = pageQuery.extend({
  projectId: z.uuid(),
  connectivity: z.enum(['online', 'offline', 'unknown']).optional(),
  lifecycle: z.string().optional(),
  tag: tag.optional(),
  search: z.string().max(120).optional(),
});

const lifecycleBody = z.object({
  status: z.enum(['active', 'maintenance', 'suspended', 'retired']),
  reason: z.string().max(500).optional(),
});

const BUCKETS: Record<string, string> = { '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour', '6h': '6 hours', '1d': '1 day' };
const MAX_RANGE_MS = 31 * 24 * 3600 * 1000;
const MAX_RAW_ROWS = 10_000;

const telemetryQuery = z.object({
  metric: z
    .string()
    .transform((s) => s.split(',').map((m) => m.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).min(1).max(10)),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  bucket: z.enum(Object.keys(BUCKETS) as [string, ...string[]]).optional(),
  agg: z.enum(['avg', 'min', 'max', 'sum', 'count', 'last']).default('avg'),
});

const controlBody = z.object({
  field: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  value: z.number().finite(),
});

/** Devices in these states may authenticate to MQTT. */
export const CONNECTABLE = ['provisioned', 'active', 'maintenance'];

@ApiTags('Devices')
@Controller('api/v1/devices')
export class DevicesController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly mqtt: MqttPublisher,
    private readonly broker: BrokerAdmin,
  ) {}

  /** Registers a device and issues its unique MQTT credential. The password is returned only once. */
  @Doc('Create', { body: createBody })
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(createBody, body);
    const project = await this.access.requireProject(user, input.projectId, 'engineer');
    await this.access.requireQuota(project.organization_id, 'devices');
    const password = generateSecret();
    const secretHash = await hashSecret(password);

    const device = await this.db.tx(async (c) => {
      const d = (
        await c.query(
          `INSERT INTO devices (organization_id, project_id, display_name, device_type, model, tags, metadata, expected_interval_seconds)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [project.organization_id, project.id, input.displayName, input.deviceType, input.model, input.tags, input.metadata, input.expectedIntervalSeconds],
        )
      ).rows[0];
      await c.query('INSERT INTO device_credentials (device_id, secret_hash, api_key_hash) VALUES ($1, $2, $3)', [d.id, secretHash, apiKeyHash(password)]);
      await this.event(c, d, 'provisioned', { by: user.id });
      await this.audit.record({ ...actor(user), organizationId: d.organization_id, action: 'device.create', resourceType: 'device', resourceId: d.id }, c);
      await emitEvent(c, d.organization_id, 'device.created', { deviceId: d.id, projectId: d.project_id, name: d.display_name });
      return d;
    });
    return { device: this.map(device), credentials: this.credentials(device, password) };
  }

  @Doc('List', { query: listQuery })
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: unknown) {
    const input = parse(listQuery, q);
    await this.access.requireProject(user, input.projectId, 'viewer');
    const params: unknown[] = [input.projectId];
    let where = 'project_id = $1';
    if (input.lifecycle) {
      params.push(input.lifecycle.split(','));
      where += ` AND lifecycle_status = ANY($${params.length})`;
    }
    if (input.tag) {
      params.push(input.tag);
      where += ` AND $${params.length} = ANY(tags)`;
    }
    if (user.scope?.deviceIds) {
      params.push(user.scope.deviceIds);
      where += ` AND id = ANY($${params.length})`;
    }
    if (input.search) {
      params.push(`%${input.search.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      where += ` AND display_name ILIKE $${params.length}`;
    }
    const rows = await this.db.query(`SELECT * FROM devices WHERE ${where} ORDER BY display_name, id`, params);
    let items = rows.map((r) => this.map(r));
    if (input.connectivity) items = items.filter((d) => d.connectivity.status === input.connectivity);
    return { items: items.slice(input.offset, input.offset + input.limit), total: items.length, limit: input.limit, offset: input.offset };
  }

  @Doc('Get')
  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    return this.map(await this.access.requireDevice(user, id, 'viewer'));
  }

  @Doc('Update', { body: updateBody })
  @Patch(':id')
  async update(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const device = await this.access.requireDevice(user, id, 'engineer');
    const input = parse(updateBody, body);
    const updated = await this.db.one(
      `UPDATE devices SET
         display_name = COALESCE($2, display_name), device_type = COALESCE($3, device_type), model = COALESCE($4, model),
         tags = COALESCE($5, tags), metadata = COALESCE($6, metadata), expected_interval_seconds = COALESCE($7, expected_interval_seconds)
       WHERE id = $1 RETURNING *`,
      [id, input.displayName ?? null, input.deviceType ?? null, input.model ?? null, input.tags ?? null, input.metadata ?? null, input.expectedIntervalSeconds ?? null],
    );
    await this.audit.record({ ...actor(user), organizationId: device.organization_id, action: 'device.update', resourceType: 'device', resourceId: id, metadata: { fields: Object.keys(input) } });
    return this.map(updated);
  }

  /** Issues a new credential and revokes the old one. The device must be re-flashed/re-configured. */
  @Doc('Rotate')
  @Post(':id/rotate-credentials')
  @HttpCode(200)
  async rotate(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const password = generateSecret();
    const secretHash = await hashSecret(password);
    const device = await this.db.tx(async (c) => {
      const d = await this.access.requireDevice(user, id, 'engineer', c);
      if (['revoked', 'retired'].includes(d.lifecycle_status)) throw new ConflictException({ code: 'device_revoked' });
      await c.query('SELECT id FROM devices WHERE id = $1 FOR UPDATE', [id]);
      await c.query(`UPDATE device_credentials SET status = 'revoked', revoked_at = now() WHERE device_id = $1 AND status = 'active'`, [id]);
      await c.query('INSERT INTO device_credentials (device_id, secret_hash, api_key_hash) VALUES ($1, $2, $3)', [id, secretHash, apiKeyHash(password)]);
      await this.event(c, d, 'credentials_rotated', { by: user.id });
      await this.audit.record({ ...actor(user), organizationId: d.organization_id, action: 'device.credentials.rotate', resourceType: 'device', resourceId: id }, c);
      return d;
    });
    await this.broker.disconnect(id); // the old password is dead: end any session that used it
    return { device: this.map(device), credentials: this.credentials(device, password) };
  }

  /** Permanently revokes the device and its credentials, and disconnects its live broker session. */
  @Doc('Revoke', { body: z.object({ reason: z.string().max(500).optional() }) })
  @Post(':id/revoke')
  @HttpCode(200)
  async revoke(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().max(500).optional() }), body ?? {});
    const device = await this.db.tx(async (c) => {
      const d = await this.access.requireDevice(user, id, 'org_admin', c);
      const updated = (await c.query(`UPDATE devices SET lifecycle_status = 'revoked' WHERE id = $1 RETURNING *`, [id])).rows[0];
      await c.query(`UPDATE device_credentials SET status = 'revoked', revoked_at = now() WHERE device_id = $1 AND status = 'active'`, [id]);
      await this.event(c, d, 'revoked', { by: user.id, reason });
      await this.audit.record({ ...actor(user), organizationId: d.organization_id, action: 'device.revoke', resourceType: 'device', resourceId: id, metadata: { reason } }, c);
      await emitEvent(c, d.organization_id, 'device.revoked', { deviceId: id, projectId: d.project_id, name: d.display_name, reason: reason ?? null });
      return updated;
    });
    await this.broker.disconnect(id);
    return this.map(device);
  }

  /** Lifecycle changes short of revocation (maintenance, suspend, resume, retire). */
  @Doc('Lifecycle', { body: lifecycleBody })
  @Post(':id/lifecycle')
  @HttpCode(200)
  async lifecycle(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const input = parse(lifecycleBody, body);
    const device = await this.db.tx(async (c) => {
      const d = await this.access.requireDevice(user, id, input.status === 'retired' ? 'org_admin' : 'engineer', c);
      if (['revoked', 'retired'].includes(d.lifecycle_status)) throw new ConflictException({ code: 'terminal_state', status: d.lifecycle_status });
      const updated = (await c.query('UPDATE devices SET lifecycle_status = $2 WHERE id = $1 RETURNING *', [id, input.status])).rows[0];
      if (input.status === 'retired') {
        await c.query(`UPDATE device_credentials SET status = 'revoked', revoked_at = now() WHERE device_id = $1 AND status = 'active'`, [id]);
      }
      await this.event(c, d, 'lifecycle_changed', { from: d.lifecycle_status, to: input.status, by: user.id, reason: input.reason });
      await this.audit.record({ ...actor(user), organizationId: d.organization_id, action: 'device.lifecycle', resourceType: 'device', resourceId: id, metadata: input }, c);
      return updated;
    });
    if (input.status === 'suspended' || input.status === 'retired') await this.broker.disconnect(id);
    return this.map(device);
  }

  @Doc('State')
  @Get(':id/state')
  async state(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const d = this.map(await this.access.requireDevice(user, id, 'viewer'));
    return { deviceId: d.id, connectivity: d.connectivity, lastSeenAt: d.lastSeenAt, lastConnectedAt: d.lastConnectedAt, lastDisconnectedAt: d.lastDisconnectedAt, reportedState: d.reportedState, firmwareVersion: d.firmwareVersion };
  }

  @Doc('Latest')
  @Get(':id/telemetry/latest')
  async latest(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const d = await this.access.requireDevice(user, id, 'viewer');
    const rows = await this.db.query(
      `SELECT DISTINCT ON (metric_key) metric_key, metric_value, ts, received_at
       FROM telemetry_measurements WHERE device_id = $1 AND organization_id = $2 AND ts > now() - interval '30 days'
       ORDER BY metric_key, ts DESC`,
      [id, d.organization_id],
    );
    return { deviceId: id, items: rows.map((r) => ({ metric: r.metric_key, value: r.metric_value, ts: r.ts, receivedAt: r.received_at })) };
  }

  @Doc('Telemetry', { query: telemetryQuery })
  @Get(':id/telemetry')
  async telemetry(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Query() q: unknown) {
    const d = await this.access.requireDevice(user, id, 'viewer');
    const input = parse(telemetryQuery, q);
    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from ? new Date(input.from) : new Date(to.getTime() - 24 * 3600 * 1000);
    if (from >= to) throw new BadRequestException({ code: 'invalid_range', message: 'from must be before to' });
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new BadRequestException({ code: 'range_too_large', maxDays: 31 });

    // organization_id is always part of the predicate (tenant scope on every telemetry query).
    const base = [id, d.organization_id, input.metric, from, to];
    if (!input.bucket) {
      const rows = await this.db.query(
        `SELECT metric_key, metric_value, ts FROM telemetry_measurements
         WHERE device_id = $1 AND organization_id = $2 AND metric_key = ANY($3) AND ts >= $4 AND ts < $5
         ORDER BY ts LIMIT ${MAX_RAW_ROWS + 1}`,
        base,
      );
      const truncated = rows.length > MAX_RAW_ROWS;
      return { deviceId: id, from, to, bucket: null, truncated, series: this.series(input.metric, rows.slice(0, MAX_RAW_ROWS), 'metric_value', 'ts') };
    }

    const aggSql: Record<string, string> = {
      avg: 'avg(metric_value)',
      min: 'min(metric_value)',
      max: 'max(metric_value)',
      sum: 'sum(metric_value)',
      count: 'count(*)::double precision',
      last: '(array_agg(metric_value ORDER BY ts DESC))[1]',
    };
    const rows = await this.db.query(
      `SELECT date_bin($6::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket, metric_key, ${aggSql[input.agg]} AS value
       FROM telemetry_measurements
       WHERE device_id = $1 AND organization_id = $2 AND metric_key = ANY($3) AND ts >= $4 AND ts < $5
       GROUP BY 1, 2 ORDER BY 1 LIMIT ${MAX_RAW_ROWS}`,
      [...base, BUCKETS[input.bucket]],
    );
    return { deviceId: id, from, to, bucket: input.bucket, agg: input.agg, series: this.series(input.metric, rows, 'value', 'bucket') };
  }

  /** Current control values (switches, sliders) for this device. */
  @Doc('Controls')
  @Get(':id/controls')
  async controls(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    await this.access.requireDevice(user, id, 'viewer');
    const rows = await this.db.query('SELECT field_key, value, updated_at FROM control_values WHERE device_id = $1 ORDER BY field_key', [id]);
    return { items: rows.map((r) => ({ field: r.field_key, value: r.value, updatedAt: r.updated_at })), mqttConnected: this.mqtt.connected };
  }

  /** Sets a control value and pushes it to the device over MQTT (HTTP devices poll /api/v1/controls). */
  @Doc('Set control', { body: controlBody })
  @Post(':id/controls')
  @HttpCode(200)
  async setControl(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const d = await this.access.requireDevice(user, id, 'engineer');
    const input = parse(controlBody, body);
    if (!CONNECTABLE.includes(d.lifecycle_status)) throw new ConflictException({ code: 'device_inactive', message: 'This device is suspended, revoked or retired.' });
    const field = await this.db.one('SELECT kind, min_value, max_value FROM metric_definitions WHERE project_id = $1 AND metric_key = $2', [d.project_id, input.field]);
    if (!field || field.kind !== 'control') {
      throw new BadRequestException({ code: 'not_a_control', message: `"${input.field}" isn’t a control field in this channel. Add it as a control field in the channel settings first.` });
    }
    let value = input.value;
    if (field.min_value !== null) value = Math.max(field.min_value, value);
    if (field.max_value !== null) value = Math.min(field.max_value, value);
    const row = await this.db.one(
      `INSERT INTO control_values (device_id, field_key, value, updated_at, updated_by) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (device_id, field_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING field_key, value, updated_at`,
      [id, input.field, value, userRef(user)],
    );
    const delivered = await this.mqtt.publishControl(d, input.field, value);
    return { field: row.field_key, value: row.value, updatedAt: row.updated_at, pushedOverMqtt: delivered };
  }

  @Doc('Events', { query: pageQuery })
  @Get(':id/events')
  async events(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Query() q: unknown) {
    await this.access.requireDevice(user, id, 'viewer');
    const { limit, offset } = parse(pageQuery, q);
    const items = await this.db.query(
      'SELECT event_type, event_time, details FROM device_events WHERE device_id = $1 ORDER BY event_time DESC, id DESC LIMIT $2 OFFSET $3',
      [id, limit, offset],
    );
    return { items: items.map((e) => ({ type: e.event_type, time: e.event_time, details: e.details })), limit, offset };
  }

  // ---- helpers ----

  private series(metrics: string[], rows: any[], valueCol: string, tsCol: string) {
    const out: Record<string, { ts: Date; value: number }[]> = Object.fromEntries(metrics.map((m) => [m, []]));
    for (const r of rows) out[r.metric_key]?.push({ ts: r[tsCol], value: Number(r[valueCol]) });
    return out;
  }

  private async event(c: PoolClient, d: any, type: string, details: Record<string, unknown>) {
    await c.query('INSERT INTO device_events (organization_id, device_id, event_type, details) VALUES ($1, $2, $3, $4)', [d.organization_id, d.id, type, details]);
  }

  private credentials(d: any, password: string) {
    const cfg = loadConfig();
    const ids = { orgId: d.organization_id, projectId: d.project_id, deviceId: d.id };
    return {
      mqttHost: cfg.MQTT_PUBLIC_HOST,
      mqttPort: cfg.MQTT_PUBLIC_PORT,
      tls: true,
      clientId: d.id,
      username: d.id,
      password,
      topics: { telemetry: buildTopic(ids, 'telemetry'), state: buildTopic(ids, 'state'), commands: buildTopic(ids, 'cmd'), commandAcks: buildTopic(ids, 'cmd-ack') },
      http: {
        apiKey: password,
        updateUrl: `${cfg.HTTP_PUBLIC_URL}/api/v1/update`,
        controlsUrl: `${cfg.HTTP_PUBLIC_URL}/api/v1/controls`,
      },
      notice: 'Store this password now. It is not stored in plaintext and cannot be shown again; rotate to get a new one. The same value is the HTTP API key.',
    };
  }

  map(d: any) {
    const connectivity = computeConnectivity({
      now: new Date(),
      lastSeenAt: d.last_seen_at,
      lastConnectedAt: d.last_connected_at,
      lastDisconnectedAt: d.last_disconnected_at,
      expectedIntervalSeconds: d.expected_interval_seconds,
    });
    return {
      id: d.id,
      organizationId: d.organization_id,
      projectId: d.project_id,
      displayName: d.display_name,
      deviceType: d.device_type,
      model: d.model,
      firmwareVersion: d.firmware_version,
      tags: d.tags,
      metadata: d.metadata,
      lifecycleStatus: d.lifecycle_status,
      expectedIntervalSeconds: d.expected_interval_seconds,
      connectivity: ['revoked', 'retired', 'suspended'].includes(d.lifecycle_status)
        ? { ...connectivity, status: 'offline' as const }
        : connectivity,
      reportedState: d.reported_state,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      lastConnectedAt: d.last_connected_at,
      lastDisconnectedAt: d.last_disconnected_at,
    };
  }
}
