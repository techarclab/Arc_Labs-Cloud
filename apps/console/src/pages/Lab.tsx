import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, Device, Field, Project, Reading, setTokenOverride } from '../api';
import { ago, num } from '../format';
import { ArcMark, ErrorBox, Status, useNow, usePoll } from '../components/ui';
import { TimeChart } from '../components/viz';
import type { Pt } from '../components/viz';

/** Reads the learner token from the link (#token) once, then removes it from the address bar. */
function takeToken(): string | null {
  const t = window.location.hash.replace(/^#/, '');
  if (t) {
    try {
      sessionStorage.setItem('arc.labToken', t);
    } catch {
      /* ignore */
    }
    history.replaceState(null, '', window.location.pathname);
    return t;
  }
  try {
    return sessionStorage.getItem('arc.labToken');
  } catch {
    return null;
  }
}

function expiry(token: string | null): number | null {
  try {
    const p = JSON.parse(atob(token!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof p.exp === 'number' ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Read-only lab view for ARC LMS learners: one channel's devices, live readings and a chart. */
export function LabPage() {
  const token = useMemo(takeToken, []);
  const exp = expiry(token);
  const now = useNow(10_000);
  const [project, setProject] = useState<Project | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [latest, setLatest] = useState<Reading[]>([]);
  const [metric, setMetric] = useState<string | null>(null);
  const [points, setPoints] = useState<Pt[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setTokenOverride(token);
    return () => setTokenOverride(null);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      const me = await api<{ scope?: { projectIds: string[] | null } }>('GET', '/auth/me');
      const pid = me.scope?.projectIds?.[0];
      if (!pid) throw new Error('This lab link has no channel.');
      const [p, f] = await Promise.all([api<Project>('GET', `/projects/${pid}`), api<{ items: Field[] }>('GET', `/projects/${pid}/fields`)]);
      setProject(p);
      setFields(f.items.filter((x) => x.kind !== 'control'));
    })().catch(setError);
  }, [token]);

  const loadDevices = useCallback(async () => {
    if (!project) return;
    const r = await api<{ items: Device[] }>('GET', `/devices?projectId=${project.id}&limit=200`);
    setDevices(r.items);
    setSelected((s) => s ?? r.items[0]?.id ?? null);
  }, [project]);
  usePoll(() => loadDevices().catch(setError), 15_000, [loadDevices]);

  const loadData = useCallback(async () => {
    if (!selected) return;
    const l = await api<{ items: Reading[] }>('GET', `/devices/${selected}/telemetry/latest`);
    setLatest(l.items);
    const m = metric ?? l.items[0]?.metric ?? null;
    if (!metric && m) setMetric(m);
    if (m) {
      const to = new Date();
      const from = new Date(to.getTime() - 3600e3);
      const s = await api<{ series: Record<string, Pt[]> }>('GET', `/devices/${selected}/telemetry?metric=${m}&from=${from.toISOString()}&to=${to.toISOString()}`);
      setPoints(s.series[m] ?? []);
    }
  }, [selected, metric]);
  usePoll(() => loadData().catch(setError), 10_000, [loadData]);

  const label = (k: string) => fields.find((f) => f.metricKey === k)?.label || k;
  const unit = (k: string) => fields.find((f) => f.metricKey === k)?.unit || '';
  const expired = exp !== null && exp < now;

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 16px' }}>
      <div className="page-head">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <ArcMark />
          <div>
            <h1>{project?.name ?? 'ARC Cloud lab'}</h1>
            <p className="sub">
              Read-only lab view{exp && !expired ? ` · access ends ${new Date(exp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
            </p>
          </div>
        </div>
      </div>
      {!token || expired ? (
        <div className="empty">
          <h3>{expired ? 'This lab link has expired' : 'No lab link'}</h3>
          <p>Open the lab again from ARC LMS to get a fresh link.</p>
        </div>
      ) : (
        <>
          <ErrorBox error={error} />
          <div className="overview-grid" style={{ marginTop: 0, gridTemplateColumns: 'minmax(0, 0.8fr) minmax(0, 1.6fr)' }}>
            <section className="panel">
              <div className="panel-head">
                <h2>Devices</h2>
              </div>
              <ul className="alert-list">
                {devices?.map((d) => (
                  <li key={d.id}>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setSelected(d.id);
                        setMetric(null);
                        setPoints([]);
                      }}
                      style={d.id === selected ? { background: 'var(--accent-soft)' } : undefined}
                    >
                      <span className="alert-main">
                        <b>{d.displayName}</b>
                        <div className="muted small">{d.lastSeenAt ? `last data ${ago(d.lastSeenAt, now)}` : 'no data yet'}</div>
                      </span>
                      <Status c={d.connectivity} />
                    </a>
                  </li>
                ))}
                {devices && !devices.length && <li className="muted small" style={{ padding: 18 }}>No devices in this lab yet.</li>}
              </ul>
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>Latest readings</h2>
              </div>
              <div className="tiles" style={{ borderTop: 0 }}>
                {latest.map((r) => (
                  <button key={r.metric} className="tile" aria-pressed={r.metric === metric} onClick={() => setMetric(r.metric)}>
                    <div className="label">{label(r.metric)}</div>
                    <div className="value">
                      {num(r.value)}
                      {unit(r.metric) && <span className="unit">{unit(r.metric)}</span>}
                    </div>
                    <div className="when">{ago(r.ts, now)}</div>
                  </button>
                ))}
              </div>
              <div className="panel-body">
                {metric ? (
                  <TimeChart series={[{ label: label(metric), points, unit: unit(metric) }]} from={new Date(now - 3600e3)} to={new Date(now)} height={220} gapMs={Math.max(60_000, ((devices?.find((d) => d.id === selected)?.expectedIntervalSeconds ?? 30) * 3) * 1000)} />
                ) : (
                  <p className="muted small">Readings appear here once the device sends data.</p>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
