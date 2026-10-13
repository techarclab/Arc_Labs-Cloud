import { FormEvent, useCallback, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, isAdmin, Org, Project } from '../api';
import { ago, dateTime } from '../format';
import { CopyButton, ErrorBox, Modal, useNow, usePoll, useToast } from '../components/ui';
import { useSession } from '../session';

interface ApiKey {
  id: string;
  name: string;
  kind: 'api_key' | 'service_account';
  prefix: string;
  role: 'viewer' | 'engineer';
  projectIds: string[] | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
}
interface NewKey extends ApiKey {
  secret: string;
  usage: { header?: string; tokenUrl?: string; clientId?: string; clientSecret?: string; grantType?: string };
}
interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  secret?: string;
}
interface Delivery {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  nextAttemptAt: string | null;
}
interface LmsLink {
  id: string;
  projectId: string;
  projectName?: string;
  lmsRef: string;
  title: string;
  deviceIds: string[] | null;
  maxTokenMinutes: number;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

const EVENT_TEXT: Record<string, string> = {
  'alert.triggered': 'Alert raised',
  'alert.acknowledged': 'Alert acknowledged',
  'alert.resolved': 'Alert resolved',
  'device.connected': 'Device connected',
  'device.disconnected': 'Device disconnected',
  'device.created': 'Device added',
  'device.revoked': 'Device revoked',
  'command.updated': 'Command status changed',
  'firmware.rollout_updated': 'Firmware rollout progress',
  'telemetry.received': 'Every reading (high volume)',
};

/** API keys, service accounts, webhooks and ARC LMS links for one organization (admins only). */
export function IntegrationsPage() {
  const { orgId = '' } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const { projects, refreshProjects } = useSession();
  const channels = projects[orgId] ?? [];
  if (!isAdmin(org?.role)) {
    return (
      <div className="empty">
        <h3>Admins only</h3>
        <p>Ask an admin of {org?.name ?? 'this organization'} to manage API keys, webhooks and ARC LMS links.</p>
      </div>
    );
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <p className="sub">Connect other systems to ARC Cloud: scripts and servers (API keys), automatic notifications (webhooks) and ARC LMS lab sessions.</p>
        </div>
      </div>
      <div className="stack">
        <KeysSection orgId={orgId} channels={channels} />
        <WebhooksSection orgId={orgId} />
        <LmsSection orgId={orgId} channels={channels} reloadChannels={() => refreshProjects(orgId)} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------
function KeysSection({ orgId, channels }: { orgId: string; channels: Project[] }) {
  const toast = useToast();
  const now = useNow(60_000);
  const [items, setItems] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<NewKey | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: ApiKey[] }>('GET', `/api-keys?organizationId=${orgId}`)).items);
    } catch (e) {
      setError(e);
    }
  }, [orgId]);
  usePoll(load, 60_000, [load]);

  async function revoke(k: ApiKey) {
    if (!confirm(`Revoke “${k.name}”? Anything using it stops working immediately.`)) return;
    try {
      await api('DELETE', `/api-keys/${k.id}`);
      toast('Key revoked');
      void load();
    } catch (e) {
      setError(e);
    }
  }
  const scope = (k: ApiKey) => (k.projectIds?.length ? k.projectIds.map((id) => channels.find((c) => c.id === id)?.name ?? 'channel').join(', ') : 'All channels');

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>API keys &amp; service accounts</h2>
          <p className="muted small">An <b>API key</b> is sent as a Bearer token by scripts. A <b>service account</b> exchanges its secret for short-lived tokens (OAuth2 client credentials), e.g. for the ARC LMS server.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          New key
        </button>
      </div>
      <ErrorBox error={error} />
      {items && !items.length ? (
        <p className="muted small" style={{ padding: '14px 18px' }}>No keys yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Access</th>
                <th className="hide-sm">Last used</th>
                <th className="hide-sm">Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items?.map((k) => (
                <tr key={k.id} style={k.revokedAt ? { opacity: 0.55 } : undefined}>
                  <td>
                    <b>{k.name}</b> <span className="pill">{k.kind === 'api_key' ? 'API key' : 'Service account'}</span>
                    <div className="muted small mono">{k.prefix}…</div>
                  </td>
                  <td>
                    {k.role === 'engineer' ? 'Read & write' : 'Read only'}
                    <div className="muted small">{scope(k)}</div>
                  </td>
                  <td className="hide-sm">{k.lastUsedAt ? ago(k.lastUsedAt, now) : <span className="muted">never</span>}</td>
                  <td className="hide-sm">{k.revokedAt ? <span className="pill bad">revoked</span> : k.expiresAt ? dateTime(k.expiresAt) : <span className="muted">never</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {!k.revokedAt && (
                      <button className="btn small quiet danger" onClick={() => revoke(k)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewKeyModal
          orgId={orgId}
          channels={channels}
          onClose={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            setCreated(k);
            void load();
          }}
        />
      )}
      <Modal
        open={!!created}
        onClose={() => setCreated(null)}
        title="Copy the secret now"
        wide
        footer={
          <button className="btn primary" onClick={() => setCreated(null)}>
            I’ve saved it
          </button>
        }
      >
        {created && (
          <div className="form">
            <p className="small">This is the only time the secret is shown. Store it in your server’s secret settings, never in a web page or app.</p>
            {created.kind === 'api_key' ? (
              <>
                <div className="key-box">
                  <code>{created.secret}</code>
                  <CopyButton text={created.secret} />
                </div>
                <pre className="code">{`curl -H "Authorization: Bearer ${created.secret}" \\\n  ${API_HINT}/api/v1/devices?projectId=…`}</pre>
              </>
            ) : (
              <dl className="secret">
                <dt>Token URL</dt>
                <dd>{created.usage.tokenUrl}</dd>
                <dt>Client ID</dt>
                <dd>
                  {created.usage.clientId} <CopyButton text={created.usage.clientId ?? ''} />
                </dd>
                <dt>Client secret</dt>
                <dd>
                  {created.secret} <CopyButton text={created.secret} />
                </dd>
                <dt>Grant type</dt>
                <dd>client_credentials</dd>
              </dl>
            )}
          </div>
        )}
      </Modal>
    </section>
  );
}

const API_HINT = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') || window.location.origin;

function NewKeyModal({ orgId, channels, onClose, onCreated }: { orgId: string; channels: Project[]; onClose: () => void; onCreated: (k: NewKey) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'api_key' | 'service_account'>('api_key');
  const [role, setRole] = useState<'viewer' | 'engineer'>('viewer');
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [expires, setExpires] = useState('365');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const k = await api<NewKey>('POST', '/api-keys', {
        organizationId: orgId,
        name,
        kind,
        role,
        projectIds: all ? null : picked,
        expiresInDays: expires ? Number(expires) : null,
      });
      onCreated(k);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="New key"
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="key-form" disabled={busy || (!all && !picked.length)}>
            Create
          </button>
        </>
      }
    >
      <form id="key-form" className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          Name <span className="hint">what will use it, e.g. “Reporting script”</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>
        <div className="form-row">
          <label className="field">
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="api_key">API key (Bearer token)</option>
              <option value="service_account">Service account (OAuth2 client credentials)</option>
            </select>
          </label>
          <label className="field">
            Access
            <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="viewer">Read only</option>
              <option value="engineer">Read &amp; write (devices, controls, commands)</option>
            </select>
          </label>
          <label className="field">
            Expires
            <select value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="30">in 30 days</option>
              <option value="90">in 90 days</option>
              <option value="365">in 1 year</option>
              <option value="">never</option>
            </select>
          </label>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All channels
          </label>
          {!all && (
            <div className="checks" style={{ marginTop: 8 }}>
              {channels.map((c) => (
                <label key={c.id}>
                  <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))} />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------
function WebhooksSection({ orgId }: { orgId: string }) {
  const toast = useToast();
  const now = useNow(30_000);
  const [items, setItems] = useState<Webhook[] | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Webhook[]; events: string[] }>('GET', `/webhooks?organizationId=${orgId}`);
      setItems(r.items);
      setEvents(r.events);
    } catch (e) {
      setError(e);
    }
  }, [orgId]);
  usePoll(load, 20_000, [load]);

  async function patch(w: Webhook, body: Partial<Webhook>, msg: string) {
    try {
      await api('PATCH', `/webhooks/${w.id}`, body);
      toast(msg);
      void load();
    } catch (e) {
      setError(e);
    }
  }
  async function test(w: Webhook) {
    try {
      await api('POST', `/webhooks/${w.id}/test`);
      toast('Test event queued; check Deliveries in a few seconds');
    } catch (e) {
      setError(e);
    }
  }
  async function remove(w: Webhook) {
    if (!confirm(`Delete the webhook “${w.name}”?`)) return;
    try {
      await api('DELETE', `/webhooks/${w.id}`);
      toast('Webhook deleted');
      void load();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Webhooks</h2>
          <p className="muted small">ARC Cloud POSTs a signed JSON event to your URL (header <code>X-ARC-Signature</code>, HMAC-SHA256) and retries with back-off if it fails.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          New webhook
        </button>
      </div>
      <ErrorBox error={error} />
      {items && !items.length ? (
        <p className="muted small" style={{ padding: '14px 18px' }}>No webhooks yet. Use one to send alerts to Slack, a ticketing tool or your own server.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Webhook</th>
                <th className="hide-sm">Events</th>
                <th>Health</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items?.map((w) => (
                <tr key={w.id} style={w.enabled ? undefined : { opacity: 0.6 }}>
                  <td>
                    <b>{w.name}</b> {!w.enabled && <span className="pill">off</span>}
                    <div className="muted small mono" style={{ overflowWrap: 'anywhere' }}>{w.url}</div>
                  </td>
                  <td className="hide-sm small">{w.events.map((e) => EVENT_TEXT[e] ?? e).join(', ')}</td>
                  <td className="small">
                    {w.consecutiveFailures > 0 ? (
                      <span className="pill bad">{w.consecutiveFailures} failed in a row</span>
                    ) : w.lastSuccessAt ? (
                      <span className="pill ok">delivered {ago(w.lastSuccessAt, now)}</span>
                    ) : (
                      <span className="muted">nothing sent yet</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn small quiet" onClick={() => test(w)}>
                      Test
                    </button>
                    <button className="btn small quiet" onClick={() => setLog(w)}>
                      Deliveries
                    </button>
                    <button className="btn small quiet" onClick={() => patch(w, { enabled: !w.enabled }, w.enabled ? 'Webhook turned off' : 'Webhook turned on')}>
                      {w.enabled ? 'Turn off' : 'Turn on'}
                    </button>
                    <button className="btn small quiet" onClick={() => setEditing(w)}>
                      Edit
                    </button>
                    <button className="btn small quiet danger" onClick={() => remove(w)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <WebhookModal
          orgId={orgId}
          hook={editing === 'new' ? null : editing}
          events={events}
          onClose={() => setEditing(null)}
          onSaved={(w) => {
            setEditing(null);
            if (w.secret) setSecret(w.secret);
            else toast('Webhook saved');
            void load();
          }}
        />
      )}
      <Modal open={!!secret} onClose={() => setSecret(null)} title="Signing secret" footer={<button className="btn primary" onClick={() => setSecret(null)}>I’ve saved it</button>}>
        <div className="form">
          <p className="small">Use this secret to check the <code>X-ARC-Signature</code> header on each request. It’s shown only once.</p>
          <div className="key-box">
            <code>{secret}</code>
            <CopyButton text={secret ?? ''} />
          </div>
        </div>
      </Modal>
      {log && <DeliveriesModal hook={log} onClose={() => setLog(null)} />}
    </section>
  );
}

function WebhookModal({ orgId, hook, events, onClose, onSaved }: { orgId: string; hook: Webhook | null; events: string[]; onClose: () => void; onSaved: (w: Webhook) => void }) {
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? 'https://');
  const [picked, setPicked] = useState<string[]>(hook?.events ?? ['alert.triggered', 'alert.resolved']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const w = hook
        ? await api<Webhook>('PATCH', `/webhooks/${hook.id}`, { name, url, events: picked })
        : await api<Webhook>('POST', '/webhooks', { organizationId: orgId, name, url, events: picked, enabled: true });
      onSaved(w);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={hook ? `Edit “${hook.name}”` : 'New webhook'}
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="hook-form" disabled={busy || !picked.length}>
            Save
          </button>
        </>
      }
    >
      <form id="hook-form" className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Ops alerts" />
        </label>
        <label className="field">
          URL <span className="hint">must be a public https:// address</span>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required pattern="https://.+" />
        </label>
        <div className="field">
          Send these events
          <div className="checks" style={{ marginTop: 6 }}>
            {events.map((ev) => (
              <label key={ev}>
                <input type="checkbox" checked={picked.includes(ev)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, ev] : p.filter((x) => x !== ev)))} />
                {EVENT_TEXT[ev] ?? ev}
              </label>
            ))}
          </div>
        </div>
      </form>
    </Modal>
  );
}

function DeliveriesModal({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const [items, setItems] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const now = useNow(10_000);
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Delivery[] }>('GET', `/webhooks/${hook.id}/deliveries?limit=50`)).items);
    } catch (e) {
      setError(e);
    }
  }, [hook.id]);
  usePoll(load, 5_000, [load]);
  return (
    <Modal open wide onClose={onClose} title={`Deliveries · ${hook.name}`} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <ErrorBox error={error} />
      {items && !items.length ? (
        <p className="muted small">Nothing sent yet. Click Test to send a sample event.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {items?.map((d) => (
                <tr key={d.id}>
                  <td>
                    {EVENT_TEXT[d.eventType] ?? d.eventType}
                    <div className="muted small">{ago(d.createdAt, now)}</div>
                  </td>
                  <td>
                    <span className={`pill ${d.status === 'sent' ? 'ok' : d.status === 'failed' ? 'bad' : 'warn'}`}>{d.status}</span>
                  </td>
                  <td className="small muted">
                    {d.responseCode ? `HTTP ${d.responseCode} · ` : ''}
                    {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                    {d.lastError ? ` · ${d.lastError}` : ''}
                    {d.nextAttemptAt ? ` · next try ${dateTime(d.nextAttemptAt)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------------------------
function LmsSection({ orgId, channels }: { orgId: string; channels: Project[]; reloadChannels: () => unknown }) {
  const toast = useToast();
  const [items, setItems] = useState<LmsLink[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [trial, setTrial] = useState<{ link: LmsLink; url: string | null; token: string; minutes: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: LmsLink[] }>('GET', `/lms/links?organizationId=${orgId}`)).items);
    } catch (e) {
      setError(e);
    }
  }, [orgId]);
  usePoll(load, 60_000, [load]);

  async function revoke(l: LmsLink) {
    if (!confirm(`Revoke the ARC LMS link “${l.title}”? Learner links stop working.`)) return;
    try {
      await api('DELETE', `/lms/links/${l.id}`);
      toast('Link revoked');
      void load();
    } catch (e) {
      setError(e);
    }
  }
  async function tryIt(l: LmsLink) {
    try {
      const r = await api<{ accessToken: string; viewerUrl: string | null; expiresIn: number }>('POST', `/lms/links/${l.id}/learner-tokens`, { learnerRef: 'admin-preview', minutes: 30 });
      const url = r.viewerUrl ?? `${window.location.origin}/lab#${r.accessToken}`;
      setTrial({ link: l, url, token: r.accessToken, minutes: Math.round(r.expiresIn / 60) });
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>ARC LMS</h2>
          <p className="muted small">
            Link an ARC LMS course or lab to a channel. The ARC LMS server (using a service account) asks for a short-lived, read-only learner link; learners never see device passwords.
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={!channels.length}>
          Link a lab
        </button>
      </div>
      <ErrorBox error={error} />
      {items && !items.length ? (
        <p className="muted small" style={{ padding: '14px 18px' }}>No labs linked yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Lab</th>
                <th>Channel</th>
                <th className="hide-sm">Learner access</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items?.map((l) => (
                <tr key={l.id} style={l.revokedAt ? { opacity: 0.55 } : undefined}>
                  <td>
                    <b>{l.title}</b>
                    <div className="muted small mono">{l.lmsRef}</div>
                  </td>
                  <td>
                    {l.projectName}
                    <div className="muted small">{l.deviceIds?.length ? `${l.deviceIds.length} device(s)` : 'all devices'}</div>
                  </td>
                  <td className="hide-sm small">
                    up to {l.maxTokenMinutes} min per learner
                    {l.expiresAt && <div className="muted">link ends {dateTime(l.expiresAt)}</div>}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {l.revokedAt ? (
                      <span className="pill bad">revoked</span>
                    ) : (
                      <>
                        <button className="btn small quiet" onClick={() => tryIt(l)}>
                          Preview as learner
                        </button>
                        <button className="btn small quiet danger" onClick={() => revoke(l)}>
                          Revoke
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <LmsModal
          orgId={orgId}
          channels={channels}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            toast('Lab linked');
            void load();
          }}
        />
      )}
      <Modal open={!!trial} onClose={() => setTrial(null)} title="Learner preview link" footer={<button className="btn primary" onClick={() => setTrial(null)}>Done</button>}>
        {trial && (
          <div className="form">
            <p className="small">
              This is what ARC LMS gives a learner: a read-only view of “{trial.link.title}”, valid for {trial.minutes} minutes.
            </p>
            {trial.url && (
              <div className="key-box">
                <a href={trial.url} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>
                  Open the learner view
                </a>
                <CopyButton text={trial.url} label="Copy link" />
              </div>
            )}
            <p className="muted small">
              ARC LMS calls <code>POST /api/v1/lms/links/{trial.link.id}/learner-tokens</code> with its service-account token. See <code>docs/integrations/arc-lms.md</code>.
            </p>
          </div>
        )}
      </Modal>
    </section>
  );
}

function LmsModal({ orgId, channels, onClose, onSaved }: { orgId: string; channels: Project[]; onClose: () => void; onSaved: () => void }) {
  const [projectId, setProjectId] = useState(channels[0]?.id ?? '');
  const [lmsRef, setLmsRef] = useState('');
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState('240');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/lms/links', { projectId, lmsRef, title, maxTokenMinutes: Number(minutes) });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  void orgId;
  return (
    <Modal
      open
      onClose={onClose}
      title="Link an ARC LMS lab"
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="lms-form" disabled={busy}>
            Link
          </button>
        </>
      }
    >
      <form id="lms-form" className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          Lab title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} placeholder="IoT Basics — Lab 3: Temperature logging" />
        </label>
        <label className="field">
          ARC LMS reference <span className="hint">the course/lab ID in ARC LMS (letters, digits, . _ / : -)</span>
          <input value={lmsRef} onChange={(e) => setLmsRef(e.target.value)} required maxLength={120} pattern="[A-Za-z0-9_./:\-]+" placeholder="course-iot101/lab-3" />
        </label>
        <div className="form-row">
          <label className="field">
            Channel
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Learner link lasts up to
            <select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
              <option value="60">1 hour</option>
              <option value="120">2 hours</option>
              <option value="240">4 hours</option>
              <option value="480">8 hours</option>
              <option value="1440">1 day</option>
            </select>
          </label>
        </div>
      </form>
    </Modal>
  );
}
