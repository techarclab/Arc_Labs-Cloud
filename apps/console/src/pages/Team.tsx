import { FormEvent, useCallback, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api, assignableRoles, canManageTeam, Org, Role, ROLE_LABEL } from '../api';
import { CopyButton, ErrorBox, Modal, usePoll, useToast } from '../components/ui';
import { dateTime } from '../format';
import { useSession } from '../session';

interface Member { userId: string; email: string; displayName: string; role: Role; joinedAt: string }
interface Invitation {
  id: string;
  kind: 'email' | 'class';
  label: string;
  email: string | null;
  role: Role;
  maxUses: number;
  usedCount: number;
  members: number;
  status: 'active' | 'used_up' | 'expired' | 'revoked';
  expiresAt: string;
  createdBy: string | null;
  acceptedBy: string | null;
}
interface Seats { members: number; pending: number; limit: number; max: number; free: number }

/** What the roles people can hold today mean (teacher, trainer, student and employee arrive with channel-level access). */
const ROLE_HELP: Partial<Record<Role, string>> = {
  owner: 'Everything, and the only one who can add or remove admins and transfer ownership. One per organization.',
  admin: 'Everything else: settings, devices, keys, the audit log, and people below admin.',
  engineer: 'Add and manage channels, devices and rules, in every channel.',
  viewer: 'See every channel’s devices and data, no changes.',
  teacher: 'Manages devices and rules in the channels given to them, and brings students into those channels.',
  trainer: 'Like a teacher: their channels only, and can bring in students.',
  student: 'Sees and uses the devices of the channels given to them. Nothing organization-wide.',
  employee: 'Sees and uses the devices of the channels given to them. Nothing organization-wide.',
};
const STATUS: Record<Invitation['status'], string> = { active: 'Open', used_up: 'Used', expired: 'Expired', revoked: 'Revoked' };

export function TeamPage() {
  const { orgId = '' } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const { user, refreshOrgs } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[] | null>(null);
  const [seats, setSeats] = useState<Seats | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<'invite' | 'class' | 'seats' | null>(null);
  const manage = canManageTeam(org);
  const mine = assignableRoles(org?.role);
  const personal = org?.kind === 'personal';

  const load = useCallback(async () => {
    try {
      setMembers((await api<{ items: Member[] }>('GET', `/organizations/${orgId}/members`)).items);
      if (manage) {
        const r = await api<{ items: Invitation[]; seats: Seats }>('GET', `/organizations/${orgId}/invitations`);
        setInvites(r.items);
        setSeats(r.seats);
      }
    } catch (e) {
      setError(e);
    }
  }, [orgId, manage]);
  usePoll(load, 60_000, [orgId, manage]);

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast(done);
      setError(null);
      void load();
    } catch (e) {
      setError(e);
    }
  }
  const changeRole = (m: Member, role: Role) =>
    act(() => api('PATCH', `/organizations/${orgId}/members/${m.userId}`, { role }), `${m.displayName} is now ${ROLE_LABEL[role].toLowerCase()}`);
  const remove = (m: Member) =>
    confirm(`Remove ${m.displayName} from ${org?.name}? They’ll lose access straight away.`) &&
    act(() => api('DELETE', `/organizations/${orgId}/members/${m.userId}`), `${m.displayName} removed`);
  const transfer = (m: Member) =>
    confirm(`Make ${m.displayName} the owner of ${org?.name}? You become an admin, and only they can make you owner again.`) &&
    act(async () => {
      await api('POST', `/organizations/${orgId}/transfer-ownership`, { userId: m.userId });
      await refreshOrgs();
    }, `${m.displayName} is now the owner`);
  const revoke = (i: Invitation) => {
    const who = i.kind === 'email' ? `the invitation for ${i.email}` : `the class code “${i.label}”`;
    if (!confirm(`Revoke ${who}? It stops working straight away.`)) return;
    const removeMembers = i.kind === 'class' && i.members > 0 && confirm(`Also remove the ${i.members} people who joined with it? (Owners and admins are never removed this way.)`);
    void act(() => api('POST', `/organizations/${orgId}/invitations/${i.id}/revoke`, { removeMembers }), 'Revoked');
  };
  async function leave() {
    if (!user || !confirm(`Leave ${org?.name}? You lose access straight away; someone would have to invite you again.`)) return;
    try {
      await api('DELETE', `/organizations/${orgId}/members/${user.id}`);
      await refreshOrgs();
      toast(`You left ${org?.name}`);
      nav('/');
    } catch (e) {
      setError(e);
    }
  }

  // The owner and the people the caller may manage; never yourself (leave instead).
  const canTouch = (m: Member) => manage && m.userId !== user?.id && m.role !== 'owner' && mine.includes(m.role);
  const open = invites?.filter((i) => i.status === 'active') ?? [];
  const past = invites?.filter((i) => i.status !== 'active').slice(0, 20) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p className="sub">
            {personal ? 'This is your personal workspace: it is just you.' : `People who can sign in to ${org?.name} and what they’re allowed to do.`}
          </p>
        </div>
        {manage && (
          <div className="row">
            <button className="btn" onClick={() => setDialog('class')}>
              Class code
            </button>
            <button className="btn primary" onClick={() => setDialog('invite')}>
              Invite people
            </button>
          </div>
        )}
      </div>
      <ErrorBox error={error} />
      {personal && (
        <div className="note" style={{ marginBottom: 14 }}>
          A personal workspace has no team. To work with others, join their organization with an invite code, or ask ARC LABS to set one up for your college, school or company.
        </div>
      )}
      {manage && seats && (
        <div className="seats-bar">
          <span>
            <b>{seats.members}</b> of <b>{seats.limit}</b> seats used{seats.pending ? ` · ${seats.pending} invited` : ''} · {seats.free} free
          </span>
          <button className="link-btn small" onClick={() => setDialog('seats')}>
            Change the limit
          </button>
        </div>
      )}
      <section className="panel" style={{ marginTop: error ? 14 : 0 }}>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th className="hide-sm">Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members?.map((m) => (
                <tr key={m.userId}>
                  <td>
                    <b>{m.displayName}</b>
                    {m.userId === user?.id && <span className="muted"> (you)</span>}
                  </td>
                  <td>{m.email}</td>
                  <td>
                    {canTouch(m) ? (
                      <select value={m.role} onChange={(e) => void changeRole(m, e.target.value as Role)} aria-label={`Role for ${m.displayName}`} style={{ width: 'auto' }}>
                        {mine.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABEL[m.role]
                    )}
                  </td>
                  <td className="hide-sm muted">{dateTime(m.joinedAt)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {org?.role === 'owner' && m.role === 'admin' && !personal && (
                      <button className="btn small" onClick={() => void transfer(m)}>
                        Make owner
                      </button>
                    )}{' '}
                    {canTouch(m) && (
                      <button className="btn small danger" onClick={() => void remove(m)}>
                        Remove
                      </button>
                    )}
                    {m.userId === user?.id && !personal && m.role !== 'owner' && (
                      <button className="btn small" onClick={() => void leave()}>
                        Leave
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {manage && invites && (open.length > 0 || past.length > 0) && (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="panel-head">
            <h2>Invitations and class codes</h2>
          </div>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>For</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th className="hide-sm">Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...open, ...past].map((i) => (
                  <tr key={i.id} className={i.status === 'active' ? undefined : 'muted'}>
                    <td>
                      {i.kind === 'email' ? i.email : <b>{i.label}</b>}
                      <div className="small muted">
                        {i.kind === 'email'
                          ? i.acceptedBy
                            ? `Accepted by ${i.acceptedBy}`
                            : `Email invitation${i.createdBy ? ` from ${i.createdBy}` : ''}`
                          : `Class code · ${i.usedCount}/${i.maxUses} used · ${i.members} in the organization`}
                      </div>
                    </td>
                    <td>{ROLE_LABEL[i.role] ?? i.role}</td>
                    <td>{STATUS[i.status]}</td>
                    <td className="hide-sm muted">{dateTime(i.expiresAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {i.status === 'active' && mine.includes(i.role) && (
                        <button className="btn small danger" onClick={() => revoke(i)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!personal && (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="panel-body">
            <h3 style={{ marginBottom: 10 }}>What each role can do</h3>
            <dl className="kv">
              {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
                <div key={r} style={{ display: 'contents' }}>
                  <dt>{ROLE_LABEL[r]}</dt>
                  <dd>{ROLE_HELP[r]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      )}
      {dialog === 'invite' && <InviteDialog orgId={orgId} roles={mine} onClose={() => setDialog(null)} onDone={() => void load()} />}
      {dialog === 'class' && <ClassCodeDialog orgId={orgId} onClose={() => setDialog(null)} onDone={() => void load()} />}
      {dialog === 'seats' && seats && (
        <SeatsDialog
          orgId={orgId}
          seats={seats}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            toast('Seat limit saved');
            void load();
          }}
        />
      )}
    </>
  );
}

function InviteDialog({ orgId, roles, onClose, onDone }: { orgId: string; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(roles.includes('engineer') ? 'engineer' : roles[0]);
  const [days, setDays] = useState(7);
  const [sent, setSent] = useState<{ email: string; link: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ email: string; link: string }>('POST', `/organizations/${orgId}/invitations`, { email, role, expiresInDays: days });
      setSent(r);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={sent ? 'Invitation sent' : 'Invite someone'}
      footer={
        sent ? (
          <>
            <button
              className="btn quiet"
              onClick={() => {
                setSent(null);
                setEmail('');
              }}
            >
              Invite another
            </button>
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <button className="btn quiet" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" type="submit" form="invite" disabled={busy}>
              {busy ? 'Sending…' : 'Send invitation'}
            </button>
          </>
        )
      }
    >
      {sent ? (
        <div className="form">
          <p>
            We emailed an invitation to <b>{sent.email}</b>. They join when they accept it, signed in with that address.
          </p>
          <p className="small muted">You can also share this link another way (chat, WhatsApp). It works only for {sent.email}, once. It won’t be shown again.</p>
          <div className="row">
            <code className="truncate" style={{ flex: 1 }}>{sent.link}</code>
            <CopyButton text={sent.link} label="Copy link" />
          </div>
        </div>
      ) : (
        <form id="invite" className="form" onSubmit={submit}>
          <label className="field">
            Email
            <span className="hint">They don’t need an ARC Cloud account yet: the email explains how to create one.</span>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <label className="field">
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}: {ROLE_HELP[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Expires after
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[1, 3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d} day{d === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </label>
          <ErrorBox error={error} />
        </form>
      )}
    </Modal>
  );
}

function ClassCodeDialog({ orgId, onClose, onDone }: { orgId: string; onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = useState('');
  const [uses, setUses] = useState(60);
  const [days, setDays] = useState(14);
  const [role, setRole] = useState<'student' | 'viewer'>('student');
  const [made, setMade] = useState<{ code: string; label: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ code: string; label: string }>('POST', `/organizations/${orgId}/class-codes`, { label, role, maxUses: uses, expiresInDays: days });
      setMade(r);
      onDone();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={made ? 'Class code created' : 'New class code'}
      footer={
        made ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn quiet" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" type="submit" form="class-code">
              Create code
            </button>
          </>
        )
      }
    >
      {made ? (
        <div className="form">
          <p>Share this code with “{made.label}”. Each person enters it under <b>Join with invite code</b> (or when they sign up) and joins as a {role}.</p>
          <div className="row">
            <code style={{ fontSize: 20, letterSpacing: 2 }}>{made.code}</code>
            <CopyButton text={made.code} label="Copy code" />
          </div>
          <p className="small muted">It won’t be shown again. Anyone with it can join until it is used up, expires, or you revoke it, and only while there are free seats.</p>
        </div>
      ) : (
        <form id="class-code" className="form" onSubmit={submit}>
          <p className="muted small">A shared code for a class or batch. To give students a channel straight away, make the code from that channel’s settings (Access).</p>
          <label className="field">
            Joins as
            <select value={role} onChange={(e) => setRole(e.target.value as 'student' | 'viewer')}>
              <option value="student">Student: only the channels given to them</option>
              <option value="viewer">Viewer: sees every channel, no changes</option>
            </select>
          </label>
          <label className="field">
            Name
            <input required maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ECE batch 2026, section B" autoFocus />
          </label>
          <label className="field">
            How many people can use it
            <input type="number" min={1} max={10000} required value={uses} onChange={(e) => setUses(Number(e.target.value))} />
          </label>
          <label className="field">
            Expires after (days)
            <input type="number" min={1} max={365} required value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </label>
          <ErrorBox error={error} />
        </form>
      )}
    </Modal>
  );
}

function SeatsDialog({ orgId, seats, onClose, onDone }: { orgId: string; seats: Seats; onClose: () => void; onDone: () => void }) {
  const [limit, setLimit] = useState(seats.limit);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('PATCH', `/organizations/${orgId}/seats`, { seatLimit: limit >= seats.max ? null : limit });
      onDone();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Seat limit"
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="seats">
            Save
          </button>
        </>
      }
    >
      <form id="seats" className="form" onSubmit={submit}>
        <p className="muted small">
          How many people may be in this organization, counting open invitations. Your plan allows up to {seats.max}. Lowering it removes nobody; it only stops new people joining.
        </p>
        <label className="field">
          Seats
          <input type="number" min={1} max={seats.max} required value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        </label>
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}
