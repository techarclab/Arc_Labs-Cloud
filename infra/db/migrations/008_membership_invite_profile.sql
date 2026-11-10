-- Which invite code put a person into an organization, so revoking a code can also remove the people who joined
-- with it (e.g. at the end of a course). Admins are never removed this way.
ALTER TABLE organization_members ADD COLUMN invite_id uuid REFERENCES invite_codes(id) ON DELETE SET NULL;
CREATE INDEX ON organization_members (invite_id) WHERE invite_id IS NOT NULL;

-- Backfill: people who signed up with an organization's code ...
UPDATE organization_members m SET invite_id = u.invite_id
FROM users u JOIN invite_codes i ON i.id = u.invite_id
WHERE m.user_id = u.id AND m.organization_id = i.organization_id AND m.invite_id IS NULL;
-- ... and people who joined later with "Join with invite code" (recorded in the audit log).
UPDATE organization_members m SET invite_id = (a.metadata->>'inviteId')::uuid
FROM audit_logs a
WHERE a.action = 'user.join_organization' AND a.actor_id = m.user_id::text AND a.organization_id = m.organization_id
  AND m.invite_id IS NULL AND EXISTS (SELECT 1 FROM invite_codes i WHERE i.id = (a.metadata->>'inviteId')::uuid);
