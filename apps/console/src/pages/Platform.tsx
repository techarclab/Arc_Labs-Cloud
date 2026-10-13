import { FormEvent, useCallback, useState } from 'react';
import { api } from '../api';
import { ago, dateTime } from '../format';
import { ErrorBox, Modal, useNow, usePoll, useToast } from '../components/ui';
import { useSession } from '../session';

type Limits = { devices: number; projects: number; rules: number; apiKeys: number; webhooks: number };
interface PlatformOrg {
  id: string;
  name: string;
  slug: string;
  plan: string;
  retentionDays: number;
  limits: Limits;
  members: number;
  devices: number;
  projects: number;
  ownerEmail: string | null;
  lastDataAt: string | null;
  createdAt: string;
}
type Plans = Record<string, { maxDevices: number; maxProjects: number; maxRules: number; maxApiKeys: number; maxWebhooks: number; retentionDays: number }>;

/** ARC LABS staff only: every customer organization, its usage and its plan. */
export function PlatformPage() {
  const { user } = useSession();
  const toast = useToast();
  const now = useNow(60_000);
  const [items, setItems] = useState<PlatformOrg[] | null>(null);
  const [plans, setPlans] = useState<Plans>({});
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<PlatformOrg | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: PlatformOrg[]; plans: Plans }>('GET', '/platform/organizations');
      setItems(r.items);
      setPlans(r.plans);
    } catch (e) {
      setError(e);
    }
  }, []);
  usePoll(load, 60_000, [load]);

  if (!user?.isPlatformAdmin) {
    return (
      <div className="empty">
        <h3>ARC LABS staff only</h3>
        <p>Platform administrators are set with PLATFORM_ADMIN_EMAILS on the API server.</p>
      </div>
    );
  }
  const shown = (items ?? []).filter((o) => !q || `${o.name} ${o.slug} ${o.ownerEmail ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const totals = (items ?? []).reduce((a, o) => ({ orgs: a.orgs + 1, devices: a.devices + o.devices, members: a.members + o.members }), { orgs: 0, devices: 0, members: 0 });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ARC LABS admin</h1>
          <p className="sub">Every customer organization on this ARC Cloud, with its plan and limits. You can’t see their devices or data from here.</p>
        </div>
        <input type="search" placeholder="Search organizations" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} aria-label="Search organizations" />
      </div>
      <ErrorBox error={error} />
      <section className="panel">
        <div className="kpis">
          <div className="kpi">
            <span className="label">Organizations</span>
            <span className="value">{items ? totals.orgs : '—'}</span>
          </div>
          <div className="kpi">
            <span className="label">Devices</span>
            <span className="value">{items ? totals.devices : '—'}</span>
          </div>
          <div className="kpi">
            <span className="label">People</span>
            <span className="value">{items ? totals.members : '—'}</span>
          </div>
        </div>
      </section>
      <section className="panel" style={{ marginTop: 20 }}>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Plan</th>
                <th>Devices</th>
                <th className="hide-sm">Channels</th>
                <th className="hide-sm">People</th>
                <th className="hide-sm">Last data</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.id}>
                  <td>
                    <b>{o.name}</b>
                    <div className="muted small">
                      {o.ownerEmail ?? 'no admin'} · since {dateTime(o.createdAt).split(',')[0]}
                    </div>
                  </td>
                  <td>
                    <span className="pill" style={{ textTransform: 'capitalize' }}>
                      {o.plan}
                    </span>
                    <div className="muted small">{o.retentionDays} days of data</div>
                  </td>
                  <td>
                    {o.devices} <span className="muted small">/ {o.limits.devices}</span>
                  </td>
                  <td className="hide-sm">
                    {o.projects} <span className="muted small">/ {o.limits.projects}</span>
                  </td>
                  <td className="hide-sm">{o.members}</td>
                  <td className="hide-sm">{o.lastDataAt ? ago(o.lastDataAt, now) : <span className="muted">never</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn small" onClick={() => setEditing(o)}>
                      Change plan
                    </button>
                  </td>
                </tr>
              ))}
              {items && !shown.length && (
                <tr>
                  <td colSpan={7} className="muted small">
                    No organizations match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {editing && (
        <PlanModal
          org={editing}
          plans={plans}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast('Plan updated');
            void load();
          }}
        />
      )}
    </>
  );
}

function PlanModal({ org, plans, onClose, onSaved }: { org: PlatformOrg; plans: Plans; onClose: () => void; onSaved: () => void }) {
  const [plan, setPlan] = useState(org.plan);
  const base = plans[plan];
  const [v, setV] = useState({ maxDevices: String(org.limits.devices), maxProjects: String(org.limits.projects), retentionDays: String(org.retentionDays) });
  const [error, setError] = useState<unknown>(null);
  function pick(p: string) {
    setPlan(p);
    const b = plans[p];
    if (b) setV({ maxDevices: String(b.maxDevices), maxProjects: String(b.maxProjects), retentionDays: String(b.retentionDays) });
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('PATCH', `/organizations/${org.id}/plan`, { plan, maxDevices: Number(v.maxDevices), maxProjects: Number(v.maxProjects), retentionDays: Number(v.retentionDays) });
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Plan for ${org.name}`} footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" form="plan-form">Save</button></>}>
      <form id="plan-form" className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          Plan
          <select value={plan} onChange={(e) => pick(e.target.value)}>
            {Object.keys(plans).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <div className="form-row">
          <label className="field">
            Max devices
            <input type="number" min={1} value={v.maxDevices} onChange={(e) => setV({ ...v, maxDevices: e.target.value })} />
          </label>
          <label className="field">
            Max channels
            <input type="number" min={1} value={v.maxProjects} onChange={(e) => setV({ ...v, maxProjects: e.target.value })} />
          </label>
          <label className="field">
            Days of data
            <input type="number" min={1} max={3650} value={v.retentionDays} onChange={(e) => setV({ ...v, retentionDays: e.target.value })} />
          </label>
        </div>
        {base && <p className="muted small">Rules, API keys and webhooks follow the {plan} plan: {base.maxRules} rules, {base.maxApiKeys} keys, {base.maxWebhooks} webhooks.</p>}
      </form>
    </Modal>
  );
}
