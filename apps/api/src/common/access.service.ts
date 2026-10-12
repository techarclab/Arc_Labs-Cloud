import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
    if (user.isPlatformAdmin) return 'org_admin';
    const row = await this.db.one<{ role: OrgRole }>(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, user.id],
    );
    return row?.role ?? null;
  }

  async requireOrg(user: AuthUser, orgId: string, min: OrgRole): Promise<OrgRole> {
    const role = await this.roleIn(user, orgId);
    if (!role) throw new NotFoundException({ code: 'not_found' });
    if (RANK[role] < RANK[min]) throw new ForbiddenException({ code: 'insufficient_role', required: min });
    return role;
  }

  async requireProject(user: AuthUser, projectId: string, min: OrgRole) {
    const project = await this.db.one('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (!project) throw new NotFoundException({ code: 'not_found' });
    await this.requireOrg(user, project.organization_id, min);
    return project;
  }

  async requireDevice(user: AuthUser, deviceId: string, min: OrgRole, q: Queryable = this.db.pool) {
    const res = await q.query('SELECT * FROM devices WHERE id = $1', [deviceId]);
    const device = res.rows[0];
    if (!device) throw new NotFoundException({ code: 'not_found' });
    await this.requireOrg(user, device.organization_id, min);
    return device;
  }
}
