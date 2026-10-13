import { FormEvent, useCallback, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, isAdmin, Org, Project } from '../api';
import { ago, dateTime } from '../format';
import { ErrorBox, Modal, useNow, usePoll, useToast } from '../components/ui';
import { useSession } from '../session';

interface SigningKey { id: string; name: string; publicKeyPem: string; createdAt: string; revokedAt: string | null }
interface Release {
  id: string;
  deviceType: string;
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  signingKeyName?: string;
  notes: string;
  status: 'released' | 'withdrawn';
  createdAt: string;
}
interface Rollout {
  id: string;
  releaseId: string;
  version: string;
  deviceType: string;
  projectId: string;
  projectName?: string;
  percent: number;
  status: 'active' | 'paused' | 'cancelled' | 'completed';
  counts: Record<string, number>;
  eligible?: number;
  createdAt: string;
  updatedAt: string;
  devices?: { deviceId: string; name: string; firmwareVersion: string | null; status: string; detail: string | null; updatedAt: string }[];
}

const STATUS_TONE: Record<string, string> = { succeeded: 'ok', failed: 'bad', sent: 'warn', pending: '', downloading: 'warn', installing: 'warn' };

/** Firmware signing keys, signed releases and staged OTA rollouts. */
export function FirmwarePage() {
  const { orgId = '' } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const { projects } = useSession();
  const channels = projects[orgId] ?? [];
  const admin = isAdmin(org?.role);
  const toast = useToast();
  const now = useNow(30_000);
  const [keys, setKeys] = useState<SigningKey[] | null>(null);
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [rollouts, setRollouts] = useState<Rollout[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [modal, setModal] = useState<'key' | 'release' | { rollout: Release } | null>(null);
  const [open, setOpen] = useState<Rollout | null>(null);

  const load = useCallback(async () => {
    try {
      const [k, r, o] = await Promise.all([
        api<{ items: SigningKey[] }>('GET', `/firmware/signing-keys?organizationId=${orgId}`),
        api<{ items: Release[] }>('GET', `/firmware/releases?organizationId=${orgId}`),
        api<{ items: Rollout[] }>('GET', `/firmware/rollouts?organizationId=${orgId}`),
      ]);
      setKeys(k.items);
      setReleases(r.items);
      setRollouts(o.items);
    } catch (e) {
      setError(e);
    }
  }, [orgId]);
  usePoll(load, 15_000, [load]);

  async function act(path: string, method: string, body: unknown, msg: string, after?: () => void) {
    try {
      await api(method, path, body);
      toast(msg);
      after?.();
      void load();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Firmware &amp; OTA</h1>
          <p className="sub">Publish signed firmware and roll it out to a share of a channel’s devices, then widen when it’s healthy.</p>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="stack">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Rollouts</h2>
              <p className="muted small">Devices download the file, check its SHA-256, install and report back. A device stays on its old firmware if anything fails.</p>
            </div>
          </div>
          {rollouts && !rollouts.length ? (
            <p className="muted small" style={{ padding: '14px 18px' }}>No rollouts yet. Start one from a release below.</p>
          ) : (
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Release</th>
                    <th>Channel</th>
                    <th>Progress</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rollouts?.map((o) => {
                    const total = Object.values(o.counts).reduce((a, b) => a + b, 0);
                    const done = o.counts.succeeded ?? 0;
                    return (
                      <tr key={o.id} className="clickable" onClick={() => setOpen(o)}>
                        <td>
                          <b>{o.version}</b> <span className="muted small">{o.deviceType}</span>
                          <div className="muted small">started {ago(o.createdAt, now)}</div>
                        </td>
                        <td>
                          {o.projectName}
                          <div className="muted small">{o.percent}% of devices</div>
                        </td>
                        <td className="small">
                          <div className="progress" style={{ marginBottom: 4 }}>
                            <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
                          </div>
                          {done} of {total} updated{o.counts.failed ? <span className="pill bad" style={{ marginLeft: 6 }}>{o.counts.failed} failed</span> : null}
                          {o.status === 'active' && o.percent < 100 && total > 0 && done + (o.counts.failed ?? 0) === total && <div className="muted">This wave is done. Widen when you’re happy.</div>}
                        </td>
                        <td>
                          <span className={`pill ${o.status === 'active' ? 'ok' : o.status === 'cancelled' ? 'bad' : o.status === 'paused' ? 'warn' : ''}`}>{o.status}</span>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                          {admin && (o.status === 'active' || o.status === 'paused') && (
                            <>
                              {o.percent < 100 && (
                                <button className="btn small quiet" onClick={() => act(`/firmware/rollouts/${o.id}`, 'PATCH', { percent: o.percent < 10 ? 10 : o.percent < 50 ? 50 : 100 }, 'Rollout widened')}>
                                  Widen to {o.percent < 10 ? 10 : o.percent < 50 ? 50 : 100}%
                                </button>
                              )}
                              <button className="btn small quiet" onClick={() => act(`/firmware/rollouts/${o.id}`, 'PATCH', { status: o.status === 'active' ? 'paused' : 'active' }, o.status === 'active' ? 'Rollout paused' : 'Rollout resumed')}>
                                {o.status === 'active' ? 'Pause' : 'Resume'}
                              </button>
                              <button
                                className="btn small quiet danger"
                                onClick={() => confirm('Cancel this rollout? Devices that already updated keep the new version.') && act(`/firmware/rollouts/${o.id}`, 'PATCH', { status: 'cancelled' }, 'Rollout cancelled')}
                              >
                                Cancel
                              </button>
                            </>
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

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Releases</h2>
              <p className="muted small">Each release is a firmware file on an https:// address, signed with one of your keys. ARC Cloud rejects releases whose signature doesn’t check out.</p>
            </div>
            {admin && (
              <button className="btn primary" onClick={() => setModal('release')} disabled={!keys?.some((k) => !k.revokedAt)} title={keys?.some((k) => !k.revokedAt) ? undefined : 'Add a signing key first'}>
                New release
              </button>
            )}
          </div>
          {releases && !releases.length ? (
            <p className="muted small" style={{ padding: '14px 18px' }}>No releases yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th className="hide-sm">File</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {releases?.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <b>{r.version}</b> <span className="muted small">{r.deviceType}</span>
                        {r.notes && <div className="muted small">{r.notes}</div>}
                      </td>
                      <td className="hide-sm small">
                        <span className="mono">{(r.sizeBytes / 1024).toFixed(0)} KB · sha256 {r.sha256.slice(0, 12)}…</span>
                        <div className="muted">signed with {r.signingKeyName ?? 'a key'} · {dateTime(r.createdAt)}</div>
                      </td>
                      <td>
                        <span className={`pill ${r.status === 'released' ? 'ok' : 'bad'}`}>{r.status}</span>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {admin && r.status === 'released' && (
                          <>
                            <button className="btn small" onClick={() => setModal({ rollout: r })} disabled={!channels.length}>
                              Roll out
                            </button>
                            <button className="btn small quiet danger" onClick={() => confirm(`Withdraw ${r.version}? Active rollouts of it stop.`) && act(`/firmware/releases/${r.id}/withdraw`, 'POST', undefined, 'Release withdrawn')}>
                              Withdraw
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
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Signing keys</h2>
              <p className="muted small">
                Make a key pair on your computer with <code>node tools/firmware-sign.mjs keygen</code>. Keep the private key offline; paste only the public key here.
              </p>
            </div>
            {admin && (
              <button className="btn" onClick={() => setModal('key')}>
                Add public key
              </button>
            )}
          </div>
          {keys && !keys.length ? (
            <p className="muted small" style={{ padding: '14px 18px' }}>No signing keys yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="grid">
                <tbody>
                  {keys?.map((k) => (
                    <tr key={k.id} style={k.revokedAt ? { opacity: 0.55 } : undefined}>
                      <td>
                        <b>{k.name}</b>
                        <div className="muted small">added {dateTime(k.createdAt)} · Ed25519</div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {k.revokedAt ? (
                          <span className="pill bad">revoked</span>
                        ) : (
                          admin && (
                            <button className="btn small quiet danger" onClick={() => confirm(`Revoke “${k.name}”? New releases can’t use it.`) && act(`/firmware/signing-keys/${k.id}`, 'DELETE', undefined, 'Key revoked')}>
                              Revoke
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {modal === 'key' && <KeyModal orgId={orgId} onClose={() => setModal(null)} onSaved={() => { setModal(null); toast('Key added'); void load(); }} />}
      {modal === 'release' && keys && <ReleaseModal orgId={orgId} keys={keys.filter((k) => !k.revokedAt)} onClose={() => setModal(null)} onSaved={() => { setModal(null); toast('Release added'); void load(); }} />}
      {modal && typeof modal === 'object' && (
        <RolloutModal
          release={modal.rollout}
          channels={channels}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            toast('Rollout started');
            void load();
          }}
        />
      )}
      {open && <RolloutDetail id={open.id} onClose={() => setOpen(null)} />}
    </>
  );
}

function KeyModal({ orgId, onClose, onSaved }: { orgId: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [pem, setPem] = useState('');
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('POST', '/firmware/signing-keys', { organizationId: orgId, name, publicKeyPem: pem });
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal open wide onClose={onClose} title="Add a signing public key" footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" form="fk-form">Add key</button></>}>
      <form id="fk-form" className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Release key 2026" />
        </label>
        <label className="field">
          Public key <span className="hint">contents of firmware-signing-public.pem</span>
          <textarea rows={5} value={pem} onChange={(e) => setPem(e.target.value)} required className="mono" placeholder={'-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----'} />
        </label>
      </form>
    </Modal>
  );
}

function ReleaseModal({ orgId, keys, onClose, onSaved }: { orgId: string; keys: SigningKey[]; onClose: () => void; onSaved: () => void }) {
  const [json, setJson] = useState('');
  const [keyId, setKeyId] = useState(keys[0]?.id ?? '');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(json);
    } catch {
      setError(new Error('Paste the JSON printed by “node tools/firmware-sign.mjs sign …”.'));
      return;
    }
    try {
      await api('POST', '/firmware/releases', {
        organizationId: orgId,
        deviceType: m.deviceType,
        version: m.version,
        url: m.url,
        sha256: m.sha256,
        sizeBytes: m.sizeBytes,
        signature: m.signature,
        signingKeyId: keyId,
        notes,
      });
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal open wide onClose={onClose} title="New firmware release" footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" form="fr-form">Add release</button></>}>
      <form id="fr-form" className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Upload the .bin file somewhere it can be downloaded over https:// (e.g. a GitHub release).</li>
          <li>
            Run <code>node tools/firmware-sign.mjs sign firmware.bin --key firmware-signing-private.pem --device-type esp32 --version 1.2.0 --url https://…/firmware.bin</code>
          </li>
          <li>Paste the JSON it prints below.</li>
        </ol>
        <label className="field">
          Signed manifest (JSON)
          <textarea rows={8} className="mono" value={json} onChange={(e) => setJson(e.target.value)} required placeholder='{"deviceType":"esp32","version":"1.2.0","url":"https://…","sha256":"…","sizeBytes":123456,"signature":"…"}' />
        </label>
        <div className="form-row">
          <label className="field">
            Signed with
            <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Release notes <span className="hint">optional</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </label>
        </div>
      </form>
    </Modal>
  );
}

function RolloutModal({ release, channels, onClose, onSaved }: { release: Release; channels: Project[]; onClose: () => void; onSaved: () => void }) {
  const [projectId, setProjectId] = useState(channels[0]?.id ?? '');
  const [percent, setPercent] = useState('10');
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('POST', '/firmware/rollouts', { releaseId: release.id, projectId, percent: Number(percent) });
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Roll out ${release.version}`} footer={<><button className="btn quiet" onClick={onClose}>Cancel</button><button className="btn primary" form="ro-form">Start rollout</button></>}>
      <form id="ro-form" className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <p className="small">Goes to “{release.deviceType}” devices in the channel. Start small, check they come back online on {release.version}, then widen.</p>
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
            First wave
            <select value={percent} onChange={(e) => setPercent(e.target.value)}>
              <option value="1">1% of devices (at least one)</option>
              <option value="10">10%</option>
              <option value="50">50%</option>
              <option value="100">All devices</option>
            </select>
          </label>
        </div>
      </form>
    </Modal>
  );
}

function RolloutDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [o, setO] = useState<Rollout | null>(null);
  const [error, setError] = useState<unknown>(null);
  const now = useNow(10_000);
  const load = useCallback(async () => {
    try {
      setO(await api<Rollout>('GET', `/firmware/rollouts/${id}`));
    } catch (e) {
      setError(e);
    }
  }, [id]);
  usePoll(load, 5_000, [load]);
  return (
    <Modal open wide onClose={onClose} title={o ? `${o.version} → ${o.projectName ?? 'channel'}` : 'Rollout'} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <ErrorBox error={error} />
      {o?.devices && (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Device</th>
                <th>Now running</th>
                <th>Update</th>
              </tr>
            </thead>
            <tbody>
              {o.devices.map((d) => (
                <tr key={d.deviceId}>
                  <td>{d.name}</td>
                  <td className="mono small">{d.firmwareVersion ?? '—'}</td>
                  <td>
                    <span className={`pill ${STATUS_TONE[d.status] ?? ''}`}>{d.status}</span>
                    <div className="muted small">
                      {d.detail ? `${d.detail} · ` : ''}
                      {ago(d.updatedAt, now)}
                    </div>
                  </td>
                </tr>
              ))}
              {!o.devices.length && (
                <tr>
                  <td colSpan={3} className="muted small">
                    No {o.deviceType} devices in this channel yet. Devices added later join the rollout when you widen or resume it.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
