-- The platform boundary (phase 5 of the auth/onboarding/authorization redesign).
--
-- ARC LABS staff (users.is_platform_admin) no longer act as an admin inside every organization (known defect
-- DEF-001). By default they see metadata only: organizations, plans, usage counts, codes. To look at an
-- organization's own data (channels, devices, readings) they open support access: for one organization, with a
-- written reason, for a limited time, read-only. Opening and ending it is recorded in the organization's own audit
-- log, and its owner is emailed, so the customer can see every time ARC LABS looked.

CREATE TABLE support_access (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the ARC LABS staff member
  reason           text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours')
);
CREATE INDEX ON support_access (user_id, expires_at DESC);
CREATE INDEX ON support_access (organization_id, created_at DESC);

-- Platform-level table: read only in system scope (sign-in checks, platform endpoints), never by tenant requests.
-- Row-level security with no policy denies every row to arc_tenant (and satisfies the e2e RLS guard).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arc_tenant') THEN
    EXECUTE 'REVOKE ALL ON support_access FROM arc_tenant';
  END IF;
END $$;
ALTER TABLE support_access ENABLE ROW LEVEL SECURITY;
