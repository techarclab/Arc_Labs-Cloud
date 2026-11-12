-- Sign-up asks "individual or organization?".
--
--   * individual:   open self-service sign-up (when ALLOW_SIGNUP=true), on the free plan's limits.
--   * organization: needs an invite code from ARC LABS that adds the person to an organization ARC LABS has set
--                   up (with its plan and limits). A code that only creates accounts is not enough.
--
-- users.account_type records what the person chose. Null only for accounts created through Google that have not
-- finished their profile yet (they are asked together with their age group).

ALTER TABLE users ADD COLUMN account_type text CHECK (account_type IN ('individual', 'organization'));

-- Existing accounts: those that joined an organization through an invite are organization accounts; everyone
-- else signed up on their own. Accounts still waiting for their age group stay null and are asked both.
UPDATE users u SET account_type = CASE
    WHEN EXISTS (SELECT 1 FROM invite_codes i WHERE i.id = u.invite_id AND i.organization_id IS NOT NULL) THEN 'organization'
    ELSE 'individual'
  END
WHERE u.age_group IS NOT NULL;
