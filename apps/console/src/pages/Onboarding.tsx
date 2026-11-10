/**
 * Self-service sign-up steps that sit between "has an account" and "uses the console":
 *  - /verify-email#token=…  (public) confirms the address from the emailed link;
 *  - ProfileGate: an account created through Google says whether the person is 18+ (under-18s need an invite code);
 *  - VerifyGate: "check your inbox" until the address is confirmed;
 *  - JoinInviteDialog: a signed-in person joins an institution's organization with an invite code.
 * The API enforces all of this (403 email_unverified / profile_incomplete); these screens only explain it.
 */
import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ArcMark, ErrorBox, Modal, useToast } from '../components/ui';
import { useSession } from '../session';

export type AgeGroup = 'adult' | 'minor';

/** "18 or older" / "under 18 with an invite code". Shared by sign-up and ProfileGate. */
export function AgeChoice({ value, onChange }: { value: AgeGroup | ''; onChange: (v: AgeGroup) => void }) {
  return (
    <fieldset className="choice">
      <legend>Your age</legend>
      <label>
        <input type="radio" name="age" required checked={value === 'adult'} onChange={() => onChange('adult')} />
        <span>I am 18 or older</span>
      </label>
      <label>
        <input type="radio" name="age" required checked={value === 'minor'} onChange={() => onChange('minor')} />
        <span>I am under 18 and have an invite code from my college or school</span>
      </label>
    </fieldset>
  );
}

function OnboardingCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-form onboarding">
      <div className="auth-card form">
        <div className="brand" style={{ color: 'var(--ink)' }}>
          <ArcMark size={28} />
          ARC Cloud
        </div>
        <h2 className="auth-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Opened from the email. The token is in the URL fragment, so it never reaches a server log. */
export function VerifyEmailPage() {
  const { user, reload } = useSession();
  const nav = useNavigate();
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    // Drop the token from the address bar and history straight away.
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setState('failed');
      setError(new Error('This link is incomplete. Open the newest email from ARC Cloud and use its button or full link.'));
      return;
    }
    api('POST', '/auth/verify-email', { token })
      .then(() => setState('done'))
      .catch((err) => {
        setError(err);
        setState('failed');
      });
  }, []);

  return (
    <OnboardingCard title={state === 'done' ? 'Email confirmed' : state === 'failed' ? 'Could not confirm your email' : 'Confirming your email…'}>
      {state === 'done' && <p className="muted">Thanks. Your ARC Cloud account is ready to use.</p>}
      <ErrorBox error={error} />
      {state !== 'working' && (
        <button
          className="btn primary"
          type="button"
          onClick={async () => {
            if (user) await reload();
            nav('/', { replace: true });
          }}
        >
          {user ? 'Open ARC Cloud' : 'Sign in'}
        </button>
      )}
    </OnboardingCard>
  );
}

/** Shown after sign-up until the emailed link is opened. */
export function VerifyGate({ email, onReload, onSignOut }: { email: string; onReload: () => Promise<void>; onSignOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now());

  // Coming back from the mail app: check again without asking.
  useEffect(() => {
    const onFocus = () => document.visibilityState === 'visible' && void onReload();
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [onReload]);
  useEffect(() => {
    if (!sentAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sentAt]);
  const wait = sentAt ? Math.max(0, 60 - Math.floor((now - sentAt) / 1000)) : 0;

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ alreadyVerified?: boolean }>('POST', '/auth/resend-verification');
      if (r.alreadyVerified) await onReload();
      else setSentAt(Date.now());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <OnboardingCard title="Check your inbox">
      <p className="muted">
        We sent a confirmation link to <b>{email}</b>. Open it to start using ARC Cloud. It can take a minute to arrive; check spam or promotions too.
      </p>
      <ErrorBox error={error} />
      {sentAt && <p className="small">A new link is on its way. Only the newest link is needed.</p>}
      <div className="row">
        <button className="btn primary" type="button" onClick={() => void onReload()}>
          I’ve confirmed it
        </button>
        <button className="btn" type="button" disabled={busy || wait > 0} onClick={resend}>
          {wait > 0 ? `Send again in ${wait}s` : 'Send the link again'}
        </button>
      </div>
      <p className="small muted">
        Wrong address?{' '}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onSignOut();
          }}
        >
          Sign out
        </a>{' '}
        and create the account again with the right one.
      </p>
    </OnboardingCard>
  );
}

/** Accounts created with Google: say whether you are 18 or older before anything else. */
export function ProfileGate({ onDone, onSignOut }: { onDone: () => Promise<void>; onSignOut: () => void }) {
  const [age, setAge] = useState<AgeGroup | ''>('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/complete-profile', { ageGroup: age, ...(invite.trim() ? { inviteCode: invite.trim() } : {}) });
      await onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="auth-form onboarding">
      <form className="auth-card form" onSubmit={submit}>
        <div className="brand" style={{ color: 'var(--ink)' }}>
          <ArcMark size={28} />
          ARC Cloud
        </div>
        <h2 className="auth-title">One more step</h2>
        <p className="muted">ARC Cloud is for people 18 or older. Students under 18 join through their college or school, with an invite code.</p>
        <AgeChoice value={age} onChange={setAge} />
        {age === 'minor' && (
          <label className="field">
            Invite code
            <input required value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="ARC-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} />
          </label>
        )}
        <ErrorBox error={error} />
        <button className="btn primary" disabled={busy || !age} type="submit">
          {busy ? 'Please wait…' : 'Continue'}
        </button>
        <button className="btn quiet small" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </form>
    </div>
  );
}

/** Join an institution's organization (e.g. a college batch) with the code ARC LABS or the instructor gave. */
export function JoinInviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refreshOrgs } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ organization: { id: string; name: string } }>('POST', '/auth/redeem-invite', { inviteCode: code.trim() });
      await refreshOrgs();
      toast(`You joined ${r.organization.name}`);
      setCode('');
      onClose();
      nav(`/o/${r.organization.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Join with an invite code">
      <form className="form" onSubmit={submit}>
        <p className="muted small">Got a code from your college, your instructor or ARC LABS? Enter it to join their organization. Your own organization stays as it is.</p>
        <label className="field">
          Invite code
          <input required autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="ARC-XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
        </label>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" disabled={busy} type="submit">
            {busy ? 'Joining…' : 'Join'}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
