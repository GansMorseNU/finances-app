import { useState } from 'react';

const COLORS = ['#2c6e8f', '#c8453b', '#7a8b2f', '#8a5aa8', '#d08a1f', '#3a9a8a', '#6b7378'];

function fmt(v: number) {
  return '$' + Math.round(v).toLocaleString('en-US');
}

/** Small line chart for st.line_chart data (index = x labels, one line per series). */
export function LineChart({ index, series }: { index: (string | number | null)[]; series: Record<string, (number | null)[]> }) {
  const names = Object.keys(series);
  const [hover, setHover] = useState<number | null>(null);
  const n = index.length;
  if (n < 2 || !names.length) return null;   // a single point says nothing
  const all = names.flatMap((k) => series[k]).filter((v): v is number => typeof v === 'number');
  if (!all.length) return null;
  let lo = Math.min(0, ...all);
  let hi = Math.max(...all);
  if (hi === lo) hi = lo + 1;
  const W = 340, H = 150, padL = 44, padR = 8, padT = 8, padB = 20;
  const x = (i: number) => padL + (n === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (n - 1));
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const ticks = [lo, (lo + hi) / 2, hi];
  const sel = hover ?? n - 1;

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Chart of ${names.join(', ')}`}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - padL) / (W - padL - padR)) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
        onPointerLeave={() => setHover(null)}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="grid" />
            <text x={padL - 4} y={y(t) + 3} textAnchor="end" className="tick">{fmt(t)}</text>
          </g>
        ))}
        {n > 1 && [0, n - 1].map((i) => (
          <text key={i} x={x(i)} y={H - 4} textAnchor={i === 0 ? 'start' : 'end'} className="tick">{String(index[i] ?? '')}</text>
        ))}
        {names.map((k, si) => {
          const pts = series[k].map((v, i) => (typeof v === 'number' ? `${x(i)},${y(v)}` : null)).filter(Boolean);
          return n === 1
            ? <circle key={k} cx={x(0)} cy={y(series[k][0] ?? 0)} r={3.5} fill={COLORS[si % COLORS.length]} />
            : <polyline key={k} points={pts.join(' ')} fill="none" stroke={COLORS[si % COLORS.length]} strokeWidth={2} strokeLinejoin="round" />;
        })}
        {n > 1 && <line x1={x(sel)} x2={x(sel)} y1={padT} y2={H - padB} className="cursor" />}
      </svg>
      <figcaption>
        <span className="chart-x">{String(index[sel] ?? '')}</span>
        {names.map((k, si) => (
          <span key={k} className="chart-key">
            <i style={{ background: COLORS[si % COLORS.length] }} />
            {names.length > 1 ? `${k} ` : ''}<b>{typeof series[k][sel] === 'number' ? fmt(series[k][sel] as number) : '–'}</b>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
