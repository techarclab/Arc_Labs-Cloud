import { ApiTags } from '@nestjs/swagger';
import { SystemDb } from '../common/tenant-scope.interceptor';
import { Doc } from '../common/docs';
import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { actor, AuthUser, CurrentUser, pageQuery, parse, requirePerson, Uuid } from '../common/http';
import { Db } from '../db/db.service';

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'slug: lowercase letters, digits and dashes'),
});
const updateBody = z.object({ name: z.string().trim().min(1).max(120) });
const memberBody = z.object({
  email: z.email(),
  role: z.enum(['org_admin', 'engineer', 'viewer']),
});
const roleBody = z.object({ role: z.enum(['org_admin', 'engineer', 'viewer']) });

const mapOrg = (o: any, role?: string) => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  status: o.status,
  planId: o.plan_id,
  createdAt: o.created_at,
  ...(role ? { role } : {}),
});

@ApiTags('Organizations')
@Controller('api/v1/organizations')
export class OrganizationsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Doc('Create', { body: createBody })
  /** Runs without row-level security: the caller is not yet a member of the organization being created. */
  @SystemDb()
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    requirePerson(user);
    const input = parse(createBody, body);
    try {
      return await this.db.tx(async (c) => {
        const org = (await c.query('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *', [input.name, input.slug])).rows[0];
        await c.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'org_admin')`, [org.id, user.id]);
        await this.audit.record({ ...actor(user), organizationId: org.id, action: 'organization.create', resourceType: 'organization', resourceId: org.id }, c);
        return mapOrg(org, 'org_admin');
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException({ code: 'slug_taken' });
      throw err;
    }
  }

  @Doc('List')
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    if (user.scope) {
      const o = await this.db.one('SELECT * FROM organizations WHERE id = $1', [user.scope.orgId]);
      return { items: o ? [mapOrg(o, user.scope.role)] : [] };
    }
    const rows = await this.db.query(
      `SELECT o.*, m.role FROM organizations o JOIN organization_members m ON m.organization_id = o.id
       WHERE m.user_id = $1 ORDER BY o.name`,
      [user.id],
    );
    return { items: rows.map((r) => mapOrg(r, r.role)) };
  }

  @Doc('Get')
  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const role = await this.access.requireOrg(user, id, 'viewer', { allowRestricted: true });
    return mapOrg(await this.db.one('SELECT * FROM organizations WHERE id = $1', [id]), role);
  }

  @Doc('Update', { body: updateBody })
  @Patch(':id')
  async update(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    await this.access.requireOrg(user, id, 'org_admin');
    const input = parse(updateBody, body);
    const org = await this.db.one('UPDATE organizations SET name = $2 WHERE id = $1 RETURNING *', [id, input.name]);
    await this.audit.record({ ...actor(user), organizationId: id, action: 'organization.update', resourceType: 'organization', resourceId: id, metadata: input });
    return mapOrg(org);
  }

  // ---- members ----

  @Doc('Members')
  @Get(':id/members')
  async members(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    await this.access.requireOrg(user, id, 'viewer');
    const rows = await this.db.query(
      `SELECT u.id, u.email, u.display_name, m.role, m.joined_at FROM organization_members m
       JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 ORDER BY u.email`,
      [id],
    );
    return { items: rows.map((r) => ({ userId: r.id, email: r.email, displayName: r.display_name, role: r.role, joinedAt: r.joined_at })) };
  }

  /** Adds an existing user. Email invitations are a later step (needs an email provider). */
  @Doc('Add member', { body: memberBody })
  @Post(':id/members')
  async addMember(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    await this.access.requireOrg(user, id, 'org_admin');
    const input = parse(memberBody, body);
    const target = await this.db.one('SELECT id FROM users WHERE email = $1', [input.email]);
    if (!target) throw new NotFoundException({ code: 'user_not_found', message: 'The user must register first' });
    await this.db.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [id, target.id, input.role],
    );
    await this.audit.record({ ...actor(user), organizationId: id, action: 'member.upsert', resourceType: 'user', resourceId: target.id, metadata: { role: input.role } });
    return { userId: target.id, role: input.role };
  }

  @Doc('Change role', { body: roleBody })
  @Patch(':id/members/:userId')
  async changeRole(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Param('userId', Uuid()) userId: string, @Body() body: unknown) {
    await this.access.requireOrg(user, id, 'org_admin');
    const input = parse(roleBody, body);
    await this.assertNotLastAdmin(id, userId, input.role);
    const row = await this.db.one('UPDATE organization_members SET role = $3 WHERE organization_id = $1 AND user_id = $2 RETURNING role', [id, userId, input.role]);
    if (!row) throw new NotFoundException({ code: 'not_found' });
    await this.audit.record({ ...actor(user), organizationId: id, action: 'member.role_change', resourceType: 'user', resourceId: userId, metadata: input });
    return { userId, role: row.role };
  }

  @Doc('Remove member')
  @Delete(':id/members/:userId')
  @HttpCode(204)
  async removeMember(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Param('userId', Uuid()) userId: string) {
    await this.access.requireOrg(user, id, 'org_admin');
    await this.assertNotLastAdmin(id, userId, null);
    await this.db.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [id, userId]);
    await this.audit.record({ ...actor(user), organizationId: id, action: 'member.remove', resourceType: 'user', resourceId: userId });
  }

  // ---- operational views ----

  @Doc('Audit logs', { query: pageQuery })
  @Get(':id/audit-logs')
  async auditLogs(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Query() q: unknown) {
    await this.access.requireOrg(user, id, 'org_admin');
    const { limit, offset } = parse(pageQuery, q);
    const items = await this.db.query(
      `SELECT id, actor_type, actor_id, action, resource_type, resource_id, metadata, created_at
       FROM audit_logs WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );
    return { items, limit, offset };
  }

  /** Recent ingestion rejections for this tenant — the first place to look when a device "isn't showing up". */
  @Doc('Rejected', { query: pageQuery })
  @Get(':id/rejected-messages')
  async rejected(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Query() q: unknown) {
    await this.access.requireOrg(user, id, 'engineer');
    const { limit, offset } = parse(pageQuery, q);
    const items = await this.db.query(
      `SELECT id, device_id, topic, reason, detail, payload_excerpt, received_at
       FROM rejected_messages WHERE organization_id = $1 ORDER BY received_at DESC LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );
    return { items, limit, offset };
  }

  private async assertNotLastAdmin(orgId: string, userId: string, newRole: string | null) {
    if (newRole === 'org_admin') return;
    const row = await this.db.one(
      `SELECT count(*)::int AS admins, bool_or(user_id = $2) AS target_is_admin
       FROM organization_members WHERE organization_id = $1 AND role = 'org_admin'`,
      [orgId, userId],
    );
    if (row?.target_is_admin && row.admins <= 1) {
      throw new ConflictException({ code: 'last_admin', message: 'An organization needs at least one org_admin' });
    }
  }
}
