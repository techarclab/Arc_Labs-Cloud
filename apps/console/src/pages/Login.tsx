import { FormEvent, useMemo, useState } from 'react';
import { api } from '../api';
import { ArcMark, ErrorBox } from '../components/ui';
import { useSession } from '../session';

/** Decorative heartbeat wall: a fleet of 8 devices × 24 slots, a couple of them dropping out. */
function Wall() {
  const cells = useMemo(() => {
    const out: string[] = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 24; col++) {
        const dead = (row === 2 && col > 15) || (row === 5 && col > 6 && col < 11);
        const thin = !dead && (row * 7 + col * 3) % 11 === 0;
        out.push(dead ? '' : thin ? 'thin' : 'hit');
      }
    }
    return out;
  }, []);
  return (
    <div className="wall" aria-hidden="true">
      {cells.map((c, i) => (
        <i key={i} className={c} />
      ))}
    </div>
  );
}

export function LoginPage() {
  const { signIn } = useSession();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r =
        mode === 'signin'
          ? await api('POST', '/auth/login', { email, password })
          : await api('POST', '/auth/register', { email, password, displayName: name || email.split('@')[0] });
      await signIn(r.accessToken);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <section className="auth-art">
        <div className="brand">
          <ArcMark size={30} />
          ARC Cloud
        </div>
        <div>
          <h1>See every device that’s reporting in, and every one that stopped.</h1>
          <p>Register your ESP32s and gateways, give each one its own secure login, and watch their readings arrive live.</p>
          <Wall />
        </div>
        <p className="small">ARC LABS</p>
      </section>
      <section className="auth-form">
        <form className="auth-card form" onSubmit={submit}>
          <div>
            <h2 style={{ fontSize: 24 }}>{mode === 'signin' ? 'Sign in' : 'Create your account'}</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              {mode === 'signin' ? 'Use the email and password you signed up with.' : 'You’ll set up your organization and first project next.'}
            </p>
          </div>
          {mode === 'signup' && (
            <label className="field">
              Your name
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          )}
          <label className="field">
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
          </label>
          <label className="field">
            Password
            {mode === 'signup' && <span className="hint">At least 12 characters.</span>}
            <input
              type="password"
              required
              minLength={mode === 'signup' ? 12 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
          </label>
          <ErrorBox error={error} />
          <button className="btn primary" disabled={busy} type="submit">
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
          <p className="small muted">
            {mode === 'signin' ? 'New to ARC Cloud? ' : 'Already have an account? '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setError(null);
                setMode(mode === 'signin' ? 'signup' : 'signin');
              }}
            >
              {mode === 'signin' ? 'Create an account' : 'Sign in'}
            </a>
          </p>
        </form>
      </section>
    </div>
  );
}
