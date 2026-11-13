/**
 * Operator CLI for ARC LABS platform administrators: the ONLY way to change users.is_platform_admin.
 * Deliberately not an HTTP endpoint: it runs on the server, with direct database access, by someone who already
 * controls the deployment.
 *
 *   node apps/api/dist/tools/platform-admin.js list
 *   node apps/api/dist/tools/platform-admin.js grant  <email> [--reason "text"]
 *   node apps/api/dist/tools/platform-admin.js revoke <email> [--reason "text"]
 *
 * On the server:  sudo docker compose -f /opt/arc-cloud/deploy/oracle/docker-compose.yml run --rm --no-deps api \
 *                   node apps/api/dist/tools/platform-admin.js grant someone@example.com --reason "ticket 42"
 *
 * Needs DATABASE_URL. Every grant and revoke is written to audit_logs (action platform_admin.grant / .revoke) in the
 * same transaction as the change, including no-op attempts (metadata.changed = false).
 *
 * Grant only an account whose owner you have confirmed: sign-up does not verify email addresses, so the address
 * alone proves nothing. The tool prints how the account signs in and when it was created to help with that check.
 */
import { hostname, userInfo } from 'node:os';
import { Client, ClientBase } from 'pg';

export type AdminAction = 'grant' | 'revoke';

export interface ChangeResult {
  userId: string;
  email: string;
  changed: boolean;
  isPlatformAdmin: boolean;
  signIn: string;
  createdAt: Date;
}

export class CliError extends Error {}

/** Who ran the tool, for the audit log (no secrets: OS user and host only). */
export function operatorId(): string {
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch {
    /* no passwd entry in some containers */
  }
  return `cli:${user}@${hostname()}`.slice(0, 200);
}

function signInMethods(row: { password_hash: string | null; identity_provider_id: string | null }): string {
  const m = [row.password_hash ? 'password' : null, row.identity_provider_id?.startsWith('google:') ? 'google' : row.identity_provider_id ? 'external' : null];
  return m.filter(Boolean).join('+') || 'none';
}

/** Sets or clears the flag for one existing user and records it in audit_logs, atomically. */
export async function setPlatformAdmin(
  db: ClientBase,
  action: AdminAction,
  email: string,
  opts: { actorId: string; reason?: string },
): Promise<ChangeResult> {
  const target = action === 'grant';
  await db.query('BEGIN');
  try {
    const row = (
      await db.query(
        `SELECT id, email, status, is_platform_admin, password_hash, identity_provider_id, created_at
         FROM users WHERE email = $1 FOR UPDATE`,
        [email.trim()],
      )
    ).rows[0];
    // Only existing accounts: never pre-authorize an address someone could register later.
    if (!row) throw new CliError(`no ARC Cloud account uses ${email}; the person must sign up first`);
    if (target && row.status !== 'active') throw new CliError(`account ${row.email} is ${row.status}; refusing to grant`);

    const changed = row.is_platform_admin !== target;
    if (changed) await db.query('UPDATE users SET is_platform_admin = $2 WHERE id = $1', [row.id, target]);
    await db.query(
      `INSERT INTO audit_logs (actor_type, actor_id, organization_id, action, resource_type, resource_id, metadata)
       VALUES ('system', $1, NULL, $2, 'user', $3, $4)`,
      [opts.actorId, `platform_admin.${action}`, row.id, { email: row.email, changed, via: 'platform-admin-cli', ...(opts.reason ? { reason: opts.reason } : {}) }],
    );
    await db.query('COMMIT');
    return { userId: row.id, email: row.email, changed, isPlatformAdmin: target, signIn: signInMethods(row), createdAt: row.created_at };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

export async function listPlatformAdmins(db: ClientBase) {
  return (
    await db.query(
      `SELECT id, email, display_name, status, password_hash, identity_provider_id, created_at
       FROM users WHERE is_platform_admin ORDER BY email`,
    )
  ).rows.map((r) => ({ id: r.id, email: r.email, displayName: r.display_name, status: r.status, signIn: signInMethods(r), createdAt: r.created_at }));
}

const USAGE = `usage: platform-admin list
       platform-admin grant  <email> [--reason "text"]
       platform-admin revoke <email> [--reason "text"]`;

export function parseArgs(argv: string[]): { cmd: 'list' } | { cmd: AdminAction; email: string; reason?: string } {
  const [cmd, ...rest] = argv;
  if (cmd === 'list' && rest.length === 0) return { cmd };
  if (cmd !== 'grant' && cmd !== 'revoke') throw new CliError(USAGE);
  let email: string | undefined;
  let reason: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--reason') {
      reason = rest[++i];
      if (!reason) throw new CliError('--reason needs a value');
    } else if (!email) email = rest[i];
    else throw new CliError(USAGE);
  }
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new CliError(USAGE);
  return { cmd, email, reason: reason?.slice(0, 500) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new CliError('DATABASE_URL is required');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    if (args.cmd === 'list') {
      const admins = await listPlatformAdmins(db);
      if (!admins.length) console.log('no platform admins');
      for (const a of admins) console.log(`${a.email}\t${a.status}\tsign-in: ${a.signIn}\tcreated ${a.createdAt.toISOString()}\t${a.id}`);
      return;
    }
    const r = await setPlatformAdmin(db, args.cmd, args.email, { actorId: operatorId(), reason: args.reason });
    const verb = args.cmd === 'grant' ? 'is now' : 'is no longer';
    console.log(r.changed ? `${r.email} ${verb} a platform admin (audited)` : `${r.email} already ${args.cmd === 'grant' ? 'was' : 'was not'} a platform admin; no change (attempt audited)`);
    console.log(`  user ${r.userId}, sign-in: ${r.signIn}, created ${r.createdAt.toISOString()}`);
    if (r.changed) console.log("  takes effect on the person's next API request");
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof CliError ? err.message : `platform-admin failed: ${(err as Error).message}`);
    process.exit(err instanceof CliError ? 2 : 1);
  });
}
