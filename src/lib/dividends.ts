import { apiKey } from './cloud';
import { useSyncExternalStore } from 'react';
import type { Asset, Settings, Transaction, TxType } from './types';
import { INCOME_TYPES } from './types';
import { currencyOf, groupTx, runMarket, sortTx } from './portfolio';
import { actions, getData } from './store';
import { today } from './format';
import { t } from './i18n';
import { fxOnDate } from './live';

/**
 * Automatic dividends ("proventos"): for each stock/FII you hold, fetch the company's payments
 * and work out how much you received from how many shares you had on the record date (data com).
 * - B3: brapi (cash dividends, JCP, FII income).
 * - US: Twelve Data (ex-date and amount per share; 30% US withholding applied).
 */

export interface FoundIncome {
  key: string;
  assetId: string;
  ticker: string;
  type: TxType;
  /** Payment date (or ex-date for US, which doesn't publish it on the free plan). */
  date: string;
  recordDate: string;
  perShare: number;
  shares: number;
  /** Amount you receive, after tax withheld at source (JCP 15%, US 30%). */
  net: number;
  currency: 'BRL' | 'USD';
  paid: boolean;
}

interface State {
  status: 'idle' | 'loading' | 'done';
  upcoming: FoundIncome[];
  notes: string[];
  lastAdded: number;
}
let state: State = { status: 'idle', upcoming: [], notes: [], lastAdded: 0 };
const listeners = new Set<() => void>();
const set = (p: Partial<State>) => {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
};
export const useDividends = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );

async function getJSON(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status });
  return r.json();
}

const B3_CLASSES = new Set(['ACAO', 'FII', 'ETF', 'BDR']);
const iso = (s?: string | null) => (s ? String(s).slice(0, 10) : '');

/** Shares held at the end of `date`. */
function sharesOn(asset: Asset, list: Transaction[], date: string, s: Settings) {
  return runMarket(asset, list, date, s).quantity;
}

async function b3Payments(a: Asset, s: Settings) {
  const auth = apiKey(s, 'brapi') ? `&token=${encodeURIComponent(apiKey(s, 'brapi') ?? '')}` : '';
  const j = await getJSON(`https://brapi.dev/api/quote/${encodeURIComponent(a.ticker.toUpperCase())}?dividends=true${auth}`);
  const list: { paymentDate?: string; lastDatePrior?: string; rate?: number; label?: string }[] = j?.results?.[0]?.dividendsData?.cashDividends;
  if (!Array.isArray(list)) return null;
  return list
    .filter((d) => Number(d.rate) > 0 && d.lastDatePrior)
    .map((d) => {
      const label = String(d.label ?? '').toUpperCase();
      const type: TxType = label.includes('JCP') || label.includes('JUROS') ? 'JCP' : a.cls === 'FII' || label.includes('RENDIMENTO') ? 'INCOME' : 'DIVIDEND';
      return { type, recordDate: iso(d.lastDatePrior), date: iso(d.paymentDate) || iso(d.lastDatePrior), perShare: Number(d.rate), withheld: type === 'JCP' ? 0.15 : 0 };
    });
}

async function usPayments(a: Asset, s: Settings, from: string) {
  if (!apiKey(s, 'twelve')) return null;
  const j = await getJSON(`https://api.twelvedata.com/dividends?symbol=${encodeURIComponent(a.ticker.toUpperCase())}&start_date=${from}&apikey=${encodeURIComponent(apiKey(s, 'twelve') ?? '')}`);
  const list: { ex_date?: string; amount?: number | string }[] = j?.dividends;
  if (!Array.isArray(list)) return null;
  return list
    .filter((d) => Number(d.amount) > 0 && d.ex_date)
    .map((d) => {
      // You must hold the shares at the close of the day before the ex-date.
      const ex = new Date(iso(d.ex_date) + 'T12:00:00');
      ex.setDate(ex.getDate() - 1);
      return { type: 'DIVIDEND' as TxType, recordDate: ex.toISOString().slice(0, 10), date: iso(d.ex_date), perShare: Number(d.amount), withheld: 0.3 };
    });
}

/** Already in the portfolio? (auto key, or any income for the same asset within a few days). */
function alreadyHave(txs: Transaction[], f: FoundIncome) {
  const t0 = Date.parse(f.date);
  return txs.some(
    (x) =>
      x.importKey === f.key ||
      (x.assetId === f.assetId && INCOME_TYPES.includes(x.type) && (x.type === f.type || f.type !== 'JCP') && Math.abs(Date.parse(x.date) - t0) <= 6 * 86400000),
  );
}

export async function findDividends(): Promise<{ found: FoundIncome[]; notes: string[] }> {
  const { assets, transactions, settings } = getData();
  const byAsset = groupTx(transactions);
  const found: FoundIncome[] = [];
  const notes = new Set<string>();
  const tdy = today();
  for (const a of assets) {
    const list = byAsset.get(a.id) ?? [];
    const first = sortTx(list).find((x) => x.type === 'BUY')?.date;
    if (!first) continue;
    const cur = currencyOf(a);
    const isB3 = B3_CLASSES.has(a.cls) && cur === 'BRL';
    const isUS = a.cls === 'EXTERIOR' && cur === 'USD';
    if (!isB3 && !isUS) continue;
    let pays: { type: TxType; recordDate: string; date: string; perShare: number; withheld: number }[] | null = null;
    try {
      pays = isB3 ? await b3Payments(a, settings) : await usPayments(a, settings, first);
    } catch (e) {
      const st = (e as { status?: number }).status;
      if (isB3 && (st === 401 || st === 403 || st === 402))
        notes.add(t('Proventos de ações BR: adicione o token da brapi em Ajustes (o plano grátis pode não incluir dividendos).', 'BR dividends: add your brapi token in Settings (the free plan may not include dividends).'));
      continue;
    }
    if (!pays) {
      if (isUS && !apiKey(settings, 'twelve')) notes.add(t('Proventos dos EUA: adicione a chave da Twelve Data em Ajustes.', 'US dividends: add your Twelve Data key in Settings.'));
      if (isB3) notes.add(t('A brapi não enviou proventos — o plano grátis pode não incluir esse dado. A Movimentação da B3 (Importar) traz todos.', "brapi didn't return dividends — the free plan may not include them. The B3 Movimentação statement (Import) has them all."));
      continue;
    }
    for (const p of pays) {
      if (p.recordDate < first) continue;
      const shares = sharesOn(a, list, p.recordDate, settings);
      if (shares <= 1e-9) continue;
      const net = Math.round(shares * p.perShare * (1 - p.withheld) * 100) / 100;
      if (net < 0.01) continue;
      const key = `auto:${a.ticker.toUpperCase()}:${p.recordDate}:${p.type}:${p.perShare}`;
      found.push({ key, assetId: a.id, ticker: a.ticker, type: p.type, date: p.date, recordDate: p.recordDate, perShare: p.perShare, shares, net, currency: isUS ? 'USD' : 'BRL', paid: p.date <= tdy });
    }
  }
  return { found: found.filter((f) => !alreadyHave(transactions, f)), notes: [...notes] };
}

/** Checks for new payments and adds the ones already paid. Runs at most once a day unless forced. */
export async function syncDividends(force = false) {
  const { settings } = getData();
  if (settings.autoDividends === false && !force) return;
  if (!force && settings.dividendsCheckedAt === today() && state.status === 'done') return;
  if (state.status === 'loading') return;
  set({ status: 'loading' });
  try {
    const { found, notes } = await findDividends();
    const paid = found.filter((f) => f.paid);
    if (paid.length) {
      const fx = getData().settings.fx.USD;
      const rates = new Map<string, number>();
      for (const d of new Set(paid.filter((f) => f.currency === 'USD').map((f) => f.date))) rates.set(d, (await fxOnDate('USD', d)) ?? fx);
      actions.addTransactions(
        paid.map((f) => ({
          assetId: f.assetId,
          type: f.type,
          date: f.date,
          quantity: 1,
          price: f.net,
          fees: 0,
          fxRate: f.currency === 'USD' ? rates.get(f.date) ?? fx : undefined,
          source: 'auto' as const,
          importKey: f.key,
          notes: t(`Automático: ${f.shares} × ${f.perShare} por cota/ação (data com ${f.recordDate.split('-').reverse().join('/')})`, `Automatic: ${f.shares} × ${f.perShare} per share (record date ${f.recordDate})`),
        })),
      );
    }
    actions.updateSettings({ dividendsCheckedAt: today() });
    set({ status: 'done', upcoming: found.filter((f) => !f.paid).sort((a, b) => a.date.localeCompare(b.date)), notes, lastAdded: paid.length });
    return paid.length;
  } catch {
    set({ status: 'done' });
    return 0;
  }
}
