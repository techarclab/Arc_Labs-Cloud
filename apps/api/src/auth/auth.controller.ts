import { ApiTags } from '@nestjs/swagger';
import { Doc } from '../common/docs';
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, HttpException, NotFoundException, Param, Patch, Post, Req, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { loadConfig } from '../config';
import { AuditService } from '../common/audit.service';
import { BrokerAdmin } from '../common/broker-admin.service';
import { readRefreshCookie, SessionsService } from '../common/sessions.service';
import { hashSecret, verifySecret } from '../common/crypto';
import { renderAccountEmail } from '../common/email';
import { grantInviteChannels, requireSeat } from '../common/seats';
import { hashInviteCode, TERMS_VERSION } from '../common/invites';
import { AllowIncomplete, AuthUser, CurrentUser, parse, Public, requirePerson, Uuid } from '../common/http';
import { SystemDb } from '../common/tenant-scope.interceptor';
import { Db } from '../db/db.service';

const registerBody = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(12, 'password must be at least 12 characters').max(256),
  /** Required for people under 18, and for everyone when sign-up is closed (ALLOW_SIGNUP=false); always checked when given. */
  inviteCode: z.string().trim().max(64).optional(),
  /** What the person declared: 18 or older, or under 18 (allowed only with an institution's invite code). */
  ageGroup: z.enum(['adult', 'minor'], { message: 'say whether you are 18 or older' }),
  /** The person accepted the privacy notice (TERMS_VERSION). */
  acceptTerms: z.literal(true, { message: 'accept the privacy notice to create an account' }),
});

const verifyEmailBody = z.object({ token: z.string().min(20).max(200) });
const completeProfileBody = z.object({ ageGroup: z.enum(['adult', 'minor']), inviteCode: z.string().trim().max(64).optional() });
/**
 * "Who is this account for?", answered once, after the email address is confirmed.
 *   individual    free plan, a personal workspace
 *   organization  needs an invite code from ARC LABS that adds the person to that organization
 *   other         free plan for now; `note` says what it is (a club, a research group…) so ARC LABS can follow up
 */
const accountTypeBody = z.object({
  accountType: z.enum(['individual', 'organization', 'other']),
  inviteCode: z.string().trim().max(64).optional(),
  note: z.string().trim().max(200).optional(),
});
const redeemInviteBody = z.object({ inviteCode: z.string().trim().min(1).max(64) });

const forgotPasswordBody = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const resetPasswordBody = z.object({ token: z.string().min(20).max(200), password: registerBody.shape.password });

/**
 * Deleting the account. `confirmEmail` must be the account's address (typed by the person, as the console's
 * confirmation challenge asks); `currentPassword` is required when the account has one.
 */
const deleteAccountBody = z.object({
  confirmEmail: z.string().trim().max(254),
  currentPassword: z.string().max(256).optional(),
});

type DeletionPlan = {
  /** Personal workspaces where the person is the only member: deleted with all their data. */
  deleteWorkspaces: { id: string; name: string; devices: number }[];
  /** Organizations the person just leaves (someone else stays admin, or they are not an admin). */
  leave: { id: string; name: string }[];
  /** Organizations the person owns: they must transfer ownership first (or ARC LABS closes the organization). */
  blockers: { id: string; name: string }[];
  platformAdmin: boolean;
};

const updateMeBody = z.object({ displayName: z.string().trim().min(1).max(120) });
const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: registerBody.shape.password });

const VERIFY_LINK_HOURS = 24;
const RESET_LINK_MINUTES = 60;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Invite = { id: string; organization_id: string | null; role: string | null };

const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});

const googleLoginBody = z.object({ credential: z.string().min(1).max(8192) });

const acceptTermsBody = z.object({
  /** The notice version the person was shown; must be the current one, so a stale page cannot record consent to new terms. */
  version: z.string().min(1).max(32),
  accept: z.literal(true),
});

type GoogleUserRow = {
  [column: string]: any;
  id: string;
  email: string;
  display_name: string;
  identity_provider_id: string | null;
  status: string;
  created_at: Date;
};

// A fixed hash so login spends the same time whether or not the email exists.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Email/password and Google Identity Services sign-in; the rest of the API uses the ARC Cloud JWT subject. */
@ApiTags('Auth')
@Controller('api/v1/auth')
export class AuthController {
  private readonly google = new OAuth2Client();

  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly broker: BrokerAdmin,
    private readonly sessions: SessionsService,
  ) {}

  @Doc('Register', { body: registerBody })
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  async register(@Body() body: unknown, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const input = parse(registerBody, body);
    const config = loadConfig();
    // Under-18s join only through an institution's invite code (the institution arranges a parent's consent).
    if (input.ageGroup === 'minor' && !input.inviteCode) throw new ForbiddenException({ code: 'minor_needs_invite' });
    if (!input.inviteCode && !config.ALLOW_SIGNUP) throw new ForbiddenException({ code: 'invite_required' });
    const verifyNow = config.EMAIL_VERIFICATION === 'off';
    const passwordHash = await hashSecret(input.password);
    try {
      const user = await this.db.tx(async (c) => {
        // Claim one use of the invite atomically; a failed insert below rolls the claim back.
        const invite = input.inviteCode ? await this.claimInvite(c, input.inviteCode) : undefined;
        const u = (
          await c.query(
            `INSERT INTO users (email, display_name, password_hash, terms_accepted_at, terms_version, invite_id, age_group, email_verified_at)
             VALUES ($1, $2, $3, now(), $4, $5, $6, CASE WHEN $7 THEN now() END)
             RETURNING id, email, display_name, created_at, email_verified_at`,
            [input.email, input.displayName, passwordHash, TERMS_VERSION, invite?.id ?? null, input.ageGroup, verifyNow],
          )
        ).rows[0];
        if (invite?.organization_id) {
          await requireSeat(c, invite.organization_id);
          await c.query(`INSERT INTO organization_members (organization_id, user_id, role, invite_id) VALUES ($1, $2, $3, $4)`, [invite.organization_id, u.id, invite.role, invite.id]);
          await grantInviteChannels(c, invite.id, u.id);
          // Joined an organization with the code: that answers "who is this account for?".
          await c.query(`UPDATE users SET account_type = 'organization' WHERE id = $1`, [u.id]);
          u.account_type = 'organization';
        }
        if (!verifyNow) await this.sendVerification(c, u.id, u.email, u.display_name);
        await this.audit.record(
          {
            actorType: 'user',
            actorId: u.id,
            organizationId: invite?.organization_id ?? undefined,
            action: 'user.register',
            resourceType: 'user',
            resourceId: u.id,
            metadata: { termsVersion: TERMS_VERSION, ageGroup: input.ageGroup, ...(invite ? { inviteId: invite.id } : {}) },
          },
          c,
        );
        return u;
      });
      return { user: { ...this.publicUser(user), emailVerified: !!user.email_verified_at, accountType: user.account_type ?? null }, ...(await this.sessions.signIn(user.id, req, res)) };
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException({ code: 'email_taken' });
      throw err;
    }
  }

  @Doc('Login', { body: loginBody })
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const input = parse(loginBody, body);
    const user = await this.db.one(
      `SELECT id, email, display_name, password_hash, status, created_at FROM users WHERE email = $1`,
      [input.email],
    );
    const ok = await verifySecret(input.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || user.status !== 'active') throw new UnauthorizedException({ code: 'invalid_credentials' });
    return { user: this.publicUser(user), ...(await this.sessions.signIn(user.id, req, res)) };
  }

  @Doc('Google sign-in configuration')
  @Public()
  @Get('google/config')
  googleConfig() {
    return { clientId: loadConfig().GOOGLE_CLIENT_ID ?? null };
  }

  @Doc('Sign in with Google', { body: googleLoginBody })
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('google')
  @HttpCode(200)
  async loginWithGoogle(@Body() body: unknown, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const config = loadConfig();
    if (!config.GOOGLE_CLIENT_ID) throw new ServiceUnavailableException({ code: 'google_signin_unconfigured' });
    const input = parse(googleLoginBody, body);

    let payload: { sub?: string; email?: string; email_verified?: boolean; name?: string } | undefined;
    try {
      const ticket = await this.google.verifyIdToken({ idToken: input.credential, audience: config.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException({ code: 'invalid_google_credential' });
    }
    const email = payload?.email?.trim();
    if (!payload?.sub || !email || payload.email_verified !== true) {
      throw new UnauthorizedException({ code: 'invalid_google_credential' });
    }

    const identityProviderId = `google:${payload.sub}`;
    const displayName = payload.name?.trim().slice(0, 120) || email.split('@')[0];
    const user = await this.db.tx(async (client) => {
      const byProvider = await client.query<GoogleUserRow>(
        `SELECT id, email, display_name, identity_provider_id, status, created_at
         FROM users WHERE identity_provider_id = $1 FOR UPDATE`,
        [identityProviderId],
      );
      let account = byProvider.rows[0];

      if (!account) {
        const byEmail = await client.query<GoogleUserRow>(
          `SELECT id, email, display_name, identity_provider_id, status, created_at
           FROM users WHERE email = $1 FOR UPDATE`,
          [email],
        );
        account = byEmail.rows[0];
        if (account) {
          if (account.identity_provider_id && account.identity_provider_id !== identityProviderId) {
            throw new ConflictException({ code: 'google_account_link_conflict' });
          }
          if (!account.identity_provider_id) account = (await this.linkGoogle(client, account.id, identityProviderId)) ?? account;
        } else {
          if (!config.ALLOW_SIGNUP) throw new ForbiddenException({ code: 'signup_disabled' });
          const created = await client.query<GoogleUserRow>(
            // Google has verified the address. Age group and consent are asked on first sign-in (complete-profile, TermsGate).
            `INSERT INTO users (email, display_name, password_hash, identity_provider_id, email_verified_at)
             VALUES ($1, $2, NULL, $3, now()) ON CONFLICT DO NOTHING
             RETURNING id, email, display_name, identity_provider_id, status, created_at`,
            [email, displayName, identityProviderId],
          );
          account = created.rows[0];

          // Another sign-in may have created the same email or Google identity concurrently.
          if (!account) {
            const raced = await client.query<GoogleUserRow>(
              `SELECT id, email, display_name, identity_provider_id, status, created_at
               FROM users WHERE identity_provider_id = $1 OR email = $2 FOR UPDATE`,
              [identityProviderId, email],
            );
            account = raced.rows.find((row) => row.identity_provider_id === identityProviderId) ?? raced.rows[0];
            if (!account || (account.identity_provider_id && account.identity_provider_id !== identityProviderId)) {
              throw new ConflictException({ code: 'google_account_link_conflict' });
            }
            if (!account.identity_provider_id) account = (await this.linkGoogle(client, account.id, identityProviderId)) ?? account;
          }
        }
      }

      if (!account || account.identity_provider_id !== identityProviderId) {
        throw new ConflictException({ code: 'google_account_link_conflict' });
      }
      if (account.status !== 'active') throw new UnauthorizedException({ code: 'account_disabled' });
      return account;
    });

    await this.audit.record({ actorType: 'user', actorId: user.id, action: 'user.google_login', resourceType: 'user', resourceId: user.id });
    return { user: this.publicUser(user), ...(await this.sessions.signIn(user.id, req, res)) };
  }

  @Doc('Me')
  @AllowIncomplete()
  @Get('me')
  async me(@CurrentUser() current: AuthUser) {
    if (current.scope) {
      // API keys, service accounts and LMS learners: describe the caller and its limits.
      return {
        user: { id: current.id, email: current.email, displayName: current.email, kind: current.kind },
        memberships: [{ id: current.scope.orgId, role: current.scope.role }],
        scope: current.scope,
        isPlatformAdmin: false,
      };
    }
    const user = await this.db.one(
      `SELECT id, email, display_name, created_at, terms_version, terms_accepted_at, email_verified_at, age_group, account_type, profession,
              password_hash IS NOT NULL AS has_password, identity_provider_id LIKE 'google:%' AS google
       FROM users WHERE id = $1`,
      [current.id],
    );
    const memberships = await this.db.query(
      `SELECT o.id, o.name, o.slug, m.role FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1 ORDER BY o.name`,
      [current.id],
    );
    return {
      user: {
        ...this.publicUser(user),
        termsVersion: user.terms_version ?? null,
        termsAcceptedAt: user.terms_accepted_at ?? null,
        /** False until the person opens the link we emailed; the console then shows only the "check your inbox" screen. */
        emailVerified: !!user.email_verified_at,
        /** Null for Google sign-ups that have not said yet; the console asks before anything else. */
        ageGroup: user.age_group ?? null,
        /** 'individual', 'organization' or 'other'; null until the person answers (after confirming the email). */
        accountType: user.account_type ?? null,
        /** Individuals: engineer, teacher, trainer, hobbyist or other. */
        profession: user.profession ?? null,
        emailVerifiedAt: user.email_verified_at ?? null,
        /** How this person can sign in (for the profile page). */
        signIn: { password: !!user.has_password, google: !!user.google },
      },
      memberships,
      isPlatformAdmin: current.isPlatformAdmin,
      /** The privacy notice version in force; the console asks the person to accept it when user.termsVersion differs. */
      currentTermsVersion: TERMS_VERSION,
    };
  }

  @Doc('Accept the current privacy notice', { body: acceptTermsBody })
  @AllowIncomplete()
  @SystemDb() // the audit row belongs to no organization, which tenant row-level security would refuse
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept-terms')
  @HttpCode(200)
  async acceptTerms(@CurrentUser() current: AuthUser, @Body() body: unknown) {
    // Only a person can consent; API keys, service accounts and LMS learner links cannot.
    if (current.scope) throw new ForbiddenException({ code: 'person_required' });
    const input = parse(acceptTermsBody, body);
    if (input.version !== TERMS_VERSION) throw new ConflictException({ code: 'terms_version_changed', currentTermsVersion: TERMS_VERSION });
    const row = await this.db.one<{ terms_version: string; terms_accepted_at: Date }>(
      `UPDATE users SET terms_version = $2, terms_accepted_at = now() WHERE id = $1 RETURNING terms_version, terms_accepted_at`,
      [current.id, TERMS_VERSION],
    );
    await this.audit.record({
      actorType: 'user',
      actorId: current.id,
      action: 'user.accept_terms',
      resourceType: 'user',
      resourceId: current.id,
      metadata: { termsVersion: TERMS_VERSION },
    });
    return { termsVersion: row!.terms_version, termsAcceptedAt: row!.terms_accepted_at };
  }

  @Doc('Confirm an email address with the token from the emailed link', { body: verifyEmailBody })
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() body: unknown) {
    const { token } = parse(verifyEmailBody, body);
    const userId = await this.db.tx(async (c) => {
      const t = (
        await c.query<{ user_id: string; email: string }>(
          `UPDATE email_verifications SET used_at = now()
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id, email`,
          [sha256(token)],
        )
      ).rows[0];
      // The address must still be the one the link was sent to.
      const u = t && (await c.query<{ id: string }>(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1 AND email = $2 RETURNING id`, [t.user_id, t.email])).rows[0];
      if (!u) throw new BadRequestException({ code: 'verification_invalid', message: 'This link is invalid, used already, or expired. Sign in and ask for a new one.' });
      await this.audit.record({ actorType: 'user', actorId: u.id, action: 'user.verify_email', resourceType: 'user', resourceId: u.id }, c);
      return u.id;
    });
    return { verified: true, userId };
  }

  @Doc('Send the email-confirmation link again')
  @AllowIncomplete()
  @SystemDb()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(@CurrentUser() current: AuthUser) {
    requirePerson(current);
    const u = await this.db.one('SELECT id, email, display_name, email_verified_at FROM users WHERE id = $1', [current.id]);
    if (u.email_verified_at) return { alreadyVerified: true };
    const recent = await this.db.one<{ last: Date | null; n: number }>(
      `SELECT max(created_at) AS last, count(*)::int AS n FROM email_verifications WHERE user_id = $1 AND created_at > now() - interval '24 hours'`,
      [u.id],
    );
    if (recent?.last && Date.now() - new Date(recent.last).getTime() < 60_000) {
      throw new HttpException({ code: 'resend_too_soon', message: 'We just sent a link. Wait a minute before asking again.' }, 429);
    }
    if ((recent?.n ?? 0) >= 5) throw new HttpException({ code: 'resend_limit', message: 'Too many links today. Try again tomorrow, or contact ARC LABS.' }, 429);
    await this.db.tx((c) => this.sendVerification(c, u.id, u.email, u.display_name));
    return { sent: true, email: u.email };
  }

  @Doc('Finish an account created through Google: age group (and an invite code for under-18s)', { body: completeProfileBody })
  @AllowIncomplete()
  @SystemDb()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('complete-profile')
  @HttpCode(200)
  async completeProfile(@CurrentUser() current: AuthUser, @Body() body: unknown) {
    requirePerson(current);
    const input = parse(completeProfileBody, body);
    if (input.ageGroup === 'minor' && !input.inviteCode) throw new ForbiddenException({ code: 'minor_needs_invite' });
    return this.db.tx(async (c) => {
      const u = (await c.query('SELECT id, age_group FROM users WHERE id = $1 FOR UPDATE', [current.id])).rows[0];
      if (u.age_group) throw new ConflictException({ code: 'profile_complete' });
      const invite = input.inviteCode ? await this.claimInvite(c, input.inviteCode) : undefined;
      await c.query('UPDATE users SET age_group = $2, invite_id = COALESCE(invite_id, $3) WHERE id = $1', [u.id, input.ageGroup, invite?.id ?? null]);
      if (invite?.organization_id) {
        await requireSeat(c, invite.organization_id);
        await c.query(`INSERT INTO organization_members (organization_id, user_id, role, invite_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [invite.organization_id, u.id, invite.role, invite.id]);
        await grantInviteChannels(c, invite.id, u.id);
        await c.query(`UPDATE users SET account_type = COALESCE(account_type, 'organization') WHERE id = $1`, [u.id]);
      }
      await this.audit.record(
        { actorType: 'user', actorId: u.id, organizationId: invite?.organization_id ?? undefined, action: 'user.complete_profile', resourceType: 'user', resourceId: u.id, metadata: { ageGroup: input.ageGroup, ...(invite ? { inviteId: invite.id } : {}) } },
        c,
      );
      return { ageGroup: input.ageGroup };
    });
  }

  @Doc('Join an organization with an invite code from ARC LABS or your institution', { body: redeemInviteBody })
  @SystemDb()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('redeem-invite')
  @HttpCode(200)
  async redeemInvite(@CurrentUser() current: AuthUser, @Body() body: unknown) {
    requirePerson(current);
    const { inviteCode } = parse(redeemInviteBody, body);
    return this.db.tx(async (c) => {
      const invite = (
        await c.query<Invite & { name: string }>(
          `SELECT i.id, i.organization_id, i.role, o.name FROM invite_codes i JOIN organizations o ON o.id = i.organization_id
           WHERE i.code_hash = $1 AND i.kind IN ('platform', 'class') AND i.revoked_at IS NULL AND i.expires_at > now() AND i.used_count < i.max_uses FOR UPDATE OF i`,
          [hashInviteCode(inviteCode)],
        )
      ).rows[0];
      // Unknown, expired, revoked, used-up, or a code that only creates accounts: one answer.
      if (!invite) throw new ForbiddenException({ code: 'invite_invalid', message: 'This code is not valid for joining an organization. It may have expired or been used up.' });
      const already = (await c.query('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [invite.organization_id, current.id])).rows[0];
      if (already) throw new ConflictException({ code: 'already_member', message: `You are already a member of ${invite.name}.` });
      await requireSeat(c, invite.organization_id!);
      await c.query('UPDATE invite_codes SET used_count = used_count + 1 WHERE id = $1', [invite.id]);
      await c.query(`INSERT INTO organization_members (organization_id, user_id, role, invite_id) VALUES ($1, $2, $3, $4)`, [invite.organization_id, current.id, invite.role, invite.id]);
      await grantInviteChannels(c, invite.id, current.id);
      await this.audit.record(
        { actorType: 'user', actorId: current.id, organizationId: invite.organization_id!, action: 'user.join_organization', resourceType: 'organization', resourceId: invite.organization_id!, metadata: { inviteId: invite.id, role: invite.role } },
        c,
      );
      return { organization: { id: invite.organization_id, name: invite.name, role: invite.role } };
    });
  }

  @Doc('Say who the account is for (once, after confirming the email); organizations join with an ARC LABS invite code', { body: accountTypeBody })
  @SystemDb()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('account-type')
  @HttpCode(200)
  async setAccountType(@CurrentUser() current: AuthUser, @Body() body: unknown) {
    requirePerson(current);
    const input = parse(accountTypeBody, body);
    // Organizations join only through ARC LABS, so an organization account must come with a code.
    if (input.accountType === 'organization' && !input.inviteCode) throw new ForbiddenException({ code: 'organization_needs_invite' });
    return this.db.tx(async (c) => {
      const u = (await c.query<{ account_type: string | null }>('SELECT account_type FROM users WHERE id = $1 FOR UPDATE', [current.id])).rows[0];
      if (u.account_type) throw new ConflictException({ code: 'account_type_set' });
      let organization: { id: string; name: string; role: string } | undefined;
      if (input.accountType === 'organization') {
        const invite = (
          await c.query<Invite & { name: string }>(
            `SELECT i.id, i.organization_id, i.role, o.name FROM invite_codes i JOIN organizations o ON o.id = i.organization_id
             WHERE i.code_hash = $1 AND i.kind IN ('platform', 'class') AND i.revoked_at IS NULL AND i.expires_at > now() AND i.used_count < i.max_uses FOR UPDATE OF i`,
            [hashInviteCode(input.inviteCode!)],
          )
        ).rows[0];
        // Unknown, expired, revoked, used up, or a code that only creates accounts: one answer.
        if (!invite) throw new ForbiddenException({ code: 'invite_not_for_organization' });
        const member = (await c.query('SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2', [invite.organization_id, current.id])).rowCount;
        if (!member) await requireSeat(c, invite.organization_id!);
        const joined = await c.query(
          `INSERT INTO organization_members (organization_id, user_id, role, invite_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING user_id`,
          [invite.organization_id, current.id, invite.role, invite.id],
        );
        // Already a member (e.g. joined at sign-up with this code): no second use.
        if (joined.rowCount) {
          await c.query('UPDATE invite_codes SET used_count = used_count + 1 WHERE id = $1', [invite.id]);
          await grantInviteChannels(c, invite.id, current.id);
        }
        organization = { id: invite.organization_id!, name: invite.name, role: invite.role! };
      }
      const note = input.accountType === 'other' ? input.note || null : null;
      await c.query('UPDATE users SET account_type = $2, account_type_note = $3 WHERE id = $1', [current.id, input.accountType, note]);
      await this.audit.record(
        {
          actorType: 'user',
          actorId: current.id,
          organizationId: organization?.id,
          action: 'user.account_type',
          resourceType: 'user',
          resourceId: current.id,
          metadata: { accountType: input.accountType, ...(note ? { note } : {}), ...(organization ? { organizationId: organization.id } : {}) },
        },
        c,
      );
      return { accountType: input.accountType, ...(organization ? { organization } : {}) };
    });
  }

  @Doc('Email a link to set a new password. Same answer whether or not the address has an account', { body: forgotPasswordBody })
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() body: unknown) {
    const { email } = parse(forgotPasswordBody, body);
    const answer = { sent: true, message: 'If an ARC Cloud account uses that address, we have emailed it a link to set a new password.' };
    const u = await this.db.one<{ id: string; email: string; display_name: string }>(
      `SELECT id, email, display_name FROM users WHERE email = $1 AND status = 'active'`,
      [email],
    );
    if (!u) return answer; // no account: send nothing, say the same
    await this.db.tx(async (c) => {
      // At most 3 links an hour per account (on top of the per-IP limit); silently, so the answer reveals nothing.
      const recent = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [u.id])).rows[0].n;
      if (recent >= 3) return;
      const token = randomBytes(32).toString('base64url');
      await c.query(`INSERT INTO password_resets (token_hash, user_id, email, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`, [
        sha256(token),
        u.id,
        u.email,
        RESET_LINK_MINUTES,
      ]);
      const link = `${loadConfig().CONSOLE_URL.replace(/\/+$/, '')}/reset-password#token=${token}`;
      const { html, text } = renderAccountEmail({
        preheader: `Choose a new password. The link expires in ${RESET_LINK_MINUTES} minutes.`,
        heading: 'Set a new password',
        greeting: `Hi ${u.display_name},`,
        intro: 'Someone, hopefully you, asked to set a new password for your ARC Cloud account. Press the button to choose one.',
        button: { label: 'Set a new password', url: link },
        notes: [
          `The link works once and expires in ${RESET_LINK_MINUTES} minutes. Setting a new password signs you out on every other device.`,
          'If you did not ask for this, ignore this email: your password stays the same.',
        ],
      });
      await c.query(`INSERT INTO deliveries (organization_id, kind, recipient, event_type, payload) VALUES (NULL, 'email', $1, 'auth.password_reset', $2)`, [
        u.email,
        { subject: 'Set a new password for ARC Cloud', text, html },
      ]);
      await this.audit.record({ actorType: 'user', actorId: u.id, action: 'user.password_reset_requested', resourceType: 'user', resourceId: u.id }, c);
    });
    return answer;
  }

  @Doc('Set a new password with the token from the emailed link; signs out every other session', { body: resetPasswordBody })
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() body: unknown, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const input = parse(resetPasswordBody, body);
    const passwordHash = await hashSecret(input.password);
    const userId = await this.db.tx(async (c) => {
      const t = (
        await c.query<{ user_id: string; email: string }>(
          `UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id, email`,
          [sha256(input.token)],
        )
      ).rows[0];
      // Opening the link proves the address, so it also counts as confirming it.
      const u =
        t &&
        (
          await c.query<{ id: string }>(
            `UPDATE users SET password_hash = $3, sessions_revoked_at = date_trunc('second', now()), email_verified_at = COALESCE(email_verified_at, now())
             WHERE id = $1 AND email = $2 AND status = 'active' RETURNING id`,
            [t.user_id, t.email, passwordHash],
          )
        ).rows[0];
      if (!u) throw new BadRequestException({ code: 'reset_invalid', message: 'This link is invalid, already used, or expired. Ask for a new one.' });
      await c.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [u.id]); // other open links die too
      await this.audit.record({ actorType: 'user', actorId: u.id, action: 'user.password_reset', resourceType: 'user', resourceId: u.id }, c);
      return u.id;
    });
    // A new password ends every session (the old one may be known to someone else); this browser gets a new one.
    await this.sessions.revokeAll(userId, 'password_reset');
    return { reset: true, ...(await this.sessions.signIn(userId, req, res)) };
  }

  @Doc('Change your display name', { body: updateMeBody })
  @SystemDb() // account-level audit row (no organization)
  @Patch('me')
  async updateMe(@CurrentUser() current: AuthUser, @Body() body: unknown) {
    requirePerson(current);
    const { displayName } = parse(updateMeBody, body);
    const u = await this.db.one('UPDATE users SET display_name = $2 WHERE id = $1 RETURNING id, email, display_name, created_at', [current.id, displayName]);
    await this.audit.record({ actorType: 'user', actorId: current.id, action: 'user.update_profile', resourceType: 'user', resourceId: current.id });
    return { user: this.publicUser(u) };
  }

  @Doc('Change your password (needs the current one); signs out every other session', { body: changePasswordBody })
  @SystemDb() // account-level audit row (no organization)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(200)
  async changePassword(@CurrentUser() current: AuthUser, @Body() body: unknown, @Req() req: any, @Res({ passthrough: true }) res: any) {
    requirePerson(current);
    const input = parse(changePasswordBody, body);
    const u = await this.db.one<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [current.id]);
    // Google-only accounts set a first password through the emailed link (proves the mailbox, not just a session).
    if (!u?.password_hash) throw new ConflictException({ code: 'no_password', message: 'You sign in with Google. To add a password, use “Forgot password?” on the sign-in page.' });
    if (!(await verifySecret(input.currentPassword, u.password_hash))) throw new ForbiddenException({ code: 'wrong_password', message: 'The current password is not right.' });
    await this.db.query(`UPDATE users SET password_hash = $2, sessions_revoked_at = date_trunc('second', now()) WHERE id = $1`, [current.id, await hashSecret(input.newPassword)]);
    await this.audit.record({ actorType: 'user', actorId: current.id, action: 'user.change_password', resourceType: 'user', resourceId: current.id });
    await this.sessions.revokeAll(current.id, 'password_change', current.sessionId);
    // This browser stays signed in: its session goes on, with a token newer than the cut-off above.
    return { changed: true, ...(current.sessionId ? await this.sessions.accessToken(current.id, current.sessionId) : await this.sessions.signIn(current.id, req, res)) };
  }

  @Doc('Sign out on every device, including this one')
  @SystemDb() // account-level audit row (no organization)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('sign-out-everywhere')
  @HttpCode(200)
  async signOutEverywhere(@CurrentUser() current: AuthUser, @Res({ passthrough: true }) res: any) {
    requirePerson(current);
    await this.sessions.revokeAll(current.id, 'sign_out_everywhere');
    this.sessions.clearCookie(res);
    // Round up to the next second, so a token issued earlier in this same second is refused too.
    await this.db.query(`UPDATE users SET sessions_revoked_at = date_trunc('second', now()) + interval '1 second' WHERE id = $1`, [current.id]);
    await this.audit.record({ actorType: 'user', actorId: current.id, action: 'user.sign_out_everywhere', resourceType: 'user', resourceId: current.id });
    return { signedOut: true };
  }

  @Doc('What deleting your account would delete, leave or block')
  @SystemDb()
  @Get('delete-account')
  async deleteAccountPreview(@CurrentUser() current: AuthUser) {
    requirePerson(current);
    return this.db.tx((c) => this.deletionPlan(c, current.id, current.isPlatformAdmin));
  }

  @Doc('Delete your account for good: your personal workspaces with their devices and data, and your memberships', { body: deleteAccountBody })
  @SystemDb() // removes rows in workspaces the person owns, and an account-level audit row
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('delete-account')
  @HttpCode(200)
  async deleteAccount(@CurrentUser() current: AuthUser, @Body() body: unknown, @Res({ passthrough: true }) res: any) {
    requirePerson(current);
    const input = parse(deleteAccountBody, body);
    const u = await this.db.one<{ email: string; password_hash: string | null }>('SELECT email, password_hash FROM users WHERE id = $1', [current.id]);
    if (!u) throw new UnauthorizedException({ code: 'invalid_token' });
    if (input.confirmEmail.toLowerCase() !== u.email.toLowerCase()) {
      throw new BadRequestException({ code: 'confirm_email_mismatch', message: 'Type your account’s email address exactly to confirm.' });
    }
    if (u.password_hash && !(await verifySecret(input.currentPassword ?? '', u.password_hash))) {
      throw new ForbiddenException({ code: 'wrong_password', message: 'The current password is not right.' });
    }

    const { plan, deviceIds } = await this.db.tx(async (c) => {
      // Lock the account first, so two requests cannot both run.
      await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [current.id]);
      const plan = await this.deletionPlan(c, current.id, current.isPlatformAdmin);
      if (plan.platformAdmin) {
        throw new ConflictException({ code: 'platform_admin_delete', message: 'ARC LABS staff accounts must have platform admin removed (operator tool) before they can be deleted.' });
      }
      if (plan.blockers.length) {
        throw new ConflictException({
          code: 'sole_admin',
          organizations: plan.blockers,
          message: `You own ${plan.blockers.map((o) => o.name).join(', ')}. Transfer ownership to an admin there first (Team page), or ask ARC LABS to close it.`,
        });
      }
      const deviceIds: string[] = [];
      for (const w of plan.deleteWorkspaces) {
        const ids = (await c.query<{ id: string }>('SELECT id FROM devices WHERE organization_id = $1', [w.id])).rows.map((r) => r.id);
        deviceIds.push(...ids);
        // These tables have no foreign key to the workspace (telemetry is a hypertable on TimescaleDB), so clear them first.
        await c.query('DELETE FROM telemetry_measurements WHERE organization_id = $1', [w.id]);
        await c.query('DELETE FROM ingested_messages WHERE device_id = ANY($1::uuid[])', [ids]);
        await c.query('DELETE FROM rejected_messages WHERE organization_id = $1', [w.id]);
        await c.query('DELETE FROM audit_logs WHERE organization_id = $1', [w.id]);
        // Everything else (channels, devices, credentials, alerts, rules, keys, webhooks, firmware…) cascades.
        await c.query('DELETE FROM organizations WHERE id = $1', [w.id]);
      }
      // Account emails still waiting to be sent to this address.
      await c.query(`DELETE FROM deliveries WHERE organization_id IS NULL AND recipient = $1 AND status = 'pending'`, [u.email]);
      // Memberships, sessions, verification and reset links cascade; "created by" columns elsewhere become empty.
      await c.query('DELETE FROM users WHERE id = $1', [current.id]);
      // A security record without personal data: the id only, no email or name.
      await this.audit.record(
        {
          actorType: 'user',
          actorId: current.id,
          action: 'user.delete',
          resourceType: 'user',
          resourceId: current.id,
          metadata: { deletedWorkspaces: plan.deleteWorkspaces.length, deletedDevices: deviceIds.length, leftOrganizations: plan.leave.length },
        },
        c,
      );
      return { plan, deviceIds };
    });
    // The devices' credentials are gone: end any live broker sessions now rather than at the next ACL check.
    await Promise.all(deviceIds.map((id) => this.broker.disconnect(id)));
    this.sessions.clearCookie(res);
    return { deleted: true, deletedWorkspaces: plan.deleteWorkspaces.length, deletedDevices: deviceIds.length, leftOrganizations: plan.leave.length };
  }

  private async deletionPlan(c: any, userId: string, platformAdmin: boolean): Promise<DeletionPlan> {
    const rows = (
      await c.query(
        `SELECT o.id, o.name, o.kind, m.role,
                (SELECT count(*)::int FROM organization_members x WHERE x.organization_id = o.id AND x.user_id <> $1) AS others,
                (SELECT count(*)::int FROM devices d WHERE d.organization_id = o.id) AS devices
         FROM organization_members m JOIN organizations o ON o.id = m.organization_id
         WHERE m.user_id = $1 ORDER BY o.name`,
        [userId],
      )
    ).rows as { id: string; name: string; kind: string; role: string; others: number; devices: number }[];
    const plan: DeletionPlan = { deleteWorkspaces: [], leave: [], blockers: [], platformAdmin };
    for (const o of rows) {
      // Members (admins included: the owner stays) just leave.
      if (o.role !== 'owner' && o.role !== 'individual') plan.leave.push({ id: o.id, name: o.name });
      // Only a personal workspace with nobody else in it is deleted; an organization ARC LABS set up never is.
      else if (o.role === 'individual' && o.others === 0 && o.kind === 'personal') plan.deleteWorkspaces.push({ id: o.id, name: o.name, devices: o.devices });
      // The owner of an organization: transfer ownership first (or ARC LABS closes it).
      else plan.blockers.push({ id: o.id, name: o.name });
    }
    return plan;
  }

  /**
   * Links a Google identity to an existing account with the same (Google-verified) address.
   *
   * If that account never confirmed its address, someone else may have registered it first with a password of
   * their choosing, waiting for the real owner to sign in with Google and start using it (account pre-hijacking).
   * So the password is removed and every earlier session is signed out: from now on only the address's owner gets
   * in (with Google, or with a password they set through "Forgot password?", which emails that address).
   */
  private async linkGoogle(c: any, userId: string, identityProviderId: string): Promise<GoogleUserRow | undefined> {
    // The caller holds the row lock (SELECT … FOR UPDATE), so this answer cannot change before the UPDATE.
    const unconfirmed = (await c.query('SELECT email_verified_at IS NULL AS u FROM users WHERE id = $1', [userId])).rows[0]?.u === true;
    const row = (
      await c.query(
        `UPDATE users SET identity_provider_id = $1, email_verified_at = COALESCE(email_verified_at, now())
           ${unconfirmed ? ", password_hash = NULL, sessions_revoked_at = date_trunc('second', now())" : ''}
         WHERE id = $2 AND (identity_provider_id IS NULL OR identity_provider_id = $1)
         RETURNING id, email, display_name, identity_provider_id, status, created_at`,
        [identityProviderId, userId],
      )
    ).rows[0];
    if (row && unconfirmed) {
      await this.audit.record(
        { actorType: 'user', actorId: row.id, action: 'user.google_link_unconfirmed', resourceType: 'user', resourceId: row.id, metadata: { passwordRemoved: true, sessionsRevoked: true } },
        c,
      );
    }
    return row;
  }

  @Doc('Renew the access token with the session cookie (rotates the refresh token)')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: any, @Res({ passthrough: true }) res: any) {
    return this.sessions.refresh(req, res);
  }

  @Doc('Log out: end this session (the cookie’s, and the token’s if given) and clear the cookie')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: any, @Res({ passthrough: true }) res: any) {
    const c = readRefreshCookie(req);
    if (c) {
      // Only with the cookie's own secret: knowing a session id is not enough to end someone's session.
      const s = await this.db.one<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM sessions WHERE id = $1 AND (refresh_hash = $2 OR prev_refresh_hash = $2)`,
        [c.sid, sha256(c.secret)],
      );
      if (s) await this.sessions.revoke(s.id, s.user_id, 'logout');
    }
    this.sessions.clearCookie(res);
  }

  @Doc('Your signed-in devices (sessions)')
  @SystemDb()
  @Get('sessions')
  async listSessions(@CurrentUser() current: AuthUser) {
    requirePerson(current);
    return { items: await this.sessions.list(current.id, current.sessionId) };
  }

  @Doc('Sign out one device (end one of your sessions)')
  @SystemDb()
  @Delete('sessions/:id')
  @HttpCode(204)
  async endSession(@CurrentUser() current: AuthUser, @Param('id', Uuid()) id: string) {
    requirePerson(current);
    if (!(await this.sessions.revoke(id, current.id, 'signed_out_from_account'))) throw new NotFoundException({ code: 'not_found' });
    await this.audit.record({ actorType: 'user', actorId: current.id, action: 'user.session_end', resourceType: 'user', resourceId: current.id, metadata: { sessionId: id } });
  }

  /** Claims one use of an invite code inside the caller's transaction; one answer for every kind of bad code. */
  private async claimInvite(c: any, code: string): Promise<Invite> {
    const invite = (
      await c.query(
        `UPDATE invite_codes SET used_count = used_count + 1
         WHERE code_hash = $1 AND kind IN ('platform', 'class') AND revoked_at IS NULL AND expires_at > now() AND used_count < max_uses
         RETURNING id, organization_id, role`,
        [hashInviteCode(code)],
      )
    ).rows[0];
    if (!invite) throw new ForbiddenException({ code: 'invite_invalid' });
    return invite;
  }

  /** Stores a single-use link (hash only) and queues the email; the worker sends it through SMTP_URL. */
  private async sendVerification(c: any, userId: string, email: string, name: string) {
    const token = randomBytes(32).toString('base64url');
    await c.query(`INSERT INTO email_verifications (token_hash, user_id, email, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`, [
      sha256(token),
      userId,
      email,
      VERIFY_LINK_HOURS,
    ]);
    // In the URL fragment, so the token is never sent to a server or written to access logs.
    const link = `${loadConfig().CONSOLE_URL.replace(/\/+$/, '')}/verify-email#token=${token}`;
    const { html, text } = renderAccountEmail({
      preheader: 'One click and your ARC Cloud account is ready.',
      heading: 'Confirm your email',
      greeting: `Hi ${name},`,
      intro: 'Welcome to ARC Cloud. Confirm your email address to start connecting your devices.',
      button: { label: 'Confirm my email', url: link },
      steps: [
        'Tell us who the account is for: just you, your college, school or company, or something else.',
        'Just you: create your first channel; the free plan covers up to 5 devices. An organization: enter the invite code ARC LABS gave you.',
        'Connect an ESP32, ESP8266 or Raspberry Pi over MQTT or HTTP and watch its readings live.',
      ],
      notes: [
        `The button works once and expires in ${VERIFY_LINK_HOURS} hours. Open it on any device; you can sign in afterwards.`,
        'If you did not create an ARC Cloud account, ignore this email; nothing will happen.',
      ],
    });
    await c.query(
      `INSERT INTO deliveries (organization_id, kind, recipient, event_type, payload) VALUES (NULL, 'email', $1, 'auth.verify_email', $2)`,
      [email, { subject: 'Confirm your email for ARC Cloud', text, html }],
    );
  }


  private publicUser(u: any) {
    return { id: u.id, email: u.email, displayName: u.display_name, createdAt: u.created_at };
  }
}
