import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, API_ORIGIN, downloadAuthed, isAdmin, Project } from '../api';
import { CopyButton, ErrorBox, useToast } from '../components/ui';
import { useSession } from '../session';
import { useChannel } from './Channel';

export function ApiKeysPage() {
  const { orgId = '', projectId = '' } = useParams();
  const { org, project, fields, devices } = useChannel();
  const { refreshProjects } = useSession();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [results, setResults] = useState(1000);
  const [device, setDevice] = useState('');

  const origin = API_ORIGIN;
  const readKey = project?.readApiKey ?? '…';
  const data = (fields ?? []).filter((f) => f.kind === 'data');
  const controls = (fields ?? []).filter((f) => f.kind === 'control');
  const exampleFields = data.length ? data.slice(0, 2).map((f, i) => `&field${f.position}=${i === 0 ? '25.4' : '61'}`).join('') : '&field1=25.4&field2=61';

  async function regenerate() {
    if (!confirm('Create a new read key? Anything using the old key (apps, spreadsheets, websites) will stop working.')) return;
    try {
      await api<Project>('POST', `/projects/${projectId}/read-key`);
      await refreshProjects(orgId);
      toast('New read key created');
    } catch (e) {
      setError(e);
    }
  }

  async function exportCsv() {
    try {
      const q = new URLSearchParams({ results: String(results), ...(device ? { device } : {}) });
      await downloadAuthed(`/api/v1/channels/${projectId}/feeds.csv?${q}`, `${(project?.name ?? 'channel').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`);
    } catch (e) {
      setError(e);
    }
  }

  const examples = [
    {
      title: 'Send data (from a device)',
      note: 'Use the device’s own key, shown once when it was added. Up to one update per second.',
      code: `GET ${origin}/api/v1/update?api_key=DEVICE_KEY${exampleFields}`,
    },
    ...(controls.length
      ? [
          {
            title: 'Read control values (from a device)',
            note: `Returns every control field as JSON. Add &field=${controls[0].metricKey} to get just that value as plain text.`,
            code: `GET ${origin}/api/v1/controls?api_key=DEVICE_KEY`,
          },
        ]
      : []),
    {
      title: 'Read the channel feed',
      note: 'For apps, spreadsheets and websites. Add &device=DEVICE_ID to read one device, &start= and &end= for a time range.',
      code: `GET ${origin}/api/v1/channels/${projectId}/feeds.json?api_key=${readKey}&results=100`,
    },
    {
      title: 'Download as CSV',
      note: 'Same as above, as a spreadsheet file.',
      code: `GET ${origin}/api/v1/channels/${projectId}/feeds.csv?api_key=${readKey}&results=1000`,
    },
  ];

  return (
    <>
      <ErrorBox error={error} />
      <div className="api-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>Write keys</h2>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p>
              Every device has its own write key: the password shown once when you added it. The same key works for MQTT and for the HTTP API. If a device’s key is lost, open the device and choose <b>Replace password</b>.
            </p>
            <p className="small muted">Devices added before the HTTP API existed need their password replaced once before HTTP works for them.</p>
            {devices && devices.length > 0 && (
              <ul className="events">
                {devices.map((d) => (
                  <li key={d.id}>
                    <Link to={`/o/${orgId}/p/${projectId}/devices/${d.id}`}>{d.displayName}</Link>
                    <span className="mono muted small">{d.id}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Read key</h2>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p>Lets apps and websites read this channel’s data without signing in. It can’t change anything.</p>
            <div className="key-box">
              <code>{readKey}</code>
              <CopyButton text={readKey} />
            </div>
            {isAdmin(org?.role) && (
              <div>
                <button className="btn small" onClick={regenerate}>
                  Create a new read key
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>Export data</h2>
        </div>
        <div className="panel-body row" style={{ alignItems: 'flex-end', gap: 14 }}>
          <label className="field" style={{ width: 240 }}>
            Device
            <select value={device} onChange={(e) => setDevice(e.target.value)}>
              <option value="">All devices</option>
              {devices?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ width: 200 }}>
            Most recent entries
            <select value={results} onChange={(e) => setResults(Number(e.target.value))}>
              {[100, 1000, 8000].map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={exportCsv}>
            Download CSV
          </button>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>API requests</h2>
          <span className="small muted">Replace DEVICE_KEY with a device’s key. Use your computer’s Wi-Fi address instead of localhost when calling from an ESP32.</span>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {examples.map((e) => (
            <div key={e.title}>
              <h3>{e.title}</h3>
              <p className="small muted" style={{ margin: '4px 0 8px' }}>
                {e.note}
              </p>
              <div className="key-box">
                <code style={{ overflowWrap: 'anywhere' }}>{e.code}</code>
                <CopyButton text={e.code.replace(/^GET /, '')} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
