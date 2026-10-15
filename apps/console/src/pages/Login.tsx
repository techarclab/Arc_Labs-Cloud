import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ArcMark, ErrorBox } from '../components/ui';
import { useSession } from '../session';

type GoogleCredentialResponse = { credential?: string };
type GoogleIdentityApi = {
  initialize: (options: { client_id: string; callback: (response: GoogleCredentialResponse) => void }) => void;
  renderButton: (
    element: HTMLElement,
    options: { type: 'standard'; theme: 'outline'; size: 'large'; text: 'signin_with'; shape: 'rectangular'; width: number },
  ) => void;
};

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentityApi } };
  }
}

function GoogleSignInButton({ clientId, onCredential }: { clientId: string; onCredential: (credential: string) => void }) {
  const button = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = button.current;
    if (!container) return;
    let active = true;
    const render = () => {
      const identity = window.google?.accounts?.id;
      if (!active || !identity) return;
      identity.initialize({
        client_id: clientId,
        callback: ({ credential }) => {
          if (credential) onCredential(credential);
        },
      });
      identity.renderButton(container, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        shape: 'rectangular',
        width: Math.min(400, Math.max(200, Math.floor(container.getBoundingClientRect().width))),
      });
    };
    const fail = () => active && setFailed(true);
    let script = document.querySelector<HTMLScriptElement>('script[data-google-identity-services]');
    if (window.google?.accounts?.id) {
      render();
      return () => { active = false; };
    }
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.googleIdentityServices = 'true';
    }
    script.addEventListener('load', render, { once: true });
    script.addEventListener('error', fail, { once: true });
    if (!script.isConnected) document.head.appendChild(script);
    return () => {
      active = false;
      script?.removeEventListener('load', render);
      script?.removeEventListener('error', fail);
    };
  }, [clientId, onCredential]);

  return (
    <>
      <div className="google-signin-button" ref={button} />
      {failed && <p className="google-auth-status">Could not load Google sign-in. You can still use your email and password.</p>}
    </>
  );
}

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
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [googleConfigLoaded, setGoogleConfigLoaded] = useState(false);
  const [googleConfigFailed, setGoogleConfigFailed] = useState(false);

  useEffect(() => {
    let active = true;
    api<{ clientId: string | null }>('GET', '/auth/google/config')
      .then(({ clientId }) => {
        if (active) setGoogleClientId(clientId);
      })
      .catch(() => {
        if (active) setGoogleConfigFailed(true);
      })
      .finally(() => {
        if (active) setGoogleConfigLoaded(true);
      });
    return () => { active = false; };
  }, []);

  const signInWithGoogle = useCallback(async (credential: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api('POST', '/auth/google', { credential });
      await signIn(r.accessToken);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }, [signIn]);

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
        <form className="auth-card form" onSubmit={submit}>
          <div>
            <h2 className="auth-title">{mode === 'signin' ? 'Sign in' : 'Create your account'}</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              {mode === 'signin' ? 'Use the email and password you signed up with.' : 'You’ll set up your organization and first project next.'}
            </p>
          </div>
          {mode === 'signin' && (
            <div className="google-auth-section">
              {googleClientId ? (
                <GoogleSignInButton clientId={googleClientId} onCredential={signInWithGoogle} />
              ) : (
                <p className="google-auth-status" role="status">
                  {!googleConfigLoaded
                    ? 'Loading Google sign-in…'
                    : googleConfigFailed
                      ? 'Google sign-in settings could not be loaded.'
                      : 'Google sign-in is not configured on this server yet.'}
                </p>
              )}
              <div className="auth-divider"><span>or use email</span></div>
            </div>
          )}
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
