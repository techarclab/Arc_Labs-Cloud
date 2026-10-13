import { useCallback, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api, canEdit, Org } from '../api';
import { Alert, AlertStatus, RESOLUTION_LABEL, SeverityPill } from '../components/alerts';
import { ErrorBox, Modal, useNow, usePoll, useToast } from '../components/ui';
import { ago, dateTime } from '../format';
import { useSession } from '../session';

type Filter = 'active' | 'triggered' | 'resolved' | 'all';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'active', label: 'Open' },
  { id: 'triggered', label: 'Needs attention' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

export function AlertsPage() {
  const { orgId = '' } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const { projects } = useSession();
  const nav = useNavigate();
  const now = useNow(30_000);
  const [filter, setFilter] = useState<Filter>('active');
  const [project, setProject] = useState('');
  const [data, setData] = useState<{ items: Alert[]; counts: { triggered: number; acknowledged: number; total: number } } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ organizationId: orgId, limit: '200' });
      if (filter !== 'all') q.set('status', filter);
      if (project) q.set('projectId', project);
      setData(await api('GET', `/alerts?${q}`));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [orgId, filter, project]);
  usePoll(load, 10_000, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p className="sub">Raised by the rules in each channel. Acknowledge to show someone is on it; alerts resolve themselves when the condition clears.</p>
        </div>
      </div>
      <ErrorBox error={error} />
      <section className="panel">
        <div className="panel-head">
          <div className="seg" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
                {f.id === 'triggered' && data?.counts.triggered ? ` (${data.counts.triggered})` : ''}
              </button>
            ))}
          </div>
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Channel" style={{ width: 'auto' }}>
            <option value="">All channels</option>
            {projects[orgId]?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {data && !data.items.length ? (
          <div className="empty">
            <h3>{filter === 'resolved' || filter === 'all' ? 'No alerts yet' : 'All clear'}</h3>
            <p>{canEdit(org?.role) ? 'Rules live in each channel’s Rules tab.' : 'Nothing needs attention right now.'}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Alert</th>
                  <th>Device</th>
                  <th>Status</th>
                  <th className="hide-sm">Started</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => nav(`/o/${orgId}/alerts/${a.id}`)}>
                    <td>
                      <SeverityPill s={a.severity} />
                    </td>
                    <td>
                      <Link to={`/o/${orgId}/alerts/${a.id}`} onClick={(e) => e.stopPropagation()}>
                        <b>{a.ruleName}</b>
                      </Link>
                      <div className="muted small">{a.message}</div>
                    </td>
                    <td>
                      {a.deviceName}
                      <div className="muted small">{a.projectName}</div>
                    </td>
                    <td>
                      <AlertStatus a={a} />
                      {a.status === 'resolved' && a.resolution && <div className="muted small">{RESOLUTION_LABEL[a.resolution]}</div>}
                    </td>
                    <td className="hide-sm muted" title={dateTime(a.triggeredAt)}>
                      {ago(a.triggeredAt, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

interface AlertDetail extends Alert {
  history: { event: string; actor: string; note: string | null; at: string }[];
  notifications: { id: number; kind: 'email' | 'webhook'; recipient: string; status: string; attempts: number; lastError: string | null; sentAt: string | null; nextAttemptAt: string | null; createdAt: string }[];
}

const EVENT_TEXT: Record<string, string> = { triggered: 'Triggered', acknowledged: 'Acknowledged', resolved: 'Resolved', notified: 'Notified' };

export function AlertDetailPage() {
  const { orgId = '', alertId = '' } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const toast = useToast();
  const now = useNow(30_000);
  const [a, setA] = useState<AlertDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [action, setAction] = useState<'acknowledge' | 'resolve' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const edit = canEdit(org?.role);

  const load = useCallback(async () => {
    try {
      setA(await api('GET', `/alerts/${alertId}`));
    } catch (e) {
      setError(e);
    }
  }, [alertId]);
  usePoll(load, 10_000, [load]);

  async function act() {
    if (!action) return;
    setBusy(true);
    try {
      await api('POST', `/alerts/${alertId}/${action}`, { note: note || undefined });
      toast(action === 'acknowledge' ? 'Acknowledged' : 'Resolved');
      setAction(null);
      setNote('');
      setError(null);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="crumbs">
        <Link to={`/o/${orgId}/alerts`}>Alerts</Link> /
      </div>
      <div className="page-head">
        <div>
          <h1>{a?.ruleName ?? 'Alert'}</h1>
          {a && (
            <p className="sub">
              <SeverityPill s={a.severity} /> <AlertStatus a={a} /> · {a.message}
            </p>
          )}
        </div>
        {a && edit && a.status !== 'resolved' && (
          <div className="row">
            {a.status === 'triggered' && (
              <button className="btn primary" onClick={() => setAction('acknowledge')}>
                Acknowledge
              </button>
            )}
            <button className="btn" onClick={() => setAction('resolve')}>
              Resolve
            </button>
          </div>
        )}
      </div>
      <ErrorBox error={error} />
      {a && (
        <div className="detail-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <section className="panel">
              <div className="panel-head">
                <h2>History</h2>
              </div>
              <ol className="timeline">
                {a.history.map((h, i) => (
                  <li key={i} className={h.event}>
                    <b>{EVENT_TEXT[h.event] ?? h.event}</b> <span className="muted">by {h.actor}</span>
                    {h.note && <div className="small">{h.note}</div>}
                    <div className="muted small">{dateTime(h.at)}</div>
                  </li>
                ))}
              </ol>
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>Notifications</h2>
              </div>
              {a.notifications.length ? (
                <div className="table-wrap">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>To</th>
                        <th>Status</th>
                        <th className="hide-sm">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.notifications.map((n) => (
                        <tr key={n.id}>
                          <td>
                            {n.kind === 'email' ? 'Email' : 'Webhook'} · <span className="mono">{n.recipient}</span>
                          </td>
                          <td>
                            <span className={`pill ${n.status === 'failed' ? 'bad' : n.status === 'pending' || n.status === 'skipped' ? 'warn' : ''}`}>{n.status}</span>
                          </td>
                          <td className="hide-sm muted small">
                            {n.status === 'sent' && `sent ${ago(n.sentAt, now)}`}
                            {n.status === 'pending' && `${n.lastError ? `${n.lastError}; ` : ''}next try ${n.nextAttemptAt ? dateTime(n.nextAttemptAt) : 'soon'}`}
                            {(n.status === 'failed' || n.status === 'skipped') && n.lastError}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted small" style={{ padding: '14px 18px' }}>
                  No emails for this rule. Add recipients in the rule, or connect a webhook in Integrations.
                </p>
              )}
            </section>
          </div>
          <section className="panel">
            <div className="panel-body">
              <dl className="kv">
                <dt>Device</dt>
                <dd>
                  <Link to={`/o/${orgId}/p/${a.projectId}/devices/${a.deviceId}`}>{a.deviceName}</Link>
                </dd>
                <dt>Channel</dt>
                <dd>
                  <Link to={`/o/${orgId}/p/${a.projectId}/rules`}>{a.projectName}</Link>
                </dd>
                <dt>Started</dt>
                <dd>{dateTime(a.triggeredAt)}</dd>
                {a.acknowledgedAt && (
                  <>
                    <dt>Acknowledged</dt>
                    <dd>
                      {dateTime(a.acknowledgedAt)}
                      {a.acknowledgedBy && ` by ${a.acknowledgedBy}`}
                    </dd>
                  </>
                )}
                {a.resolvedAt && (
                  <>
                    <dt>Resolved</dt>
                    <dd>
                      {dateTime(a.resolvedAt)} ({a.resolution ? RESOLUTION_LABEL[a.resolution] : ''}
                      {a.resolvedBy ? `, ${a.resolvedBy}` : ''})
                    </dd>
                  </>
                )}
                {a.value !== null && (
                  <>
                    <dt>Value</dt>
                    <dd>{a.value}</dd>
                  </>
                )}
              </dl>
            </div>
          </section>
        </div>
      )}
      <Modal
        open={!!action}
        onClose={() => setAction(null)}
        title={action === 'acknowledge' ? 'Acknowledge alert' : 'Resolve alert'}
        footer={
          <>
            <button className="btn quiet" onClick={() => setAction(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy} onClick={act}>
              {action === 'acknowledge' ? 'Acknowledge' : 'Resolve'}
            </button>
          </>
        }
      >
        <p className="muted small">
          {action === 'acknowledge'
            ? 'Lets your team know someone is handling it. The alert stays open until the condition clears or you resolve it.'
            : 'Closes the alert now. If the condition is still true, a new alert opens after the rule’s quiet period.'}
        </p>
        <label className="field">
          Note <span className="hint">optional, saved in the history</span>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      </Modal>
    </>
  );
}
