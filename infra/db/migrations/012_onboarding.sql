-- Onboarding (phase 3 of the auth/onboarding/authorization redesign): "Who are you?" and organization setup codes.
--
--   * Individuals say what they do (users.profession) and get a personal workspace.
--   * Organizations (industry, corporate) and institutions (school, college, university) are created only with an
--     organization setup code from ARC LABS: bound to the creator's email address, single use, expiring, carrying
--     the plan. Whoever uses it becomes the organization's owner. organizations.org_type records the type.
--   * Everyone else joins an existing organization by invitation or class code (phase 2).
--
-- Account type never grants platform privileges (those come only from users.is_platform_admin).

ALTER TABLE users ADD COLUMN profession text CHECK (profession IN ('engineer', 'teacher', 'trainer', 'hobbyist', 'other'));

ALTER TABLE organizations ADD COLUMN org_type text CHECK (org_type IN ('industry', 'corporate', 'school', 'college', 'university'));

-- ---------- invite_codes: kind org_setup ----------
ALTER TABLE invite_codes DROP CONSTRAINT IF EXISTS invite_codes_kind_check;
ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_kind_check CHECK (kind IN ('platform', 'email', 'class', 'org_setup'));

ALTER TABLE invite_codes ADD COLUMN plan text CHECK (plan IN ('free', 'pro', 'enterprise'));
ALTER TABLE invite_codes ADD COLUMN org_type text CHECK (org_type IN ('industry', 'corporate', 'school', 'college', 'university'));

-- Email invitations and setup codes are bound to an address; the others are not.
ALTER TABLE invite_codes DROP CONSTRAINT invite_codes_email_kind;
ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_email_kind CHECK ((kind IN ('email', 'org_setup')) = (email IS NOT NULL));
-- A setup code creates its organization, so it has none yet (and no role: its user becomes the owner).
ALTER TABLE invite_codes DROP CONSTRAINT invite_codes_org_kind;
ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_org_kind CHECK (
  CASE kind WHEN 'platform' THEN true WHEN 'org_setup' THEN organization_id IS NULL ELSE organization_id IS NOT NULL END
);
-- Only setup codes carry a plan and type; they always carry a plan and work once.
ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_setup_fields CHECK (
  CASE WHEN kind = 'org_setup' THEN plan IS NOT NULL AND max_uses = 1 ELSE plan IS NULL AND org_type IS NULL END
);
