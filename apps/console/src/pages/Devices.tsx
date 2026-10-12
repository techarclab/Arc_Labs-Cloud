import { FormEvent, useCallback, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, canEdit, Credentials, Device, Reading } from '../api';
import { CredentialsDialog } from '../components/Credentials';
import { ErrorBox, Lifecycle, Modal, Status, Strip, useNow, usePoll } from '../components/ui';
import { ago, metricLabel, num } from '../format';
import { useSession } from '../session';
import { useChannel } from './Channel';

const STRIP_MINUTES = 30;

interface Row extends Device {
  latest?: Reading[];
  strip?: number[];
}

async function stripFor(device: Device, metric: string): Promise<number[]> {
  const to = new Date();
  const from = new Date(to.getTime() - STRIP_MINUTES * 60_000);
  from.setSeconds(0, 0);
  const r = await api('GET', `/devices/${device.id}/telemetry?metric=${metric}&bucket=1m&agg=count&from=${from.toISOString()}&to=${to.toISOString()}`);
  const counts = new Array(STRIP_MINUTES).fill(0);
  for (const p of r.series[metric] ?? []) {
    const idx = Math.floor((new Date(p.ts).getTime() - from.getTime()) / 60_000);
    if (idx >= 0 && idx < STRIP_MINUTES) counts[idx] = p.value;
  }
  return counts;
}

export function DevicesPage() {
  const { orgId = '', projectId = '' } = useParams();
  const { org, reloadDevices } = useChannel();
  const { refreshProjects } = useSession();
  const nav = useNavigate();
  const now = useNow();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<'all' | 'online' | 'offline' | 'unknown'>('all');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<{ device: Device; credentials: Credentials } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Device[] }>('GET', `/devices?projectId=${projectId}&limit=200`);
      const latest = await Promise.all(r.items.map((d) => api<{ items: Reading[] }>('GET', `/devices/${d.id}/telemetry/latest`).then((x) => x.items).catch(() => [])));
      setRows((prev) => r.items.map((d, i) => ({ ...d, latest: latest[i], strip: prev?.find((p) => p.id === d.id)?.strip })));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [projectId]);

  const rowsRef = useRef<Row[] | null>(null);
  rowsRef.current = rows;
  const loadStrips = useCallback(async () => {
    const current = rowsRef.current;
    if (!current) return;
    const entries = await Promise.all(
      current.slice(0, 50).map(async (d) => {
        const metric = d.latest?.[0]?.metric;
        const strip = metric ? await stripFor(d, metric).catch(() => undefined) : new Array(STRIP_MINUTES).fill(0);
        return [d.id, strip] as const;
      }),
    );
    const byId = new Map(entries);
    setRows((rs) => rs?.map((d) => (byId.get(d.id) ? { ...d, strip: byId.get(d.id) } : d)) ?? rs);
  }, []);

  usePoll(load, 5000, [projectId]);
  usePoll(loadStrips, 30_000, [projectId, rows === null]);

  const counts = { online: 0, offline: 0, unknown: 0 };
  rows?.forEach((d) => counts[d.connectivity.status]++);
  const visible = (rows ?? []).filter((d) => (filter === 'all' || d.connectivity.status === filter) && d.displayName.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      {canEdit(org?.role) && (
        <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}>
          <button className="btn primary" onClick={() => setAdding(true)}>
            Add device
          </button>
        </div>
      )}

      <ErrorBox error={error} />

      <section className="panel">
        {rows && rows.length > 0 && (
          <div className="fleet">
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              <span className="n" style={{ color: 'var(--ink)' }}>
                {rows.length}
              </span>
              devices
            </button>
            <button className="on" aria-pressed={filter === 'online'} onClick={() => setFilter('online')}>
              <span className="n">{counts.online}</span>online
            </button>
            <button className="off" aria-pressed={filter === 'offline'} onClick={() => setFilter('offline')}>
              <span className="n">{counts.offline}</span>offline
            </button>
            <button className="unk" aria-pressed={filter === 'unknown'} onClick={() => setFilter('unknown')}>
              <span className="n">{counts.unknown}</span>not seen yet
            </button>
            <input type="search" placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginLeft: 'auto', width: 220 }} aria-label="Search devices" />
          </div>
        )}

        {rows === null && !error && <div className="empty">Loading devices…</div>}

        {rows?.length === 0 && (
          <div className="empty">
            <h3>No devices in this channel yet</h3>
            <p>Add a device to get its secure login, then run the simulator or flash an ESP32 with it.</p>
            {canEdit(org?.role) && (
              <button className="btn primary" onClick={() => setAdding(true)}>
                Add your first device
              </button>
            )}
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Status</th>
                  <th className="hide-sm">Last {STRIP_MINUTES} minutes</th>
                  <th>Latest readings</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => nav(`/o/${orgId}/p/${projectId}/devices/${d.id}`)}>
                    <td>
                      <Link to={`/o/${orgId}/p/${projectId}/devices/${d.id}`} onClick={(e) => e.stopPropagation()} style={{ color: 'var(--ink)', fontWeight: 600 }}>
                        {d.displayName}
                      </Link>
                      <div className="small muted">
                        {d.deviceType}
                        {d.firmwareVersion ? `, firmware ${d.firmwareVersion}` : ''}
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <Status c={d.connectivity} />
                        <Lifecycle s={d.lifecycleStatus} />
                      </div>
                    </td>
                    <td className="hide-sm">{d.strip ? <Strip counts={d.strip} expected={60 / d.expectedIntervalSeconds} label="Messages per minute" /> : <span className="muted small">—</span>}</td>
                    <td>
                      {d.latest?.length ? (
                        <div className="readings-inline">
                          {d.latest.slice(0, 3).map((r) => {
                            const m = metricLabel(r.metric);
                            return (
                              <span key={r.metric} title={m.label}>
                                <b>{num(r.value)}</b> {m.unit || m.label}
                              </span>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="muted small">No data yet</span>
                      )}
                    </td>
                    <td className="muted" title={d.lastSeenAt ?? ''}>
                      {ago(d.lastSeenAt, now)}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                      No devices match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AddDeviceDialog
        open={adding}
        projectId={projectId}
        onClose={() => setAdding(false)}
        onCreated={(r) => {
          setAdding(false);
          setCreated(r);
          void load();
          void reloadDevices();
          void refreshProjects(orgId);
        }}
      />
      {created && <CredentialsDialog device={created.device} credentials={created.credentials} onClose={() => setCreated(null)} />}
    </>
  );
}

const INTERVALS = [
  [5, 'Every 5 seconds'],
  [10, 'Every 10 seconds'],
  [30, 'Every 30 seconds'],
  [60, 'Every minute'],
  [300, 'Every 5 minutes'],
  [900, 'Every 15 minutes'],
  [3600, 'Every hour'],
] as const;

function AddDeviceDialog({ open, projectId, onClose, onCreated }: { open: boolean; projectId: string; onClose: () => void; onCreated: (r: { device: Device; credentials: Credentials }) => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('esp32');
  const [interval, setIntervalS] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('POST', '/devices', { projectId, displayName: name, deviceType: type, expectedIntervalSeconds: interval });
      setName('');
      onCreated(r);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a device">
      <form className="form" onSubmit={submit} id="add-device">
        <label className="field">
          Name
          <span className="hint">Something you’ll recognise, like where it is.</span>
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Greenhouse 1 – north wall" autoFocus />
        </label>
        <label className="field">
          Kind of device
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="esp32">ESP32</option>
            <option value="esp8266">ESP8266</option>
            <option value="raspberry-pi">Raspberry Pi</option>
            <option value="gateway">Gateway</option>
            <option value="simulator">Simulator</option>
            <option value="generic">Other</option>
          </select>
        </label>
        <label className="field">
          How often it sends data
          <span className="hint">ARC Cloud marks the device offline after three missed reports.</span>
          <select value={interval} onChange={(e) => setIntervalS(Number(e.target.value))}>
            {INTERVALS.map(([s, l]) => (
              <option key={s} value={s}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <ErrorBox error={error} />
      </form>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn quiet" type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" type="submit" form="add-device" disabled={busy}>
          {busy ? 'Adding…' : 'Add device'}
        </button>
      </div>
    </Modal>
  );
}
