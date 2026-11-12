/**
 * Self-service sign-up steps that sit between "has an account" and "uses the console":
 *  - /verify-email#token=…  (public) confirms the address from the emailed link;
 *  - ProfileGate: an account created through Google says whether the person is 18+ (under-18s need an invite code);
 *  - VerifyGate: "check your inbox" until the address is confirmed;
 *  - JoinInviteDialog: a signed-in person joins an institution's organization with an invite code;
 *  - ForgotPasswordForm and /reset-password#token=… set a new password from an emailed link.
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

/** Shown in place of the sign-in form. The answer is the same whether or not the address has an account. */
export function ForgotPasswordForm({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-card form" onSubmit={submit}>
      <div className="auth-card-heading">
        <p className="auth-kicker">
          <span aria-hidden="true" /> ARC CLOUD CONSOLE
        </p>
        <h2 className="auth-title">Forgot your password?</h2>
        {!sent && <p className="muted">Enter your account’s email address and we’ll send you a link to set a new password.</p>}
      </div>
      {sent ? (
        <p className="muted">
          If an ARC Cloud account uses <b>{email.trim()}</b>, a link is on its way. It works once, for 60 minutes. Check spam too. Accounts made with
          “Sign in with Google” can simply use that button instead.
        </p>
      ) : (
        <>
          <label className="field">
            Email
            <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
          <ErrorBox error={error} />
          <button className="btn primary" disabled={busy} type="submit">
            {busy ? 'Please wait…' : 'Email me a link'}
          </button>
        </>
      )}
      <p className="small muted">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
        >
          Back to sign in
        </a>
      </p>
    </form>
  );
}

/** Opened from the reset email. The token is in the URL fragment, so it never reaches a server log. */
export function ResetPasswordPage() {
  const { signIn } = useSession();
  const nav = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token'));
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname); // drop the token from the address bar and history
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) {
      setError(new Error('The two passwords are different.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ accessToken: string }>('POST', '/auth/reset-password', { token, password });
      await signIn(r.accessToken);
      nav('/', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <OnboardingCard title="This link is incomplete">
        <p className="muted">Open the newest “Set a new password” email from ARC Cloud and use its full link, or ask for a new one from the sign-in page.</p>
        <button className="btn primary" type="button" onClick={() => nav('/', { replace: true })}>
          Go to sign in
        </button>
      </OnboardingCard>
    );
  }
  return (
    <div className="auth-form onboarding">
      <form className="auth-card form" onSubmit={submit}>
        <div className="brand" style={{ color: 'var(--ink)' }}>
          <ArcMark size={28} />
          ARC Cloud
        </div>
        <h2 className="auth-title">Set a new password</h2>
        <p className="muted small">At least 12 characters. You will be signed out on every other device.</p>
        <label className="field">
          New password
          <input type="password" required minLength={12} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <label className="field">
          New password again
          <input type="password" required minLength={12} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </label>
        <ErrorBox error={error} />
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? 'Please wait…' : 'Save and sign in'}
        </button>
      </form>
    </div>
  );
}

export type AccountType = 'individual' | 'organization' | 'other';

const ACCOUNT_TYPES: { value: AccountType; title: string; text: string }[] = [
  { value: 'individual', title: 'Just me', text: 'Your own projects at home, for study or as a hobby. Free for up to 5 devices and 3 channels, 30 days of history.' },
  { value: 'organization', title: 'My college, school or company', text: 'Join the organization ARC LABS has set up for you, with the invite code they gave you. Its plan sets the limits.' },
  { value: 'other', title: 'Something else', text: 'A club, research group, startup or event. You start on the free plan; tell us a little and ARC LABS can help with more.' },
];

/**
 * Asked once, right after the email address is confirmed: who is this account for?
 * Organizations join with an invite code from ARC LABS; everyone else continues on the free plan.
 */
export function AccountTypeGate({ name, onDone, onSignOut }: { name: string; onDone: () => Promise<void>; onSignOut: () => void }) {
  const { refreshOrgs } = useSession();
  const nav = useNavigate();
  const [type, setType] = useState<AccountType | ''>('');
  const [invite, setInvite] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ organization?: { id: string } }>('POST', '/auth/account-type', {
        accountType: type,
        ...(type === 'organization' ? { inviteCode: invite.trim() } : {}),
        ...(type === 'other' && note.trim() ? { note: note.trim() } : {}),
      });
      if (r.organization) await refreshOrgs();
      await onDone();
      nav(r.organization ? `/o/${r.organization.id}` : '/', { replace: true });
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
        <div>
          <p className="auth-kicker"><span aria-hidden="true" /> EMAIL CONFIRMED</p>
          <h2 className="auth-title">Welcome, {name.split(' ')[0]}! Who is this account for?</h2>
          <p className="muted">This sets up the right workspace and limits for you. You only answer once.</p>
        </div>
        <fieldset className="choice account-types">
          <legend className="sr-only">Who is this account for?</legend>
          {ACCOUNT_TYPES.map((t) => (
            <label key={t.value} className={type === t.value ? 'selected' : undefined}>
              <input type="radio" name="account-type" required checked={type === t.value} onChange={() => setType(t.value)} />
              <span>
                <b>{t.title}</b>
                <span className="hint">{t.text}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {type === 'organization' && (
          <label className="field">
            Invite code
            <span className="hint">From ARC LABS or your instructor, e.g. ARC-7KQ3-M9TX-4HPW. No code yet? Choose “Just me” and join later from the menu.</span>
            <input required value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus />
          </label>
        )}
        {type === 'other' && (
          <label className="field">
            What is it? <span className="hint">Optional, e.g. “Robotics club, 20 members”.</span>
            <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} autoFocus />
          </label>
        )}
        <ErrorBox error={error} />
        <button className="btn primary" disabled={busy || !type} type="submit">
          {busy ? 'Please wait…' : type === 'organization' ? 'Join my organization' : 'Continue'}
        </button>
        <button className="btn quiet small" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </form>
    </div>
  );
}
