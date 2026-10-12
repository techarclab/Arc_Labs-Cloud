import { useEffect, useState } from 'react';
import { Field, Reading, Widget, WidgetType } from '../api';
import { ago, num } from '../format';
import { Chart, Point } from './Chart';

export const WIDGET_TYPES: { type: WidgetType; name: string; help: string; forKind: 'data' | 'control' }[] = [
  { type: 'value', name: 'Value', help: 'The latest reading as a big number.', forKind: 'data' },
  { type: 'gauge', name: 'Gauge', help: 'The latest reading on a dial between a min and max.', forKind: 'data' },
  { type: 'chart', name: 'Chart', help: 'Readings over time.', forKind: 'data' },
  { type: 'indicator', name: 'Indicator light', help: 'Lights up when the reading is at or above a threshold.', forKind: 'data' },
  { type: 'switch', name: 'Switch', help: 'Turns something on or off, like a relay or LED.', forKind: 'control' },
  { type: 'slider', name: 'Slider', help: 'Sets a number in a range, like brightness or speed.', forKind: 'control' },
];

export function fmt(v: number | null | undefined, field?: Field) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (field) return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: field.decimals });
  return num(v);
}

export function ValueWidget({ reading, field, now }: { reading?: Reading; field?: Field; now: number }) {
  return (
    <div className="w-value">
      <div className="big">
        {fmt(reading?.value, field)}
        {field?.unit && <span className="unit">{field.unit}</span>}
      </div>
      <div className="muted small">{reading ? ago(reading.ts, now) : 'No data yet'}</div>
    </div>
  );
}

/** 240° dial. */
export function GaugeWidget({ reading, field, min, max, now }: { reading?: Reading; field?: Field; min: number; max: number; now: number }) {
  const v = reading?.value;
  const R = 70;
  const cx = 90;
  const cy = 86;
  const a0 = (-210 * Math.PI) / 180;
  const a1 = (30 * Math.PI) / 180;
  const frac = v === undefined || max === min ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min)));
  const at = (f: number) => {
    const a = a0 + (a1 - a0) * f;
    return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  };
  const arc = (f0: number, f1: number) => {
    const [x0, y0] = at(f0);
    const [x1, y1] = at(f1);
    const large = (f1 - f0) * 240 > 180 ? 1 : 0;
    return `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1}`;
  };
  const out = v !== undefined && (v < min || v > max);
  return (
    <div className="w-gauge">
      <svg viewBox="0 0 180 150" role="img" aria-label={`${fmt(v, field)} ${field?.unit ?? ''} on a scale from ${min} to ${max}`}>
        <path d={arc(0, 1)} className="track" />
        {v !== undefined && frac > 0 && <path d={arc(0, Math.max(frac, 0.005))} className={`fill${out ? ' out' : ''}`} />}
        <text x={cx} y={cy + 4} textAnchor="middle" className="g-value">
          {fmt(v, field)}
        </text>
        <text x={cx} y={cy + 24} textAnchor="middle" className="g-unit">
          {field?.unit ?? ''}
        </text>
        <text x={at(0)[0]} y={at(0)[1] + 18} textAnchor="middle" className="g-tick">
          {num(min)}
        </text>
        <text x={at(1)[0]} y={at(1)[1] + 18} textAnchor="middle" className="g-tick">
          {num(max)}
        </text>
      </svg>
      <div className="muted small" style={{ textAlign: 'center', marginTop: -10 }}>
        {reading ? ago(reading.ts, now) : 'No data yet'}
      </div>
    </div>
  );
}

export function IndicatorWidget({ reading, threshold, onLabel, offLabel, now }: { reading?: Reading; threshold: number; onLabel: string; offLabel: string; now: number }) {
  const on = reading !== undefined && reading.value >= threshold;
  return (
    <div className="w-indicator">
      <span className={`lamp${on ? ' on' : ''}${reading === undefined ? ' none' : ''}`} aria-hidden="true" />
      <div>
        <div style={{ fontWeight: 600, fontSize: 18 }}>{reading === undefined ? 'No data' : on ? onLabel : offLabel}</div>
        <div className="muted small">
          {reading ? `${num(reading.value)}, ${ago(reading.ts, now)}` : 'Waiting for a reading'}
        </div>
      </div>
    </div>
  );
}

export function SwitchWidget({ value, onValue, offValue, disabled, onChange, label }: { value: number | null; onValue: number; offValue: number; disabled?: boolean; onChange: (v: number) => void; label: string }) {
  const on = value !== null && value === onValue;
  return (
    <div className="w-switch">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`toggle${on ? ' on' : ''}`}
        disabled={disabled}
        onClick={() => onChange(on ? offValue : onValue)}
      >
        <span className="knob" />
      </button>
      <span className="state">{value === null ? 'Not set' : on ? 'On' : 'Off'}</span>
    </div>
  );
}

export function SliderWidget({ value, min, max, step, field, disabled, onCommit, label }: { value: number | null; min: number; max: number; step: number; field?: Field; disabled?: boolean; onCommit: (v: number) => void; label: string }) {
  const [draft, setDraft] = useState<number>(value ?? min);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging && value !== null) setDraft(value);
  }, [value, dragging]);
  return (
    <div className="w-slider">
      <div className="big" style={{ fontSize: 28 }}>
        {value === null && !dragging ? '—' : fmt(draft, field)}
        {field?.unit && <span className="unit">{field.unit}</span>}
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onPointerDown={() => setDragging(true)}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => {
          setDragging(false);
          onCommit(draft);
        }}
        onKeyUp={() => onCommit(draft)}
      />
      <div className="row muted small" style={{ justifyContent: 'space-between' }}>
        <span>{num(min)}</span>
        <span>{num(max)}</span>
      </div>
    </div>
  );
}

export function ChartWidget({ points, from, to, field, height }: { points: Point[]; from: Date; to: Date; field?: Field; height: number }) {
  const span = to.getTime() - from.getTime();
  const gap = span <= 3600e3 ? 5 * 60e3 : span <= 6 * 3600e3 ? 15 * 60e3 : span <= 86400e3 ? 45 * 60e3 : 3 * 3600e3;
  return <Chart points={points} from={from} to={to} unit={field?.unit ?? ''} gapMs={gap} height={height} limits={field ? { min: field.minValue, max: field.maxValue } : undefined} />;
}

/** Sensible defaults for a new widget on a field. */
export function defaultWidget(type: WidgetType, field: Field): Omit<Widget, 'id'> {
  const lo = field.minValue ?? 0;
  const hi = field.maxValue ?? (type === 'switch' ? 1 : 100);
  switch (type) {
    case 'gauge':
      return { type, title: field.label, field: field.metricKey, size: 's', options: { min: lo, max: hi } };
    case 'chart':
      return { type, title: field.label, field: field.metricKey, size: 'l', options: { range: '1h' } };
    case 'indicator':
      return { type, title: field.label, field: field.metricKey, size: 's', options: { threshold: field.maxValue ?? 1, onLabel: 'On', offLabel: 'Off' } };
    case 'switch':
      return { type, title: field.label, field: field.metricKey, size: 's', options: { onValue: field.maxValue ?? 1, offValue: field.minValue ?? 0 } };
    case 'slider':
      return { type, title: field.label, field: field.metricKey, size: 's', options: { min: lo, max: hi, step: field.step ?? 1 } };
    default:
      return { type: 'value', title: field.label, field: field.metricKey, size: 's', options: {} };
  }
}
