import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, usePoll } from '../components/ui';
import { dateTime } from '../format';

interface Entry { id: number; actor_type: string; actor_id: string | null; action: string; resource_type: string; resource_id: string | null; metadata: Record<string, unknown>; created_at: string }

const ACTION: Record<string, string> = {
  'organization.create': 'Created the organization',
  'organization.update': 'Renamed the organization',
  'project.create': 'Created a project',
  'project.update': 'Changed project settings',
  'project.metric_definitions.set': 'Changed allowed readings',
  'device.create': 'Registered a device',
  'device.update': 'Edited a device',
  'device.credentials.rotate': 'Replaced a device password',
  'device.revoke': 'Revoked a device',
  'device.lifecycle': 'Changed a device’s status',
  'member.upsert': 'Added a person or changed their role',
  'member.role_change': 'Changed a role',
  'member.remove': 'Removed a person',
};

export function AuditPage() {
  const { orgId = '' } = useParams();
  const [items, setItems] = useState<Entry[] | null>(null);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const PAGE = 50;

  const load = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([
        api<{ items: Entry[] }>('GET', `/organizations/${orgId}/audit-logs?limit=${PAGE}&offset=${offset}`),
        api<{ items: { userId: string; displayName: string }[] }>('GET', `/organizations/${orgId}/members`),
      ]);
      setItems(a.items);
      setPeople(Object.fromEntries(m.items.map((x) => [x.userId, x.displayName])));
    } catch (e) {
      setError(e);
    }
  }, [orgId, offset]);
  usePoll(load, 30_000, [orgId, offset]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="sub">Every change made in this organization, newest first. Only admins can see this.</p>
        </div>
      </div>
      <ErrorBox error={error} />
      <section className="panel">
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th className="hide-sm">Details</th>
              </tr>
            </thead>
            <tbody>
              {items?.map((e) => (
                <tr key={e.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {dateTime(e.created_at)}
                  </td>
                  <td>{e.actor_type === 'user' ? (people[e.actor_id ?? ''] ?? 'Former member') : e.actor_type}</td>
                  <td>{ACTION[e.action] ?? e.action}</td>
                  <td className="hide-sm small muted">
                    {Object.keys(e.metadata ?? {}).length ? Object.entries(e.metadata).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-head" style={{ borderTop: '1px solid var(--line-soft)', borderBottom: 0 }}>
          <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Newer
          </button>
          <button className="btn small" disabled={(items?.length ?? 0) < PAGE} onClick={() => setOffset(offset + PAGE)}>
            Older
          </button>
        </div>
      </section>
    </>
  );
}
