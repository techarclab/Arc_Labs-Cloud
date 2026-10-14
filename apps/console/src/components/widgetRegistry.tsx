/**
 * Every dashboard widget type: what it's called, which fields it works with, its settings,
 * and how it renders. The dashboard and the "Add widget" dialog are both driven from this list.
 */
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api, Device, Field, Reading, Widget } from '../api';
import { ago, num } from '../format';
import { usePoll } from './ui';
import { Battery, HBarChart, Heatmap, Histogram, Legend, Meter, Pt, Ring, Scatter, SERIES, Sparkline, Tank, Thermometer, TimeChart, TimeStyle } from './viz';
import { fmt, GaugeWidget, IndicatorWidget, SliderWidget, SwitchWidget, ValueWidget } from './widgets';
import { BOARD_TEMPLATES, BoardFrame } from './customBoard';

// ------------------------------------------------------------------ types

export type Group = 'Values' | 'Charts' | 'Controls' | 'Templates' | 'Other';
export const GROUPS: { id: Group; help: string }[] = [
  { id: 'Values', help: 'Show the latest reading' },
  { id: 'Charts', help: 'Show readings over time' },
  { id: 'Controls', help: 'Send values to the device' },
  { id: 'Templates', help: 'Your own board designed in HTML and CSS' },
  { id: 'Other', help: 'Notes and labels' },
];

type OptValue = string | number | boolean | null;
export interface OptSpec {
  key: string;
  label: string;
  kind: 'number' | 'text' | 'longtext' | 'select' | 'field';
  choices?: [string, string][];
  hint?: string;
  fieldKind?: 'data' | 'control';
  def: (f?: Field) => OptValue;
}

export interface Ctx {
  deviceId: string;
  devices: Device[];
  fields: Field[];
  field?: Field;
  reading?: Reading;
  latest: Map<string, Reading>;
  control: number | null;
  controls: Map<string, number>;
  canControl: boolean;
  setControl: (field: string, value: number) => void;
  now: number;
}

export interface WidgetSpec {
  type: string;
  name: string;
  group: Group;
  help: string;
  fieldKind: 'data' | 'control' | 'none';
  size: Widget['size'];
  options: OptSpec[];
  icon: ReactNode;
  render: (w: Widget, c: Ctx) => ReactNode;
}

// ------------------------------------------------------------------ data hooks

export const RANGE_CHOICES: [string, string][] = [
  ['1h', 'Last hour'],
  ['6h', 'Last 6 hours'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
];
const RANGE: Record<string, { ms: number; chart: string | null; dense: string | null; poll: number }> = {
  '1h': { ms: 3600e3, chart: null, dense: null, poll: 6000 },
  '6h': { ms: 6 * 3600e3, chart: '5m', dense: null, poll: 20_000 },
  '24h': { ms: 86400e3, chart: '15m', dense: '1m', poll: 60_000 },
  '7d': { ms: 7 * 86400e3, chart: '1h', dense: '15m', poll: 120_000 },
  '30d': { ms: 30 * 86400e3, chart: '6h', dense: '1h', poll: 300_000 },
};
const BUCKET_MS: Record<string, number> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '6h': 6 * 3600e3, '1d': 86400e3 };

interface SeriesResult {
  series: Record<string, Pt[]>;
  from: Date;
  to: Date;
  bucket: string | null;
}

/** Readings over a time range for one device. `dense` keeps more points (for histograms/scatter/tables). */
export function useSeries(deviceId: string, fields: string[], range: string, opts: { agg?: string; dense?: boolean; bucket?: string } = {}) {
  const [data, setData] = useState<SeriesResult | null>(null);
  const key = fields.filter(Boolean).join(',');
  const r = RANGE[range] ?? RANGE['1h'];
  const bucket = opts.bucket ?? (opts.dense ? r.dense : r.chart);
  const load = useCallback(async () => {
    if (!deviceId || !key) return;
    const to = new Date();
    const from = new Date(to.getTime() - r.ms);
    const q = `metric=${key}&from=${from.toISOString()}&to=${to.toISOString()}${bucket ? `&bucket=${bucket}&agg=${opts.agg ?? 'avg'}` : ''}`;
    const res = await api('GET', `/devices/${deviceId}/telemetry?${q}`);
    setData({ series: res.series, from, to, bucket });
  }, [deviceId, key, r.ms, bucket, opts.agg]);
  useEffect(() => setData(null), [deviceId, key, range]);
  usePoll(() => load().catch(() => undefined), r.poll, [load]);
  return data;
}

function useAllDevicesLatest(devices: Device[]) {
  const [rows, setRows] = useState<Record<string, Reading[]>>({});
  const ids = devices.map((d) => d.id).join(',');
  const load = useCallback(async () => {
    const list = devices.slice(0, 50);
    const res = await Promise.all(list.map((d) => api<{ items: Reading[] }>('GET', `/devices/${d.id}/telemetry/latest`).then((r) => r.items).catch(() => [])));
    setRows(Object.fromEntries(list.map((d, i) => [d.id, res[i]])));
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  usePoll(() => load().catch(() => undefined), 10_000, [load]);
  return rows;
}

const gapFor = (r: SeriesResult | null, intervalMs = 60e3) => (r?.bucket ? BUCKET_MS[r.bucket] * 2.5 : Math.max(intervalMs * 3, 5 * 60e3));
const frac = (v: number | undefined, lo: number, hi: number) => (v === undefined ? 0 : (v - lo) / (hi - lo || 1));
const nOpt = (w: Widget, k: string, d: number) => (w.options[k] === undefined || w.options[k] === null || w.options[k] === '' ? d : Number(w.options[k]));
const sOpt = (w: Widget, k: string, d: string) => (w.options[k] === undefined || w.options[k] === null ? d : String(w.options[k]));
const lo = (f?: Field) => f?.minValue ?? 0;
const hi = (f?: Field, d = 100) => f?.maxValue ?? d;

function parseMapping(s: string): { value: number; label: string }[] {
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [v, ...rest] = p.split(':');
      return { value: Number(v), label: rest.join(':').trim() || v };
    })
    .filter((m) => Number.isFinite(m.value));
}

function When({ r, now }: { r?: Reading; now: number }) {
  return <div className="muted small w-when">{r ? ago(r.ts, now) : 'No data yet'}</div>;
}

function BigValue({ v, f }: { v?: number; f?: Field }) {
  return (
    <div className="big">
      {fmt(v, f)}
      {f?.unit && <span className="unit">{f.unit}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ chart widgets (own data)

function ChartView({ w, c }: { w: Widget; c: Ctx }) {
  const extra = sOpt(w, 'field2', '');
  const extra3 = sOpt(w, 'field3', '');
  const keys = [w.field, extra, extra3].filter((k, i, a) => k && a.indexOf(k) === i);
  const range = sOpt(w, 'range', '1h');
  const style = sOpt(w, 'style', 'line') as TimeStyle;
  const agg = sOpt(w, 'agg', 'avg');
  const d = useSeries(c.deviceId, keys, range, { agg });
  const label = (k: string) => c.fields.find((f) => f.metricKey === k)?.label ?? k;
  const height = w.size === 'xl' || w.size === 'l' ? 230 : 170;
  return (
    <>
      <Legend items={keys.map((k, i) => ({ label: label(k), color: SERIES[i] }))} />
      <TimeChart
        series={keys.map((k) => ({ label: label(k), points: d?.series[k] ?? [], unit: c.fields.find((f) => f.metricKey === k)?.unit ?? '' }))}
        from={d?.from ?? new Date(Date.now() - 3600e3)}
        to={d?.to ?? new Date()}
        style={keys.length > 1 && style === 'bars' ? 'line' : style}
        unit={c.field?.unit ?? ''}
        height={height}
        gapMs={gapFor(d)}
      />
    </>
  );
}

const AGO: Record<string, string> = { '1h': '1 hour ago', '6h': '6 hours ago', '24h': '24 hours ago', '7d': '7 days ago', '30d': '30 days ago' };

function StatView({ w, c }: { w: Widget; c: Ctx }) {
  const range = sOpt(w, 'range', '1h');
  const d = useSeries(c.deviceId, [w.field], range);
  const pts = d?.series[w.field] ?? [];
  const first = pts[0]?.value;
  const v = c.reading?.value;
  const delta = v !== undefined && first !== undefined ? v - first : null;
  return (
    <div>
      <BigValue v={v} f={c.field} />
      <div className="small" style={{ marginTop: 4 }}>
        {delta === null ? (
          <span className="muted">No change data yet</span>
        ) : (
          <span className={delta === 0 ? 'muted' : ''}>
            {delta > 0 ? '▲ up' : delta < 0 ? '▼ down' : 'no change'} {delta !== 0 && `${num(Math.abs(delta))} ${c.field?.unit ?? ''}`} <span className="muted">vs {AGO[range] ?? 'earlier'}</span>
          </span>
        )}
      </div>
      <Sparkline points={pts} />
    </div>
  );
}

function StatsView({ w, c }: { w: Widget; c: Ctx }) {
  const range = sOpt(w, 'range', '24h');
  const d = useSeries(c.deviceId, [w.field], range, { dense: true });
  const vs = (d?.series[w.field] ?? []).map((p) => p.value);
  const items: [string, number | undefined][] = vs.length
    ? [
        ['Lowest', Math.min(...vs)],
        ['Average', vs.reduce((a, b) => a + b, 0) / vs.length],
        ['Highest', Math.max(...vs)],
      ]
    : [
        ['Lowest', undefined],
        ['Average', undefined],
        ['Highest', undefined],
      ];
  return (
    <div className="w-stats">
      {items.map(([k, v]) => (
        <div key={k}>
          <div className="muted small">{k}</div>
          <div className="mid">
            {fmt(v, c.field)}
            {c.field?.unit && <span className="unit">{c.field.unit}</span>}
          </div>
        </div>
      ))}
      <div className="muted small" style={{ gridColumn: '1 / -1' }}>
        {RANGE_CHOICES.find((r) => r[0] === range)?.[1]}
      </div>
    </div>
  );
}

function HistogramView({ w, c }: { w: Widget; c: Ctx }) {
  const range = sOpt(w, 'range', '24h');
  const d = useSeries(c.deviceId, [w.field], range, { dense: true });
  return <Histogram values={(d?.series[w.field] ?? []).map((p) => p.value)} bins={nOpt(w, 'bins', 12)} unit={c.field?.unit ?? ''} height={w.size === 'xl' || w.size === 'l' ? 220 : 170} />;
}

function ScatterView({ w, c }: { w: Widget; c: Ctx }) {
  const xField = sOpt(w, 'xField', '');
  const range = sOpt(w, 'range', '24h');
  const d = useSeries(c.deviceId, [w.field, xField], range, { dense: true });
  const ys = new Map((d?.series[w.field] ?? []).map((p) => [new Date(p.ts).getTime(), p.value]));
  const pairs = (d?.series[xField] ?? []).flatMap((p) => {
    const y = ys.get(new Date(p.ts).getTime());
    return y === undefined ? [] : [{ x: p.value, y, ts: String(p.ts) }];
  });
  const label = (k: string) => c.fields.find((f) => f.metricKey === k)?.label ?? k;
  if (!xField) return <p className="muted small">Choose a second field for the horizontal axis in this widget’s settings.</p>;
  return <Scatter pairs={pairs} xLabel={label(xField)} yLabel={label(w.field)} height={w.size === 'xl' || w.size === 'l' ? 230 : 180} />;
}

function HeatmapView({ w, c }: { w: Widget; c: Ctx }) {
  const days = nOpt(w, 'days', 7);
  const d = useSeries(c.deviceId, [w.field], days > 7 ? '30d' : '7d', { bucket: '1h', agg: sOpt(w, 'agg', 'avg') });
  const cutoff = Date.now() - days * 86400e3;
  return <Heatmap points={(d?.series[w.field] ?? []).filter((p) => new Date(p.ts).getTime() >= cutoff)} days={days} unit={c.field?.unit ?? ''} />;
}

function TableView({ w, c }: { w: Widget; c: Ctx }) {
  const rows = nOpt(w, 'rows', 10);
  const keys = c.fields.filter((f) => f.kind === 'data').slice(0, 6).map((f) => f.metricKey);
  const d = useSeries(c.deviceId, keys, '6h');
  const byTs = new Map<number, Record<string, number>>();
  for (const k of keys) for (const p of d?.series[k] ?? []) {
    const t = new Date(p.ts).getTime();
    byTs.set(t, { ...(byTs.get(t) ?? {}), [k]: p.value });
  }
  const list = [...byTs.entries()].sort((a, b) => b[0] - a[0]).slice(0, rows);
  return (
    <div className="table-wrap w-table">
      <table className="grid">
        <thead>
          <tr>
            <th>Time</th>
            {keys.map((k) => {
              const f = c.fields.find((x) => x.metricKey === k)!;
              return <th key={k}>{f.label}{f.unit ? ` (${f.unit})` : ''}</th>;
            })}
          </tr>
        </thead>
        <tbody>
          {list.map(([t, v]) => (
            <tr key={t}>
              <td className="muted" style={{ whiteSpace: 'nowrap' }}>{new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</td>
              {keys.map((k) => (
                <td key={k}>{fmt(v[k], c.fields.find((x) => x.metricKey === k))}</td>
              ))}
            </tr>
          ))}
          {!list.length && (
            <tr>
              <td colSpan={keys.length + 1} className="muted">
                No readings in the last 6 hours
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CompareView({ w, c }: { w: Widget; c: Ctx }) {
  const all = useAllDevicesLatest(c.devices);
  const rows = c.devices.map((d) => ({ label: d.displayName, value: all[d.id]?.find((r) => r.metric === w.field)?.value ?? null }));
  rows.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  if (!c.devices.length) return <p className="muted small">No devices in this channel yet.</p>;
  return <HBarChart rows={rows} unit={c.field?.unit ?? ''} />;
}

function MapView({ w, c }: { w: Widget; c: Ctx }) {
  const lngField = sOpt(w, 'lngField', '');
  const all = useAllDevicesLatest(c.devices);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([20.6, 78.9], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);
  const points = c.devices.flatMap((d) => {
    const lat = all[d.id]?.find((r) => r.metric === w.field)?.value;
    const lng = all[d.id]?.find((r) => r.metric === lngField)?.value;
    return lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [{ d, lat, lng }] : [];
  });
  const sig = points.map((p) => `${p.d.id}:${p.lat}:${p.lng}`).join('|');
  useEffect(() => {
    if (!map.current || !layer.current) return;
    layer.current.clearLayers();
    for (const p of points) {
      L.circleMarker([p.lat, p.lng], { radius: p.d.id === c.deviceId ? 9 : 7, color: '#fff', weight: 2, fillColor: p.d.connectivity.status === 'online' ? '#0e9f8a' : '#8a96a3', fillOpacity: 1 })
        .bindTooltip(`${p.d.displayName}${p.d.connectivity.status === 'online' ? '' : ' (offline)'}`)
        .addTo(layer.current);
    }
    if (points.length && !fitted.current) {
      map.current.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])).pad(0.3), { maxZoom: 15 });
      fitted.current = true;
    }
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div ref={el} className="w-map" style={{ height: w.size === 'xl' || w.size === 'l' ? 300 : 220 }} />
      {!lngField && <p className="muted small">Choose the longitude field in this widget’s settings.</p>}
      {lngField && !points.length && <p className="muted small">No device has reported a location yet.</p>}
    </>
  );
}

// ------------------------------------------------------------------ control widgets

function PushButton({ w, c }: { w: Widget; c: Ctx }) {
  const press = nOpt(w, 'pressValue', 1);
  const release = nOpt(w, 'releaseValue', 0);
  const [down, setDown] = useState(false);
  const up = () => {
    if (!down) return;
    setDown(false);
    c.setControl(w.field, release);
  };
  return (
    <div className="w-button">
      <button
        type="button"
        className={`push${down ? ' down' : ''}`}
        disabled={!c.canControl}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setDown(true);
          c.setControl(w.field, press);
        }}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !down) {
            setDown(true);
            c.setControl(w.field, press);
          }
        }}
        onKeyUp={up}
      >
        {sOpt(w, 'text', 'Hold')}
      </button>
      <span className="muted small">Sends {num(press)} while held, {num(release)} when released</span>
    </div>
  );
}

function Stepper({ w, c }: { w: Widget; c: Ctx }) {
  const min = nOpt(w, 'min', lo(c.field));
  const max = nOpt(w, 'max', hi(c.field));
  const step = nOpt(w, 'step', c.field?.step ?? 1);
  const v = c.control;
  const go = (d: number) => c.setControl(w.field, Math.max(min, Math.min(max, +((v ?? min) + d).toFixed(6))));
  return (
    <div className="w-stepper">
      <button type="button" className="btn" disabled={!c.canControl || (v ?? min) <= min} onClick={() => go(-step)} aria-label="Decrease">
        −
      </button>
      <BigValue v={v ?? undefined} f={c.field} />
      <button type="button" className="btn" disabled={!c.canControl || (v ?? min) >= max} onClick={() => go(step)} aria-label="Increase">
        +
      </button>
    </div>
  );
}

function Segmented({ w, c }: { w: Widget; c: Ctx }) {
  const opts = parseMapping(sOpt(w, 'choices', '0:Off,1:Auto,2:On'));
  return (
    <div className="w-seg" role="radiogroup" aria-label={w.title || c.field?.label}>
      {opts.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={c.control === o.value} disabled={!c.canControl} onClick={() => c.setControl(w.field, o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function NumberInput({ w, c }: { w: Widget; c: Ctx }) {
  const [draft, setDraft] = useState('');
  const min = nOpt(w, 'min', lo(c.field));
  const max = nOpt(w, 'max', hi(c.field));
  return (
    <form
      className="w-number"
      onSubmit={(e) => {
        e.preventDefault();
        const v = Number(draft);
        if (draft.trim() === '' || !Number.isFinite(v)) return;
        c.setControl(w.field, Math.max(min, Math.min(max, v)));
        setDraft('');
      }}
    >
      <div className="muted small">
        Now: <b style={{ color: 'var(--ink)' }}>{c.control === null ? 'not set' : `${fmt(c.control, c.field)} ${c.field?.unit ?? ''}`}</b>
      </div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input type="number" step="any" min={min} max={max} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`${num(min)} to ${num(max)}`} disabled={!c.canControl} aria-label={`New value for ${c.field?.label}`} />
        <button className="btn primary" type="submit" disabled={!c.canControl || draft.trim() === ''}>
          Send
        </button>
      </div>
    </form>
  );
}

function ColorPicker({ w, c }: { w: Widget; c: Ctx }) {
  const hex = c.control === null ? '#000000' : `#${Math.max(0, Math.min(0xffffff, Math.round(c.control))).toString(16).padStart(6, '0')}`;
  const [draft, setDraft] = useState(hex);
  useEffect(() => setDraft(hex), [hex]);
  return (
    <div className="w-color">
      <input
        type="color"
        value={draft}
        disabled={!c.canControl}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== hex && c.setControl(w.field, parseInt(draft.slice(1), 16))}
        aria-label={`Colour for ${c.field?.label}`}
      />
      <div>
        <div className="mono">{draft.toUpperCase()}</div>
        <div className="muted small">
          R {parseInt(draft.slice(1, 3), 16)} G {parseInt(draft.slice(3, 5), 16)} B {parseInt(draft.slice(5, 7), 16)}
        </div>
        {draft !== hex && (
          <button className="btn small primary" style={{ marginTop: 6 }} onClick={() => c.setControl(w.field, parseInt(draft.slice(1), 16))} disabled={!c.canControl}>
            Send colour
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ icons (small previews in the picker)

const I = (d: ReactNode) => (
  <svg viewBox="0 0 48 32" aria-hidden="true" className="w-icon">
    {d}
  </svg>
);
const ink = '#3a4757';
const acc = '#2a78d6';

// ------------------------------------------------------------------ the registry

const rangeOpt = (def = '1h'): OptSpec => ({ key: 'range', label: 'Time range', kind: 'select', choices: RANGE_CHOICES, def: () => def });
const minOpt: OptSpec = { key: 'min', label: 'Minimum', kind: 'number', def: (f) => lo(f) };
const maxOpt = (d = 100): OptSpec => ({ key: 'max', label: 'Maximum', kind: 'number', def: (f) => hi(f, d) });

export const WIDGETS: WidgetSpec[] = [
  // ---- Values
  {
    type: 'value', name: 'Value', group: 'Values', help: 'The latest reading as a big number.', fieldKind: 'data', size: 's', options: [],
    icon: I(<text x="24" y="22" textAnchor="middle" fontSize="16" fontWeight="700" fill={ink}>24.5</text>),
    render: (w, c) => <ValueWidget reading={c.reading} field={c.field} now={c.now} />,
  },
  {
    type: 'stat', name: 'Value with trend', group: 'Values', help: 'Latest value, how much it changed, and a small trend line.', fieldKind: 'data', size: 's', options: [rangeOpt('1h')],
    icon: I(<><text x="4" y="14" fontSize="11" fontWeight="700" fill={ink}>24.5</text><path d="M4 26 L14 22 L22 24 L32 17 L44 19" stroke={acc} strokeWidth="2" fill="none" /></>),
    render: (w, c) => <StatView w={w} c={c} />,
  },
  {
    type: 'gauge', name: 'Gauge', group: 'Values', help: 'A dial between a minimum and maximum.', fieldKind: 'data', size: 's', options: [minOpt, maxOpt()],
    icon: I(<><path d="M8 28 A16 16 0 1 1 40 28" stroke="#d5dce3" strokeWidth="5" fill="none" /><path d="M8 28 A16 16 0 0 1 30 13" stroke={acc} strokeWidth="5" fill="none" /></>),
    render: (w, c) => <GaugeWidget reading={c.reading} field={c.field} min={nOpt(w, 'min', lo(c.field))} max={nOpt(w, 'max', hi(c.field))} now={c.now} />,
  },
  {
    type: 'ring', name: 'Progress ring', group: 'Values', help: 'A full circle that fills up, good for percentages.', fieldKind: 'data', size: 's', options: [minOpt, maxOpt()],
    icon: I(<><circle cx="24" cy="16" r="11" stroke="#d5dce3" strokeWidth="5" fill="none" /><path d="M24 5 A11 11 0 1 1 13 16" stroke={acc} strokeWidth="5" fill="none" /></>),
    render: (w, c) => {
      const mn = nOpt(w, 'min', lo(c.field));
      const mx = nOpt(w, 'max', hi(c.field));
      const v = c.reading?.value;
      return (
        <>
          <Ring frac={frac(v, mn, mx)} out={v !== undefined && (v < mn || v > mx)}>
            <BigValue v={v} f={c.field} />
          </Ring>
          <When r={c.reading} now={c.now} />
        </>
      );
    },
  },
  {
    type: 'level', name: 'Tank level', group: 'Values', help: 'A tank that fills up, for water or fuel levels.', fieldKind: 'data', size: 's', options: [minOpt, maxOpt()],
    icon: I(<><rect x="16" y="3" width="16" height="26" rx="3" stroke="#9aa8b6" strokeWidth="2" fill="none" /><rect x="18" y="14" width="12" height="13" fill={acc} /></>),
    render: (w, c) => {
      const mn = nOpt(w, 'min', lo(c.field));
      const mx = nOpt(w, 'max', hi(c.field));
      const v = c.reading?.value;
      return (
        <div className="w-figure-row">
          <Tank frac={frac(v, mn, mx)} />
          <div>
            <BigValue v={v} f={c.field} />
            <div className="muted small">{v === undefined ? '' : `${Math.round(Math.max(0, Math.min(1, frac(v, mn, mx))) * 100)}% full`}</div>
            <When r={c.reading} now={c.now} />
          </div>
        </div>
      );
    },
  },
  {
    type: 'thermometer', name: 'Thermometer', group: 'Values', help: 'A thermometer that turns red above a set temperature.', fieldKind: 'data', size: 's',
    options: [minOpt, maxOpt(50), { key: 'hot', label: 'Red at or above', kind: 'number', def: (f) => (f?.maxValue ?? 50) * 0.8 }],
    icon: I(<><rect x="21" y="3" width="6" height="20" rx="3" stroke="#9aa8b6" strokeWidth="1.5" fill="none" /><circle cx="24" cy="25" r="5" fill="#eb6834" /><rect x="22.5" y="12" width="3" height="12" fill="#eb6834" /></>),
    render: (w, c) => {
      const v = c.reading?.value;
      return (
        <div className="w-figure-row">
          <Thermometer frac={frac(v, nOpt(w, 'min', lo(c.field)), nOpt(w, 'max', hi(c.field, 50)))} hot={v !== undefined && v >= nOpt(w, 'hot', 40)} />
          <div>
            <BigValue v={v} f={c.field} />
            <When r={c.reading} now={c.now} />
          </div>
        </div>
      );
    },
  },
  {
    type: 'battery', name: 'Battery', group: 'Values', help: 'Battery level from a voltage or percentage reading.', fieldKind: 'data', size: 's',
    options: [{ ...minOpt, label: 'Empty at', hint: 'e.g. 3.3 for a LiPo cell, or 0 for %' }, { ...maxOpt(), label: 'Full at', hint: 'e.g. 4.2 for a LiPo cell, or 100 for %' }],
    icon: I(<><rect x="8" y="8" width="28" height="16" rx="3" stroke="#9aa8b6" strokeWidth="2" fill="none" /><rect x="37" y="13" width="3" height="6" fill="#9aa8b6" /><rect x="11" y="11" width="16" height="10" fill="#0e9f8a" /></>),
    render: (w, c) => {
      const f = Math.max(0, Math.min(1, frac(c.reading?.value, nOpt(w, 'min', lo(c.field)), nOpt(w, 'max', hi(c.field)))));
      return (
        <div>
          <Battery frac={f} />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <b style={{ fontSize: 22 }}>{c.reading ? `${Math.round(f * 100)}%` : '—'}</b>
            <span className="muted small">
              {fmt(c.reading?.value, c.field)} {c.field?.unit}
            </span>
          </div>
          <When r={c.reading} now={c.now} />
        </div>
      );
    },
  },
  {
    type: 'meter', name: 'Bar meter', group: 'Values', help: 'A horizontal bar that turns red above a warning level.', fieldKind: 'data', size: 'm',
    options: [minOpt, maxOpt(), { key: 'warn', label: 'Red at or above', kind: 'number', hint: 'Leave empty for no warning', def: () => '' }],
    icon: I(<><rect x="4" y="13" width="40" height="7" rx="3.5" fill="#d5dce3" /><rect x="4" y="13" width="26" height="7" rx="3.5" fill={acc} /></>),
    render: (w, c) => {
      const v = c.reading?.value;
      const warn = w.options.warn === '' || w.options.warn === null || w.options.warn === undefined ? null : Number(w.options.warn);
      return (
        <div>
          <BigValue v={v} f={c.field} />
          <Meter frac={frac(v, nOpt(w, 'min', lo(c.field)), nOpt(w, 'max', hi(c.field)))} warn={warn !== null && v !== undefined && v >= warn} />
          <div className="row muted small" style={{ justifyContent: 'space-between', marginTop: 4 }}>
            <span>{num(nOpt(w, 'min', lo(c.field)))}</span>
            <span>{num(nOpt(w, 'max', hi(c.field)))}</span>
          </div>
        </div>
      );
    },
  },
  {
    type: 'indicator', name: 'Indicator light', group: 'Values', help: 'A light that turns on at or above a threshold.', fieldKind: 'data', size: 's',
    options: [
      { key: 'threshold', label: 'Light up at or above', kind: 'number', def: (f) => f?.maxValue ?? 1 },
      { key: 'onLabel', label: 'Text when lit', kind: 'text', def: () => 'On' },
      { key: 'offLabel', label: 'Text when dark', kind: 'text', def: () => 'Off' },
    ],
    icon: I(<circle cx="24" cy="16" r="9" fill="#f5b82e" stroke="#f0d68c" strokeWidth="3" />),
    render: (w, c) => <IndicatorWidget reading={c.reading} threshold={nOpt(w, 'threshold', 1)} onLabel={sOpt(w, 'onLabel', 'On')} offLabel={sOpt(w, 'offLabel', 'Off')} now={c.now} />,
  },
  {
    type: 'status', name: 'Status text', group: 'Values', help: 'Turns a number into words, like 0 = Idle, 1 = Running, 2 = Fault.', fieldKind: 'data', size: 's',
    options: [{ key: 'mapping', label: 'Values and words', kind: 'text', hint: 'value:word, separated by commas', def: () => '0:Idle,1:Running,2:Fault' }],
    icon: I(<><rect x="6" y="9" width="36" height="14" rx="7" fill="#dcf3ef" /><text x="24" y="20" textAnchor="middle" fontSize="9" fontWeight="700" fill="#0b7a6a">Running</text></>),
    render: (w, c) => {
      const map = parseMapping(sOpt(w, 'mapping', ''));
      const v = c.reading?.value;
      const hit = map.find((m) => m.value === v);
      return (
        <div>
          <div className="w-status">{v === undefined ? '—' : hit ? hit.label : `Unknown (${num(v)})`}</div>
          <When r={c.reading} now={c.now} />
        </div>
      );
    },
  },
  {
    type: 'stats', name: 'Lowest / average / highest', group: 'Values', help: 'Summary of a field over a time range.', fieldKind: 'data', size: 'm', options: [rangeOpt('24h')],
    icon: I(<><text x="4" y="20" fontSize="9" fill={ink}>12</text><text x="18" y="20" fontSize="9" fontWeight="700" fill={ink}>18</text><text x="33" y="20" fontSize="9" fill={ink}>27</text></>),
    render: (w, c) => <StatsView w={w} c={c} />,
  },

  // ---- Charts
  {
    type: 'chart', name: 'Time chart', group: 'Charts', help: 'Readings over time as a line, area, step or bar chart. Up to 3 fields on one chart.', fieldKind: 'data', size: 'l',
    options: [
      { key: 'style', label: 'Style', kind: 'select', choices: [['line', 'Line'], ['area', 'Area'], ['step', 'Steps'], ['bars', 'Bars (one field)']], def: () => 'line' },
      rangeOpt('1h'),
      { key: 'agg', label: 'Combine readings by', kind: 'select', choices: [['avg', 'Average'], ['min', 'Lowest'], ['max', 'Highest'], ['last', 'Last'], ['count', 'Count']], hint: 'Used for ranges over 1 hour', def: () => 'avg' },
      { key: 'field2', label: 'Second field (optional)', kind: 'field', fieldKind: 'data', hint: 'Use fields with the same unit', def: () => '' },
      { key: 'field3', label: 'Third field (optional)', kind: 'field', fieldKind: 'data', def: () => '' },
    ],
    icon: I(<path d="M4 24 L14 15 L22 19 L32 8 L44 12" stroke={acc} strokeWidth="2.5" fill="none" strokeLinejoin="round" />),
    render: (w, c) => <ChartView w={w} c={c} />,
  },
  {
    type: 'histogram', name: 'Histogram', group: 'Charts', help: 'How often each value occurred, to see the usual range.', fieldKind: 'data', size: 'm',
    options: [rangeOpt('24h'), { key: 'bins', label: 'Number of bars', kind: 'select', choices: [['8', '8'], ['12', '12'], ['20', '20']], def: () => '12' }],
    icon: I(<>{[6, 12, 20, 26, 16, 8].map((h, i) => <rect key={i} x={5 + i * 6.5} y={28 - h} width="5" height={h} rx="1" fill={acc} />)}</>),
    render: (w, c) => <HistogramView w={w} c={c} />,
  },
  {
    type: 'scatter', name: 'Scatter plot', group: 'Charts', help: 'One field against another, to see if they move together (like temperature and humidity).', fieldKind: 'data', size: 'm',
    options: [{ key: 'xField', label: 'Horizontal axis field', kind: 'field', fieldKind: 'data', def: () => '' }, rangeOpt('24h')],
    icon: I(<>{[[8, 24], [14, 20], [19, 21], [24, 15], [30, 13], [36, 9], [40, 10]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2.5" fill={acc} />)}</>),
    render: (w, c) => <ScatterView w={w} c={c} />,
  },
  {
    type: 'heatmap', name: 'Heatmap', group: 'Charts', help: 'Hourly averages by day, to spot daily patterns.', fieldKind: 'data', size: 'xl',
    options: [
      { key: 'days', label: 'Days', kind: 'select', choices: [['7', 'Last 7 days'], ['14', 'Last 14 days'], ['30', 'Last 30 days']], def: () => '7' },
      { key: 'agg', label: 'Combine readings by', kind: 'select', choices: [['avg', 'Average'], ['max', 'Highest'], ['min', 'Lowest']], def: () => 'avg' },
    ],
    icon: I(<>{Array.from({ length: 12 }, (_, i) => <rect key={i} x={6 + (i % 4) * 9.5} y={5 + Math.floor(i / 4) * 8} width="8" height="6.5" rx="1" fill={['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab'][(i * 7) % 4]} />)}</>),
    render: (w, c) => <HeatmapView w={w} c={c} />,
  },
  {
    type: 'table', name: 'Data table', group: 'Charts', help: 'The latest readings as rows, newest first.', fieldKind: 'none', size: 'l',
    options: [{ key: 'rows', label: 'Rows', kind: 'select', choices: [['5', '5'], ['10', '10'], ['20', '20'], ['50', '50']], def: () => '10' }],
    icon: I(<>{[8, 15, 22].map((y) => <rect key={y} x="6" y={y} width="36" height="4" rx="1" fill={y === 8 ? '#9aa8b6' : '#d5dce3'} />)}</>),
    render: (w, c) => <TableView w={w} c={c} />,
  },
  {
    type: 'compare', name: 'Compare devices', group: 'Charts', help: 'The latest value of a field for every device in this channel.', fieldKind: 'data', size: 'm', options: [],
    icon: I(<>{[30, 22, 14].map((wd, i) => <rect key={i} x="6" y={6 + i * 8} width={wd} height="5" rx="2" fill={acc} />)}</>),
    render: (w, c) => <CompareView w={w} c={c} />,
  },
  {
    type: 'map', name: 'Map', group: 'Charts', help: 'Where your devices are, from latitude and longitude fields. Needs internet for the map tiles.', fieldKind: 'data', size: 'l',
    options: [{ key: 'lngField', label: 'Longitude field', kind: 'field', fieldKind: 'data', hint: 'The widget’s main field is latitude', def: () => '' }],
    icon: I(<><rect x="5" y="4" width="38" height="24" rx="2" fill="#e6eef6" /><path d="M24 8 a5 5 0 0 1 5 5 c0 4 -5 9 -5 9 s-5 -5 -5 -9 a5 5 0 0 1 5 -5z" fill="#0e9f8a" /></>),
    render: (w, c) => <MapView w={w} c={c} />,
  },

  // ---- Controls
  {
    type: 'switch', name: 'Switch', group: 'Controls', help: 'On/off, like a relay, pump or light.', fieldKind: 'control', size: 's',
    options: [
      { key: 'onValue', label: 'Value for On', kind: 'number', def: (f) => f?.maxValue ?? 1 },
      { key: 'offValue', label: 'Value for Off', kind: 'number', def: (f) => f?.minValue ?? 0 },
    ],
    icon: I(<><rect x="10" y="9" width="28" height="15" rx="7.5" fill="#0e9f8a" /><circle cx="30.5" cy="16.5" r="5.5" fill="#fff" /></>),
    render: (w, c) => <SwitchWidget label={w.title || c.field?.label || ''} value={c.control} onValue={nOpt(w, 'onValue', 1)} offValue={nOpt(w, 'offValue', 0)} disabled={!c.canControl} onChange={(v) => c.setControl(w.field, v)} />,
  },
  {
    type: 'button', name: 'Push button', group: 'Controls', help: 'Sends a value while held down, another when released, like a door buzzer.', fieldKind: 'control', size: 's',
    options: [
      { key: 'text', label: 'Button text', kind: 'text', def: () => 'Hold' },
      { key: 'pressValue', label: 'Value while held', kind: 'number', def: (f) => f?.maxValue ?? 1 },
      { key: 'releaseValue', label: 'Value when released', kind: 'number', def: (f) => f?.minValue ?? 0 },
    ],
    icon: I(<><circle cx="24" cy="16" r="11" fill="#2f45c5" /><circle cx="24" cy="16" r="7" fill="#4f63d9" /></>),
    render: (w, c) => <PushButton w={w} c={c} />,
  },
  {
    type: 'slider', name: 'Slider', group: 'Controls', help: 'A number in a range, like brightness or speed.', fieldKind: 'control', size: 's',
    options: [minOpt, maxOpt(), { key: 'step', label: 'Step', kind: 'number', def: (f) => f?.step ?? 1 }],
    icon: I(<><rect x="5" y="15" width="38" height="3" rx="1.5" fill="#d5dce3" /><rect x="5" y="15" width="22" height="3" rx="1.5" fill={acc} /><circle cx="27" cy="16.5" r="5" fill="#fff" stroke={acc} strokeWidth="2" /></>),
    render: (w, c) => (
      <SliderWidget
        label={w.title || c.field?.label || ''}
        value={c.control}
        min={nOpt(w, 'min', lo(c.field))}
        max={nOpt(w, 'max', hi(c.field))}
        step={nOpt(w, 'step', c.field?.step ?? 1)}
        field={c.field}
        disabled={!c.canControl}
        onCommit={(v) => c.setControl(w.field, v)}
      />
    ),
  },
  {
    type: 'stepper', name: 'Plus / minus', group: 'Controls', help: 'Buttons that raise or lower a value by a fixed step, like a thermostat.', fieldKind: 'control', size: 's',
    options: [minOpt, maxOpt(), { key: 'step', label: 'Step', kind: 'number', def: (f) => f?.step ?? 1 }],
    icon: I(<><rect x="4" y="9" width="12" height="14" rx="3" fill="#e6eaee" /><text x="10" y="20" textAnchor="middle" fontSize="11" fill={ink}>−</text><text x="24" y="21" textAnchor="middle" fontSize="10" fontWeight="700" fill={ink}>22</text><rect x="32" y="9" width="12" height="14" rx="3" fill="#e6eaee" /><text x="38" y="20" textAnchor="middle" fontSize="11" fill={ink}>+</text></>),
    render: (w, c) => <Stepper w={w} c={c} />,
  },
  {
    type: 'segmented', name: 'Mode selector', group: 'Controls', help: 'Pick one of a few modes, like Off / Auto / On.', fieldKind: 'control', size: 'm',
    options: [{ key: 'choices', label: 'Values and names', kind: 'text', hint: 'value:name, separated by commas', def: () => '0:Off,1:Auto,2:On' }],
    icon: I(<><rect x="4" y="10" width="40" height="12" rx="3" fill="#e6eaee" /><rect x="17" y="10" width="14" height="12" rx="3" fill="#14202e" /></>),
    render: (w, c) => <Segmented w={w} c={c} />,
  },
  {
    type: 'number', name: 'Number input', group: 'Controls', help: 'Type an exact value and send it, like a set point.', fieldKind: 'control', size: 's', options: [minOpt, maxOpt()],
    icon: I(<><rect x="4" y="10" width="26" height="12" rx="2" fill="#fff" stroke="#9aa8b6" /><text x="8" y="19.5" fontSize="8" fill={ink}>42</text><rect x="32" y="10" width="12" height="12" rx="2" fill="#2f45c5" /></>),
    render: (w, c) => <NumberInput w={w} c={c} />,
  },
  {
    type: 'color', name: 'Colour picker', group: 'Controls', help: 'Pick a colour for an RGB LED. Sends it as one number (0xRRGGBB).', fieldKind: 'control', size: 's', options: [],
    icon: I(<><circle cx="18" cy="14" r="7" fill="#e34948" opacity="0.85" /><circle cx="30" cy="14" r="7" fill="#1baf7a" opacity="0.85" /><circle cx="24" cy="22" r="7" fill="#2a78d6" opacity="0.85" /></>),
    render: (w, c) => <ColorPicker w={w} c={c} />,
  },

  // ---- Templates
  {
    type: 'custom', name: 'Custom board (HTML & CSS)', group: 'Templates',
    help: 'Design your own board in HTML and CSS. Start from a template, then put live values in with placeholders like {{temperature}}.',
    fieldKind: 'none', size: 'l',
    options: [
      { key: 'template', label: 'Template', kind: 'text', def: () => 'hero' },
      { key: 'html', label: 'HTML', kind: 'longtext', def: () => '' },
      { key: 'css', label: 'CSS', kind: 'longtext', def: () => '' },
      { key: 'height', label: 'Height (pixels)', kind: 'number', def: () => BOARD_TEMPLATES[0].height },
    ],
    icon: I(<><rect x="4" y="5" width="40" height="22" rx="4" fill="#3157f6" /><path d="M14 11l-5 5 5 5M34 11l5 5-5 5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /><path d="M27 10l-6 12" stroke="#bfe9ff" strokeWidth="2.2" strokeLinecap="round" /></>),
    render: (w, c) => (
      <BoardFrame
        title={w.title}
        html={sOpt(w, 'html', '')}
        css={sOpt(w, 'css', '')}
        height={nOpt(w, 'height', 220)}
        data={{ fields: c.fields, latest: c.latest, controls: c.controls, device: c.devices.find((d) => d.id === c.deviceId), now: c.now }}
      />
    ),
  },

  // ---- Other
  {
    type: 'text', name: 'Note', group: 'Other', help: 'A text note for instructions or labels on the dashboard.', fieldKind: 'none', size: 'm',
    options: [{ key: 'text', label: 'Text', kind: 'longtext', def: () => '' }],
    icon: I(<>{[9, 15, 21].map((y, i) => <rect key={y} x="6" y={y} width={i === 2 ? 22 : 36} height="3" rx="1.5" fill="#9aa8b6" />)}</>),
    render: (w) => <p className="w-note">{sOpt(w, 'text', '') || 'Edit this widget to add text.'}</p>,
  },
];

export const SPEC = new Map(WIDGETS.map((s) => [s.type, s]));

export function defaultsFor(spec: WidgetSpec, field?: Field): Widget['options'] {
  return Object.fromEntries(spec.options.map((o) => [o.key, o.def(field)]));
}
