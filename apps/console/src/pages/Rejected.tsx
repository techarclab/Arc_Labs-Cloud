import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Device } from '../api';
import { ErrorBox, usePoll } from '../components/ui';
import { dateTime } from '../format';
import { useSession } from '../session';

interface Rejected { id: number; device_id: string | null; topic: string; reason: string; detail: string; payload_excerpt: string; received_at: string }

const REASON: Record<string, { title: string; fix: string }> = {
  invalid_json: { title: 'Not valid JSON', fix: 'Check the firmware builds the message with a JSON library rather than by joining strings.' },
  schema_invalid: { title: 'Message format is wrong', fix: 'Compare the message with the format in docs/device-protocol. Every message needs schemaVersion 1, a messageId and numeric metrics.' },
  timestamp_out_of_range: { title: 'Clock is wrong', fix: 'The device’s time is more than 5 minutes ahead or 7 days behind. Sync it with NTP, or leave the timestamp out.' },
  metric_not_allowed: { title: 'Unknown reading name', fix: 'This project only accepts the readings listed in its settings. Add the reading there, or rename it in the firmware.' },
  value_out_of_range: { title: 'Value outside allowed range', fix: 'The value is outside the min/max set in project settings. Check the sensor, or widen the range.' },
  payload_too_large: { title: 'Message too large', fix: 'Messages must be under 16 KB. Send fewer values per message.' },
  device_inactive: { title: 'Device is suspended or revoked', fix: 'Messages from suspended or revoked devices are ignored. Reactivate it on its device page.' },
  topic_mismatch: { title: 'Wrong topic', fix: 'The device published to a topic for a different project. Use the topic shown when the device was registered.' },
  unknown_device: { title: 'Unknown device', fix: 'The device ID in the topic isn’t registered.' },
  bad_topic: { title: 'Topic not recognised', fix: 'Topics must look like arc/v1/<org>/<project>/<device>/telemetry.' },
};

export function RejectedPage() {
  const { orgId = '' } = useParams();
  const { projects } = useSession();
  const [items, setItems] = useState<Rejected[] | null>(null);
  const [names, setNames] = useState<Record<string, { name: string; projectId: string }>>({});
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Rejected[] }>('GET', `/organizations/${orgId}/rejected-messages?limit=100`);
      setItems(r.items);
      const ids = [...new Set(r.items.map((i) => i.device_id).filter(Boolean))] as string[];
      const missing = ids.filter((id) => !names[id]);
      if (missing.length) {
        const found = await Promise.all(missing.map((id) => api<Device>('GET', `/devices/${id}`).catch(() => null)));
        setNames((n) => ({ ...n, ...Object.fromEntries(found.filter(Boolean).map((d) => [d!.id, { name: d!.displayName, projectId: d!.projectId }])) }));
      }
    } catch (e) {
      setError(e);
    }
  }, [orgId, names]);
  usePoll(load, 15_000, [orgId]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rejected data</h1>
          <p className="sub">Messages that arrived but weren’t saved, and why. Look here first when a device is connected but its readings don’t show up.</p>
        </div>
      </div>
      <ErrorBox error={error} />
      <section className="panel">
        {items?.length === 0 && (
          <div className="empty">
            <h3>Nothing rejected</h3>
            <p>Every message your devices sent was accepted.</p>
          </div>
        )}
        {items && items.length > 0 && (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Device</th>
                  <th>Problem</th>
                  <th className="hide-sm">Details</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const reason = REASON[r.reason];
                  const dev = r.device_id ? names[r.device_id] : undefined;
                  const proj = dev && Object.values(projects).flat().find((p) => p.id === dev.projectId);
                  return (
                    <tr key={r.id} className="clickable" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {dateTime(r.received_at)}
                      </td>
                      <td>
                        {dev ? (
                          <Link to={`/o/${orgId}/p/${dev.projectId}/devices/${r.device_id}`} onClick={(e) => e.stopPropagation()}>
                            {dev.name}
                          </Link>
                        ) : (
                          <span className="muted">Unknown</span>
                        )}
                        {proj && <div className="small muted">{proj.name}</div>}
                      </td>
                      <td>
                        <b>{reason?.title ?? r.reason}</b>
                        {open === r.id && reason && <p className="small" style={{ marginTop: 6, maxWidth: '60ch' }}>{reason.fix}</p>}
                      </td>
                      <td className="hide-sm">
                        <span className="small">{r.detail}</span>
                        {open === r.id && (
                          <pre className="code" style={{ marginTop: 8, whiteSpace: 'pre-wrap', maxWidth: 420 }}>
                            {r.payload_excerpt || '(empty)'}
                          </pre>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {items && items.length > 0 && <p className="small muted" style={{ marginTop: 10 }}>Click a row to see how to fix it and the start of the message.</p>}
    </>
  );
}
