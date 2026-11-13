/**
 * Channel settings → Access: which teachers, trainers, students and employees can use this channel. Everyone with
 * an organization-wide role (owner, admin, engineer, viewer) already sees every channel.
 * Teachers and trainers who have the channel manage students; the owner and admins manage everyone.
 * Also: invite students by email straight into this channel, or make a class code for it.
 */
import { FormEvent, useCallback, useState } from 'react';
import { api, assignableRoles, Org, Role, ROLE_LABEL } from '../api';
import { CopyButton, ErrorBox, Modal, usePoll, useToast } from './ui';

interface Person { userId: string; email: string; displayName: string; role: Role }
interface Access { grants: (Person & { grantedAt: string; canRevoke: boolean })[]; candidates: Person[] }

export function ChannelAccess({ org, projectId, projectName }: { org: Org; projectId: string; projectName: string }) {
  const toast = useToast();
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pick, setPick] = useState('');
  const [dialog, setDialog] = useState<'invite' | 'class' | null>(null);
  // People with a scoped role this caller may bring into the channel (teachers and trainers: students).
  const roles = assignableRoles(org.role).filter((r) => r === 'teacher' || r === 'trainer' || r === 'student' || r === 'employee');

  const load = useCallback(async () => {
    try {
      setAccess(await api<Access>('GET', `/projects/${projectId}/access`));
    } catch (e) {
      setError(e);
    }
  }, [projectId]);
  usePoll(load, 60_000, [projectId]);

  async function change(method: 'PUT' | 'DELETE', p: Person) {
    try {
      await api(method, `/projects/${projectId}/access/${p.userId}`, method === 'PUT' ? {} : undefined);
      toast(method === 'PUT' ? `${p.displayName} can use ${projectName}` : `${p.displayName} no longer has ${projectName}`);
      setPick('');
      setError(null);
      void load();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Access</h2>
          <p className="small muted">
            Owners, admins, engineers and viewers see every channel. Teachers, trainers, students and employees see only the channels listed here.
          </p>
        </div>
        <div className="row">
          <button className="btn small" onClick={() => setDialog('class')}>
            Class code
          </button>
          <button className="btn small primary" onClick={() => setDialog('invite')}>
            Invite {roles.length === 1 ? 'students' : 'people'}
          </button>
        </div>
      </div>
      <div className="panel-body">
        <ErrorBox error={error} />
        {access && !access.grants.length && <p className="muted small">Nobody with a scoped role has this channel yet.</p>}
        {!!access?.grants.length && (
          <table className="grid">
            <tbody>
              {access.grants.map((g) => (
                <tr key={g.userId}>
                  <td>
                    <b>{g.displayName}</b> <span className="muted small">{g.email}</span>
                  </td>
                  <td>{ROLE_LABEL[g.role]}</td>
                  <td style={{ textAlign: 'right' }}>
                    {g.canRevoke && (
                      <button className="btn small danger" onClick={() => void change('DELETE', g)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!!access?.candidates.length && (
          <div className="row" style={{ marginTop: 12 }}>
            <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Give access to" style={{ width: 'auto', minWidth: 220 }}>
              <option value="">Give access to…</option>
              {access.candidates.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.displayName} ({ROLE_LABEL[c.role]})
                </option>
              ))}
            </select>
            <button className="btn" disabled={!pick} onClick={() => void change('PUT', access.candidates.find((c) => c.userId === pick)!)}>
              Add
            </button>
          </div>
        )}
      </div>
      {dialog && <InviteToChannel kind={dialog} org={org} projectId={projectId} projectName={projectName} roles={roles} onClose={() => setDialog(null)} onDone={() => void load()} />}
    </section>
  );
}

function InviteToChannel({ kind, org, projectId, projectName, roles, onClose, onDone }: { kind: 'invite' | 'class'; org: Org; projectId: string; projectName: string; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState(projectName);
  const [uses, setUses] = useState(60);
  const [role, setRole] = useState<Role>(roles.includes('student') ? 'student' : roles[0]);
  const [result, setResult] = useState<{ text: string; secret: string; label: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (kind === 'invite') {
        const r = await api<{ email: string; link: string }>('POST', `/organizations/${org.id}/invitations`, { email, role, projectIds: [projectId] });
        setResult({ text: `We emailed ${r.email}. When they accept, they join ${org.name} as ${ROLE_LABEL[role].toLowerCase()} with this channel. You can also share the link (it works only for them, once):`, secret: r.link, label: 'Copy link' });
      } else {
        const r = await api<{ code: string }>('POST', `/organizations/${org.id}/class-codes`, { label, role: 'student', maxUses: uses, expiresInDays: 30, projectIds: [projectId] });
        setResult({ text: `Share this code. Each person who enters it under “Join with invite code” (or at sign-up) joins as a student with ${projectName}. Shown only now:`, secret: r.code, label: 'Copy code' });
      }
      onDone();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={result ? 'Done' : kind === 'invite' ? `Invite to ${projectName}` : `Class code for ${projectName}`}
      footer={
        result ? (
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button className="btn quiet" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" type="submit" form="invite-channel">
              {kind === 'invite' ? 'Send invitation' : 'Create code'}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="form">
          <p>{result.text}</p>
          <div className="row">
            <code className="truncate" style={{ flex: 1 }}>{result.secret}</code>
            <CopyButton text={result.secret} label={result.label} />
          </div>
        </div>
      ) : (
        <form id="invite-channel" className="form" onSubmit={submit}>
          {kind === 'invite' ? (
            <>
              <label className="field">
                Email
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
              </label>
              {roles.length > 1 && (
                <label className="field">
                  Role
                  <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          ) : (
            <>
              <label className="field">
                Name
                <input required maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
              </label>
              <label className="field">
                How many students can use it
                <input type="number" min={1} max={10000} required value={uses} onChange={(e) => setUses(Number(e.target.value))} />
              </label>
              <p className="small muted">Expires in 30 days. Only while the organization has free seats.</p>
            </>
          )}
          <ErrorBox error={error} />
        </form>
      )}
    </Modal>
  );
}
