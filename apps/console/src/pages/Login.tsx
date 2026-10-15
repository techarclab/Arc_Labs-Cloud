import { FormEvent, useState } from 'react';
import { api } from '../api';
import { ArcMark, ErrorBox } from '../components/ui';
import { useSession } from '../session';

/** A smooth, deterministic trace for the hero (no randomness, so it renders the same every time). */
function trace(seed: number, amp: number, base: number, w = 560, n = 48) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * w;
    const y = base + Math.sin(i / 4.2 + seed) * amp + Math.sin(i / 1.7 + seed * 2) * amp * 0.28;
    pts.push([x, y]);
  }
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
}

/** Hero illustration: three devices reporting in, drawn once on load. */
function SignalScene() {
  const lines = [
    { d: trace(0.4, 16, 70), c: '#17B39B' },
    { d: trace(2.1, 12, 132), c: '#6E8BFF' },
    { d: trace(4.0, 9, 188, 340, 30), c: '#F0A23B' },
  ];
  // The pump's signal stops: its line ends, then a faint dashed "last value" carries on.
  const endY = 188 + Math.sin(30 / 4.2 + 4) * 9 + Math.sin(30 / 1.7 + 8) * 9 * 0.28;
  return (
    <div className="scene" aria-hidden="true">
      <svg viewBox="0 0 560 240" preserveAspectRatio="none" className="scene-svg">
        {lines.map((l, i) => (
          <path key={i} d={l.d} stroke={l.c} className="trace" style={{ animationDelay: `${i * 0.35}s` }} />
        ))}
        <path d={`M340 ${endY.toFixed(1)} H560`} stroke="#F0A23B" className="trace-gap" />
        <circle cx="340" cy={endY} r="4" fill="#F0A23B" className="trace-end" />
      </svg>
      <div className="chip" style={{ left: '6%', top: '10%' }}>
        <span className="pulse" />
        <b>Greenhouse, bay 1</b>
        <span>28.4 °C</span>
      </div>
      <div className="chip" style={{ right: '4%', top: '44%' }}>
        <span className="pulse" />
        <b>Water tank</b>
        <span>72 %</span>
      </div>
      <div className="chip warn" style={{ left: '22%', bottom: '2%' }}>
        <span className="pulse" />
        <b>Pump controller</b>
        <span>no data for 12 min</span>
      </div>
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
          <ArcMark size={32} />
          <span>
            ARC Cloud <small>by ARC LABS</small>
          </span>
        </div>
        <video className="auth-video" autoPlay muted loop playsInline preload="auto" aria-hidden="true">
          <source src="/arc-labs-ident.mp4" type="video/mp4" />
        </video>
        <div className="auth-copy">
          <h1>Every device, reporting in.</h1>
          <p>Connect ESP32s and gateways over secure MQTT or simple HTTP, watch their readings live, and get told the moment one goes quiet.</p>
        </div>
        <SignalScene />
        <ul className="auth-points">
          <li>Live dashboards with 25 widgets</li>
          <li>Alerts by email and webhook</li>
          <li>Signed over-the-air updates</li>
        </ul>
      </section>
      <section className="auth-form">
        <img className="auth-logo" src="/arc-labs-logo.jpg" alt="ARC Labs — communicate, collaborate, create" />
        <form className="auth-card form" onSubmit={submit}>
          <div>
            <h2 className="auth-title">{mode === 'signin' ? 'Sign in' : 'Create your account'}</h2>
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
