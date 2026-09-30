import { useEffect, useMemo, useRef, useState } from 'react';
import { easeOutCubic, reducedMotion } from './motion';
import { money, percent } from '../lib/format';
import { t } from '../lib/i18n';

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
  sub?: string;
}

const TAU = Math.PI * 2;
const SIZE = 300;
const C = SIZE / 2;
const R = 128;
const THICK = 38;
const GAP = 0.018; // radians between slices

function arc(a0: number, a1: number, r0: number, r1: number) {
  // Angles start at 12 o'clock, clockwise.
  const p = (a: number, r: number) => [C + r * Math.sin(a), C - r * Math.cos(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(a0, r1);
  const [x1, y1] = p(a1, r1);
  const [x2, y2] = p(a1, r0);
  const [x3, y3] = p(a0, r0);
  return `M${x0},${y0}A${r1},${r1} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large} 0 ${x3},${y3}Z`;
}

/**
 * Animated donut: sweeps in on mount, morphs when the data changes,
 * the hovered slice pops out and the centre shows its details.
 */
export function Donut({
  slices, active, onHover, onSelect, centerLabel, centerValue,
}: {
  slices: DonutSlice[];
  active: string | null;
  onHover: (k: string | null) => void;
  onSelect?: (k: string) => void;
  centerLabel: string;
  centerValue: number;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const target = useMemo(() => new Map(slices.map((s) => [s.key, s.value / total])), [slices, total]);

  // Animated fractions per key + global sweep progress.
  const [fr, setFr] = useState<Map<string, number>>(() => (reducedMotion() ? target : new Map()));
  const [sweep, setSweep] = useState(reducedMotion() ? 1 : 0);
  const frRef = useRef(fr);
  const sweepRef = useRef(sweep);

  useEffect(() => {
    if (reducedMotion()) {
      setFr(target);
      setSweep(1);
      return;
    }
    const from = frRef.current;
    const fromSweep = sweepRef.current;
    const keys = new Set([...from.keys(), ...target.keys()]);
    const t0 = performance.now();
    const D = fromSweep < 1 ? 1100 : 650;
    let raf = 0;
    const step = (now: number) => {
      const k = easeOutCubic(Math.min(1, (now - t0) / D));
      const m = new Map<string, number>();
      for (const key of keys) {
        const a = from.get(key) ?? (fromSweep < 1 ? target.get(key) ?? 0 : 0);
        const b = target.get(key) ?? 0;
        m.set(key, a + (b - a) * k);
      }
      frRef.current = m;
      sweepRef.current = fromSweep + (1 - fromSweep) * k;
      setFr(m);
      setSweep(sweepRef.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const order = slices.map((s) => s.key);
  const bySlice = new Map(slices.map((s) => [s.key, s]));
  let a = 0;
  const paths = order.map((key) => {
    const f = (fr.get(key) ?? 0) * sweep;
    const a0 = a;
    const a1 = a + f * TAU;
    a = a1;
    return { key, a0, a1 };
  });

  const hovered = active ? bySlice.get(active) : null;

  return (
    <div className="donut" onMouseLeave={() => onHover(null)}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={t('Distribuição do patrimônio', 'Portfolio allocation')}>
        <circle cx={C} cy={C} r={R - THICK / 2} fill="none" stroke="var(--surface-2)" strokeWidth={THICK} />
        {paths.map(({ key, a0, a1 }) => {
          const s = bySlice.get(key);
          if (!s || a1 - a0 < 0.002) return null;
          const on = active === key;
          const gap = Math.min(GAP, (a1 - a0) / 3);
          const r1 = on ? R + 8 : R;
          const r0 = on ? R - THICK - 2 : R - THICK;
          return (
            <path
              key={key}
              d={arc(a0 + gap / 2, a1 - gap / 2, r0, r1)}
              fill={s.color}
              opacity={active && !on ? 0.28 : 1}
              style={{ transition: 'opacity .2s', cursor: onSelect ? 'pointer' : 'default' }}
              onMouseEnter={() => onHover(key)}
              onClick={() => onSelect?.(key)}
            />
          );
        })}
      </svg>
      <div className="donut-center">
        {hovered ? (
          <>
            <span className="dc-label">{hovered.label}</span>
            <span className="dc-value">{money(hovered.value)}</span>
            <span className="dc-sub">{percent(hovered.value / total)}{hovered.sub ? ` · ${hovered.sub}` : ''}</span>
          </>
        ) : (
          <>
            <span className="dc-label">{centerLabel}</span>
            <span className="dc-value">{money(centerValue)}</span>
            <span className="dc-sub">{slices.length} {slices.length === 1 ? t('grupo', 'group') : t('grupos', 'groups')}</span>
          </>
        )}
      </div>
    </div>
  );
}
