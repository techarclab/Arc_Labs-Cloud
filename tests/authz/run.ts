/**
 * Route × role authorization matrix. Generates the OpenAPI spec from the API's own controllers, checks that every
 * operation has a rule in tests/authz/policy.ts, then calls every route as every kind of caller:
 *
 *   anon      no token
 *   outsider  admin of ANOTHER organization (tenant isolation)
 *   viewer, engineer, admin   members of organization A with that role
 *   platform  ARC LABS platform admin, not a member of organization A
 *
 * Denied callers must get 401/403/404 (anon: 401) with real resource ids and realistic bodies, so a missing check
 * would actually perform the action and show up as a failure. Allowed callers must not be refused.
 *
 *   DATABASE_URL=postgres://…/empty_db npx tsx tests/authz/run.ts
 *
 * Writes tests/authz/out/results.json and results.md (evidence for docs/operations/).
 */
import assert from 'node:assert/strict';
import { ChildProcess, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, KeyObject, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { API, DB, ROOT, SECRETS, spawnSvc, waitFor } from '../e2e/harness';
import { KNOWN_DEFECTS, Need, POLICY, Rule } from './policy';

const OUT = resolve(ROOT, 'tests/authz/out');
const PRINCIPALS = ['anon', 'outsider', 'viewer', 'engineer', 'admin', 'platform'] as const;
type Principal = (typeof PRINCIPALS)[number];
const RANK: Partial<Record<Principal, number>> = { viewer: 1, engineer: 2, admin: 3 };
const NEED_RANK: Partial<Record<Need, number>> = { viewer: 1, engineer: 2, org_admin: 3 };
/** 403 codes that mean "not allowed"; other 403s are business rules (plan limit, wrong password, …). */
const DENY_CODES = new Set(['insufficient_role', 'platform_admin_only', 'not_found', 'person_required', 'person_only', 'email_unverified', 'profile_incomplete']);

export interface Fixtures {
  orgA: string;
  projA: string;
  projX: string;
  devA: string;
  devRevoke: string;
  devLifecycle: string;
  cmdA: string;
  ruleA: string;
  ruleX: string;
  alertA: string;
  keyX: string;
  hookA: string;
  hookX: string;
  linkA: string;
  linkX: string;
  sigX: string;
  relA: string;
  relX: string;
  roA: string;
  inviteX: string;
  spareId: string;
  emails: Record<string, string>;
  fields: unknown[];
  newPublicKey: () => string;
  signedRelease: () => unknown;
}

type Outcome = 'pass' | 'fail' | 'known' | 'inconclusive';
interface Cell {
  op: string;
  principal: Principal;
  expect: 'allow' | 'deny';
  status: number;
  code?: string;
  outcome: Outcome;
  why?: string;
}

async function call(method: string, path: string, token: string | undefined, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function sql(text: string, params: unknown[] = []) {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

function expectation(p: Principal, rule: Rule, op: string): { expect: 'allow' | 'deny'; known?: string } {
  const known = KNOWN_DEFECTS.find((d) => d.applies(p, rule, op))?.id;
  let allow: boolean;
  switch (rule.need) {
    case 'public':
      allow = true;
      break;
    case 'device':
      allow = false; // no person's token is a device key
      break;
    case 'user':
      allow = p !== 'anon';
      break;
    case 'platform':
      allow = p === 'platform';
      break;
    default:
      allow = RANK[p] !== undefined && RANK[p]! >= NEED_RANK[rule.need]!;
  }
  if (known) return { expect: allow ? 'deny' : 'allow', known }; // the defect inverts the intended outcome today
  return { expect: allow ? 'allow' : 'deny' };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const procs: ChildProcess[] = [];
  const emails = {
    admin: 'admin@a.test',
    engineer: 'engineer@a.test',
    viewer: 'viewer@a.test',
    spare: 'spare@a.test',
    spare2: 'spare2@a.test',
    outsider: 'admin@b.test',
    platform: 'platform@arclabs.test',
  };
  try {
    // ---------- the spec, from the controllers themselves ----------
    const specPath = resolve(OUT, 'openapi.json');
    execFileSync(process.execPath, ['apps/api/dist/openapi.js', specPath], { cwd: ROOT, stdio: 'ignore' });
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const ops: { key: string; method: string; path: string; query: string[] }[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        if (!item[method]) continue;
        const query = (item[method].parameters ?? []).filter((p: any) => p.in === 'query' && p.required).map((p: any) => p.name);
        ops.push({ key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path, query });
      }
    }
    const unlisted = ops.filter((o) => !POLICY[o.key]).map((o) => o.key);
    const stale = Object.keys(POLICY).filter((k) => !ops.some((o) => o.key === k));

    // ---------- the API ----------
    procs.push(
      spawnSvc('api', 'apps/api/dist/main.js', {
        ...SECRETS,
        DATABASE_URL: DB!,
        PORT: '3100',
        INTERNAL_PORT: '3101',
        RUN_MIGRATIONS: 'true',
        NODE_ENV: 'test',
        EMAIL_VERIFICATION: 'required',
        ALLOW_PRIVATE_WEBHOOKS: 'true',
        CONSOLE_URL: 'http://console.test',
      }),
    );
    await waitFor(async () => (await fetch(`${API}/health/ready`)).ok, 'API');

    // ---------- callers ----------
    const tokens: Partial<Record<Principal, string>> = {};
    const ids: Record<string, string> = {};
    for (const [who, email] of Object.entries(emails)) {
      const r = await call('POST', '/api/v1/auth/register', undefined, { email, displayName: who, password: `matrix-${who}-password-1`, ageGroup: 'adult', acceptTerms: true });
      assert.equal(r.status, 201, `${who}: ${JSON.stringify(r.body)}`);
      ids[who] = r.body.user.id;
      if ((PRINCIPALS as readonly string[]).includes(who)) tokens[who as Principal] = r.body.accessToken;
    }
    await sql(`UPDATE users SET email_verified_at = now()`); // no SMTP here
    // Platform admin comes only from the database flag (the operator tool sets it in production).
    await sql(`UPDATE users SET is_platform_admin = true WHERE email = $1`, [emails.platform]);
    const as = (p: Principal) => tokens[p];
    const ok = (r: { status: number; body: any }, what: string) => {
      assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    };

    // ---------- organization A (the target) and B (the outsider's own) ----------
    const orgA = ok(await call('POST', '/api/v1/organizations', as('admin'), { name: 'Org A', slug: 'org-a' }), 'org A').id;
    ok(await call('POST', '/api/v1/organizations', as('outsider'), { name: 'Org B', slug: 'org-b' }), 'org B');
    ok(await call('PATCH', `/api/v1/organizations/${orgA}/plan`, as('platform'), { plan: 'pro' }), 'org A on pro');
    for (const [who, role] of [['engineer', 'engineer'], ['viewer', 'viewer'], ['spare', 'viewer']]) {
      ok(await call('POST', `/api/v1/organizations/${orgA}/members`, as('admin'), { email: emails[who as keyof typeof emails], role }), `member ${who}`);
    }
    const project = async (name: string) => ok(await call('POST', '/api/v1/projects', as('admin'), { organizationId: orgA, name, timezone: 'Asia/Kolkata' }), name).id;
    const projA = await project('Channel A');
    const projX = await project('Sacrificial channel');
    const fields = [
      { metricKey: 'temperature', label: 'Temperature', unit: '°C', minValue: -40, maxValue: 85 },
      { metricKey: 'led1', label: 'LED 1', kind: 'control', minValue: 0, maxValue: 1, step: 1, decimals: 0 },
    ];
    ok(await call('PUT', `/api/v1/projects/${projA}/fields`, as('admin'), { metrics: fields }), 'fields');
    for (const name of ['blink', 'zap']) {
      ok(await call('PUT', `/api/v1/projects/${projA}/command-types/${name}`, as('admin'), { params: [{ key: 'seconds', type: 'number', min: 1, max: 10, required: true }], ttlSeconds: 600 }), `command type ${name}`);
    }
    const device = async (name: string) => ok(await call('POST', '/api/v1/devices', as('admin'), { projectId: projA, displayName: name }), name).device.id;
    const devA = await device('Device A');
    const devRevoke = await device('To revoke');
    const devLifecycle = await device('To suspend');
    const cmdA = ok(await call('POST', `/api/v1/devices/${devA}/commands`, as('admin'), { name: 'blink', payload: { seconds: 1 } }), 'command').id;
    const rule = async (name: string) =>
      ok(await call('POST', '/api/v1/rules', as('admin'), { projectId: projA, name, ruleType: 'threshold', metricKey: 'temperature', operator: '>', threshold: 80, severity: 'warning' }), name).id;
    const ruleA = await rule('Rule A');
    const ruleX = await rule('Rule X');
    const alertA = (
      await sql(
        `INSERT INTO alerts (organization_id, project_id, device_id, rule_id, rule_name, rule_type, severity, message, value)
         VALUES ($1, $2, $3, $4, 'Rule A', 'threshold', 'warning', 'matrix fixture', 90) RETURNING id`,
        [orgA, projA, devA, ruleA],
      )
    )[0].id;
    const keyX = ok(await call('POST', '/api/v1/api-keys', as('admin'), { organizationId: orgA, name: 'Key X', role: 'viewer' }), 'api key').id;
    const hook = async (name: string) => ok(await call('POST', '/api/v1/webhooks', as('admin'), { organizationId: orgA, name, url: 'http://127.0.0.1:9/hook', events: ['alert.triggered'] }), name).id;
    const hookA = await hook('Hook A');
    const hookX = await hook('Hook X');
    const link = async (ref: string) => ok(await call('POST', '/api/v1/lms/links', as('admin'), { projectId: projA, lmsRef: ref, title: ref, deviceIds: [devA], maxTokenMinutes: 60 }), ref).id;
    const linkA = await link('lab-a');
    const linkX = await link('lab-x');

    const signing: { privateKey: KeyObject; id: string } = { privateKey: null as unknown as KeyObject, id: '' };
    const newPublicKey = () => {
      const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      return kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    };
    {
      const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      signing.privateKey = kp.privateKey;
      signing.id = ok(await call('POST', '/api/v1/firmware/signing-keys', as('admin'), { organizationId: orgA, name: 'Release key', publicKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString() }), 'signing key').id;
    }
    const sigX = ok(await call('POST', '/api/v1/firmware/signing-keys', as('admin'), { organizationId: orgA, name: 'Key to delete', publicKeyPem: newPublicKey() }), 'signing key X').id;
    let fwVersion = 0;
    const signedRelease = () => {
      const m = { deviceType: 'esp32', version: `3.0.${++fwVersion}`, url: `https://fw.example.test/${fwVersion}.bin`, sha256: createHash('sha256').update(String(fwVersion)).digest('hex'), sizeBytes: 1024 };
      const canonical = JSON.stringify({ deviceType: m.deviceType, sha256: m.sha256, sizeBytes: m.sizeBytes, url: m.url, version: m.version });
      return { organizationId: orgA, ...m, signingKeyId: signing.id, signature: sign('sha256', Buffer.from(canonical), { key: signing.privateKey, dsaEncoding: 'der' }).toString('base64') };
    };
    const relA = ok(await call('POST', '/api/v1/firmware/releases', as('admin'), signedRelease()), 'release A').id;
    const relX = ok(await call('POST', '/api/v1/firmware/releases', as('admin'), signedRelease()), 'release X').id;
    const roA = ok(await call('POST', '/api/v1/firmware/rollouts', as('admin'), { releaseId: relA, projectId: projA, percent: 10 }), 'rollout').id;
    const inviteX = ok(await call('POST', '/api/v1/platform/invites', as('platform'), { label: 'X', maxUses: 1, expiresInDays: 1 }), 'invite').id;

    const f: Fixtures = {
      orgA, projA, projX, devA, devRevoke, devLifecycle, cmdA, ruleA, ruleX, alertA, keyX, hookA, hookX, linkA, linkX, sigX, relA, relX, roA, inviteX,
      spareId: ids.spare, emails, fields, newPublicKey, signedRelease,
    };

    // Default path parameter for each resource; a rule's `params` overrides it.
    const defaults = (path: string): Record<string, string> => {
      const pick: [RegExp, Record<string, string>][] = [
        [/^\/api\/v1\/organizations\/\{id\}/, { id: orgA, userId: f.spareId }],
        [/^\/api\/v1\/(projects|channels)\/\{id\}/, { id: projA, name: 'blink' }],
        [/^\/api\/v1\/devices\/\{id\}/, { id: devA }],
        [/^\/api\/v1\/commands\/\{commandId\}/, { commandId: cmdA }],
        [/^\/api\/v1\/rules\/\{id\}/, { id: ruleA }],
        [/^\/api\/v1\/alerts\/\{id\}/, { id: alertA }],
        [/^\/api\/v1\/api-keys\/\{id\}/, { id: keyX }],
        [/^\/api\/v1\/webhooks\/\{id\}/, { id: hookA }],
        [/^\/api\/v1\/lms\/links\/\{id\}/, { id: linkA }],
        [/^\/api\/v1\/firmware\/signing-keys\/\{id\}/, { id: sigX }],
        [/^\/api\/v1\/firmware\/releases\/\{id\}/, { id: relX }],
        [/^\/api\/v1\/firmware\/rollouts\/\{id\}/, { id: roA }],
        [/^\/api\/v1\/platform\/invites\/\{id\}/, { id: inviteX }],
      ];
      return pick.find(([re]) => re.test(path))?.[1] ?? {};
    };
    const QUERY: Record<string, string> = { organizationId: orgA, projectId: projA, deviceId: devA, metric: 'temperature', field: 'led1' };
    const url = (op: (typeof ops)[number], rule: Rule) => {
      const params = { ...defaults(op.path), ...(rule.params?.(f) ?? {}) };
      const p = op.path.replace(/\{(\w+)\}/g, (_, k) => {
        if (!params[k]) throw new Error(`${op.key}: no fixture for {${k}}`);
        return params[k];
      });
      const q = op.query.map((k) => `${k}=${encodeURIComponent(QUERY[k] ?? '')}`).join('&');
      return q ? `${p}?${q}` : p;
    };

    // ---------- the matrix ----------
    const cells: Cell[] = [];
    const destructive: { op: (typeof ops)[number]; rule: Rule; principal: Principal }[] = [];
    const judge = (op: string, principal: Principal, rule: Rule, exp: { expect: 'allow' | 'deny'; known?: string }, res: { status: number; body: any }): Cell => {
      const code = typeof res.body === 'object' && res.body ? res.body.code : undefined;
      const base = { op, principal, expect: exp.expect, status: res.status, code };
      if (res.status >= 500 && !(res.status === 503 && (code || rule.probe === 'none'))) return { ...base, outcome: 'fail', why: 'server error' };
      const refused = res.status === 401 || res.status === 404 || (res.status === 403 && (code === undefined || DENY_CODES.has(code)));
      let pass: boolean;
      let why: string | undefined;
      if (exp.expect === 'deny') {
        if (res.status === 400 || res.status === 429) return { ...base, outcome: 'inconclusive', why: `${res.status} before the permission check` };
        pass = refused && (principal !== 'anon' || res.status === 401 || (rule.need === 'device' && res.status === 404));
        why = pass ? undefined : principal === 'anon' && refused ? 'anonymous caller should get 401' : 'NOT REFUSED';
      } else if (rule.probe === 'read') {
        pass = res.status >= 200 && res.status < 300;
        why = pass ? undefined : 'allowed caller refused or failed';
      } else {
        pass = !refused;
        why = pass ? undefined : 'allowed caller refused';
      }
      if (exp.known) return { ...base, outcome: pass ? 'known' : 'fail', why: pass ? exp.known : `${exp.known} looks fixed: remove it from KNOWN_DEFECTS (${why})` };
      return { ...base, outcome: pass ? 'pass' : 'fail', why };
    };

    for (const op of ops) {
      const rule = POLICY[op.key];
      if (!rule) continue;
      if (rule.need === 'public') {
        const res = await call(op.method, url(op, rule), undefined, rule.body?.(f) ?? {});
        cells.push(judge(op.key, 'anon', rule, { expect: 'allow' }, { ...res, status: res.status === 401 && rule.probe === 'none' ? 200 : res.status }));
        continue;
      }
      for (const principal of PRINCIPALS) {
        const exp = expectation(principal, rule, op.key);
        if (exp.expect === 'allow' && (rule.probe === 'none' || rule.probe === 'destructive')) {
          if (rule.probe === 'destructive' && !destructive.some((d) => d.op === op)) destructive.push({ op, rule, principal });
          continue;
        }
        const res = await call(op.method, url(op, rule), as(principal), rule.body?.(f) ?? {});
        cells.push(judge(op.key, principal, rule, exp, res));
      }
    }
    // Lifecycle: the matrix probes "maintenance" (engineer); retiring a device is permanent and needs org_admin.
    {
      const lifecycle = POLICY['POST /api/v1/devices/{id}/lifecycle'];
      const retire = { ...lifecycle, need: 'org_admin' as Need };
      for (const principal of ['viewer', 'engineer'] as Principal[]) {
        const res = await call('POST', `/api/v1/devices/${devLifecycle}/lifecycle`, as(principal), { status: 'retired' });
        cells.push(judge('POST /api/v1/devices/{id}/lifecycle (status: retired)', principal, retire, { expect: 'deny' }, res));
      }
    }
    // Destructive routes, once each, as the least-privileged allowed caller (PRINCIPALS is ordered by privilege).
    for (const d of destructive) {
      const res = await call(d.op.method, url(d.op, d.rule), as(d.principal), d.rule.body?.(f) ?? {});
      cells.push(judge(d.op.key, d.principal, { ...d.rule, probe: 'read' }, expectation(d.principal, d.rule, d.op.key), res));
    }

    // ---------- report ----------
    const count = (o: Outcome) => cells.filter((c) => c.outcome === o).length;
    const failed = cells.filter((c) => c.outcome === 'fail');
    const inconclusive = cells.filter((c) => c.outcome === 'inconclusive');
    const known = cells.filter((c) => c.outcome === 'known');
    const when = new Date().toISOString();
    writeFileSync(resolve(OUT, 'results.json'), JSON.stringify({ when, operations: ops.length, unlisted, stale, cells }, null, 2));
    const grid = ops.map((o) => {
      const row = PRINCIPALS.map((p) => {
        const c = cells.find((x) => x.op === o.key && x.principal === p);
        if (!c) return '·';
        const mark = { pass: '✓', fail: '✗', known: '!', inconclusive: '?' }[c.outcome];
        return `${mark} ${c.status}`;
      });
      return `| \`${o.key}\` | ${POLICY[o.key]?.need ?? '**unlisted**'} | ${row.join(' | ')} |`;
    });
    const md = [
      `# Authorization matrix, ${when}`,
      '',
      `${ops.length} operations in the generated OpenAPI spec × ${PRINCIPALS.length} callers: ${count('pass')} pass, ${failed.length} fail, ${known.length} known defect, ${inconclusive.length} inconclusive.`,
      '',
      unlisted.length ? `**Operations without a policy entry:** ${unlisted.map((u) => `\`${u}\``).join(', ')}` : 'Every operation has a policy entry.',
      stale.length ? `\n**Policy entries for operations that no longer exist:** ${stale.map((u) => `\`${u}\``).join(', ')}` : '',
      '',
      ...(failed.length ? ['## Failures', '', '| Operation | Caller | Expected | Got | Why |', '|---|---|---|---|---|', ...failed.map((c) => `| \`${c.op}\` | ${c.principal} | ${c.expect} | ${c.status} ${c.code ?? ''} | ${c.why} |`), ''] : []),
      ...(known.length ? ['## Known defects (current behaviour expected until fixed)', '', ...KNOWN_DEFECTS.map((d) => `- **${d.id}** (${known.filter((c) => c.why === d.id).length} cells): ${d.title}`), ''] : []),
      ...(inconclusive.length ? ['## Inconclusive (validation or rate limit answered before the permission check)', '', ...inconclusive.map((c) => `- \`${c.op}\` as ${c.principal}: ${c.status} ${c.code ?? ''}`), ''] : []),
      '## Grid',
      '',
      '✓ as intended · ✗ wrong · ! known defect · ? inconclusive · · not called (public route, or destructive/session-ending probe run once as the least-privileged allowed caller)',
      '',
      `| Operation | Needs | ${PRINCIPALS.join(' | ')} |`,
      `|---|---|${PRINCIPALS.map(() => '---').join('|')}|`,
      ...grid,
      '',
    ].join('\n');
    writeFileSync(resolve(OUT, 'results.md'), md);
    console.log(md.split('## Grid')[0]);
    const bad = failed.length + inconclusive.length + unlisted.length + stale.length;
    process.exitCode = bad ? 1 : 0;
  } finally {
    for (const p of procs) p.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
