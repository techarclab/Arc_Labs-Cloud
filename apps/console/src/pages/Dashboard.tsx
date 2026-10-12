import { DragEvent, FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, canEdit, Control, Field, Reading, Widget } from '../api';
import { ErrorBox, Modal, Status, useNow, usePoll, useToast } from '../components/ui';
import { Ctx, defaultsFor, GROUPS, Group, SPEC, WidgetSpec, WIDGETS } from '../components/widgetRegistry';
import { useChannel } from './Channel';

const newId = () => Math.random().toString(36).slice(2, 10);

function make(spec: WidgetSpec, f?: Field, size?: Widget['size'], all: Field[] = []): Widget {
  const options = defaultsFor(spec, f);
  const others = all.filter((x) => x.kind === 'data' && x.metricKey !== f?.metricKey);
  // Preselect a sensible second field for two-field widgets.
  if (spec.type === 'scatter' && !options.xField && others[0]) options.xField = others[0].metricKey;
  if (spec.type === 'map' && !options.lngField) options.lngField = (others.find((x) => /^(lng|lon|long|longitude)$/i.test(x.metricKey)) ?? others[0])?.metricKey ?? '';
  return { id: newId(), type: spec.type as Widget['type'], title: spec.fieldKind === 'none' ? spec.name : f?.label ?? spec.name, field: f?.metricKey ?? '', size: size ?? spec.size, options };
}

/** One widget per field, plus a few richer views, so a new channel starts with something useful. */
function starterWidgets(fields: Field[]): Widget[] {
  const out: Widget[] = [];
  for (const f of fields.filter((x) => x.kind === 'control')) {
    out.push(make(SPEC.get(f.minValue === 0 && f.maxValue === 1 ? 'switch' : 'slider')!, f));
  }
  const data = fields.filter((f) => f.kind === 'data');
  data.slice(0, 4).forEach((f, i) => out.push(make(SPEC.get(i === 0 ? 'stat' : f.minValue !== null && f.maxValue !== null ? 'gauge' : 'value')!, f)));
  if (data[0]) {
    const chart = make(SPEC.get('chart')!, data[0], data.length > 1 ? 'l' : 'xl');
    out.push(chart);
  }
  if (data[1]) out.push(make(SPEC.get('chart')!, data[1], 'l'));
  if (data[0]) out.push(make(SPEC.get('stats')!, data[0], 'l'));
  if (data[0] && data[1]) out.push({ ...make(SPEC.get('scatter')!, data[1]), options: { xField: data[0].metricKey, range: '24h' } });
  if (data[0]) out.push(make(SPEC.get('heatmap')!, data[0], data[0] && data[1] ? 'l' : 'xl'));
  return out;
}

export function DashboardPage() {
  const { orgId = '', projectId = '' } = useParams();
  const { org, fields, devices } = useChannel();
  const toast = useToast();
  const now = useNow();
  const editable = canEdit(org?.role);

  const [widgets, setWidgets] = useState<Widget[] | null>(null);
  const [draft, setDraft] = useState<Widget[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [deviceId, setDeviceId] = useState<string>('');
  const [latest, setLatest] = useState<Reading[]>([]);
  const [controls, setControls] = useState<Control[]>([]);
  const [editingWidget, setEditingWidget] = useState<Widget | 'new' | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const editing = draft !== null;
  const shown = draft ?? widgets ?? [];
  const fieldBy = useMemo(() => new Map((fields ?? []).map((f) => [f.metricKey, f])), [fields]);
  const device = devices?.find((d) => d.id === deviceId);

  useEffect(() => {
    api<{ widgets: Widget[] }>('GET', `/projects/${projectId}/dashboard`)
      .then((r) => setWidgets(r.widgets))
      .catch((e) => {
        setError(e);
        setWidgets([]);
      });
    setDraft(null);
  }, [projectId]);

  useEffect(() => {
    if (!devices?.length || devices.some((d) => d.id === deviceId)) return;
    let remembered = '';
    try {
      remembered = localStorage.getItem(`arc.dash.${projectId}`) ?? '';
    } catch {
      /* ignore */
    }
    const pick = devices.find((d) => d.id === remembered) ?? devices.find((d) => d.connectivity.status === 'online') ?? devices[0];
    setDeviceId(pick.id);
  }, [devices, deviceId, projectId]);

  const loadLive = useCallback(async () => {
    if (!deviceId) return;
    const [l, c] = await Promise.all([api<{ items: Reading[] }>('GET', `/devices/${deviceId}/telemetry/latest`), api<{ items: Control[] }>('GET', `/devices/${deviceId}/controls`)]);
    setLatest(l.items);
    setControls(c.items);
  }, [deviceId]);
  usePoll(() => loadLive().catch(() => undefined), 4000, [loadLive]);

  const setControl = useCallback(
    async (field: string, value: number) => {
      setControls((cs) => [...cs.filter((c) => c.field !== field), { field, value, updatedAt: new Date().toISOString() }]);
      try {
        const r = await api('POST', `/devices/${deviceId}/controls`, { field, value });
        if (!r.pushedOverMqtt) toast('Saved. The device gets it the next time it checks in.');
      } catch (e) {
        setError(e);
        void loadLive();
      }
    },
    [deviceId, toast, loadLive],
  );

  async function save() {
    try {
      const r = await api<{ widgets: Widget[] }>('PUT', `/projects/${projectId}/dashboard`, { widgets: draft });
      setWidgets(r.widgets);
      setDraft(null);
      setError(null);
      toast('Dashboard saved');
    } catch (e) {
      setError(e);
    }
  }

  function onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    if (!draft || !dragId || dragId === targetId) return;
    const next = [...draft];
    const [moved] = next.splice(next.findIndex((w) => w.id === dragId), 1);
    next.splice(next.findIndex((w) => w.id === targetId), 0, moved);
    setDraft(next);
    setDragId(null);
  }

  function move(id: string, by: number) {
    if (!draft) return;
    const i = draft.findIndex((w) => w.id === id);
    const j = i + by;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  }

  const latestMap = useMemo(() => new Map(latest.map((r) => [r.metric, r])), [latest]);
  const ctrl = new Map(controls.map((c) => [c.field, c.value]));
  const noFields = fields !== null && fields.length === 0;

  return (
    <>
      <div className="dash-bar">
        {devices && devices.length > 0 ? (
          <label className="row" style={{ gap: 10 }}>
            <span className="muted">Showing</span>
            <select
              value={deviceId}
              onChange={(e) => {
                setDeviceId(e.target.value);
                setLatest([]);
                setControls([]);
                try {
                  localStorage.setItem(`arc.dash.${projectId}`, e.target.value);
                } catch {
                  /* ignore */
                }
              }}
              style={{ width: 'auto', minWidth: 220 }}
              aria-label="Device"
            >
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.displayName}
                </option>
              ))}
            </select>
            {device && <Status c={device.connectivity} />}
            {device && (
              <Link className="small" to={`/o/${orgId}/p/${projectId}/devices/${device.id}`}>
                Device details
              </Link>
            )}
          </label>
        ) : (
          <span />
        )}
        {editable && (
          <div className="row">
            {editing ? (
              <>
                <button className="btn" onClick={() => setEditingWidget('new')} disabled={!fields?.length}>
                  Add widget
                </button>
                <button className="btn quiet" onClick={() => setDraft(null)}>
                  Cancel
                </button>
                <button className="btn primary" onClick={save}>
                  Save dashboard
                </button>
              </>
            ) : (
              <button className="btn" onClick={() => setDraft(widgets ?? [])} disabled={noFields}>
                Edit dashboard
              </button>
            )}
          </div>
        )}
      </div>

      <ErrorBox error={error} />

      {noFields && (
        <div className="panel empty">
          <h3>Set up this channel’s fields first</h3>
          <p>Fields are the values your devices send (like temperature) and the controls they receive (like a relay). Widgets show and change those fields.</p>
          <Link className="btn primary" to={`/o/${orgId}/p/${projectId}/settings`}>
            Set up fields
          </Link>
        </div>
      )}

      {!noFields && devices?.length === 0 && (
        <div className="note" style={{ marginBottom: 16 }}>
          No devices in this channel yet. <Link to={`/o/${orgId}/p/${projectId}/devices`}>Add a device</Link> to see live values here.
        </div>
      )}

      {!noFields && widgets !== null && shown.length === 0 && (
        <div className="panel empty">
          <h3>This dashboard is empty</h3>
          <p>Choose from {WIDGETS.length} widget types, or start with a ready-made set for this channel’s fields.</p>
          {editable && fields && (
            <div className="row">
              <button className="btn primary" onClick={() => setDraft(starterWidgets(fields))}>
                Create a starter dashboard
              </button>
              <button
                className="btn"
                onClick={() => {
                  setDraft([]);
                  setEditingWidget('new');
                }}
              >
                Add one widget
              </button>
            </div>
          )}
        </div>
      )}

      {editing && shown.length > 0 && <p className="small muted" style={{ marginBottom: 10 }}>Drag widgets (or use the arrows) to reorder them. Changes aren’t saved until you press Save dashboard.</p>}

      <div className="dash-grid">
        {shown.map((w, idx) => {
          const spec = SPEC.get(w.type);
          const f = fieldBy.get(w.field);
          const missing = spec && spec.fieldKind !== 'none' && !f;
          const ctx: Ctx = {
            deviceId,
            devices: devices ?? [],
            fields: fields ?? [],
            field: f,
            reading: latestMap.get(w.field),
            latest: latestMap,
            control: ctrl.get(w.field) ?? null,
            canControl: editable && !editing && !!device,
            setControl,
            now,
          };
          return (
            <section
              key={w.id}
              className={`widget size-${w.size} type-${w.type}${editing ? ' editing' : ''}${dragId === w.id ? ' dragging' : ''}`}
              draggable={editing}
              onDragStart={() => setDragId(w.id)}
              onDragOver={(e) => editing && e.preventDefault()}
              onDrop={(e) => onDrop(e, w.id)}
              onDragEnd={() => setDragId(null)}
            >
              <header>
                <h3>{w.title || f?.label || spec?.name}</h3>
                {editing && (
                  <div className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
                    <button className="btn small quiet" onClick={() => move(w.id, -1)} disabled={idx === 0} aria-label="Move earlier">
                      ←
                    </button>
                    <button className="btn small quiet" onClick={() => move(w.id, 1)} disabled={idx === shown.length - 1} aria-label="Move later">
                      →
                    </button>
                    <button className="btn small quiet" onClick={() => setEditingWidget(w)}>
                      Edit
                    </button>
                    <button className="btn small quiet danger" onClick={() => setDraft(draft!.filter((x) => x.id !== w.id))}>
                      Remove
                    </button>
                  </div>
                )}
              </header>
              <div className="widget-body">
                {!spec && <p className="muted small">Unknown widget type “{w.type}”.</p>}
                {missing && <p className="muted small">Field “{w.field}” no longer exists in this channel.</p>}
                {spec && !missing && (deviceId || spec.fieldKind === 'none' || w.type === 'compare' || w.type === 'map' ? spec.render(w, ctx) : <p className="muted small">Add a device to see data.</p>)}
              </div>
            </section>
          );
        })}
      </div>

      {editingWidget && fields && (
        <WidgetDialog
          widget={editingWidget === 'new' ? null : editingWidget}
          fields={fields}
          onClose={() => setEditingWidget(null)}
          onSave={(w) => {
            setDraft((d) => {
              const list = d ?? [];
              return list.some((x) => x.id === w.id) ? list.map((x) => (x.id === w.id ? w : x)) : [...list, w];
            });
            setEditingWidget(null);
          }}
        />
      )}
    </>
  );
}

function WidgetDialog({ widget, fields, onClose, onSave }: { widget: Widget | null; fields: Field[]; onClose: () => void; onSave: (w: Widget) => void }) {
  const [group, setGroup] = useState<Group>(widget ? SPEC.get(widget.type)?.group ?? 'Values' : 'Values');
  const [w, setW] = useState<Widget>(() => widget ?? make(WIDGETS[0], fields.find((f) => f.kind === 'data')));
  const spec = SPEC.get(w.type)!;
  const fieldChoices = spec.fieldKind === 'none' ? [] : fields.filter((f) => f.kind === spec.fieldKind);

  function pickType(s: WidgetSpec) {
    const choices = s.fieldKind === 'none' ? [] : fields.filter((f) => f.kind === s.fieldKind);
    const f = (s.type === 'map' ? choices.find((x) => /^(lat|latitude)$/i.test(x.metricKey)) : undefined) ?? choices.find((x) => x.metricKey === w.field) ?? choices[0];
    const keepTitle = w.title && w.title !== (fields.find((x) => x.metricKey === w.field)?.label ?? '') && w.title !== SPEC.get(w.type)?.name;
    setW({ ...make(s, f, undefined, fields), id: w.id, title: keepTitle ? w.title : s.fieldKind === 'none' ? s.name : f?.label ?? s.name });
  }
  function pickField(key: string) {
    const f = fields.find((x) => x.metricKey === key);
    const autoTitle = !w.title || w.title === fields.find((x) => x.metricKey === w.field)?.label;
    setW({ ...w, field: key, title: autoTitle ? f?.label ?? w.title : w.title, options: { ...defaultsFor(spec, f), ...Object.fromEntries(Object.entries(w.options).filter(([k]) => spec.options.find((o) => o.key === k)?.kind === 'select' || spec.options.find((o) => o.key === k)?.kind === 'text' || spec.options.find((o) => o.key === k)?.kind === 'longtext')) } });
  }
  const setOpt = (k: string, v: string | number) => setW((p) => ({ ...p, options: { ...p.options, [k]: v } }));

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(w);
  }

  const inGroup = WIDGETS.filter((s) => s.group === group);
  const unusable = spec.fieldKind !== 'none' && !fieldChoices.length;

  return (
    <Modal
      open
      onClose={onClose}
      title={widget ? 'Edit widget' : 'Add a widget'}
      wide
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="widget-form" disabled={unusable}>
            {widget ? 'Apply' : 'Add widget'}
          </button>
        </>
      }
    >
      <div className="tabs" role="tablist">
        {GROUPS.map((g) => (
          <button key={g.id} role="tab" aria-selected={group === g.id} onClick={() => setGroup(g.id)} title={g.help}>
            {g.id}
          </button>
        ))}
      </div>
      <div className="type-picker" role="radiogroup" aria-label="Widget type">
        {inGroup.map((s) => (
          <button key={s.type} type="button" role="radio" aria-checked={w.type === s.type} className="type-card" onClick={() => pickType(s)}>
            {s.icon}
            <b>{s.name}</b>
          </button>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: -4 }}>
        {spec.help}
      </p>

      {unusable ? (
        <div className="note">
          {spec.fieldKind === 'control'
            ? 'This channel has no control fields. Add one in Channel settings (choose “Control” as the kind), then come back.'
            : 'This channel has no sensor fields yet. Add them in Channel settings.'}
        </div>
      ) : (
        <form id="widget-form" className="form" onSubmit={submit}>
          <div className="form-row">
            {spec.fieldKind !== 'none' && (
              <label className="field">
                {w.type === 'map' ? 'Latitude field' : 'Field'}
                <select value={w.field} onChange={(e) => pickField(e.target.value)}>
                  {fieldChoices.map((f) => (
                    <option key={f.metricKey} value={f.metricKey}>
                      Field {f.position}: {f.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              Title
              <input value={w.title} onChange={(e) => setW({ ...w, title: e.target.value })} maxLength={80} />
            </label>
            <label className="field">
              Size
              <select value={w.size} onChange={(e) => setW({ ...w, size: e.target.value as Widget['size'] })}>
                <option value="s">Small (quarter width)</option>
                <option value="m">Medium (third)</option>
                <option value="l">Large (half)</option>
                <option value="xl">Full width</option>
              </select>
            </label>
          </div>

          {spec.options.length > 0 && (
            <div className="form-row">
              {spec.options.map((o) => (
                <label key={o.key} className="field" style={o.kind === 'longtext' ? { gridColumn: '1 / -1' } : undefined}>
                  {o.label}
                  {o.hint && <span className="hint">{o.hint}</span>}
                  {o.kind === 'number' && (
                    <input type="number" step="any" value={w.options[o.key] === null || w.options[o.key] === undefined ? '' : String(w.options[o.key])} onChange={(e) => setOpt(o.key, e.target.value === '' ? '' : Number(e.target.value))} />
                  )}
                  {o.kind === 'text' && <input value={String(w.options[o.key] ?? '')} maxLength={200} onChange={(e) => setOpt(o.key, e.target.value)} />}
                  {o.kind === 'longtext' && <textarea rows={4} maxLength={500} value={String(w.options[o.key] ?? '')} onChange={(e) => setOpt(o.key, e.target.value)} />}
                  {o.kind === 'select' && (
                    <select value={String(w.options[o.key] ?? '')} onChange={(e) => setOpt(o.key, e.target.value)}>
                      {o.choices!.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  )}
                  {o.kind === 'field' && (
                    <select value={String(w.options[o.key] ?? '')} onChange={(e) => setOpt(o.key, e.target.value)}>
                      <option value="">{o.key === 'xField' || o.key === 'lngField' ? 'Choose a field' : 'None'}</option>
                      {fields
                        .filter((f) => f.kind === (o.fieldKind ?? 'data') && f.metricKey !== w.field)
                        .map((f) => (
                          <option key={f.metricKey} value={f.metricKey}>
                            Field {f.position}: {f.label}
                          </option>
                        ))}
                    </select>
                  )}
                </label>
              ))}
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
