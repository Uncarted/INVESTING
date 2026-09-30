import { useMemo, useRef, useState } from 'react';
import { money, moneyCompact, percent, fmtMonth } from '../lib/format';

export interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** Stacked composition bar + ranked list with direct labels (legend and values in one). */
export function Allocation({ slices, onSelect }: { slices: Slice[]; onSelect?: (key: string) => void }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const sorted = [...slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const max = sorted[0]?.value ?? 1;
  const [hover, setHover] = useState<string | null>(null);
  if (!total) return <div className="muted small">Sem dados.</div>;
  return (
    <div>
      <div className="stackbar" role="img" aria-label="Composição">
        {sorted.map((s) => (
          <div
            key={s.key}
            title={`${s.label}: ${percent(s.value / total)}`}
            style={{ width: `${(s.value / total) * 100}%`, background: s.color, opacity: hover && hover !== s.key ? 0.35 : 1 }}
          />
        ))}
      </div>
      <div className="alloc-list">
        {sorted.map((s) => (
          <div
            key={s.key}
            className="alloc-row"
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onSelect?.(s.key)}
            style={{ cursor: onSelect ? 'pointer' : undefined }}
          >
            <span className="dot" style={{ background: s.color, width: 10, height: 10, borderRadius: 3 }} />
            <span>{s.label}</span>
            <span className="num text-2">{money(s.value)}</span>
            <span className="num" style={{ fontWeight: 600 }}>{percent(s.value / total)}</span>
            <div className="bar">
              <div style={{ width: `${(s.value / max) * 100}%`, background: s.color }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Single-series area chart with crosshair tooltip. */
export function AreaChart({ data, height = 220, compact }: { data: { month: string; value: number }[]; height?: number; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const pad = compact ? { l: 6, r: 6, t: 10, b: 22 } : { l: 56, r: 12, t: 12, b: 26 };
  const { ticks, x, y, path, area } = useMemo(() => {
    const max = Math.max(1, ...data.map((d) => d.value));
    const step = niceStep(max / (compact ? 2 : 4));
    const top = Math.ceil(max / step) * step;
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
    const x = (i: number) => pad.l + (data.length <= 1 ? 0.5 : i / (data.length - 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
    const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`);
    const path = 'M' + pts.join('L');
    const area = `${path}L${x(data.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
    return { ticks, x, y, path, area };
  }, [data, H]);

  if (data.length < 2) return <div className="muted small" style={{ padding: 24 }}>Adicione lançamentos para ver a evolução.</div>;

  const labelEvery = Math.max(1, Math.ceil(data.length / (compact ? 5 : 8)));
  const onMove = (e: React.MouseEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };
  const h = hover !== null ? data[hover] : null;
  return (
    <div className={'chart' + (compact ? ' compact' : '')} ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Evolução do valor aplicado">
        <defs>
          <linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--line)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--line)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} strokeDasharray={t === 0 ? undefined : '2 4'} />
            {compact ? t > 0 && <text className="tick" x={pad.l} y={y(t) - 5}>{moneyCompact(t)}</text> : <text className="tick" x={pad.l - 8} y={y(t) + 4} textAnchor="end">{moneyCompact(t)}</text>}
          </g>
        ))}
        {data.map((d, i) =>
          (i % labelEvery === 0 && data.length - 1 - i >= labelEvery / 2) || i === data.length - 1 ? (
            <text key={d.month} className="tick" x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}>{fmtMonth(d.month)}</text>
          ) : null,
        )}
        <path d={area} fill="url(#areaFill)" className="area-fade" />
        <path d={path} fill="none" stroke="var(--line)" strokeWidth={2} strokeLinejoin="round" pathLength={1} className="line-draw" />
        {h && hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={y(0)} stroke="var(--axis)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(h.value)} r={5} fill="var(--line)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {h && hover !== null && (
        <div className="tooltip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(h.value) / H) * 100}%` }}>
          <div className="muted">{fmtMonth(h.month)}</div>
          <div style={{ fontWeight: 650 }}>{money(h.value)}</div>
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Vertical bars per month (proventos). */
export function MonthBars({ data, height = 180 }: { data: { label: string; value: number }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const pad = { l: 56, r: 8, t: 10, b: 24 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const bw = (W - pad.l - pad.r) / data.length;
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Proventos por mês">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} />
            <text className="tick" x={pad.l - 8} y={y(t) + 4} textAnchor="end">{moneyCompact(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 = pad.l + i * bw;
          const bh = Math.max(0, y(0) - y(d.value));
          const w = Math.min(28, bw - 6);
          const cx = x0 + bw / 2;
          const r = Math.min(4, bh);
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={x0} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {bh > 0 && (
                <path
                  d={`M${cx - w / 2},${y(0)}V${y(d.value) + r}q0,-${r} ${r},-${r}H${cx + w / 2 - r}q${r},0 ${r},${r}V${y(0)}Z`}
                  fill="var(--c-FII)"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              <text className="tick" x={cx} y={H - 6} textAnchor="middle">{d.label}</text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${((pad.l + hover * bw + bw / 2) / W) * 100}%`, top: `${(y(data[hover].value) / H) * 100}%` }}>
          <div className="muted">{data[hover].label}</div>
          <div style={{ fontWeight: 650 }}>{money(data[hover].value)}</div>
        </div>
      )}
    </div>
  );
}
