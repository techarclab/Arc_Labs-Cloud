/**
 * Visualizations for dashboard widgets, in plain SVG.
 * Colours follow the reference data-viz palette: categorical slots in fixed order,
 * a single-hue blue ramp for magnitude, hairline solid gridlines, 2px lines, 4px rounded bar ends.
 */
import { ReactNode, useId, useMemo, useRef, useState } from 'react';
import { num } from '../format';

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];
export const SEQ = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const GRID = '#e6eaee';
const INK_MUTED = '#5b6875';
const TRACK = '#e3e8ed';

export interface Pt { ts: string | Date; value: number }

export function ticks(min: number, max: number, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return { lo, hi, ticks: out };
}

const compact = (v: number) => (Math.abs(v) >= 1000 ? `${num(v / 1000)}K` : num(v));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Width-aware SVG: measures its container so text never stretches. */
function useWidth(initial = 400) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(initial);
  const obs = useRef<ResizeObserver | null>(null);
  const set = (el: HTMLDivElement | null) => {
    (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    obs.current?.disconnect();
    if (el) {
      obs.current = new ResizeObserver((e) => setW(Math.max(120, Math.round(e[0].contentRect.width))));
      obs.current.observe(el);
    }
  };
  return { set, w };
}

export function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div className="viz-tip" style={{ left: x, top: y }}>
      {children}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="viz-legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- time series

export type TimeStyle = 'line' | 'area' | 'step' | 'bars';

export function TimeChart({
  series,
  from,
  to,
  height = 200,
  style = 'line',
  unit = '',
  gapMs,
  refLines = [],
}: {
  series: { label: string; points: Pt[]; unit?: string }[];
  from: Date;
  to: Date;
  height?: number;
  style?: TimeStyle;
  unit?: string;
  gapMs: number;
  refLines?: number[];
}) {
  const { set, w } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const P = { l: 44, r: 10, t: 10, b: 24 };
  const t0 = from.getTime();
  const t1 = to.getTime();
  const m = useMemo(() => {
    const all = series.flatMap((s) => s.points.map((p) => p.value)).concat(refLines);
    if (style === 'bars') all.push(0);
    const { lo, hi, ticks: yt } = ticks(Math.min(...all, Infinity), Math.max(...all, -Infinity));
    const x = (t: number) => P.l + ((t - t0) / (t1 - t0 || 1)) * (w - P.l - P.r);
    const y = (v: number) => P.t + (1 - (v - lo) / (hi - lo || 1)) * (height - P.t - P.b);
    const paths = series.map((s) => {
      const pts = s.points.map((p) => ({ t: new Date(p.ts).getTime(), v: p.value }));
      const segs: { t: number; v: number }[][] = [];
      for (const p of pts) {
        const last = segs.at(-1);
        if (!last || p.t - last[last.length - 1].t > gapMs) segs.push([p]);
        else last.push(p);
      }
      const line = segs
        .map((sg) =>
          sg
            .map((p, i) => {
              if (i === 0) return `M${x(p.t)},${y(p.v)}`;
              return style === 'step' ? `H${x(p.t)}V${y(p.v)}` : `L${x(p.t)},${y(p.v)}`;
            })
            .join(''),
        )
        .join('');
      const area = segs.map((sg) => (sg.length > 1 ? `M${x(sg[0].t)},${y(lo)}` + sg.map((p) => `L${x(p.t)},${y(p.v)}`).join('') + `L${x(sg[sg.length - 1].t)},${y(lo)}Z` : '')).join('');
      return { pts, line, area, lone: segs.filter((sg) => sg.length === 1).map((sg) => sg[0]) };
    });
    const span = t1 - t0;
    const fmt: Intl.DateTimeFormatOptions = span > 2 * 86400e3 ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' };
    const nx = Math.max(2, Math.min(6, Math.floor(w / 110)));
    const xt = Array.from({ length: nx }, (_, i) => t0 + (span * i) / (nx - 1));
    return { lo, hi, yt, x, y, paths, xt, fmt };
  }, [series, t0, t1, w, height, style, gapMs, refLines]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bars: one band per distinct timestamp of the first series.
  const bars = style === 'bars' ? m.paths[0]?.pts ?? [] : [];
  const band = bars.length ? Math.max(2, (w - P.l - P.r) / bars.length) : 0;
  const barW = Math.min(24, Math.max(1, band - 2));

  const hoverPts = hover === null ? [] : m.paths.map((p, i) => ({ i, p: nearest(p.pts, hover) })).filter((h) => h.p);

  return (
    <div className="viz" ref={set} onPointerLeave={() => setHover(null)}>
      <svg
        width={w}
        height={height}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - r.left;
          setHover(t0 + ((px - P.l) / (w - P.l - P.r)) * (t1 - t0));
        }}
        role="img"
        aria-label={`${series.map((s) => s.label).join(', ')} over time`}
      >
        {m.yt.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={w - P.r} y1={m.y(t)} y2={m.y(t)} stroke={GRID} />
            <text x={P.l - 6} y={m.y(t) + 4} textAnchor="end" className="viz-axis">
              {compact(t)}
            </text>
          </g>
        ))}
        {m.xt.map((t, i) => (
          <text key={t} x={m.x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === m.xt.length - 1 ? 'end' : 'middle'} className="viz-axis">
            {new Date(t).toLocaleString(undefined, m.fmt)}
          </text>
        ))}
        {refLines.map((r) => (
          <line key={r} x1={P.l} x2={w - P.r} y1={m.y(r)} y2={m.y(r)} stroke="#c8423b" strokeOpacity={0.5} />
        ))}
        {style === 'bars'
          ? bars.map((p) => {
              const x = m.x(p.t) - barW / 2;
              const y0 = m.y(Math.max(0, m.lo));
              const y1 = m.y(p.v);
              const top = Math.min(y0, y1);
              const h = Math.max(1, Math.abs(y0 - y1));
              const r = Math.min(4, barW / 2, h);
              return <path key={p.t} d={roundedTop(x, top, barW, h, r)} fill={SERIES[0]} />;
            })
          : m.paths.map((p, i) => (
              <g key={i}>
                {style === 'area' && <path d={p.area} fill={SERIES[i]} fillOpacity={0.12} />}
                <path d={p.line} fill="none" stroke={SERIES[i]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {p.lone.map((l) => (
                  <circle key={l.t} cx={m.x(l.t)} cy={m.y(l.v)} r={3} fill={SERIES[i]} />
                ))}
              </g>
            ))}
        {hoverPts.length > 0 && (
          <>
            <line x1={m.x(hoverPts[0].p!.t)} x2={m.x(hoverPts[0].p!.t)} y1={P.t} y2={height - P.b} stroke={INK_MUTED} strokeOpacity={0.4} />
            {hoverPts.map((h) => (
              <circle key={h.i} cx={m.x(h.p!.t)} cy={m.y(h.p!.v)} r={4.5} fill={SERIES[h.i]} stroke="#fff" strokeWidth={2} />
            ))}
          </>
        )}
      </svg>
      {hoverPts.length > 0 && (
        <Tip x={Math.min(m.x(hoverPts[0].p!.t), w - 80)} y={P.t}>
          <div className="muted">{new Date(hoverPts[0].p!.t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
          {hoverPts.map((h) => (
            <div key={h.i}>
              {series.length > 1 && <i className="sw" style={{ background: SERIES[h.i] }} />}
              {series.length > 1 ? `${series[h.i].label}: ` : ''}
              <b>
                {num(h.p!.v)}
                {(series[h.i].unit ?? unit) && ` ${series[h.i].unit ?? unit}`}
              </b>
            </div>
          ))}
        </Tip>
      )}
      {!series.some((s) => s.points.length) && <div className="viz-empty">No readings in this time range</div>}
    </div>
  );
}

function nearest(pts: { t: number; v: number }[], t: number) {
  let best: { t: number; v: number } | null = null;
  for (const p of pts) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best;
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function roundedRight(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

// ---------------------------------------------------------------- sparkline

export function Sparkline({ points, height = 36 }: { points: Pt[]; height?: number }) {
  const { set, w } = useWidth(160);
  if (points.length < 2) return <div ref={set} style={{ height }} />;
  const vs = points.map((p) => p.value);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const ts = points.map((p) => new Date(p.ts).getTime());
  const x = (t: number) => 2 + ((t - ts[0]) / (ts[ts.length - 1] - ts[0] || 1)) * (w - 8);
  const y = (v: number) => 4 + (1 - (v - lo) / (hi - lo || 1)) * (height - 8);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(ts[i])},${y(p.value)}`).join('');
  const last = points[points.length - 1];
  return (
    <div ref={set}>
      <svg width={w} height={height} aria-hidden="true">
        <path d={d} fill="none" stroke="#9aa8b6" strokeWidth={1.5} strokeLinejoin="round" />
        <circle cx={x(ts[ts.length - 1])} cy={y(last.value)} r={4} fill={SERIES[0]} stroke="#fff" strokeWidth={2} />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- categorical bars (compare devices)

export function HBarChart({ rows, unit, max }: { rows: { label: string; value: number | null; sub?: string }[]; unit: string; max?: number }) {
  const { set, w } = useWidth();
  const labelW = Math.min(190, Math.round(w * 0.46));
  const maxChars = Math.max(6, Math.floor((labelW - 12) / 6.6));
  const valW = 64;
  const vals = rows.map((r) => r.value ?? 0);
  const hi = max ?? Math.max(...vals, 0);
  const lo = Math.min(0, ...vals);
  const barH = 18;
  const rowH = 30;
  const x = (v: number) => labelW + ((v - lo) / (hi - lo || 1)) * (w - labelW - valW);
  return (
    <div className="viz" ref={set}>
      <svg width={w} height={rows.length * rowH} role="img" aria-label="Latest value per device">
        {rows.map((r, i) => {
          const y = i * rowH + (rowH - barH) / 2;
          const v = r.value;
          return (
            <g key={r.label + i}>
              <title>{`${r.label}: ${v === null ? 'no data' : `${num(v)} ${unit}`}`}</title>
              <text x={labelW - 8} y={y + barH / 2 + 4} textAnchor="end" className="viz-label">
                {r.label.length > maxChars ? `${r.label.slice(0, maxChars - 1)}…` : r.label}
              </text>
              <rect x={labelW} y={y} width={w - labelW - valW} height={barH} fill={TRACK} rx={4} opacity={0.5} />
              {v !== null && <path d={roundedRight(x(Math.min(0, v)), y, Math.max(2, Math.abs(x(v) - x(0))), barH, 4)} fill={SERIES[0]} />}
              <text x={w - valW + 8} y={y + barH / 2 + 4} className="viz-value">
                {v === null ? '—' : num(v)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- histogram

export function Histogram({ values, bins = 12, unit, height = 180 }: { values: number[]; bins?: number; unit: string; height?: number }) {
  const { set, w } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const P = { l: 36, r: 8, t: 10, b: 26 };
  const m = useMemo(() => {
    if (!values.length) return null;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const width = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0);
    for (const v of values) counts[Math.min(bins - 1, Math.floor((v - lo) / width))]++;
    const yt = ticks(0, Math.max(...counts));
    return { lo, width, counts, yt };
  }, [values, bins]);
  if (!m) return <div className="viz-empty static">No readings in this time range</div>;
  const band = (w - P.l - P.r) / bins;
  const bw = Math.min(24 * 2, band - 2);
  const y = (c: number) => P.t + (1 - c / (m.yt.hi || 1)) * (height - P.t - P.b);
  return (
    <div className="viz" ref={set} onPointerLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={`How often each value occurred, ${values.length} readings`}>
        {m.yt.ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={w - P.r} y1={y(t)} y2={y(t)} stroke={GRID} />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="viz-axis">
              {compact(t)}
            </text>
          </g>
        ))}
        {m.counts.map((c, i) => {
          const x = P.l + i * band + (band - bw) / 2;
          const h = Math.max(c ? 1 : 0, y(0) - y(c));
          return (
            <g key={i} onPointerEnter={() => setHover(i)}>
              <rect x={P.l + i * band} y={P.t} width={band} height={height - P.t - P.b} fill="transparent" />
              {c > 0 && <path d={roundedTop(x, y(c), bw, h, Math.min(4, bw / 2, h))} fill={hover === i ? '#1c5cab' : SERIES[0]} />}
            </g>
          );
        })}
        {[0, Math.floor(bins / 2), bins].map((i) => (
          <text key={i} x={P.l + i * band} y={height - 8} textAnchor={i === 0 ? 'start' : i === bins ? 'end' : 'middle'} className="viz-axis">
            {num(m.lo + i * m.width)}
          </text>
        ))}
      </svg>
      {hover !== null && (
        <Tip x={Math.min(P.l + hover * band, w - 120)} y={P.t}>
          <b>{m.counts[hover]}</b> readings between {num(m.lo + hover * m.width)} and {num(m.lo + (hover + 1) * m.width)} {unit}
        </Tip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- scatter

export function Scatter({ pairs, xLabel, yLabel, height = 200 }: { pairs: { x: number; y: number; ts: string }[]; xLabel: string; yLabel: string; height?: number }) {
  const { set, w } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const P = { l: 44, r: 10, t: 10, b: 34 };
  if (!pairs.length) return <div className="viz-empty static">No readings with both values in this time range</div>;
  const xt = ticks(Math.min(...pairs.map((p) => p.x)), Math.max(...pairs.map((p) => p.x)));
  const yt = ticks(Math.min(...pairs.map((p) => p.y)), Math.max(...pairs.map((p) => p.y)));
  const x = (v: number) => P.l + ((v - xt.lo) / (xt.hi - xt.lo || 1)) * (w - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - yt.lo) / (yt.hi - yt.lo || 1)) * (height - P.t - P.b);
  const shown = pairs.slice(-600);
  return (
    <div className="viz" ref={set} onPointerLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={`${yLabel} against ${xLabel}`}>
        {yt.ticks.map((t) => (
          <g key={`y${t}`}>
            <line x1={P.l} x2={w - P.r} y1={y(t)} y2={y(t)} stroke={GRID} />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="viz-axis">
              {compact(t)}
            </text>
          </g>
        ))}
        {xt.ticks.map((t) => (
          <text key={`x${t}`} x={x(t)} y={height - 18} textAnchor="middle" className="viz-axis">
            {compact(t)}
          </text>
        ))}
        <text x={(w + P.l) / 2} y={height - 3} textAnchor="middle" className="viz-axis">
          {xLabel}
        </text>
        {shown.map((p, i) => (
          <circle key={i} cx={x(p.x)} cy={y(p.y)} r={hover === i ? 6 : 4} fill={SERIES[0]} fillOpacity={0.75} stroke="#fff" strokeWidth={1.5} onPointerEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover !== null && shown[hover] && (
        <Tip x={Math.min(x(shown[hover].x), w - 140)} y={Math.max(0, y(shown[hover].y) - 50)}>
          {xLabel}: <b>{num(shown[hover].x)}</b>, {yLabel}: <b>{num(shown[hover].y)}</b>
          <div className="muted">{new Date(shown[hover].ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
        </Tip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- heatmap (day × hour)

export function Heatmap({ points, days, unit }: { points: Pt[]; days: number; unit: string }) {
  const { set, w } = useWidth();
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const grid: (number | null)[][] = Array.from({ length: days }, () => new Array(24).fill(null));
  for (const p of points) {
    const t = new Date(p.ts);
    const d = Math.floor((new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() - start.getTime()) / 86400e3);
    if (d >= 0 && d < days) grid[d][t.getHours()] = p.value;
  }
  const vals = grid.flat().filter((v): v is number => v !== null);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const color = (v: number) => SEQ[Math.round(clamp01((v - lo) / (hi - lo || 1)) * (SEQ.length - 1))];
  const labelW = 54;
  const cw = (w - labelW) / 24;
  const ch = Math.min(22, Math.max(12, cw * 0.8));
  const height = days * ch + 22;
  return (
    <div className="viz" ref={set} onPointerLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={`Hourly average for the last ${days} days`}>
        {grid.map((row, d) => {
          const day = new Date(start.getTime() + d * 86400e3);
          return (
            <g key={d}>
              <text x={labelW - 6} y={d * ch + ch / 2 + 4} textAnchor="end" className="viz-axis">
                {day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
              </text>
              {row.map((v, h) => (
                <rect
                  key={h}
                  x={labelW + h * cw + 1}
                  y={d * ch + 1}
                  width={Math.max(1, cw - 2)}
                  height={ch - 2}
                  rx={2}
                  fill={v === null ? '#f1f3f5' : color(v)}
                  stroke={hover?.d === d && hover.h === h ? '#14202e' : 'none'}
                  onPointerEnter={() => setHover({ d, h })}
                />
              ))}
            </g>
          );
        })}
        {[0, 6, 12, 18, 23].map((h) => (
          <text key={h} x={labelW + h * cw + cw / 2} y={height - 6} textAnchor="middle" className="viz-axis">
            {String(h).padStart(2, '0')}:00
          </text>
        ))}
      </svg>
      {vals.length > 0 && (
        <div className="viz-scale">
          <span>{num(lo)}</span>
          <i style={{ background: `linear-gradient(90deg, ${SEQ[0]}, ${SEQ[6]}, ${SEQ[12]})` }} />
          <span>
            {num(hi)} {unit}
          </span>
        </div>
      )}
      {hover && (
        <Tip x={Math.min(labelW + hover.h * cw, w - 150)} y={Math.max(0, hover.d * ch - 46)}>
          {new Date(start.getTime() + hover.d * 86400e3).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, {String(hover.h).padStart(2, '0')}:00
          <div>
            <b>{grid[hover.d][hover.h] === null ? 'No data' : `${num(grid[hover.d][hover.h]!)} ${unit}`}</b>
          </div>
        </Tip>
      )}
      {!vals.length && <div className="viz-empty">No readings in this time range</div>}
    </div>
  );
}

// ---------------------------------------------------------------- figures

export function Ring({ frac, children, out }: { frac: number; children: ReactNode; out?: boolean }) {
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <div className="viz-ring">
      <svg viewBox="0 0 130 130" aria-hidden="true">
        <circle cx={65} cy={65} r={R} fill="none" stroke={TRACK} strokeWidth={12} />
        <circle cx={65} cy={65} r={R} fill="none" stroke={out ? '#c8423b' : SERIES[0]} strokeWidth={12} strokeLinecap="round" strokeDasharray={`${C * clamp01(frac)} ${C}`} transform="rotate(-90 65 65)" />
      </svg>
      <div className="viz-ring-center">{children}</div>
    </div>
  );
}

export function Tank({ frac }: { frac: number }) {
  const clip = `tank-${useId().replace(/:/g, '')}`;
  const f = clamp01(frac);
  const H = 120;
  const top = 10 + (1 - f) * H;
  return (
    <svg viewBox="0 0 90 140" className="viz-figure" aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <rect x={10} y={10} width={70} height={H} rx={10} />
        </clipPath>
      </defs>
      <rect x={10} y={10} width={70} height={H} rx={10} fill="#f1f4f7" stroke="#c3ccd5" strokeWidth={2} />
      <g clipPath={`url(#${clip})`}>
        <path d={`M10,${top + 3} Q27,${top - 3} 45,${top + 3} T80,${top + 3} V140 H10Z`} fill={SERIES[0]} fillOpacity={0.85} />
      </g>
      {[0.25, 0.5, 0.75].map((t) => (
        <line key={t} x1={70} x2={80} y1={10 + (1 - t) * H} y2={10 + (1 - t) * H} stroke="#9aa8b6" />
      ))}
    </svg>
  );
}

export function Thermometer({ frac, hot }: { frac: number; hot?: boolean }) {
  const f = clamp01(frac);
  const top = 12;
  const bottom = 100;
  const level = bottom - f * (bottom - top);
  const fill = hot ? '#c8423b' : SERIES[1];
  return (
    <svg viewBox="0 0 60 140" className="viz-figure" aria-hidden="true">
      <rect x={22} y={6} width={16} height={100} rx={8} fill="#f1f4f7" stroke="#c3ccd5" strokeWidth={2} />
      <circle cx={30} cy={116} r={16} fill="#f1f4f7" stroke="#c3ccd5" strokeWidth={2} />
      <rect x={26} y={level} width={8} height={bottom - level + 10} rx={4} fill={fill} />
      <circle cx={30} cy={116} r={11} fill={fill} />
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <line key={t} x1={40} x2={46} y1={bottom - t * (bottom - top)} y2={bottom - t * (bottom - top)} stroke="#9aa8b6" />
      ))}
    </svg>
  );
}

export function Battery({ frac }: { frac: number }) {
  const f = clamp01(frac);
  const color = f <= 0.15 ? '#c8423b' : f <= 0.35 ? '#b7791f' : '#0e9f8a';
  return (
    <svg viewBox="0 0 130 64" className="viz-battery" aria-hidden="true">
      <rect x={4} y={6} width={110} height={52} rx={8} fill="#fff" stroke="#9aa8b6" strokeWidth={3} />
      <rect x={116} y={22} width={8} height={20} rx={3} fill="#9aa8b6" />
      <rect x={10} y={12} width={Math.max(0, 98 * f)} height={40} rx={4} fill={color} />
    </svg>
  );
}

export function Meter({ frac, warn }: { frac: number; warn?: boolean }) {
  return (
    <div className="viz-meter" aria-hidden="true">
      <div style={{ width: `${clamp01(frac) * 100}%`, background: warn ? '#c8423b' : SERIES[0] }} />
    </div>
  );
}
