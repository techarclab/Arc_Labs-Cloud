import { FormEvent, useCallback, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, isAdmin, Org } from '../api';
import { num } from '../format';
import { ErrorBox, usePoll, useToast } from '../components/ui';
import { TimeChart } from '../components/viz';

interface Usage {
  plan: string;
  retentionDays: number;
  limits: Record<'devices' | 'projects' | 'rules' | 'apiKeys' | 'webhooks', number>;
  used: Record<'devices' | 'projects' | 'rules' | 'apiKeys' | 'webhooks', number>;
  messagesPerDay: { day: string; messages: number; measurements: number }[];
  topDevices: { deviceId: string; name: string; projectName: string; messages: number }[];
  alertsBySeverity30d: Record<string, number>;
  rejected7d: number;
  plans: Record<string, { retentionDays: number }>;
}

const LIMIT_LABEL = { devices: 'Devices', projects: 'Channels', rules: 'Alert rules', apiKeys: 'API keys', webhooks: 'Webhooks' } as const;

/** Plan limits, usage, data retention and simple analytics for one organization. */
export function UsagePage() {
  const { orgId = '' } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const toast = useToast();
  const [u, setU] = useState<Usage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [days, setDays] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<Usage>('GET', `/organizations/${orgId}/usage`);
      setU(r);
      setDays((d) => d || String(r.retentionDays));
    } catch (e) {
      setError(e);
    }
  }, [orgId]);
  usePoll(load, 60_000, [load]);

  async function saveRetention(e: FormEvent) {
    e.preventDefault();
    try {
      await api('PATCH', `/organizations/${orgId}/settings`, { retentionDays: Number(days) });
      toast('Retention saved. Older readings are removed overnight.');
      void load();
    } catch (err) {
      setError(err);
    }
  }

  const to = new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000);
  const from = new Date(to.getTime() - 30 * 86_400_000);
  const cap = u ? (u.plans[u.plan]?.retentionDays ?? 3650) : 3650;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Usage &amp; limits</h1>
          <p className="sub">
            {u ? (
              <>
                <b style={{ textTransform: 'capitalize' }}>{u.plan}</b> plan · readings kept for {u.retentionDays} days
              </>
            ) : (
              'Plan, limits and how much data your devices send.'
            )}
          </p>
        </div>
      </div>
      <ErrorBox error={error} />
      {u && (
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Limits</h2>
              <span className="muted small">ARC LABS sets your plan’s limits. Contact us to raise them.</span>
            </div>
            <div className="table-wrap">
              <table className="grid">
                <tbody>
                  {(Object.keys(LIMIT_LABEL) as (keyof typeof LIMIT_LABEL)[]).map((k) => {
                    const pct = u.limits[k] ? Math.min(100, (u.used[k] / u.limits[k]) * 100) : 0;
                    return (
                      <tr key={k}>
                        <td style={{ width: '30%' }}>{LIMIT_LABEL[k]}</td>
                        <td>
                          <div className={`progress ${pct >= 90 ? 'over' : ''}`}>
                            <span style={{ width: `${pct}%` }} />
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {u.used[k]} <span className="muted">of {u.limits[k]}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="overview-grid" style={{ marginTop: 0 }}>
            <section className="panel">
              <div className="panel-head">
                <h2>Messages per day</h2>
                <span className="muted small">last 30 days</span>
              </div>
              <div className="panel-body">
                <TimeChart series={[{ label: 'Messages', points: u.messagesPerDay.map((d) => ({ ts: d.day, value: d.messages })) }]} from={from} to={to} style="bars" gapMs={86_400_000} height={180} />
                <p className="muted small" style={{ marginTop: 8 }}>
                  {num(u.messagesPerDay.reduce((a, d) => a + d.messages, 0))} messages · {num(u.rejected7d)} rejected in the last 7 days
                </p>
              </div>
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>Busiest devices</h2>
                <span className="muted small">last 7 days</span>
              </div>
              {u.topDevices.length ? (
                <div className="table-wrap">
                  <table className="grid">
                    <tbody>
                      {u.topDevices.map((d) => (
                        <tr key={d.deviceId}>
                          <td>
                            {d.name}
                            <div className="muted small">{d.projectName}</div>
                          </td>
                          <td style={{ textAlign: 'right' }}>{num(d.messages)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted small" style={{ padding: '14px 18px' }}>No data in the last 7 days.</p>
              )}
            </section>
          </div>

          <section className="panel">
            <div className="panel-head">
              <h2>Data retention</h2>
              <span className="muted small">
                Alerts in the last 30 days: {u.alertsBySeverity30d.critical ?? 0} critical, {u.alertsBySeverity30d.warning ?? 0} warning, {u.alertsBySeverity30d.info ?? 0} info
              </span>
            </div>
            <form className="panel-body form" onSubmit={saveRetention} style={{ maxWidth: 520 }}>
              <label className="field">
                Keep device readings for <span className="hint">days (your plan allows up to {cap})</span>
                <input type="number" min={1} max={cap} value={days} onChange={(e) => setDays(e.target.value)} disabled={!isAdmin(org?.role)} required />
              </label>
              {isAdmin(org?.role) && (
                <div>
                  <button className="btn primary">Save</button>
                </div>
              )}
            </form>
          </section>
        </div>
      )}
    </>
  );
}
