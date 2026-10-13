import { isPlatformAdminEmail } from '../config';
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  ParseUUIDPipe,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { Db } from '../db/db.service';

/** Parse a request body/query with zod; throws 400 with the first issues. */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException({
      code: 'validation_failed',
      issues: result.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export const Uuid = () => new ParseUUIDPipe({ version: undefined });

/** Restriction carried by non-person callers (API keys, service accounts, LMS learners). */
export interface PrincipalScope {
  orgId: string;
  role: 'viewer' | 'engineer';
  projectIds: string[] | null;
  deviceIds: string[] | null;
  /** api_keys.id or lms_links.id */
  sourceId: string;
}

export interface AuthUser {
  id: string;
  email: string;
  isPlatformAdmin: boolean;
  kind?: 'user' | 'api_key' | 'service_account' | 'learner';
  scope?: PrincipalScope;
}

export const isPerson = (u: AuthUser) => !u.scope;
/** users.id for FK columns (NULL for API keys and other non-person callers). */
export const userRef = (u: AuthUser) => (u.scope ? null : u.id);
/** Audit actor for the caller. */
export const actor = (u: AuthUser) =>
  u.scope ? ({ actorType: 'service', actorId: `${u.kind}:${u.scope.sourceId}` } as const) : ({ actorType: 'user', actorId: u.id } as const);
/** Human-readable label for "requested by" columns. */
export const label = (u: AuthUser) => (u.scope ? `${u.kind?.replace('_', ' ')}: ${u.email}` : u.email);

export const API_KEY_PREFIX = 'arc_sk_';

const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

/** Global guard: every route needs a valid bearer token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException({ code: 'missing_token' });
    const token = header.slice(7).trim();

    // Organization API key: Authorization: Bearer arc_sk_...
    if (token.startsWith(API_KEY_PREFIX)) {
      req.user = await this.apiKeyPrincipal(token);
      return true;
    }

    let payload: { sub: string; typ?: string; lms?: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException({ code: 'invalid_token' });
    }
    if (payload.typ === 'svc') {
      req.user = await this.keyById(payload.sub, 'service_account');
      return true;
    }
    if (payload.typ === 'lab') {
      req.user = await this.learner(payload.sub, payload.lms ?? 'learner');
      return true;
    }
    // Re-check on every request so disabled users lose access immediately.
    const user = await this.db.one(
      `SELECT id, email, is_platform_admin FROM users WHERE id = $1 AND status = 'active'`,
      [payload.sub],
    );
    if (!user) throw new UnauthorizedException({ code: 'invalid_token' });
    req.user = { id: user.id, email: user.email, isPlatformAdmin: user.is_platform_admin || isPlatformAdminEmail(user.email), kind: 'user' } satisfies AuthUser;
    return true;
  }

  private async apiKeyPrincipal(secret: string): Promise<AuthUser> {
    const hash = createHash('sha256').update(secret).digest('hex');
    const key = await this.db.one(`SELECT id FROM api_keys WHERE key_hash = $1 AND kind = 'api_key'`, [hash]);
    if (!key) throw new UnauthorizedException({ code: 'invalid_token' });
    return this.keyById(key.id, 'api_key');
  }

  private async keyById(id: string, kind: 'api_key' | 'service_account'): Promise<AuthUser> {
    const key = await this.db.one(
      `UPDATE api_keys SET last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < now() - interval '1 minute' THEN now() ELSE last_used_at END
       WHERE id = $1 AND kind = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       RETURNING id, organization_id, name, role, project_ids`,
      [id, kind],
    );
    if (!key) throw new UnauthorizedException({ code: 'invalid_token' });
    return {
      id: key.id,
      email: key.name,
      isPlatformAdmin: false,
      kind,
      scope: { orgId: key.organization_id, role: key.role, projectIds: key.project_ids ?? null, deviceIds: null, sourceId: key.id },
    };
  }

  private async learner(linkId: string, learnerRef: string): Promise<AuthUser> {
    const link = await this.db.one(
      `SELECT id, organization_id, project_id, device_ids, title FROM lms_links WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [linkId],
    );
    if (!link) throw new UnauthorizedException({ code: 'invalid_token' });
    return {
      id: link.id,
      email: learnerRef,
      isPlatformAdmin: false,
      kind: 'learner',
      scope: { orgId: link.organization_id, role: 'viewer', projectIds: [link.project_id], deviceIds: link.device_ids ?? null, sourceId: link.id },
    };
  }
}

/** Rejects non-person callers (API keys, service accounts, learners) on person-only routes. */
export function requirePerson(u: AuthUser) {
  if (u.scope) throw new ForbiddenException({ code: 'person_only', message: 'This action needs a signed-in person, not an API key.' });
}

/** Optional `limit`/`offset` pagination shared by list endpoints. */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
