import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadConfig } from '../config';

export type Queryable = Pick<PoolClient, 'query'>;

/**
 * Database scope of the current request (see infra/db/migrations/004_row_level_security.sql).
 *  - `orgIds: null`  → system: runs as the connection role, row-level security does not apply
 *    (workers, broker hooks, device HTTP lookups, sign-in, platform admins).
 *  - `orgIds: [...]` → tenant: every statement runs as `arc_tenant` with those organizations pinned,
 *    so Postgres itself hides other tenants' rows even if a query forgets its organization filter.
 * Set per request by TenantScopeInterceptor; absent (no store) means system.
 */
export interface DbScope {
  orgIds: string[] | null;
}
export const dbScope = new AsyncLocalStorage<DbScope>();
export const TENANT_ROLE = 'arc_tenant';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: loadConfig().DATABASE_URL, max: 10 });

  /** A Queryable that honours the current scope (use instead of `pool` as a default argument). */
  readonly scoped: Queryable = { query: ((sql: string, params?: unknown[]) => this.raw(sql, params ?? [])) as Queryable['query'] };

  private tenantOrgs(): string[] | null {
    const s = dbScope.getStore();
    if (!s || s.orgIds === null) return null;
    for (const id of s.orgIds) if (!UUID.test(id)) throw new Error('invalid organization id in db scope');
    return s.orgIds;
  }

  /** Applies the tenant role + organizations to an open transaction. */
  private async applyScope(c: PoolClient, orgIds: string[]) {
    await c.query(`SELECT set_config('role', $1, true), set_config('arc.org_ids', $2, true)`, [TENANT_ROLE, orgIds.join(',')]);
  }

  async raw<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (this.tenantOrgs() === null) return this.pool.query<T>(sql, params);
    return this.tx((c) => c.query<T>(sql, params));
  }

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.raw<T>(sql, params)).rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const orgIds = this.tenantOrgs();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (orgIds !== null) await this.applyScope(client, orgIds);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Runs `fn` as system (no row-level security). Only for audited cross-tenant steps, e.g. creating an organization. */
  asSystem<T>(fn: () => Promise<T>): Promise<T> {
    return dbScope.run({ orgIds: null }, fn);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

@Global()
@Module({ providers: [Db], exports: [Db] })
export class DbModule {}
