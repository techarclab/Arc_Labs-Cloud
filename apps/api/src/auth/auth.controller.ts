import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { loadConfig } from '../config';
import { AuditService } from '../common/audit.service';
import { hashSecret, verifySecret } from '../common/crypto';
import { AuthUser, CurrentUser, parse, Public } from '../common/http';
import { Db } from '../db/db.service';

const registerBody = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(12, 'password must be at least 12 characters').max(256),
});

const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});

// A fixed hash so login spends the same time whether or not the email exists.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * Built-in email/password auth for local development and early pilots.
 * For production, put an OIDC provider (e.g. Amazon Cognito) in front and map
 * `identity_provider_id`; the rest of the API only depends on the JWT `sub`.
 */
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  async register(@Body() body: unknown) {
    if (!loadConfig().ALLOW_SIGNUP) throw new ForbiddenException({ code: 'signup_disabled' });
    const input = parse(registerBody, body);
    const passwordHash = await hashSecret(input.password);
    try {
      const user = await this.db.one(
        `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3)
         RETURNING id, email, display_name, created_at`,
        [input.email, input.displayName, passwordHash],
      );
      await this.audit.record({ actorType: 'user', actorId: user.id, action: 'user.register', resourceType: 'user', resourceId: user.id });
      return { user: this.publicUser(user), ...(await this.issueToken(user.id)) };
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException({ code: 'email_taken' });
      throw err;
    }
  }

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

  @Get('me')
  async me(@CurrentUser() current: AuthUser) {
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
