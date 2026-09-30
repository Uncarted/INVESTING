import { useEffect, useRef, useState } from 'react';

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Smoothly animates towards `target`. First render counts up from `from`. */
export function useTween(target: number, duration = 900, from = 0): number {
  const [v, setV] = useState(reducedMotion() ? target : from);
  const cur = useRef(v);
  useEffect(() => {
    if (reducedMotion()) {
      cur.current = target;
      setV(target);
      return;
    }
    const start = cur.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / duration);
      const x = start + (target - start) * easeOutExpo(k);
      cur.current = x;
      setV(x);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

/** Renders a formatted number that counts to its value. */
export function CountUp({ value, format, duration }: { value: number; format: (v: number) => string; duration?: number }) {
  const v = useTween(value, duration);
  return <>{format(v)}</>;
}

/** Wraps a value and briefly flashes green/red whenever it goes up/down. */
export function Flash({ value, children, className = '' }: { value: number; children: React.ReactNode; className?: string }) {
  const prev = useRef(value);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (value === prev.current) return;
    setDir(value > prev.current ? 'up' : 'down');
    setTick((t) => t + 1);
    prev.current = value;
  }, [value]);
  return (
    <span key={tick} className={`${className} ${dir ? 'flash-' + dir : ''}`}>
      {children}
    </span>
  );
}
