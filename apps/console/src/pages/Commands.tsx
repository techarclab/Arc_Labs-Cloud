import { FormEvent, useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, canEdit, isAdmin, Role } from '../api';
import { ago, dateTime } from '../format';
import { ErrorBox, Modal, useNow, usePoll, useToast } from '../components/ui';
import { useChannel } from './Channel';

export interface CommandParam { key: string; type: 'number' | 'boolean' | 'string'; min?: number; max?: number; maxLength?: number; required?: boolean }
export interface CommandType { id: string; name: string; description: string; params: CommandParam[]; ttlSeconds: number; minRole: 'engineer' | 'org_admin' }
export interface Command {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'published' | 'acknowledged' | 'failed' | 'expired';
  requestedBy: string;
  createdAt: string;
  expiresAt: string;
  publishedAt: string | null;
  completedAt: string | null;
  result: unknown;
  error: string | null;
}

export const COMMAND_STATUS: Record<Command['status'], { text: string; tone: string }> = {
  queued: { text: 'Waiting to send', tone: 'warn' },
  published: { text: 'Sent, waiting for device', tone: 'warn' },
  acknowledged: { text: 'Done', tone: 'ok' },
  failed: { text: 'Device reported an error', tone: 'bad' },
  expired: { text: 'Expired, no reply', tone: 'bad' },
};

const ttlText = (s: number) => (s >= 86400 ? `${Math.round(s / 86400)} d` : s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

/** Channel tab: the allow-list of commands devices in this channel accept. */
export function CommandTypesPage() {
  const { projectId = '' } = useParams();
  const { org } = useChannel();
  const toast = useToast();
  const admin = isAdmin(org?.role);
  const [items, setItems] = useState<CommandType[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<CommandType | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: CommandType[] }>('GET', `/projects/${projectId}/command-types`)).items);
    } catch (e) {
      setError(e);
    }
  }, [projectId]);
  usePoll(load, 60_000, [load]);

  async function remove(t: CommandType) {
    if (!confirm(`Remove “${t.name}”? Devices in this channel can no longer be sent it.`)) return;
    try {
      await api('DELETE', `/projects/${projectId}/command-types/${encodeURIComponent(t.name)}`);
      toast('Command removed');
      void load();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <p className="sub" style={{ margin: 0, maxWidth: 720 }}>
          Commands are one-off instructions to a device, such as “reboot” or “calibrate”. Only the commands listed here can be sent. Each one is tracked until the device confirms it, and expires if the device doesn’t reply in
          time. Send them from a device’s page.
        </p>
        {admin && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            New command
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      <section className="panel">
        {items && !items.length ? (
          <div className="empty">
            <h3>No commands allowed yet</h3>
            <p>For example “reboot” (no settings) or “set_interval” with a number setting “seconds” from 5 to 3600.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Command</th>
                  <th>Settings</th>
                  <th className="hide-sm">Expires after</th>
                  <th className="hide-sm">Who can send</th>
                  {admin && <th />}
                </tr>
              </thead>
              <tbody>
                {items?.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <b className="mono">{t.name}</b>
                      {t.description && <div className="muted small">{t.description}</div>}
                    </td>
                    <td className="small">
                      {t.params.length
                        ? t.params.map((p) => `${p.key} (${p.type}${p.min !== undefined || p.max !== undefined ? ` ${p.min ?? '…'}–${p.max ?? '…'}` : ''}${p.required ? ', required' : ''})`).join(', ')
                        : <span className="muted">none</span>}
                    </td>
                    <td className="hide-sm">{ttlText(t.ttlSeconds)}</td>
                    <td className="hide-sm">{t.minRole === 'org_admin' ? 'Admins' : 'Engineers & admins'}</td>
                    {admin && (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn small quiet" onClick={() => setEditing(t)}>
                          Edit
                        </button>
                        <button className="btn small quiet danger" onClick={() => remove(t)}>
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing && (
        <TypeModal
          projectId={projectId}
          type={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast('Command saved');
            void load();
          }}
        />
      )}
    </>
  );
}

function TypeModal({ projectId, type, onClose, onSaved }: { projectId: string; type: CommandType | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(type?.name ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [ttl, setTtl] = useState(String(type?.ttlSeconds ?? 300));
  const [minRole, setMinRole] = useState(type?.minRole ?? 'engineer');
  const [params, setParams] = useState<CommandParam[]>(type?.params ?? []);
  const [error, setError] = useState<unknown>(null);
  const set = (i: number, p: Partial<CommandParam>) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, ...p } : x)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('PUT', `/projects/${projectId}/command-types/${encodeURIComponent(name)}`, {
        description,
        ttlSeconds: Number(ttl),
        minRole,
        params: params.map((p) => ({
          key: p.key,
          type: p.type,
          required: !!p.required,
          ...(p.type === 'number' && p.min !== undefined && !Number.isNaN(p.min) ? { min: p.min } : {}),
          ...(p.type === 'number' && p.max !== undefined && !Number.isNaN(p.max) ? { max: p.max } : {}),
          ...(p.type === 'string' ? { maxLength: p.maxLength ?? 100 } : {}),
        })),
      });
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal open wide onClose={onClose} title={type ? `Edit ${type.name}` : 'New command'} footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" form="ct-form">Save</button></>}>
      <form id="ct-form" className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-row">
          <label className="field">
            Name <span className="hint">what the firmware receives</span>
            <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} required pattern="[a-z][a-z0-9_.\-]{0,47}" disabled={!!type} placeholder="reboot" className="mono" />
          </label>
          <label className="field">
            Expires after <span className="hint">if the device doesn’t reply</span>
            <select value={ttl} onChange={(e) => setTtl(e.target.value)}>
              <option value="60">1 minute</option>
              <option value="300">5 minutes</option>
              <option value="3600">1 hour</option>
              <option value="86400">1 day</option>
              <option value="604800">7 days</option>
            </select>
          </label>
          <label className="field">
            Who can send
            <select value={minRole} onChange={(e) => setMinRole(e.target.value as typeof minRole)}>
              <option value="engineer">Engineers &amp; admins</option>
              <option value="org_admin">Admins only</option>
            </select>
          </label>
        </div>
        <label className="field">
          Description <span className="hint">optional</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="Restarts the device" />
        </label>
        <div className="field">
          Settings sent with the command
          {params.map((p, i) => (
            <div key={i} className="form-row" style={{ alignItems: 'end', marginTop: 6 }}>
              <input aria-label="Setting name" value={p.key} onChange={(e) => set(i, { key: e.target.value })} required pattern="[A-Za-z][A-Za-z0-9_]{0,31}" placeholder="seconds" className="mono" />
              <select aria-label="Type" value={p.type} onChange={(e) => set(i, { type: e.target.value as CommandParam['type'] })}>
                <option value="number">number</option>
                <option value="boolean">on/off</option>
                <option value="string">text</option>
              </select>
              {p.type === 'number' && (
                <>
                  <input aria-label="Minimum" type="number" step="any" placeholder="min" value={p.min ?? ''} onChange={(e) => set(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  <input aria-label="Maximum" type="number" step="any" placeholder="max" value={p.max ?? ''} onChange={(e) => set(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })} />
                </>
              )}
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                <input type="checkbox" checked={!!p.required} onChange={(e) => set(i, { required: e.target.checked })} /> required
              </label>
              <button type="button" className="btn small quiet danger" onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          {params.length < 10 && (
            <div style={{ marginTop: 8 }}>
              <button type="button" className="btn small" onClick={() => setParams((ps) => [...ps, { key: '', type: 'number', required: true }])}>
                Add a setting
              </button>
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** Device page panel: send an allowed command and follow its status. */
export function DeviceCommands({ deviceId, projectId, role, inactive }: { deviceId: string; projectId: string; role?: Role; inactive: boolean }) {
  const toast = useToast();
  const now = useNow(5_000);
  const [types, setTypes] = useState<CommandType[] | null>(null);
  const [items, setItems] = useState<Command[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sending, setSending] = useState<CommandType | null>(null);
  const [open, setOpen] = useState<Command | null>(null);
  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        api<{ items: CommandType[] }>('GET', `/projects/${projectId}/command-types`),
        api<{ items: Command[] }>('GET', `/devices/${deviceId}/commands?limit=10`),
      ]);
      setTypes(t.items);
      setItems(c.items);
    } catch (e) {
      setError(e);
    }
  }, [deviceId, projectId]);
  usePoll(load, 5_000, [load]);

  const allowed = (t: CommandType) => (t.minRole === 'org_admin' ? isAdmin(role) : canEdit(role));
  const sendable = (types ?? []).filter(allowed);

  async function send(t: CommandType, payload: Record<string, unknown>) {
    try {
      await api('POST', `/devices/${deviceId}/commands`, { name: t.name, payload });
      setSending(null);
      toast(`“${t.name}” sent`);
      void load();
    } catch (e) {
      setError(e);
    }
  }
  async function retry(c: Command) {
    try {
      await api('POST', `/commands/${c.id}/retry`);
      toast('Sent again');
      void load();
    } catch (e) {
      setError(e);
    }
  }
  if (types && !types.length && items && !items.length) return null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Commands</h2>
        {!inactive && sendable.length > 0 && (
          <select
            aria-label="Send a command"
            value=""
            onChange={(e) => {
              const t = sendable.find((x) => x.name === e.target.value);
              if (!t) return;
              if (t.params.length) setSending(t);
              else if (confirm(`Send “${t.name}” to this device?`)) void send(t, {});
            }}
            style={{ width: 'auto' }}
          >
            <option value="">Send a command…</option>
            {sendable.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <ErrorBox error={error} />
      {items && !items.length ? (
        <p className="muted small" style={{ padding: '12px 18px' }}>No commands sent yet.</p>
      ) : (
        <ul className="events" style={{ padding: '6px 18px' }}>
          {items?.map((c) => (
            <li key={c.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(c)}>
              <span>
                <b className="mono">{c.name}</b> <span className={`pill ${COMMAND_STATUS[c.status].tone}`}>{COMMAND_STATUS[c.status].text}</span>
              </span>
              <span className="muted small">{ago(c.createdAt, now)}</span>
            </li>
          ))}
        </ul>
      )}
      {sending && <SendModal type={sending} onClose={() => setSending(null)} onSend={(p) => send(sending, p)} />}
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `Command ${open.name}` : ''} footer={<>{open && canEdit(role) && (open.status === 'queued' || open.status === 'published') && <button className="btn" onClick={() => retry(open)}>Send again</button>}<button className="btn primary" onClick={() => setOpen(null)}>Close</button></>}>
        {open && (
          <dl className="kv">
            <dt>Status</dt>
            <dd>{COMMAND_STATUS[open.status].text}</dd>
            <dt>Settings</dt>
            <dd className="mono">{Object.keys(open.payload ?? {}).length ? JSON.stringify(open.payload) : '—'}</dd>
            <dt>Sent by</dt>
            <dd>{open.requestedBy}</dd>
            <dt>Created</dt>
            <dd>{dateTime(open.createdAt)}</dd>
            <dt>Reached device</dt>
            <dd>{dateTime(open.publishedAt)}</dd>
            <dt>Finished</dt>
            <dd>{dateTime(open.completedAt)}</dd>
            <dt>Expires</dt>
            <dd>{dateTime(open.expiresAt)}</dd>
            {open.error && (
              <>
                <dt>Error</dt>
                <dd>{open.error}</dd>
              </>
            )}
            {open.result != null && (
              <>
                <dt>Device reply</dt>
                <dd className="mono">{JSON.stringify(open.result)}</dd>
              </>
            )}
          </dl>
        )}
      </Modal>
    </section>
  );
}

function SendModal({ type, onClose, onSend }: { type: CommandType; onClose: () => void; onSend: (p: Record<string, unknown>) => void }) {
  const [vals, setVals] = useState<Record<string, string | boolean>>({});
  function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {};
    for (const p of type.params) {
      const v = vals[p.key];
      if (p.type === 'boolean') payload[p.key] = !!v;
      else if (v !== undefined && v !== '') payload[p.key] = p.type === 'number' ? Number(v) : v;
    }
    onSend(payload);
  }
  return (
    <Modal open onClose={onClose} title={`Send ${type.name}`} footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" form="send-form">Send</button></>}>
      <form id="send-form" className="form" onSubmit={submit}>
        {type.description && <p className="small muted">{type.description}</p>}
        {type.params.map((p) =>
          p.type === 'boolean' ? (
            <label key={p.key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={!!vals[p.key]} onChange={(e) => setVals((v) => ({ ...v, [p.key]: e.target.checked }))} /> <span className="mono">{p.key}</span>
            </label>
          ) : (
            <label key={p.key} className="field">
              <span className="mono">{p.key}</span>
              {p.type === 'number' && (p.min !== undefined || p.max !== undefined) && <span className="hint">{p.min ?? '…'} to {p.max ?? '…'}</span>}
              <input
                type={p.type === 'number' ? 'number' : 'text'}
                step="any"
                min={p.min}
                max={p.max}
                maxLength={p.maxLength}
                required={p.required}
                value={String(vals[p.key] ?? '')}
                onChange={(e) => setVals((v) => ({ ...v, [p.key]: e.target.value }))}
              />
            </label>
          ),
        )}
      </form>
    </Modal>
  );
}
