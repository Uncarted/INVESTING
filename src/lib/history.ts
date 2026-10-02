import { apiKey } from './cloud';
import { useEffect, useMemo, useState } from 'react';
import type { Asset, Settings, Transaction } from './types';
import { isMarketClass } from './types';
import { computePositions, currencyOf, sortTx } from './portfolio';
import { toISODate, today } from './format';

/**
 * Price history for charts: the portfolio's value over time and each asset's own chart.
 * Same free sources as the rest of the app: Binance (crypto), brapi (B3), Twelve Data (US),
 * Frankfurter/AwesomeAPI (dollar and euro). Daily bars are cached in localStorage for the day.
 */

export type Range = '1D' | '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | '5Y' | 'ALL';
export interface Bar {
  t: number; // ms
  close: number;
}

const DAY = 86400000;
const iso = (ms: number) => toISODate(new Date(ms));
const midday = (d: string) => Date.parse(d + 'T12:00:00');

/** First day of a range (for ALL, the first transaction date is used by the caller). */
export function rangeStart(r: Range, first?: string): string {
  const d = new Date();
  if (r === '1D') d.setDate(d.getDate() - 1);
  else if (r === '1W') d.setDate(d.getDate() - 7);
  else if (r === '1M') d.setMonth(d.getMonth() - 1);
  else if (r === '3M') d.setMonth(d.getMonth() - 3);
  else if (r === '6M') d.setMonth(d.getMonth() - 6);
  else if (r === 'YTD') d.setMonth(0, 1);
  else if (r === '1Y') d.setFullYear(d.getFullYear() - 1);
  else if (r === '5Y') d.setFullYear(d.getFullYear() - 5);
  else return first ?? iso(Date.now() - 365 * DAY);
  return toISODate(d);
}

type Kind = 'CRYPTO' | 'B3' | 'US';
const kindOf = (a: Asset): Kind => (a.cls === 'CRIPTO' ? 'CRYPTO' : currencyOf(a) === 'BRL' ? 'B3' : 'US');

async function getJSON(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(String(res.status)), { status: res.status });
  return res.json();
}

// Twelve Data's free plan allows 8 requests a minute: space them out.
let tdQueue: Promise<unknown> = Promise.resolve();
const tdTimes: number[] = [];
function twelve<T>(url: string): Promise<T> {
  const run = async () => {
    const now = Date.now();
    while (tdTimes.length && now - tdTimes[0] > 61000) tdTimes.shift();
    if (tdTimes.length >= 7) await new Promise((r) => setTimeout(r, 61000 - (now - tdTimes[0])));
    tdTimes.push(Date.now());
    return getJSON(url) as Promise<T>;
  };
  const p = tdQueue.then(run, run);
  tdQueue = p.catch(() => undefined);
  return p;
}

type Grain = 'intraday' | 'hourly' | 'daily';
const grainOf = (r: Range): Grain => (r === '1D' ? 'intraday' : r === '1W' ? 'hourly' : 'daily');

async function fetchBars(a: Asset, from: string, grain: Grain, s: Settings): Promise<Bar[]> {
  const sym = a.ticker.toUpperCase();
  const kind = kindOf(a);
  if (kind === 'CRYPTO') {
    const interval = grain === 'intraday' ? '5m' : grain === 'hourly' ? '1h' : '1d';
    const out: Bar[] = [];
    let start = grain === 'intraday' ? Date.now() - DAY : Date.parse(from + 'T00:00:00Z');
    for (let i = 0; i < 6; i++) {
      const j: unknown[][] = await getJSON(`https://api.binance.com/api/v3/klines?symbol=${sym}BRL&interval=${interval}&startTime=${start}&limit=1000`);
      for (const k of j) out.push({ t: grain === 'daily' ? midday(iso(Number(k[0]))) : Number(k[0]), close: Number(k[4]) });
      if (j.length < 1000) break;
      start = Number(j[j.length - 1][0]) + 1;
    }
    return out;
  }
  if (kind === 'B3') {
    const auth = apiKey(s, 'brapi') ? `&token=${encodeURIComponent(apiKey(s, 'brapi') ?? '')}` : '';
    const days = (Date.now() - midday(from)) / DAY;
    const [range, interval] =
      grain === 'intraday' ? ['1d', '5m'] : grain === 'hourly' ? ['5d', '1h']
      : [days <= 28 ? '1mo' : days <= 88 ? '3mo' : days <= 175 ? '6mo' : days <= 360 ? '1y' : days <= 720 ? '2y' : days <= 1800 ? '5y' : 'max', '1d'];
    const j = await getJSON(`https://brapi.dev/api/quote/${encodeURIComponent(sym)}?range=${range}&interval=${interval}${auth}`);
    const hist: { date: number; close: number }[] = j?.results?.[0]?.historicalDataPrice ?? [];
    return hist
      .filter((h) => h.close > 0)
      .map((h) => ({ t: grain === 'daily' ? midday(iso(h.date * 1000)) : h.date * 1000, close: h.close }));
  }
  if (!apiKey(s, 'twelve')) return [];
  const k = `apikey=${encodeURIComponent(apiKey(s, 'twelve') ?? '')}`;
  const q =
    grain === 'intraday' ? 'interval=5min&outputsize=100'
    : grain === 'hourly' ? 'interval=1h&outputsize=60'
    : `interval=1day&start_date=${from}&outputsize=5000`;
  const j = await twelve<{ values?: { datetime: string; close: string }[] }>(
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&${q}&timezone=UTC&${k}`,
  );
  return (j?.values ?? [])
    .map((v) => ({ t: v.datetime.length <= 10 ? midday(v.datetime) : Date.parse(v.datetime.replace(' ', 'T') + 'Z'), close: Number(v.close) }))
    .filter((b) => b.close > 0)
    .reverse();
}

const mem = new Map<string, Promise<Bar[]>>();
const LS = 'wallet:px:';

/** Bars for an asset (native currency), oldest first. Never throws: failures return []. */
export function priceSeries(a: Asset, from: string, grain: Grain, s: Settings): Promise<Bar[]> {
  if (!isMarketClass(a.cls) || a.cls === 'CAIXA') return Promise.resolve([]);
  const kind = kindOf(a);
  const id = `${kind}:${a.ticker.toUpperCase()}:${grain}`;
  const day = today();
  if (grain === 'daily') {
    try {
      const c = JSON.parse(localStorage.getItem(LS + id) ?? 'null') as { day: string; from: string; bars: Bar[] } | null;
      if (c && c.day === day && c.from <= from) return Promise.resolve(c.bars);
    } catch {
      /* no cache */
    }
  }
  const key = `${id}:${grain === 'daily' ? from : Math.floor(Date.now() / 120000)}`;
  let p = mem.get(key);
  if (!p) {
    p = fetchBars(a, from, grain, s).catch(() => [] as Bar[]);
    mem.set(key, p);
    p.then((bars) => {
      if (!bars.length) return mem.delete(key);
      if (grain === 'daily')
        try {
          localStorage.setItem(LS + id, JSON.stringify({ day, from, bars }));
        } catch {
          /* storage full */
        }
    });
  }
  return p;
}

/** Daily dollar and euro rates (BRL per unit) since `from`. */
const fxMem = new Map<string, Promise<{ USD: Bar[]; EUR: Bar[] }>>();
export function fxSeries(from: string): Promise<{ USD: Bar[]; EUR: Bar[] }> {
  let p = fxMem.get(from);
  if (p) return p;
  p = (async () => {
    const to = today();
    for (const url of [
      `https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=BRL,EUR`,
      `https://api.frankfurter.app/${from}..${to}?from=USD&to=BRL,EUR`,
    ]) {
      try {
        const j = await getJSON(url);
        const USD: Bar[] = [];
        const EUR: Bar[] = [];
        for (const [d, r] of Object.entries(j?.rates ?? {}) as [string, { BRL: number; EUR: number }][]) {
          if (!(r.BRL > 0)) continue;
          USD.push({ t: midday(d), close: r.BRL });
          if (r.EUR > 0) EUR.push({ t: midday(d), close: r.BRL / r.EUR });
        }
        if (USD.length) return { USD: USD.sort((a, b) => a.t - b.t), EUR: EUR.sort((a, b) => a.t - b.t) };
      } catch {
        /* try the next source */
      }
    }
    return { USD: [], EUR: [] };
  })();
  fxMem.set(from, p);
  p.then((r) => !r.USD.length && fxMem.delete(from));
  return p;
}

/** Last bar at or before `t` (or the first one, if `t` is earlier than the data). */
export function at(bars: Bar[] | undefined, t: number): number | undefined {
  if (!bars?.length) return undefined;
  let lo = 0;
  let hi = bars.length - 1;
  if (t < bars[0].t) return bars[0].close;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return bars[lo].close;
}

export interface HistPoint {
  t: number;
  value: number;
  invested: number;
}

/** Portfolio value and amount invested on each day of the range. */
export function buildHistory(
  assets: Asset[],
  txs: Transaction[],
  settings: Settings,
  from: string,
  bars: Map<string, Bar[]>,
  fx: { USD: Bar[]; EUR: Bar[] },
  now?: { value: number; invested: number },
): HistPoint[] {
  const start = midday(from);
  const end = midday(today());
  const days = Math.max(1, Math.round((end - start) / DAY));
  const step = Math.max(1, Math.ceil(days / 240));
  const out: HistPoint[] = [];
  for (let t = start; t < end; t += step * DAY) {
    const d = iso(t);
    // No history for an asset (e.g. missing key): use today's price rather than a fake jump at the end.
    const priced = assets.map((a) => (isMarketClass(a.cls) ? { ...a, currentPrice: at(bars.get(a.id), t) ?? a.currentPrice, prevClose: undefined } : a));
    const s = { ...settings, fx: { ...settings.fx, USD: at(fx.USD, t) ?? settings.fx.USD, EUR: at(fx.EUR, t) ?? settings.fx.EUR } };
    const pos = computePositions(priced, txs, s, d);
    out.push({ t, value: pos.reduce((x, p) => x + p.value, 0), invested: pos.reduce((x, p) => x + p.cost, 0) });
  }
  if (now) out.push({ t: end, ...now });
  return out;
}

/** Loads everything needed for the portfolio chart, progressively (the chart fills in as data arrives). */
export function usePortfolioHistory(
  range: Range,
  assets: Asset[],
  txs: Transaction[],
  settings: Settings,
  now: { value: number; invested: number },
) {
  const first = useMemo(() => sortTx(txs)[0]?.date, [txs]);
  const from = range === 'ALL' ? first ?? today() : rangeStart(range);
  const held = useMemo(() => {
    const ids = new Set(txs.map((x) => x.assetId));
    return assets.filter((a) => isMarketClass(a.cls) && ids.has(a.id));
  }, [assets, txs]);
  const [bars, setBars] = useState<Map<string, Bar[]>>(new Map());
  const [fx, setFx] = useState<{ USD: Bar[]; EUR: Bar[] }>({ USD: [], EUR: [] });
  const [pending, setPending] = useState(0);
  const keys = `${apiKey(settings, 'brapi')}|${apiKey(settings, 'twelve')}`;

  useEffect(() => {
    if (range === '1D') return;
    let alive = true;
    setPending(held.length + 1);
    fxSeries(from).then((r) => alive && (setFx(r), setPending((n) => n - 1)));
    for (const a of held)
      priceSeries(a, from, 'daily', settings).then((b) => {
        if (!alive) return;
        setBars((m) => new Map(m).set(a.id, b));
        setPending((n) => n - 1);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, from, held.map((a) => a.id + a.ticker).join(), keys]);

  // The history only changes when data arrives; live ticks just move the last point (cheap).
  const base = useMemo(
    () => (range === '1D' ? [] : buildHistory(assets, txs, settings, from, bars, fx)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, from, bars, fx, txs, assets.length],
  );
  const points = useMemo(() => (range === '1D' ? [] : [...base, { t: Date.parse(today() + 'T12:00:00'), ...now }]), [base, range, now]);
  const missing = held.filter((a) => bars.has(a.id) && !bars.get(a.id)!.length).map((a) => a.ticker);
  return { points, loading: pending > 0, missing };
}

/** An asset's own price chart. */
export function useAssetSeries(asset: Asset | undefined, range: Range, settings: Settings) {
  const [state, setState] = useState<{ key: string; bars: Bar[] }>({ key: '', bars: [] });
  const from = rangeStart(range);
  const grain = grainOf(range);
  const key = asset ? `${asset.id}:${asset.ticker}:${range}:${apiKey(settings, 'brapi')}|${apiKey(settings, 'twelve')}` : '';
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    priceSeries(asset, from, grain, settings).then((bars) => {
      if (!alive) return;
      const start = grain === 'daily' ? midday(from) : 0;
      let b = bars.filter((x) => x.t >= start);
      // Intraday: only the last trading session.
      if (grain === 'intraday' && b.length) {
        const lastDay = iso(b[b.length - 1].t);
        b = b.filter((x) => iso(x.t) === lastDay);
      }
      setState({ key, bars: b });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const bars = state.key === key ? state.bars : null;
  // Keep the last point in sync with the live price.
  const withLive = useMemo(() => {
    if (!bars || !bars.length || !asset?.currentPrice) return bars;
    const last = bars[bars.length - 1];
    const now = grain === 'daily' ? midday(today()) : Date.now();
    return last.t >= now - (grain === 'daily' ? 0 : 60000) ? [...bars.slice(0, -1), { t: last.t, close: asset.currentPrice }] : [...bars, { t: now, close: asset.currentPrice }];
  }, [bars, asset?.currentPrice, grain]);
  return { bars: withLive, loading: bars === null, intraday: grain !== 'daily' };
}
