import { ApiTags } from '@nestjs/swagger';
import { Doc } from '../common/docs';
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { CommandParam, validateCommandPayload } from '@arc/shared';
import { z } from 'zod';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { actor, AuthUser, CurrentUser, label, pageQuery, parse, userRef, Uuid } from '../common/http';
import { Db } from '../db/db.service';
import { CommandsService, mapCommand } from './commands.service';

const paramSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
  type: z.enum(['number', 'boolean', 'string']),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  maxLength: z.number().int().min(1).max(500).optional(),
  required: z.boolean().optional(),
});
const typeBody = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_.-]{0,47}$/, 'lowercase letters, digits, . _ -'),
  description: z.string().trim().max(200).default(''),
  params: z.array(paramSchema).max(10).default([]),
  ttlSeconds: z.number().int().min(10).max(604800).default(300),
  minRole: z.enum(['engineer', 'org_admin']).default('engineer'),
});
const sendBody = z.object({ name: z.string().max(48), payload: z.record(z.string(), z.unknown()).default({}) });

const mapType = (t: any) => ({ id: t.id, name: t.name, description: t.description, params: t.params, ttlSeconds: t.ttl_seconds, minRole: t.min_role, createdAt: t.created_at });

/** Reserved for platform features (OTA); cannot be defined or sent directly. */
const RESERVED_COMMANDS = new Set(['ota.update']);

@ApiTags('Commands')
@Controller('api/v1')
export class CommandsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly commands: CommandsService,
  ) {}

  // ---- allow-list per channel ----

  @Doc('List types')
  @Get('projects/:id/command-types')
  async listTypes(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    await this.access.requireProject(user, id, 'viewer');
    return { items: (await this.db.query('SELECT * FROM command_types WHERE project_id = $1 ORDER BY name', [id])).map(mapType) };
  }

  @Doc('Upsert type')
  @Put('projects/:id/command-types/:name')
  async upsertType(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Param('name') name: string, @Body() body: unknown) {
    const project = await this.access.requireProject(user, id, 'org_admin');
    const input = parse(typeBody, { ...(body as object), name });
    if (RESERVED_COMMANDS.has(input.name)) throw new BadRequestException({ code: 'reserved_command', message: `"${input.name}" is reserved.` });
    const keys = input.params.map((p) => p.key);
    if (new Set(keys).size !== keys.length) throw new BadRequestException({ code: 'duplicate_param' });
    const t = await this.db.one(
      `INSERT INTO command_types (project_id, name, description, params, ttl_seconds, min_role) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id, name) DO UPDATE SET description = EXCLUDED.description, params = EXCLUDED.params,
         ttl_seconds = EXCLUDED.ttl_seconds, min_role = EXCLUDED.min_role RETURNING *`,
      [id, input.name, input.description, JSON.stringify(input.params), input.ttlSeconds, input.minRole],
    );
    await this.audit.record({ ...actor(user), organizationId: project.organization_id, action: 'command_type.upsert', resourceType: 'command_type', resourceId: t.id, metadata: input });
    return mapType(t);
  }

  @Doc('Delete type')
  @Delete('projects/:id/command-types/:name')
  @HttpCode(204)
  async deleteType(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Param('name') name: string) {
    const project = await this.access.requireProject(user, id, 'org_admin');
    const t = await this.db.one('DELETE FROM command_types WHERE project_id = $1 AND name = $2 RETURNING id', [id, name]);
    if (!t) throw new NotFoundException({ code: 'not_found' });
    await this.audit.record({ ...actor(user), organizationId: project.organization_id, action: 'command_type.delete', resourceType: 'command_type', resourceId: t.id, metadata: { name } });
  }

  // ---- sending & tracking ----

  @Doc('Send', { body: sendBody })
  @Post('devices/:id/commands')
  async send(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const input = parse(sendBody, body);
    const device = await this.access.requireDevice(user, id, 'engineer');
    if (!['active', 'provisioned', 'maintenance'].includes(device.lifecycle_status)) throw new ConflictException({ code: 'device_inactive' });
    const type = await this.db.one('SELECT * FROM command_types WHERE project_id = $1 AND name = $2', [device.project_id, input.name]);
    if (!type) throw new BadRequestException({ code: 'command_not_allowed', message: `"${input.name}" isn’t an allowed command for this channel.` });
    if (type.min_role === 'org_admin') await this.access.requireDevice(user, id, 'org_admin');
    const problem = validateCommandPayload(type.params as CommandParam[], input.payload);
    if (problem) throw new BadRequestException({ code: 'invalid_payload', message: problem });
    const c = await this.db.tx(async (t) => {
      const row = await this.commands.create(t, device, type.name, input.payload, type.ttl_seconds, userRef(user), label(user));
      await this.audit.record({ ...actor(user), organizationId: device.organization_id, action: 'command.send', resourceType: 'command', resourceId: row.id, metadata: { deviceId: id, name: type.name, payload: input.payload } }, t);
      return row;
    });
    return mapCommand(await this.commands.publish(c));
  }

  @Doc('List', { query: pageQuery })
  @Get('devices/:id/commands')
  async list(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Query() q: unknown) {
    await this.access.requireDevice(user, id, 'viewer');
    const { limit, offset } = parse(pageQuery, q);
    const rows = await this.db.query('SELECT * FROM commands WHERE device_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [id, limit, offset]);
    return { items: rows.map(mapCommand) };
  }

  @Doc('Get')
  @Get('commands/:commandId')
  async get(@CurrentUser() user: AuthUser, @Param('commandId', Uuid()) commandId: string) {
    const c = await this.db.one('SELECT c.*, d.display_name AS device_name FROM commands c JOIN devices d ON d.id = c.device_id WHERE c.id = $1', [commandId]);
    if (!c) throw new NotFoundException({ code: 'not_found' });
    await this.access.requireDevice(user, c.device_id, 'viewer');
    return mapCommand(c);
  }

  /** Re-sends a queued/published command (e.g. after the device reconnected). */
  @Doc('Retry')
  @Post('commands/:commandId/retry')
  @HttpCode(200)
  async retry(@CurrentUser() user: AuthUser, @Param('commandId', Uuid()) commandId: string) {
    const c = await this.db.one('SELECT * FROM commands WHERE id = $1', [commandId]);
    if (!c) throw new NotFoundException({ code: 'not_found' });
    await this.access.requireDevice(user, c.device_id, 'engineer');
    if (!['queued', 'published'].includes(c.status) || new Date(c.expires_at) < new Date()) throw new ForbiddenException({ code: 'command_finished' });
    return mapCommand(await this.commands.publish({ ...c, status: 'queued' }));
  }
}
