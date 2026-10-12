import { useMemo, useRef, useState } from 'react';
import { num } from '../format';

export interface Point { ts: string | Date; value: number }

const W = 800;
const PAD = { l: 52, r: 16, t: 14, b: 28 };

function niceTicks(min: number, max: number, count = 5) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}

/** Single-series time chart in plain SVG. Gaps longer than `gapMs` break the line. */
export function Chart({ points, from, to, unit, gapMs, limits, height = 260 }: { points: Point[]; from: Date; to: Date; unit: string; gapMs: number; limits?: { min: number | null; max: number | null }; height?: number }) {
  const H = height;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; p: Point } | null>(null);

  const model = useMemo(() => {
    const pts = points.map((p) => ({ t: new Date(p.ts).getTime(), v: p.value, p }));
    const values = pts.map((p) => p.v);
    if (limits?.min != null) values.push(limits.min);
    if (limits?.max != null) values.push(limits.max);
    const { lo, hi, ticks } = niceTicks(values.length ? Math.min(...values) : 0, values.length ? Math.max(...values) : 1);
    const t0 = from.getTime();
    const t1 = to.getTime();
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
    let d = '';
    const lone: { x: number; y: number }[] = [];
    pts.forEach((p, i) => {
      const gapBefore = i === 0 || p.t - pts[i - 1].t > gapMs;
      const gapAfter = i === pts.length - 1 || pts[i + 1].t - p.t > gapMs;
      d += `${gapBefore ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      if (gapBefore && gapAfter) lone.push({ x: x(p.t), y: y(p.v) });
    });
    const span = t1 - t0;
    const fmt: Intl.DateTimeFormatOptions = span > 2 * 86400e3 ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' };
    const xTicks = Array.from({ length: 6 }, (_, i) => t0 + (span * i) / 5);
    return { pts, ticks, x, y, d, xTicks, fmt, lone };
  }, [points, from, to, gapMs, limits, H]);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = ref.current;
    if (!svg || !model.pts.length) return;
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    let best = model.pts[0];
    for (const p of model.pts) if (Math.abs(model.x(p.t) - vx) < Math.abs(model.x(best.t) - vx)) best = p;
    setHover({ x: (model.x(best.t) / W) * r.width, y: (model.y(best.v) / H) * r.height, p: best.p });
  }

  return (
    <div className="chart">
      <svg ref={ref} style={{ height }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Chart of readings over time">
        <g className="axis">
          {model.ticks.map((t) => (
            <g key={t}>
              <line className="gridline" x1={PAD.l} x2={W - PAD.r} y1={model.y(t)} y2={model.y(t)} />
              <text x={PAD.l - 8} y={model.y(t) + 4} textAnchor="end">
                {num(t)}
              </text>
            </g>
          ))}
          {model.xTicks.map((t, i) => (
            <text key={t} x={model.x(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === 5 ? 'end' : 'middle'}>
              {new Date(t).toLocaleString(undefined, model.fmt)}
            </text>
          ))}
        </g>
        {limits?.min != null && <line className="limit" x1={PAD.l} x2={W - PAD.r} y1={model.y(limits.min)} y2={model.y(limits.min)} />}
        {limits?.max != null && <line className="limit" x1={PAD.l} x2={W - PAD.r} y1={model.y(limits.max)} y2={model.y(limits.max)} />}
        <path className="line" d={model.d} vectorEffect="non-scaling-stroke" />
        {model.lone.map((p, i) => (
          <line key={i} x1={p.x} x2={p.x + 0.01} y1={p.y} y2={p.y} stroke="var(--accent)" strokeWidth={5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
        {hover && <line className="hover-line" x1={(hover.x / (ref.current?.getBoundingClientRect().width || 1)) * W} x2={(hover.x / (ref.current?.getBoundingClientRect().width || 1)) * W} y1={PAD.t} y2={H - PAD.b} vectorEffect="non-scaling-stroke" />}
      </svg>
      {hover && (
        <div className="tip" style={{ left: hover.x, top: hover.y }}>
          <b>
            {num(hover.p.value)}
            {unit ? ` ${unit}` : ''}
          </b>{' '}
          at {new Date(hover.p.ts).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', day: 'numeric', month: 'short' })}
        </div>
      )}
      {!points.length && (
        <div className="empty" style={{ position: 'absolute', inset: 0, justifyContent: 'center' }}>
          No readings in this time range.
        </div>
      )}
    </div>
  );
}
