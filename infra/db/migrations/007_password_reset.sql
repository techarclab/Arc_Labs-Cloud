-- "Forgot password": a single-use emailed link (valid 60 minutes; only its SHA-256 is stored) lets a person set a
-- new password. Setting it signs out every other session: access tokens issued before users.sessions_revoked_at are
-- refused (the JWTs themselves are stateless, so this timestamp is what revokes them).
ALTER TABLE users ADD COLUMN sessions_revoked_at timestamptz;

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      citext NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON password_resets (user_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arc_tenant') THEN
    EXECUTE 'REVOKE ALL ON password_resets FROM arc_tenant';
  END IF;
END $$;
