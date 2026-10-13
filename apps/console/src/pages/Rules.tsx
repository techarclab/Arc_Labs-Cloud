import { FormEvent, useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, canEdit } from '../api';
import { SeverityPill } from '../components/alerts';
import { ErrorBox, Modal, usePoll, useToast } from '../components/ui';
import { useChannel } from './Channel';

interface Rule {
  id: string;
  deviceId: string | null;
  name: string;
  ruleType: 'threshold' | 'stale' | 'offline';
  metricKey: string | null;
  operator: string | null;
  threshold: number | null;
  forSeconds: number;
  staleSeconds: number | null;
  severity: 'info' | 'warning' | 'critical';
  cooldownSeconds: number;
  notifyEmails: string[];
  enabled: boolean;
  activeAlerts?: number;
}

const OPS: { op: string; text: string }[] = [
  { op: '>', text: 'is above' },
  { op: '>=', text: 'is at or above' },
  { op: '<', text: 'is below' },
  { op: '<=', text: 'is at or below' },
  { op: '==', text: 'equals' },
  { op: '!=', text: 'is not' },
];
const minutes = (s: number) => (s % 3600 === 0 && s >= 3600 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

export function RulesPage() {
  const { orgId = '', projectId = '' } = useParams();
  const { org, fields, devices } = useChannel();
  const toast = useToast();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const edit = canEdit(org?.role);

  const load = useCallback(async () => {
    try {
      setRules((await api<{ items: Rule[] }>('GET', `/rules?projectId=${projectId}`)).items);
    } catch (e) {
      setError(e);
    }
  }, [projectId]);
  usePoll(load, 15_000, [load]);

  const label = (key: string | null) => fields?.find((f) => f.metricKey === key)?.label || key || '';
  const unit = (key: string | null) => fields?.find((f) => f.metricKey === key)?.unit || '';
  const deviceName = (id: string | null) => (id ? devices?.find((d) => d.id === id)?.displayName ?? 'one device' : 'Every device');
  const describe = (r: Rule) =>
    r.ruleType === 'threshold'
      ? `${label(r.metricKey)} ${OPS.find((o) => o.op === r.operator)?.text} ${r.threshold}${unit(r.metricKey) ? ` ${unit(r.metricKey)}` : ''}${r.forSeconds ? ` for ${minutes(r.forSeconds)}` : ''}`
      : r.ruleType === 'stale'
        ? `No data for ${minutes(r.staleSeconds ?? 0)}`
        : 'Goes offline';

  async function toggle(r: Rule) {
    try {
      await api('PATCH', `/rules/${r.id}`, { enabled: !r.enabled });
      toast(r.enabled ? `“${r.name}” paused` : `“${r.name}” on`);
      void load();
    } catch (e) {
      setError(e);
    }
  }
  async function remove(r: Rule) {
    if (!confirm(`Delete the rule “${r.name}”? Its open alerts are closed.`)) return;
    try {
      await api('DELETE', `/rules/${r.id}`);
      toast('Rule deleted');
      void load();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <p className="sub" style={{ margin: 0 }}>
          Rules watch this channel’s devices and raise <Link to={`/o/${orgId}/alerts`}>alerts</Link>, with emails to the people you choose.
        </p>
        {edit && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            New rule
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      <section className="panel">
        {rules && !rules.length ? (
          <div className="empty">
            <h3>No rules yet</h3>
            <p>For example: “Temperature is above 30 °C for 5 minutes”, “No data for 10 minutes”, or “Goes offline”.</p>
            {edit && (
              <button className="btn primary" onClick={() => setEditing('new')}>
                Create the first rule
              </button>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>When</th>
                  <th className="hide-sm">Devices</th>
                  <th>Severity</th>
                  <th>Open</th>
                  {edit && <th />}
                </tr>
              </thead>
              <tbody>
                {rules?.map((r) => (
                  <tr key={r.id} style={r.enabled ? undefined : { opacity: 0.6 }}>
                    <td>
                      <b>{r.name}</b>
                      {!r.enabled && <span className="pill" style={{ marginLeft: 8 }}>paused</span>}
                      {r.notifyEmails.length > 0 && <div className="muted small">Emails {r.notifyEmails.join(', ')}</div>}
                    </td>
                    <td>{describe(r)}</td>
                    <td className="hide-sm">{deviceName(r.deviceId)}</td>
                    <td>
                      <SeverityPill s={r.severity} />
                    </td>
                    <td>{r.activeAlerts ? <Link to={`/o/${orgId}/alerts`}>{r.activeAlerts}</Link> : <span className="muted">0</span>}</td>
                    {edit && (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn small quiet" onClick={() => toggle(r)}>
                          {r.enabled ? 'Pause' : 'Turn on'}
                        </button>
                        <button className="btn small quiet" onClick={() => setEditing(r)}>
                          Edit
                        </button>
                        <button className="btn small danger quiet" onClick={() => remove(r)}>
                          Delete
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
        <RuleForm
          projectId={projectId}
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast('Rule saved');
            void load();
          }}
        />
      )}
    </>
  );
}

function RuleForm({ projectId, rule, onClose, onSaved }: { projectId: string; rule: Rule | null; onClose: () => void; onSaved: () => void }) {
  const { fields, devices } = useChannel();
  const dataFields = (fields ?? []).filter((f) => f.kind === 'data');
  const [name, setName] = useState(rule?.name ?? '');
  const [type, setType] = useState<Rule['ruleType']>(rule?.ruleType ?? 'threshold');
  const [metric, setMetric] = useState(rule?.metricKey ?? dataFields[0]?.metricKey ?? '');
  const [op, setOp] = useState(rule?.operator ?? '>');
  const [threshold, setThreshold] = useState(rule?.threshold?.toString() ?? '');
  const [forMin, setForMin] = useState(((rule?.forSeconds ?? 0) / 60).toString());
  const [staleMin, setStaleMin] = useState(((rule?.staleSeconds ?? 600) / 60).toString());
  const [deviceId, setDeviceId] = useState(rule?.deviceId ?? '');
  const [severity, setSeverity] = useState<Rule['severity']>(rule?.severity ?? 'warning');
  const [cooldownMin, setCooldownMin] = useState(((rule?.cooldownSeconds ?? 300) / 60).toString());
  const [emails, setEmails] = useState(rule?.notifyEmails.join(', ') ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const unit = fields?.find((f) => f.metricKey === metric)?.unit;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const notifyEmails = emails.split(/[\s,;]+/).filter(Boolean);
    const common = {
      name: name.trim(),
      severity,
      cooldownSeconds: Math.round(Number(cooldownMin) * 60),
      notifyEmails,
      forSeconds: type === 'threshold' ? Math.round(Number(forMin) * 60) : 0,
      ...(type === 'threshold' ? { operator: op, threshold: Number(threshold) } : {}),
      ...(type === 'stale' ? { staleSeconds: Math.round(Number(staleMin) * 60) } : {}),
    };
    try {
      if (rule) await api('PATCH', `/rules/${rule.id}`, common);
      else await api('POST', '/rules', { ...common, projectId, ruleType: type, deviceId: deviceId || null, ...(type === 'threshold' ? { metricKey: metric } : {}) });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={rule ? `Edit “${rule.name}”` : 'New rule'}
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="rule-form" disabled={busy}>
            Save rule
          </button>
        </>
      }
    >
      <form id="rule-form" className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Greenhouse too hot" />
        </label>
        <div className="form-row">
          <label className="field">
            Alert when
            <select value={type} onChange={(e) => setType(e.target.value as Rule['ruleType'])} disabled={!!rule}>
              <option value="threshold">A reading crosses a limit</option>
              <option value="stale">No data arrives for a while</option>
              <option value="offline">A device goes offline</option>
            </select>
          </label>
          <label className="field">
            Devices
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={!!rule}>
              <option value="">Every device in this channel</option>
              {devices?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {type === 'threshold' && (
          <div className="form-row">
            <label className="field">
              Field
              <select value={metric} onChange={(e) => setMetric(e.target.value)} disabled={!!rule} required>
                {dataFields.map((f) => (
                  <option key={f.metricKey} value={f.metricKey}>
                    {f.label || f.metricKey}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Condition
              <select value={op} onChange={(e) => setOp(e.target.value)}>
                {OPS.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.text}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Value {unit && <span className="hint">{unit}</span>}
              <input type="number" step="any" value={threshold} onChange={(e) => setThreshold(e.target.value)} required />
            </label>
            <label className="field">
              For at least <span className="hint">minutes, 0 = at once</span>
              <input type="number" min={0} max={1440} step="any" value={forMin} onChange={(e) => setForMin(e.target.value)} />
            </label>
          </div>
        )}
        {type === 'stale' && (
          <label className="field">
            No data for <span className="hint">minutes (at least 1)</span>
            <input type="number" min={1} max={10080} step="any" value={staleMin} onChange={(e) => setStaleMin(e.target.value)} required />
          </label>
        )}
        {type === 'offline' && <p className="muted small">Uses the device’s online/offline status: a broker disconnect, or no data for 3× its reporting interval.</p>}
        <div className="form-row">
          <label className="field">
            Severity
            <select value={severity} onChange={(e) => setSeverity(e.target.value as Rule['severity'])}>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label className="field">
            Quiet period <span className="hint">minutes before it can alert again</span>
            <input type="number" min={0} max={1440} step="any" value={cooldownMin} onChange={(e) => setCooldownMin(e.target.value)} />
          </label>
        </div>
        <label className="field">
          Email <span className="hint">addresses to notify, separated by commas (optional)</span>
          <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="you@arclabs.in, team@arclabs.in" />
        </label>
      </form>
    </Modal>
  );
}
