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
import { slugify } from '../format';

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

export type Path = 'individual' | 'organization' | 'institution' | 'join';
type Profession = 'engineer' | 'teacher' | 'trainer' | 'hobbyist' | 'other';
type OrgType = 'industry' | 'corporate' | 'school' | 'college' | 'university';

const PATHS: { value: Path; title: string; text: string }[] = [
  { value: 'individual', title: 'Individual', text: 'Your own projects: an engineer, teacher, trainer or hobbyist. Free for up to 5 devices and 3 channels.' },
  { value: 'organization', title: 'Organization', text: 'An industry or corporate team. Needs a setup code from ARC LABS; you become the owner.' },
  { value: 'institution', title: 'Institution', text: 'A school, college or university. Needs a setup code from ARC LABS; you become the owner.' },
  { value: 'join', title: 'Join my organization', text: 'Your college, school or company is already on ARC Cloud and gave you a class code.' },
];
const PROFESSIONS: { value: Profession; label: string }[] = [
  { value: 'engineer', label: 'Engineer' },
  { value: 'teacher', label: 'Teacher' },
  { value: 'trainer', label: 'Trainer' },
  { value: 'hobbyist', label: 'Hobbyist' },
  { value: 'other', label: 'Other' },
];
const ORG_TYPES: Record<'organization' | 'institution', { value: OrgType; label: string }[]> = {
  organization: [
    { value: 'industry', label: 'Industry' },
    { value: 'corporate', label: 'Corporate' },
  ],
  institution: [
    { value: 'school', label: 'School' },
    { value: 'college', label: 'College' },
    { value: 'university', label: 'University' },
  ],
};

/**
 * "Who are you?", asked once, right after the email address is confirmed (and after any emailed invitation).
 * Individuals get a personal workspace; organizations and institutions are created with an ARC LABS setup code;
 * people joining an existing organization use its class code (emailed invitations arrive by link instead).
 */
export function WhoAreYouGate({ name, email, onDone, onSignOut }: { name: string; email: string; onDone: () => Promise<void>; onSignOut: () => void }) {
  const { refreshOrgs } = useSession();
  const nav = useNavigate();
  const [path, setPath] = useState<Path | ''>('');
  const [profession, setProfession] = useState<Profession | ''>('');
  const [orgType, setOrgType] = useState<OrgType | ''>('');
  const [code, setCode] = useState('');
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const ready =
    path === 'individual' ? !!profession : path === 'join' ? !!code.trim() : path ? !!orgType && !!code.trim() && !!orgName.trim() && !!slug : false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      let orgId: string | undefined;
      if (path === 'individual') {
        await api('POST', '/onboarding/individual', { profession });
      } else if (path === 'join') {
        const r = await api<{ organization?: { id: string } }>('POST', '/auth/account-type', { accountType: 'organization', inviteCode: code.trim() });
        orgId = r.organization?.id;
      } else {
        const r = await api<{ organization: { id: string } }>('POST', '/onboarding/organization', { setupCode: code.trim(), name: orgName.trim(), slug, orgType });
        orgId = r.organization.id;
      }
      if (orgId) await refreshOrgs();
      await onDone();
      nav(orgId ? `/o/${orgId}` : '/', { replace: true });
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
          <h2 className="auth-title">Welcome, {name.split(' ')[0]}! Who are you?</h2>
          <p className="muted">This sets up the right workspace and limits for you. You answer once.</p>
        </div>
        <fieldset className="choice account-types">
          <legend className="sr-only">Who are you?</legend>
          {PATHS.map((t) => (
            <label key={t.value} className={path === t.value ? 'selected' : undefined}>
              <input
                type="radio"
                name="path"
                required
                checked={path === t.value}
                onChange={() => {
                  setPath(t.value);
                  setOrgType(t.value === 'organization' || t.value === 'institution' ? ORG_TYPES[t.value].length === 1 ? ORG_TYPES[t.value][0].value : '' : '');
                  setError(null);
                }}
              />
              <span>
                <b>{t.title}</b>
                <span className="hint">{t.text}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {path === 'individual' && (
          <fieldset className="choice chips">
            <legend>What do you do?</legend>
            {PROFESSIONS.map((p) => (
              <label key={p.value} className={profession === p.value ? 'selected' : undefined}>
                <input type="radio" name="profession" required checked={profession === p.value} onChange={() => setProfession(p.value)} />
                <span>{p.label}</span>
              </label>
            ))}
          </fieldset>
        )}

        {(path === 'organization' || path === 'institution') && (
          <>
            <fieldset className="choice chips">
              <legend>Which kind?</legend>
              {ORG_TYPES[path].map((o) => (
                <label key={o.value} className={orgType === o.value ? 'selected' : undefined}>
                  <input type="radio" name="org-type" required checked={orgType === o.value} onChange={() => setOrgType(o.value)} />
                  <span>{o.label}</span>
                </label>
              ))}
            </fieldset>
            <label className="field">
              Setup code from ARC LABS
              <span className="hint">ARC LABS emailed it to {email}. It works once, only for this address. No code? Contact ARC LABS, or choose “Individual” for now.</span>
              <input required value={code} onChange={(e) => setCode(e.target.value)} placeholder="ARC-XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
            </label>
            <label className="field">
              {path === 'institution' ? 'Name of your school, college or university' : 'Name of your organization'}
              <input
                required
                maxLength={120}
                value={orgName}
                onChange={(e) => {
                  setOrgName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
                placeholder={path === 'institution' ? 'Anurag University' : 'ARC LABS'}
              />
            </label>
            <label className="field">
              Short name
              <span className="hint">Lowercase letters, numbers and dashes. Used in links.</span>
              <input
                required
                pattern="[a-z0-9][a-z0-9\-]{1,62}"
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
              />
            </label>
          </>
        )}

        {path === 'join' && (
          <label className="field">
            Class code
            <span className="hint">From your instructor or organization, e.g. ARC-7KQ3-M9TX-4HPW. Got an email invitation instead? Open its link.</span>
            <input required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
          </label>
        )}

        <ErrorBox error={error} />
        <button className="btn primary" disabled={busy || !ready} type="submit">
          {busy ? 'Please wait…' : path === 'organization' || path === 'institution' ? 'Create my organization' : path === 'join' ? 'Join' : 'Continue'}
        </button>
        <button className="btn quiet small" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </form>
    </div>
  );
}
