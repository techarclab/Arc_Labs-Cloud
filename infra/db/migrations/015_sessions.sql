-- Server-side sessions (phase 6 of the auth/onboarding/authorization redesign).
--
-- Signing in creates a session. The browser gets:
--   * a short-lived access token (JWT with the session id `sid`), kept in memory by the console, never in storage;
--   * a refresh token in an httpOnly, Secure cookie (not readable by page scripts), sent only to /api/v1/auth.
-- Each refresh rotates the refresh token. Presenting an old one again (outside a short grace window for two tabs
-- refreshing at once) means it was copied: the session is revoked. Only SHA-256 hashes are stored.
-- Logging out, "sign out everywhere", a password change or reset, and signing out one device revoke sessions here,
-- and every request with a session token checks it, so revocation applies at once.

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash       text NOT NULL,
  prev_refresh_hash  text,
  rotated_at         timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text,
  user_agent         text CHECK (char_length(user_agent) <= 300),
  ip                 text CHECK (char_length(ip) <= 64)
);
CREATE INDEX ON sessions (user_id, created_at DESC);
CREATE UNIQUE INDEX ON sessions (refresh_hash);

-- Account-level table: used only by sign-in, refresh and the account's own endpoints (system scope), never by
-- tenant requests. Row-level security with no policy denies every row to arc_tenant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arc_tenant') THEN
    EXECUTE 'REVOKE ALL ON sessions FROM arc_tenant';
  END IF;
END $$;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
