import { FormEvent, useCallback, useState } from 'react';
import { api } from '../api';
import { ago, dateTime } from '../format';
import { CopyButton, ErrorBox, Modal, useNow, usePoll, useToast } from '../components/ui';
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
      <InvitesSection orgs={items ?? []} />
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

interface Invite {
  id: string;
  label: string;
  organizationId: string | null;
  organizationName: string | null;
  role: string | null;
  maxUses: number;
  usedCount: number;
  /** People currently in the organization because of this code. */
  members?: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  status: 'active' | 'expired' | 'used_up' | 'revoked';
}
const STATUS_LABEL: Record<Invite['status'], string> = { active: 'active', expired: 'expired', used_up: 'used up', revoked: 'revoked' };

/** Invite codes: sign-up stays closed; each batch or customer gets a code with limited uses and an expiry. */
function InvitesSection({ orgs }: { orgs: PlatformOrg[] }) {
  const toast = useToast();
  const [items, setItems] = useState<Invite[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ code: string; label: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Invite[] }>('GET', '/platform/invites')).items);
    } catch (e) {
      setError(e);
    }
  }, []);
  usePoll(load, 60_000, [load]);

  const [revoking, setRevoking] = useState<Invite | null>(null);
  async function revoke(i: Invite, removeMembers: boolean) {
    try {
      const r = await api<{ removedMembers: number }>('POST', `/platform/invites/${i.id}/revoke`, { removeMembers });
      toast(removeMembers ? `Code revoked; ${r.removedMembers} ${r.removedMembers === 1 ? 'person' : 'people'} removed from ${i.organizationName}` : 'Invite code revoked');
      setRevoking(null);
      void load();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 18px' }}>
        <div>
          <h3 style={{ margin: 0 }}>Invite codes</h3>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Anyone 18 or older can sign up alone. Codes put a class or customer into an organization (new or existing accounts, entered at sign-up or with “Join with invite code”), and are the only way for under-18 students to sign up. A code works for a limited number of people until it expires or you revoke it.
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          New invite code
        </button>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Label</th>
              <th>Used</th>
              <th className="hide-sm">Joins</th>
              <th>Expires</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(items ?? []).map((i) => (
              <tr key={i.id} style={i.status !== 'active' ? { opacity: 0.6 } : undefined}>
                <td>
                  <b>{i.label}</b>
                  <div className="muted small">created {dateTime(i.createdAt)}</div>
                </td>
                <td>
                  {i.usedCount} <span className="muted small">/ {i.maxUses}</span>
                </td>
                <td className="hide-sm">{i.organizationName ? `${i.organizationName} (${i.role})` : <span className="muted">own organization</span>}</td>
                <td>{dateTime(i.expiresAt).split(',')[0]}</td>
                <td>
                  <span className={`pill${i.status === 'active' ? ' ok' : ''}`}>{STATUS_LABEL[i.status]}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {(i.status === 'active' || (i.organizationId && (i.members ?? 0) > 0)) && (
                    <button className="btn small quiet danger" onClick={() => setRevoking(i)}>
                      {i.status === 'active' ? 'Revoke' : `Remove ${i.members} ${i.members === 1 ? 'person' : 'people'}`}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {items && !items.length && (
              <tr>
                <td colSpan={6} className="muted small">
                  No invite codes yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && (
        <InviteModal
          orgs={orgs}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            void load();
          }}
        />
      )}
      {created && (
        <Modal open onClose={() => setCreated(null)} title={`Invite code for ${created.label}`} footer={<button className="btn primary" onClick={() => setCreated(null)}>Done</button>}>
          <div className="note">This code is shown only now. ARC Cloud stores just a scrambled version of it. If it is lost, revoke it and create a new one.</div>
          <p style={{ fontSize: 26, fontWeight: 700, letterSpacing: 2, textAlign: 'center', margin: '18px 0' }} className="mono">
            {created.code}
          </p>
          <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
            <CopyButton text={created.code} label="Copy code" />
            <CopyButton text={`${window.location.origin}/?invite=${encodeURIComponent(created.code)}`} label="Copy sign-up link" />
          </div>
          <p className="muted small" style={{ marginTop: 14 }}>
            The sign-up link opens the form with the code filled in. Share it only with the people it is meant for: anyone with the code can create an account
            until it is used up or expires.
          </p>
        </Modal>
      )}
      <Modal open={!!revoking} onClose={() => setRevoking(null)} title={revoking?.status === 'active' ? `Revoke “${revoking?.label}”?` : `Remove the people who joined with “${revoking?.label}”?`}>
        {revoking && (
          <div className="form">
            {revoking.status === 'active' && <p>Nobody can use this code any more.</p>}
            {revoking.organizationId ? (
              <p>
                <b>{revoking.members ?? 0}</b> {revoking.members === 1 ? 'person is' : 'people are'} in <b>{revoking.organizationName}</b> because of this code. You can keep them, or
                remove them too (for example at the end of a course). Their own accounts and organizations stay; they only lose access to {revoking.organizationName}. Admins
                are never removed this way.
              </p>
            ) : (
              <p className="muted">Accounts already created with it stay: each one has its own organization.</p>
            )}
            <div className="row">
              {revoking.status === 'active' && (
                <button className="btn" onClick={() => void revoke(revoking, false)}>
                  {revoking.organizationId && (revoking.members ?? 0) > 0 ? 'Revoke, keep them' : 'Revoke'}
                </button>
              )}
              {revoking.organizationId && (revoking.members ?? 0) > 0 && (
                <button className="btn danger" onClick={() => void revoke(revoking, true)}>
                  {revoking.status === 'active' ? 'Revoke and remove them' : 'Remove them'}
                </button>
              )}
              <button className="btn quiet" onClick={() => setRevoking(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

function InviteModal({ orgs, onClose, onCreated }: { orgs: PlatformOrg[]; onClose: () => void; onCreated: (c: { code: string; label: string }) => void }) {
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState('60');
  const [days, setDays] = useState('14');
  const [orgId, setOrgId] = useState('');
  const [role, setRole] = useState('engineer');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ code: string; label: string }>('POST', '/platform/invites', {
        label: label.trim(),
        maxUses: Number(maxUses),
        expiresInDays: Number(days),
        ...(orgId ? { organizationId: orgId, role } : {}),
      });
      onCreated(r);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="New invite code"
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="invite-form" disabled={busy}>
            Create code
          </button>
        </>
      }
    >
      <form id="invite-form" className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          Label
          <span className="hint">Who it is for, e.g. “Anurag University ECE batch, Nov 2026”.</span>
          <input required maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <div className="form-row">
          <label className="field">
            How many people
            <input type="number" required min={1} max={10000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
          </label>
          <label className="field">
            Valid for (days)
            <input type="number" required min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
        </div>
        <label className="field">
          What the code does
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">Lets people sign up (e.g. under-18 students); each creates their own organization</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                Join {o.name}
              </option>
            ))}
          </select>
        </label>
        {orgId && (
          <label className="field">
            Role in that organization
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="viewer">Viewer: sees dashboards</option>
              <option value="engineer">Engineer: manages devices</option>
              <option value="org_admin">Admin: manages people and settings</option>
            </select>
          </label>
        )}
      </form>
    </Modal>
  );
}
