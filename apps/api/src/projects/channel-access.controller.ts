/**
 * Channel access (phase 4): which people with a scoped role (teacher, trainer, student, employee) may use a
 * channel. Organization-wide roles (owner, admin, engineer, viewer) already see every channel.
 *
 * Who manages it: the owner and admins, for anyone with a scoped role; a teacher or trainer who has the channel,
 * for students only (AccessService.canAssign). Engineers and viewers manage channels' devices, not people.
 */
import { ApiTags } from '@nestjs/swagger';
import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Put } from '@nestjs/common';
import { AccessService, canAssign, CallerRole, isScoped, MemberRole } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { Doc } from '../common/docs';
import { actor, AuthUser, CurrentUser, requirePerson, Uuid } from '../common/http';
import { Db } from '../db/db.service';

@ApiTags('Channels')
@Controller('api/v1/projects')
export class ChannelAccessController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * People with access to the channel through a grant, and (for whoever may grant) the people they could add.
   * A teacher only sees students here, not the organization's whole member list.
   */
  @Doc('Channel access: grants and who could be added')
  @Get(':id/access')
  async list(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const { project, caller } = await this.manager(user, id);
    const visible = (role: MemberRole) => canAssign(caller, role);
    const rows = await this.db.query<{ user_id: string; email: string; display_name: string; role: MemberRole; granted: boolean; granted_at: Date | null }>(
      `SELECT m.user_id, u.email, u.display_name, m.role, (g.user_id IS NOT NULL) AS granted, g.created_at AS granted_at
       FROM organization_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN project_members g ON g.project_id = $2 AND g.user_id = m.user_id
       WHERE m.organization_id = $1 AND m.role IN ('teacher', 'trainer', 'student', 'employee')
       ORDER BY u.display_name, u.email`,
      [project.organization_id, id],
    );
    const person = (r: (typeof rows)[number]) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role });
    return {
      grants: rows.filter((r) => r.granted && (visible(r.role) || caller === 'owner' || caller === 'admin')).map((r) => ({ ...person(r), grantedAt: r.granted_at, canRevoke: visible(r.role) })),
      candidates: rows.filter((r) => !r.granted && visible(r.role)).map(person),
    };
  }

  @Doc('Give someone with a scoped role access to the channel')
  @Put(':id/access/:userId')
  @HttpCode(200)
  async grant(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Param('userId', Uuid()) userId: string, @Body() _body: unknown) {
    const { project, caller } = await this.manager(user, id);
    const target = await this.target(project.organization_id, userId, caller);
    await this.db.tx(async (c) => {
      const added = await c.query(
        `INSERT INTO project_members (project_id, organization_id, user_id, granted_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING user_id`,
        [id, project.organization_id, userId, user.id],
      );
      if (added.rowCount) {
        await this.audit.record({ ...actor(user), organizationId: project.organization_id, action: 'channel.access_grant', resourceType: 'project', resourceId: id, metadata: { userId, role: target } }, c);
      }
    });
    return { projectId: id, userId, granted: true };
  }

  @Doc('Take away someone’s access to the channel')
  @Delete(':id/access/:userId')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Param('userId', Uuid()) userId: string) {
    const { project, caller } = await this.manager(user, id);
    const target = await this.target(project.organization_id, userId, caller);
    await this.db.tx(async (c) => {
      const gone = await c.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 RETURNING user_id', [id, userId]);
      if (gone.rowCount) {
        await this.audit.record({ ...actor(user), organizationId: project.organization_id, action: 'channel.access_revoke', resourceType: 'project', resourceId: id, metadata: { userId, role: target } }, c);
      }
    });
  }

  /** The channel (as an engineer-level caller who has it) and the caller's role; only owner, admin, teacher, trainer. */
  private async manager(user: AuthUser, projectId: string): Promise<{ project: any; caller: CallerRole }> {
    requirePerson(user);
    const project = await this.access.requireProject(user, projectId, 'engineer');
    const caller = (await this.access.roleIn(user, project.organization_id))!;
    if (!['owner', 'admin', 'teacher', 'trainer'].includes(caller)) {
      throw new ForbiddenException({ code: 'insufficient_role', message: 'Only the owner, admins, and teachers or trainers of this channel manage who can use it.' });
    }
    return { project, caller };
  }

  /** The person must be in the organization with a scoped role the caller may manage. */
  private async target(orgId: string, userId: string, caller: CallerRole): Promise<MemberRole> {
    const m = await this.db.one<{ role: MemberRole }>('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
    if (!m) throw new NotFoundException({ code: 'not_found' });
    if (!isScoped(m.role)) {
      throw new ConflictException({ code: 'not_scoped', message: 'Their role already sees every channel. Channel access is for teachers, trainers, students and employees.' });
    }
    if (!canAssign(caller, m.role)) throw new ForbiddenException({ code: 'role_not_assignable', message: 'Teachers and trainers manage students only.' });
    return m.role;
  }
}
