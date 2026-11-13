import { FormEvent, useCallback, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api, assignableRoles, canManageTeam, Org, Role, ROLE_LABEL } from '../api';
import { ErrorBox, Modal, usePoll, useToast } from '../components/ui';
import { dateTime } from '../format';
import { useSession } from '../session';

interface Member { userId: string; email: string; displayName: string; role: Role; joinedAt: string }

/** What the roles people can hold today mean (teacher, trainer, student and employee arrive with channel-level access). */
const ROLE_HELP: Partial<Record<Role, string>> = {
  owner: 'Everything, and the only one who can add or remove admins and transfer ownership. One per organization.',
  admin: 'Everything else: settings, devices, keys, the audit log, and people below admin.',
  engineer: 'Add and manage channels, devices and rules.',
  viewer: 'See devices and data, no changes.',
};

export function TeamPage() {
  const { orgId = '' } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const { user, refreshOrgs } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const manage = canManageTeam(org);
  const mine = assignableRoles(org?.role);
  const personal = org?.kind === 'personal';

  const load = useCallback(async () => {
    try {
      setMembers((await api<{ items: Member[] }>('GET', `/organizations/${orgId}/members`)).items);
    } catch (e) {
      setError(e);
    }
  }, [orgId]);
  usePoll(load, 60_000, [orgId]);

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
          <button className="btn primary" onClick={() => setAdding(true)}>
            Add person
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      {personal && (
        <div className="note" style={{ marginBottom: 14 }}>
          A personal workspace has no team. To work with others, join their organization with an invite code, or ask ARC LABS to set one up for your college, school or company.
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
      {adding && (
        <AddMember
          orgId={orgId}
          roles={mine}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            toast('Person added');
            void load();
          }}
        />
      )}
    </>
  );
}

function AddMember({ orgId, roles, onClose, onAdded }: { orgId: string; roles: Role[]; onClose: () => void; onAdded: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(roles.includes('engineer') ? 'engineer' : roles[0]);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('POST', `/organizations/${orgId}/members`, { email, role });
      onAdded();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a person"
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="add-member">
            Add person
          </button>
        </>
      }
    >
      <form id="add-member" className="form" onSubmit={submit}>
        <p className="muted">They need an ARC Cloud account first. Ask them to sign up, then add them here with the same email.</p>
        <label className="field">
          Email
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
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}
