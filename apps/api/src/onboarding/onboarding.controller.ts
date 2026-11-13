/**
 * "Who are you?" (phase 3), asked once after the email address is confirmed:
 *  - an individual (engineer, teacher, trainer, hobbyist, other): a personal workspace on the free plan;
 *  - an organization (industry, corporate) or institution (school, college, university): created with an
 *    organization setup code from ARC LABS, bound to the person's address; they become its owner;
 *  - joining an existing organization: by emailed invitation or class code (InvitationsController, redeem-invite).
 * The answer never grants platform privileges.
 */
import { ApiTags } from '@nestjs/swagger';
import { Body, ConflictException, Controller, ForbiddenException, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuditService } from '../common/audit.service';
import { Doc } from '../common/docs';
import { AuthUser, CurrentUser, parse, requirePerson } from '../common/http';
import { hashInviteCode } from '../common/invites';
import { SystemDb } from '../common/tenant-scope.interceptor';
import { Db } from '../db/db.service';
import { PLANS } from '../organizations/org-ops.controller';

export const ORG_TYPES = ['industry', 'corporate', 'school', 'college', 'university'] as const;
export const PROFESSIONS = ['engineer', 'teacher', 'trainer', 'hobbyist', 'other'] as const;

const individualBody = z.object({ profession: z.enum(PROFESSIONS) });
const organizationBody = z.object({
  setupCode: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'slug: lowercase letters, digits and dashes'),
  /** Used when the setup code does not fix the type. */
  orgType: z.enum(ORG_TYPES).optional(),
});

@ApiTags('Onboarding')
@Controller('api/v1/onboarding')
export class OnboardingController {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Doc('I am an individual: say what you do (once); a personal workspace follows with the first channel', { body: individualBody })
  @SystemDb() // account-level audit row
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('individual')
  @HttpCode(200)
  async individual(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    requirePerson(user);
    const { profession } = parse(individualBody, body);
    return this.db.tx(async (c) => {
      const u = (await c.query<{ account_type: string | null }>('SELECT account_type FROM users WHERE id = $1 FOR UPDATE', [user.id])).rows[0];
      if (u.account_type) throw new ConflictException({ code: 'account_type_set' });
      await c.query(`UPDATE users SET account_type = 'individual', profession = $2 WHERE id = $1`, [user.id, profession]);
      await this.audit.record({ actorType: 'user', actorId: user.id, action: 'user.onboarding', resourceType: 'user', resourceId: user.id, metadata: { accountType: 'individual', profession } }, c);
      return { accountType: 'individual', profession };
    });
  }

  /**
   * Creates an organization with an ARC LABS setup code. The code is bound to the address it was issued for, works
   * once, and sets the plan (and possibly the type). A failure anywhere (taken short name, wrong address) rolls
   * everything back, so the code is not used up.
   */
  @Doc('Create your organization with an ARC LABS setup code; you become its owner', { body: organizationBody })
  @SystemDb() // the caller is not yet a member of the organization being created
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('organization')
  async organization(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    requirePerson(user);
    const input = parse(organizationBody, body);
    try {
      return await this.db.tx(async (c) => {
        const code = (
          await c.query<{ id: string; email: string; plan: string; org_type: string | null; label: string }>(
            `SELECT id, email, plan, org_type, label FROM invite_codes
             WHERE code_hash = $1 AND kind = 'org_setup' AND revoked_at IS NULL AND expires_at > now() AND used_count < max_uses
             FOR UPDATE`,
            [hashInviteCode(input.setupCode)],
          )
        ).rows[0];
        // Unknown, used, expired or revoked: one answer.
        if (!code) throw new ForbiddenException({ code: 'setup_code_invalid', message: 'This setup code is not valid: it may have been used, revoked, or expired. Ask ARC LABS for a new one.' });
        if (code.email.toLowerCase() !== user.email.toLowerCase()) {
          throw new ForbiddenException({ code: 'setup_code_email_mismatch', message: 'This setup code was issued for a different email address. Sign in with that address, or ask ARC LABS.' });
        }
        const orgType = code.org_type ?? input.orgType;
        if (!orgType) throw new ConflictException({ code: 'org_type_required', message: 'Choose what kind of organization this is.' });
        const p = PLANS[code.plan];
        const org = (
          await c.query(
            `INSERT INTO organizations (name, slug, created_by, kind, org_type, plan, max_devices, max_projects, max_rules, max_api_keys, max_webhooks, max_widgets, retention_days, max_members)
             VALUES ($1, $2, $3, 'organization', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id, name, slug`,
            [input.name, input.slug, user.id, orgType, code.plan, p.maxDevices, p.maxProjects, p.maxRules, p.maxApiKeys, p.maxWebhooks, p.maxWidgets, p.retentionDays, p.maxMembers],
          )
        ).rows[0];
        await c.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, [org.id, user.id]);
        await c.query(`UPDATE invite_codes SET used_count = 1, accepted_by = $2, accepted_at = now() WHERE id = $1`, [code.id, user.id]);
        await c.query(`UPDATE users SET account_type = COALESCE(account_type, 'organization') WHERE id = $1`, [user.id]);
        await this.audit.record(
          { actorType: 'user', actorId: user.id, organizationId: org.id, action: 'organization.create', resourceType: 'organization', resourceId: org.id, metadata: { kind: 'organization', role: 'owner', orgType, plan: code.plan, setupCodeId: code.id } },
          c,
        );
        return { organization: { id: org.id, name: org.name, slug: org.slug, orgType, plan: code.plan, role: 'owner' } };
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException({ code: 'slug_taken' });
      throw err;
    }
  }
}
