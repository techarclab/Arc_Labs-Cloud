import { ConflictException } from '@nestjs/common';

/**
 * Seats: who may still join an organization. The limit is the owner's/admin's seat_limit within the plan's
 * max_members. Members count against it, and so do open email invitations (each one reserves a seat).
 *
 * Call inside the transaction that adds the member: the organization row is locked, so two people joining at the
 * same moment cannot both take the last seat.
 */
export async function seatUsage(c: any, orgId: string, opts: { excludeInviteId?: string; lock?: boolean } = {}) {
  const org = (
    await c.query(`SELECT max_members, seat_limit FROM organizations WHERE id = $1 ${opts.lock ? 'FOR UPDATE' : ''}`, [orgId])
  ).rows[0] as { max_members: number; seat_limit: number | null } | undefined;
  const counts = (
    await c.query(
      `SELECT (SELECT count(*)::int FROM organization_members WHERE organization_id = $1) AS members,
              (SELECT count(*)::int FROM invite_codes
                WHERE organization_id = $1 AND kind = 'email' AND revoked_at IS NULL AND used_count = 0 AND expires_at > now()
                  AND ($2::uuid IS NULL OR id <> $2)) AS pending`,
      [orgId, opts.excludeInviteId ?? null],
    )
  ).rows[0] as { members: number; pending: number };
  const max = org?.max_members ?? 0;
  const limit = Math.min(org?.seat_limit ?? max, max);
  return { members: counts.members, pending: counts.pending, limit, max, free: Math.max(0, limit - counts.members - counts.pending) };
}

/** Throws 409 seats_full when nobody else can join (or be invited). Locks the organization row. */
export async function requireSeat(c: any, orgId: string, opts: { excludeInviteId?: string } = {}) {
  const s = await seatUsage(c, orgId, { ...opts, lock: true });
  if (s.free < 1) {
    throw new ConflictException({
      code: 'seats_full',
      limit: s.limit,
      message: `This organization has no free seats (${s.members} members${s.pending ? `, ${s.pending} invited` : ''}, limit ${s.limit}). An owner or admin can raise the limit or remove someone.`,
    });
  }
  return s;
}

/**
 * The channels an invitation or class code comes with become the new member's channel grants (project_members).
 * Only channels still in the invitation's organization; already granted ones are kept as they are.
 * Call right after the membership row exists, in the same transaction.
 */
export async function grantInviteChannels(c: any, inviteId: string, userId: string) {
  await c.query(
    `INSERT INTO project_members (project_id, organization_id, user_id, granted_by)
     SELECT p.id, p.organization_id, $2, i.created_by FROM invite_codes i
     JOIN projects p ON p.id = ANY (i.project_ids) AND p.organization_id = i.organization_id
     WHERE i.id = $1
     ON CONFLICT DO NOTHING`,
    [inviteId, userId],
  );
}
