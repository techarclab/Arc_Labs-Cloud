import { ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, Queryable } from '../db/db.service';
import { AuthUser } from './http';

export type OrgRole = 'org_admin' | 'engineer' | 'viewer';
const RANK: Record<OrgRole, number> = { viewer: 1, engineer: 2, org_admin: 3 };

/**
 * Tenant isolation lives here. Every controller resolves the owning organization of the
 * resource from the database (never from the client) and checks the caller's role.
 * Non-members get 404 so resource existence is not revealed across tenants.
 */
@Injectable()
export class AccessService {
  constructor(private readonly db: Db) {}

  async roleIn(user: AuthUser, orgId: string): Promise<OrgRole | null> {
    if (user.scope) return user.scope.orgId === orgId ? user.scope.role : null;
    if (user.isPlatformAdmin) return 'org_admin';
    const row = await this.db.one<{ role: OrgRole }>(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, user.id],
    );
    return row?.role ?? null;
  }

  /**
   * Organization-wide access. Callers restricted to some channels/devices (API keys with a
   * channel list, LMS learners) only pass with `allowRestricted` (e.g. reading the org name).
   */
  async requireOrg(user: AuthUser, orgId: string, min: OrgRole, opts: { allowRestricted?: boolean } = {}): Promise<OrgRole> {
    if (user.scope && (user.scope.projectIds || user.scope.deviceIds) && !opts.allowRestricted) {
      throw new NotFoundException({ code: 'not_found' });
    }
    const role = await this.roleIn(user, orgId);
    if (!role) throw new NotFoundException({ code: 'not_found' });
    if (RANK[role] < RANK[min]) throw new ForbiddenException({ code: 'insufficient_role', required: min });
    return role;
  }

  async requireProject(user: AuthUser, projectId: string, min: OrgRole) {
    const project = await this.db.one('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (!project) throw new NotFoundException({ code: 'not_found' });
    if (user.scope?.projectIds && !user.scope.projectIds.includes(project.id)) throw new NotFoundException({ code: 'not_found' });
    await this.requireOrg(user, project.organization_id, min, { allowRestricted: true });
    return project;
  }

  async requireDevice(user: AuthUser, deviceId: string, min: OrgRole, q: Queryable = this.db.pool) {
    const res = await q.query('SELECT * FROM devices WHERE id = $1', [deviceId]);
    const device = res.rows[0];
    if (!device) throw new NotFoundException({ code: 'not_found' });
    if (user.scope?.projectIds && !user.scope.projectIds.includes(device.project_id)) throw new NotFoundException({ code: 'not_found' });
    if (user.scope?.deviceIds && !user.scope.deviceIds.includes(device.id)) throw new NotFoundException({ code: 'not_found' });
    await this.requireOrg(user, device.organization_id, min, { allowRestricted: true });
    return device;
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
