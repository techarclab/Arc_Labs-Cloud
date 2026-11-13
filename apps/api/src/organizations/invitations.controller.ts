/**
 * Organization invitations (phase 2):
 *  - email invitations: one person, bound to their email address, single use, expiring, revocable. The token is
 *    only in the emailed link (and shown once to the inviter, to share another way); only its hash is stored.
 *  - class codes: a shared code for a class or batch, student or viewer role only, limited uses, capped by seats.
 * Owners invite any role below owner; admins invite the roles below admin (AccessService.canAssign).
 * Accepting never gives more than the invitation says, and only to the account with the invited, confirmed address.
 *
 * Invitations live in invite_codes, which tenant requests cannot read (migration 005), so these handlers run in
 * system scope and check access themselves (AccessService) and always filter by organization.
 */
import { ApiTags } from '@nestjs/swagger';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpException, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AccessService, ASSIGNABLE_ROLES, canAssign, CallerRole, MemberRole } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { Doc } from '../common/docs';
import { renderAccountEmail } from '../common/email';
import { actor, AuthUser, CurrentUser, parse, Public, requirePerson, userRef, Uuid } from '../common/http';
import { hashInviteCode, newInviteCode } from '../common/invites';
import { requireSeat, seatUsage } from '../common/seats';
import { SystemDb } from '../common/tenant-scope.interceptor';
import { loadConfig } from '../config';
import { Db } from '../db/db.service';

/** Email invitations per organization per 24 h: keeps an account from using ARC Cloud's mail to spam people. */
const EMAIL_INVITES_PER_DAY = 200;
const ROLE_LABEL: Record<string, string> = { admin: 'Admin', engineer: 'Engineer', viewer: 'Viewer', student: 'Student', teacher: 'Teacher', trainer: 'Trainer', employee: 'Employee' };

const tokenHash = (token: string) => createHash('sha256').update(`email-invite:${token}`).digest('hex');

const emailInviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(ASSIGNABLE_ROLES),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
/** Class codes: student or viewer only (student becomes available with channel-level access, phase 4). */
const classCodeBody = z.object({
  label: z.string().trim().min(1).max(120),
  role: z.enum(['viewer']),
  maxUses: z.number().int().min(1).max(10000),
  expiresInDays: z.number().int().min(1).max(365),
});
const revokeBody = z.object({ removeMembers: z.boolean().optional() });
const seatsBody = z.object({ seatLimit: z.number().int().min(1).max(100000).nullable() });
const tokenBody = z.object({ token: z.string().min(20).max(200) });
const tokenQuery = z.object({ token: z.string().min(20).max(200) });

function status(i: { revoked_at: Date | null; expires_at: Date; used_count: number; max_uses: number }) {
  if (i.revoked_at) return 'revoked';
  if (i.used_count >= i.max_uses) return 'used_up';
  if (new Date(i.expires_at) <= new Date()) return 'expired';
  return 'active';
}

/** a***@example.com: enough for the right person to recognise, without spelling it out to whoever holds the link. */
const maskEmail = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, (_, a, b) => `${a}***${b}`);

@ApiTags('Invitations')
@Controller('api/v1')
export class InvitationsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  // ---------- managing invitations (owner / admin) ----------

  @Doc('Invitations and class codes of an organization (no tokens or codes)')
  @SystemDb()
  @Get('organizations/:id/invitations')
  async list(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    await this.requireManager(user, id);
    const rows = await this.db.query(
      `SELECT i.id, i.kind, i.label, i.email, i.role, i.max_uses, i.used_count, i.expires_at, i.revoked_at, i.created_at, i.accepted_at,
              cu.display_name AS created_by_name, au.display_name AS accepted_by_name,
              (SELECT count(*)::int FROM organization_members m WHERE m.invite_id = i.id) AS members
       FROM invite_codes i LEFT JOIN users cu ON cu.id = i.created_by LEFT JOIN users au ON au.id = i.accepted_by
       WHERE i.organization_id = $1 AND i.kind IN ('email', 'class') ORDER BY i.created_at DESC LIMIT 500`,
      [id],
    );
    return {
      items: rows.map((i) => ({
        id: i.id,
        kind: i.kind,
        label: i.label,
        email: i.email,
        role: i.role,
        maxUses: i.max_uses,
        usedCount: i.used_count,
        members: i.members,
        status: status(i),
        expiresAt: i.expires_at,
        createdAt: i.created_at,
        createdBy: i.created_by_name ?? null,
        acceptedAt: i.accepted_at,
        acceptedBy: i.accepted_by_name ?? null,
      })),
      seats: await this.db.tx((c) => seatUsage(c, id)),
    };
  }

  @Doc('Invite someone by email (one person, single use, expiring)', { body: emailInviteBody })
  @SystemDb()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('organizations/:id/invitations')
  async inviteByEmail(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    requirePerson(user);
    const caller = await this.requireManager(user, id);
    const input = parse(emailInviteBody, body);
    this.requireAssignable(caller, input.role);
    const token = randomBytes(24).toString('base64url');
    const link = `${loadConfig().CONSOLE_URL.replace(/\/+$/, '')}/invite#token=${token}`;
    const row = await this.db.tx(async (c) => {
      const org = (await c.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [id])).rows[0];
      const member = (await c.query('SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND u.email = $2', [id, input.email])).rowCount;
      if (member) throw new ConflictException({ code: 'already_member', message: 'They are already in this organization.' });
      const sent = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM invite_codes WHERE organization_id = $1 AND kind = 'email' AND created_at > now() - interval '1 day'`, [id])).rows[0].n;
      if (sent >= EMAIL_INVITES_PER_DAY) throw new HttpException({ code: 'invite_limit', message: `At most ${EMAIL_INVITES_PER_DAY} email invitations a day per organization.` }, 429);
      // Re-inviting replaces the open invitation (its link stops working), so it does not hold a second seat.
      await c.query(`UPDATE invite_codes SET revoked_at = now() WHERE organization_id = $1 AND kind = 'email' AND email = $2 AND revoked_at IS NULL AND used_count = 0`, [id, input.email]);
      await requireSeat(c, id);
      const inv = (
        await c.query(
          `INSERT INTO invite_codes (kind, code_hash, label, organization_id, role, email, max_uses, expires_at, created_by)
           VALUES ('email', $1, $2, $3, $4, $5, 1, now() + make_interval(days => $6), $7) RETURNING id, expires_at`,
          [tokenHash(token), `Invitation for ${input.email}`, id, input.role, input.email, input.expiresInDays, userRef(user)],
        )
      ).rows[0];
      const inviter = (await c.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [user.id])).rows[0]?.display_name ?? 'Someone';
      const roleLabel = ROLE_LABEL[input.role] ?? input.role;
      const { html, text } = renderAccountEmail({
        preheader: `${inviter} invited you to ${org.name} on ARC Cloud.`,
        heading: `Join ${org.name}`,
        greeting: 'Hello,',
        intro: `${inviter} invited you to join ${org.name} on ARC Cloud as ${roleLabel === 'Admin' ? 'an' : 'a'} ${roleLabel}.`,
        button: { label: 'Accept the invitation', url: link },
        steps: [
          `Sign in, or create a free account, with this email address (${input.email}). The invitation works only for it.`,
          'Press “Accept” to join. You can see the organization’s channels and devices straight away.',
        ],
        notes: [
          `The invitation works once and expires in ${input.expiresInDays} day${input.expiresInDays === 1 ? '' : 's'}.`,
          `If you don’t know ${inviter} or ${org.name}, ignore this email; nothing will happen.`,
        ],
      });
      // auth.* deliveries keep only the subject once sent, so the link does not stay in the outbox.
      await c.query(`INSERT INTO deliveries (organization_id, kind, recipient, event_type, payload) VALUES ($1, 'email', $2, 'auth.invitation', $3)`, [
        id,
        input.email,
        { subject: `${inviter} invited you to ${org.name} on ARC Cloud`, text, html },
      ]);
      await this.audit.record({ ...actor(user), organizationId: id, action: 'invite.create', resourceType: 'invite_code', resourceId: inv.id, metadata: { kind: 'email', email: input.email, role: input.role, expiresInDays: input.expiresInDays } }, c);
      return inv;
    });
    // The link is also returned once, so the inviter can share it another way (WhatsApp, a class chat). It still
    // works only for the invited address.
    return { id: row.id, email: input.email, role: input.role, expiresAt: row.expires_at, link };
  }

  @Doc('Create a class code (shared, student or viewer, limited uses, capped by seats)', { body: classCodeBody })
  @SystemDb()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('organizations/:id/class-codes')
  async createClassCode(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    requirePerson(user);
    const caller = await this.requireManager(user, id);
    const input = parse(classCodeBody, body);
    this.requireAssignable(caller, input.role);
    const code = newInviteCode();
    const row = await this.db.one(
      `INSERT INTO invite_codes (kind, code_hash, label, organization_id, role, max_uses, expires_at, created_by)
       VALUES ('class', $1, $2, $3, $4, $5, now() + make_interval(days => $6), $7) RETURNING id, expires_at`,
      [hashInviteCode(code), input.label, id, input.role, input.maxUses, input.expiresInDays, userRef(user)],
    );
    await this.audit.record({ ...actor(user), organizationId: id, action: 'invite.create', resourceType: 'invite_code', resourceId: row.id, metadata: { kind: 'class', label: input.label, role: input.role, maxUses: input.maxUses, expiresInDays: input.expiresInDays } });
    return { id: row.id, code, label: input.label, role: input.role, maxUses: input.maxUses, expiresAt: row.expires_at };
  }

  @Doc('Revoke an invitation or class code; optionally remove the people who joined with it (never the owner or admins)', { body: revokeBody })
  @SystemDb()
  @Post('organizations/:id/invitations/:inviteId/revoke')
  @HttpCode(200)
  async revoke(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Param('inviteId', Uuid()) inviteId: string, @Body() body: unknown) {
    const caller = await this.requireManager(user, id);
    const { removeMembers } = parse(revokeBody, body ?? {});
    return this.db.tx(async (c) => {
      const inv = (
        await c.query<{ id: string; role: MemberRole }>(
          `UPDATE invite_codes SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND organization_id = $2 AND kind IN ('email', 'class') RETURNING id, role`,
          [inviteId, id],
        )
      ).rows[0];
      if (!inv) throw new NotFoundException({ code: 'not_found' });
      // An admin cannot revoke (or remove the people of) an invitation for a role they could not give.
      this.requireAssignable(caller, inv.role);
      const removed = removeMembers
        ? (await c.query<{ user_id: string }>(`DELETE FROM organization_members WHERE organization_id = $1 AND invite_id = $2 AND role NOT IN ('owner', 'admin') RETURNING user_id`, [id, inviteId])).rows
        : [];
      for (const r of removed) {
        await this.audit.record({ ...actor(user), organizationId: id, action: 'member.remove', resourceType: 'user', resourceId: r.user_id, metadata: { inviteId } }, c);
      }
      await this.audit.record({ ...actor(user), organizationId: id, action: 'invite.revoke', resourceType: 'invite_code', resourceId: inviteId, metadata: { removedMembers: removed.length } }, c);
      return { id: inviteId, status: 'revoked', removedMembers: removed.length };
    });
  }

  @Doc('Seats: members, open invitations and the limit', {})
  @SystemDb()
  @Get('organizations/:id/seats')
  async seats(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    await this.access.requireOrg(user, id, 'viewer', { allowRestricted: true });
    const s = await this.db.tx((c) => seatUsage(c, id));
    const o = await this.db.one<{ seat_limit: number | null }>('SELECT seat_limit FROM organizations WHERE id = $1', [id]);
    return { ...s, seatLimit: o?.seat_limit ?? null };
  }

  @Doc('Set the seat limit, within the plan (null: the plan’s maximum)', { body: seatsBody })
  @SystemDb()
  @Patch('organizations/:id/seats')
  async setSeats(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    await this.requireManager(user, id);
    const { seatLimit } = parse(seatsBody, body);
    const o = await this.db.one<{ max_members: number }>('SELECT max_members FROM organizations WHERE id = $1', [id]);
    if (seatLimit !== null && seatLimit > o!.max_members) {
      throw new BadRequestException({ code: 'seat_limit_above_plan', max: o!.max_members, message: `Your plan allows at most ${o!.max_members} members. Ask ARC LABS for more.` });
    }
    // Lowering it below the current head count removes nobody; it only stops new people joining.
    await this.db.query('UPDATE organizations SET seat_limit = $2 WHERE id = $1', [id, seatLimit]);
    await this.audit.record({ ...actor(user), organizationId: id, action: 'organization.seats', resourceType: 'organization', resourceId: id, metadata: { seatLimit } });
    return { seatLimit, max: o!.max_members };
  }

  // ---------- receiving an invitation ----------

  @Doc('What an emailed invitation is for (organization, role, invited address)', { query: tokenQuery })
  @Public()
  @SystemDb()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('invitations/preview')
  async preview(@Query() q: unknown) {
    const { token } = parse(tokenQuery, q);
    const i = await this.db.one(
      `SELECT i.role, i.email, i.expires_at, i.revoked_at, i.used_count, i.max_uses, o.name AS org_name, u.display_name AS inviter
       FROM invite_codes i JOIN organizations o ON o.id = i.organization_id LEFT JOIN users u ON u.id = i.created_by
       WHERE i.code_hash = $1 AND i.kind = 'email'`,
      [tokenHash(token)],
    );
    if (!i || status(i) !== 'active') throw new NotFoundException({ code: 'invite_invalid', message: 'This invitation is not valid any more: it may have been used, revoked, or expired. Ask for a new one.' });
    return { organizationName: i.org_name, role: i.role, invitedBy: i.inviter ?? null, email: maskEmail(i.email), expiresAt: i.expires_at };
  }

  @Doc('Accept an emailed invitation (the signed-in account must have the invited, confirmed address)', { body: tokenBody })
  @SystemDb()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('invitations/accept')
  @HttpCode(200)
  async accept(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    requirePerson(user);
    const { token } = parse(tokenBody, body);
    return this.db.tx(async (c) => {
      const inv = (
        await c.query(
          `SELECT i.id, i.organization_id, i.role, i.email, i.expires_at, i.revoked_at, i.used_count, i.max_uses, o.name AS org_name
           FROM invite_codes i JOIN organizations o ON o.id = i.organization_id
           WHERE i.code_hash = $1 AND i.kind = 'email' FOR UPDATE OF i`,
          [tokenHash(token)],
        )
      ).rows[0];
      if (!inv || status(inv) !== 'active') throw new ForbiddenException({ code: 'invite_invalid', message: 'This invitation is not valid any more: it may have been used, revoked, or expired. Ask for a new one.' });
      // The guard already requires a confirmed address; it must be the invited one.
      if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new ForbiddenException({ code: 'invite_email_mismatch', email: maskEmail(inv.email), message: `This invitation is for ${maskEmail(inv.email)}. Sign in with that address to accept it.` });
      }
      const member = (await c.query('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [inv.organization_id, user.id])).rows[0];
      if (member) throw new ConflictException({ code: 'already_member', message: `You are already a member of ${inv.org_name}.` });
      // This invitation already holds a seat; a full organization (limit lowered since) still refuses.
      await requireSeat(c, inv.organization_id, { excludeInviteId: inv.id });
      await c.query(`UPDATE invite_codes SET used_count = 1, accepted_by = $2, accepted_at = now() WHERE id = $1`, [inv.id, user.id]);
      await c.query(`INSERT INTO organization_members (organization_id, user_id, role, invite_id) VALUES ($1, $2, $3, $4)`, [inv.organization_id, user.id, inv.role, inv.id]);
      // Joining an organization answers "who is this account for?" if it was still open.
      await c.query(`UPDATE users SET account_type = COALESCE(account_type, 'organization') WHERE id = $1`, [user.id]);
      await this.audit.record({ actorType: 'user', actorId: user.id, organizationId: inv.organization_id, action: 'invite.accept', resourceType: 'invite_code', resourceId: inv.id, metadata: { role: inv.role } }, c);
      return { organization: { id: inv.organization_id, name: inv.org_name, role: inv.role } };
    });
  }

  // ---------- helpers ----------

  /** Owner or admin of an organization (not a personal workspace). Returns the caller's role. */
  private async requireManager(user: AuthUser, orgId: string): Promise<CallerRole> {
    const role = await this.access.requireOrg(user, orgId, 'org_admin');
    const o = await this.db.one<{ kind: string }>('SELECT kind FROM organizations WHERE id = $1', [orgId]);
    if (o?.kind === 'personal') {
      throw new ConflictException({ code: 'personal_workspace', message: 'A personal workspace is just you. For a team, ask ARC LABS to set up an organization.' });
    }
    if (role === 'individual') throw new ForbiddenException({ code: 'insufficient_role' });
    return role;
  }

  private requireAssignable(caller: CallerRole, role: MemberRole) {
    if (!canAssign(caller, role)) throw new ForbiddenException({ code: 'role_not_assignable', message: 'Only the owner can invite admins.' });
  }
}
