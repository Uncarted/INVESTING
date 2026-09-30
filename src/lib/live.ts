import { useSyncExternalStore } from 'react';
import type { Asset, Settings } from './types';
import { actions } from './store';
import { currencyOf } from './portfolio';

/**
 * Live quotes.
 * - US / foreign stocks: Finnhub (free key) — REST snapshot + WebSocket trades, real time.
 * - B3 (ações, FIIs, ETFs, BDRs): brapi.dev — polled every minute.
 * - Crypto: Binance public API — REST snapshot + WebSocket ticker, real time, no key.
 * - Dollar/euro: AwesomeAPI — polled every minute, no key.
 * Prices live in memory (ticking UI) and are saved to the assets every ~30s.
 */

export interface Quote {
  price: number;
  prevClose?: number;
  ts: number;
  source: 'finnhub' | 'brapi' | 'binance';
}

export type FeedStatus = 'off' | 'ready' | 'connecting' | 'live' | 'polling' | 'error' | 'needs-key';

interface LiveState {
  quotes: Map<string, Quote>;
  status: { us: FeedStatus; b3: FeedStatus; crypto: FeedStatus; fx: FeedStatus };
  fx?: { USD: number; EUR: number; USDprev?: number };
  version: number;
}

let state: LiveState = {
  quotes: new Map(),
  status: { us: 'off', b3: 'off', crypto: 'off', fx: 'off' },
  version: 0,
};
const listeners = new Set<() => void>();
let notifyQueued = false;
function notify() {
  // Batch bursts of WebSocket ticks into one render per frame.
  if (notifyQueued) return;
  notifyQueued = true;
  requestAnimationFrame(() => {
    notifyQueued = false;
    state = { ...state, version: state.version + 1 };
    listeners.forEach((l) => l());
  });
}
const setStatus = (k: keyof LiveState['status'], v: FeedStatus) => {
  if (state.status[k] === v) return;
  state.status = { ...state.status, [k]: v };
  notify();
};
function setQuote(ticker: string, q: Omit<Quote, 'ts'>) {
  const key = ticker.toUpperCase();
  const old = state.quotes.get(key);
  state.quotes.set(key, { ...q, prevClose: q.prevClose ?? old?.prevClose, ts: Date.now() });
  dirty = true;
  notify();
}

export function useLive(): LiveState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Returns assets with the latest live prices merged in. */
export function withLive(assets: Asset[], live: LiveState): Asset[] {
  if (!live.quotes.size) return assets;
  return assets.map((a) => {
    const q = live.quotes.get(a.ticker.toUpperCase());
    return q ? { ...a, currentPrice: q.price, prevClose: q.prevClose ?? a.prevClose } : a;
  });
}

// ---------------------------------------------------------------------------

const B3 = new Set(['ACAO', 'FII', 'ETF', 'BDR']);
const isUS = (a: Asset) => currencyOf(a) !== 'BRL' && a.cls !== 'CRIPTO';

let timers: number[] = [];
let sockets: WebSocket[] = [];
let dirty = false;
let key = '';

export function stopLive() {
  timers.forEach((t) => clearInterval(t));
  sockets.forEach((s) => {
    s.onclose = null;
    s.close();
  });
  timers = [];
  sockets = [];
  key = '';
  state.status = { us: 'off', b3: 'off', crypto: 'off', fx: 'off' };
  notify();
}

/** (Re)starts feeds for the given assets. Cheap to call repeatedly: only restarts when inputs change. */
export function startLive(assets: Asset[], s: Settings) {
  const us = uniq(assets.filter(isUS).map((a) => a.ticker));
  const b3 = uniq(assets.filter((a) => B3.has(a.cls) && currencyOf(a) === 'BRL').map((a) => a.ticker));
  const crypto = uniq(assets.filter((a) => a.cls === 'CRIPTO').map((a) => a.ticker));
  const next = JSON.stringify([us, b3, crypto, s.finnhubToken, s.brapiToken, s.livePrices]);
  if (next === key) return;
  stopLive();
  key = next;
  if (!s.livePrices) return;

  startFx();
  // Feeds only run when you hold something from that market; otherwise show "ready".
  if (us.length) startUS(us, s.finnhubToken);
  else setStatus('us', s.finnhubToken ? 'ready' : 'needs-key');
  if (b3.length) startB3(b3, s.brapiToken);
  else setStatus('b3', 'ready');
  if (crypto.length) startCrypto(crypto);
  else setStatus('crypto', 'ready');

  // Persist the latest prices so the app opens with them next time.
  timers.push(
    window.setInterval(() => {
      if (!dirty) return;
      dirty = false;
      actions.updatePrices(new Map([...state.quotes].map(([k, q]) => [k, { price: q.price, prevClose: q.prevClose }])));
    }, 30000),
  );
}

export function flushLive() {
  if (!dirty) return;
  dirty = false;
  actions.updatePrices(new Map([...state.quotes].map(([k, q]) => [k, { price: q.price, prevClose: q.prevClose }])));
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.toUpperCase()))].sort();

async function getJSON(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// --- Dollar / euro ---------------------------------------------------------
function startFx() {
  const run = async () => {
    try {
      const j = await getJSON('https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL');
      const usd = Number(j?.USDBRL?.bid);
      const eur = Number(j?.EURBRL?.bid);
      if (usd > 0 && eur > 0) {
        const usdPrev = usd - Number(j.USDBRL.varBid || 0);
        state.fx = { USD: usd, EUR: eur, USDprev: usdPrev };
        actions.updateSettings({ fx: { USD: usd, EUR: eur, updatedAt: new Date().toISOString() } });
        setStatus('fx', 'polling');
      }
    } catch {
      setStatus('fx', 'error');
    }
  };
  run();
  timers.push(window.setInterval(run, 60000));
}

/** Historical exchange rate (BRL per unit) for a trade date; falls back to null. */
export async function fxOnDate(cur: 'USD' | 'EUR', date: string): Promise<number | null> {
  const d = date.replace(/-/g, '');
  try {
    // Look back a few days to cover weekends and holidays.
    const start = new Date(date + 'T12:00:00');
    start.setDate(start.getDate() - 6);
    const s = start.toISOString().slice(0, 10).replace(/-/g, '');
    const j = await getJSON(`https://economia.awesomeapi.com.br/json/daily/${cur}-BRL/7?start_date=${s}&end_date=${d}`);
    const v = Number(j?.[0]?.bid);
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

// --- US / foreign: Finnhub -------------------------------------------------
function startUS(tickers: string[], token?: string) {
  if (!token) return setStatus('us', 'needs-key');
  setStatus('us', 'connecting');
  const snapshot = async () => {
    for (const t of tickers) {
      try {
        const j = await getJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${token}`);
        if (j?.c > 0) setQuote(t, { price: j.c, prevClose: j.pc || undefined, source: 'finnhub' });
      } catch (e) {
        if ((e as Error).message === '401') return setStatus('us', 'error');
      }
    }
  };
  snapshot();
  timers.push(window.setInterval(snapshot, 5 * 60000));

  let retry = 0;
  const connect = () => {
    const ws = new WebSocket(`wss://ws.finnhub.io?token=${token}`);
    sockets.push(ws);
    ws.onopen = () => {
      retry = 0;
      tickers.forEach((symbol) => ws.send(JSON.stringify({ type: 'subscribe', symbol })));
      setStatus('us', 'live');
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type !== 'trade' || !Array.isArray(m.data)) return;
      const last = new Map<string, number>();
      for (const d of m.data) last.set(d.s, d.p);
      last.forEach((p, s) => setQuote(s, { price: p, source: 'finnhub' }));
    };
    ws.onclose = () => {
      setStatus('us', 'polling');
      sockets = sockets.filter((x) => x !== ws);
      window.setTimeout(connect, Math.min(60000, 2000 * 2 ** retry++));
    };
  };
  connect();
}

// --- B3: brapi -------------------------------------------------------------
function startB3(tickers: string[], token?: string) {
  setStatus('b3', 'connecting');
  const auth = token ? `token=${encodeURIComponent(token)}` : '';
  const run = async () => {
    let ok = 0;
    let unauthorized = false;
    // Free plan: one ticker per request.
    const queue = [...tickers];
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          const j = await getJSON(`https://brapi.dev/api/quote/${encodeURIComponent(t)}?${auth}`);
          const r = j?.results?.[0];
          if (r?.regularMarketPrice > 0) {
            setQuote(t, { price: r.regularMarketPrice, prevClose: r.regularMarketPreviousClose || undefined, source: 'brapi' });
            ok++;
          }
        } catch (e) {
          if ((e as Error).message === '401') unauthorized = true;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setStatus('b3', ok ? 'polling' : unauthorized && !token ? 'needs-key' : 'error');
  };
  run();
  timers.push(window.setInterval(run, 60000));
}

// --- Crypto: Binance -------------------------------------------------------
function startCrypto(coins: string[]) {
  setStatus('crypto', 'connecting');
  // Stablecoins track the dollar.
  const pairs = coins
    .filter((c) => !['USDT', 'USDC', 'DAI'].includes(c))
    .map((c) => ({ coin: c, pair: `${c}BRL` }));
  const stable = coins.filter((c) => ['USDT', 'USDC', 'DAI'].includes(c));
  const snapshot = async () => {
    for (const { coin, pair } of pairs) {
      try {
        const j = await getJSON(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
        const p = Number(j.lastPrice);
        if (p > 0) setQuote(coin, { price: p, prevClose: Number(j.openPrice) || undefined, source: 'binance' });
      } catch {
        /* pair may not exist in BRL */
      }
    }
    for (const c of stable) if (state.fx) setQuote(c, { price: state.fx.USD, prevClose: state.fx.USDprev, source: 'binance' });
  };
  snapshot();
  if (!pairs.length) return setStatus('crypto', 'polling');

  let retry = 0;
  const connect = () => {
    const streams = pairs.map((p) => `${p.pair.toLowerCase()}@miniTicker`).join('/');
    const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    sockets.push(ws);
    ws.onopen = () => {
      retry = 0;
      setStatus('crypto', 'live');
    };
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data)?.data;
      const hit = pairs.find((p) => p.pair === d?.s);
      if (hit) setQuote(hit.coin, { price: Number(d.c), prevClose: Number(d.o) || undefined, source: 'binance' });
    };
    ws.onclose = () => {
      setStatus('crypto', 'polling');
      sockets = sockets.filter((x) => x !== ws);
      window.setTimeout(connect, Math.min(60000, 2000 * 2 ** retry++));
    };
  };
  connect();
}

// --- Symbol search ---------------------------------------------------------
export interface SymbolHit {
  symbol: string;
  description: string;
  market: 'US' | 'B3';
}

/** Searches US symbols (Finnhub) and B3 tickers (brapi) by name or ticker. */
export async function searchSymbols(q: string, s: Settings): Promise<SymbolHit[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const out: SymbolHit[] = [];
  const tasks: Promise<void>[] = [];
  if (s.finnhubToken) {
    tasks.push(
      getJSON(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&exchange=US&token=${s.finnhubToken}`)
        .then((j) => {
          for (const r of (j?.result ?? []).slice(0, 8)) {
            if (!r.symbol || r.symbol.includes('.')) continue;
            out.push({ symbol: r.symbol, description: r.description, market: 'US' });
          }
        })
        .catch(() => {}),
    );
  }
  tasks.push(
    getJSON(`https://brapi.dev/api/available?search=${encodeURIComponent(query)}${s.brapiToken ? `&token=${s.brapiToken}` : ''}`)
      .then((j) => {
        for (const t of (j?.stocks ?? []).slice(0, 6)) out.push({ symbol: t, description: 'B3', market: 'B3' });
      })
      .catch(() => {}),
  );
  await Promise.all(tasks);
  return out;
}
