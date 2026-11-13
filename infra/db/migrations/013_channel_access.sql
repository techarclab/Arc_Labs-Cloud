-- Channel-level access (phase 4 of the auth/onboarding/authorization redesign).
--
-- Organization-wide roles (owner, admin, engineer, viewer) see every channel. Scoped roles (teacher, trainer,
-- student, employee) see only the channels they are granted here, with their role's level inside them
-- (teacher/trainer: engineer level; student/employee: viewer level). Everything organization-wide (overview, team,
-- integrations, firmware, usage, audit) stays closed to them, the way it is for channel-limited API keys.
--
-- A grant belongs to a membership: leaving or being removed from the organization removes every grant; deleting
-- the channel removes its grants.

CREATE TABLE project_members (
  project_id      uuid NOT NULL,
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  granted_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON project_members (organization_id, user_id);

-- Tenant isolation, as for every table with organization_id (migration 004).
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_members TO arc_tenant
  USING (organization_id = ANY (arc_scope_orgs())) WITH CHECK (organization_id = ANY (arc_scope_orgs()));

-- Invitations and class codes can come with channels: the people who join get those channels straight away.
ALTER TABLE invite_codes ADD COLUMN project_ids uuid[];
