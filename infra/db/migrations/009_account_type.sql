-- "Who is this account for?", asked once the email address is confirmed, and personal workspaces.
--
--   * individual:   open self-service sign-up (when ALLOW_SIGNUP=true), on the free plan's limits.
--   * organization: needs an invite code from ARC LABS that adds the person to an organization ARC LABS has set
--                   up (with its plan and limits). A code that only creates accounts is not enough.
--   * other:        a club, research group, startup…: free plan for now, with a short description so ARC LABS
--                   can follow up.
--
-- users.account_type is null until the person answers (the console asks right after the email is confirmed).
--
-- organizations.kind tells a person's own free workspace ('personal', created by anyone who is not ARC LABS
-- staff) from a real organization set up by ARC LABS ('organization'). The console shows a personal workspace as
-- "Personal workspace" instead of "Admin of <name>".

ALTER TABLE users ADD COLUMN account_type text CHECK (account_type IN ('individual', 'organization', 'other'));
ALTER TABLE users ADD COLUMN account_type_note text CHECK (char_length(account_type_note) <= 200);

-- Existing accounts: those that joined an organization through an invite are organization accounts; everyone
-- else who has finished sign-up signed up on their own. The rest are asked.
UPDATE users u SET account_type = CASE
    WHEN EXISTS (SELECT 1 FROM invite_codes i WHERE i.id = u.invite_id AND i.organization_id IS NOT NULL) THEN 'organization'
    ELSE 'individual'
  END
WHERE u.age_group IS NOT NULL AND u.email_verified_at IS NOT NULL;

ALTER TABLE organizations ADD COLUMN kind text NOT NULL DEFAULT 'organization' CHECK (kind IN ('personal', 'organization'));

-- Free organizations a person created for themselves (not ARC LABS staff) are personal workspaces. Organizations
-- from before open sign-up were moved to Pro by migration 006 and stay organizations.
UPDATE organizations o SET kind = 'personal'
WHERE o.plan = 'free'
  AND o.created_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o.created_by AND u.is_platform_admin);
