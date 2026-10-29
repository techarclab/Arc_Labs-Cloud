-- Invite-only registration and recorded consent (pilot onboarding of a college batch or a customer).
--
--   * Sign-up stays closed (ALLOW_SIGNUP=false); a person can register only with an invite code that ARC LABS
--     staff (platform admins) create per batch. Codes are random, shown once, stored only as a SHA-256 hash,
--     limited in uses and time, and revocable. Optionally a code adds the new user to an organization.
--   * Every new account records when it accepted the privacy notice, and which version.

CREATE TABLE invite_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash       text NOT NULL UNIQUE,
  label           text NOT NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  role            text CHECK (role IN ('org_admin', 'engineer', 'viewer')),
  max_uses        integer NOT NULL CHECK (max_uses BETWEEN 1 AND 10000),
  used_count      integer NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  expires_at      timestamptz NOT NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  CHECK ((organization_id IS NULL) = (role IS NULL))
);
CREATE INDEX ON invite_codes (created_at DESC);

-- Platform-level table, used only by sign-up and platform admins (both run without row-level security).
-- Tenant requests must never read it, so take away the default grant migration 004 gives arc_tenant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arc_tenant') THEN
    EXECUTE 'REVOKE ALL ON invite_codes FROM arc_tenant';
  END IF;
END $$;

-- Defence in depth (and the e2e guard that every table with organization_id has RLS): row-level security with
-- no policy for arc_tenant denies every row to tenant requests.
ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;

ALTER TABLE users ADD COLUMN terms_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN terms_version text;
ALTER TABLE users ADD COLUMN invite_id uuid REFERENCES invite_codes(id) ON DELETE SET NULL;
