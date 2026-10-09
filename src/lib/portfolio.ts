import type { Asset, AssetClass, Currency, Settings, Transaction } from './types';
import { INCOME_TYPES, isMarketClass } from './types';

export interface Sale {
  txId: string;
  assetId: string;
  cls: AssetClass;
  date: string;
  quantity: number;
  /** Net proceeds (qty × price − fees). */
  proceeds: number;
  /** Gross sale value (qty × price), used for the R$20k / R$35k exemption limits. */
  grossValue: number;
  cost: number;
  gain: number;
  avgPrice: number;
  dayTrade: boolean;
  /** Sold more than held at the time. */
  oversold: boolean;
}

export interface Position {
  asset: Asset;
  currency: Currency;
  /** Average price in the asset's own currency. */
  avgPriceNative: number;
  /** Current value in the asset's own currency. */
  valueNative: number;
  /** Change since previous close, in BRL (0 when unknown). */
  dayChange: number;
  quantity: number;
  avgPrice: number;
  /** Cost basis of what is still held. */
  cost: number;
  /** Current value (market price or fixed-income estimate). */
  value: number;
  /** True when value comes from an estimate or falls back to cost. */
  valueIsEstimate: boolean;
  realized: number;
  income: number;
  firstDate?: string;
  closed: boolean;
}

const EPS = 1e-9;

export function sortTx(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    // Same day: corporate events first, then buys, then sells.
    const rank = (t: Transaction) => (t.type === 'SPLIT' ? 0 : t.type === 'BONUS' ? 1 : t.type === 'BUY' ? 2 : 3);
    const r = rank(a) - rank(b);
    if (r) return r;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

interface MarketState {
  quantity: number;
  cost: number;
  /** Cost in the asset's own currency. */
  costNative: number;
  realized: number;
  income: number;
  sales: Sale[];
  firstDate?: string;
}

/**
 * Brazilian average-price (preço médio) method:
 * buys add qty×price + fees to cost; sells remove avg×qty from cost and don't change the average;
 * splits change quantity only; bonus shares add qty at the cost attributed by the company.
 */
// Crypto is always priced in reais (Binance BRL pairs), whatever was stored.
export const currencyOf = (a: Asset): Currency => (a.cls === 'CRIPTO' ? 'BRL' : a.currency ?? (a.cls === 'EXTERIOR' ? 'USD' : 'BRL'));

/** BRL per unit of currency: the rate stored on the trade, else the current rate. */
export const fxFor = (t: Transaction, cur: Currency, s?: Pick<Settings, 'fx'>) =>
  cur === 'BRL' ? 1 : t.fxRate ?? s?.fx?.[cur] ?? 1;

export function runMarket(asset: Asset, txs: Transaction[], until?: string, settings?: Pick<Settings, 'fx'>): MarketState {
  const st: MarketState = { quantity: 0, cost: 0, costNative: 0, realized: 0, income: 0, sales: [] };
  const cur = currencyOf(asset);
  const sorted = sortTx(txs);
  const buyDays = new Set(sorted.filter((t) => t.type === 'BUY').map((t) => t.date));
  for (const t of sorted) {
    if (until && t.date > until) break;
    const fx = fxFor(t, cur, settings);
    switch (t.type) {
      case 'BUY':
        st.quantity += t.quantity;
        st.costNative += t.quantity * t.price + (t.fees || 0);
        st.cost += (t.quantity * t.price + (t.fees || 0)) * fx;
        st.firstDate ??= t.date;
        break;
      case 'BONUS':
        st.quantity += t.quantity;
        st.costNative += t.quantity * t.price;
        st.cost += t.quantity * t.price * fx;
        break;
      case 'SPLIT':
        // factor 0: position adjusted to zero (e.g. not in the B3 position anymore).
        if (t.factor !== undefined && t.factor >= 0) st.quantity *= t.factor;
        if (st.quantity <= EPS) {
          st.quantity = 0;
          st.cost = 0;
          st.costNative = 0;
        }
        break;
      case 'SELL': {
        const avg = st.quantity > EPS ? st.cost / st.quantity : 0;
        const avgNative = st.quantity > EPS ? st.costNative / st.quantity : 0;
        const held = Math.max(st.quantity, 0);
        const oversold = t.quantity > held + EPS;
        const q = Math.min(t.quantity, held);
        // All tax figures in BRL, converted at the trade date's rate.
        const grossValue = t.quantity * t.price * fx;
        const proceeds = grossValue - (t.fees || 0) * fx;
        // If oversold, only the held part has a known cost.
        const cost = avg * q;
        const gain = proceeds - cost;
        st.quantity -= q;
        st.cost -= cost;
        st.costNative -= avgNative * q;
        if (st.quantity <= EPS) {
          st.quantity = 0;
          st.cost = 0;
          st.costNative = 0;
        }
        st.realized += gain;
        st.sales.push({
          txId: t.id, assetId: asset.id, cls: asset.cls, date: t.date, quantity: t.quantity,
          proceeds, grossValue, cost, gain, avgPrice: avg, dayTrade: buyDays.has(t.date), oversold,
        });
        break;
      }
      default:
        if (INCOME_TYPES.includes(t.type)) st.income += t.quantity * t.price * fx;
    }
  }
  return st;
}

/** Yearly rate (% a.a.) the asset earns under the settings' assumptions. */
export function fixedAnnualRate(asset: Asset, s: Settings): number {
  const f = asset.fixed;
  if (!f) return 0;
  // Poupança: 0,5% a.m. + TR while Selic > 8,5%; otherwise 70% of Selic (TR ignored).
  if (f.kind === 'POUPANCA') return s.selicRate > 8.5 ? 6.17 : s.selicRate * 0.7;
  switch (f.indexer) {
    case 'CDI':
      return (s.cdiRate * f.rate) / 100;
    case 'SELIC':
      return (1 + s.selicRate / 100) * (1 + f.rate / 100) * 100 - 100;
    case 'IPCA':
      return (1 + s.ipcaRate / 100) * (1 + f.rate / 100) * 100 - 100;
    case 'PRE':
      return f.rate;
  }
}

const DAY = 86400000;
const days = (from: string, to: string) =>
  Math.max(0, (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);
/** Growth factor between two dates (calendar-day approximation of the 252-business-day convention). */
export const growth = (annualPct: number, from: string, to: string) =>
  Math.pow(1 + annualPct / 100, days(from, to) / 365);

interface ValueState {
  cost: number;
  value: number;
  realized: number;
  income: number;
  firstDate?: string;
  closed: boolean;
  estimate: boolean;
}

/**
 * Value-based assets (renda fixa, fundos, outros): each BUY is an application of R$ `price`,
 * each SELL a redemption of R$ `price`. Value is estimated by compounding the configured rate
 * unless a manual balance was informed.
 */
export function runValue(asset: Asset, txs: Transaction[], s: Settings, asOf: string): ValueState {
  const rate = fixedAnnualRate(asset, s);
  let cost = 0;
  let value = 0;
  let realized = 0;
  let income = 0;
  let last = '';
  let firstDate: string | undefined;
  let closed = false;
  for (const t of sortTx(txs)) {
    if (t.date > asOf) break;
    if (last) value *= growth(rate, last, t.date);
    last = t.date;
    const amount = t.quantity * t.price;
    if (t.type === 'BUY') {
      cost += amount + (t.fees || 0);
      value += amount;
      firstDate ??= t.date;
      closed = false;
    } else if (t.type === 'SELL') {
      const frac = t.closes || value <= EPS ? 1 : Math.min(1, amount / value);
      const costOut = cost * frac;
      realized += amount - (t.fees || 0) - costOut;
      cost -= costOut;
      value = t.closes ? 0 : Math.max(0, value - amount);
      if (t.closes || cost <= 0.005) {
        cost = 0;
        value = 0;
        closed = true;
      }
    } else if (INCOME_TYPES.includes(t.type)) {
      income += amount;
    }
  }
  if (last && !closed) value *= growth(rate, last, asOf);

  let estimate = rate > 0;
  if (!closed && asset.manualValue !== undefined && asset.manualValueDate && asOf >= asset.manualValueDate) {
    // Start from the informed balance and apply only flows after it.
    let v = asset.manualValue;
    let from = asset.manualValueDate;
    for (const t of sortTx(txs)) {
      if (t.date <= asset.manualValueDate || t.date > asOf) continue;
      v *= growth(rate, from, t.date);
      from = t.date;
      const amount = t.quantity * t.price;
      if (t.type === 'BUY') v += amount;
      else if (t.type === 'SELL') v = t.closes ? 0 : Math.max(0, v - amount);
    }
    value = v * growth(rate, from, asOf);
    estimate = from !== asOf && rate > 0;
  } else if (rate === 0 && !closed) {
    value = cost;
    estimate = true;
  }
  return { cost, value, realized, income, firstDate, closed, estimate };
}

export function computePositions(
  assets: Asset[],
  txs: Transaction[],
  settings: Settings,
  asOf: string,
): Position[] {
  const byAsset = groupTx(txs);
  return assets.map((asset) => {
    const list = byAsset.get(asset.id) ?? [];
    if (isMarketClass(asset.cls)) {
      const cur = currencyOf(asset);
      const fxNow = cur === 'BRL' ? 1 : settings.fx?.[cur] ?? 1;
      const st = runMarket(asset, list, asOf, settings);
      const avg = st.quantity > EPS ? st.cost / st.quantity : 0;
      const avgNative = st.quantity > EPS ? st.costNative / st.quantity : 0;
      const hasPrice = asset.currentPrice !== undefined && asset.currentPrice > 0;
      const valueNative = hasPrice ? st.quantity * asset.currentPrice! : st.costNative;
      return {
        asset,
        currency: cur,
        avgPriceNative: avgNative,
        valueNative,
        // Ignore implausible previous closes (e.g. stale data after a split).
        dayChange:
          hasPrice && asset.prevClose && asset.currentPrice! / asset.prevClose < 1.5 && asset.currentPrice! / asset.prevClose > 0.67
            ? st.quantity * (asset.currentPrice! - asset.prevClose) * fxNow
            : 0,
        quantity: st.quantity,
        avgPrice: avg,
        cost: st.cost,
        value: hasPrice ? valueNative * fxNow : st.cost,
        valueIsEstimate: !hasPrice,
        realized: st.realized,
        income: st.income,
        firstDate: st.firstDate,
        closed: st.quantity <= EPS && list.length > 0,
      };
    }
    const st = runValue(asset, list, settings, asOf);
    return {
      asset,
      currency: 'BRL' as Currency,
      avgPriceNative: st.cost,
      valueNative: st.value,
      dayChange: 0,
      quantity: st.closed ? 0 : 1,
      avgPrice: st.cost,
      cost: st.cost,
      value: st.value,
      valueIsEstimate: st.estimate,
      realized: st.realized,
      income: st.income,
      firstDate: st.firstDate,
      closed: st.closed,
    };
  });
}

export function groupTx(txs: Transaction[]): Map<string, Transaction[]> {
  const m = new Map<string, Transaction[]>();
  for (const t of txs) {
    const arr = m.get(t.assetId);
    if (arr) arr.push(t);
    else m.set(t.assetId, [t]);
  }
  return m;
}

export function allSales(assets: Asset[], txs: Transaction[], settings?: Pick<Settings, 'fx'>): Sale[] {
  const byAsset = groupTx(txs);
  const out: Sale[] = [];
  for (const a of assets) {
    if (!isMarketClass(a.cls)) continue;
    out.push(...runMarket(a, byAsset.get(a.id) ?? [], undefined, settings).sales);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Month-end cost basis series (net amount invested over time). */
export function investedSeries(assets: Asset[], txs: Transaction[], settings: Settings, end: string) {
  if (!txs.length) return [];
  const first = sortTx(txs)[0].date.slice(0, 7);
  const months: string[] = [];
  let [y, m] = first.split('-').map(Number);
  const endYm = end.slice(0, 7);
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    months.push(ym);
    if (ym >= endYm) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months.map((ym) => {
    const [yy, mm] = ym.split('-').map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    const asOf = ym === endYm ? end : `${ym}-${String(lastDay).padStart(2, '0')}`;
    const pos = computePositions(assets, txs, { ...settings }, asOf);
    return { month: ym, cost: pos.reduce((s, p) => s + p.cost, 0) };
  });
}
