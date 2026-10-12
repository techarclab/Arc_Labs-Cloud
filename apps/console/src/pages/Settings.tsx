import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, canEdit, Field, Reading } from '../api';
import { ErrorBox, useToast } from '../components/ui';
import { metricLabel } from '../format';
import { useSession } from '../session';
import { useChannel } from './Channel';

const MAX_FIELDS = 16;

type Row = {
  position: number;
  metricKey: string;
  label: string;
  unit: string;
  kind: 'data' | 'control';
  minValue: string;
  maxValue: string;
  decimals: number;
  step: string;
  keyTouched?: boolean;
};

const toRow = (f: Field): Row => ({
  position: f.position,
  metricKey: f.metricKey,
  label: f.label,
  unit: f.unit,
  kind: f.kind,
  minValue: f.minValue?.toString() ?? '',
  maxValue: f.maxValue?.toString() ?? '',
  decimals: f.decimals,
  step: f.step?.toString() ?? '',
  keyTouched: true,
});

export function SettingsPage() {
  const { orgId = '', projectId = '' } = useParams();
  const { org, project, fields, reloadFields, devices } = useChannel();
  const { refreshProjects } = useSession();
  const toast = useToast();
  const editable = canEdit(org?.role);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [received, setReceived] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<unknown>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description);
    }
  }, [project]);
  useEffect(() => {
    if (fields && !dirty) setRows(fields.map(toRow));
  }, [fields, dirty]);

  // Readings devices have sent that aren't fields yet.
  useEffect(() => {
    if (!devices?.length) return;
    Promise.all(devices.slice(0, 20).map((d) => api<{ items: Reading[] }>('GET', `/devices/${d.id}/telemetry/latest`).catch(() => ({ items: [] }))))
      .then((rs) => setReceived([...new Set(rs.flatMap((r) => r.items.map((i) => i.metric)))].sort()))
      .catch(() => undefined);
  }, [devices]);

  const unmapped = useMemo(() => received.filter((k) => !rows.some((r) => r.metricKey === k)), [received, rows]);
  const nextPosition = () => {
    for (let i = 1; i <= MAX_FIELDS; i++) if (!rows.some((r) => r.position === i)) return i;
    return null;
  };

  function update(i: number, patch: Partial<Row>) {
    setDirty(true);
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        // Keep the default "fieldN" name in step with the field number until the user types their own.
        if (patch.position && !r.keyTouched && /^field\d+$/.test(r.metricKey)) next.metricKey = `field${patch.position}`;
        return next;
      }),
    );
  }

  function addField(preset?: Partial<Row>) {
    const pos = nextPosition();
    if (!pos) return;
    setDirty(true);
    setRows((rs) =>
      [...rs, { position: pos, metricKey: `field${pos}`, label: `Field ${pos}`, unit: '', kind: 'data' as const, minValue: '', maxValue: '', decimals: 2, step: '', ...preset }].sort((a, b) => a.position - b.position),
    );
  }

  async function saveChannel(e: FormEvent) {
    e.preventDefault();
    try {
      await api('PATCH', `/projects/${projectId}`, { name, description });
      await refreshProjects(orgId);
      setError(null);
      toast('Channel saved');
    } catch (err) {
      setError(err);
    }
  }

  async function saveFields(e: FormEvent) {
    e.preventDefault();
    try {
      const n = (s: string) => (s.trim() === '' ? null : Number(s));
      await api('PUT', `/projects/${projectId}/fields`, {
        metrics: rows.map((r) => ({
          metricKey: r.metricKey.trim(),
          label: r.label.trim() || r.metricKey.trim(),
          unit: r.unit.trim(),
          kind: r.kind,
          position: r.position,
          minValue: n(r.minValue),
          maxValue: n(r.maxValue),
          decimals: r.decimals,
          step: n(r.step),
        })),
      });
      setDirty(false);
      await reloadFields();
      setFieldError(null);
      toast('Fields saved');
    } catch (err) {
      setFieldError(err);
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Fields</h2>
            <p className="small muted" style={{ marginTop: 4, maxWidth: '78ch' }}>
              Up to {MAX_FIELDS} fields per channel. <b>Sensor</b> fields are values devices send, like temperature. <b>Control</b> fields are values you send to devices from a switch or slider, like a relay. Devices can
              send a field by its number (<code>field1</code>) or its name.
            </p>
          </div>
        </div>
        <form className="panel-body form" onSubmit={saveFields}>
          {rows.length > 0 && (
            <div className="table-wrap">
              <table className="grid fields-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Label</th>
                    <th>Name in firmware</th>
                    <th>Kind</th>
                    <th>Unit</th>
                    <th>Min</th>
                    <th>Max</th>
                    <th>Decimals</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td style={{ width: 92 }}>
                        <select value={r.position} onChange={(e) => update(i, { position: Number(e.target.value) })} disabled={!editable} aria-label="Field number">
                          {Array.from({ length: MAX_FIELDS }, (_, k) => k + 1)
                            .filter((n) => n === r.position || !rows.some((x) => x.position === n))
                            .map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                        </select>
                      </td>
                      <td>
                        <input required value={r.label} onChange={(e) => update(i, { label: e.target.value })} disabled={!editable} aria-label="Label" />
                      </td>
                      <td>
                        <input
                          required
                          pattern="[A-Za-z][A-Za-z0-9_]{0,63}"
                          title="Letters, digits and _ ; start with a letter"
                          className="mono"
                          value={r.metricKey}
                          onChange={(e) => update(i, { metricKey: e.target.value, keyTouched: true })}
                          disabled={!editable}
                          aria-label="Name in firmware"
                        />
                      </td>
                      <td style={{ width: 120 }}>
                        <select value={r.kind} onChange={(e) => update(i, { kind: e.target.value as Row['kind'] })} disabled={!editable} aria-label="Kind">
                          <option value="data">Sensor</option>
                          <option value="control">Control</option>
                        </select>
                      </td>
                      <td style={{ width: 80 }}>
                        <input value={r.unit} onChange={(e) => update(i, { unit: e.target.value })} disabled={!editable} aria-label="Unit" />
                      </td>
                      <td style={{ width: 90 }}>
                        <input type="number" step="any" value={r.minValue} onChange={(e) => update(i, { minValue: e.target.value })} disabled={!editable} aria-label="Minimum" />
                      </td>
                      <td style={{ width: 90 }}>
                        <input type="number" step="any" value={r.maxValue} onChange={(e) => update(i, { maxValue: e.target.value })} disabled={!editable} aria-label="Maximum" />
                      </td>
                      <td style={{ width: 80 }}>
                        <input type="number" min={0} max={6} value={r.decimals} onChange={(e) => update(i, { decimals: Number(e.target.value) })} disabled={!editable} aria-label="Decimals" />
                      </td>
                      <td>
                        {editable && (
                          <button
                            type="button"
                            className="btn small quiet"
                            onClick={() => {
                              setDirty(true);
                              setRows(rows.filter((_, j) => j !== i));
                            }}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {rows.length === 0 && <p className="muted">No fields yet. Until you add some, this channel accepts any reading a device sends.</p>}
          {rows.length > 0 && (
            <p className="small muted">Readings a device sends that aren’t listed here are rejected. Values outside min/max are rejected too, and controls are kept inside that range.</p>
          )}

          {editable && unmapped.length > 0 && (
            <div className="note">
              Your devices are sending readings that aren’t fields yet:{' '}
              {unmapped.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="btn small"
                  style={{ margin: '4px 6px 0 0' }}
                  onClick={() => {
                    const m = metricLabel(k);
                    addField({ metricKey: k, label: m.label, unit: m.unit, keyTouched: true });
                  }}
                >
                  Add {k}
                </button>
              ))}
              {rows.length === 0 && <div style={{ marginTop: 6 }}>Add all of them before saving, or their data will start being rejected.</div>}
            </div>
          )}

          <ErrorBox error={fieldError} />
          {editable && (
            <div className="row">
              <button type="button" className="btn" onClick={() => addField()} disabled={rows.length >= MAX_FIELDS}>
                Add field
              </button>
              <button type="button" className="btn" onClick={() => addField({ kind: 'control', label: 'Relay', metricKey: 'relay', minValue: '0', maxValue: '1', decimals: 0, step: '1', keyTouched: true })} disabled={rows.length >= MAX_FIELDS || rows.some((r) => r.metricKey === 'relay')}>
                Add a relay control
              </button>
              <button className="btn primary" type="submit" disabled={!dirty}>
                Save fields
              </button>
              {dirty && <span className="small muted">Unsaved changes</span>}
            </div>
          )}
        </form>
      </section>

      <section className="panel" style={{ marginTop: 20, maxWidth: 720 }}>
        <div className="panel-head">
          <h2>Channel</h2>
        </div>
        <form className="panel-body form" onSubmit={saveChannel}>
          <label className="field">
            Name
            <input required value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} />
          </label>
          <label className="field">
            Description
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} />
          </label>
          <ErrorBox error={error} />
          {editable && (
            <div>
              <button className="btn primary" type="submit">
                Save channel
              </button>
            </div>
          )}
        </form>
      </section>
    </>
  );
}
