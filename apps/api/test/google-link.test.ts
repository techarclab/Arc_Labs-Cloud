/**
 * Linking a Google sign-in to an existing account with the same address (AuthController.linkGoogle).
 * Google ID tokens cannot be minted in tests, so this drives the linking step directly with a recording client.
 *
 * Pre-hijacking: someone registers the victim's address with their own password and never confirms it. When the
 * victim later signs in with Google, the account is linked; the attacker's password and sessions must die then.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AuthController } from '../src/auth/auth.controller';

function setup(emailVerified: boolean) {
  const queries: string[] = [];
  const audits: any[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql.replace(/\s+/g, ' '));
      if (sql.includes('email_verified_at IS NULL AS u')) return { rows: [{ u: !emailVerified }] };
      if (sql.startsWith('UPDATE users')) return { rows: [{ id: 'u1', email: 'v@x.test', display_name: 'V', identity_provider_id: 'google:1', status: 'active', created_at: new Date() }] };
      return { rows: [] };
    },
  };
  const audit = { record: async (e: any) => audits.push(e) };
  const ctrl = new AuthController({} as any, {} as any, audit as any, {} as any);
  return { link: () => (ctrl as any).linkGoogle(client, 'u1', 'google:1'), queries, audits };
}

describe('Google account linking', () => {
  it('an unconfirmed account loses its password and every earlier session, and it is audited', async () => {
    const t = setup(false);
    const row = await t.link();
    expect(row.identity_provider_id).toBe('google:1');
    const update = t.queries.find((q) => q.startsWith('UPDATE users'))!;
    expect(update).toContain('password_hash = NULL');
    expect(update).toContain("sessions_revoked_at = date_trunc('second', now())");
    expect(update).toContain('email_verified_at = COALESCE(email_verified_at, now())');
    expect(t.audits.map((a) => a.action)).toEqual(['user.google_link_unconfirmed']);
  });
  it('a confirmed account keeps its password and sessions', async () => {
    const t = setup(true);
    await t.link();
    const update = t.queries.find((q) => q.startsWith('UPDATE users'))!;
    expect(update).not.toContain('password_hash');
    expect(update).not.toContain('sessions_revoked_at');
    expect(t.audits).toEqual([]);
  });
});
