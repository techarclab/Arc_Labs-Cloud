import { FormEvent, useCallback, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, isAdmin, Org, Role, ROLE_LABEL } from '../api';
import { ErrorBox, Modal, usePoll, useToast } from '../components/ui';
import { dateTime } from '../format';
import { useSession } from '../session';

interface Member { userId: string; email: string; displayName: string; role: Role; joinedAt: string }

const ROLE_HELP: Record<Role, string> = {
  org_admin: 'Everything, including the team, revoking devices and the audit log.',
  engineer: 'Add and manage projects’ devices and settings.',
  viewer: 'See devices and data, no changes.',
};

export function TeamPage() {
  const { orgId = '' } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const { user } = useSession();
  const toast = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const admin = isAdmin(org?.role);

  const load = useCallback(async () => {
    try {
      setMembers((await api<{ items: Member[] }>('GET', `/organizations/${orgId}/members`)).items);
    } catch (e) {
      setError(e);
    }
  }, [orgId]);
  usePoll(load, 60_000, [orgId]);

  async function changeRole(m: Member, role: Role) {
    try {
      await api('PATCH', `/organizations/${orgId}/members/${m.userId}`, { role });
      toast(`${m.displayName} is now ${ROLE_LABEL[role].toLowerCase()}`);
      setError(null);
      void load();
    } catch (e) {
      setError(e);
    }
  }
  async function remove(m: Member) {
    if (!confirm(`Remove ${m.displayName} from ${org?.name}? They’ll lose access straight away.`)) return;
    try {
      await api('DELETE', `/organizations/${orgId}/members/${m.userId}`);
      toast(`${m.displayName} removed`);
      setError(null);
      void load();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p className="sub">People who can sign in to {org?.name} and what they’re allowed to do.</p>
        </div>
        {admin && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            Add person
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      <section className="panel" style={{ marginTop: error ? 14 : 0 }}>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th className="hide-sm">Joined</th>
                {admin && <th />}
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
                    {admin ? (
                      <select value={m.role} onChange={(e) => changeRole(m, e.target.value as Role)} aria-label={`Role for ${m.displayName}`} style={{ width: 'auto' }}>
                        {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
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
                  {admin && (
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn small danger" onClick={() => remove(m)}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
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
      {adding && (
        <AddMember
          orgId={orgId}
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

function AddMember({ orgId, onClose, onAdded }: { orgId: string; onClose: () => void; onAdded: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('engineer');
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
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
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
