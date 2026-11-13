import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { Db, dbScope } from '../db/db.service';
import { AuthUser } from './http';

const SYSTEM_DB = 'arcSystemDb';
/**
 * Marks a handler that must run without row-level security. Use only where the handler itself enforces
 * access and has to touch rows outside the caller's current organizations (e.g. creating an organization).
 */
export const SystemDb = () => SetMetadata(SYSTEM_DB, true);

/**
 * Pins the database scope for the rest of the request (after JwtAuthGuard has set req.user):
 *  - person            → the organizations they are a member of
 *  - API key / service account / LMS learner → their one organization
 *  - ARC LABS staff → their organizations and those with open support access (like any person)
 *  - public routes, @SystemDb handlers (platform endpoints among them) → system (no row-level security)
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  constructor(
    private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  private async orgIdsFor(user: AuthUser | undefined): Promise<string[] | null> {
    if (!user) return null;
    if (user.scope) return [user.scope.orgId];
    // ARC LABS staff are scoped like everyone else (no more blanket system access): their own organizations, plus
    // any they have open support access to. Platform endpoints run in system scope explicitly (@SystemDb).
    const rows = await this.db.query<{ organization_id: string }>(
      `SELECT organization_id FROM organization_members WHERE user_id = $1
       UNION
       SELECT organization_id FROM support_access WHERE $2 AND user_id = $1 AND ended_at IS NULL AND expires_at > now()`,
      [user.id, user.isPlatformAdmin],
    );
    return rows.map((r) => r.organization_id);
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const system = this.reflector.getAllAndOverride<boolean>(SYSTEM_DB, [ctx.getHandler(), ctx.getClass()]);
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    return new Observable((subscriber) => {
      let inner: { unsubscribe(): void } | undefined;
      (system ? Promise.resolve(null) : this.orgIdsFor(user))
        .then((orgIds) =>
          dbScope.run({ orgIds }, () => {
            inner = next.handle().subscribe(subscriber);
          }),
        )
        .catch((err) => subscriber.error(err));
      return () => inner?.unsubscribe();
    });
  }
}
