import { ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, Queryable } from '../db/db.service';
import { AuthUser } from './http';

/** What a person is in an organization (organization_members.role). */
export type MemberRole = 'owner' | 'admin' | 'teacher' | 'trainer' | 'engineer' | 'student' | 'employee' | 'viewer' | 'individual';
/**
 * A caller's role: a member role, the role of an API key / service account / LMS link (viewer or engineer), or
 * 'support': ARC LABS staff with active, time-limited support access to this organization (read-only).
 */
export type CallerRole = MemberRole | 'support';
/**
 * Access levels the API's checks are written against: requireOrg(user, org, 'engineer'). Named after the original
 * three roles so the existing call sites read the same; 'org_admin' means "admin level".
 */
export type OrgRole = 'org_admin' | 'engineer' | 'viewer';
const RANK: Record<OrgRole, number> = { viewer: 1, engineer: 2, org_admin: 3 };

/**
 * Each role's level. teacher/trainer/student/employee are scoped (SCOPED_ROLES): they have this level only inside
 * the channels granted to them (project_members), and nothing organization-wide.
 */
export const LEVEL: Record<CallerRole, OrgRole> = {
  support: 'viewer', // and read-only: requireOrg refuses anything above viewer level
  owner: 'org_admin',
  admin: 'org_admin',
  individual: 'org_admin', // runs their personal workspace; team management is refused separately (no team there)
  engineer: 'engineer',
  teacher: 'engineer',
  trainer: 'engineer',
  viewer: 'viewer',
  student: 'viewer',
  employee: 'viewer',
};

/** Roles limited to the channels granted to them. */
export const SCOPED_ROLES: ReadonlySet<CallerRole> = new Set(['teacher', 'trainer', 'student', 'employee']);
export const isScoped = (role: CallerRole | null | undefined) => !!role && SCOPED_ROLES.has(role);

/** Roles that can be given to someone (invites, changing a role). Never owner (transfer) or individual. */
export const ASSIGNABLE_ROLES = ['admin', 'teacher', 'trainer', 'engineer', 'student', 'employee', 'viewer'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * Who may hand out / take away a role: only the owner deals with admins; admins manage the people below them;
 * teachers and trainers may bring in students (invitations, class codes, channel access), nothing else.
 */
export function canAssign(callerRole: CallerRole | null, role: MemberRole): boolean {
  if (role === 'owner' || role === 'individual') return false;
  if (callerRole === 'owner') return true;
  if (callerRole === 'admin') return role !== 'admin';
  if (callerRole === 'teacher' || callerRole === 'trainer') return role === 'student';
  return false;
}

/**
 * Tenant isolation lives here. Every controller resolves the owning organization of the
 * resource from the database (never from the client) and checks the caller's role.
 * Non-members get 404 so resource existence is not revealed across tenants.
 */
@Injectable()
export class AccessService {
  constructor(private readonly db: Db) {}

  async roleIn(user: AuthUser, orgId: string): Promise<CallerRole | null> {
    if (user.scope) return user.scope.orgId === orgId ? user.scope.role : null;
    const row = await this.db.one<{ role: MemberRole }>(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, user.id],
    );
    if (row) return row.role;
    // ARC LABS staff are not members of customer organizations: only open support access lets them look in.
    if (user.isPlatformAdmin && (await this.supportAccess(user.id, orgId))) return 'support';
    return null;
  }

  /** The caller's open support access to an organization (support_access is platform-only: read in system scope). */
  async supportAccess(userId: string, orgId: string): Promise<{ id: string; expires_at: Date } | null> {
    return this.db.asSystem(() =>
      this.db.one<{ id: string; expires_at: Date }>(
        'SELECT id, expires_at FROM support_access WHERE user_id = $1 AND organization_id = $2 AND ended_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1',
        [userId, orgId],
      ),
    );
  }

  /**
   * Organization-wide access. Callers restricted to some channels/devices (API keys with a
   * channel list, LMS learners) only pass with `allowRestricted` (e.g. reading the org name).
   */
  async requireOrg(user: AuthUser, orgId: string, min: OrgRole, opts: { allowRestricted?: boolean } = {}): Promise<CallerRole> {
    if (user.scope && (user.scope.projectIds || user.scope.deviceIds) && !opts.allowRestricted) {
      throw new NotFoundException({ code: 'not_found' });
    }
    const role = await this.roleIn(user, orgId);
    if (!role) throw new NotFoundException({ code: 'not_found' });
    // People with a scoped role are channel-limited too: organization-wide things stay hidden (404, as for keys).
    if (!user.scope && isScoped(role) && !opts.allowRestricted) throw new NotFoundException({ code: 'not_found' });
    // A suspended organization is closed for everyone but ARC LABS staff (who can sort it out): people, API keys
    // and LMS links alike. Devices are already refused by the broker hooks and the device HTTP API.
    if (!user.isPlatformAdmin) {
      const org = await this.db.one<{ status: string }>('SELECT status FROM organizations WHERE id = $1', [orgId]);
      if (org?.status !== 'active') throw new ForbiddenException({ code: 'org_suspended', message: 'This organization is suspended. Contact ARC LABS.' });
    }
    if (role === 'support' && min !== 'viewer') {
      throw new ForbiddenException({ code: 'support_read_only', message: 'Support access is read-only: ARC LABS staff can look, not change anything.' });
    }
    if (RANK[LEVEL[role]] < RANK[min]) throw new ForbiddenException({ code: 'insufficient_role', required: min });
    return role;
  }

  async requireProject(user: AuthUser, projectId: string, min: OrgRole) {
    const project = await this.db.one('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (!project) throw new NotFoundException({ code: 'not_found' });
    if (user.scope?.projectIds && !user.scope.projectIds.includes(project.id)) throw new NotFoundException({ code: 'not_found' });
    const role = await this.requireOrg(user, project.organization_id, min, { allowRestricted: true });
    await this.requireGrant(user, role, project.id);
    return project;
  }

  async requireDevice(user: AuthUser, deviceId: string, min: OrgRole, q: Queryable = this.db.scoped) {
    const res = await q.query('SELECT * FROM devices WHERE id = $1', [deviceId]);
    const device = res.rows[0];
    if (!device) throw new NotFoundException({ code: 'not_found' });
    if (user.scope?.projectIds && !user.scope.projectIds.includes(device.project_id)) throw new NotFoundException({ code: 'not_found' });
    if (user.scope?.deviceIds && !user.scope.deviceIds.includes(device.id)) throw new NotFoundException({ code: 'not_found' });
    const role = await this.requireOrg(user, device.organization_id, min, { allowRestricted: true });
    await this.requireGrant(user, role, device.project_id);
    return device;
  }

  /** A scoped person reaches a channel only with a grant; anyone else is not affected. Not granted: 404. */
  private async requireGrant(user: AuthUser, role: CallerRole, projectId: string) {
    if (user.scope || !isScoped(role)) return;
    const g = await this.db.one('SELECT 1 AS ok FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, user.id]);
    if (!g) throw new NotFoundException({ code: 'not_found' });
  }

  /**
   * The channels a caller may list in an organization: null = all of them. Channel-limited API keys and LMS links,
   * and people with a scoped role (their grants).
   */
  async projectScope(user: AuthUser, orgId: string): Promise<string[] | null> {
    if (user.scope) return user.scope.projectIds ?? null;
    const role = await this.roleIn(user, orgId);
    if (!isScoped(role)) return null;
    const rows = await this.db.query<{ project_id: string }>('SELECT project_id FROM project_members WHERE organization_id = $1 AND user_id = $2', [orgId, user.id]);
    return rows.map((r) => r.project_id);
  }

  /** SQL filter for device lists: restricted callers only see their devices. */
  deviceFilter(user: AuthUser): { projectIds: string[] | null; deviceIds: string[] | null } {
    return { projectIds: user.scope?.projectIds ?? null, deviceIds: user.scope?.deviceIds ?? null };
  }

  /** Plan limits (organizations.max_*). Throws 402-style 403 with code quota_exceeded. */
  async requireQuota(orgId: string, kind: 'devices' | 'projects' | 'rules' | 'api_keys' | 'webhooks') {
    const sql: Record<typeof kind, string> = {
      devices: `SELECT count(*)::int AS n FROM devices WHERE organization_id = $1 AND lifecycle_status NOT IN ('revoked', 'retired')`,
      projects: 'SELECT count(*)::int AS n FROM projects WHERE organization_id = $1',
      rules: 'SELECT count(*)::int AS n FROM alert_rules WHERE organization_id = $1',
      api_keys: 'SELECT count(*)::int AS n FROM api_keys WHERE organization_id = $1 AND revoked_at IS NULL',
      webhooks: 'SELECT count(*)::int AS n FROM webhooks WHERE organization_id = $1',
    };
    const org = await this.db.one(`SELECT plan, max_${kind} AS max FROM organizations WHERE id = $1`, [orgId]);
    const used = (await this.db.one<{ n: number }>(sql[kind], [orgId]))!.n;
    if (org && used >= org.max) {
      throw new HttpException(
        { code: 'quota_exceeded', resource: kind, limit: org.max, plan: org.plan, message: `Your ${org.plan} plan allows ${org.max} ${kind.replace('_', ' ')}.` },
        403,
      );
    }
  }
}
