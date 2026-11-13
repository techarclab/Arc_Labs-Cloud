-- Roles and ownership (phase 1 of the auth/onboarding/authorization redesign).
--
-- Member roles (organization_members.role):
--   owner       exactly one per organization; only the owner transfers ownership, promotes or removes admins
--   admin       everything else in the organization, including people below admin
--   teacher, trainer, engineer, student, employee, viewer
--               member roles (teacher/trainer/student/employee are accepted here, assigned from phase 4 on,
--               when channel-level access arrives)
--   individual  the one person in a personal workspace: runs it fully, but a personal workspace has no team
--
-- The API keeps three access levels for its existing checks (viewer=1, engineer=2, admin=3): see
-- AccessService.LEVEL. API keys and service accounts keep their own role column (viewer/engineer), unchanged.

-- ---------- organization_members.role ----------
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'organization_members'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%org_admin%'
  LOOP
    EXECUTE format('ALTER TABLE organization_members DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

UPDATE organization_members SET role = 'admin' WHERE role = 'org_admin';

ALTER TABLE organization_members ADD CONSTRAINT organization_members_role_check
  CHECK (role IN ('owner', 'admin', 'teacher', 'trainer', 'engineer', 'student', 'employee', 'viewer', 'individual'));

-- A "personal" workspace that already has other people in it is really a team: it becomes an organization (with
-- an owner, below), so nobody loses access and someone can still manage those people.
UPDATE organizations o SET kind = 'organization'
WHERE o.kind = 'personal' AND (SELECT count(*) FROM organization_members m WHERE m.organization_id = o.id) > 1;

-- The one person in a personal workspace.
UPDATE organization_members m SET role = 'individual'
FROM organizations o
WHERE o.id = m.organization_id AND o.kind = 'personal' AND m.role = 'admin';

-- One owner per organization: its creator if they are still an admin there, otherwise the admin who joined first.
WITH pick AS (
  SELECT DISTINCT ON (m.organization_id) m.organization_id, m.user_id
  FROM organization_members m JOIN organizations o ON o.id = m.organization_id
  WHERE o.kind = 'organization' AND m.role = 'admin'
  ORDER BY m.organization_id, (m.user_id = o.created_by) DESC, m.joined_at, m.user_id
)
UPDATE organization_members m SET role = 'owner'
FROM pick WHERE m.organization_id = pick.organization_id AND m.user_id = pick.user_id;

CREATE UNIQUE INDEX organization_members_one_owner ON organization_members (organization_id) WHERE role = 'owner';
CREATE UNIQUE INDEX organization_members_one_individual ON organization_members (organization_id) WHERE role = 'individual';

-- Every organization with an admin now has an owner. One with members but no admin at all (should not exist: the
-- API always kept an admin) is left without an owner rather than promoting a viewer, and reported here; the
-- Platform page shows it with no owner, for ARC LABS to sort out. Not an error, so a deploy never fails on it.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM organizations o
  WHERE o.kind = 'organization'
    AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'owner');
  IF n > 0 THEN
    RAISE WARNING '010_roles_ownership: % organization(s) have members but no admin, so no owner was set', n;
  END IF;
END $$;

-- ---------- invite_codes.role ----------
-- Invites never make an owner or an individual (ownership is transferred, personal workspaces have no team).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'invite_codes'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%org_admin%'
  LOOP
    EXECUTE format('ALTER TABLE invite_codes DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

UPDATE invite_codes SET role = 'admin' WHERE role = 'org_admin';

ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_role_check
  CHECK (role IN ('admin', 'teacher', 'trainer', 'engineer', 'student', 'employee', 'viewer'));
