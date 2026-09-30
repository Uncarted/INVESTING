import type { Settings } from './types';
import { today } from './format';

/**
 * Price lookup for the entry form: today's price or the close on any past date.
 * - Crypto: Binance (no key).
 * - B3: brapi (quote + daily history).
 * - US: Finnhub for today; Twelve Data for past dates (both free keys). Falls back between them.
 */
export type Market = 'US' | 'B3' | 'CRYPTO';

export type PriceResult =
  | { ok: true; price: number; date: string; source: string; exact: boolean }
  | { ok: false; reason: 'needs-key' | 'unavailable' | 'network'; hint?: string };

const cache = new Map<string, Promise<PriceResult>>();

export function priceOn(symbol: string, market: Market, date: string, s: Settings): Promise<PriceResult> {
  const key = [symbol, market, date, s.finnhubToken ?? '', s.brapiToken ?? '', s.twelveDataToken ?? ''].join('|');
  let p = cache.get(key);
  if (!p) {
    p = lookup(symbol.toUpperCase(), market, date, s).catch(() => ({ ok: false, reason: 'network' }) as PriceResult);
    cache.set(key, p);
    // Don't keep failures around: the user may add a key or come back online.
    p.then((r) => !r.ok && cache.delete(key));
  }
  return p;
}

async function getJSON(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(String(res.status)), { status: res.status });
  return res.json();
}

const ok = (price: number, date: string, source: string, target: string): PriceResult =>
  price > 0 ? { ok: true, price, date, source, exact: date === target } : { ok: false, reason: 'unavailable' };

const toISO = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function lookup(symbol: string, market: Market, date: string, s: Settings): Promise<PriceResult> {
  const isToday = date >= today();
  if (market === 'CRYPTO') return crypto(symbol, date, isToday);
  if (market === 'B3') return b3(symbol, date, isToday, s);
  return us(symbol, date, isToday, s);
}

async function crypto(coin: string, date: string, isToday: boolean): Promise<PriceResult> {
  const pair = `${coin}BRL`;
  if (isToday) {
    const j = await getJSON(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
    return ok(Number(j.price), date, 'Binance', date);
  }
  const start = Date.parse(date + 'T00:00:00Z');
  const j = await getJSON(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&startTime=${start}&limit=1`);
  const k = j?.[0];
  return k ? ok(Number(k[4]), toISO(k[0]), 'Binance', date) : { ok: false, reason: 'unavailable' };
}

function brapiRange(date: string) {
  const days = (Date.now() - Date.parse(date + 'T12:00:00')) / 86400000;
  return days <= 5 ? '5d' : days <= 28 ? '1mo' : days <= 88 ? '3mo' : days <= 175 ? '6mo' : days <= 360 ? '1y' : days <= 720 ? '2y' : days <= 1800 ? '5y' : 'max';
}

async function b3(symbol: string, date: string, isToday: boolean, s: Settings): Promise<PriceResult> {
  const auth = s.brapiToken ? `&token=${encodeURIComponent(s.brapiToken)}` : '';
  try {
    if (isToday) {
      const j = await getJSON(`https://brapi.dev/api/quote/${encodeURIComponent(symbol)}?${auth.slice(1)}`);
      return ok(j?.results?.[0]?.regularMarketPrice, date, 'brapi', date);
    }
    const j = await getJSON(`https://brapi.dev/api/quote/${encodeURIComponent(symbol)}?range=${brapiRange(date)}&interval=1d${auth}`);
    const hist: { date: number; close: number }[] = j?.results?.[0]?.historicalDataPrice ?? [];
    const end = Date.parse(date + 'T23:59:59Z') / 1000;
    const bar = hist.filter((h) => h.date <= end && h.close > 0).sort((a, b) => b.date - a.date)[0];
    return bar ? ok(bar.close, toISO(bar.date * 1000), 'brapi', date) : { ok: false, reason: 'unavailable', hint: 'Histórico longo pode exigir o plano pago da brapi.' };
  } catch (e) {
    const st = (e as { status?: number }).status;
    if (st === 401 || st === 403) return { ok: false, reason: 'needs-key', hint: 'Adicione o token grátis da brapi em Ajustes.' };
    throw e;
  }
}

async function us(symbol: string, date: string, isToday: boolean, s: Settings): Promise<PriceResult> {
  if (isToday && s.finnhubToken) {
    try {
      const j = await getJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${s.finnhubToken}`);
      if (j?.c > 0) return ok(j.c, date, 'Finnhub', date);
    } catch {
      /* fall through */
    }
  }
  if (s.twelveDataToken) {
    const k = `apikey=${encodeURIComponent(s.twelveDataToken)}`;
    if (isToday) {
      const j = await getJSON(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&${k}`);
      if (Number(j?.price) > 0) return ok(Number(j.price), date, 'Twelve Data', date);
    }
    // end_date is exclusive for daily bars: ask up to the next day and take the last bar.
    const next = toISO(Date.parse(date + 'T12:00:00Z') + 86400000);
    const j = await getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&end_date=${next}&outputsize=1&${k}`);
    const v = j?.values?.[0];
    if (v) return ok(Number(v.close), String(v.datetime).slice(0, 10), 'Twelve Data', date);
    return { ok: false, reason: 'unavailable' };
  }
  if (!isToday && s.finnhubToken) {
    // Finnhub candles are premium on most accounts, but try.
    try {
      const from = Math.floor(Date.parse(date + 'T00:00:00Z') / 1000) - 5 * 86400;
      const to = Math.floor(Date.parse(date + 'T23:59:59Z') / 1000);
      const j = await getJSON(`https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${s.finnhubToken}`);
      if (j?.s === 'ok' && j.c?.length) return ok(j.c[j.c.length - 1], toISO(j.t[j.t.length - 1] * 1000), 'Finnhub', date);
    } catch {
      /* premium endpoint */
    }
  }
  return {
    ok: false,
    reason: 'needs-key',
    hint: isToday ? 'Adicione a chave grátis da Finnhub em Ajustes.' : 'Para preços de datas passadas, adicione a chave grátis da Twelve Data em Ajustes.',
  };
}

/** Twelve Data symbol search (works without a key) — covers US and Brazil. */
export async function twelveSearch(q: string): Promise<{ symbol: string; name: string; market: 'US' | 'B3' }[]> {
  try {
    const j = await getJSON(`https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=12`);
    return (j?.data ?? [])
      .filter((d: { country: string; instrument_type: string }) => (d.country === 'United States' || d.country === 'Brazil') && /Stock|ETF|REIT|Depositary/i.test(d.instrument_type))
      .map((d: { symbol: string; instrument_name: string; country: string }) => ({
        symbol: d.symbol,
        name: d.instrument_name,
        market: d.country === 'Brazil' ? 'B3' : 'US',
      }));
  } catch {
    return [];
  }
}
