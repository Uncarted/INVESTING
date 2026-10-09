import { apiKey, yahooUrl } from './cloud';
import type { Asset, Settings } from './types';
import { fxSeries, priceSeries, type Bar } from './history';
import { twelveSearch } from './prices';
import { searchDirectory } from './tickers';
import type { LogoMarket } from '../components/Logo';

/**
 * "What if I had bought…": any stock, ETF or coin, at any past date.
 * Yahoo Finance (through the "quotes" function) covers exchanges worldwide and has dividend-adjusted
 * prices; without it we fall back to brapi (B3), Twelve Data (US) and Binance (crypto).
 */

export interface Hit {
  symbol: string; // as the source knows it (PETR4.SA, 7203.T, BTC-USD…)
  ticker: string; // for display and logos
  name: string;
  exch: string;
  market: LogoMarket;
  src: 'yahoo' | 'b3' | 'us' | 'crypto';
}

export interface Series {
  currency: string;
  bars: Bar[]; // price
  adj?: Bar[]; // dividends reinvested
}

const DAY = 86400000;
const midday = (ms: number) => Date.parse(new Date(ms).toISOString().slice(0, 10) + 'T12:00:00');

async function getJSON(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK', 'LTC', 'MATIC', 'TRX', 'SHIB'];
const COIN_NAMES: Record<string, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB', XRP: 'XRP', ADA: 'Cardano', DOGE: 'Dogecoin', AVAX: 'Avalanche', DOT: 'Polkadot', LINK: 'Chainlink', LTC: 'Litecoin', MATIC: 'Polygon', TRX: 'Tron', SHIB: 'Shiba Inu' };

/** A ready-made hit for quick picks (AAPL, PETR4, BTC…). */
export function quickHit(sym: string): Hit {
  const yahoo = !!yahooUrl('');
  if (COINS.includes(sym)) return { symbol: yahoo ? `${sym}-USD` : sym, ticker: sym, name: COIN_NAMES[sym], exch: 'Crypto', market: 'CRYPTO', src: yahoo ? 'yahoo' : 'crypto' };
  const b3 = /^[A-Z]{4}\d{1,2}$/.test(sym);
  const name = searchDirectory(sym, 1)[0]?.name ?? sym;
  if (b3) return { symbol: yahoo ? `${sym}.SA` : sym, ticker: sym, name, exch: 'B3', market: 'B3', src: yahoo ? 'yahoo' : 'b3' };
  return { symbol: sym, ticker: sym, name, exch: 'NASDAQ/NYSE', market: 'US', src: yahoo ? 'yahoo' : 'us' };
}

const YAHOO_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND', 'CRYPTOCURRENCY', 'INDEX']);

export async function searchAny(q: string): Promise<Hit[]> {
  const query = q.trim();
  if (query.length < 1) return [];
  const yurl = yahooUrl(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`);
  if (yurl) {
    try {
      const j = await getJSON(yurl);
      const out: Hit[] = [];
      for (const r of (j?.quotes ?? []) as { symbol?: string; shortname?: string; longname?: string; exchDisp?: string; quoteType?: string }[]) {
        if (!r.symbol || !YAHOO_TYPES.has(r.quoteType ?? '')) continue;
        const crypto = r.quoteType === 'CRYPTOCURRENCY';
        const sa = r.symbol.endsWith('.SA');
        const ticker = crypto ? r.symbol.replace(/-[A-Z]+$/, '') : sa ? r.symbol.slice(0, -3) : r.symbol;
        out.push({
          symbol: r.symbol,
          ticker,
          name: r.longname || r.shortname || r.symbol,
          exch: crypto ? 'Crypto' : r.exchDisp ?? '',
          market: crypto ? 'CRYPTO' : sa ? 'B3' : r.symbol.includes('.') || r.symbol.startsWith('^') ? 'OTHER' : 'US',
          src: 'yahoo',
        });
      }
      if (out.length) return out;
    } catch {
      /* fall back below */
    }
  }
  const up = query.toUpperCase();
  const out: Hit[] = [];
  for (const c of COINS) if (c.startsWith(up) || COIN_NAMES[c].toUpperCase().startsWith(up)) out.push(quickHit(c));
  for (const d of searchDirectory(query, 6)) out.push({ ...quickHit(d.symbol), name: d.name ?? d.symbol });
  const seen = new Set(out.map((h) => h.ticker));
  for (const r of await twelveSearch(query)) {
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    out.push({ symbol: r.symbol, ticker: r.symbol, name: r.name, exch: r.market === 'B3' ? 'B3' : 'US', market: r.market, src: r.market === 'B3' ? 'b3' : 'us' });
  }
  return out.slice(0, 10);
}

// Yahoo quotes a few markets in cents (London pence, Johannesburg, Tel Aviv).
const MINOR: Record<string, string> = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ILA: 'ILS' };

async function yahooChart(symbol: string, from: number): Promise<Series | null> {
  const span = Date.now() - from;
  const interval = span <= 3 * DAY ? '5m' : span <= 9 * DAY ? '30m' : span > 8 * 365 * DAY ? '1wk' : '1d';
  const intraday = interval.endsWith('m');
  const url = yahooUrl(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${Math.floor((from - (intraday ? DAY : 7 * DAY)) / 1000)}&period2=${Math.floor(Date.now() / 1000)}&interval=${interval}&events=div%2Csplit`);
  if (!url) return null;
  const j = await getJSON(url);
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp?.length) return null;
  let currency: string = r.meta?.currency ?? 'USD';
  const div = MINOR[currency] ? 100 : 1;
  currency = MINOR[currency] ?? currency;
  const close: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
  const adjc: (number | null)[] | undefined = r.indicators?.adjclose?.[0]?.adjclose;
  const bars: Bar[] = [];
  const adj: Bar[] = [];
  r.timestamp.forEach((ts: number, i: number) => {
    const c = close[i];
    if (!(c && c > 0)) return;
    const t = intraday ? ts * 1000 : midday(ts * 1000);
    bars.push({ t, close: c / div });
    const a = adjc?.[i];
    if (a && a > 0) adj.push({ t, close: a / div });
  });
  // Latest price (the last daily bar can lag a little during the session).
  const live = Number(r.meta?.regularMarketPrice);
  if (live > 0 && bars.length) {
    const last = bars[bars.length - 1];
    const ratio = live / div / last.close;
    last.close = live / div;
    if (adj.length) adj[adj.length - 1].close *= ratio;
  }
  return { currency, bars, adj: adj.length === bars.length ? adj : undefined };
}

export async function loadSeries(h: Hit, from: number, s: Settings): Promise<Series | null> {
  if (h.src === 'yahoo') return yahooChart(h.symbol, from);
  const pad = new Date(from - 7 * DAY).toISOString().slice(0, 10);
  const fake = (cls: Asset['cls'], currency: 'BRL' | 'USD') => ({ id: 'sim', ticker: h.symbol, name: h.name, cls, currency }) as unknown as Asset;
  if (h.src === 'us' && !apiKey(s, 'twelve')) return null;
  const asset = h.src === 'crypto' ? fake('CRIPTO', 'BRL') : h.src === 'b3' ? fake('ACAO', 'BRL') : fake('EXTERIOR', 'USD');
  const bars = await priceSeries(asset, pad, 'daily', s);
  return bars.length ? { currency: h.src === 'us' ? 'USD' : 'BRL', bars } : null;
}

/** BRL per unit of `cur` since `from` (ms). */
export async function fxToBRL(cur: string, from: number): Promise<Bar[]> {
  if (cur === 'BRL') return [];
  if (yahooUrl('')) {
    try {
      const r = await yahooChart(`${cur}BRL=X`, from);
      if (r?.bars.length) return r.bars;
    } catch {
      /* try below */
    }
  }
  if (cur === 'USD' || cur === 'EUR') {
    const pad = new Date(from - 7 * DAY).toISOString().slice(0, 10);
    return (await fxSeries(pad))[cur];
  }
  return [];
}
