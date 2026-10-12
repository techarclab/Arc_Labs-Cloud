import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { api, canEdit, Control, Credentials, Device, downloadAuthed, isAdmin, MetricDef, Org, Reading } from '../api';
import { SliderWidget, SwitchWidget } from '../components/widgets';
import { Chart, Point } from '../components/Chart';
import { CredentialsDialog } from '../components/Credentials';
import { ErrorBox, Lifecycle, LIFECYCLE_TEXT, Modal, Status, Strip, useNow, usePoll, useToast } from '../components/ui';
import { ago, dateTime, metricLabel, num } from '../format';
import { useSession } from '../session';

const RANGES = {
  '1h': { ms: 3600e3, bucket: '1m', label: '1 hour' },
  '6h': { ms: 6 * 3600e3, bucket: '5m', label: '6 hours' },
  '24h': { ms: 24 * 3600e3, bucket: '15m', label: '24 hours' },
  '7d': { ms: 7 * 86400e3, bucket: '1h', label: '7 days' },
} as const;
type RangeKey = keyof typeof RANGES;
const BUCKET_MS: Record<string, number> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3 };

const EVENT_TEXT: Record<string, string> = {
  provisioned: 'Registered',
  first_message: 'First data received',
  connected: 'Connected',
  disconnected: 'Disconnected',
  credentials_rotated: 'Password replaced',
  revoked: 'Revoked',
  lifecycle_changed: 'Status changed',
  firmware_changed: 'Firmware changed',
};

export function DeviceDetail() {
  const { orgId = '', projectId = '', deviceId = '' } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const { projects } = useSession();
  const project = projects[orgId]?.find((p) => p.id === projectId);
  const now = useNow();
  const toast = useToast();

  const [device, setDevice] = useState<Device | null>(null);
  const [latest, setLatest] = useState<Reading[]>([]);
  const [defs, setDefs] = useState<MetricDef[]>([]);
  const [metric, setMetric] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>('1h');
  const [series, setSeries] = useState<{ points: Point[]; from: Date; to: Date } | null>(null);
  const [strip, setStrip] = useState<number[] | null>(null);
  const [events, setEvents] = useState<{ type: string; time: string; details: any }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [newCreds, setNewCreds] = useState<{ device: Device; credentials: Credentials } | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<null | 'rotate' | 'revoke' | 'suspend'>(null);
  const [controls, setControls] = useState<Control[]>([]);

  const load = useCallback(async () => {
    try {
      const [d, l, ev, c] = await Promise.all([
        api<Device>('GET', `/devices/${deviceId}`),
        api<{ items: Reading[] }>('GET', `/devices/${deviceId}/telemetry/latest`),
        api('GET', `/devices/${deviceId}/events?limit=15`),
        api<{ items: Control[] }>('GET', `/devices/${deviceId}/controls`),
      ]);
      setDevice(d);
      setLatest(l.items);
      setEvents(ev.items);
      setControls(c.items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [deviceId]);
  usePoll(load, 5000, [deviceId]);

  useEffect(() => {
    api<{ items: MetricDef[] }>('GET', `/projects/${projectId}/metric-definitions`)
      .then((r) => setDefs(r.items))
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    if (!metric && latest.length) setMetric(latest[0].metric);
  }, [latest, metric]);

  const loadSeries = useCallback(async () => {
    if (!metric) return;
    const to = new Date();
    const r = RANGES[range];
    const from = new Date(to.getTime() - r.ms);
    const q = `metric=${metric}&from=${from.toISOString()}&to=${to.toISOString()}`;
    const res = await api('GET', `/devices/${deviceId}/telemetry?${q}${range === '1h' ? '' : `&bucket=${r.bucket}&agg=avg`}`);
    setSeries({ points: res.series[metric] ?? [], from, to });
  }, [deviceId, metric, range]);
  usePoll(() => loadSeries().catch(() => undefined), 10_000, [loadSeries]);

  const loadStrip = useCallback(async () => {
    const m = latest[0]?.metric;
    if (!m) return setStrip(new Array(60).fill(0));
    const to = new Date();
    const from = new Date(to.getTime() - 60 * 60e3);
    from.setSeconds(0, 0);
    const r = await api('GET', `/devices/${deviceId}/telemetry?metric=${m}&bucket=1m&agg=count&from=${from.toISOString()}&to=${to.toISOString()}`);
    const counts = new Array(60).fill(0);
    for (const p of r.series[m] ?? []) {
      const i = Math.floor((new Date(p.ts).getTime() - from.getTime()) / 60e3);
      if (i >= 0 && i < 60) counts[i] = p.value;
    }
    setStrip(counts);
  }, [deviceId, latest[0]?.metric]); // eslint-disable-line react-hooks/exhaustive-deps
  usePoll(() => loadStrip().catch(() => undefined), 30_000, [loadStrip]);

  async function setControl(field: string, value: number) {
    setControls((cs) => [...cs.filter((c) => c.field !== field), { field, value, updatedAt: new Date().toISOString() }]);
    try {
      const r = await api('POST', `/devices/${deviceId}/controls`, { field, value });
      toast(r.pushedOverMqtt ? `${field} set to ${r.value}` : `${field} saved. The device gets it the next time it checks in.`);
    } catch (e) {
      setError(e);
      void load();
    }
  }

  async function lifecycle(status: string) {
    try {
      const d = await api<Device>('POST', `/devices/${deviceId}/lifecycle`, { status });
      setDevice(d);
      toast(`${d.displayName}: ${LIFECYCLE_TEXT[status]?.toLowerCase() ?? status}`);
      void load();
    } catch (e) {
      setError(e);
    }
  }

  const unit = metric ? metricLabel(metric, defs).unit : '';
  const def = defs.find((d) => d.metricKey === metric);
  const limits = useMemo(() => (def ? { min: def.minValue, max: def.maxValue } : undefined), [def]);

  if (!device) {
    return error ? (
      <div className="empty">
        <h3>Couldn’t open this device</h3>
        <ErrorBox error={error} />
        <Link to={`/o/${orgId}/p/${projectId}`}>Back to devices</Link>
      </div>
    ) : (
      <div className="empty">Loading…</div>
    );
  }

  const dead = device.lifecycleStatus === 'revoked' || device.lifecycleStatus === 'retired';
  const hits = strip?.filter((c) => c > 0).length ?? 0;

  return (
    <>
      <div className="crumbs">
        <Link to={`/o/${orgId}/p/${projectId}`}>{project?.name ?? 'Devices'}</Link> / {device.displayName}
      </div>
      <div className="page-head">
        <div>
          <h1>{device.displayName}</h1>
          <div className="row" style={{ marginTop: 10, gap: 14 }}>
            <Status c={device.connectivity} />
            <Lifecycle s={device.lifecycleStatus} />
            <span className="muted">Last seen {ago(device.lastSeenAt, now)}</span>
          </div>
        </div>
        {canEdit(org?.role) && !dead && (
          <div className="row">
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="btn" onClick={() => setConfirm('rotate')}>
              Replace password
            </button>
          </div>
        )}
      </div>

      <ErrorBox error={error} />

      <div className="detail-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          <section className="panel">
            <div className="panel-head">
              <h2>Last hour</h2>
              <span className="muted small">
                Reported in {hits} of 60 minutes, expected every {device.expectedIntervalSeconds < 60 ? `${device.expectedIntervalSeconds}s` : `${Math.round(device.expectedIntervalSeconds / 60)} min`}
              </span>
            </div>
            <div className="panel-body">
              {strip ? <Strip counts={strip} expected={60 / device.expectedIntervalSeconds} size="big" label="Messages per minute, last hour" /> : <div style={{ height: 44 }} />}
              <div className="strip-axis">
                <span>60 min ago</span>
                <span>30 min ago</span>
                <span>now</span>
              </div>
            </div>
            {latest.length > 0 && (
              <div className="tiles">
                {latest.map((r) => {
                  const m = metricLabel(r.metric, defs);
                  return (
                    <button key={r.metric} className="tile" aria-pressed={metric === r.metric} onClick={() => setMetric(r.metric)}>
                      <div className="label">{m.label}</div>
                      <div className="value">
                        {num(r.value)}
                        {m.unit && <span className="unit">{m.unit}</span>}
                      </div>
                      <div className="when">{ago(r.ts, now)}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>{metric ? metricLabel(metric, defs).label : 'Readings'}</h2>
              <div className="seg" role="group" aria-label="Time range">
                {(Object.keys(RANGES) as RangeKey[]).map((k) => (
                  <button key={k} aria-pressed={range === k} onClick={() => setRange(k)}>
                    {k}
                  </button>
                ))}
              </div>
            </div>
            <div className="panel-body">
              {latest.length === 0 ? (
                <div className="empty">
                  <h3>No readings yet</h3>
                  <p>Once this device sends data it will appear here within a few seconds.</p>
                </div>
              ) : series ? (
                <Chart
                  points={series.points}
                  from={series.from}
                  to={series.to}
                  unit={unit}
                  gapMs={range === '1h' ? Math.max(device.expectedIntervalSeconds * 3000, 60e3) : BUCKET_MS[RANGES[range].bucket] * 2.5}
                  limits={limits}
                />
              ) : (
                <div style={{ height: 260 }} />
              )}
              {range !== '1h' && <p className="small muted" style={{ marginTop: 8 }}>Averaged over {RANGES[range].bucket.replace('m', ' min').replace('h', ' hour')} periods.</p>}
            </div>
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {defs.some((d) => d.kind === 'control') && (
            <section className="panel">
              <div className="panel-head">
                <h2>Controls</h2>
              </div>
              <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {defs
                  .filter((d) => d.kind === 'control')
                  .map((f) => {
                    const v = controls.find((c) => c.field === f.metricKey)?.value ?? null;
                    const disabled = !canEdit(org?.role) || dead;
                    return (
                      <div key={f.metricKey}>
                        <div className="small muted" style={{ marginBottom: 6 }}>
                          {f.label}
                        </div>
                        {f.minValue === 0 && f.maxValue === 1 ? (
                          <SwitchWidget label={f.label} value={v} onValue={1} offValue={0} disabled={disabled} onChange={(x) => setControl(f.metricKey, x)} />
                        ) : (
                          <SliderWidget label={f.label} value={v} min={f.minValue ?? 0} max={f.maxValue ?? 100} step={f.step ?? 1} field={f} disabled={disabled} onCommit={(x) => setControl(f.metricKey, x)} />
                        )}
                      </div>
                    );
                  })}
              </div>
            </section>
          )}
          <section className="panel">
            <div className="panel-head">
              <h2>Details</h2>
              <button
                className="btn small"
                onClick={() =>
                  downloadAuthed(`/api/v1/channels/${projectId}/feeds.csv?device=${deviceId}&results=8000`, `${device.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`).catch(setError)
                }
              >
                Download CSV
              </button>
            </div>
            <div className="panel-body">
              <dl className="kv">
                <dt>Kind</dt>
                <dd>{device.deviceType}</dd>
                <dt>Firmware</dt>
                <dd>{device.firmwareVersion ?? '—'}</dd>
                <dt>Reports</dt>
                <dd>every {device.expectedIntervalSeconds}s</dd>
                <dt>Connected</dt>
                <dd>{dateTime(device.lastConnectedAt)}</dd>
                <dt>Disconnected</dt>
                <dd>{dateTime(device.lastDisconnectedAt)}</dd>
                <dt>Registered</dt>
                <dd>{dateTime(device.createdAt)}</dd>
                <dt>Device ID</dt>
                <dd className="mono">{device.id}</dd>
                {Object.entries(device.reportedState ?? {})
                  .filter(([k]) => k !== 'firmwareVersion')
                  .map(([k, v]) => {
                    const m = metricLabel(k);
                    return (
                      <div key={k} style={{ display: 'contents' }}>
                        <dt>{m.label}</dt>
                        <dd>
                          {typeof v === 'number' ? num(v) : String(v)}
                          {m.unit && typeof v === 'number' ? ` ${m.unit}` : ''}
                        </dd>
                      </div>
                    );
                  })}
              </dl>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Recent activity</h2>
            </div>
            <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              <ul className="events">
                {events.map((e, i) => (
                  <li key={i}>
                    <span>
                      {EVENT_TEXT[e.type] ?? e.type}
                      {e.type === 'lifecycle_changed' && e.details?.to ? `: ${LIFECYCLE_TEXT[e.details.to] ?? e.details.to}` : ''}
                      {e.type === 'firmware_changed' ? `: ${e.details.from} to ${e.details.to}` : ''}
                    </span>
                    <span className="muted small" title={dateTime(e.time)}>
                      {ago(e.time, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {canEdit(org?.role) && !dead && (
            <section className="panel">
              <div className="panel-head">
                <h2>Device access</h2>
              </div>
              <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
                {device.lifecycleStatus === 'maintenance' || device.lifecycleStatus === 'suspended' ? (
                  <button className="btn" onClick={() => lifecycle('active')}>
                    Mark as active again
                  </button>
                ) : (
                  <button className="btn" onClick={() => lifecycle('maintenance')}>
                    Put in maintenance
                  </button>
                )}
                {device.lifecycleStatus !== 'suspended' && (
                  <button className="btn" onClick={() => setConfirm('suspend')}>
                    Suspend
                  </button>
                )}
                {isAdmin(org?.role) && (
                  <button className="btn danger" onClick={() => setConfirm('revoke')}>
                    Revoke device
                  </button>
                )}
                <p className="small muted">Suspended and revoked devices can’t connect. Revoking is permanent.</p>
              </div>
            </section>
          )}
        </div>
      </div>

      {editing && (
        <EditDialog
          device={device}
          onClose={() => setEditing(false)}
          onSaved={(d) => {
            setDevice(d);
            setEditing(false);
            toast('Device saved');
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          kind={confirm}
          device={device}
          onClose={() => setConfirm(null)}
          onDone={(r) => {
            setConfirm(null);
            if (confirm === 'rotate') setNewCreds(r);
            else {
              setDevice(r);
              toast(confirm === 'revoke' ? 'Device revoked' : 'Device suspended');
            }
            void load();
          }}
        />
      )}
      {newCreds && <CredentialsDialog replaced device={newCreds.device} credentials={newCreds.credentials} onClose={() => setNewCreds(null)} />}
    </>
  );
}

function EditDialog({ device, onClose, onSaved }: { device: Device; onClose: () => void; onSaved: (d: Device) => void }) {
  const [name, setName] = useState(device.displayName);
  const [interval, setIntervalS] = useState(device.expectedIntervalSeconds);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      onSaved(await api<Device>('PATCH', `/devices/${device.id}`, { displayName: name, expectedIntervalSeconds: interval }));
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit device"
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="edit-device">
            Save
          </button>
        </>
      }
    >
      <form id="edit-device" className="form" onSubmit={submit}>
        <label className="field">
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Sends data every (seconds)
          <span className="hint">Used to decide when the device counts as offline.</span>
          <input type="number" min={1} max={86400} required value={interval} onChange={(e) => setIntervalS(Number(e.target.value))} />
        </label>
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

function ConfirmDialog({ kind, device, onClose, onDone }: { kind: 'rotate' | 'revoke' | 'suspend'; device: Device; onClose: () => void; onDone: (r: any) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [typed, setTyped] = useState('');
  const copy = {
    rotate: {
      title: `Replace the password for ${device.displayName}?`,
      body: 'The current password stops working straight away. The device stays disconnected until you update it with the new password.',
      action: 'Replace password',
    },
    suspend: {
      title: `Suspend ${device.displayName}?`,
      body: 'The device won’t be able to connect or send data until you mark it as active again. Its history is kept.',
      action: 'Suspend',
    },
    revoke: {
      title: `Revoke ${device.displayName}?`,
      body: 'This permanently blocks the device. You can’t undo it; to use the hardware again, register it as a new device. Its history is kept.',
      action: 'Revoke device',
    },
  }[kind];

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r =
        kind === 'rotate'
          ? await api('POST', `/devices/${device.id}/rotate-credentials`)
          : kind === 'revoke'
            ? await api('POST', `/devices/${device.id}/revoke`, {})
            : await api('POST', `/devices/${device.id}/lifecycle`, { status: 'suspended' });
      onDone(r);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={copy.title}
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${kind === 'rotate' ? 'primary' : 'danger solid'}`} disabled={busy || (kind === 'revoke' && typed !== device.displayName)} onClick={go}>
            {busy ? 'Working…' : copy.action}
          </button>
        </>
      }
    >
      <p>{copy.body}</p>
      {kind === 'revoke' && (
        <label className="field">
          Type the device name to confirm
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={device.displayName} />
        </label>
      )}
      <ErrorBox error={error} />
    </Modal>
  );
}

