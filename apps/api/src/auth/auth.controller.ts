import { ApiTags } from '@nestjs/swagger';
import { Doc } from '../common/docs';
import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { loadConfig } from '../config';
import { AuditService } from '../common/audit.service';
import { hashSecret, verifySecret } from '../common/crypto';
import { hashInviteCode, TERMS_VERSION } from '../common/invites';
import { AuthUser, CurrentUser, parse, Public } from '../common/http';
import { Db } from '../db/db.service';

const registerBody = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(12, 'password must be at least 12 characters').max(256),
  /** Required when sign-up is closed (ALLOW_SIGNUP=false); always checked when given. */
  inviteCode: z.string().trim().max(64).optional(),
  /** The person confirmed they are 18 or older and accepted the privacy notice (TERMS_VERSION). */
  acceptTerms: z.literal(true, { message: 'accept the privacy notice to create an account' }),
});

const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});

const googleLoginBody = z.object({ credential: z.string().min(1).max(8192) });

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
  ) {}

  @Doc('Register', { body: registerBody })
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  async register(@Body() body: unknown) {
    const input = parse(registerBody, body);
    if (!input.inviteCode && !loadConfig().ALLOW_SIGNUP) throw new ForbiddenException({ code: 'invite_required' });
    const passwordHash = await hashSecret(input.password);
    try {
      const user = await this.db.tx(async (c) => {
        // Claim one use of the invite atomically; a failed insert below rolls the claim back.
        let invite: { id: string; organization_id: string | null; role: string | null } | undefined;
        if (input.inviteCode) {
          invite = (
            await c.query(
              `UPDATE invite_codes SET used_count = used_count + 1
               WHERE code_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND used_count < max_uses
               RETURNING id, organization_id, role`,
              [hashInviteCode(input.inviteCode)],
            )
          ).rows[0];
          // One answer for unknown, expired, revoked and used-up codes: nothing to learn by guessing.
          if (!invite) throw new ForbiddenException({ code: 'invite_invalid' });
        }
        const u = (
          await c.query(
            `INSERT INTO users (email, display_name, password_hash, terms_accepted_at, terms_version, invite_id)
             VALUES ($1, $2, $3, now(), $4, $5)
             RETURNING id, email, display_name, created_at`,
            [input.email, input.displayName, passwordHash, TERMS_VERSION, invite?.id ?? null],
          )
        ).rows[0];
        if (invite?.organization_id) {
          await c.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)`, [invite.organization_id, u.id, invite.role]);
        }
        await this.audit.record(
          {
            actorType: 'user',
            actorId: u.id,
            organizationId: invite?.organization_id ?? undefined,
            action: 'user.register',
            resourceType: 'user',
            resourceId: u.id,
            metadata: { termsVersion: TERMS_VERSION, ...(invite ? { inviteId: invite.id } : {}) },
          },
          c,
        );
        return u;
      });
      return { user: this.publicUser(user), ...(await this.issueToken(user.id)) };
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
  async login(@Body() body: unknown) {
    const input = parse(loginBody, body);
    const user = await this.db.one(
      `SELECT id, email, display_name, password_hash, status, created_at FROM users WHERE email = $1`,
      [input.email],
    );
    const ok = await verifySecret(input.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || user.status !== 'active') throw new UnauthorizedException({ code: 'invalid_credentials' });
    return { user: this.publicUser(user), ...(await this.issueToken(user.id)) };
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
  async loginWithGoogle(@Body() body: unknown) {
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
          if (!account.identity_provider_id) {
            const linked = await client.query<GoogleUserRow>(
              `UPDATE users SET identity_provider_id = $1 WHERE id = $2 AND (identity_provider_id IS NULL OR identity_provider_id = $1)
               RETURNING id, email, display_name, identity_provider_id, status, created_at`,
              [identityProviderId, account.id],
            );
            account = linked.rows[0] ?? account;
          }
        } else {
          if (!config.ALLOW_SIGNUP) throw new ForbiddenException({ code: 'signup_disabled' });
          const created = await client.query<GoogleUserRow>(
            `INSERT INTO users (email, display_name, password_hash, identity_provider_id)
             VALUES ($1, $2, NULL, $3) ON CONFLICT DO NOTHING
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
            if (!account.identity_provider_id) {
              const linked = await client.query<GoogleUserRow>(
                `UPDATE users SET identity_provider_id = $1 WHERE id = $2 AND (identity_provider_id IS NULL OR identity_provider_id = $1)
                 RETURNING id, email, display_name, identity_provider_id, status, created_at`,
                [identityProviderId, account.id],
              );
              account = linked.rows[0] ?? account;
            }
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
    return { user: this.publicUser(user), ...(await this.issueToken(user.id)) };
  }

  @Doc('Me')
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
    const user = await this.db.one('SELECT id, email, display_name, created_at FROM users WHERE id = $1', [current.id]);
    const memberships = await this.db.query(
      `SELECT o.id, o.name, o.slug, m.role FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1 ORDER BY o.name`,
      [current.id],
    );
    return { user: this.publicUser(user), memberships, isPlatformAdmin: current.isPlatformAdmin };
  }

  private async issueToken(userId: string) {
    const ttl = loadConfig().JWT_TTL_SECONDS;
    const accessToken = await this.jwt.signAsync({ sub: userId }, { expiresIn: ttl });
    return { accessToken, tokenType: 'Bearer', expiresIn: ttl };
  }

  private publicUser(u: any) {
    return { id: u.id, email: u.email, displayName: u.display_name, createdAt: u.created_at };
  }
}
