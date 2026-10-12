import {
  BadRequestException,
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

export interface AuthUser {
  id: string;
  email: string;
  isPlatformAdmin: boolean;
}

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

    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(header.slice(7));
    } catch {
      throw new UnauthorizedException({ code: 'invalid_token' });
    }
    // Re-check on every request so disabled users lose access immediately.
    const user = await this.db.one(
      `SELECT id, email, is_platform_admin FROM users WHERE id = $1 AND status = 'active'`,
      [payload.sub],
    );
    if (!user) throw new UnauthorizedException({ code: 'invalid_token' });
    req.user = { id: user.id, email: user.email, isPlatformAdmin: user.is_platform_admin } satisfies AuthUser;
    return true;
  }
}

/** Optional `limit`/`offset` pagination shared by list endpoints. */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
