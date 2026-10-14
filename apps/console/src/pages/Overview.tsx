import { useCallback, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { api, isAdmin, Org } from '../api';
import { Alert, AlertList } from '../components/alerts';
import { ErrorBox, useNow, usePoll } from '../components/ui';
import { TimeChart } from '../components/viz';

interface Overview {
  devices: { total: number; online: number; offline: number; never_seen: number; inactive: number };
  alerts: { triggered: number; acknowledged: number; critical: number };
  recentAlerts: Alert[];
  activity: { hour: string; messages: number }[];
  projects: { id: string; name: string; description: string; devices: number; online: number }[];
}

/** Organization dashboard: device counts by state, alerts, activity and channel shortcuts. */
export function OverviewPage() {
  const { orgId = '' } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const now = useNow(30_000);
  const load = useCallback(async () => {
    try {
      setData(await api<Overview>('GET', `/organizations/${orgId}/overview`));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [orgId]);
  usePoll(load, 15_000, [orgId]);

  const to = new Date(Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000);
  const from = new Date(to.getTime() - 24 * 3_600_000);
  const d = data?.devices;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{org?.name ?? 'Overview'}</h1>
          <p className="sub">Every device, alert and channel in your organization at a glance.</p>
        </div>
        {isAdmin(org?.role) && (
          <Link className="btn" to={`/setup?org=${orgId}`}>
            New channel
          </Link>
        )}
      </div>
      <ErrorBox error={error} />

      <section className="panel" aria-label="Devices and alerts">
        <div className="kpis">
          <Kpi label="Devices" value={d?.total} />
          <Kpi label="Online" value={d?.online} tone="on" />
          <Kpi label="Offline" value={d?.offline} tone={d?.offline ? 'off' : undefined} />
          <Kpi label="Not seen yet" value={d?.never_seen} />
          <Kpi label="Alerts needing attention" value={data?.alerts.triggered} tone={data?.alerts.triggered ? 'off' : undefined} to={`/o/${orgId}/alerts`} sub={data?.alerts.critical ? `${data.alerts.critical} critical` : undefined} />
          <Kpi label="Acknowledged" value={data?.alerts.acknowledged} to={`/o/${orgId}/alerts`} />
        </div>
      </section>

      <div className="overview-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>Recent alerts</h2>
            <Link to={`/o/${orgId}/alerts`} className="small">
              All alerts
            </Link>
          </div>
          {data && <AlertList orgId={orgId} items={data.recentAlerts} now={now} empty="No alerts yet. Add rules in a channel’s Rules tab." />}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Messages received</h2>
            <span className="muted small">last 24 hours, per hour</span>
          </div>
          <div className="panel-body">
            {data && (
              <TimeChart
                series={[{ label: 'Messages', points: data.activity.map((a) => ({ ts: a.hour, value: a.messages })) }]}
                from={from}
                to={to}
                style="bars"
                gapMs={3_600_000}
                height={180}
              />
            )}
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>Channels</h2>
        </div>
        <div className="channel-cards">
          {data?.projects.map((p) => (
            <Link key={p.id} to={`/o/${orgId}/p/${p.id}`} className="channel-card">
              <b>{p.name}</b>
              {p.description && <span className="muted small">{p.description}</span>}
              <span className="fleet-bar" aria-hidden="true">
                <span style={{ width: `${p.devices ? (p.online / p.devices) * 100 : 0}%` }} />
              </span>
              <span className="small">
                <b>{p.online}</b> <span className="muted">of {p.devices} device{p.devices === 1 ? '' : 's'} online</span>
              </span>
            </Link>
          ))}
          {data && !data.projects.length && <p className="muted small" style={{ padding: 18 }}>No channels yet.</p>}
        </div>
      </section>
    </>
  );
}

function Kpi({ label, value, tone, to, sub }: { label: string; value?: number; tone?: 'on' | 'off'; to?: string; sub?: string }) {
  const body = (
    <>
      <span className="label">{label}</span>
      <span className={`value ${tone ?? ''}`}>{value ?? '—'}</span>
      {sub && <span className="when">{sub}</span>}
    </>
  );
  return to ? (
    <Link to={to} className="kpi">
      {body}
    </Link>
  ) : (
    <div className="kpi">{body}</div>
  );
}
