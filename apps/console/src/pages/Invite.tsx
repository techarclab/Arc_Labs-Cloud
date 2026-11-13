/**
 * Emailed invitations: /invite#token=… shows who invited you to what. The token waits in sessionStorage while the
 * person signs in or creates an account (and confirms their email), then PendingInviteGate offers "Accept" before
 * anything else. The API checks everything again (single use, expiry, the invited address, seats).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ROLE_LABEL, Role } from '../api';
import { ArcMark, ErrorBox } from '../components/ui';
import { useSession } from '../session';

interface Preview { organizationName: string; role: Role; invitedBy: string | null; email: string; expiresAt: string }

const KEY = 'arc.inviteToken';
const INFO = 'arc.inviteInfo';
const store = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* private mode: the invitation then works only in this tab's session */
    }
  },
  del: (k: string) => {
    try {
      sessionStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};
export const pendingInviteToken = () => store.get(KEY);
/** For the sign-in page: "sign in with x***@… to join …". */
export function pendingInviteInfo(): Preview | null {
  try {
    return JSON.parse(store.get(INFO) ?? 'null');
  } catch {
    return null;
  }
}
function clearPendingInvite() {
  store.del(KEY);
  store.del(INFO);
}

function InviteCard({ token, signedIn, onAccepted, onLeave }: { token: string; signedIn: boolean; onAccepted: (orgId: string) => void; onLeave: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Preview>('GET', `/invitations/preview?token=${encodeURIComponent(token)}`)
      .then((p) => {
        setPreview(p);
        store.set(INFO, JSON.stringify(p));
      })
      .catch(setError);
  }, [token]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ organization: { id: string } }>('POST', '/invitations/accept', { token });
      clearPendingInvite();
      onAccepted(r.organization.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="auth-form onboarding">
      <div className="auth-card form">
        <div className="brand" style={{ color: 'var(--ink)' }}>
          <ArcMark size={28} />
          ARC Cloud
        </div>
        {preview ? (
          <>
            <div>
              <p className="auth-kicker"><span aria-hidden="true" /> INVITATION</p>
              <h2 className="auth-title">Join {preview.organizationName}</h2>
              <p className="muted">
                {preview.invitedBy ? `${preview.invitedBy} invited you` : 'You are invited'} to join <b>{preview.organizationName}</b> as{' '}
                <b>{ROLE_LABEL[preview.role] ?? preview.role}</b>. The invitation is for <b>{preview.email}</b> and works once.
              </p>
            </div>
            <ErrorBox error={error} />
            {signedIn ? (
              <button className="btn primary" type="button" disabled={busy} onClick={() => void accept()}>
                {busy ? 'Joining…' : `Accept and join ${preview.organizationName}`}
              </button>
            ) : (
              <>
                <p className="small muted">Sign in, or create a free account, with {preview.email}. You come back here to accept afterwards.</p>
                <button className="btn primary" type="button" onClick={onLeave}>
                  Sign in or create an account
                </button>
              </>
            )}
          </>
        ) : error ? (
          <>
            <h2 className="auth-title">Invitation not valid</h2>
            <ErrorBox error={error} />
          </>
        ) : (
          <p className="muted">Checking the invitation…</p>
        )}
        <button
          className="btn quiet small"
          type="button"
          onClick={() => {
            clearPendingInvite();
            onLeave();
          }}
        >
          {preview && signedIn ? 'Not now' : 'Close'}
        </button>
      </div>
    </div>
  );
}

/** Opened from the email. The token is in the URL fragment, so it never reaches a server log. */
export function InvitePage() {
  const { user, refreshOrgs } = useSession();
  const nav = useNavigate();
  const [token] = useState(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get('token');
    window.history.replaceState(null, '', window.location.pathname);
    if (t) store.set(KEY, t);
    return t ?? pendingInviteToken();
  });
  if (!token) {
    return (
      <div className="auth-form onboarding">
        <div className="auth-card form">
          <h2 className="auth-title">This link is incomplete</h2>
          <p className="muted">Open the newest invitation email and use its button or full link.</p>
        </div>
      </div>
    );
  }
  return (
    <InviteCard
      token={token}
      signedIn={!!user && user.emailVerified !== false}
      onAccepted={async (orgId) => {
        await refreshOrgs();
        nav(`/o/${orgId}`, { replace: true });
      }}
      onLeave={() => nav('/', { replace: true })}
    />
  );
}

/** After signing in (and confirming the email): accept the invitation that brought the person here. */
export function PendingInviteGate({ token, onDone }: { token: string; onDone: () => Promise<void> }) {
  const { refreshOrgs } = useSession();
  const nav = useNavigate();
  return (
    <InviteCard
      token={token}
      signedIn
      onAccepted={async (orgId) => {
        await refreshOrgs();
        await onDone();
        nav(`/o/${orgId}`, { replace: true });
      }}
      onLeave={() => void onDone()}
    />
  );
}
