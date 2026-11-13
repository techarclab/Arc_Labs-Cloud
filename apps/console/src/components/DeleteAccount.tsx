/**
 * "Delete my account": shows what will be deleted, then asks for three confirmations before anything happens:
 * a code shown as an image-like challenge (typed, not pasted), the account's email address, and the current password
 * (when the account has one). The API checks the email and password again and does the deletion.
 */
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorBox, Modal } from './ui';

interface Plan {
  deleteWorkspaces: { id: string; name: string; devices: number }[];
  leave: { id: string; name: string }[];
  blockers: { id: string; name: string }[];
  platformAdmin: boolean;
}

// No 0/O, 1/I/L: easy to read and type.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  const r = new Uint32Array(6);
  crypto.getRandomValues(r);
  return Array.from(r, (n) => ALPHABET[n % ALPHABET.length]).join('');
}

/** The challenge, drawn as SVG with jitter and noise lines, so it is read and typed rather than copied. */
function CodeImage({ code }: { code: string }) {
  const glyphs = useMemo(
    () => Array.from(code, (ch, i) => ({ ch, x: 18 + i * 30, y: 38 + ((i * 7) % 9) - 4, r: ((i * 37) % 31) - 15 })),
    [code],
  );
  return (
    <svg className="challenge" viewBox="0 0 200 56" role="img" aria-label={`Confirmation code: ${code.split('').join(' ')}`}>
      <rect width="200" height="56" rx="8" fill="#f3f5fa" />
      {[0, 1, 2].map((i) => (
        <path key={i} d={`M0 ${14 + i * 14} C 60 ${4 + i * 20}, 120 ${50 - i * 12}, 200 ${20 + i * 10}`} stroke="#c3cbe0" strokeWidth="1.5" fill="none" />
      ))}
      {glyphs.map((g, i) => (
        <text key={i} x={g.x} y={g.y} transform={`rotate(${g.r} ${g.x + 8} ${g.y - 10})`} fontSize="26" fontWeight="700" fontFamily="'IBM Plex Mono', monospace" fill="#2a3550">
          {g.ch}
        </text>
      ))}
    </svg>
  );
}

export function DeleteAccountDialog({ open, email, hasPassword, onClose, onDeleted }: { open: boolean; email: string; hasPassword: boolean; onClose: () => void; onDeleted: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [code, setCode] = useState(newCode);
  const [typedCode, setTypedCode] = useState('');
  const [typedEmail, setTypedEmail] = useState('');
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setError(null);
    setCode(newCode());
    setTypedCode('');
    setTypedEmail('');
    setPassword('');
    setUnderstood(false);
    api<Plan>('GET', '/auth/delete-account').then(setPlan).catch(setError);
  }, [open]);

  const codeOk = typedCode.replace(/\s/g, '').toUpperCase() === code;
  const emailOk = typedEmail.trim().toLowerCase() === email.toLowerCase();
  const blocked = !!plan && (plan.platformAdmin || plan.blockers.length > 0);
  const ready = !!plan && !blocked && codeOk && emailOk && understood && (!hasPassword || password.length > 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/delete-account', { confirmEmail: typedEmail.trim(), ...(hasPassword ? { currentPassword: password } : {}) });
      onDeleted();
    } catch (err) {
      setError(err);
      setCode(newCode()); // a failed try gets a fresh code
      setTypedCode('');
      setBusy(false);
    }
  }

  const devices = plan?.deleteWorkspaces.reduce((n, w) => n + w.devices, 0) ?? 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delete your account"
      footer={
        <div className="row">
          <button className="btn" type="button" onClick={onClose}>
            Keep my account
          </button>
          <button className="btn danger solid" type="submit" form="delete-account" disabled={!ready || busy}>
            {busy ? 'Deleting…' : 'Delete my account forever'}
          </button>
        </div>
      }
    >
      <form id="delete-account" className="form" onSubmit={submit}>
        <div className="note warn">
          This can’t be undone. Your account is deleted from ARC Cloud straight away, and you are signed out everywhere.
        </div>

        {!plan && !error && <p className="muted">Checking what would be deleted…</p>}
        {plan && (
          <div className="delete-plan">
            {plan.deleteWorkspaces.length > 0 && (
              <>
                <p>
                  <b>Deleted with all their data</b> (channels, {devices} device{devices === 1 ? '' : 's'} and their keys, readings, alerts, rules, API keys):
                </p>
                <ul>
                  {plan.deleteWorkspaces.map((w) => (
                    <li key={w.id}>
                      {w.name} <span className="muted">· {w.devices} device{w.devices === 1 ? '' : 's'}</span>
                    </li>
                  ))}
                </ul>
                {devices > 0 && <p className="small muted">Those devices stop connecting at once. Want to keep the readings? Download them first (channel → API keys &amp; export → Download CSV).</p>}
              </>
            )}
            {plan.leave.length > 0 && (
              <>
                <p>
                  <b>You leave</b> (they and their data stay):
                </p>
                <ul>
                  {plan.leave.map((o) => (
                    <li key={o.id}>{o.name}</li>
                  ))}
                </ul>
              </>
            )}
            {plan.blockers.length > 0 && (
              <div className="note warn">
                You own <b>{plan.blockers.map((o) => o.name).join(', ')}</b>. Transfer ownership to an admin there first (Team page), or ask ARC LABS to close it. Then come back here.
              </div>
            )}
            {plan.platformAdmin && <div className="note warn">This is an ARC LABS staff account. Platform admin must be removed with the operator tool before it can be deleted.</div>}
          </div>
        )}

        {plan && !blocked && (
          <>
            <div className="field">
              Type the code you see
              <span className="hint">This checks that a person, not a script or a stray click, is deleting the account.</span>
              <div className="challenge-row">
                <CodeImage code={code} />
                <button type="button" className="link-btn small" onClick={() => { setCode(newCode()); setTypedCode(''); }}>
                  New code
                </button>
              </div>
              <input
                value={typedCode}
                onChange={(e) => setTypedCode(e.target.value)}
                onPaste={(e) => e.preventDefault()}
                maxLength={8}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-invalid={typedCode.length >= 6 && !codeOk}
                placeholder="6 characters"
              />
            </div>
            <label className="field">
              Your email address
              <span className="hint">Type {email} to confirm.</span>
              <input type="email" value={typedEmail} onChange={(e) => setTypedEmail(e.target.value)} autoComplete="off" />
            </label>
            {hasPassword && (
              <label className="field">
                Current password
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </label>
            )}
            <label className="consent">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              <span>I understand my account{plan.deleteWorkspaces.length ? ', my workspaces and their data' : ''} will be deleted for good.</span>
            </label>
          </>
        )}
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}
