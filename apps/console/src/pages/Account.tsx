/** "Your account": who you are, how you sign in, your organizations, password and sessions. */
import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ROLE_LABEL } from '../api';
import { DeleteAccountDialog } from '../components/DeleteAccount';
import { ErrorBox, useToast } from '../components/ui';
import { useSession } from '../session';

interface Me {
  user: {
    id: string;
    email: string;
    displayName: string;
    createdAt: string;
    emailVerifiedAt: string | null;
    ageGroup: 'adult' | 'minor' | null;
    termsVersion: string | null;
    termsAcceptedAt: string | null;
    signIn: { password: boolean; google: boolean };
  };
  memberships: { id: string; name?: string; role: keyof typeof ROLE_LABEL }[];
  isPlatformAdmin: boolean;
}

const day = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export function AccountPage() {
  const { orgs, reload, signIn, signOut } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [pwError, setPwError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    try {
      const m = await api<Me>('GET', '/auth/me');
      setMe(m);
      setName(m.user.displayName);
    } catch (err) {
      setError(err);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    try {
      await api('PATCH', '/auth/me', { displayName: name.trim() });
      await reload();
      await load();
      toast('Name saved');
    } catch (err) {
      setError(err);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    if (next !== again) {
      setPwError(new Error('The two new passwords are different.'));
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ accessToken: string }>('POST', '/auth/change-password', { currentPassword: current, newPassword: next });
      await signIn(r.accessToken); // this browser stays signed in; every other session is signed out
      setCurrent('');
      setNext('');
      setAgain('');
      toast('Password changed. You were signed out everywhere else.');
    } catch (err) {
      setPwError(err);
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    if (!confirm('Sign out on every device and browser, including this one?')) return;
    try {
      await api('POST', '/auth/sign-out-everywhere');
    } finally {
      signOut();
      nav('/');
    }
  }

  if (!me) return <ErrorBox error={error} />;
  const u = me.user;
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? me.memberships.find((m) => m.id === id)?.name ?? id;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Your account</h1>
          <p className="sub">{u.email}</p>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="stack">
        <section className="panel">
          <div className="panel-head">
            <h2>Profile</h2>
          </div>
          <div className="panel-body">
            <form className="form" onSubmit={saveName} style={{ maxWidth: 460 }}>
              <label className="field">
                Name
                <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
              <div className="row">
                <button className="btn primary" type="submit" disabled={name.trim() === u.displayName || !name.trim()}>
                  Save name
                </button>
              </div>
            </form>
            <dl className="facts">
              <dt>Email</dt>
              <dd>
                {u.email} {u.emailVerifiedAt ? <span className="pill ok">confirmed</span> : <span className="pill warn">not confirmed</span>}
              </dd>
              <dt>Sign in with</dt>
              <dd>{[u.signIn.password && 'email and password', u.signIn.google && 'Google'].filter(Boolean).join(' or ') || '—'}</dd>
              <dt>Age</dt>
              <dd>{u.ageGroup === 'adult' ? '18 or older' : u.ageGroup === 'minor' ? 'under 18 (joined through an institution)' : '—'}</dd>
              <dt>Member since</dt>
              <dd>{day(u.createdAt)}</dd>
              <dt>Privacy notice</dt>
              <dd>
                version {u.termsVersion ?? '—'}, accepted {day(u.termsAcceptedAt)} · <Link to="/privacy">read it</Link>
              </dd>
              {me.isPlatformAdmin && (
                <>
                  <dt>ARC LABS</dt>
                  <dd>platform admin (plans and invite codes for every organization; no access to their data)</dd>
                </>
              )}
            </dl>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Organizations</h2>
            <span className="muted small">Your role is separate in each one.</span>
          </div>
          <div className="table-wrap">
            <table className="grid">
              <tbody>
                {me.memberships.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link to={`/o/${m.id}`}>{orgName(m.id)}</Link>
                    </td>
                    <td style={{ textAlign: 'right' }}>{ROLE_LABEL[m.role] ?? m.role}</td>
                  </tr>
                ))}
                {!me.memberships.length && (
                  <tr>
                    <td className="muted">None yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Password</h2>
          </div>
          <div className="panel-body">
            {u.signIn.password ? (
              <form className="form" onSubmit={changePassword} style={{ maxWidth: 460 }}>
                <label className="field">
                  Current password
                  <input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
                </label>
                <label className="field">
                  New password
                  <span className="hint">At least 12 characters.</span>
                  <input type="password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
                </label>
                <label className="field">
                  New password again
                  <input type="password" required minLength={12} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
                </label>
                <ErrorBox error={pwError} />
                <div className="row">
                  <button className="btn primary" type="submit" disabled={busy}>
                    {busy ? 'Please wait…' : 'Change password'}
                  </button>
                </div>
                <p className="small muted">Changing it signs you out on every other device.</p>
              </form>
            ) : (
              <p className="muted">
                You sign in with Google, so there is no ARC Cloud password. To add one, sign out and use <b>Forgot password?</b> on the sign-in page: the link
                goes to {u.email}.
              </p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Sessions</h2>
          </div>
          <div className="panel-body">
            <p className="muted">Lost a phone or used a shared computer? This signs you out on every device and browser, including this one.</p>
            <button className="btn danger" type="button" onClick={() => void signOutEverywhere()}>
              Sign out everywhere
            </button>
          </div>
        </section>

        <section className="panel danger-zone">
          <div className="panel-head">
            <div>
              <h2>Delete your account</h2>
              <p className="small muted">Removes your account from ARC Cloud for good. This can’t be undone.</p>
            </div>
          </div>
          <div className="panel-body">
            <ul className="danger-list">
              <li>Your personal workspaces are deleted with their channels, devices, keys and readings; devices stop working right away</li>
              <li>You leave the organizations you are a member of; they keep their data</li>
              <li>If you own an organization, transfer ownership to one of its admins first</li>
            </ul>
            <button className="btn danger" type="button" onClick={() => setDeleting(true)}>
              Delete my account…
            </button>
          </div>
        </section>
      </div>
      <DeleteAccountDialog
        open={deleting}
        email={u.email}
        hasPassword={u.signIn.password}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false);
          signOut();
          nav('/');
          toast('Your account has been deleted.');
        }}
      />
    </>
  );
}
