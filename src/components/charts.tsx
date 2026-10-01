import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MONTHS, fmtDate, money, moneyCompact, percent, fmtMonth, toISODate } from '../lib/format';
import { locale, t } from '../lib/i18n';

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
  if (!total) return <div className="muted small">{t('Sem dados.', 'No data.')}</div>;
  return (
    <div>
      <div className="stackbar" role="img" aria-label={t('Composição', 'Composition')}>
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

  if (data.length < 2) return <div className="muted small" style={{ padding: 24 }}>{t('Adicione lançamentos para ver a evolução.', 'Add transactions to see the history.')}</div>;

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
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Evolução do valor aplicado', 'Amount invested over time')}>
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
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Proventos por mês', 'Dividends per month')}>
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

// ---------------------------------------------------------------------------
// Time-series line chart (portfolio value, asset prices).

export interface LinePoint {
  t: number;
  v: number;
  /** Optional second, dashed series (e.g. amount invested). */
  b?: number;
}

const fmtAxisDate = (t: number, mode: 'intraday' | 'hourly' | 'daily', span: number) => {
  const d = new Date(t);
  if (mode === 'intraday') return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  if (span > 400 * 86400000) return `${MONTHS[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
export const fmtTipDate = (t: number, mode: 'intraday' | 'hourly' | 'daily') => {
  const d = new Date(t);
  const day = fmtDate(toISODate(d));
  return mode === 'daily' ? day : `${day} · ${d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`;
};

export function LineChart({
  points,
  tone,
  height = 200,
  format,
  mode = 'daily',
  markers,
  refLine,
  tip,
  animKey,
  axis = true,
  onHover,
  hideTip,
}: {
  points: LinePoint[];
  tone: 'pos' | 'neg' | 'flat';
  height?: number;
  format: (v: number) => string;
  mode?: 'intraday' | 'hourly' | 'daily';
  markers?: { t: number; kind: 'buy' | 'sell' }[];
  refLine?: { v: number; label: string };
  tip?: (p: LinePoint, i: number) => React.ReactNode;
  animKey?: string;
  axis?: boolean;
  onHover?: (i: number | null) => void;
  hideTip?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const pad = { l: 2, r: axis ? 66 : 2, t: 10, b: axis ? 24 : 4 };
  const color = tone === 'pos' ? 'var(--pos)' : tone === 'neg' ? 'var(--neg)' : 'var(--line)';
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const vals = points.flatMap((p) => (p.b !== undefined ? [p.v, p.b] : [p.v]));
    if (refLine) vals.push(refLine.v);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi - lo < Math.abs(hi) * 0.002) {
      hi += Math.abs(hi) * 0.01 || 1;
      lo -= Math.abs(lo) * 0.01 || 1;
    }
    const padV = (hi - lo) * 0.1;
    lo -= padV;
    hi += padV;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    // Intraday/hourly: evenly spaced (skips nights and weekends); daily: true time scale.
    const x = (i: number) => pad.l + (mode === 'daily' ? (points[i].t - t0) / (t1 - t0 || 1) : i / (points.length - 1)) * (w - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const line = 'M' + points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('L');
    const base = points.some((p) => p.b !== undefined) ? 'M' + points.map((p, i) => `${x(i).toFixed(1)},${y(p.b ?? p.v).toFixed(1)}`).join('L') : '';
    const area = `${line}L${x(points.length - 1).toFixed(1)},${H - pad.b}L${x(0).toFixed(1)},${H - pad.b}Z`;
    const step = niceStep((hi - lo) / 3);
    const ticks: number[] = [];
    for (let k = Math.ceil(lo / step); k * step <= hi; k++) ticks.push(k * step || 0);
    const n = Math.min(5, Math.max(2, Math.floor(w / 110)));
    const labels = Array.from({ length: n }, (_, k) => Math.round((k / (n - 1)) * (points.length - 1)));
    return { x, y, line, base, area, ticks, labels, span: t1 - t0 };
  }, [points, w, H, mode, refLine?.v, axis]);

  if (!geo) return <div className="chart-empty" style={{ height: H }} />;
  const { x, y, line, base, area, ticks, labels, span } = geo;

  const onMove = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const px = clientX - rect.left;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(x(i) - px);
      if (d < bd) (bd = d), (best = i);
    }
    setHover(best);
    onHover?.(best);
  };
  const hp = hover !== null ? points[hover] : null;
  const gid = `lg-${tone}`;
  const nearest = (t: number) => {
    let best = 0;
    for (let i = 0; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    return best;
  };

  return (
    <div
      className="lchart"
      ref={ref}
      onPointerMove={(e) => onMove(e.clientX)}
      onPointerDown={(e) => onMove(e.clientX)}
      onPointerLeave={() => {
        setHover(null);
        onHover?.(null);
      }}
      style={{ height: H }}
    >
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {axis &&
          ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeDasharray="2 5" />
              <text className="tick" x={w - pad.r + 8} y={y(v) + 4}>{format(v)}</text>
            </g>
          ))}
        {axis &&
          labels.map((i, k) => (
            <text key={k} className="tick" x={x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : k === labels.length - 1 ? 'end' : 'middle'}>
              {fmtAxisDate(points[i].t, mode, span)}
            </text>
          ))}
        <g key={animKey}>
          <path d={area} fill={`url(#${gid})`} className="area-fade" />
          {base && <path d={base} fill="none" stroke="var(--text-3, var(--muted))" strokeWidth={1.25} strokeDasharray="4 4" opacity={0.7} />}
          {refLine && (
            <g>
              <line x1={pad.l} x2={w - pad.r} y1={y(refLine.v)} y2={y(refLine.v)} stroke="var(--muted)" strokeDasharray="1 4" strokeWidth={1.25} />
              <text className="tick ref" x={pad.l + 4} y={y(refLine.v) - 5}>{refLine.label}</text>
            </g>
          )}
          <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="line-draw" />
          {markers?.map((m, k) => {
            const i = nearest(m.t);
            return <circle key={k} cx={x(i)} cy={y(points[i].v)} r={3.5} fill={m.kind === 'buy' ? 'var(--pos)' : 'var(--neg)'} stroke="var(--surface)" strokeWidth={1.5} className="marker" />;
          })}
        </g>
        {hp && hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--axis)" />
            {hp.b !== undefined && <circle cx={x(hover)} cy={y(hp.b)} r={3} fill="var(--surface)" stroke="var(--muted)" strokeWidth={1.5} />}
            <circle cx={x(hover)} cy={y(hp.v)} r={4.5} fill={color} stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && hover !== null && !hideTip && (
        <div className={'ltip' + (x(hover) > w * 0.5 ? ' left' : '')} style={{ left: x(hover) }}>
          <div className="muted">{fmtTipDate(hp.t, mode)}</div>
          {tip ? tip(hp, hover) : <b>{format(hp.v)}</b>}
        </div>
      )}
    </div>
  );
}
