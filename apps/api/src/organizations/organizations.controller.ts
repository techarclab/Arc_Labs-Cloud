import { ApiTags } from '@nestjs/swagger';
import { SystemDb } from '../common/tenant-scope.interceptor';
import { Doc } from '../common/docs';
import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { loadConfig } from '../config';
import { z } from 'zod';
import { AccessService, ASSIGNABLE_ROLES, canAssign, CallerRole, MemberRole } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { actor, AuthUser, CurrentUser, pageQuery, parse, requirePerson, Uuid } from '../common/http';
import { Db } from '../db/db.service';

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'slug: lowercase letters, digits and dashes'),
});
const updateBody = z.object({ name: z.string().trim().min(1).max(120) });
/** A role that can be given to someone. 'org_admin' is still accepted (older clients) and means admin. */
const assignableRole = z
  .enum([...ASSIGNABLE_ROLES, 'org_admin'])
  .transform((r) => (r === 'org_admin' ? 'admin' : r) as MemberRole);
const memberBody = z.object({ email: z.email(), role: assignableRole });
const roleBody = z.object({ role: assignableRole });
const transferBody = z.object({ userId: z.uuid() });

const mapOrg = (o: any, role?: string) => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  status: o.status,
  planId: o.plan_id,
  /** 'personal': someone's own free workspace; 'organization': set up by ARC LABS (a college, school or company). */
  kind: o.kind,
  /** industry, corporate, school, college or university (organizations set up with a setup code). */
  orgType: o.org_type ?? null,
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
        // One free organization per person (so the free plan's limits mean something). Platform admins are exempt;
        // anyone else who needs more asks ARC LABS. The lock makes parallel requests count one at a time.
        if (!user.isPlatformAdmin) {
          await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`org-create:${user.id}`]);
          const limit = loadConfig().ORGS_PER_USER;
          const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM organizations WHERE created_by = $1', [user.id])).rows[0].n;
          if (n >= limit) {
            throw new ForbiddenException({ code: 'org_limit', limit, message: `You can create ${limit} organization${limit === 1 ? '' : 's'}. Contact ARC LABS if you need more.` });
          }
        }
        // Only ARC LABS staff set up real organizations; anyone else gets a personal workspace on the free plan.
        const kind = user.isPlatformAdmin ? 'organization' : 'personal';
        const org = (await c.query('INSERT INTO organizations (name, slug, created_by, kind) VALUES ($1, $2, $3, $4) RETURNING *', [input.name, input.slug, user.id, kind])).rows[0];
        // A personal workspace has its one "individual"; an organization (set up by ARC LABS staff) starts with its
        // creator as owner, who can hand ownership to the customer's admin.
        const role: MemberRole = kind === 'personal' ? 'individual' : 'owner';
        await c.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)`, [org.id, user.id, role]);
        await this.audit.record({ ...actor(user), organizationId: org.id, action: 'organization.create', resourceType: 'organization', resourceId: org.id, metadata: { kind, role } }, c);
        return mapOrg(org, role);
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

  /**
   * Adds an existing account directly, without the person agreeing. ARC LABS staff only (support); everyone else
   * invites people (POST /organizations/:id/invitations), so nobody is put into an organization without accepting.
   * Someone already in the organization keeps their role: change it with PATCH.
   */
  @Doc('Add member (ARC LABS staff only; others send an invitation)', { body: memberBody })
  @Post(':id/members')
  async addMember(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const caller = await this.access.requireOrg(user, id, 'org_admin'); // non-members: 404 first, as everywhere
    if (!user.isPlatformAdmin || user.scope) {
      throw new ForbiddenException({ code: 'use_invitations', message: 'Invite people instead: they join when they accept (Team → Invite people).' });
    }
    await this.requireTeam(id);
    const input = parse(memberBody, body);
    this.requireAssignable(caller, input.role);
    const target = await this.db.one('SELECT id FROM users WHERE email = $1', [input.email]);
    if (!target) throw new NotFoundException({ code: 'user_not_found', message: 'The user must register first' });
    const added = await this.db.one(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO NOTHING RETURNING role`,
      [id, target.id, input.role],
    );
    if (!added) throw new ConflictException({ code: 'already_member', message: 'They are already in this organization. Change their role instead.' });
    await this.audit.record({ ...actor(user), organizationId: id, action: 'member.add', resourceType: 'user', resourceId: target.id, metadata: { role: input.role } });
    return { userId: target.id, role: input.role };
  }

  @Doc('Change role', { body: roleBody })
  @Patch(':id/members/:userId')
  async changeRole(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Param('userId', Uuid()) userId: string, @Body() body: unknown) {
    const caller = await this.access.requireOrg(user, id, 'org_admin');
    await this.requireTeam(id);
    const input = parse(roleBody, body);
    return this.db.tx(async (c) => {
      const target = (await c.query<{ role: MemberRole }>('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 FOR UPDATE', [id, userId])).rows[0];
      if (!target) throw new NotFoundException({ code: 'not_found' });
      if (target.role === 'owner') throw new ConflictException({ code: 'owner_role', message: 'The owner’s role can’t be changed. The owner can transfer ownership to an admin.' });
      // Both the role they have and the role they get must be within the caller's reach.
      this.requireAssignable(caller, target.role);
      this.requireAssignable(caller, input.role);
      await c.query('UPDATE organization_members SET role = $3 WHERE organization_id = $1 AND user_id = $2', [id, userId, input.role]);
      await this.audit.record({ ...actor(user), organizationId: id, action: 'member.role_change', resourceType: 'user', resourceId: userId, metadata: { from: target.role, role: input.role } }, c);
      return { userId, role: input.role };
    });
  }

  /** Removes someone, or lets a member leave. The owner never leaves or is removed: they transfer ownership first. */
  @Doc('Remove member')
  @Delete(':id/members/:userId')
  @HttpCode(204)
  async removeMember(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Param('userId', Uuid()) userId: string) {
    const leaving = !user.scope && userId === user.id;
    const caller = await this.access.requireOrg(user, id, leaving ? 'viewer' : 'org_admin');
    await this.requireTeam(id);
    await this.db.tx(async (c) => {
      const target = (await c.query<{ role: MemberRole }>('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 FOR UPDATE', [id, userId])).rows[0];
      if (!target) throw new NotFoundException({ code: 'not_found' });
      if (target.role === 'owner') {
        throw new ConflictException({ code: 'owner_role', message: 'The owner can’t be removed or leave. Transfer ownership to an admin first.' });
      }
      if (!leaving) this.requireAssignable(caller, target.role);
      await c.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [id, userId]);
      await this.audit.record({ ...actor(user), organizationId: id, action: leaving ? 'member.leave' : 'member.remove', resourceType: 'user', resourceId: userId, metadata: { role: target.role } }, c);
    });
  }

  /** The owner hands the organization to one of its admins, and becomes an admin. */
  @Doc('Transfer ownership', { body: transferBody })
  @Post(':id/transfer-ownership')
  @HttpCode(200)
  async transferOwnership(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    requirePerson(user);
    const caller = await this.access.requireOrg(user, id, 'org_admin');
    await this.requireTeam(id);
    const { userId } = parse(transferBody, body);
    if (caller !== 'owner') throw new ForbiddenException({ code: 'owner_only', message: 'Only the owner can transfer ownership.' });
    if (userId === user.id) throw new ConflictException({ code: 'already_owner' });
    return this.db.tx(async (c) => {
      const rows = (
        await c.query<{ user_id: string; role: MemberRole }>(
          `SELECT user_id, role FROM organization_members WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) FOR UPDATE`,
          [id, [user.id, userId]],
        )
      ).rows;
      const me = rows.find((r) => r.user_id === user.id);
      const next = rows.find((r) => r.user_id === userId);
      if (me?.role !== 'owner') throw new ForbiddenException({ code: 'owner_only', message: 'Only the owner can transfer ownership.' });
      if (!next) throw new NotFoundException({ code: 'not_found' });
      if (next.role !== 'admin') throw new ConflictException({ code: 'transfer_needs_admin', message: 'Make them an admin first, then transfer ownership.' });
      // Demote first: only one owner may exist at any moment (unique index).
      await c.query(`UPDATE organization_members SET role = 'admin' WHERE organization_id = $1 AND user_id = $2`, [id, user.id]);
      await c.query(`UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2`, [id, userId]);
      await this.audit.record({ ...actor(user), organizationId: id, action: 'organization.transfer_ownership', resourceType: 'organization', resourceId: id, metadata: { from: user.id, to: userId } }, c);
      return { ownerId: userId, yourRole: 'admin' };
    });
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

  /** A personal workspace has no team: one person, no members to add, promote or remove. */
  private async requireTeam(orgId: string) {
    const o = await this.db.one<{ kind: string }>('SELECT kind FROM organizations WHERE id = $1', [orgId]);
    if (o?.kind === 'personal') {
      throw new ConflictException({ code: 'personal_workspace', message: 'A personal workspace is just you. For a team, ask ARC LABS to set up an organization.' });
    }
  }

  private requireAssignable(caller: CallerRole, role: MemberRole) {
    if (!canAssign(caller, role)) {
      throw new ForbiddenException({
        code: 'role_not_assignable',
        message: role === 'owner' ? 'Ownership is transferred, not assigned.' : 'Only the owner can add, promote or remove admins.',
      });
    }
  }

}
