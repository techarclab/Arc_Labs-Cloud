-- Open self-service sign-up (like Blynk / ThingSpeak), with email verification, an age rule, and a free plan.
--
--   * Anyone 18 or older can create an account without an invite code. People under 18 can join only with an
--     invite code from their institution (which arranges a parent's or guardian's consent under its agreement
--     with ARC LABS). users.age_group records what the person declared.
--   * A new account must confirm its email address before it can do anything but sign in, read the privacy
--     notice and ask for another link. Links are single-use, expire after 24 hours, and only their SHA-256 hash is
--     stored. The email itself goes through the deliveries outbox, sent by the worker.
--   * Free plan: 5 devices, 3 channels, 30 days of history, 12 widgets per dashboard, and one free organization
--     per person (organizations.created_by). Organizations that existed before this change move to Pro, so
--     nothing they already have is cut.

-- ---------- Accounts ----------
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN age_group text CHECK (age_group IN ('adult', 'minor'));

-- Existing accounts were created by invitation or by ARC LABS staff and confirmed "I am 18 or older" with the
-- privacy notice; treat their addresses as confirmed. Accounts that never accepted a notice (created through
-- Google before consent was recorded) are asked for their age group at their next sign-in.
UPDATE users SET email_verified_at = created_at;
UPDATE users SET age_group = 'adult' WHERE terms_accepted_at IS NOT NULL;

CREATE TABLE email_verifications (
  token_hash text PRIMARY KEY,                       -- SHA-256 of the token in the link; the token itself is never stored
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      citext NOT NULL,                        -- the address the link was sent to
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON email_verifications (user_id, created_at DESC);

-- Platform-level table (like invite_codes): used only by the auth endpoints, never by tenant requests.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arc_tenant') THEN
    EXECUTE 'REVOKE ALL ON email_verifications FROM arc_tenant';
  END IF;
END $$;

-- Account emails (verification) are not sent on behalf of any organization.
ALTER TABLE deliveries ALTER COLUMN organization_id DROP NOT NULL;

-- ---------- Plans ----------
ALTER TABLE organizations ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN max_widgets int NOT NULL DEFAULT 12;

UPDATE organizations SET
  plan = 'pro',
  max_devices = GREATEST(max_devices, 1000),
  max_projects = GREATEST(max_projects, 200),
  max_rules = GREATEST(max_rules, 2000),
  max_api_keys = GREATEST(max_api_keys, 200),
  max_webhooks = GREATEST(max_webhooks, 50),
  max_widgets = 64
WHERE plan = 'free';
UPDATE organizations SET max_widgets = 64 WHERE plan <> 'free';

-- New organizations start on the free plan (must match PLANS.free in the API).
ALTER TABLE organizations
  ALTER COLUMN max_devices SET DEFAULT 5,
  ALTER COLUMN max_projects SET DEFAULT 3,
  ALTER COLUMN max_rules SET DEFAULT 10,
  ALTER COLUMN max_api_keys SET DEFAULT 3,
  ALTER COLUMN max_webhooks SET DEFAULT 2,
  ALTER COLUMN retention_days SET DEFAULT 30;
