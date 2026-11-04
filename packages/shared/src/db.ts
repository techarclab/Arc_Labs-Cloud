import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { parse } from 'pg-connection-string';

/**
 * node-postgres settings for DATABASE_URL (use for every Pool and Client).
 *
 * With `passwordFile`, the password is read from that file for every new connection instead of from the URL.
 * Why: RDS rotates the master password every 7 days. On the AWS server the host keeps the file current
 * (deploy/aws/write-env.py --db-password-only, every minute), so new connections use the new password without a
 * restart; containers never need AWS credentials. Open connections are unaffected by a password change.
 *
 * The URL must then carry no password: node-postgres lets connection-string fields override explicit settings,
 * so a password in the URL (even an empty one) would silently replace the file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pgConnectionConfig(databaseUrl: string, passwordFile?: string): { [key: string]: any } {
  if (!passwordFile) return { connectionString: databaseUrl };
  const { password, ...rest } = parse(databaseUrl);
  if (password) throw new Error('DATABASE_URL must not contain a password when DATABASE_PASSWORD_FILE is set');
  return {
    ...rest,
    password: () => {
      const value = readFileSync(passwordFile, 'utf8').trim();
      if (!value) throw new Error(`database password file ${passwordFile} is empty`);
      return value;
    },
  };
}

/**
 * Returns a check that opens a NEW database connection and runs `SELECT 1`, for health endpoints.
 *
 * Why not a query on the pool: pooled connections that are already logged in keep working after the password
 * changes, so a pool query stays green while every new login is refused. On 2026-10-31 that hid a rotated RDS
 * password from the uptime alarm for ~21 hours. A fresh login fails as soon as logins fail (password, pg_hba,
 * connection limit, TLS).
 *
 * Results are cached for `cacheMs` and concurrent callers share one attempt, so frequent probes (Route 53 checks
 * from several regions) open at most one connection per `cacheMs`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function newConnectionCheck(config: { [key: string]: any }, opts: { cacheMs?: number; timeoutMs?: number } = {}): () => Promise<boolean> {
  const cacheMs = opts.cacheMs ?? 15_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  let last: { at: number; ok: boolean } | undefined;
  let inflight: Promise<boolean> | undefined;
  return () => {
    if (last && Date.now() - last.at < cacheMs) return Promise.resolve(last.ok);
    if (inflight) return inflight;
    inflight = (async () => {
      const client = new Client({ ...config, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs });
      // A failed login also surfaces as an 'error' event on some paths; without a listener Node would crash.
      client.on('error', () => undefined);
      try {
        await client.connect();
        await client.query('SELECT 1');
        return true;
      } catch {
        return false;
      } finally {
        await client.end().catch(() => undefined);
      }
    })().then((ok) => {
      last = { at: Date.now(), ok };
      inflight = undefined;
      return ok;
    });
    return inflight;
  };
}
