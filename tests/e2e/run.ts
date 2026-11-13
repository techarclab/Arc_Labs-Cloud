/**
 * End-to-end checks for every phase (DATABASE_URL=postgres://… empty DB):  npm run test:e2e
 */
import assert from 'node:assert/strict';
import { ChildProcess, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newConnectionCheck, pgConnectionConfig } from '@arc/shared';
import { MqttClient } from 'mqtt';
import { Pool } from 'pg';
import {
  ROOT,
  DB,
  API,
  HOOKS,
  BROKER_PORT,
  SECRETS,
  sleep,
  http,
  hook,
  spawnSvc,
  waitFor,
  startBroker,
  brokerControl,
  dropBrokerClients,
  connectDevice,
  pub,
  telemetry,
} from './harness';

const results: { name: string; ok: boolean; err?: string }[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function main() {
  const procs: ChildProcess[] = [];
  const { server, broker } = await startBroker();
  const sinks = await startSinks();
  // Stand-in for the EMQX management API: DELETE /api/v5/clients/{id} with HTTP Basic (an API key).
  const EMQX_KEY = 'e2e-emqx-key', EMQX_SECRET = 'e2e-emqx-secret-0123456789abcdef';
  const kicked: string[] = [];
  const emqxAdmin = (await import('node:http')).createServer((req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from(`${EMQX_KEY}:${EMQX_SECRET}`).toString('base64')}`) return void res.writeHead(401).end();
    const m = /^\/api\/v5\/clients\/([^/?]+)$/.exec(req.url ?? '');
    if (req.method !== 'DELETE' || !m) return void res.writeHead(404).end();
    const id = decodeURIComponent(m[1]);
    kicked.push(id);
    const client = (broker as any).clients?.[id];
    if (!client) return void res.writeHead(404).end();
    client.close();
    res.writeHead(204).end();
  });
  await new Promise<void>((r) => emqxAdmin.listen(18184, '127.0.0.1', r));
  try {
    const env = {
      ...SECRETS,
      DATABASE_URL: DB!,
      PORT: '3100',
      INTERNAL_PORT: '3101',
      RUN_MIGRATIONS: 'true',
      MQTT_PUBLIC_HOST: '127.0.0.1',
      MQTT_PUBLIC_PORT: String(BROKER_PORT),
      MQTT_URL: `mqtt://127.0.0.1:${BROKER_PORT}`,
      HTTP_PUBLIC_URL: API.replace('/api/v1', ''),
      NODE_ENV: 'test',
      ALLOW_PRIVATE_WEBHOOKS: 'true',
      CONSOLE_URL: 'http://console.test',
      EMQX_API_URL: 'http://127.0.0.1:18184',
      EMQX_API_KEY: EMQX_KEY,
      EMQX_API_SECRET: EMQX_SECRET,
      // Obsolete setting, kept on purpose: these addresses must get NO privileges (see "Platform admin" checks).
      // Mixed case, because the old email match was case-insensitive.
      PLATFORM_ADMIN_EMAILS: 'staff@arclabs.test, Intruder@Invited.test',
    };
    procs.push(spawnSvc('api', 'apps/api/dist/main.js', env));
    await waitFor(async () => (await fetch(`${API}/health/ready`)).ok, 'API');
    procs.push(
      spawnSvc('worker', 'apps/ingestion-worker/dist/main.js', {
        DATABASE_URL: DB!,
        MQTT_URL: `mqtt://127.0.0.1:${BROKER_PORT}`,
        MQTT_PROTOCOL_VERSION: '4',
        SHARED_SUBSCRIPTION: 'false',
        MQTT_SERVICE_PASSWORD: SECRETS.MQTT_SERVICE_PASSWORD,
        HEALTH_PORT: '19100',
        CACHE_TTL_SECONDS: '1',
        RULES_INTERVAL_SECONDS: '2',
        DELIVERIES_INTERVAL_SECONDS: '1',
        COMMANDS_INTERVAL_SECONDS: '1',
        ROLLOUTS_INTERVAL_SECONDS: '1',
        RETENTION_INTERVAL_SECONDS: '2',
        SMTP_URL: `smtp://127.0.0.1:${SMTP_PORT}/?ignoreTLS=true`,
        MAIL_FROM: 'ARC Cloud <alerts@arclabs.test>',
        CONSOLE_URL: 'http://console.test',
        ALLOW_PRIVATE_WEBHOOKS: 'true',
      }),
    );
    await waitFor(async () => (await fetch('http://127.0.0.1:19100/health/ready')).ok, 'worker');
    await sleep(500);

    console.log('\nIdentity & tenancy');
    const a = await http('POST', '/api/v1/auth/register', undefined, { email: 'alice@arclabs.test', displayName: 'Alice', password: 'correct-horse-battery', ageGroup: 'adult', acceptTerms: true });
    const b = await http('POST', '/api/v1/auth/register', undefined, { email: 'bob@other.test', displayName: 'Bob', password: 'correct-horse-staple', ageGroup: 'adult', acceptTerms: true });
    const tA = a.body.accessToken as string;
    const tB = b.body.accessToken as string;
    await check('users register (open sign-up, no invite) and receive tokens', () => {
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(b.status, 201);
      assert.equal(a.body.user.emailVerified, false);
    });
    await check('weak password, missing age group and duplicate email rejected', async () => {
      assert.equal((await http('POST', '/api/v1/auth/register', undefined, { email: 'x@y.test', displayName: 'X', password: 'short', ageGroup: 'adult', acceptTerms: true })).status, 400);
      assert.equal((await http('POST', '/api/v1/auth/register', undefined, { email: 'x@y.test', displayName: 'X', password: 'correct-horse-battery', acceptTerms: true })).status, 400);
      assert.equal((await http('POST', '/api/v1/auth/register', undefined, { email: 'ALICE@arclabs.test', displayName: 'A', password: 'correct-horse-battery', ageGroup: 'adult', acceptTerms: true })).status, 409);
    });
    await check('an unconfirmed account can only read itself and ask for a link', async () => {
      const me = (await http('GET', '/api/v1/auth/me', tA)).body;
      assert.equal(me.user.emailVerified, false);
      assert.equal(me.user.ageGroup, 'adult');
      assert.equal(me.user.accountType, null, 'asked after the email is confirmed');
      assert.equal((await http('POST', '/api/v1/auth/account-type', tA, { accountType: 'individual' })).body.code, 'email_unverified');
      const r = await http('POST', '/api/v1/organizations', tA, { name: 'Too early', slug: 'too-early' });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'email_unverified');
      assert.equal((await http('GET', '/api/v1/organizations', tA)).body.code, 'email_unverified');
      const again = await http('POST', '/api/v1/auth/resend-verification', tA);
      assert.equal(again.status, 429, 'a link was sent seconds ago');
      assert.equal(again.body.code, 'resend_too_soon');
    });
    await check('the emailed link confirms the address, once; bad and reused tokens are refused', async () => {
      const token = await emailedToken(sinks, 'alice@arclabs.test');
      const mail = [...sinks.emails].reverse().find((e) => e.to === 'alice@arclabs.test' && e.raw.includes('verify-email'))!;
      assert.match(mail.raw, /Content-Type: text\/html/i, 'an HTML part');
      assert.match(mail.raw, /Content-Type: text\/plain/i, 'and a plain-text part');
      assert.match(mail.raw, /Confirm my email/, 'with the button');
      assert.equal((await http('POST', '/api/v1/auth/verify-email', undefined, { token: 'x'.repeat(43) })).body.code, 'verification_invalid');
      const ok = await http('POST', '/api/v1/auth/verify-email', undefined, { token });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((await http('POST', '/api/v1/auth/verify-email', undefined, { token })).body.code, 'verification_invalid', 'single use');
      assert.equal((await http('GET', '/api/v1/auth/me', tA)).body.user.emailVerified, true);
      assert.equal((await http('GET', '/api/v1/organizations', tA)).status, 200);
      assert.equal((await http('POST', '/api/v1/auth/resend-verification', tA)).body.alreadyVerified, true);
      const stored = await sql(`SELECT count(*)::int AS n FROM email_verifications WHERE token_hash = $1`, [token]);
      assert.equal(stored[0].n, 0, 'only a hash of the token is stored');
      await http('POST', '/api/v1/auth/verify-email', undefined, { token: await emailedToken(sinks, 'bob@other.test') });
      assert.equal((await http('GET', '/api/v1/auth/me', tB)).body.user.emailVerified, true);
    });
    await check('sent account emails keep no link in the outbox', async () => {
      await eventually(
        async () => (await sql(`SELECT payload FROM deliveries WHERE event_type = 'auth.verify_email' AND recipient = 'alice@arclabs.test'`)).every((d) => d.payload.redacted === true && !d.payload.text && !d.payload.html),
        'redacted payload',
      );
    });
    await check('login works; wrong password gets 401', async () => {
      assert.equal((await http('POST', '/api/v1/auth/login', undefined, { email: 'alice@arclabs.test', password: 'correct-horse-battery' })).status, 200);
      assert.equal((await http('POST', '/api/v1/auth/login', undefined, { email: 'alice@arclabs.test', password: 'nope-nope-nope' })).status, 401);
    });
    await check('unauthenticated requests get 401', async () => {
      assert.equal((await http('GET', '/api/v1/organizations')).status, 401);
    });

    const orgA = (await http('POST', '/api/v1/organizations', tA, { name: 'ARC Labs', slug: 'arc-labs' })).body;
    const orgB = (await http('POST', '/api/v1/organizations', tB, { name: 'Other Co', slug: 'other-co' })).body;
    // Both start as personal workspaces (their creators are not ARC LABS staff). ARC Labs plays a team organization
    // that ARC LABS has set up for Alice, with Alice as owner (from phase 3 this happens with a setup code).
    await sql(`UPDATE organizations SET kind = 'organization' WHERE id = $1`, [orgA.id]);
    await sql(`UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND role = 'individual'`, [orgA.id]);
    await check('new organizations start on the free plan (5 devices, 3 channels, 30 days, 12 widgets)', async () => {
      const [o] = await sql(`SELECT o.plan, o.max_devices, o.max_projects, o.retention_days, o.max_widgets, u.email FROM organizations o JOIN users u ON u.id = o.created_by WHERE o.id = $1`, [orgA.id]);
      assert.deepEqual(o, { plan: 'free', max_devices: 5, max_projects: 3, retention_days: 30, max_widgets: 12, email: 'alice@arclabs.test' });
    });
    await check('one free organization per person', async () => {
      const r = await http('POST', '/api/v1/organizations', tA, { name: 'Second', slug: 'second-org' });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'org_limit');
    });
    // The rest of this suite exercises many devices and channels; give both organizations the old, larger limits.
    await sql(`UPDATE organizations SET max_devices = 50, max_projects = 20, max_rules = 100, max_api_keys = 20, max_webhooks = 10, max_widgets = 64`);
    const proj = (await http('POST', '/api/v1/projects', tA, { organizationId: orgA.id, name: 'Greenhouse', timezone: 'Asia/Kolkata' })).body;
    await check('org + project created', () => {
      assert.ok(orgA.id && orgB.id && proj.id);
    });

    console.log('\nInvites & consent (pilot onboarding)');
    // A second API on the same database with sign-up closed, as on the pilot server.
    const { MQTT_URL: _noBroker, ...closedEnv } = env;
    const closedApi = spawnSvc('api-closed', 'apps/api/dist/main.js', { ...closedEnv, PORT: '3200', INTERNAL_PORT: '3201', ALLOW_SIGNUP: 'false', RUN_MIGRATIONS: 'false' });
    procs.push(closedApi);
    let closedApiLog = '';
    closedApi.stdout!.on('data', (d: Buffer) => (closedApiLog += d.toString()));
    const CLOSED = 'http://127.0.0.1:3200';
    await waitFor(async () => (await fetch(`${CLOSED}/health/ready`)).ok, 'API with sign-up closed');
    const closedRegister = async (body: Record<string, unknown>) => {
      const r = await fetch(`${CLOSED}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const student = (n: number, extra: Record<string, unknown> = {}) => ({ email: `student${n}@college.test`, displayName: `Student ${n}`, password: 'student-password-123', ageGroup: 'adult', acceptTerms: true, ...extra });
    await sql(`UPDATE users SET is_platform_admin = true WHERE email = 'alice@arclabs.test'`);
    let batch: any;
    await check('consent is required to register', async () => {
      const r = await http('POST', '/api/v1/auth/register', undefined, { email: 'noconsent@college.test', displayName: 'N', password: 'student-password-123', ageGroup: 'adult' });
      assert.equal(r.status, 400, JSON.stringify(r.body));
    });
    await check('only platform admins create invite codes; the code is shown once', async () => {
      assert.equal((await http('POST', '/api/v1/platform/invites', tB, { label: 'x', maxUses: 1, expiresInDays: 1 })).status, 403);
      assert.equal((await http('GET', '/api/v1/platform/invites', tB)).status, 403);
      batch = (await http('POST', '/api/v1/platform/invites', tA, { label: 'College batch Nov 2026', maxUses: 2, expiresInDays: 30 })).body;
      assert.match(batch.code, /^ARC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const list = (await http('GET', '/api/v1/platform/invites', tA)).body.items;
      const item = list.find((i: any) => i.id === batch.id);
      assert.equal(item.status, 'active');
      assert.equal(item.code, undefined, 'the list never returns codes');
      const stored = await sql(`SELECT code_hash FROM invite_codes WHERE id = $1`, [batch.id]);
      assert.notEqual(stored[0].code_hash, batch.code, 'only a hash is stored');
    });
    await check('sign-up closed: registration needs a valid invite code', async () => {
      assert.equal((await closedRegister(student(1))).body.code, 'invite_required');
      assert.equal((await closedRegister(student(1, { inviteCode: 'ARC-AAAA-BBBB-CCCC' }))).body.code, 'invite_invalid');
      const ok = await closedRegister(student(1, { inviteCode: batch.code.toLowerCase().replace(/-/g, ' ') }));
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const row = (await sql(`SELECT terms_accepted_at, terms_version, invite_id FROM users WHERE email = 'student1@college.test'`))[0];
      assert.ok(row.terms_accepted_at && row.terms_version, 'consent recorded');
      assert.equal(row.invite_id, batch.id);
    });
    await check('invite limits: uses counted atomically, duplicate email does not burn a use, used-up code refused', async () => {
      assert.equal((await closedRegister(student(1, { inviteCode: batch.code }))).status, 409);
      const second = await closedRegister(student(2, { inviteCode: batch.code }));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal((await closedRegister(student(3, { inviteCode: batch.code }))).body.code, 'invite_invalid');
      const item = (await http('GET', '/api/v1/platform/invites', tA)).body.items.find((i: any) => i.id === batch.id);
      assert.equal(item.usedCount, 2);
      assert.equal(item.status, 'used_up');
    });
    await check('expired and revoked codes are refused', async () => {
      const exp = (await http('POST', '/api/v1/platform/invites', tA, { label: 'expired', maxUses: 5, expiresInDays: 1 })).body;
      await sql(`UPDATE invite_codes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [exp.id]);
      assert.equal((await closedRegister(student(4, { inviteCode: exp.code }))).body.code, 'invite_invalid');
      const rev = (await http('POST', '/api/v1/platform/invites', tA, { label: 'revoked', maxUses: 5, expiresInDays: 1 })).body;
      assert.equal((await http('POST', `/api/v1/platform/invites/${rev.id}/revoke`, tA)).status, 200);
      assert.equal((await closedRegister(student(4, { inviteCode: rev.code }))).body.code, 'invite_invalid');
    });
    await check('an invite can add the new user to an organization with a role', async () => {
      assert.equal((await http('POST', '/api/v1/platform/invites', tA, { label: 'bad', maxUses: 1, expiresInDays: 1, organizationId: orgA.id })).status, 400);
      const team = (await http('POST', '/api/v1/platform/invites', tA, { label: 'ARC Labs viewers', maxUses: 1, expiresInDays: 7, organizationId: orgA.id, role: 'viewer' })).body;
      const r = await closedRegister(student(5, { inviteCode: team.code }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const me = await (await fetch(`${CLOSED}/api/v1/auth/me`, { headers: { authorization: `Bearer ${r.body.accessToken}` } })).json();
      assert.deepEqual(me.memberships.map((m: any) => [m.id, m.role]), [[orgA.id, 'viewer']]);
      assert.equal(me.user.accountType, 'organization', 'joining with the code answers the question');
    });
    await check('under-18s can sign up only with an invite code', async () => {
      const minor = (n: number, extra: Record<string, unknown> = {}) => ({ email: `minor${n}@school.test`, displayName: `Minor ${n}`, password: 'student-password-123', ageGroup: 'minor', acceptTerms: true, ...extra });
      // (Registration is rate-limited per IP to 10/min; this suite stays under it on each API.)
      assert.equal((await http('POST', '/api/v1/auth/register', undefined, minor(1))).body.code, 'minor_needs_invite');
      const code = (await http('POST', '/api/v1/platform/invites', tA, { label: 'School batch', maxUses: 5, expiresInDays: 7 })).body.code;
      const ok = await http('POST', '/api/v1/auth/register', undefined, minor(1, { inviteCode: code }));
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal((await sql(`SELECT age_group FROM users WHERE email = 'minor1@school.test'`))[0].age_group, 'minor');
    });
    await check('signed-in people join an organization with an invite code (in the portal)', async () => {
      const carol = (await http('POST', '/api/v1/auth/register', undefined, { email: 'carol@join.test', displayName: 'Carol', password: 'carol-password-123', ageGroup: 'adult', acceptTerms: true })).body;
      const tC = carol.accessToken as string;
      const team = (await http('POST', '/api/v1/platform/invites', tA, { label: 'ARC Labs class', maxUses: 3, expiresInDays: 7, organizationId: orgA.id, role: 'viewer' })).body;
      assert.equal((await http('POST', '/api/v1/auth/redeem-invite', tC, { inviteCode: team.code })).body.code, 'email_unverified', 'confirm the email first');
      await http('POST', '/api/v1/auth/verify-email', undefined, { token: await emailedToken(sinks, 'carol@join.test') });
      assert.equal((await http('POST', '/api/v1/auth/redeem-invite', tC, { inviteCode: 'ARC-AAAA-BBBB-CCCC' })).body.code, 'invite_invalid');
      const signupOnly = (await http('POST', '/api/v1/platform/invites', tA, { label: 'accounts only', maxUses: 3, expiresInDays: 7 })).body;
      assert.equal((await http('POST', '/api/v1/auth/redeem-invite', tC, { inviteCode: signupOnly.code })).body.code, 'invite_invalid', 'a code without an organization only creates accounts');
      const r = await http('POST', '/api/v1/auth/redeem-invite', tC, { inviteCode: team.code });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.organization, { id: orgA.id, name: 'ARC Labs', role: 'viewer' });
      assert.deepEqual((await http('GET', '/api/v1/auth/me', tC)).body.memberships.map((m: any) => [m.id, m.role]), [[orgA.id, 'viewer']]);
      assert.equal((await http('POST', '/api/v1/auth/redeem-invite', tC, { inviteCode: team.code })).body.code, 'already_member');
      assert.equal((await sql(`SELECT used_count FROM invite_codes WHERE id = $1`, [team.id]))[0].used_count, 1, 'a refused redeem does not use up the code');
      const own = await http('POST', `/api/v1/organizations`, tC, { name: 'Carol Co', slug: 'carol-co' });
      assert.equal(own.status, 201, 'joining does not count as creating');
      assert.equal(own.body.kind, 'personal', 'not ARC LABS staff: a personal workspace');
    });
    await check('after confirming the email: individual, organization (ARC LABS code) or other, answered once', async () => {
      // Sign in through the second API: sign-in is rate-limited per IP (10/min) on each API, and this suite is near it.
      const closedLogin = async (email: string, password: string) =>
        (await (await fetch(`${CLOSED}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).accessToken as string;
      const tC = await closedLogin('carol@join.test', 'carol-password-123');
      assert.equal((await http('GET', '/api/v1/auth/me', tC)).body.user.accountType, null);
      assert.equal((await http('POST', '/api/v1/auth/account-type', tC, { accountType: 'organization' })).body.code, 'organization_needs_invite');
      const accountsOnly = (await http('POST', '/api/v1/platform/invites', tA, { label: 'accounts only (account type)', maxUses: 3, expiresInDays: 7 })).body;
      assert.equal((await http('POST', '/api/v1/auth/account-type', tC, { accountType: 'organization', inviteCode: accountsOnly.code })).body.code, 'invite_not_for_organization');
      assert.equal((await sql(`SELECT used_count FROM invite_codes WHERE id = $1`, [accountsOnly.id]))[0].used_count, 0, 'nothing claimed');
      const other = await http('POST', '/api/v1/auth/account-type', tC, { accountType: 'other', note: 'Robotics club' });
      assert.equal(other.status, 200, JSON.stringify(other.body));
      assert.deepEqual(await sql(`SELECT account_type, account_type_note FROM users WHERE email = 'carol@join.test'`), [{ account_type: 'other', account_type_note: 'Robotics club' }]);
      assert.equal((await http('POST', '/api/v1/auth/account-type', tC, { accountType: 'individual' })).body.code, 'account_type_set');

      // Organization path: ARC LABS staff set up a real organization and give out its code.
      const staffOrg = await http('POST', '/api/v1/organizations', tA, { name: 'Staff College', slug: 'staff-college' });
      assert.equal(staffOrg.body.kind, 'organization', 'created by ARC LABS staff');
      const code = (await http('POST', '/api/v1/platform/invites', tA, { label: 'Staff College admins', maxUses: 2, expiresInDays: 7, organizationId: staffOrg.body.id, role: 'engineer' })).body;
      await sql(`UPDATE users SET email_verified_at = now() WHERE email = 'student2@college.test'`);
      const tS = await closedLogin('student2@college.test', 'student-password-123');
      const joined = await http('POST', '/api/v1/auth/account-type', tS, { accountType: 'organization', inviteCode: code.code });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      assert.deepEqual(joined.body.organization, { id: staffOrg.body.id, name: 'Staff College', role: 'engineer' });
      const me = (await http('GET', '/api/v1/auth/me', tS)).body;
      assert.equal(me.user.accountType, 'organization');
      assert.ok(me.memberships.some((m: any) => m.id === staffOrg.body.id && m.role === 'engineer'));
      assert.equal((await sql(`SELECT used_count FROM invite_codes WHERE id = $1`, [code.id]))[0].used_count, 1);
    });
    await check('an account without an age group (Google sign-up) can only finish its profile', async () => {
      const tD = (await http('POST', '/api/v1/auth/login', undefined, { email: 'carol@join.test', password: 'carol-password-123' })).body.accessToken as string;
      await sql(`UPDATE users SET age_group = NULL WHERE email = 'carol@join.test'`);
      assert.equal((await http('GET', '/api/v1/organizations', tD)).body.code, 'profile_incomplete');
      assert.equal((await http('GET', '/api/v1/auth/me', tD)).body.user.ageGroup, null);
      assert.equal((await http('POST', '/api/v1/auth/complete-profile', tD, { ageGroup: 'minor' })).body.code, 'minor_needs_invite');
      assert.equal((await http('POST', '/api/v1/auth/complete-profile', tD, { ageGroup: 'adult' })).status, 200);
      assert.equal((await http('GET', '/api/v1/organizations', tD)).status, 200);
      assert.equal((await http('POST', '/api/v1/auth/complete-profile', tD, { ageGroup: 'adult' })).body.code, 'profile_complete');
    });
    await check('forgot password: same answer for any address; the emailed link sets a new password once and signs out other sessions', async () => {
      const unknown = await http('POST', '/api/v1/auth/forgot-password', undefined, { email: 'nobody@nowhere.test' });
      const known = await http('POST', '/api/v1/auth/forgot-password', undefined, { email: 'Carol@Join.test' });
      assert.equal(unknown.status, 200);
      assert.deepEqual(unknown.body, known.body, 'no way to tell whether an account exists');
      const old = (await http('POST', '/api/v1/auth/login', undefined, { email: 'carol@join.test', password: 'carol-password-123' })).body.accessToken as string;
      const mail = await eventually(async () => [...sinks.emails].reverse().find((e) => e.to === 'carol@join.test' && e.raw.includes('reset-password')), 'reset email');
      const text = mail.raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      const token = /reset-password#token=([A-Za-z0-9_-]+)/.exec(text)![1];
      assert.equal((await http('POST', '/api/v1/auth/reset-password', undefined, { token, password: 'short' })).status, 400, 'password rules apply');
      await new Promise((r) => setTimeout(r, 1100)); // the old token must be from an earlier second than the reset
      const r = await http('POST', '/api/v1/auth/reset-password', undefined, { token, password: 'carol-new-password-456' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await http('GET', '/api/v1/auth/me', r.body.accessToken)).status, 200, 'signed in with the new password');
      const stale = await http('GET', '/api/v1/auth/me', old);
      assert.equal(stale.status, 401);
      assert.equal(stale.body.code, 'session_revoked');
      assert.equal((await http('POST', '/api/v1/auth/reset-password', undefined, { token, password: 'carol-other-password-789' })).body.code, 'reset_invalid', 'single use');
      assert.equal((await http('POST', '/api/v1/auth/login', undefined, { email: 'carol@join.test', password: 'carol-password-123' })).status, 401);
      assert.equal((await http('POST', '/api/v1/auth/login', undefined, { email: 'carol@join.test', password: 'carol-new-password-456' })).status, 200);
      await http('POST', '/api/v1/auth/forgot-password', undefined, { email: 'carol@join.test' });
      await http('POST', '/api/v1/auth/forgot-password', undefined, { email: 'carol@join.test' });
      await http('POST', '/api/v1/auth/forgot-password', undefined, { email: 'carol@join.test' });
      const n = await sql(`SELECT count(*)::int AS n FROM password_resets p JOIN users u ON u.id = p.user_id WHERE u.email = 'carol@join.test'`);
      assert.equal(n[0].n, 3, 'at most 3 links an hour per account');
    });
    await check('profile: rename, change password (signs out other sessions), sign out everywhere', async () => {
      const login = async (password: string) => (await http('POST', '/api/v1/auth/login', undefined, { email: 'carol@join.test', password })).body.accessToken as string;
      const t1 = await login('carol-new-password-456');
      const me = (await http('GET', '/api/v1/auth/me', t1)).body;
      assert.deepEqual(me.user.signIn, { password: true, google: false });
      assert.ok(me.user.emailVerifiedAt);
      assert.equal((await http('PATCH', '/api/v1/auth/me', t1, { displayName: '  Carol K  ' })).body.user.displayName, 'Carol K');
      assert.equal((await http('POST', '/api/v1/auth/change-password', t1, { currentPassword: 'wrong-password-1', newPassword: 'carol-third-password-789' })).body.code, 'wrong_password');
      await new Promise((r) => setTimeout(r, 1100));
      const changed = await http('POST', '/api/v1/auth/change-password', t1, { currentPassword: 'carol-new-password-456', newPassword: 'carol-third-password-789' });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      assert.equal((await http('GET', '/api/v1/auth/me', t1)).body.code, 'session_revoked', 'the old session is signed out');
      const t2 = changed.body.accessToken as string;
      assert.equal((await http('GET', '/api/v1/auth/me', t2)).status, 200, 'this browser stays signed in');
      assert.equal((await http('POST', '/api/v1/auth/sign-out-everywhere', t2)).status, 200);
      assert.equal((await http('GET', '/api/v1/auth/me', t2)).status, 401);
      await new Promise((r) => setTimeout(r, 1100));
      const tg = await login('carol-third-password-789');
      assert.equal((await http('GET', '/api/v1/auth/me', tg)).status, 200, 'signing in again works');
      await sql(`UPDATE users SET password_hash = NULL WHERE email = 'carol@join.test'`); // as if created with Google
      assert.equal((await http('POST', '/api/v1/auth/change-password', tg, { currentPassword: 'x', newPassword: 'carol-fourth-password-0' })).body.code, 'no_password', 'Google-only accounts add a password through the emailed link');
    });
    await check('revoking an invite code can also remove the people who joined with it (never admins)', async () => {
      const team = (await http('POST', '/api/v1/platform/invites', tA, { label: 'Course batch', maxUses: 5, expiresInDays: 7, organizationId: orgA.id, role: 'viewer' })).body;
      // (Reuses an existing account: registration is rate-limited per IP.)
      await sql(`UPDATE users SET email_verified_at = now() WHERE email = 'minor1@school.test'`);
      const dan = (await http('POST', '/api/v1/auth/login', undefined, { email: 'minor1@school.test', password: 'student-password-123' })).body;
      assert.equal((await http('POST', '/api/v1/auth/redeem-invite', dan.accessToken, { inviteCode: team.code })).status, 200);
      const listed = (await http('GET', '/api/v1/platform/invites', tA)).body.items.find((i: any) => i.id === team.id);
      assert.equal(listed.members, 1);
      const keep = await http('POST', `/api/v1/platform/invites/${team.id}/revoke`, tA, {});
      assert.equal(keep.body.removedMembers, 0, 'plain revoke keeps people');
      assert.equal((await sql(`SELECT count(*)::int AS n FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'minor1@school.test'`))[0].n, 1);
      const out = await http('POST', `/api/v1/platform/invites/${team.id}/revoke`, tA, { removeMembers: true });
      assert.equal(out.body.removedMembers, 1);
      assert.equal((await sql(`SELECT count(*)::int AS n FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'minor1@school.test'`))[0].n, 0);
      assert.equal((await http('GET', `/api/v1/organizations/${orgA.id}/overview`, dan.accessToken)).status, 404, 'removed people lose access at once');
    });
    await check('a person who is not a platform admin can accept a new privacy notice (account-level audit row)', async () => {
      await sql(`UPDATE users SET terms_version = '2000-01-01' WHERE email = 'bob@other.test'`);
      const me = (await http('GET', '/api/v1/auth/me', tB)).body;
      const r = await http('POST', '/api/v1/auth/accept-terms', tB, { version: me.currentTermsVersion, accept: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const zero = (await http('POST', '/api/v1/auth/login', undefined, { email: 'minor1@school.test', password: 'student-password-123' })).body;
      await sql(`UPDATE users SET terms_version = NULL WHERE email = 'minor1@school.test'`); // like a new Google account: no organization yet
      assert.equal((await sql(`SELECT count(*)::int AS n FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'minor1@school.test'`))[0].n, 0);
      const r2 = await http('POST', '/api/v1/auth/accept-terms', zero.accessToken, { version: me.currentTermsVersion, accept: true });
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
    });
    await check('rotated DB password: warm pool still works, but the health check sees refused logins; file update fixes both', async () => {
      // Regression (pilot, 2026-10-31): RDS rotated the password; pooled connections kept working, so health checks
      // stayed green for ~21 h while every new login was refused.
      const dir = mkdtempSync(join(tmpdir(), 'arc-e2e-rot-'));
      const file = join(dir, 'password');
      const role = 'e2e_rotate';
      const u = new URL(DB!);
      u.username = role;
      u.password = '';
      await sql(`DROP ROLE IF EXISTS ${role}`);
      await sql(`CREATE ROLE ${role} LOGIN PASSWORD 'rot-one'`);
      writeFileSync(file, 'rot-one\n');
      const cfg = pgConnectionConfig(u.toString(), file);
      const pool = new Pool({ ...cfg, max: 1, idleTimeoutMillis: 0 });
      const fresh = newConnectionCheck(cfg, { cacheMs: 0 });
      try {
        assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1);
        assert.equal(await fresh(), true, 'healthy before rotation');
        await sql(`ALTER ROLE ${role} PASSWORD 'rot-two'`);
        assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1, 'warm pooled connection unaffected (why pool checks miss it)');
        assert.equal(await fresh(), false, 'fresh-login check fails while the file is stale');
        writeFileSync(join(dir, 'password.tmp'), 'rot-two\n');
        renameSync(join(dir, 'password.tmp'), file);
        assert.equal(await fresh(), true, 'picks up the new password from the file, no restart');
      } finally {
        await pool.end().catch(() => undefined);
        await sql(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    });
    await check('/health/deep logs in afresh to the database', async () => {
      const r = await fetch(`${API}/health/deep`);
      assert.equal(r.status, 200);
      assert.equal(((await r.json()) as { db: boolean }).db, true);
    });
    await check('tenant role cannot read invite codes', async () => {
      const r = await sql(`SELECT has_table_privilege('arc_tenant', 'invite_codes', 'SELECT') AS can`);
      assert.equal(r[0].can, false);
    });
    await check('a changed privacy notice must be accepted again, by a person, at the current version', async () => {
      let me = (await http('GET', '/api/v1/auth/me', tA)).body;
      assert.ok(me.currentTermsVersion, 'current version published');
      assert.equal(me.user.termsVersion, me.currentTermsVersion, 'sign-up recorded the current version');
      await sql(`UPDATE users SET terms_version = '2000-01-01' WHERE email = 'alice@arclabs.test'`);
      me = (await http('GET', '/api/v1/auth/me', tA)).body;
      assert.notEqual(me.user.termsVersion, me.currentTermsVersion, 'console sees the mismatch');
      const stale = await http('POST', '/api/v1/auth/accept-terms', tA, { version: '2000-01-01', accept: true });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'terms_version_changed');
      assert.equal((await http('POST', '/api/v1/auth/accept-terms', tA, { version: me.currentTermsVersion, accept: false })).status, 400);
      assert.equal((await http('POST', '/api/v1/auth/accept-terms', undefined, { version: me.currentTermsVersion, accept: true })).status, 401);
      const ok = await http('POST', '/api/v1/auth/accept-terms', tA, { version: me.currentTermsVersion, accept: true });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      me = (await http('GET', '/api/v1/auth/me', tA)).body;
      assert.equal(me.user.termsVersion, me.currentTermsVersion);
      const audit = await sql(`SELECT metadata FROM audit_logs WHERE action = 'user.accept_terms' AND actor_id = (SELECT id::text FROM users WHERE email = 'alice@arclabs.test')`);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].metadata.termsVersion, me.currentTermsVersion);
    });
    await sql(`UPDATE users SET is_platform_admin = false WHERE email = 'alice@arclabs.test'`);
    console.log('\nPlatform admin comes only from the database flag (PLATFORM_ADMIN_EMAILS is ignored)');
    // A separate tenant whose data an escalated account must not reach.
    // Created in SQL, not through sign-up: registration is rate-limited per IP (10/min) and this suite is at it.
    await sql(`INSERT INTO users (email, display_name, email_verified_at, age_group, account_type, terms_version, terms_accepted_at) VALUES ('victim@tenant.test', 'Victim', now(), 'adult', 'individual', '2000-01-01', now())`);
    const victim = { accessToken: (await tokenFor('victim@tenant.test')).token };
    const victimOrg = (await http('POST', '/api/v1/organizations', victim.accessToken, { name: 'Victim Co', slug: 'victim-co' })).body;
    const victimProj = (await http('POST', '/api/v1/projects', victim.accessToken, { organizationId: victimOrg.id, name: 'Private channel' })).body;
    const victimDev = (await http('POST', '/api/v1/devices', victim.accessToken, { projectId: victimProj.id, displayName: 'Private device' })).body.device;
    const call = async (base: string, method: string, path: string, token: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    /** Everything a platform admin could do, refused; and another tenant's data hidden (404, not 403). */
    const assertNoPlatformAccess = async (base: string, token: string) => {
      const me = await call(base, 'GET', '/api/v1/auth/me', token);
      assert.equal(me.status, 200);
      assert.equal(me.body.isPlatformAdmin, false, 'not reported as platform admin');
      assert.equal((await call(base, 'GET', '/api/v1/platform/organizations', token)).status, 403, 'platform organizations');
      assert.equal((await call(base, 'GET', '/api/v1/platform/invites', token)).status, 403, 'list invites');
      assert.equal((await call(base, 'POST', '/api/v1/platform/invites', token, { label: 'x', maxUses: 1, expiresInDays: 1 })).status, 403, 'create invites');
      assert.equal((await call(base, 'PATCH', `/api/v1/organizations/${victimOrg.id}/plan`, token, { plan: 'pro' })).status, 403, 'change a plan');
      assert.equal((await call(base, 'GET', `/api/v1/organizations/${victimOrg.id}`, token)).status, 404, 'other tenant organization');
      assert.equal((await call(base, 'GET', `/api/v1/organizations/${victimOrg.id}/overview`, token)).status, 404, 'other tenant overview');
      assert.equal((await call(base, 'GET', `/api/v1/projects/${victimProj.id}`, token)).status, 404, 'other tenant channel');
      assert.equal((await call(base, 'GET', `/api/v1/devices/${victimDev.id}`, token)).status, 404, 'other tenant device');
      assert.equal((await call(base, 'GET', `/api/v1/channels/${victimProj.id}/feeds.json`, token)).status, 404, 'other tenant feed');
      const orgs = (await call(base, 'GET', '/api/v1/organizations', token)).body;
      assert.ok(!JSON.stringify(orgs).includes(victimOrg.id), 'other tenant not listed');
    };
    const adminCli = (...args: string[]) => {
      const r = spawnSync(process.execPath, ['apps/api/dist/tools/platform-admin.js', ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB! }, encoding: 'utf8' });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    let tStaff = '';
    await check('open sign-up with an email listed in PLATFORM_ADMIN_EMAILS grants no platform admin', async () => {
      const r = await http('POST', '/api/v1/auth/register', undefined, { email: 'staff@arclabs.test', displayName: 'Not staff', password: 'claimed-password-123', ageGroup: 'adult', acceptTerms: true });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      tStaff = r.body.accessToken;
      await sql(`UPDATE users SET email_verified_at = now() WHERE email = 'staff@arclabs.test'`); // even with the address confirmed
      await assertNoPlatformAccess(API, tStaff);
    });
    await check('invite-code sign-up with an email listed in PLATFORM_ADMIN_EMAILS grants no platform admin', async () => {
      await sql(`UPDATE users SET is_platform_admin = true WHERE email = 'alice@arclabs.test'`);
      const inv = (await http('POST', '/api/v1/platform/invites', tA, { label: 'batch', maxUses: 1, expiresInDays: 1 })).body;
      await sql(`UPDATE users SET is_platform_admin = false WHERE email = 'alice@arclabs.test'`);
      const r = await closedRegister({ email: 'intruder@invited.test', displayName: 'Intruder', password: 'claimed-password-123', ageGroup: 'adult', acceptTerms: true, inviteCode: inv.code });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      await sql(`UPDATE users SET email_verified_at = now() WHERE email = 'intruder@invited.test'`);
      await assertNoPlatformAccess(CLOSED, r.body.accessToken);
      assert.equal((await sql(`SELECT is_platform_admin FROM users WHERE email = 'intruder@invited.test'`))[0].is_platform_admin, false);
    });
    await check('an old PLATFORM_ADMIN_EMAILS setting starts the API with a clear warning, not a crash', async () => {
      assert.match(closedApiLog, /PLATFORM_ADMIN_EMAILS is set but IGNORED/);
      assert.ok(!/staff@arclabs\.test|intruder@invited\.test/i.test(closedApiLog), 'addresses are not echoed into logs');
    });
    await check('database flag via the operator CLI: grant and revoke apply on the next request, both audited', async () => {
      const g = adminCli('grant', 'staff@arclabs.test', '--reason', 'e2e');
      assert.equal(g.status, 0, g.out);
      // The token issued before the grant: privileges are read from the database on every request.
      const me = (await http('GET', '/api/v1/auth/me', tStaff)).body;
      assert.equal(me.isPlatformAdmin, true);
      const all = await http('GET', '/api/v1/platform/organizations', tStaff);
      assert.equal(all.status, 200);
      assert.ok(all.body.items.some((o: any) => o.id === victimOrg.id), 'legitimate admin sees every organization');
      // Metadata only: a platform admin sees the organization in the platform list, not its data (phase 5).
      assert.equal((await http('GET', `/api/v1/devices/${victimDev.id}`, tStaff)).status, 404, 'no tenant data without support access');
      assert.match(adminCli('list').out, /staff@arclabs\.test/);

      const rv = adminCli('revoke', 'staff@arclabs.test');
      assert.equal(rv.status, 0, rv.out);
      await assertNoPlatformAccess(API, tStaff);
      assert.doesNotMatch(adminCli('list').out, /staff@arclabs\.test/);

      const audit = await sql(
        `SELECT action, actor_type, actor_id, metadata FROM audit_logs
         WHERE resource_type = 'user' AND resource_id = (SELECT id::text FROM users WHERE email = 'staff@arclabs.test') AND action LIKE 'platform_admin.%' ORDER BY id`,
      );
      assert.deepEqual(audit.map((a) => [a.action, a.actor_type, a.metadata.changed]), [['platform_admin.grant', 'system', true], ['platform_admin.revoke', 'system', true]]);
      assert.ok(audit.every((a) => /^cli:/.test(a.actor_id)), 'operator recorded');
      assert.equal(audit[0].metadata.reason, 'e2e');
    });
    await check('operator CLI refuses unknown emails and disabled accounts, and never creates users', async () => {
      const ghost = adminCli('grant', 'ghost@nowhere.test');
      assert.equal(ghost.status, 2, ghost.out);
      assert.equal((await sql(`SELECT count(*)::int AS n FROM users WHERE email = 'ghost@nowhere.test'`))[0].n, 0, 'cannot pre-authorize an address');
      await sql(`UPDATE users SET status = 'disabled' WHERE email = 'intruder@invited.test'`);
      const disabled = adminCli('grant', 'intruder@invited.test');
      assert.equal(disabled.status, 2, disabled.out);
      assert.equal((await sql(`SELECT is_platform_admin FROM users WHERE email = 'intruder@invited.test'`))[0].is_platform_admin, false);
      assert.equal(adminCli('frobnicate', 'staff@arclabs.test').status, 2, 'unknown command');
      assert.equal((await sql(`SELECT count(*)::int AS n FROM users WHERE is_platform_admin`))[0].n, 0, 'no admins left behind');
    });

    await check('metric definitions set', async () => {
      const r = await http('PUT', `/api/v1/projects/${proj.id}/metric-definitions`, tA, {
        metrics: [
          { metricKey: 'temperatureC', label: 'Temperature', unit: '°C', minValue: -40, maxValue: 85 },
          { metricKey: 'humidityPct', label: 'Humidity', unit: '%', minValue: 0, maxValue: 100 },
        ],
      });
      assert.equal(r.status, 200);
    });

    console.log('\nProvisioning');
    const created = await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'ESP32 Greenhouse 1', deviceType: 'esp32', tags: ['greenhouse'], expectedIntervalSeconds: 10 });
    const dev = created.body.device;
    const creds = created.body.credentials;
    await check('device registered with unique credential returned once', async () => {
      assert.equal(created.status, 201);
      assert.equal(creds.username, dev.id);
      assert.equal(creds.topics.telemetry, `arc/v1/${orgA.id}/${proj.id}/${dev.id}/telemetry`);
      assert.ok(creds.password.length >= 40);
      const again = await http('GET', `/api/v1/devices/${dev.id}`, tA);
      assert.equal(JSON.stringify(again.body).includes(creds.password), false);
      assert.equal(again.body.connectivity.status, 'unknown');
      // Non-secret connection details for the console's Arduino code generator.
      assert.deepEqual(again.body.connection, { mqttHost: creds.mqttHost, mqttPort: creds.mqttPort, topicBase: `arc/v1/${orgA.id}/${proj.id}/${dev.id}` });
    });
    await check('credential stored as scrypt hash, not plaintext', async () => {
      const { Client } = await import('pg');
      const c = new Client({ connectionString: DB });
      await c.connect();
      const row = (await c.query('SELECT secret_hash FROM device_credentials WHERE device_id = $1', [dev.id])).rows[0];
      await c.end();
      assert.ok(row.secret_hash.startsWith('scrypt$'));
      assert.ok(!row.secret_hash.includes(creds.password));
    });

    console.log('\nMQTT auth & ACL (via broker hooks)');
    await check('wrong password rejected', async () => {
      await assert.rejects(connectDevice({ ...creds, password: 'wrong' }));
    });
    await check('clientid must equal username', async () => {
      await assert.rejects(connectDevice({ ...creds, clientId: randomUUID() }));
    });
    await check('hooks require the internal token', async () => {
      const r = await fetch(`${HOOKS}/internal/mqtt/authenticate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 401);
    });
    await check('ACL: own telemetry/state/cmd-ack allowed; other device / other tenant / publishing cmd / wildcard subscribe denied', async () => {
      const t = (topic: string, action = 'publish') => hook('/internal/mqtt/authorize', { username: dev.id, clientid: dev.id, topic, action });
      assert.equal((await t(creds.topics.telemetry)).result, 'allow');
      assert.equal((await t(creds.topics.state)).result, 'allow');
      assert.equal((await t(`arc/v1/${orgA.id}/${proj.id}/${randomUUID()}/telemetry`)).result, 'deny');
      assert.equal((await t(`arc/v1/${orgB.id}/${proj.id}/${dev.id}/telemetry`)).result, 'deny');
      assert.equal((await t(`arc/v1/${orgA.id}/${proj.id}/${dev.id}/cmd-ack`)).result, 'allow');
      assert.equal((await t(`arc/v1/${orgA.id}/${proj.id}/${dev.id}/cmd`)).result, 'deny');
      assert.equal((await t('#', 'subscribe')).result, 'deny');
    });

    console.log('\nIngestion');
    const device = await connectDevice(creds);
    const dupId = randomUUID();
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 29.4, humidityPct: 61 }, dupId));
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 29.6, humidityPct: 60.5 }, dupId)); // duplicate
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 29.8, humidityPct: 60 }));
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 30.1, humidityPct: 59.5 }));
    await pub(device, creds.topics.telemetry, '{not-json');
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 'hot' }));
    await pub(device, creds.topics.telemetry, telemetry({ pressureHpa: 1012 })); // not defined for project
    await pub(device, creds.topics.telemetry, telemetry({ temperatureC: 140 })); // out of range
    await pub(device, creds.topics.state, { schemaVersion: 1, state: { firmwareVersion: '1.0.0', uptimeS: 42 } });
    await sleep(1500);

    await check('valid messages persisted once (duplicate messageId ignored)', async () => {
      const r = await http('GET', `/api/v1/devices/${dev.id}/telemetry?metric=temperatureC,humidityPct`, tA);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.series.temperatureC.map((p: any) => p.value), [29.4, 29.8, 30.1]);
      assert.equal(r.body.series.humidityPct.length, 3);
    });
    await check('latest values endpoint', async () => {
      const r = await http('GET', `/api/v1/devices/${dev.id}/telemetry/latest`, tA);
      const temp = r.body.items.find((i: any) => i.metric === 'temperatureC');
      assert.equal(temp.value, 30.1);
    });
    await check('aggregated history (1m buckets)', async () => {
      const r = await http('GET', `/api/v1/devices/${dev.id}/telemetry?metric=temperatureC&bucket=1m&agg=max`, tA);
      assert.equal(r.status, 200);
      assert.ok(r.body.series.temperatureC.length >= 1);
      assert.equal(Math.max(...r.body.series.temperatureC.map((p: any) => p.value)), 30.1);
    });
    await check('invalid payloads rejected and logged with reasons', async () => {
      const r = await http('GET', `/api/v1/organizations/${orgA.id}/rejected-messages`, tA);
      const reasons = r.body.items.map((i: any) => i.reason).sort();
      assert.deepEqual(reasons, ['invalid_json', 'metric_not_allowed', 'schema_invalid', 'value_out_of_range']);
    });
    await check('device is online, active, with state + firmware + events', async () => {
      const s = await http('GET', `/api/v1/devices/${dev.id}/state`, tA);
      assert.equal(s.body.connectivity.status, 'online');
      assert.equal(s.body.reportedState.uptimeS, 42);
      assert.equal(s.body.firmwareVersion, '1.0.0');
      const d = await http('GET', `/api/v1/devices/${dev.id}`, tA);
      assert.equal(d.body.lifecycleStatus, 'active');
      const ev = await http('GET', `/api/v1/devices/${dev.id}/events`, tA);
      const types = ev.body.items.map((e: any) => e.type);
      for (const t of ['provisioned', 'first_message', 'connected']) assert.ok(types.includes(t), `missing event ${t}: ${types}`);
    });
    await check('publishing to another device topic is blocked by the broker', async () => {
      const otherTopic = `arc/v1/${orgA.id}/${proj.id}/${randomUUID()}/telemetry`;
      const closed = new Promise<void>((r) => device.once('close', () => r()));
      device.publish(otherTopic, JSON.stringify(telemetry({ temperatureC: 1 })), { qos: 0 });
      await Promise.race([closed, sleep(3000).then(() => { throw new Error('connection not closed'); })]);
    });
    await sleep(800);
    await check('broker disconnect marks device offline', async () => {
      const s = await http('GET', `/api/v1/devices/${dev.id}/state`, tA);
      assert.equal(s.body.connectivity.status, 'offline');
      assert.equal(s.body.connectivity.source, 'broker_event');
    });

    console.log('\nTenant isolation & RBAC');
    await check('other tenant cannot see device, telemetry, project or org (404)', async () => {
      for (const p of [`/api/v1/devices/${dev.id}`, `/api/v1/devices/${dev.id}/telemetry?metric=temperatureC`, `/api/v1/devices/${dev.id}/telemetry/latest`, `/api/v1/projects/${proj.id}`, `/api/v1/organizations/${orgA.id}`, `/api/v1/devices?projectId=${proj.id}`, `/api/v1/organizations/${orgA.id}/rejected-messages`]) {
        assert.equal((await http('GET', p, tB)).status, 404, p);
      }
    });
    await check('row-level security: the database itself hides other tenants (tenant role)', async () => {
      const { Client } = await import('pg');
      const c = new Client({ connectionString: DB });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('role', 'arc_tenant', true), set_config('arc.org_ids', $1, true)`, [orgB.id]);
        // No WHERE on organization: RLS alone must hide org A's rows from a session scoped to org B.
        assert.equal((await c.query('SELECT count(*)::int AS n FROM devices WHERE id = $1', [dev.id])).rows[0].n, 0, 'devices');
        assert.equal((await c.query('SELECT count(*)::int AS n FROM projects WHERE id = $1', [proj.id])).rows[0].n, 0, 'projects');
        assert.equal((await c.query('SELECT count(*)::int AS n FROM telemetry_measurements WHERE device_id = $1', [dev.id])).rows[0].n, 0, 'telemetry');
        assert.equal((await c.query('SELECT count(*)::int AS n FROM device_credentials WHERE device_id = $1', [dev.id])).rows[0].n, 0, 'credentials');
        assert.equal((await c.query('SELECT count(*)::int AS n FROM metric_definitions WHERE project_id = $1', [proj.id])).rows[0].n, 0, 'fields');
        await assert.rejects(c.query(`INSERT INTO devices (organization_id, project_id, display_name) VALUES ($1, $2, 'x')`, [orgA.id, proj.id]), /row-level security/);
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query(`SELECT set_config('role', 'arc_tenant', true)`); // no organizations pinned → sees nothing
        assert.equal((await c.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 0, 'unscoped tenant sees nothing');
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
    });
    await check('every tenant table has row-level security (guards future migrations)', async () => {
      const missing = await sql(`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                      AND a.attname IN ('organization_id', 'project_id', 'device_id', 'alert_id'))
          AND NOT (c.relname = 'telemetry_measurements' AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'))
        ORDER BY 1`);
      assert.deepEqual(missing.map((r: any) => r.relname), [], 'add a tenant_isolation policy in the migration that creates these tables');
    });
    await check('API requests run as the RLS-restricted role, pinned to the caller\'s organizations', async () => {
      // A temporary trigger records which role and organizations the API's own write ran under.
      await sql(`CREATE TABLE rls_probe (who text, orgs text)`);
      await sql(`GRANT INSERT ON rls_probe TO arc_tenant`);
      await sql(`CREATE FUNCTION rls_probe_fn() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO rls_probe VALUES (current_user, current_setting('arc.org_ids', true)); RETURN NEW; END $$`);
      await sql(`CREATE TRIGGER rls_probe_t AFTER INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION rls_probe_fn()`);
      try {
        const r = await http('PATCH', `/api/v1/devices/${dev.id}`, tA, { displayName: 'ESP32 #1' });
        assert.ok(r.status < 300, JSON.stringify(r.body));
        const rows = await sql('SELECT who, orgs FROM rls_probe');
        assert.ok(rows.length >= 1, 'the request wrote an audit row');
        for (const row of rows) {
          assert.equal(row.who, 'arc_tenant');
          assert.ok(row.orgs.split(',').includes(orgA.id) && !row.orgs.split(',').includes(orgB.id), row.orgs);
        }
      } finally {
        await sql('DROP TRIGGER rls_probe_t ON audit_logs');
        await sql('DROP FUNCTION rls_probe_fn()');
        await sql('DROP TABLE rls_probe');
      }
    });
    await check('other tenant cannot create devices in, or rotate devices of, another org', async () => {
      assert.equal((await http('POST', '/api/v1/devices', tB, { projectId: proj.id, displayName: 'evil' })).status, 404);
      assert.equal((await http('POST', `/api/v1/devices/${dev.id}/rotate-credentials`, tB)).status, 404);
      assert.equal((await http('POST', `/api/v1/devices/${dev.id}/revoke`, tB, {})).status, 404);
    });
    await check('viewer can read but not provision or revoke (403)', async () => {
      // Bob joins by invitation (people are never added without accepting).
      const inv = await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tA, { email: 'bob@other.test', role: 'viewer' });
      assert.equal(inv.status, 201, JSON.stringify(inv.body));
      assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/members`, tA, { email: 'bob@other.test', role: 'viewer' })).body.code, 'use_invitations');
      const acc = await http('POST', '/api/v1/invitations/accept', tB, { token: await emailedInviteToken(sinks, 'bob@other.test') });
      assert.equal(acc.status, 200, JSON.stringify(acc.body));
      assert.deepEqual(acc.body.organization, { id: orgA.id, name: 'ARC Labs', role: 'viewer' });
      assert.equal((await http('GET', `/api/v1/devices/${dev.id}`, tB)).status, 200);
      assert.equal((await http('POST', '/api/v1/devices', tB, { projectId: proj.id, displayName: 'nope' })).status, 403);
      assert.equal((await http('POST', `/api/v1/devices/${dev.id}/revoke`, tB, {})).status, 403);
    });
    await check('the owner cannot be removed or leave (transfer ownership first)', async () => {
      const me = (await http('GET', '/api/v1/auth/me', tA)).body.user;
      const r = await http('DELETE', `/api/v1/organizations/${orgA.id}/members/${me.id}`, tA);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'owner_role');
    });

    console.log('\nCredential lifecycle');
    await check('rotation: old password stops working, new one works, and the live session is cut', async () => {
      const live = await connectDevice(creds);
      const closed = new Promise<void>((r) => live.once('close', () => r()));
      const r = await http('POST', `/api/v1/devices/${dev.id}/rotate-credentials`, tA);
      assert.equal(r.status, 200);
      await Promise.race([closed, sleep(3000).then(() => { throw new Error('session still open after rotation'); })]);
      live.end(true);
      assert.ok(kicked.includes(dev.id), 'API asked the broker to disconnect the device');
      await assert.rejects(connectDevice(creds));
      const c = await connectDevice(r.body.credentials);
      await pub(c, creds.topics.telemetry, telemetry({ temperatureC: 31 }));
      c.end();
      creds.password = r.body.credentials.password;
    });
    await check('revocation disconnects the live session at once, then blocks connection and ACL', async () => {
      const live = await connectDevice(creds);
      const closed = new Promise<void>((r) => live.once('close', () => r()));
      const before = kicked.length;
      assert.equal((await http('POST', `/api/v1/devices/${dev.id}/revoke`, tA, { reason: 'e2e' })).status, 200);
      await Promise.race([closed, sleep(3000).then(() => { throw new Error('session still open after revocation'); })]);
      live.end(true);
      assert.equal(kicked.length, before + 1);
      await assert.rejects(connectDevice(creds));
      assert.equal((await hook('/internal/mqtt/authorize', { username: dev.id, topic: creds.topics.telemetry, action: 'publish' })).result, 'deny');
    });
    await check('audit log records provisioning, rotation and revocation', async () => {
      const r = await http('GET', `/api/v1/organizations/${orgA.id}/audit-logs`, tA);
      const actions = r.body.items.map((i: any) => i.action);
      for (const a of ['device.create', 'device.credentials.rotate', 'device.revoke', 'invite.accept']) assert.ok(actions.includes(a), a);
    });
    console.log('\nChannels: fields, HTTP API, controls, feeds, dashboards');
    const httpUrl = (q: string) => `${API}/api/v1/update?${q}`;
    await check('fields get numbers and control kinds', async () => {
      const r = await http('PUT', `/api/v1/projects/${proj.id}/fields`, tA, {
        metrics: [
          { metricKey: 'temperatureC', label: 'Temperature', unit: '°C', minValue: -40, maxValue: 85 },
          { metricKey: 'humidityPct', label: 'Humidity', unit: '%', minValue: 0, maxValue: 100 },
          { metricKey: 'relay', label: 'Relay', kind: 'control', minValue: 0, maxValue: 1, step: 1, decimals: 0 },
          { metricKey: 'brightness', label: 'Brightness', kind: 'control', minValue: 0, maxValue: 100, position: 6 },
        ],
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.items.map((f: any) => [f.metricKey, f.position, f.kind]), [
        ['temperatureC', 1, 'data'], ['humidityPct', 2, 'data'], ['relay', 3, 'control'], ['brightness', 6, 'control'],
      ]);
    });
    const dev2 = (await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'HTTP board', expectedIntervalSeconds: 15 })).body;
    const key2 = dev2.credentials.http.apiKey as string;
    await check('HTTP update maps field1/field2 to channel fields', async () => {
      const r = await fetch(httpUrl(`api_key=${encodeURIComponent(key2)}&field1=24.5&field2=55`));
      const body = await r.json();
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.deepEqual(body.values, { temperatureC: 24.5, humidityPct: 55 });
      const latest = await http('GET', `/api/v1/devices/${dev2.device.id}/telemetry/latest`, tA);
      assert.equal(latest.body.items.find((i: any) => i.metric === 'temperatureC').value, 24.5);
      const d = await http('GET', `/api/v1/devices/${dev2.device.id}`, tA);
      assert.equal(d.body.lifecycleStatus, 'active');
      assert.equal(d.body.connectivity.status, 'online');
    });
    await check('HTTP update: POST JSON, rejects bad key, non-numbers, unknown fields, out of range', async () => {
      await sleep(1100);
      const post = await fetch(`${API}/api/v1/update`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key2 }, body: JSON.stringify({ humidityPct: 57 }) });
      assert.equal(post.status, 200);
      await sleep(1100);
      // Preferred: key in the Authorization header, nothing secret in the URL.
      const bearer = await fetch(`${API}/api/v1/update?field2=58`, { headers: { authorization: `Bearer ${key2}` } });
      assert.equal(bearer.status, 200, await bearer.text());
      assert.equal((await fetch(`${API}/api/v1/update?field2=58`, { headers: { authorization: 'Bearer not-a-real-key-123456' } })).status, 401);
      assert.equal((await fetch(httpUrl('api_key=not-a-real-key-123456&field1=1'))).status, 401);
      await sleep(1100);
      assert.equal((await fetch(httpUrl(`api_key=${key2}&field1=hot`))).status, 400);
      await sleep(1100);
      assert.equal((await fetch(httpUrl(`api_key=${key2}&pressureHpa=1000`))).status, 400);
      await sleep(1100);
      assert.equal((await fetch(httpUrl(`api_key=${key2}&field1=500`))).status, 400);
    });
    await check('HTTP update is rate limited per device', async () => {
      await sleep(5200);
      const codes = [];
      for (let i = 0; i < 8; i++) codes.push((await fetch(httpUrl(`api_key=${key2}&field2=${50 + i}`))).status);
      assert.ok(codes.includes(429), String(codes));
    });

    const c2 = dev2.credentials;
    const cmdTopic = c2.topics.commands as string;
    const board = await connectDevice(c2);
    const received: any[] = [];
    board.on('message', (t, p) => t === cmdTopic && received.push(JSON.parse(p.toString())));
    await check('device can subscribe to its own control topic only', async () => {
      const ok = await new Promise<any>((r) => board.subscribe(cmdTopic, { qos: 1 }, (e, g) => r(e ?? g)));
      assert.ok(Array.isArray(ok) && ok[0].qos !== 128, JSON.stringify(ok));
      assert.equal((await hook('/internal/mqtt/authorize', { username: dev2.device.id, topic: cmdTopic.replace(dev2.device.id, randomUUID()), action: 'subscribe' })).result, 'deny');
    });
    await check('setting a control pushes it to the device over MQTT (and clamps to max)', async () => {
      const r1 = await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, tA, { field: 'relay', value: 1 });
      const r2 = await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, tA, { field: 'brightness', value: 150 });
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.equal(r1.body.pushedOverMqtt, true);
      assert.equal(r2.body.value, 100);
      await sleep(600);
      assert.deepEqual(received.map((m) => [m.field, m.value]), [['relay', 1], ['brightness', 100]]);
    });
    await check('controls: data fields and viewers are refused', async () => {
      assert.equal((await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, tA, { field: 'temperatureC', value: 1 })).status, 400);
      assert.equal((await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, tB, { field: 'relay', value: 0 })).status, 403);
    });
    await check('HTTP devices poll control values (JSON and plain text by field number)', async () => {
      const j = await (await fetch(`${API}/api/v1/controls?api_key=${key2}`)).json();
      assert.deepEqual(j, { relay: 1, brightness: 100 });
      assert.equal(await (await fetch(`${API}/api/v1/controls?api_key=${key2}&field=field3`)).text(), '1');
      assert.equal(await (await fetch(`${API}/api/v1/controls?api_key=${key2}&field=brightness`)).text(), '100');
    });
    await check('control values are re-sent when the device reconnects', async () => {
      board.end(true);
      await sleep(300);
      const again = await connectDevice(c2);
      const got: any[] = [];
      again.on('message', (t, p) => got.push(JSON.parse(p.toString())));
      await new Promise((r) => again.subscribe(cmdTopic, { qos: 1 }, r));
      await sleep(2800);
      again.end(true);
      assert.deepEqual(got.map((m) => m.field).sort(), ['brightness', 'relay']);
    });
    await check('channel feeds: JSON and CSV with the read key, refused with a wrong key', async () => {
      const p = (await http('GET', `/api/v1/projects/${proj.id}`, tA)).body;
      assert.match(p.readApiKey, /^[A-Z0-9]{16}$/);
      const j = await (await fetch(`${API}/api/v1/channels/${proj.id}/feeds.json?api_key=${p.readApiKey}&results=50&device=${dev2.device.id}`)).json();
      assert.equal(j.channel.field1, 'Temperature');
      assert.ok(j.feeds.some((f: any) => f.field1 === 24.5 && f.field2 === 55), JSON.stringify(j.feeds.slice(0, 3)));
      const csv = await (await fetch(`${API}/api/v1/channels/${proj.id}/feeds.csv?api_key=${p.readApiKey}`)).text();
      assert.match(csv.split('\n')[0], /^created_at,device_id,device_name,Temperature \(°C\),Humidity \(%\)/);
      assert.equal((await fetch(`${API}/api/v1/channels/${proj.id}/feeds.json?api_key=WRONGWRONGWRONG1`)).status, 401);
      const viaToken = await fetch(`${API}/api/v1/channels/${proj.id}/feeds.json`, { headers: { authorization: `Bearer ${tA}` } });
      assert.equal(viaToken.status, 200);
    });
    await check('dashboard layout saves and loads; viewers cannot change it', async () => {
      const widgets = [
        { id: 'w1', type: 'gauge', title: 'Temperature', field: 'temperatureC', size: 'm', options: { min: 0, max: 50 } },
        { id: 'w2', type: 'switch', title: 'Pump', field: 'relay', size: 's', options: {} },
      ];
      assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/dashboard`, tA, { widgets })).status, 200);
      const g = await http('GET', `/api/v1/projects/${proj.id}/dashboard`, tB);
      assert.equal(g.body.widgets.length, 2);
      assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/dashboard`, tB, { widgets: [] })).status, 403);
    });

    await check('worker exposes metrics', async () => {
      const m = await (await fetch('http://127.0.0.1:19100/metrics')).text();
      assert.match(m, /arc_ingest_accepted_total 4/);
      assert.match(m, /arc_ingest_duplicates_total 1/);
    });

    await phases4to7({ tA, tB, orgA, orgB, proj, dev2, key2, sinks });
    await accountDeletion({ tA, orgA, kicked });
    await orgSuspension({ tA, tB, orgA, orgB });
    await rolesAndOwnership({ tA, tB, orgA, orgB });
    await invitationsAndSeats({ tA, tB, orgA, sinks });
    await onboarding({ tA, tB, sinks });
    await channelAccess({ tA, tB, orgA, proj, sinks });
    await platformBoundary({ tA, tB, orgB, sinks });
  } finally {
    for (const p of procs) p.kill('SIGTERM');
    await new Promise((r) => broker.close(() => r(null)));
    server.close();
    emqxAdmin.close();
    await sinks.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------------------------
// Phases 4–7 (rules & alerts, integrations, hardening, commands & OTA)
// ---------------------------------------------------------------------------------------

const SMTP_PORT = 18925;
const SINK_PORT = 18926;
const SINK = `http://127.0.0.1:${SINK_PORT}`;

interface Sinks {
  emails: { to: string; raw: string }[];
  hooks: { path: string; headers: Record<string, string>; body: string }[];
  close: () => Promise<void>;
}

async function startSinks(): Promise<Sinks> {
  const { SMTPServer } = await import('smtp-server');
  const { createServer: createHttp } = await import('node:http');
  const emails: Sinks['emails'] = [];
  const hooks: Sinks['hooks'] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (d) => (raw += d));
      stream.on('end', () => {
        for (const r of session.envelope.rcptTo) emails.push({ to: r.address, raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  const web = createHttp((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hooks.push({ path: req.url ?? '', headers: req.headers as Record<string, string>, body });
      res.writeHead(req.url?.startsWith('/fail') ? 500 : 204).end();
    });
  });
  await new Promise<void>((r) => web.listen(SINK_PORT, '127.0.0.1', r));
  return {
    emails,
    hooks,
    close: async () => {
      await new Promise<void>((r) => smtp.close(() => r()));
      await new Promise<void>((r) => web.close(() => r()));
    },
  };
}

/** The token from the newest confirmation email sent to `to` (quoted-printable decoded). */
async function emailedToken(sinks: Sinks, to: string): Promise<string> {
  const mail = await eventually(async () => [...sinks.emails].reverse().find((e) => e.to === to && e.raw.includes('verify-email')), `confirmation email to ${to}`);
  const text = mail.raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return /verify-email#token=([A-Za-z0-9_-]+)/.exec(text)![1];
}

async function sql(text: string, params: unknown[] = []) {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

async function eventually<T>(fn: () => Promise<T | undefined | null | false>, what: string, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`);
}

/** A sign-in token for an existing account, made with the test API's JWT secret (sign-in is rate-limited per IP). */
async function tokenFor(email: string) {
  const { createHmac } = await import('node:crypto');
  const id = (await sql(`SELECT id FROM users WHERE email = $1`, [email]))[0].id as string;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, iat: now, exp: now + 600, iss: 'arc-cloud', aud: 'arc-cloud-api' })}`;
  return { id, token: `${head}.${createHmac('sha256', SECRETS.JWT_SECRET).update(head).digest('base64url')}` };
}

/** The token from the newest invitation email to `to` (quoted-printable decoded). */
async function emailedInviteToken(sinks: Sinks, to: string): Promise<string> {
  const mail = await eventually(async () => [...sinks.emails].reverse().find((e) => e.to === to && e.raw.includes('invite#token')), `invitation email to ${to}`);
  const text = mail.raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return /invite#token=([A-Za-z0-9_-]+)/.exec(text)![1];
}

/** A confirmed account made in SQL (sign-up is rate-limited per IP, and this suite is at it). */
async function sqlUser(email: string, opts: { accountType?: string | null } = {}) {
  await sql(
    `INSERT INTO users (email, display_name, email_verified_at, age_group, account_type, terms_version, terms_accepted_at) VALUES ($1, $2, now(), 'adult', $3, '2000-01-01', now())`,
    [email, email, opts.accountType === undefined ? 'individual' : opts.accountType],
  );
  return tokenFor(email);
}

async function invitationsAndSeats(ctx: { tA: string; tB: string; orgA: any; sinks: Sinks }) {
  const { tA, tB, orgA, sinks } = ctx;
  console.log('\nInvitations & seats');
  const tokenOf = (link: string) => new URL(link).hash.slice('#token='.length);
  const invite = (email: string, role = 'viewer', token = tA) => http('POST', `/api/v1/organizations/${orgA.id}/invitations`, token, { email, role });
  await check('an emailed invitation: preview, bound to the invited address, single use; the link is emailed and never kept', async () => {
    const dana = await sqlUser('dana@invite.test', { accountType: null });
    const r = await invite('dana@invite.test', 'engineer');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const token = await emailedInviteToken(sinks, 'dana@invite.test');
    assert.equal(token, tokenOf(r.body.link), 'the emailed link is the one shown to the inviter');
    const pre = await fetch(`${API}/api/v1/invitations/preview?token=${token}`);
    assert.equal(pre.status, 200);
    assert.deepEqual(await pre.json(), { organizationName: 'ARC Labs', role: 'engineer', invitedBy: 'Alice', email: 'd***@invite.test', expiresAt: r.body.expiresAt });
    assert.equal((await fetch(`${API}/api/v1/invitations/preview?token=${'x'.repeat(32)}`)).status, 404);
    // Someone else's account cannot use it, and trying does not use it up.
    assert.equal((await http('POST', '/api/v1/invitations/accept', tB, { token })).body.code, 'invite_email_mismatch');
    // Nor can it be redeemed as a shared code.
    assert.equal((await http('POST', '/api/v1/auth/redeem-invite', dana.token, { inviteCode: token })).body.code, 'invite_invalid');
    const ok = await http('POST', '/api/v1/invitations/accept', dana.token, { token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.organization.role, 'engineer');
    assert.equal((await sql(`SELECT account_type FROM users WHERE id = $1`, [dana.id]))[0].account_type, 'organization', 'joining answers "who is this account for?"');
    assert.equal((await http('POST', '/api/v1/invitations/accept', dana.token, { token })).body.code, 'invite_invalid', 'single use');
    const listed = (await http('GET', `/api/v1/organizations/${orgA.id}/invitations`, tA)).body.items.find((i: any) => i.email === 'dana@invite.test');
    assert.equal(listed.status, 'used_up');
    assert.equal(listed.acceptedBy, 'dana@invite.test');
    assert.equal(listed.code, undefined);
    await eventually(
      async () => (await sql(`SELECT payload FROM deliveries WHERE event_type = 'auth.invitation' AND recipient = 'dana@invite.test'`)).every((d) => d.payload.redacted === true && !d.payload.text && !d.payload.html),
      'invitation link not kept in the outbox',
    );
    assert.equal((await sql(`SELECT count(*)::int AS n FROM invite_codes WHERE code_hash = $1 OR code_hash = $2`, [token, tokenOf(r.body.link)]))[0].n, 0, 'only a hash is stored');
  });
  await check('re-inviting replaces the open link; revoked and expired invitations are refused', async () => {
    const eve = await sqlUser('eve@invite.test');
    const first = tokenOf((await invite('eve@invite.test')).body.link);
    const second = (await invite('eve@invite.test')).body;
    assert.equal((await http('POST', '/api/v1/invitations/accept', eve.token, { token: first })).body.code, 'invite_invalid', 'the older link died');
    const rv = await http('POST', `/api/v1/organizations/${orgA.id}/invitations/${second.id}/revoke`, tA, {});
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.equal((await http('POST', '/api/v1/invitations/accept', eve.token, { token: tokenOf(second.link) })).body.code, 'invite_invalid', 'revoked');
    const third = (await invite('eve@invite.test')).body;
    await sql(`UPDATE invite_codes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [third.id]);
    assert.equal((await http('POST', '/api/v1/invitations/accept', eve.token, { token: tokenOf(third.link) })).body.code, 'invite_invalid', 'expired');
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tB, { email: 'x@invite.test', role: 'viewer' })).status, 403, 'viewers cannot invite');
  });
  await check('seats: members and open invitations count; a full organization refuses invitations and class codes until the limit rises', async () => {
    const before = (await http('GET', `/api/v1/organizations/${orgA.id}/seats`, tA)).body;
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/seats`, tA, { seatLimit: before.max + 1 })).body.code, 'seat_limit_above_plan');
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/seats`, tA, { seatLimit: before.members + before.pending })).status, 200);
    assert.equal((await invite('frank@invite.test')).body.code, 'seats_full');
    const code = (await http('POST', `/api/v1/organizations/${orgA.id}/class-codes`, tA, { label: 'Batch', role: 'viewer', maxUses: 2, expiresInDays: 7 })).body;
    assert.match(code.code, /^ARC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const gina = await sqlUser('gina@invite.test');
    assert.equal((await http('POST', '/api/v1/auth/redeem-invite', gina.token, { inviteCode: code.code })).body.code, 'seats_full');
    assert.equal((await sql(`SELECT used_count FROM invite_codes WHERE id = $1`, [code.id]))[0].used_count, 0, 'a refused join does not use the code');
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/seats`, tA, { seatLimit: null })).status, 200);
    const joined = await http('POST', '/api/v1/auth/redeem-invite', gina.token, { inviteCode: code.code });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.organization.role, 'viewer');
  });
  await check('class codes: student or viewer only; used up; revoking can remove the people who joined with it', async () => {
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/class-codes`, tA, { label: 'x', role: 'admin', maxUses: 1, expiresInDays: 1 })).status, 400);
    const code = (await http('POST', `/api/v1/organizations/${orgA.id}/class-codes`, tA, { label: 'One seat', role: 'viewer', maxUses: 1, expiresInDays: 7 })).body;
    const hank = await sqlUser('hank@invite.test');
    const ivy = await sqlUser('ivy@invite.test');
    assert.equal((await http('POST', '/api/v1/auth/redeem-invite', hank.token, { inviteCode: code.code })).status, 200);
    assert.equal((await http('POST', '/api/v1/auth/redeem-invite', ivy.token, { inviteCode: code.code })).body.code, 'invite_invalid', 'used up');
    const rv = await http('POST', `/api/v1/organizations/${orgA.id}/invitations/${code.id}/revoke`, tA, { removeMembers: true });
    assert.equal(rv.body.removedMembers, 1);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1 AND user_id = $2`, [orgA.id, hank.id]))[0].n, 0);
    const actions = (await sql(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'invite.%'`, [orgA.id])).map((a: any) => a.action);
    for (const a of ['invite.create', 'invite.accept', 'invite.revoke']) assert.ok(actions.includes(a), a);
  });
}

/** The setup code from the newest setup-code email to `to`. */
async function emailedSetupCode(sinks: Sinks, to: string): Promise<string> {
  const mail = await eventually(async () => [...sinks.emails].reverse().find((e) => e.to === to && /setup code/i.test(e.raw)), `setup code email to ${to}`);
  const text = mail.raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return /ARC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(text)![0];
}

async function onboarding(ctx: { tA: string; tB: string; sinks: Sinks }) {
  const { tA, tB, sinks } = ctx;
  console.log('\nOnboarding: who are you, organization setup codes');
  const asStaff = async <T>(fn: () => Promise<T>) => {
    await sql(`UPDATE users SET is_platform_admin = true WHERE email = 'alice@arclabs.test'`);
    try {
      return await fn();
    } finally {
      await sql(`UPDATE users SET is_platform_admin = false WHERE email = 'alice@arclabs.test'`);
    }
  };
  const create = (body: Record<string, unknown>, token: string) => http('POST', '/api/v1/onboarding/organization', token, body);
  let olgaToken = '';
  await check('ARC LABS issues a setup code bound to an email; it is emailed; staff see only their own codes', async () => {
    const r = await asStaff(() => http('POST', '/api/v1/platform/org-setup-codes', tA, { email: 'Olga@Onboard.test', plan: 'pro', orgType: 'college' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.code, /^ARC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(r.body.email, 'olga@onboard.test');
    assert.equal(await emailedSetupCode(sinks, 'olga@onboard.test'), r.body.code);
    assert.equal((await http('POST', '/api/v1/platform/org-setup-codes', tB, { email: 'x@onboard.test', plan: 'pro' })).status, 403, 'staff only');
    const list = (await asStaff(() => http('GET', '/api/v1/platform/invites', tA))).body.items;
    assert.ok(list.some((i: any) => i.kind === 'org_setup' && i.email === 'olga@onboard.test' && i.plan === 'pro' && i.orgType === 'college'));
    assert.ok(!list.some((i: any) => i.kind === 'email' || i.kind === 'class'), 'organizations\' own invitations are not shown to staff');
  });
  await check('a setup code works only for its address, only to create an organization, and a failure does not use it up', async () => {
    const code = await emailedSetupCode(sinks, 'olga@onboard.test');
    const olga = await sqlUser('olga@onboard.test', { accountType: null });
    olgaToken = olga.token;
    assert.equal((await create({ setupCode: 'ARC-AAAA-BBBB-CCCC', name: 'X', slug: 'x-college' }, olga.token)).body.code, 'setup_code_invalid');
    assert.equal((await create({ setupCode: code, name: 'Bob College', slug: 'bob-college' }, tB)).body.code, 'setup_code_email_mismatch');
    assert.equal((await http('POST', '/api/v1/auth/redeem-invite', olga.token, { inviteCode: code })).body.code, 'invite_invalid', 'not a join code');
    // Not usable as a sign-up code either (complete-profile claims codes the same way sign-up does).
    await sql(`INSERT INTO users (email, display_name, email_verified_at) VALUES ('noage@onboard.test', 'No age', now())`);
    const noAge = await tokenFor('noage@onboard.test');
    assert.equal((await http('POST', '/api/v1/auth/complete-profile', noAge.token, { ageGroup: 'adult', inviteCode: code })).body.code, 'invite_invalid');
    assert.equal((await create({ setupCode: code, name: 'Taken', slug: 'arc-labs' }, olga.token)).body.code, 'slug_taken');
    assert.equal((await sql(`SELECT used_count FROM invite_codes WHERE email = 'olga@onboard.test'`))[0].used_count, 0, 'still unused');
  });
  await check('using it creates the organization with the plan and type from the code; the person becomes its owner; once only', async () => {
    const code = await emailedSetupCode(sinks, 'olga@onboard.test');
    const r = await create({ setupCode: code.toLowerCase(), name: 'Anurag University', slug: 'anurag-university', orgType: 'industry' }, olgaToken);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.organization, { id: r.body.organization.id, name: 'Anurag University', slug: 'anurag-university', orgType: 'college', plan: 'pro', role: 'owner' });
    const [o] = await sql(`SELECT kind, org_type, plan, max_members, max_devices FROM organizations WHERE id = $1`, [r.body.organization.id]);
    assert.deepEqual(o, { kind: 'organization', org_type: 'college', plan: 'pro', max_members: 500, max_devices: 1000 }, 'the code fixes the type');
    const me = (await http('GET', '/api/v1/auth/me', olgaToken)).body;
    assert.equal(me.user.accountType, 'organization');
    assert.equal(me.isPlatformAdmin, false, 'owning an organization grants no platform privileges');
    assert.equal((await http('GET', '/api/v1/platform/organizations', olgaToken)).status, 403);
    assert.deepEqual(me.memberships.map((m: any) => m.role), ['owner']);
    assert.equal((await create({ setupCode: code, name: 'Again', slug: 'again-org' }, olgaToken)).body.code, 'setup_code_invalid', 'single use');
    // The new owner can invite straight away.
    assert.equal((await http('POST', `/api/v1/organizations/${r.body.organization.id}/invitations`, olgaToken, { email: 'staff1@anurag.test', role: 'admin' })).status, 201);
  });
  await check('a code without a type lets its owner choose; revoked and expired codes are refused', async () => {
    const pat = await sqlUser('pat@onboard.test', { accountType: null });
    const c1 = (await asStaff(() => http('POST', '/api/v1/platform/org-setup-codes', tA, { email: 'pat@onboard.test', plan: 'free' }))).body;
    assert.equal((await create({ setupCode: c1.code, name: 'Pat Works', slug: 'pat-works' }, pat.token)).body.code, 'org_type_required');
    const ok = await create({ setupCode: c1.code, name: 'Pat Works', slug: 'pat-works', orgType: 'industry' }, pat.token);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.organization.orgType, 'industry');
    const c2 = (await asStaff(() => http('POST', '/api/v1/platform/org-setup-codes', tA, { email: 'pat@onboard.test', plan: 'pro', orgType: 'corporate' }))).body;
    await asStaff(() => http('POST', `/api/v1/platform/invites/${c2.id}/revoke`, tA, {}));
    assert.equal((await create({ setupCode: c2.code, name: 'P2', slug: 'pat-two' }, pat.token)).body.code, 'setup_code_invalid', 'revoked');
    const c3 = (await asStaff(() => http('POST', '/api/v1/platform/org-setup-codes', tA, { email: 'pat@onboard.test', plan: 'pro', orgType: 'corporate' }))).body;
    await sql(`UPDATE invite_codes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [c3.id]);
    assert.equal((await create({ setupCode: c3.code, name: 'P3', slug: 'pat-three' }, pat.token)).body.code, 'setup_code_invalid', 'expired');
  });
  await check('individuals say what they do, once; no platform privileges', async () => {
    const quinn = await sqlUser('quinn@onboard.test', { accountType: null });
    assert.equal((await http('POST', '/api/v1/onboarding/individual', quinn.token, { profession: 'astronaut' })).status, 400);
    const r = await http('POST', '/api/v1/onboarding/individual', quinn.token, { profession: 'hobbyist' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const me = (await http('GET', '/api/v1/auth/me', quinn.token)).body;
    assert.deepEqual([me.user.accountType, me.user.profession, me.isPlatformAdmin], ['individual', 'hobbyist', false]);
    assert.equal((await http('POST', '/api/v1/onboarding/individual', quinn.token, { profession: 'engineer' })).body.code, 'account_type_set');
  });
}

async function channelAccess(ctx: { tA: string; tB: string; orgA: any; proj: any; sinks: Sinks }) {
  const { tA, tB, orgA, proj, sinks } = ctx;
  console.log('\nChannel-level access: teachers, students');
  const tokenOf = (link: string) => new URL(link).hash.slice('#token='.length);
  const labB = await http('POST', '/api/v1/projects', tA, { organizationId: orgA.id, name: 'Lab B' });
  assert.equal(labB.status, 201, JSON.stringify(labB.body));
  const projB = labB.body.id as string;
  const tess = await sqlUser('tess@lab.test', { accountType: null });
  const stu = await sqlUser('stu@lab.test', { accountType: null });
  const sam = await sqlUser('sam@lab.test', { accountType: null });
  const ids = Object.fromEntries((await sql(`SELECT email, id FROM users WHERE email IN ('bob@other.test')`)).map((r: any) => [r.email, r.id]));
  const orgWide = [
    `/api/v1/organizations/${orgA.id}/overview`,
    `/api/v1/organizations/${orgA.id}/members`,
    `/api/v1/organizations/${orgA.id}/usage`,
    `/api/v1/organizations/${orgA.id}/audit-logs`,
    `/api/v1/organizations/${orgA.id}/rejected-messages`,
    `/api/v1/alerts?organizationId=${orgA.id}`,
    `/api/v1/api-keys?organizationId=${orgA.id}`,
    `/api/v1/firmware/releases?organizationId=${orgA.id}`,
  ];
  const projects = async (t: string) => (await http('GET', `/api/v1/projects?organizationId=${orgA.id}`, t)).body.items.map((p: any) => p.id).sort();
  await check('a teacher invited with a channel sees only that channel, with engineer rights there, and nothing organization-wide', async () => {
    const inv = await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tA, { email: 'tess@lab.test', role: 'teacher', projectIds: [proj.id] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal((await http('POST', '/api/v1/invitations/accept', tess.token, { token: tokenOf(inv.body.link) })).status, 200);
    assert.deepEqual(await projects(tess.token), [proj.id]);
    assert.equal((await http('GET', `/api/v1/projects/${proj.id}`, tess.token)).status, 200);
    assert.equal((await http('GET', `/api/v1/devices?projectId=${proj.id}`, tess.token)).status, 200);
    assert.equal((await http('GET', `/api/v1/projects/${projB}`, tess.token)).status, 404, 'other channels do not exist for them');
    assert.equal((await http('GET', `/api/v1/devices?projectId=${projB}`, tess.token)).status, 404);
    for (const path of orgWide) assert.equal((await http('GET', path, tess.token)).status, 404, path);
    assert.equal((await http('GET', `/api/v1/organizations/${orgA.id}`, tess.token)).status, 200, 'the organization name is fine');
    assert.equal((await http('POST', '/api/v1/projects', tess.token, { organizationId: orgA.id, name: 'Mine' })).status, 404, 'no new channels');
    assert.equal((await http('PATCH', `/api/v1/projects/${proj.id}`, tess.token, { description: 'Set by the teacher' })).status, 200, 'engineer rights in their channel');
  });
  await check('teachers invite students only, only into their own channels; students see their channel read-only', async () => {
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tess.token, { email: 'stu@lab.test', role: 'engineer' })).body.code, 'role_not_assignable');
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tess.token, { email: 'stu@lab.test', role: 'viewer' })).body.code, 'role_not_assignable');
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tess.token, { email: 'stu@lab.test', role: 'student', projectIds: [projB] })).status, 404, 'not their channel');
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tA, { email: 'x@lab.test', role: 'engineer', projectIds: [proj.id] })).body.code, 'channels_for_scoped_roles');
    const inv = await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tess.token, { email: 'stu@lab.test', role: 'student', projectIds: [proj.id] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal((await http('POST', '/api/v1/invitations/accept', stu.token, { token: await emailedInviteToken(sinks, 'stu@lab.test') })).status, 200);
    assert.deepEqual(await projects(stu.token), [proj.id]);
    assert.equal((await http('GET', `/api/v1/devices?projectId=${proj.id}`, stu.token)).status, 200);
    assert.equal((await http('POST', '/api/v1/devices', stu.token, { projectId: proj.id, displayName: 'nope' })).status, 403, 'viewer level');
    assert.equal((await http('GET', `/api/v1/projects/${projB}`, stu.token)).status, 404);
    for (const path of orgWide) assert.equal((await http('GET', path, stu.token)).status, 404, path);
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, stu.token, { email: 'y@lab.test', role: 'student' })).status, 403, 'students do not invite');
    // A teacher sees only the invitations they made.
    const mine = (await http('GET', `/api/v1/organizations/${orgA.id}/invitations`, tess.token)).body.items;
    assert.ok(mine.length > 0 && mine.every((i: any) => i.email === 'stu@lab.test'), JSON.stringify(mine.map((i: any) => i.email)));
    const alices = (await http('GET', `/api/v1/organizations/${orgA.id}/invitations`, tA)).body.items.find((i: any) => i.email === 'tess@lab.test');
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/invitations/${alices.id}/revoke`, tess.token, {})).status, 404, 'not theirs to revoke');
  });
  await check('channel access: a class code with a channel; teachers grant and remove students; roles that see everything are not granted', async () => {
    const code = await http('POST', `/api/v1/organizations/${orgA.id}/class-codes`, tess.token, { label: 'Lab class', role: 'student', maxUses: 30, expiresInDays: 7, projectIds: [proj.id] });
    assert.equal(code.status, 201, JSON.stringify(code.body));
    assert.equal((await http('POST', '/api/v1/auth/redeem-invite', sam.token, { inviteCode: code.body.code })).status, 200);
    assert.deepEqual(await projects(sam.token), [proj.id]);
    const access = (await http('GET', `/api/v1/projects/${proj.id}/access`, tess.token)).body;
    assert.deepEqual(access.grants.map((g: any) => g.email).sort(), ['sam@lab.test', 'stu@lab.test']);
    assert.ok(!JSON.stringify(access).includes('alice@arclabs.test'), 'a teacher does not get the member list');
    assert.equal((await http('DELETE', `/api/v1/projects/${proj.id}/access/${sam.id}`, tess.token)).status, 204);
    assert.equal((await http('GET', `/api/v1/projects/${proj.id}`, sam.token)).status, 404, 'access removed');
    assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/access/${sam.id}`, tess.token, {})).status, 200);
    assert.equal((await http('GET', `/api/v1/projects/${proj.id}`, sam.token)).status, 200);
    assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/access/${ids['bob@other.test']}`, tA, {})).body.code, 'not_scoped');
    assert.equal((await http('PUT', `/api/v1/projects/${projB}/access/${sam.id}`, tess.token, {})).status, 404, 'not the teacher\'s channel');
    assert.equal((await http('GET', `/api/v1/projects/${proj.id}/access`, tB)).status, 403, 'a viewer does not manage access');
    assert.equal((await http('PUT', `/api/v1/projects/${projB}/access/${tess.id}`, tA, {})).status, 200, 'the owner grants a teacher another channel');
    assert.deepEqual(await projects(tess.token), [proj.id, projB].sort());
    const actions = (await sql(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'channel.access_%'`, [orgA.id])).map((a: any) => a.action);
    assert.ok(actions.includes('channel.access_grant') && actions.includes('channel.access_revoke'));
  });
  await check('leaving the organization or deleting the channel removes the grants', async () => {
    assert.equal((await http('DELETE', `/api/v1/organizations/${orgA.id}/members/${stu.id}`, tA)).status, 204);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM project_members WHERE user_id = $1`, [stu.id]))[0].n, 0);
    const del = await http('DELETE', `/api/v1/projects/${projB}`, tA, { confirmName: 'Lab B' });
    assert.ok(del.status >= 200 && del.status < 300, JSON.stringify(del.body));
    assert.equal((await sql(`SELECT count(*)::int AS n FROM project_members WHERE project_id = $1`, [projB]))[0].n, 0);
    assert.deepEqual(await projects(tess.token), [proj.id]);
  });
}

async function platformBoundary(ctx: { tA: string; tB: string; orgB: any; sinks: Sinks }) {
  const { tA, tB, orgB, sinks } = ctx;
  console.log('\nPlatform boundary: metadata only, support access');
  // Alice plays an ARC LABS staff member; orgB (owned by Bob) is the customer.
  await sql(`UPDATE users SET is_platform_admin = true WHERE email = 'alice@arclabs.test'`);
  try {
    const projB = (await http('POST', '/api/v1/projects', tB, { organizationId: orgB.id, name: 'Customer channel' })).body.id as string;
    const devB = (await http('POST', '/api/v1/devices', tB, { projectId: projB, displayName: 'Customer device' })).body.device.id as string;
    const tenantRoutes = [
      `/api/v1/organizations/${orgB.id}`,
      `/api/v1/organizations/${orgB.id}/overview`,
      `/api/v1/organizations/${orgB.id}/members`,
      `/api/v1/projects/${projB}`,
      `/api/v1/devices/${devB}`,
      `/api/v1/devices?projectId=${projB}`,
      `/api/v1/channels/${projB}/feeds.json`,
    ];
    let support = '';
    await check('ARC LABS staff see metadata, not an organization\'s data', async () => {
      const orgs = (await http('GET', '/api/v1/platform/organizations', tA)).body.items;
      assert.ok(orgs.some((o: any) => o.id === orgB.id), 'listed with its plan and counts');
      for (const path of tenantRoutes) assert.equal((await http('GET', path, tA)).status, 404, path);
      assert.ok(!(await http('GET', '/api/v1/organizations', tA)).body.items.some((o: any) => o.id === orgB.id));
      const self = await http('POST', `/api/v1/organizations/${orgB.id}/members`, tA, { email: 'alice@arclabs.test', role: 'viewer' });
      assert.equal(self.body.code, 'use_support_access', 'staff cannot add themselves to look around');
    });
    await check('support access: needs a reason, is read-only, visible to the customer (audit log + email), and ends', async () => {
      assert.equal((await http('POST', `/api/v1/platform/organizations/${orgB.id}/support-access`, tA, { reason: 'help' })).status, 400, 'a real reason');
      assert.equal((await http('POST', `/api/v1/platform/organizations/${orgB.id}/support-access`, tB, { reason: 'I am not staff, let me in' })).status, 403);
      const r = await http('POST', `/api/v1/platform/organizations/${orgB.id}/support-access`, tA, { reason: 'Ticket 42: customer device not reporting', minutes: 30 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.mode, 'read-only');
      support = r.body.id;
      for (const path of tenantRoutes) assert.equal((await http('GET', path, tA)).status, 200, path);
      const listed = (await http('GET', '/api/v1/organizations', tA)).body.items.find((o: any) => o.id === orgB.id);
      assert.equal(listed.role, 'support');
      assert.equal(listed.support.id, support);
      assert.equal((await http('PATCH', `/api/v1/projects/${projB}`, tA, { description: 'changed by staff' })).body.code, 'support_read_only');
      assert.equal((await http('POST', '/api/v1/devices', tA, { projectId: projB, displayName: 'staff device' })).body.code, 'support_read_only');
      assert.equal((await http('POST', `/api/v1/devices/${devB}/revoke`, tA, {})).body.code, 'support_read_only');
      // The customer sees it: their audit log, and an email to the owner.
      const audit = (await http('GET', `/api/v1/organizations/${orgB.id}/audit-logs`, tB)).body.items;
      const opened = audit.find((a: any) => a.action === 'support.access_open');
      assert.equal(opened.metadata.reason, 'Ticket 42: customer device not reporting');
      await eventually(async () => sinks.emails.find((e) => e.to === 'bob@other.test' && /support access/i.test(e.raw)), 'email to the owner');
      const sessions = (await http('GET', '/api/v1/platform/support-access', tA)).body.items;
      assert.ok(sessions.some((x: any) => x.id === support && x.open && x.mine));
      assert.equal((await http('POST', `/api/v1/platform/support-access/${support}/end`, tA)).status, 200);
      for (const path of tenantRoutes) assert.equal((await http('GET', path, tA)).status, 404, `after ending: ${path}`);
      assert.ok((await http('GET', `/api/v1/organizations/${orgB.id}/audit-logs`, tB)).body.items.some((a: any) => a.action === 'support.access_end'));
    });
    await check('support access expires on its own', async () => {
      const r = await http('POST', `/api/v1/platform/organizations/${orgB.id}/support-access`, tA, { reason: 'Ticket 43: follow-up check', minutes: 15 });
      assert.equal((await http('GET', `/api/v1/projects/${projB}`, tA)).status, 200);
      await sql(`UPDATE support_access SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1`, [r.body.id]);
      assert.equal((await http('GET', `/api/v1/projects/${projB}`, tA)).status, 404);
    });
  } finally {
    await sql(`UPDATE users SET is_platform_admin = false WHERE email = 'alice@arclabs.test'`);
  }
}

async function rolesAndOwnership(ctx: { tA: string; tB: string; orgA: any; orgB: any }) {
  const { tA, tB, orgA, orgB } = ctx;
  console.log('\nRoles & ownership');
  const ids = Object.fromEntries((await sql(`SELECT email, id FROM users WHERE email IN ('alice@arclabs.test', 'bob@other.test', 'minor1@school.test')`)).map((r: any) => [r.email, r.id]));
  const alice = ids['alice@arclabs.test'];
  const bob = ids['bob@other.test'];
  const roleOf = async (org: string, user: string) => (await sql(`SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`, [org, user]))[0]?.role;
  await check('only the owner promotes to admin; an admin cannot touch the owner, transfer, or make admins', async () => {
    assert.equal(await roleOf(orgA.id, alice), 'owner');
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/members/${bob}`, tA, { role: 'admin' })).status, 200);
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/members/${alice}`, tB, { role: 'viewer' })).body.code, 'owner_role');
    assert.equal((await http('DELETE', `/api/v1/organizations/${orgA.id}/members/${alice}`, tB)).body.code, 'owner_role');
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/transfer-ownership`, tB, { userId: bob })).body.code, 'owner_only');
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tB, { email: 'minor1@school.test', role: 'admin' })).body.code, 'role_not_assignable');
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/members/${alice}`, tA, { role: 'owner' })).status, 400, 'owner is never assigned');
    const invited = await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tB, { email: 'minor1@school.test', role: 'viewer' });
    assert.equal(invited.status, 201, JSON.stringify(invited.body));
    const tMinor = (await tokenFor('minor1@school.test')).token;
    assert.equal((await http('POST', '/api/v1/invitations/accept', tMinor, { token: new URL(invited.body.link).hash.slice('#token='.length) })).status, 200);
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/invitations`, tB, { email: 'minor1@school.test', role: 'engineer' })).body.code, 'already_member', 'inviting a member never changes their role');
  });
  await check('a member can leave; the owner cannot', async () => {
    const tM = (await tokenFor('minor1@school.test')).token;
    assert.equal((await http('DELETE', `/api/v1/organizations/${orgA.id}/members/${ids['minor1@school.test']}`, tM)).status, 204);
    assert.equal(await roleOf(orgA.id, ids['minor1@school.test']), undefined);
    assert.equal((await http('DELETE', `/api/v1/organizations/${orgA.id}/members/${alice}`, tA)).body.code, 'owner_role');
  });
  await check('ownership transfer: to an admin only, audited, exactly one owner throughout', async () => {
    const r = await http('POST', `/api/v1/organizations/${orgA.id}/transfer-ownership`, tA, { userId: bob });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await roleOf(orgA.id, bob), 'owner');
    assert.equal(await roleOf(orgA.id, alice), 'admin');
    assert.equal((await sql(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1 AND role = 'owner'`, [orgA.id]))[0].n, 1);
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/transfer-ownership`, tA, { userId: alice })).body.code, 'owner_only', 'the old owner has no say any more');
    const audit = await sql(`SELECT metadata FROM audit_logs WHERE action = 'organization.transfer_ownership' AND organization_id = $1`, [orgA.id]);
    assert.deepEqual(audit[0].metadata, { from: alice, to: bob });
    // And back, then Bob returns to viewer (as the rest of this suite expects).
    assert.equal((await http('POST', `/api/v1/organizations/${orgA.id}/transfer-ownership`, tB, { userId: alice })).status, 200);
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/members/${bob}`, tA, { role: 'viewer' })).status, 200);
    await assert.rejects(sql(`UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2`, [orgA.id, bob]), /organization_members_one_owner/, 'the database refuses a second owner');
  });
  await check('a personal workspace has no team; a paid plan makes it an organization owned by its person', async () => {
    assert.equal(await roleOf(orgB.id, bob), 'individual');
    assert.equal((await http('POST', `/api/v1/organizations/${orgB.id}/invitations`, tB, { email: 'alice@arclabs.test', role: 'viewer' })).body.code, 'personal_workspace');
    assert.equal((await http('GET', '/api/v1/organizations', tB)).body.items.find((o: any) => o.id === orgB.id).role, 'individual');
    await sql(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [alice]);
    try {
      assert.equal((await http('PATCH', `/api/v1/organizations/${orgB.id}/plan`, tA, { plan: 'pro' })).status, 200);
    } finally {
      await sql(`UPDATE users SET is_platform_admin = false WHERE id = $1`, [alice]);
    }
    assert.equal((await sql(`SELECT kind FROM organizations WHERE id = $1`, [orgB.id]))[0].kind, 'organization');
    assert.equal(await roleOf(orgB.id, bob), 'owner');
  });
}

async function orgSuspension(ctx: { tA: string; tB: string; orgA: any; orgB: any }) {
  const { tA, tB, orgA, orgB } = ctx;
  console.log('\nSuspended organizations');
  await check('a suspended organization is closed over the API for its members, not for ARC LABS staff; reactivating restores access', async () => {
    await sql(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [orgB.id]);
    try {
      const r = await http('GET', `/api/v1/organizations/${orgB.id}/overview`, tB);
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.code, 'org_suspended');
      assert.equal((await http('GET', `/api/v1/organizations/${orgB.id}`, tB)).body.code, 'org_suspended');
      // Bob is also a viewer in orgA (added earlier in this suite): his other, active organization still works.
      assert.equal((await http('GET', `/api/v1/organizations/${orgA.id}/overview`, tB)).status, 200, 'other organizations unaffected');
      const listed = (await http('GET', '/api/v1/organizations', tB)).body.items.find((o: any) => o.id === orgB.id);
      assert.equal(listed?.status, 'suspended', 'members can still see that it is suspended');
      await sql(`UPDATE users SET is_platform_admin = true WHERE email = 'alice@arclabs.test'`);
      assert.equal((await http('GET', `/api/v1/organizations/${orgB.id}/overview`, tA)).status, 404, 'staff are not members');
      const sa = await http('POST', `/api/v1/platform/organizations/${orgB.id}/support-access`, tA, { reason: 'Customer asked why the organization is suspended', minutes: 15 });
      assert.equal(sa.status, 201, JSON.stringify(sa.body));
      assert.equal((await http('GET', `/api/v1/organizations/${orgB.id}/overview`, tA)).status, 200, 'ARC LABS staff with support access can still look');
      await http('POST', `/api/v1/platform/support-access/${sa.body.id}/end`, tA);
    } finally {
      await sql(`UPDATE users SET is_platform_admin = false WHERE email = 'alice@arclabs.test'`);
      await sql(`UPDATE organizations SET status = 'active' WHERE id = $1`, [orgB.id]);
    }
    assert.equal((await http('GET', `/api/v1/organizations/${orgB.id}/overview`, tB)).status, 200);
  });
}

async function accountDeletion(ctx: { tA: string; orgA: any; kicked: string[] }) {
  const { tA, orgA, kicked } = ctx;
  console.log('\nAccount deletion');
  // Carol: signs in with Google only by now (no password), a member of orgA, and owner of the personal workspace "Carol Co".
  const { id: carolId, token: tC } = await tokenFor('carol@join.test');
  const carolCo = (await sql(`SELECT id FROM organizations WHERE slug = 'carol-co'`))[0].id as string;
  let device: any;
  await check('setup: a channel, a Raspberry Pi device and readings in the personal workspace', async () => {
    const p = await http('POST', '/api/v1/projects', tC, { organizationId: carolCo, name: 'Home' });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const d = await http('POST', '/api/v1/devices', tC, { projectId: p.body.id, displayName: 'Pi', deviceType: 'raspberry-pi' });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    device = d.body.device;
    await sql(
      `INSERT INTO telemetry_measurements (organization_id, project_id, device_id, metric_key, metric_value, ts, received_at, message_id) VALUES ($1, $2, $3, 'temp', 21.5, now(), now(), 'm1')`,
      [carolCo, p.body.id, device.id],
    );
    await sql(`INSERT INTO ingested_messages (device_id, message_id) VALUES ($1, 'm1')`, [device.id]);
    await sql(`INSERT INTO rejected_messages (organization_id, device_id, topic, reason) VALUES ($1, $2, 't', 'schema_invalid')`, [carolCo, device.id]);
  });
  await check('deleting needs the exact email and the password; ARC LABS staff cannot delete themselves', async () => {
    // (At most 5 tries a minute per IP: this section makes exactly 5.)
    await sql(`UPDATE users SET is_platform_admin = true WHERE email = 'alice@arclabs.test'`);
    assert.equal((await http('POST', '/api/v1/auth/delete-account', tA, { confirmEmail: 'someone@else.test', currentPassword: 'correct-horse-battery' })).body.code, 'confirm_email_mismatch');
    assert.equal((await http('POST', '/api/v1/auth/delete-account', tA, { confirmEmail: 'alice@arclabs.test', currentPassword: 'wrong-password-1' })).body.code, 'wrong_password');
    assert.equal((await http('POST', '/api/v1/auth/delete-account', tA, { confirmEmail: 'alice@arclabs.test', currentPassword: 'correct-horse-battery' })).body.code, 'platform_admin_delete');
    assert.equal((await sql(`SELECT count(*)::int AS n FROM users WHERE email = 'alice@arclabs.test'`))[0].n, 1);
  });
  await check('the only admin of a workspace with other members must hand over first', async () => {
    await sql(`INSERT INTO organization_members (organization_id, user_id, role) SELECT $1, id, 'viewer' FROM users WHERE email = 'bob@other.test'`, [carolCo]);
    const plan = (await http('GET', '/api/v1/auth/delete-account', tC)).body;
    assert.deepEqual(plan.blockers.map((o: any) => o.id), [carolCo]);
    const r = await http('POST', '/api/v1/auth/delete-account', tC, { confirmEmail: 'carol@join.test' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'sole_admin');
    await sql(`DELETE FROM organization_members WHERE organization_id = $1 AND user_id <> $2`, [carolCo, carolId]);
  });
  await check('preview: the personal workspace is deleted, the organization is only left', async () => {
    const plan = (await http('GET', '/api/v1/auth/delete-account', tC)).body;
    assert.deepEqual(plan.deleteWorkspaces, [{ id: carolCo, name: 'Carol Co', devices: 1 }]);
    assert.ok(plan.leave.some((o: any) => o.id === orgA.id));
    assert.deepEqual(plan.blockers, []);
  });
  await check('delete: account, personal workspace, devices and readings gone; devices kicked; organizations keep their data', async () => {
    const orgADevices = (await sql(`SELECT count(*)::int AS n FROM devices WHERE organization_id = $1`, [orgA.id]))[0].n;
    const r = await http('POST', '/api/v1/auth/delete-account', tC, { confirmEmail: 'Carol@Join.test' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { deleted: true, deletedWorkspaces: 1, deletedDevices: 1, leftOrganizations: 1 });
    const count = async (q: string, params: unknown[]) => (await sql(q, params))[0].n;
    assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [carolId]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM organizations WHERE id = $1`, [carolCo]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM devices WHERE id = $1`, [device.id]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM device_credentials WHERE device_id = $1`, [device.id]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM telemetry_measurements WHERE organization_id = $1`, [carolCo]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM ingested_messages WHERE device_id = $1`, [device.id]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM rejected_messages WHERE organization_id = $1`, [carolCo]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM organization_members WHERE user_id = $1`, [carolId]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM devices WHERE organization_id = $1`, [orgA.id]), orgADevices, 'orgA is untouched');
    assert.ok(kicked.includes(device.id), 'the broker was asked to disconnect the deleted device');
    assert.equal((await http('GET', '/api/v1/auth/me', tC)).status, 401, 'the old session no longer works');
    const audit = await sql(`SELECT metadata FROM audit_logs WHERE action = 'user.delete' AND actor_id = $1`, [carolId]);
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit[0].metadata).includes('carol'), 'no personal data in the record');
  });
}

async function phases4to7(ctx: { tA: string; tB: string; orgA: any; orgB: any; proj: any; dev2: any; key2: string; sinks: Sinks }) {
  const { tA, tB, orgA, orgB, proj, dev2, key2, sinks } = ctx;
  const { createHmac, generateKeyPairSync, sign, verify, createHash } = await import('node:crypto');
  const httpSend = async (q: string) => {
    await sleep(1100); // per-device HTTP rate limit (1/s)
    const r = await fetch(`${API}/api/v1/update?api_key=${encodeURIComponent(key2)}&${q}`);
    assert.equal(r.status, 200, await r.text());
  };
  const activeAlerts = async (ruleId: string) =>
    (await http('GET', `/api/v1/alerts?organizationId=${orgA.id}&status=active`, tA)).body.items.filter((a: any) => a.ruleId === ruleId);

  console.log('\nRules & alerts (phase 4)');
  const hook = await http('POST', '/api/v1/webhooks', tA, { organizationId: orgA.id, name: 'Ops', url: `${SINK}/hook`, events: ['alert.triggered', 'alert.resolved', 'command.updated'] });
  let rule: any;
  await check('rules: validation, roles and creation', async () => {
    assert.equal(hook.status, 201, JSON.stringify(hook.body));
    assert.match(hook.body.secret, /^whsec_/);
    assert.equal((await http('POST', '/api/v1/rules', tA, { projectId: proj.id, name: 'Bad', ruleType: 'threshold', metricKey: 'temperatureC' })).status, 400);
    assert.equal((await http('POST', '/api/v1/rules', tB, { projectId: proj.id, name: 'Hot', ruleType: 'offline' })).status, 403);
    const r = await http('POST', '/api/v1/rules', tA, {
      projectId: proj.id, name: 'Too hot', ruleType: 'threshold', metricKey: 'temperatureC', operator: '>', threshold: 30,
      severity: 'critical', cooldownSeconds: 0, notifyEmails: ['alice@arclabs.test'],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    rule = r.body;
  });
  await check('threshold breach triggers one alert (deduplicated) with email + signed webhook', async () => {
    await httpSend('field1=35');
    const [a] = await eventually(async () => (await activeAlerts(rule.id)).length === 1 && activeAlerts(rule.id), 'alert');
    assert.equal(a.status, 'triggered');
    assert.equal(a.severity, 'critical');
    assert.equal(a.value, 35);
    await httpSend('field1=36');
    await sleep(2500);
    assert.equal((await activeAlerts(rule.id)).length, 1, 'still one active alert');
    const email = await eventually(async () => sinks.emails.find((e) => e.to === 'alice@arclabs.test' && /CRITICAL/.test(e.raw)), 'email');
    assert.match(email.raw, /CRITICAL(:|=3A)[ _]Too[ _]hot/);
    assert.match(email.raw, /Temperature is 35/);
    const wh = await eventually(async () => sinks.hooks.find((h) => h.headers['x-arc-event'] === 'alert.triggered'), 'webhook');
    const [, t, v1] = /t=(\d+),v1=([0-9a-f]+)/.exec(wh.headers['x-arc-signature'])!;
    assert.equal(createHmac('sha256', hook.body.secret).update(`${t}.${wh.body}`).digest('hex'), v1, 'valid HMAC signature');
    assert.equal(JSON.parse(wh.body).data.ruleName, 'Too hot');
  });
  let alertId = '';
  await check('acknowledge: viewer refused; engineer/admin records history', async () => {
    const [a] = await activeAlerts(rule.id);
    alertId = a.id;
    assert.equal((await http('POST', `/api/v1/alerts/${a.id}/acknowledge`, tB, {})).status, 403);
    const ack = await http('POST', `/api/v1/alerts/${a.id}/acknowledge`, tA, { note: 'Opening the vents' });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.status, 'acknowledged');
    assert.equal((await http('POST', `/api/v1/alerts/${a.id}/acknowledge`, tA, {})).status, 409);
    const d = await eventually(async () => {
      const r = (await http('GET', `/api/v1/alerts/${a.id}`, tA)).body;
      return r.notifications.some((n: any) => n.status === 'sent') && r;
    }, 'notification recorded');
    assert.deepEqual(d.history.map((h: any) => h.event).filter((e: string) => e !== 'notified'), ['triggered', 'acknowledged']);
    assert.equal(d.notifications.find((n: any) => n.kind === 'email').recipient, 'alice@arclabs.test');
  });
  await check('recovery resolves the alert automatically', async () => {
    await httpSend('field1=22');
    const a = await eventually(async () => {
      const r = (await http('GET', `/api/v1/alerts/${alertId}`, tA)).body;
      return r.status === 'resolved' && r;
    }, 'recovery');
    assert.equal(a.resolution, 'recovered');
    await eventually(async () => sinks.hooks.some((h) => h.headers['x-arc-event'] === 'alert.resolved'), 'resolved webhook');
  });
  await check('manual resolve with audit; cooldown suppresses re-trigger', async () => {
    await httpSend('field1=41');
    const [a] = await eventually(async () => (await activeAlerts(rule.id)).length === 1 && activeAlerts(rule.id), 'second alert');
    const res = await http('POST', `/api/v1/alerts/${a.id}/resolve`, tA, { note: 'fixed' });
    assert.equal(res.body.resolution, 'manual');
    assert.equal((await http('PATCH', `/api/v1/rules/${rule.id}`, tA, { cooldownSeconds: 3600 })).status, 200);
    await httpSend('field1=42');
    await sleep(3000);
    assert.equal((await activeAlerts(rule.id)).length, 0, 'cooldown holds');
    const audit = await http('GET', `/api/v1/organizations/${orgA.id}/audit-logs`, tA);
    assert.ok(audit.body.items.some((e: any) => e.action === 'alert.resolve'));
  });

  // MQTT device for offline rules, commands and OTA.
  const d3 = (await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'Pump controller', deviceType: 'esp32-pump', expectedIntervalSeconds: 5 })).body;
  const d4 = (await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'Pump controller 2', deviceType: 'esp32-pump', expectedIntervalSeconds: 5 })).body;
  const received: any[] = [];
  const connect3 = async () => {
    const c = await connectDevice(d3.credentials);
    await new Promise<void>((r, j) => c.subscribe(d3.credentials.topics.commands, { qos: 1 }, (e) => (e ? j(e) : r())));
    c.on('message', (_t, p) => received.push(JSON.parse(p.toString())));
    return c;
  };
  await check('offline rule alerts when a device disconnects', async () => {
    const off = await http('POST', '/api/v1/rules', tA, { projectId: proj.id, deviceId: d3.device.id, name: 'Pump offline', ruleType: 'offline', severity: 'warning' });
    assert.equal(off.status, 201);
    const c = await connect3();
    await pub(c, d3.credentials.topics.telemetry, telemetry({ temperatureC: 20 }));
    await sleep(1000);
    await new Promise<void>((r) => c.end(false, {}, () => r()));
    const [a] = await eventually(async () => {
      const l = await activeAlerts(off.body.id);
      return l.length === 1 && l;
    }, 'offline alert');
    assert.equal(a.deviceId, d3.device.id);
    assert.match(a.message, /disconnected/i);
  });

  await check('stale rule: waits for silence after connecting, alerts once readings stop, recovers', async () => {
    const d5 = (await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'Quiet sensor', expectedIntervalSeconds: 5 })).body;
    const st = await http('POST', '/api/v1/rules', tA, { projectId: proj.id, deviceId: d5.device.id, name: 'Quiet', ruleType: 'stale', staleSeconds: 60, severity: 'warning', cooldownSeconds: 0 });
    assert.equal(st.status, 201, JSON.stringify(st.body));
    const c = await connectDevice(d5.credentials);
    await sleep(5000); // several rule passes: connected, no reading yet, under the limit → no alert
    assert.equal((await activeAlerts(st.body.id)).length, 0, 'no alert right after connecting');
    await sql(`UPDATE devices SET last_seen_at = now() - interval '5 minutes', last_connected_at = now() - interval '5 minutes' WHERE id = $1`, [d5.device.id]);
    const [a] = await eventually(async () => {
      const l = await activeAlerts(st.body.id);
      return l.length === 1 && l;
    }, 'stale alert');
    assert.match(a.message, /No data for/);
    await pub(c, d5.credentials.topics.telemetry, telemetry({ temperatureC: 21 }));
    await eventually(async () => (await activeAlerts(st.body.id)).length === 0, 'stale alert recovers');
    await new Promise<void>((r) => c.end(false, {}, () => r()));
  });

  console.log('\nAPI keys, service accounts, webhooks, ARC LMS (phase 5)');
  const proj2 = (await http('POST', '/api/v1/projects', tA, { organizationId: orgA.id, name: 'Cold store' })).body;
  await check('scoped API key: channel-limited, read-only, revocable', async () => {
    const k = await http('POST', '/api/v1/api-keys', tA, { organizationId: orgA.id, name: 'Grafana', role: 'viewer', projectIds: [proj.id] });
    assert.equal(k.status, 201, JSON.stringify(k.body));
    assert.match(k.body.secret, /^arc_sk_/);
    const key = k.body.secret;
    assert.equal((await http('GET', `/api/v1/devices?projectId=${proj.id}`, key)).status, 200);
    assert.equal((await http('GET', `/api/v1/devices/${dev2.device.id}/telemetry/latest`, key)).status, 200);
    assert.equal((await http('GET', `/api/v1/projects/${proj2.id}`, key)).status, 404, 'other channel hidden');
    assert.equal((await http('GET', `/api/v1/projects?organizationId=${orgA.id}`, key)).body.items.length, 1);
    assert.equal((await http('GET', `/api/v1/organizations/${orgB.id}`, key)).status, 404, 'other tenant hidden');
    assert.equal((await http('POST', '/api/v1/devices', key, { projectId: proj.id, displayName: 'x' })).status, 403, 'viewer key cannot write');
    assert.equal((await http('GET', `/api/v1/organizations/${orgA.id}/members`, key)).status, 404, 'restricted key cannot list members');
    assert.equal((await http('POST', '/api/v1/organizations', key, { name: 'Nope', slug: 'nope-co' })).status, 403);
    assert.equal((await http('POST', '/api/v1/api-keys', key, { organizationId: orgA.id, name: 'escalate', role: 'engineer' })).status, 403);
    assert.equal((await http('POST', '/api/v1/auth/accept-terms', key, { version: 'x', accept: true })).status, 403, 'an API key cannot consent');
    assert.equal((await http('GET', `/api/v1/api-keys?organizationId=${orgA.id}`, tB)).status, 403, 'viewer cannot list keys');
    const list = await http('GET', `/api/v1/api-keys?organizationId=${orgA.id}`, tA);
    assert.ok(list.body.items[0].lastUsedAt, 'last used recorded');
    assert.ok(!JSON.stringify(list.body).includes(key), 'secret never listed');
    assert.equal((await http('DELETE', `/api/v1/api-keys/${k.body.id}`, tA)).status, 204);
    assert.equal((await http('GET', `/api/v1/devices?projectId=${proj.id}`, key)).status, 401);
  });
  let svcToken = '';
  await check('service account: OAuth2 client-credentials token', async () => {
    const sa = await http('POST', '/api/v1/api-keys', tA, { organizationId: orgA.id, name: 'ARC LMS', kind: 'service_account', role: 'viewer' });
    assert.equal(sa.status, 201);
    assert.equal((await http('POST', '/api/v1/oauth/token', undefined, { grant_type: 'client_credentials', client_id: sa.body.id, client_secret: 'arc_sk_wrong-wrong-wrong' })).status, 401);
    const form = await fetch(`${API}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: sa.body.id, client_secret: sa.body.secret }),
    });
    const tok = await form.json();
    assert.equal(form.status, 200, JSON.stringify(tok));
    assert.equal(tok.token_type, 'Bearer');
    svcToken = tok.access_token;
    assert.equal((await http('GET', `/api/v1/devices?projectId=${proj2.id}`, svcToken)).status, 200);
    assert.equal((await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, svcToken, { field: 'relay', value: 1 })).status, 403);
  });
  await check('webhooks: test delivery, delivery log, retries on failure', async () => {
    const t = await http('POST', `/api/v1/webhooks/${hook.body.id}/test`, tA);
    assert.equal(t.status, 202);
    await eventually(async () => sinks.hooks.some((h) => h.headers['x-arc-event'] === 'webhook.test'), 'test delivery');
    const log = await http('GET', `/api/v1/webhooks/${hook.body.id}/deliveries`, tA);
    assert.ok(log.body.items.some((d: any) => d.eventType === 'webhook.test' && d.status === 'sent' && d.responseCode === 204));
    const bad = await http('POST', '/api/v1/webhooks', tA, { organizationId: orgA.id, name: 'Broken', url: `${SINK}/fail`, events: ['*'] });
    await http('POST', `/api/v1/webhooks/${bad.body.id}/test`, tA);
    const d = await eventually(async () => {
      const items = (await http('GET', `/api/v1/webhooks/${bad.body.id}/deliveries`, tA)).body.items;
      return items[0]?.attempts >= 1 && items[0].lastError && items[0];
    }, 'failed attempt');
    assert.equal(d.status, 'pending', 'scheduled for retry');
    assert.equal(d.responseCode, 500);
    assert.ok(new Date(d.nextAttemptAt).getTime() > Date.now() + 10_000, 'backoff applied');
    assert.equal((await http('POST', '/api/v1/webhooks', tB, { organizationId: orgA.id, name: 'x', url: `${SINK}/x`, events: ['*'] })).status, 403);
    await http('DELETE', `/api/v1/webhooks/${bad.body.id}`, tA);
  });
  await check('ARC LMS: learner token limited to linked devices, read-only, revocable', async () => {
    const link = await http('POST', '/api/v1/lms/links', tA, { projectId: proj.id, lmsRef: 'iot-101/lab-3', title: 'Lab 3: sensors', deviceIds: [dev2.device.id], maxTokenMinutes: 60 });
    assert.equal(link.status, 201, JSON.stringify(link.body));
    const lt = await http('POST', `/api/v1/lms/links/${link.body.id}/learner-tokens`, svcToken, { learnerRef: 'student-42', minutes: 600 });
    assert.equal(lt.status, 201, JSON.stringify(lt.body));
    assert.equal(lt.body.expiresIn, 3600, 'capped at the link maximum');
    assert.match(lt.body.viewerUrl, /^http:\/\/console\.test\/lab#/);
    const learner = lt.body.accessToken;
    assert.equal((await http('GET', `/api/v1/devices/${dev2.device.id}/telemetry/latest`, learner)).status, 200);
    assert.equal((await http('GET', `/api/v1/devices/${d3.device.id}`, learner)).status, 404, 'unlinked device hidden');
    const list = await http('GET', `/api/v1/devices?projectId=${proj.id}`, learner);
    assert.deepEqual(list.body.items.map((d: any) => d.id), [dev2.device.id]);
    assert.equal((await http('POST', `/api/v1/devices/${dev2.device.id}/controls`, learner, { field: 'relay', value: 1 })).status, 403);
    assert.equal((await http('POST', `/api/v1/lms/links/${link.body.id}/learner-tokens`, learner, { learnerRef: 'x' })).status, 404, 'learners cannot mint tokens');
    assert.ok(JSON.stringify((await http('GET', `/api/v1/auth/me`, learner)).body).includes('student-42'));
    assert.equal((await http('DELETE', `/api/v1/lms/links/${link.body.id}`, tA)).status, 204);
    assert.equal((await http('GET', `/api/v1/devices/${dev2.device.id}/telemetry/latest`, learner)).status, 401, 'revoked link ends access');
    const audit = await http('GET', `/api/v1/organizations/${orgA.id}/audit-logs`, tA);
    assert.ok(audit.body.items.some((e: any) => e.action === 'lms.learner_token'), 'cross-platform access logged');
  });
  await check('OpenAPI documentation is published', async () => {
    const spec = await (await fetch(`${API}/api/openapi.json`)).json();
    for (const p of ['/api/v1/rules', '/api/v1/alerts/{id}/acknowledge', '/api/v1/api-keys', '/api/v1/webhooks', '/api/v1/oauth/token', '/api/v1/devices/{id}/commands', '/api/v1/firmware/releases']) {
      assert.ok(spec.paths[p], `missing ${p}`);
    }
    assert.ok(spec.paths['/api/v1/rules'].post.requestBody, 'request bodies documented');
    assert.equal((await fetch(`${API}/api/docs`)).status, 200);
  });

  console.log('\nCommands & OTA (phase 7)');
  await check('command allow-list: admin defines, others refused, reserved names blocked', async () => {
    assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/command-types/blink`, tB, { params: [] })).status, 403);
    assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/command-types/ota.update`, tA, { params: [] })).status, 400);
    const t = await http('PUT', `/api/v1/projects/${proj.id}/command-types/blink`, tA, {
      description: 'Blink the LED', params: [{ key: 'seconds', type: 'number', min: 1, max: 10, required: true }], ttlSeconds: 120,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal((await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'reboot' })).status, 400);
    assert.equal((await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 99 } })).status, 400);
    assert.equal((await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tB, { name: 'blink', payload: { seconds: 2 } })).status, 403);
  });
  let c3: MqttClient | null = null;
  await check('MQTT command: queued while offline, delivered on reconnect, acknowledged by device', async () => {
    const sent = await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 2 } });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    c3 = await connect3();
    const msg = await eventually(async () => received.find((m) => m.commandId === sent.body.id), 'command delivered');
    assert.deepEqual(msg.payload, { seconds: 2 });
    assert.equal((await http('GET', `/api/v1/commands/${sent.body.id}`, tA)).body.status !== 'acknowledged', true, 'not acknowledged before the device says so');
    await pub(c3, d3.credentials.topics.telemetry.replace(/telemetry$/, 'cmd-ack'), { commandId: sent.body.id, status: 'ok', result: { blinked: true } });
    const done = await eventually(async () => {
      const r = (await http('GET', `/api/v1/commands/${sent.body.id}`, tA)).body;
      return r.status === 'acknowledged' && r;
    }, 'ack');
    assert.deepEqual(done.result, { blinked: true });
    await eventually(async () => sinks.hooks.some((h) => h.headers['x-arc-event'] === 'command.updated' && JSON.parse(h.body).data.status === 'acknowledged'), 'command webhook');
  });
  await check('API recovers after the broker refuses its login, and delivers commands queued meanwhile', async () => {
    // Regression (pilot, 2026-10-28): the API restarted while EMQX was up; EMQX refused its first login because
    // the API's own hooks were not listening yet, and mqtt.js never retried. Switches, commands and OTA silently
    // stopped reaching devices until the API was restarted again.
    const ready = async () => (await (await fetch(`${API}/health/ready`)).json()) as { mqtt?: string };
    assert.equal((await ready()).mqtt, 'connected');
    const deep = async () => (await fetch(`${API}/health/deep`)).status;
    assert.equal(await deep(), 200, '/health/deep healthy');
    brokerControl.refuseApiLogins = true;
    try {
      assert.equal(dropBrokerClients('svc-api'), 1, 'API connection found');
      await eventually(async () => (await ready()).mqtt === 'disconnected', 'API offline');
      await sleep(4000); // at least one refused reconnect (reconnectPeriod 3 s)
      assert.equal((await ready()).mqtt, 'disconnected', 'refused while logins are refused');
      assert.equal(await deep(), 503, '/health/deep fails while the API cannot publish (uptime check alerts)');
      assert.equal((await fetch(`${API}/health/ready`)).status, 200, '/health/ready stays 200 so EMQX and Docker are not blocked');
      const q = await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 3 } });
      assert.equal(q.status, 201, JSON.stringify(q.body));
      assert.equal((await http('GET', `/api/v1/commands/${q.body.id}`, tA)).body.status, 'queued');
      brokerControl.refuseApiLogins = false;
      await eventually(async () => (await ready()).mqtt === 'connected', 'API reconnected after a refused login', 20000);
      assert.equal(await deep(), 200, '/health/deep recovers');
      const msg = await eventually(async () => received.find((m) => m.commandId === q.body.id), 'queued command delivered after reconnect');
      assert.deepEqual(msg.payload, { seconds: 3 });
      assert.equal((await http('GET', `/api/v1/commands/${q.body.id}`, tA)).body.status, 'published');
      await pub(c3!, d3.credentials.topics.telemetry.replace(/telemetry$/, 'cmd-ack'), { commandId: q.body.id, status: 'ok' });
    } finally {
      brokerControl.refuseApiLogins = false;
    }
  });
  await check('commands expire when not acknowledged; failures recorded', async () => {
    const s1 = await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 1 } });
    await sql(`UPDATE commands SET expires_at = now() - interval '1 second' WHERE id = $1`, [s1.body.id]);
    await eventually(async () => (await http('GET', `/api/v1/commands/${s1.body.id}`, tA)).body.status === 'expired', 'expired');
    const s2 = await http('POST', `/api/v1/devices/${d3.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 1 } });
    await pub(c3!, d3.credentials.topics.telemetry.replace(/telemetry$/, 'cmd-ack'), { commandId: s2.body.id, status: 'error', error: 'LED broken' });
    const f = await eventually(async () => {
      const r = (await http('GET', `/api/v1/commands/${s2.body.id}`, tA)).body;
      return r.status === 'failed' && r;
    }, 'failed');
    assert.equal(f.error, 'LED broken');
  });
  await check('HTTP device: fetch next command and acknowledge it', async () => {
    const s = await http('POST', `/api/v1/devices/${dev2.device.id}/commands`, tA, { name: 'blink', payload: { seconds: 3 } });
    await sleep(1100);
    const next = await fetch(`${API}/api/v1/commands/next?api_key=${encodeURIComponent(key2)}`);
    const body = await next.json();
    assert.equal(body.commandId, s.body.id);
    const ack = await fetch(`${API}/api/v1/commands/${s.body.id}/ack?api_key=${encodeURIComponent(key2)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"status":"ok"}' });
    assert.equal(ack.status, 200);
    assert.equal((await http('GET', `/api/v1/commands/${s.body.id}`, tA)).body.status, 'acknowledged');
    await sleep(1100);
    assert.equal((await fetch(`${API}/api/v1/commands/next?api_key=${encodeURIComponent(key2)}`)).status, 204);
    const again = await fetch(`${API}/api/v1/commands/${s.body.id}/ack?api_key=${encodeURIComponent(key2)}`, { method: 'POST' });
    assert.equal(again.status, 404, 'cannot ack twice');
  });
  await check('OTA signing keys: P-256 is device-verifiable; legacy Ed25519 accepted; RSA refused', async () => {
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const edKey = await http('POST', '/api/v1/firmware/signing-keys', tA, { organizationId: orgA.id, name: 'Legacy key', publicKeyPem: ed });
    assert.equal(edKey.status, 201, JSON.stringify(edKey.body));
    assert.equal(edKey.body.algorithm, 'ed25519');
    assert.equal(edKey.body.deviceVerifiable, false);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    assert.equal((await http('POST', '/api/v1/firmware/signing-keys', tA, { organizationId: orgA.id, name: 'RSA', publicKeyPem: rsa })).status, 400);
  });
  await check('OTA: unsigned/mis-signed releases refused; signed staged rollout completes', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const key = await http('POST', '/api/v1/firmware/signing-keys', tA, { organizationId: orgA.id, name: 'Release key', publicKeyPem: pem });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    assert.equal(key.body.algorithm, 'ecdsa-p256');
    assert.equal(key.body.deviceVerifiable, true);
    const m = { deviceType: 'esp32-pump', version: '2.0.0', url: 'https://firmware.arclabs.test/pump-2.0.0.bin', sha256: createHash('sha256').update('fw').digest('hex'), sizeBytes: 1048576 };
    const canonical = JSON.stringify({ deviceType: m.deviceType, sha256: m.sha256, sizeBytes: m.sizeBytes, url: m.url, version: m.version });
    const signature = sign('sha256', Buffer.from(canonical), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
    const badSig = sign('sha256', Buffer.from(canonical.replace('2.0.0', '2.0.1')), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
    assert.equal((await http('POST', '/api/v1/firmware/releases', tA, { organizationId: orgA.id, ...m, signature: badSig, signingKeyId: key.body.id })).status, 400);
    const rel = await http('POST', '/api/v1/firmware/releases', tA, { organizationId: orgA.id, ...m, signature, signingKeyId: key.body.id });
    assert.equal(rel.status, 201, JSON.stringify(rel.body));
    const ro = await http('POST', '/api/v1/firmware/rollouts', tA, { releaseId: rel.body.id, projectId: proj.id, percent: 50 });
    assert.equal(ro.status, 201, JSON.stringify(ro.body));
    assert.equal(ro.body.devices.length, 1, '50% of 2 devices');
    // Whichever device was picked: if it's d3, it receives the OTA command over MQTT.
    const widen = await http('PATCH', `/api/v1/firmware/rollouts/${ro.body.id}`, tA, { percent: 100 });
    assert.equal(widen.body.devices.length, 2);
    const ota = await eventually(async () => received.find((x) => x.name === 'ota.update'), 'OTA command');
    assert.equal(ota.payload.version, '2.0.0');
    assert.equal(ota.payload.signature, signature);
    // Devices verify the signature over exactly these bytes and read url/sha256/version only from them.
    assert.equal(ota.payload.manifest, canonical);
    assert.ok(verify('sha256', Buffer.from(ota.payload.manifest), { key: publicKey, dsaEncoding: 'der' }, Buffer.from(ota.payload.signature, 'base64')));
    await pub(c3!, d3.credentials.topics.telemetry.replace(/telemetry$/, 'cmd-ack'), { commandId: ota.commandId, status: 'ok' });
    await pub(c3!, d3.credentials.topics.telemetry, { ...telemetry({ temperatureC: 21 }), metadata: { firmwareVersion: '2.0.0' } });
    // d4 updates over the same rails (simulate its report).
    await sql(`UPDATE devices SET firmware_version = '2.0.0' WHERE id = $1`, [d4.device.id]);
    const final = await eventually(async () => {
      const r = (await http('GET', `/api/v1/firmware/rollouts/${ro.body.id}`, tA)).body;
      return r.status === 'completed' && r;
    }, 'rollout completed');
    assert.deepEqual(final.devices.map((d: any) => d.status), ['succeeded', 'succeeded']);
  });
  await check('OTA: cancelling a rollout or withdrawing a release closes its pending update commands', async () => {
    // Regression (pilot, 2026-10-29): cancelled rollouts kept their ota.update commands open for 24 h and the
    // worker re-sent them on every reconnect, so a device that rolled back reinstalled the same image in a loop.
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = await http('POST', '/api/v1/firmware/signing-keys', tA, { organizationId: orgA.id, name: 'Loop test key', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const release = async (version: string) => {
      const m = { deviceType: 'esp32-pump', version, url: `https://firmware.arclabs.test/pump-${version}.bin`, sha256: createHash('sha256').update(version).digest('hex'), sizeBytes: 4096 };
      const canonical = JSON.stringify({ deviceType: m.deviceType, sha256: m.sha256, sizeBytes: m.sizeBytes, url: m.url, version: m.version });
      const signature = sign('sha256', Buffer.from(canonical), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
      const rel = await http('POST', '/api/v1/firmware/releases', tA, { organizationId: orgA.id, ...m, signature, signingKeyId: key.body.id });
      assert.equal(rel.status, 201, JSON.stringify(rel.body));
      const ro = await http('POST', '/api/v1/firmware/rollouts', tA, { releaseId: rel.body.id, projectId: proj.id, percent: 100 });
      assert.equal(ro.status, 201, JSON.stringify(ro.body));
      return { rel: rel.body, ro: ro.body };
    };
    const openCommands = async (rolloutId: string) =>
      (await sql(`SELECT c.status, c.error FROM firmware_rollout_devices rd JOIN commands c ON c.id = rd.command_id WHERE rd.rollout_id = $1`, [rolloutId])) as any;
    const rowsOf = (r: any) => (Array.isArray(r) ? r : r.rows) as { status: string; error: string | null }[];

    const a = await release('3.0.0');
    assert.ok(rowsOf(await openCommands(a.ro.id)).length >= 1, 'commands were created');
    assert.ok(rowsOf(await openCommands(a.ro.id)).every((c) => ['queued', 'published'].includes(c.status)));
    const cancel = await http('PATCH', `/api/v1/firmware/rollouts/${a.ro.id}`, tA, { status: 'cancelled' });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.ok(rowsOf(await openCommands(a.ro.id)).every((c) => c.status === 'expired' && c.error === 'rollout cancelled'), 'cancel closes the commands');

    const b = await release('3.0.1');
    assert.ok(rowsOf(await openCommands(b.ro.id)).every((c) => ['queued', 'published'].includes(c.status)));
    assert.equal((await http('POST', `/api/v1/firmware/releases/${b.rel.id}/withdraw`, tA)).status, 200);
    assert.ok(rowsOf(await openCommands(b.ro.id)).every((c) => c.status === 'expired' && c.error === 'release withdrawn'), 'withdraw closes the commands');
  });

  console.log('\nHardening (phase 6)');
  await check('quotas enforced from the organization plan', async () => {
    await sql('UPDATE organizations SET max_devices = 1 WHERE id = $1', [orgA.id]);
    const r = await http('POST', '/api/v1/devices', tA, { projectId: proj.id, displayName: 'Over quota' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'quota_exceeded');
    await sql('UPDATE organizations SET max_devices = 50 WHERE id = $1', [orgA.id]);
  });
  await check('retention removes telemetry older than the organization setting', async () => {
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/settings`, tB, { retentionDays: 30 })).status, 403);
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/settings`, tA, { retentionDays: 5000 })).status, 400);
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/settings`, tA, { retentionDays: 365 })).status, 403, 'above the free plan');
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/settings`, tA, { retentionDays: 30 })).status, 200);
    await sql(
      `INSERT INTO telemetry_measurements (organization_id, project_id, device_id, metric_key, metric_value, ts, received_at, message_id)
       VALUES ($1, $2, $3, 'temperatureC', 1, now() - interval '40 days', now() - interval '40 days', 'old-msg')`,
      [orgA.id, proj.id, dev2.device.id],
    );
    await eventually(async () => (await sql(`SELECT 1 FROM telemetry_measurements WHERE message_id = 'old-msg'`)).length === 0, 'old row purged');
    assert.ok((await sql('SELECT count(*)::int AS n FROM telemetry_measurements WHERE organization_id = $1', [orgA.id]))[0].n > 0, 'recent data kept');
  });
  await check('plans: only platform admins change limits', async () => {
    assert.equal((await http('PATCH', `/api/v1/organizations/${orgA.id}/plan`, tA, { plan: 'pro' })).status, 403);
    await sql(`UPDATE users SET is_platform_admin = true WHERE email = 'alice@arclabs.test'`);
    const p = await http('PATCH', `/api/v1/organizations/${orgA.id}/plan`, tA, { plan: 'pro' });
    assert.equal(p.status, 200);
    assert.equal(p.body.maxDevices, 1000);
    const all = await http('GET', '/api/v1/platform/organizations', tA);
    assert.equal(all.status, 200);
    assert.ok(all.body.items.some((o: any) => o.id === orgA.id && o.plan === 'pro' && o.ownerEmail === 'alice@arclabs.test'));
    assert.ok(all.body.items.some((o: any) => o.id === orgB.id), 'sees every organization');
    await sql(`UPDATE users SET is_platform_admin = false WHERE email = 'alice@arclabs.test'`);
    assert.equal((await http('GET', '/api/v1/platform/organizations', tA)).status, 403);
  });
  await check('overview and usage analytics', async () => {
    const o = await http('GET', `/api/v1/organizations/${orgA.id}/overview`, tB);
    assert.equal(o.status, 200);
    assert.ok(o.body.devices.total >= 4);
    assert.ok(o.body.recentAlerts.length >= 1);
    assert.ok(o.body.projects.some((p: any) => p.name === 'Greenhouse'));
    const u = await http('GET', `/api/v1/organizations/${orgA.id}/usage`, tA);
    assert.equal(u.body.plan, 'pro');
    assert.ok(u.body.used.devices >= 3);
    assert.ok(u.body.messagesPerDay.length >= 1);
    assert.ok(u.body.topDevices.length >= 1);
  });
  await check('worker exposes job metrics', async () => {
    const m = await (await fetch('http://127.0.0.1:19100/metrics')).text();
    assert.match(m, /arc_alerts_triggered_total \d+/);
    assert.match(m, /arc_deliveries_sent_total\{reason="webhook"\} \d+/);
    assert.match(m, /arc_deliveries_retried_total\{reason="webhook"\} \d+/);
  });
  await check('custom HTML/CSS board widgets save with long options', async () => {
    const html = '<div class="hero">{{temperatureC}}</div>'.repeat(200);
    const widgets = [{ id: 'cb1', type: 'custom', title: 'My board', field: '', size: 'l', options: { template: 'hero', html, css: '.hero{color:red}', height: 240 } }];
    assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/dashboard`, tA, { widgets })).status, 200);
    assert.equal((await http('GET', `/api/v1/projects/${proj.id}/dashboard`, tA)).body.widgets[0].options.html.length, html.length);
    const huge = { ...widgets[0], options: { html: 'x'.repeat(20001) } };
    await sql('UPDATE organizations SET max_widgets = 1 WHERE id = $1', [orgA.id]);
    const over = await http('PUT', `/api/v1/projects/${proj.id}/dashboard`, tA, { widgets: [widgets[0], { ...widgets[0], id: 'second' }] });
    assert.equal(over.status, 403, 'plan widget limit');
    assert.equal(over.body.resource, 'widgets');
    await sql('UPDATE organizations SET max_widgets = 64 WHERE id = $1', [orgA.id]);
    assert.equal((await http('PUT', `/api/v1/projects/${proj.id}/dashboard`, tA, { widgets: [huge] })).status, 400);
  });
  await check('delete channel: admins only, name must match, removes devices and readings', async () => {
    const scrap = (await http('POST', '/api/v1/projects', tA, { organizationId: orgA.id, name: 'Scrap bench' })).body;
    await http('PUT', `/api/v1/projects/${scrap.id}/fields`, tA, { metrics: [{ metricKey: 'temp', label: 'Temp', position: 1 }, { metricKey: 'led', label: 'LED', kind: 'control', position: 2, minValue: 0, maxValue: 1 }] });
    const d = (await http('POST', '/api/v1/devices', tA, { projectId: scrap.id, displayName: 'Scrap ESP32' })).body;
    const k = d.credentials.http.apiKey as string;
    assert.equal((await fetch(`${API}/api/v1/update?api_key=${encodeURIComponent(k)}&field1=21.5`)).status, 200);
    const scoped = await http('POST', '/api/v1/api-keys', tA, { organizationId: orgA.id, name: 'scrap only', role: 'viewer', projectIds: [scrap.id] });
    assert.equal((await http('DELETE', `/api/v1/projects/${scrap.id}`, tB, { confirmName: 'Scrap bench' })).status, 403, 'viewer');
    assert.equal((await http('DELETE', `/api/v1/projects/${scrap.id}`, tA, { confirmName: 'Scrap' })).status, 400, 'wrong name');
    assert.equal((await http('DELETE', `/api/v1/projects/${scrap.id}`, scoped.body.secret, { confirmName: 'Scrap bench' })).status, 403, 'API key');
    const del = await http('DELETE', `/api/v1/projects/${scrap.id}`, tA, { confirmName: 'Scrap bench' });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.devices, 1);
    assert.equal((await http('GET', `/api/v1/projects/${scrap.id}`, tA)).status, 404);
    assert.equal((await http('GET', `/api/v1/devices/${d.device.id}`, tA)).status, 404);
    assert.equal((await fetch(`${API}/api/v1/update?api_key=${encodeURIComponent(k)}&field1=22`)).status, 401, 'device key stops working');
    assert.equal(Number((await sql(`SELECT count(*) FROM telemetry_measurements WHERE project_id = '${scrap.id}'`))[0].count), 0);
    assert.ok((await sql(`SELECT revoked_at FROM api_keys WHERE id = '${scoped.body.id}'`))[0].revoked_at, 'channel-only key revoked');
    assert.ok((await http('GET', `/api/v1/organizations/${orgA.id}/audit-logs?limit=5`, tA)).body.items.some((e: any) => e.action === "project.delete"));
  });
  if (c3) await new Promise<void>((r) => c3!.end(false, {}, () => r()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
