-- Invitations and seats (phase 2 of the auth/onboarding/authorization redesign).
--
-- invite_codes gets a kind:
--   platform  what existed before: codes ARC LABS staff create (sign-up batches, optionally joining an organization)
--   email     an organization invites one person: bound to their email address, single use, expiring, revocable.
--             The token travels only in the emailed link; only its SHA-256 hash is stored (code_hash).
--   class     a shared code for a class or batch: student or viewer role only, limited uses, capped by seats
-- Every kind is bound to an organization except platform codes that only create accounts.
--
-- Seats: organizations.max_members is the plan's cap (set by ARC LABS); organizations.seat_limit is the owner's or
-- an admin's own limit within it ("set the limit of students or joiners"). Members count against it, and so do
-- pending email invitations, so a full organization cannot hand out more invitations than it has seats.

ALTER TABLE invite_codes ADD COLUMN kind text NOT NULL DEFAULT 'platform' CHECK (kind IN ('platform', 'email', 'class'));
ALTER TABLE invite_codes ADD COLUMN email citext;
ALTER TABLE invite_codes ADD COLUMN accepted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invite_codes ADD COLUMN accepted_at timestamptz;

ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_email_kind CHECK ((kind = 'email') = (email IS NOT NULL));
ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_org_kind CHECK (kind = 'platform' OR organization_id IS NOT NULL);
ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_email_single_use CHECK (kind <> 'email' OR max_uses = 1);
ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_class_roles CHECK (kind <> 'class' OR role IN ('student', 'viewer'));

-- One open email invitation per person and organization (re-inviting replaces the old one).
CREATE UNIQUE INDEX invite_codes_one_open_email ON invite_codes (organization_id, email)
  WHERE kind = 'email' AND revoked_at IS NULL AND used_count = 0;
CREATE INDEX ON invite_codes (organization_id, created_at DESC) WHERE organization_id IS NOT NULL;

-- ---------- seats ----------
ALTER TABLE organizations ADD COLUMN max_members int NOT NULL DEFAULT 10 CHECK (max_members BETWEEN 1 AND 100000);
ALTER TABLE organizations ADD COLUMN seat_limit int CHECK (seat_limit BETWEEN 1 AND 100000);

-- Plan caps (must match PLANS in the API: free 10, pro 500, enterprise 10000), never below today's head count so
-- nobody is pushed out; new joins simply stop at the cap.
UPDATE organizations o SET max_members = GREATEST(
    CASE o.plan WHEN 'enterprise' THEN 10000 WHEN 'pro' THEN 500 ELSE 10 END,
    (SELECT count(*) FROM organization_members m WHERE m.organization_id = o.id)
  );
