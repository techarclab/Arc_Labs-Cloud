/**
 * Who may call each API route: the authorization policy the matrix (tests/authz/run.ts) enforces. Every operation
 * in the generated OpenAPI spec must be listed here, so a new route cannot ship without a decision about who may
 * call it.
 *
 * `need` is the INTENDED rule (docs: roles in the Complete Reference, section 3), not whatever the code does today.
 * Where the code differs, the difference is a defect listed in KNOWN_DEFECTS and the matrix expects the current
 * behaviour for that cell until the defect is fixed (then the matrix fails and asks you to remove the entry).
 *
 *   public   anyone, no sign-in
 *   device   device key only (HTTP device API); a person's sign-in token must not work
 *   user     any signed-in person (their own account)
 *   viewer | engineer | org_admin   members of the organization that owns the resource, at least this role
 *   platform ARC LABS platform admins only
 *
 * `probe` says how the matrix exercises the route for callers who ARE allowed:
 *   read         GET with real ids: must answer 2xx
 *   write        realistic body: must not be refused for permissions (2xx, or a validation/conflict answer)
 *   destructive  runs once, last, as the least-privileged allowed caller, on a resource created for it
 *   none         not exercised for allowed callers (it would end the caller's session); denial is still tested
 */
import type { Fixtures } from './run';

export type Need = 'public' | 'device' | 'user' | 'viewer' | 'engineer' | 'org_admin' | 'platform';
export type Probe = 'read' | 'write' | 'destructive' | 'none';

export interface Rule {
  need: Need;
  probe: Probe;
  /** Path parameters, when the default (the main fixture for the path's resource) is not the right one. */
  params?: (f: Fixtures) => Record<string, string>;
  body?: (f: Fixtures) => unknown;
}

const r = (need: Need, probe: Probe, extra: Omit<Rule, 'need' | 'probe'> = {}): Rule => ({ need, probe, ...extra });

export const POLICY: Record<string, Rule> = {
  // ---------- public ----------
  'GET /': r('public', 'read'),
  'GET /health/live': r('public', 'read'),
  'GET /health/ready': r('public', 'read'),
  'GET /health/deep': r('public', 'none'), // 503 here on purpose: no broker in this test
  'POST /api/v1/auth/register': r('public', 'none'),
  'POST /api/v1/auth/login': r('public', 'none'),
  'GET /api/v1/auth/google/config': r('public', 'read'),
  'POST /api/v1/auth/google': r('public', 'none'),
  'POST /api/v1/auth/verify-email': r('public', 'none'),
  'POST /api/v1/auth/forgot-password': r('public', 'none'),
  'POST /api/v1/auth/reset-password': r('public', 'none'),
  'POST /api/v1/oauth/token': r('public', 'none'),

  // ---------- the caller's own account ----------
  'GET /api/v1/auth/me': r('user', 'read'),
  'PATCH /api/v1/auth/me': r('user', 'write', { body: () => ({ displayName: 'Matrix User' }) }),
  'POST /api/v1/auth/accept-terms': r('user', 'write', { body: () => ({ version: '2000-01-01', accept: true }) }),
  'POST /api/v1/auth/resend-verification': r('user', 'write'),
  'POST /api/v1/auth/complete-profile': r('user', 'write', { body: () => ({ ageGroup: 'adult' }) }),
  'POST /api/v1/auth/account-type': r('user', 'write', { body: () => ({ accountType: 'organization', inviteCode: 'ARC-AAAA-BBBB-CCCC' }) }),
  'GET /api/v1/auth/delete-account': r('user', 'read'),
  'POST /api/v1/auth/delete-account': r('user', 'write', { body: () => ({ confirmEmail: 'not-this-account@example.test' }) }),
  'POST /api/v1/auth/redeem-invite': r('user', 'write', { body: () => ({ inviteCode: 'ARC-AAAA-BBBB-CCCC' }) }),
  'POST /api/v1/auth/change-password': r('user', 'write', { body: () => ({ currentPassword: 'not-the-password-1', newPassword: 'matrix-new-password-1' }) }),
  'POST /api/v1/auth/sign-out-everywhere': r('user', 'none'),
  'GET /api/v1/organizations': r('user', 'read'),
  'POST /api/v1/organizations': r('user', 'write', { body: () => ({ name: 'Matrix extra', slug: `matrix-${Date.now()}` }) }),

  // ---------- organization ----------
  'GET /api/v1/organizations/{id}': r('viewer', 'read'),
  'PATCH /api/v1/organizations/{id}': r('org_admin', 'write', { body: () => ({ name: 'Matrix Org A' }) }),
  'GET /api/v1/organizations/{id}/members': r('viewer', 'read'),
  'POST /api/v1/organizations/{id}/members': r('org_admin', 'write', { body: (f) => ({ email: f.emails.spare2, role: 'viewer' }) }),
  'PATCH /api/v1/organizations/{id}/members/{userId}': r('org_admin', 'write', { body: () => ({ role: 'viewer' }) }),
  'DELETE /api/v1/organizations/{id}/members/{userId}': r('org_admin', 'destructive'),
  'GET /api/v1/organizations/{id}/audit-logs': r('org_admin', 'read'),
  'GET /api/v1/organizations/{id}/rejected-messages': r('engineer', 'read'),
  'GET /api/v1/organizations/{id}/overview': r('viewer', 'read'),
  'GET /api/v1/organizations/{id}/usage': r('viewer', 'read'),
  'PATCH /api/v1/organizations/{id}/settings': r('org_admin', 'write', { body: () => ({ retentionDays: 30 }) }),

  // ---------- ARC LABS platform ----------
  'PATCH /api/v1/organizations/{id}/plan': r('platform', 'write', { body: () => ({ plan: 'pro' }) }),
  'GET /api/v1/platform/organizations': r('platform', 'read'),
  'GET /api/v1/platform/invites': r('platform', 'read'),
  'POST /api/v1/platform/invites': r('platform', 'write', { body: () => ({ label: 'matrix', maxUses: 1, expiresInDays: 1 }) }),
  'POST /api/v1/platform/invites/{id}/revoke': r('platform', 'destructive', { body: () => ({}) }),

  // ---------- channels ----------
  'POST /api/v1/projects': r('org_admin', 'write', { body: (f) => ({ organizationId: f.orgA, name: 'Matrix extra channel', timezone: 'Asia/Kolkata' }) }),
  'GET /api/v1/projects': r('viewer', 'read'),
  'GET /api/v1/projects/{id}': r('viewer', 'read'),
  'PATCH /api/v1/projects/{id}': r('engineer', 'write', { body: () => ({ name: 'Matrix channel' }) }),
  'DELETE /api/v1/projects/{id}': r('org_admin', 'destructive', { params: (f) => ({ id: f.projX }), body: () => ({ confirmName: 'Sacrificial channel' }) }),
  'GET /api/v1/projects/{id}/fields': r('viewer', 'read'),
  'PUT /api/v1/projects/{id}/fields': r('engineer', 'write', { body: (f) => ({ metrics: f.fields }) }),
  'GET /api/v1/projects/{id}/metric-definitions': r('viewer', 'read'),
  'PUT /api/v1/projects/{id}/metric-definitions': r('engineer', 'write', { body: (f) => ({ metrics: f.fields }) }),
  'POST /api/v1/projects/{id}/read-key': r('org_admin', 'write'),
  'GET /api/v1/projects/{id}/dashboard': r('viewer', 'read'),
  'PUT /api/v1/projects/{id}/dashboard': r('engineer', 'write', { body: () => ({ widgets: [] }) }),
  'GET /api/v1/channels/{id}/feeds.json': r('viewer', 'read'),
  'GET /api/v1/channels/{id}/feeds.csv': r('viewer', 'read'),
  'GET /api/v1/projects/{id}/command-types': r('viewer', 'read'),
  'PUT /api/v1/projects/{id}/command-types/{name}': r('org_admin', 'write', { body: () => ({ params: [{ key: 'seconds', type: 'number', min: 1, max: 10, required: true }], ttlSeconds: 120 }) }),
  'DELETE /api/v1/projects/{id}/command-types/{name}': r('org_admin', 'destructive', { params: (f) => ({ id: f.projA, name: 'zap' }) }),

  // ---------- devices ----------
  'POST /api/v1/devices': r('engineer', 'write', { body: (f) => ({ projectId: f.projA, displayName: 'Matrix board' }) }),
  'GET /api/v1/devices': r('viewer', 'read'),
  'GET /api/v1/devices/{id}': r('viewer', 'read'),
  'PATCH /api/v1/devices/{id}': r('engineer', 'write', { body: () => ({ displayName: 'Matrix probe' }) }),
  'POST /api/v1/devices/{id}/rotate-credentials': r('engineer', 'write'),
  'POST /api/v1/devices/{id}/revoke': r('org_admin', 'destructive', { params: (f) => ({ id: f.devRevoke }), body: () => ({ reason: 'matrix' }) }),
  // Maintenance/suspend/resume: engineer. Retiring (permanent) needs org_admin: checked separately in run.ts.
  'POST /api/v1/devices/{id}/lifecycle': r('engineer', 'destructive', { params: (f) => ({ id: f.devLifecycle }), body: () => ({ status: 'maintenance', reason: 'matrix' }) }),
  'GET /api/v1/devices/{id}/state': r('viewer', 'read'),
  'GET /api/v1/devices/{id}/telemetry/latest': r('viewer', 'read'),
  'GET /api/v1/devices/{id}/telemetry': r('viewer', 'read'),
  'GET /api/v1/devices/{id}/controls': r('viewer', 'read'),
  'POST /api/v1/devices/{id}/controls': r('engineer', 'write', { body: () => ({ field: 'led1', value: 1 }) }),
  'GET /api/v1/devices/{id}/events': r('viewer', 'read'),
  'POST /api/v1/devices/{id}/commands': r('engineer', 'write', { body: () => ({ name: 'blink', payload: { seconds: 1 } }) }),
  'GET /api/v1/devices/{id}/commands': r('viewer', 'read'),
  'GET /api/v1/commands/{commandId}': r('viewer', 'read'),
  'POST /api/v1/commands/{commandId}/retry': r('engineer', 'write'),

  // ---------- device HTTP API (device key, never a person's token) ----------
  'GET /api/v1/commands/next': r('device', 'none'),
  'POST /api/v1/commands/{commandId}/ack': r('device', 'none', { body: () => ({ status: 'ok' }) }),
  'GET /api/v1/update': r('device', 'none'),
  'POST /api/v1/update': r('device', 'none', { body: () => ({ temperature: 20 }) }),
  'PUT /api/v1/update': r('device', 'none', { body: () => ({ temperature: 20 }) }),
  'PATCH /api/v1/update': r('device', 'none', { body: () => ({ temperature: 20 }) }),
  'DELETE /api/v1/update': r('device', 'none'),
  'GET /api/v1/controls': r('device', 'none'),

  // ---------- rules and alerts ----------
  'GET /api/v1/rules': r('viewer', 'read'),
  'POST /api/v1/rules': r('engineer', 'write', { body: (f) => ({ projectId: f.projA, name: 'Matrix rule', ruleType: 'threshold', metricKey: 'temperature', operator: '>', threshold: 80, severity: 'warning' }) }),
  'GET /api/v1/rules/{id}': r('viewer', 'read'),
  'PATCH /api/v1/rules/{id}': r('engineer', 'write', { body: () => ({ cooldownSeconds: 600 }) }),
  'DELETE /api/v1/rules/{id}': r('engineer', 'destructive', { params: (f) => ({ id: f.ruleX }) }),
  'GET /api/v1/alerts': r('viewer', 'read'),
  'GET /api/v1/alerts/{id}': r('viewer', 'read'),
  'POST /api/v1/alerts/{id}/acknowledge': r('engineer', 'write', { body: () => ({ note: 'matrix' }) }),
  'POST /api/v1/alerts/{id}/resolve': r('engineer', 'destructive', { body: () => ({ note: 'matrix' }) }),

  // ---------- integrations ----------
  'GET /api/v1/api-keys': r('org_admin', 'read'),
  'POST /api/v1/api-keys': r('org_admin', 'write', { body: (f) => ({ organizationId: f.orgA, name: 'Matrix key', role: 'viewer' }) }),
  'DELETE /api/v1/api-keys/{id}': r('org_admin', 'destructive'),
  'GET /api/v1/webhooks': r('org_admin', 'read'),
  'POST /api/v1/webhooks': r('org_admin', 'write', { body: (f) => ({ organizationId: f.orgA, name: 'Matrix hook', url: 'http://127.0.0.1:9/hook', events: ['alert.triggered'] }) }),
  'PATCH /api/v1/webhooks/{id}': r('org_admin', 'write', { body: () => ({ name: 'Matrix hook 2' }) }),
  'DELETE /api/v1/webhooks/{id}': r('org_admin', 'destructive', { params: (f) => ({ id: f.hookX }) }),
  'POST /api/v1/webhooks/{id}/test': r('org_admin', 'write'),
  'GET /api/v1/webhooks/{id}/deliveries': r('org_admin', 'read'),
  'GET /api/v1/lms/links': r('org_admin', 'read'), // Integrations page is admin-only; scoped service accounts list with viewer
  'POST /api/v1/lms/links': r('org_admin', 'write', { body: (f) => ({ projectId: f.projA, lmsRef: `matrix-${Date.now()}`, title: 'Matrix lab', deviceIds: [f.devA], maxTokenMinutes: 60 }) }),
  'DELETE /api/v1/lms/links/{id}': r('org_admin', 'destructive', { params: (f) => ({ id: f.linkX }) }),
  'POST /api/v1/lms/links/{id}/learner-tokens': r('org_admin', 'write', { body: () => ({ learnerRef: 'matrix-student', minutes: 5 }) }),

  // ---------- firmware ----------
  'GET /api/v1/firmware/signing-keys': r('viewer', 'read'),
  'POST /api/v1/firmware/signing-keys': r('org_admin', 'write', { body: (f) => ({ organizationId: f.orgA, name: `Matrix key ${Date.now()}`, publicKeyPem: f.newPublicKey() }) }),
  'DELETE /api/v1/firmware/signing-keys/{id}': r('org_admin', 'destructive', { params: (f) => ({ id: f.sigX }) }),
  'GET /api/v1/firmware/releases': r('viewer', 'read'),
  'POST /api/v1/firmware/releases': r('org_admin', 'write', { body: (f) => f.signedRelease() }),
  'POST /api/v1/firmware/releases/{id}/withdraw': r('org_admin', 'destructive', { params: (f) => ({ id: f.relX }) }),
  'GET /api/v1/firmware/rollouts': r('viewer', 'read'),
  'POST /api/v1/firmware/rollouts': r('org_admin', 'write', { body: (f) => ({ releaseId: f.relA, projectId: f.projA, percent: 10 }) }),
  'GET /api/v1/firmware/rollouts/{id}': r('viewer', 'read'),
  'PATCH /api/v1/firmware/rollouts/{id}': r('org_admin', 'write', { body: () => ({ percent: 20 }) }),
};

/**
 * Differences between the intended policy and today's code. While an entry is here, the matrix expects the CURRENT
 * behaviour in the cells it names and reports them as known defects (not failures). Fix the code, delete the entry.
 */
export const KNOWN_DEFECTS: { id: string; title: string; applies: (principal: string, rule: Rule, op: string) => boolean }[] = [
  // DEF-001 (platform admins held org_admin in every organization) was fixed on 2026-11-12: the platform caller is
  // now expected to be refused on every organization route, like the outsider.
];
