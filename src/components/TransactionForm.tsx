import { apiKey } from '../lib/cloud';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, toast } from './ui';
import { Icon } from './Icon';
import { Logo, marketOf } from './Logo';
import { actions, getData, newAsset, useData } from '../lib/store';
import type { Asset, AssetClass, Currency, FixedKind, Indexer, Transaction, TxType } from '../lib/types';
import { CLASS_LABEL, CLASS_ORDER, CURRENCY_LABEL, CURRENCY_SYMBOL, INDEXER_LABEL, isMarketClass } from '../lib/types';
import { fxOnDate, searchSymbols, useLive } from '../lib/live';
import { priceOn, twelveSearch, type Market, type PriceResult } from '../lib/prices';
import { lookupTicker, searchDirectory, type TickerInfo } from '../lib/tickers';
import { guessClass, normalizeTicker } from '../lib/classify';
import { fmtCurrency, fmtDate, money, numStr, parseNumber, qty, today, toISODate } from '../lib/format';
import { t } from '../lib/i18n';
import { runMarket, groupTx, currencyOf, computePositions } from '../lib/portfolio';
import { estimateSaleTax, type SaleTaxEstimate } from '../lib/tax';
import { FUND_CLASS, prettyFund, searchFunds, type Fund } from '../lib/funds';
import { getLang } from '../lib/i18n';

type Mode = 'market' | 'fixed' | 'income' | 'event' | 'cash';

const INSTITUTIONS = [
  'Ágora', 'Avenue', 'Banco do Brasil', 'Banco Pan', 'Binance', 'Bradesco', 'BTG Pactual', 'C6 Bank', 'Caixa', 'Charles Schwab',
  'Clear', 'Genial', 'Inter', 'Interactive Brokers', 'Itaú', 'Íon (Itaú)', 'Mercado Bitcoin', 'Mercado Pago', 'Modal', 'Neon',
  'Nomad', 'Nubank', 'NuInvest', 'Órama', 'PagBank', 'PicPay', 'Rico', 'Safra', 'Santander', 'Sicoob', 'Sicredi', 'Sofisa',
  'Toro', 'Warren', 'XP',
];

// ---------------------------------------------------------------------------
// Renda fixa types: each one knows its yield options, defaults and whether it matures.

type FType = 'CDB' | 'LCI' | 'LCA' | 'TESOURO_SELIC' | 'TESOURO_IPCA' | 'TESOURO_PRE' | 'CONTA' | 'POUPANCA' | 'FUNDO' | 'OUTRO';
const FTYPES: FType[] = ['CDB', 'LCI', 'LCA', 'TESOURO_SELIC', 'TESOURO_IPCA', 'TESOURO_PRE', 'FUNDO', 'OUTRO'];
const FTYPE: Record<FType, { kind: FixedKind; indexers: Indexer[]; rate: number; label: () => string; hint: () => string }> = {
  CDB: { kind: 'CDB', indexers: ['CDI', 'IPCA', 'PRE'], rate: 100, label: () => 'CDB', hint: () => t('Emitido por banco', 'Issued by a bank') },
  LCI: { kind: 'LCI', indexers: ['CDI', 'IPCA', 'PRE'], rate: 92, label: () => 'LCI', hint: () => t('Isenta de IR', 'Tax-free') },
  LCA: { kind: 'LCA', indexers: ['CDI', 'IPCA', 'PRE'], rate: 92, label: () => 'LCA', hint: () => t('Isenta de IR', 'Tax-free') },
  CONTA: { kind: 'CONTA', indexers: ['CDI'], rate: 100, label: () => t('Caixinha', 'Cash account'), hint: () => t('Rende todo dia', 'Daily yield') },
  TESOURO_SELIC: { kind: 'TESOURO', indexers: ['SELIC'], rate: 0.05, label: () => 'Tesouro Selic', hint: () => t('Reserva', 'Reserve') },
  TESOURO_IPCA: { kind: 'TESOURO', indexers: ['IPCA'], rate: 6.5, label: () => 'Tesouro IPCA+', hint: () => t('Inflação + taxa', 'Inflation + rate') },
  TESOURO_PRE: { kind: 'TESOURO', indexers: ['PRE'], rate: 13, label: () => t('Tesouro Pré', 'Tesouro Fixed'), hint: () => t('Taxa fixa', 'Fixed rate') },
  POUPANCA: { kind: 'POUPANCA', indexers: ['SELIC'], rate: 0, label: () => t('Poupança', 'Savings'), hint: () => t('Sem IR', 'Tax-free') },
  FUNDO: { kind: 'OUTRO', indexers: ['CDI'], rate: 100, label: () => t('Fundo', 'Fund'), hint: () => t('Busque pelo nome', 'Search by name') },
  OUTRO: { kind: 'OUTRO', indexers: ['CDI', 'IPCA', 'PRE'], rate: 100, label: () => t('Outro', 'Other'), hint: () => t('CRI, CRA, debênture', 'CRI, CRA, debenture') },
};
const DEFAULT_RATE: Record<Indexer, number> = { CDI: 100, IPCA: 6.5, PRE: 13, SELIC: 0.05 };
const hasMaturity = (k: FType) => k !== 'CONTA' && k !== 'POUPANCA' && k !== 'FUNDO';

function ftypeOf(a?: Asset): FType {
  if (!a || isMarketClass(a.cls)) return 'CDB';
  if (a.cls === 'FUNDO') return 'FUNDO';
  const f = a.fixed;
  if (!f) return 'OUTRO';
  if (f.kind === 'TESOURO') return f.indexer === 'SELIC' ? 'TESOURO_SELIC' : f.indexer === 'IPCA' ? 'TESOURO_IPCA' : 'TESOURO_PRE';
  if (f.kind === 'CDB' || f.kind === 'LCI' || f.kind === 'LCA' || f.kind === 'CONTA' || f.kind === 'POUPANCA') return f.kind;
  return 'OUTRO';
}

/** "CDB Nubank 110% CDI 2027", "Tesouro IPCA+ 2035", "Caixinha Nubank"… */
function buildFixedName(o: { fType: FType; bank: string; indexer: Indexer; rate: number; maturity: string; daily: boolean }) {
  const yr = o.maturity ? o.maturity.slice(0, 4) : '';
  const r = Number.isFinite(o.rate) ? numStr(o.rate) || '0' : '';
  const rateStr = o.indexer === 'CDI' ? `${r}% CDI` : o.indexer === 'IPCA' ? `IPCA+${r}%` : o.indexer === 'SELIC' ? `Selic+${r}%` : `${r}% ${t('a.a.', 'p.a.')}`;
  const bank = o.bank.trim();
  switch (o.fType) {
    case 'TESOURO_SELIC': return `Tesouro Selic ${yr}`.trim();
    case 'TESOURO_IPCA': return `Tesouro IPCA+ ${yr}`.trim();
    case 'TESOURO_PRE': return `Tesouro Prefixado ${yr}`.trim();
    case 'POUPANCA': return `${t('Poupança', 'Savings')} ${bank}`.trim();
    case 'CONTA': return `${t('Caixinha', 'Cash')} ${bank} ${rateStr}`.trim();
    case 'FUNDO':
    case 'OUTRO': return '';
    default: return [FTYPE[o.fType].label(), bank, rateStr, yr || (o.daily ? t('liquidez diária', 'daily') : '')].filter(Boolean).join(' ');
  }
}

export interface FormInit {
  mode?: Mode;
  asset?: Asset;
  tx?: Transaction;
  side?: 'BUY' | 'SELL';
}

/** What the user picked in the search: enough to create the asset and fetch prices. */
interface Pick {
  /** Typed by hand (not in any list): class/currency are editable. */
  custom?: boolean;
  symbol: string;
  name?: string;
  cls: AssetClass;
  currency: Currency;
  market: Market;
}

function modeOf(tx: Transaction, asset?: Asset): Mode {
  if (tx.type === 'DIVIDEND' || tx.type === 'JCP' || tx.type === 'INCOME') return 'income';
  if (tx.type === 'SPLIT' || tx.type === 'BONUS') return 'event';
  if (asset?.cls === 'CAIXA') return 'cash';
  return asset && !isMarketClass(asset.cls) ? 'fixed' : 'market';
}

const str = numStr;
const priceMarket = (cls: AssetClass, cur: Currency): Market => (cls === 'CRIPTO' ? 'CRYPTO' : cur !== 'BRL' ? 'US' : 'B3');

function pickFromInfo(t: TickerInfo): Pick {
  if (t.kind === 'U') return { symbol: t.symbol, name: t.name, cls: 'EXTERIOR', currency: 'USD', market: 'US' };
  if (t.kind === 'C') return { symbol: t.symbol, name: t.name, cls: 'CRIPTO', currency: 'BRL', market: 'CRYPTO' };
  const cls: AssetClass = t.kind === 'F' ? 'FII' : t.kind === 'E' ? 'ETF' : /3[1-5]$/.test(t.symbol) ? 'BDR' : 'ACAO';
  return { symbol: t.symbol, name: t.name, cls, currency: 'BRL', market: 'B3' };
}
function pickFromAsset(a: Asset): Pick {
  const cur = currencyOf(a);
  return { symbol: a.ticker, name: a.name, cls: a.cls, currency: cur, market: priceMarket(a.cls, cur) };
}

/** Most recent institution used overall (or for one asset). */
function lastInstitution(txs: Transaction[], assetId?: string) {
  let best: Transaction | undefined;
  for (const t of txs) {
    if (!t.institution || (assetId && t.assetId !== assetId)) continue;
    if (!best || t.createdAt > best.createdAt) best = t;
  }
  return best?.institution ?? '';
}

export function TransactionForm({ init, onClose }: { init?: FormInit; onClose: () => void }) {
  const data = useData();
  const live = useLive();
  const editing = init?.tx;
  const initAsset = init?.asset ?? (editing ? data.assets.find((a) => a.id === editing.assetId) : undefined);
  const [mode, setMode] = useState<Mode>(init?.mode ?? (editing ? modeOf(editing, initAsset) : initAsset?.cls === 'CAIXA' ? 'cash' : initAsset && !isMarketClass(initAsset.cls) ? 'fixed' : 'market'));
  const [cashCur, setCashCur] = useState<Currency>(initAsset?.cls === 'CAIXA' ? currencyOf(initAsset) : 'BRL');
  const [cashOp, setCashOp] = useState<'balance' | 'in' | 'out'>(editing ? (editing.type === 'SELL' ? 'out' : 'in') : 'balance');
  const [cashAmount, setCashAmount] = useState(editing && initAsset?.cls === 'CAIXA' ? str(editing.quantity) : '');

  // shared
  const [ticker, setTicker] = useState(initAsset?.ticker ?? '');
  const [pick, setPick] = useState<Pick | null>(initAsset && isMarketClass(initAsset.cls) ? pickFromAsset(initAsset) : null);
  const [date, setDate] = useState(editing?.date ?? today());
  const [institution, setInstitution] = useState(
    editing?.institution ?? (initAsset ? lastInstitution(data.transactions, initAsset.id) || initAsset.institution || '' : lastInstitution(data.transactions)),
  );
  const [notes, setNotes] = useState(editing?.notes ?? '');
  // market
  const [side, setSide] = useState<'BUY' | 'SELL'>(init?.side ?? (editing?.type === 'SELL' ? 'SELL' : 'BUY'));
  const [quantity, setQuantity] = useState(editing && modeOf(editing, initAsset) !== 'fixed' ? str(editing.quantity) : '');
  const [price, setPrice] = useState(editing ? str(editing.price) : '');
  const [fees, setFees] = useState(editing ? str(editing.fees) : '');
  const [totalStr, setTotalStr] = useState('');
  const [lastEdit, setLastEdit] = useState<'qty' | 'total'>('qty');
  const priceManual = useRef(!!editing);
  const [priceInfo, setPriceInfo] = useState<{ state: 'idle' | 'loading' | 'done'; result?: PriceResult }>({ state: 'idle' });
  // fixed
  const [amount, setAmount] = useState(editing ? str(editing.quantity * editing.price) : '');
  const [closes, setCloses] = useState(!!editing?.closes);
  const [indexer, setIndexer] = useState<Indexer>(initAsset?.fixed?.indexer ?? 'CDI');
  const [rate, setRate] = useState(str(initAsset?.fixed?.rate) || (initAsset ? '' : '100'));
  const [maturity, setMaturity] = useState(initAsset?.fixed?.maturity ?? '');
  const [issuer, setIssuer] = useState(initAsset?.fixed?.issuer ?? '');
  const [fType, setFType] = useState<FType>(() => ftypeOf(initAsset));
  const [daily, setDaily] = useState(initAsset?.fixed?.daily ?? false);
  const [customName, setCustomName] = useState('');
  const [fundPick, setFundPick] = useState<Fund | null>(null);
  const [showIssuer, setShowIssuer] = useState(!!initAsset?.fixed?.issuer);
  // income / event
  const [incomeType, setIncomeType] = useState<TxType>(editing && ['DIVIDEND', 'JCP', 'INCOME'].includes(editing.type) ? editing.type : 'DIVIDEND');
  const [eventType, setEventType] = useState<'SPLIT' | 'GROUP' | 'BONUS'>(
    editing?.type === 'BONUS' ? 'BONUS' : editing?.factor && editing.factor < 1 ? 'GROUP' : 'SPLIT',
  );
  const [ratioFrom, setRatioFrom] = useState(editing?.factor && editing.factor < 1 ? String(Math.round(1 / editing.factor)) : '1');
  const [ratioTo, setRatioTo] = useState(editing?.factor && editing.factor >= 1 ? String(editing.factor) : '1');
  // currency
  const [fxRate, setFxRate] = useState(editing?.fxRate ? str(editing.fxRate) : '');
  const fxTouched = useRef(!!editing?.fxRate);
  const [error, setError] = useState('');
  const [refetch, setRefetch] = useState(0);

  // In "Bolsa" the asset is whatever was picked in the search; elsewhere, the typed holding.
  const resolved: Pick | null = mode === 'market' ? pick : null;
  const existing = useMemo(() => {
    const t = (mode === 'market' ? pick?.symbol ?? '' : ticker).trim().toUpperCase();
    if (!t) return undefined;
    return data.assets.find((a) => a.ticker.toUpperCase() === t || a.ticker.toUpperCase() === normalizeTicker(t));
  }, [mode, pick, ticker, data.assets]);
  const incomeAsset = mode !== 'market' ? existing : undefined;

  const currency: Currency =
    mode === 'cash' ? cashCur : mode === 'fixed' ? 'BRL' : mode === 'market' ? resolved?.currency ?? 'BRL' : incomeAsset ? currencyOf(incomeAsset) : 'BRL';
  const foreign = currency !== 'BRL';
  const sym = CURRENCY_SYMBOL[currency];
  const wholeShares = resolved?.market === 'B3';

  // Exchange rate for the trade date.
  useEffect(() => {
    if (!foreign || fxTouched.current || !date) return;
    let alive = true;
    setFxRate(str(Math.round(data.settings.fx[currency as 'USD' | 'EUR'] * 10000) / 10000));
    fxOnDate(currency as 'USD' | 'EUR', date).then((v) => {
      if (alive && v && !fxTouched.current) setFxRate(str(Math.round(v * 10000) / 10000));
    });
    return () => {
      alive = false;
    };
  }, [foreign, currency, date, data.settings.fx]);

  // Automatic price: today's quote or the close on the chosen date.
  const symbolForPrice = mode === 'market' && resolved ? resolved.symbol : '';
  const marketForPrice = resolved?.market;
  useEffect(() => {
    if (!symbolForPrice || !marketForPrice || !date) return setPriceInfo({ state: 'idle' });
    if (priceManual.current) return;
    let alive = true;
    // Instant: use the live quote for today when we already have it.
    const liveQ = live.quotes.get(symbolForPrice.toUpperCase());
    if (date >= today() && liveQ) {
      setPrice(str(liveQ.price));
      setPriceInfo({ state: 'done', result: { ok: true, price: liveQ.price, date, source: t('ao vivo', 'live'), exact: true } });
      return;
    }
    setPriceInfo({ state: 'loading' });
    setPrice('');
    const id = setTimeout(() => {
      priceOn(symbolForPrice, marketForPrice, date, data.settings).then((r) => {
        if (!alive || priceManual.current) return;
        // Fallback for today: the last price saved for this asset.
        const saved = data.assets.find((a) => a.ticker.toUpperCase() === symbolForPrice.toUpperCase());
        if (!r.ok && date >= today() && saved?.currentPrice) {
          r = { ok: true, price: saved.currentPrice, date: saved.priceUpdatedAt?.slice(0, 10) ?? date, source: 'saved', exact: false };
        }
        setPriceInfo({ state: 'done', result: r });
        if (r.ok) setPrice(str(r.price));
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
    // Live quotes are read once per lookup on purpose, not on every tick.
  }, [symbolForPrice, marketForPrice, date, refetch, apiKey(data.settings, 'finnhub'), apiKey(data.settings, 'brapi'), apiKey(data.settings, 'twelve')]);

  const held = useMemo(() => {
    if (!existing || !isMarketClass(existing.cls)) return null;
    const txs = (groupTx(data.transactions).get(existing.id) ?? []).filter((t) => t.id !== editing?.id);
    const st = runMarket(existing, txs, date, data.settings);
    return { quantity: st.quantity, avg: st.quantity ? st.costNative / st.quantity : 0 };
  }, [existing, data.transactions, date, editing?.id, data.settings]);
  const fx = foreign ? parseNumber(fxRate) : 1;

  // Quantity ⇄ total: whichever was typed last drives the other.
  const p = parseNumber(price);
  const f = parseNumber(fees) || 0;
  const typedTotal = parseNumber(totalStr);
  let q = parseNumber(quantity);
  if (lastEdit === 'total' && p > 0 && Number.isFinite(typedTotal)) {
    q = typedTotal / p;
    if (wholeShares) q = Math.floor(q + 1e-9);
  }
  const gross = Number.isFinite(q) && Number.isFinite(p) ? q * p : NaN;
  const total = Number.isFinite(gross) ? gross + (side === 'BUY' ? f : -f) : NaN;
  const leftover = lastEdit === 'total' && Number.isFinite(typedTotal) && Number.isFinite(gross) ? typedTotal - gross : 0;

  const institutions = useMemo(
    () => [...new Set([...getData().assets.map((a) => a.institution).filter(Boolean), ...INSTITUTIONS])] as string[],
    [],
  );

  function choose(pk: Pick) {
    setTicker(pk.symbol);
    setPick(pk);
    priceManual.current = false;
    fxTouched.current = false;
    const asset = data.assets.find((a) => a.ticker.toUpperCase() === pk.symbol.toUpperCase());
    if (asset) setInstitution(lastInstitution(data.transactions, asset.id) || asset.institution || institution);
    else {
      // New asset: use the broker you last used for the same market (B3, US, crypto).
      const sameMarket = new Set(
        data.assets.filter((a) => isMarketClass(a.cls) && priceMarket(a.cls, currencyOf(a)) === pk.market).map((a) => a.id),
      );
      const inst = lastInstitution(data.transactions.filter((t) => sameMarket.has(t.assetId)));
      if (inst) setInstitution(inst);
    }
  }

  function saveCash() {
    const v = parseNumber(cashAmount);
    if (!(v >= 0) || (cashOp !== 'balance' && !(v > 0))) return setError(t('Informe o valor.', 'Enter the amount.'));
    if (!cashAsset && !institution) return setError(t('Escolha o banco ou corretora.', 'Choose the bank or broker.'));
    if (foreign && !(fx > 0)) return setError(t('Informe a cotação da moeda no dia.', "Enter that day's exchange rate."));
    const diff = cashOp === 'balance' ? Math.round((v - cashHave) * 100) / 100 : cashOp === 'in' ? v : -v;
    if (Math.abs(diff) < 0.005) {
      toast(t('O saldo já está assim', 'The balance is already that'));
      return onClose();
    }
    const created = cashAsset ? undefined : newAsset({ ticker: cashTicker, cls: 'CAIXA', currency: cashCur, institution: institution || undefined, currentPrice: 1 });
    const asset = cashAsset ?? created!;
    const tx = {
      assetId: asset.id, type: (diff > 0 ? 'BUY' : 'SELL') as TxType, date, quantity: Math.abs(diff), price: 1, fees: 0,
      fxRate: foreign ? fx : undefined, institution: institution || asset.institution, notes: notes || (cashOp === 'balance' ? t(`Saldo informado: ${fmtCurrency(v, cashCur, { always: true })}`, `Balance entered: ${fmtCurrency(v, cashCur, { always: true })}`) : undefined),
      source: editing?.source ?? ('manual' as const),
    };
    if (editing) {
      actions.updateTransaction(editing.id, tx);
      toast(t('Lançamento atualizado', 'Transaction updated'));
    } else {
      actions.addTransactions([tx], created ? [created] : []);
      toast(t(`${asset.ticker}: saldo ${fmtCurrency(cashHave + diff, cashCur, { always: true })}`, `${asset.ticker}: balance ${fmtCurrency(cashHave + diff, cashCur, { always: true })}`));
    }
    onClose();
  }

  function save(again: boolean) {
    setError('');
    if (mode === 'cash') return saveCash();
    const tk = mode === 'fixed' ? (existing ? existing.ticker : fixedName) : mode === 'market' ? pick?.symbol ?? '' : normalizeTicker(ticker);
    if (mode === 'fixed' && side === 'SELL' && !existing) return setError(t('Escolha qual investimento você resgatou.', 'Choose which investment you redeemed.'));
    if (mode === 'fixed' && !existing && (fType === 'FUNDO' || fType === 'OUTRO') && !customName.trim()) return setError(t('Dê um nome ao investimento.', 'Give the investment a name.'));
    if (mode === 'fixed' && !existing && fType.startsWith('TESOURO') && !maturity) return setError(t('Informe o vencimento do título.', 'Enter the bond maturity.'));
    if (!tk) return setError(mode === 'income' || mode === 'event' ? t('Escolha o ativo.', 'Choose the asset.') : t('Escolha o ativo.', 'Choose the asset.'));
    if (!date) return setError(t('Informe a data.', 'Enter the date.'));

    let asset = existing ?? (mode === 'fixed' ? data.assets.find((a) => a.ticker.toLowerCase() === tk.toLowerCase()) : undefined);
    let created: Asset | undefined;
    if (!asset) {
      if (mode === 'income' || mode === 'event') return setError(t('Esse ativo não está na sua carteira. Lance uma compra primeiro.', "This asset isn't in your portfolio. Add a buy first."));
      if (mode === 'fixed' && side === 'SELL') return setError(t('Selecione um investimento existente para resgatar.', 'Pick an existing investment to redeem.'));
      created = newAsset(
        mode === 'fixed'
          ? {
              ticker: tk, cls: fType === 'FUNDO' ? 'FUNDO' : 'RENDA_FIXA', institution: institution || undefined,
              name: fType === 'FUNDO' && fundPick ? fundPick.name : undefined,
              cnpj: fType === 'FUNDO' && fundPick ? fundPick.cnpj : undefined,
              fixed: {
                kind: FTYPE[fType].kind, indexer, rate: parseNumber(rate) || 0,
                maturity: daily || !hasMaturity(fType) ? undefined : maturity || undefined,
                issuer: showIssuer && issuer ? issuer : undefined,
                daily: daily || fType === 'POUPANCA' || fType === 'CONTA' ? true : undefined,
              },
            }
          : {
              ticker: tk, name: resolved?.name, cls: resolved?.cls ?? 'ACAO',
              currency: currency !== 'BRL' ? currency : undefined, institution: institution || undefined,
              currentPrice: priceInfo.result?.ok && date >= today() ? priceInfo.result.price : undefined,
            },
      );
      asset = created;
    }

    if (foreign && (mode === 'market' || mode === 'income') && !(fx > 0)) return setError(t('Informe a cotação da moeda no dia.', "Enter that day's exchange rate."));
    const fxPart = foreign && (mode === 'market' || mode === 'income') ? { fxRate: fx } : {};
    const base = { ...fxPart, assetId: asset.id, date, institution: institution || undefined, notes: notes || undefined, source: editing?.source ?? ('manual' as const), importKey: editing?.importKey };
    let tx: Omit<Transaction, 'id' | 'createdAt'>;
    if (mode === 'market') {
      if (!(q > 0)) return setError(lastEdit === 'total' && p > 0 ? t('O valor não compra nem 1 unidade a esse preço.', "That amount doesn't buy even 1 unit at this price.") : t('Informe a quantidade.', 'Enter the quantity.'));
      if (!(p > 0)) return setError(t('Informe o preço.', 'Enter the price.'));
      if (side === 'SELL' && held && q > held.quantity + 1e-9)
        return setError(t(`Você tinha ${qty(held.quantity)} em ${fmtDate(date)}. Falta lançar alguma compra?`, `You had ${qty(held.quantity)} on ${fmtDate(date)}. Is a buy missing?`));
      tx = { ...base, type: side, quantity: q, price: p, fees: f };
    } else if (mode === 'fixed') {
      const a = parseNumber(amount);
      if (!(a > 0)) return setError(t('Informe o valor.', 'Enter the amount.'));
      tx = { ...base, type: side, quantity: 1, price: a, fees: 0, closes: side === 'SELL' ? closes : undefined };
    } else if (mode === 'income') {
      const a = parseNumber(amount);
      if (!(a > 0)) return setError(t('Informe o valor recebido.', 'Enter the amount received.'));
      tx = { ...base, type: incomeType, quantity: 1, price: a, fees: 0 };
    } else if (eventType === 'BONUS') {
      if (!(parseNumber(quantity) > 0)) return setError(t('Informe a quantidade recebida.', 'Enter the quantity received.'));
      tx = { ...base, type: 'BONUS', quantity: parseNumber(quantity), price: p > 0 ? p : 0, fees: 0 };
    } else {
      const from = parseNumber(ratioFrom);
      const to = parseNumber(ratioTo);
      if (!(from > 0 && to > 0) || from === to) return setError(t('Proporção inválida.', 'Invalid ratio.'));
      tx = { ...base, type: 'SPLIT', quantity: 0, price: 0, fees: 0, factor: to / from };
    }

    if (editing) {
      actions.updateTransaction(editing.id, tx);
      toast(t('Lançamento atualizado', 'Transaction updated'));
    } else {
      actions.addTransactions([tx], created ? [created] : []);
      toast(
        mode === 'market'
          ? t(`${side === 'BUY' ? 'Compra' : 'Venda'} de ${qty(q)} ${tk} salva`, `${side === 'BUY' ? 'Bought' : 'Sold'} ${qty(q)} ${tk}`)
          : created ? t(`${tk} adicionado à carteira`, `${tk} added to your portfolio`) : t('Lançamento salvo', 'Transaction saved'),
      );
    }
    if (again) {
      setTicker('');
      setPick(null);
      setQuantity('');
      setTotalStr('');
      setLastEdit('qty');
      setPrice('');
      setFees('');
      setAmount('');
      setNotes('');
      priceManual.current = false;
      fxTouched.current = false;
      setPriceInfo({ state: 'idle' });
    } else onClose();
  }

  const holdingsFor = (m: Mode) => data.assets.filter((a) => (m === 'fixed' ? !isMarketClass(a.cls) : isMarketClass(a.cls)));

  const setDateQuick = (d: Date) => {
    setDate(toISODate(d));
  };
  const yesterday = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  };

  const selling = mode === 'market' && side === 'SELL';

  // ----- Conta: money sitting in a bank/broker account, in reais, dollars or euros -----
  const CASH_NAME: Record<Currency, string> = { BRL: t('Reais', 'Reais'), USD: t('Dólar', 'Dollars'), EUR: 'Euro' };
  const cashTicker = `${CASH_NAME[cashCur]} ${institution || ''}`.trim();
  const cashAsset =
    initAsset?.cls === 'CAIXA'
      ? initAsset
      : data.assets.find((a) => a.cls === 'CAIXA' && currencyOf(a) === cashCur && (a.institution ?? '').toLowerCase() === institution.toLowerCase() && !!institution);
  const cashHave = useMemo(() => {
    if (!cashAsset) return 0;
    const list = data.transactions.filter((x) => x.assetId === cashAsset.id && x.id !== editing?.id);
    return runMarket(cashAsset, list, date, data.settings).quantity;
  }, [cashAsset, data.transactions, data.settings, date, editing?.id]);

  // ----- Renda fixa: everything is picked; the name is built from the choices -----
  const fixedPositions = useMemo(() => computePositions(data.assets.filter((a) => !isMarketClass(a.cls)), data.transactions, data.settings, today()), [data]);
  const fixedHoldings = fixedPositions.filter((p) => !p.closed || p.asset.id === initAsset?.id).map((p) => p.asset);
  const fixedSub = (a: Asset) => {
    const p = fixedPositions.find((x) => x.asset.id === a.id);
    return [p ? money(p.value, { always: true }) : '', a.institution].filter(Boolean).join(' · ');
  };
  const marketPositions = useMemo(() => computePositions(data.assets.filter((a) => isMarketClass(a.cls)), data.transactions, data.settings, today()), [data]);
  const marketHoldings = marketPositions
    .filter((p) => p.quantity > 0 || p.asset.id === initAsset?.id)
    .sort((a, b) => b.value - a.value)
    .map((p) => p.asset);
  const marketSub = (a: Asset) => {
    const p = marketPositions.find((x) => x.asset.id === a.id);
    return [p ? `${qty(p.quantity)} ${a.cls === 'FII' ? t('cotas', 'units') : a.cls === 'CRIPTO' ? '' : t('ações', 'shares')}` : '', a.name].filter(Boolean).join(' · ');
  };
  const autoName = buildFixedName({ fType, bank: (showIssuer && issuer) || institution, indexer, rate: parseNumber(rate), maturity: daily ? '' : maturity, daily });
  const fixedName = (fType === 'FUNDO' || fType === 'OUTRO' ? customName : customName || autoName).trim();
  function chooseFType(k: FType) {
    setFType(k);
    const d = FTYPE[k];
    setIndexer(d.indexers[0]);
    setRate(String(d.rate).replace('.', t(',', '.')));
    setDaily(k === 'CONTA' || k === 'POUPANCA');
    setCustomName('');
    setFundPick(null);
    if (!k.startsWith('TESOURO') && k !== 'CDB' && k !== 'LCI' && k !== 'LCA') setShowIssuer(false);
  }
  const liveNow = resolved ? live.quotes.get(resolved.symbol.toUpperCase()) : undefined;

  return (
    <Modal
      title={editing ? t('Editar lançamento', 'Edit transaction') : t('Novo lançamento', 'New transaction')}
      onClose={onClose}
      footer={
        <>
          {error && <span className="neg small" style={{ marginRight: 'auto', alignSelf: 'center' }}>{error}</span>}
          <button className="btn" onClick={onClose}>{t('Cancelar', 'Cancel')}</button>
          {!editing && !selling && mode !== 'cash' && <button className="btn" onClick={() => save(true)}>{t('Salvar e adicionar outro', 'Save and add another')}</button>}
          <button className="btn primary" onClick={() => save(false)}>{selling ? t('Vender', 'Sell') : t('Salvar', 'Save')}</button>
        </>
      }
    >
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(false); }}>
        {!editing && (
          <div className="type-grid" role="tablist">
            {([
              ['market', t('Bolsa', 'Market'), t('Ações, FIIs, ETFs, EUA, cripto', 'Stocks, REITs, ETFs, US, crypto'), 'chart'],
              ['fixed', t('Renda fixa', 'Fixed income'), t('CDB, LCI, Tesouro, fundos', 'CDB, LCI, Tesouro, funds'), 'wallet'],
              ['income', t('Provento', 'Dividend'), t('Dividendo, JCP, rendimento', 'Dividend, JCP, income'), 'coins'],
              ['event', t('Evento', 'Event'), t('Desdobro, bonificação', 'Split, bonus shares'), 'refresh'],
              ['cash', t('Conta', 'Cash'), t('Dinheiro em R$, US$ ou €', 'Money in R$, US$ or €'), 'cash'],
            ] as [Mode, string, string, string][]).map(([m, l, d, ic]) => (
              <button type="button" key={m} className={'type-card' + (mode === m ? ' on' : '')} onClick={() => setMode(m)}>
                <Icon name={ic} size={18} />
                <b>{l}</b>
                <span>{d}</span>
              </button>
            ))}
          </div>
        )}

        <div key={mode} className="mode-pane stack">
        {mode === 'market' && (
          <>
            <div className="seg">
              <button type="button" className={side === 'BUY' ? 'on' : ''} onClick={() => setSide('BUY')}>{t('Compra', 'Buy')}</button>
              <button type="button" className={side === 'SELL' ? 'on' : ''} onClick={() => setSide('SELL')}>{t('Venda', 'Sell')}</button>
            </div>

            {resolved ? (
              <div className="picked">
                <Logo symbol={resolved.symbol} market={resolved.market} cls={resolved.cls} size={44} />
                <div className="picked-info">
                  <b>{resolved.symbol}</b>
                  <span>{resolved.name ?? CLASS_LABEL[resolved.cls]}</span>
                </div>
                <div className="picked-meta">
                  <span className="chip">{CLASS_LABEL[resolved.cls]} · {sym}</span>
                  {liveNow && <span className="small text-2">{t('agora', 'now')} {fmtCurrency(liveNow.price, currency, { always: true })}</span>}
                  {held && held.quantity > 0 && <span className="small muted">{t('você tem', 'you hold')} {qty(held.quantity)}</span>}
                </div>
                {!editing && (
                  <button type="button" className="icon-btn" title={t('Trocar ativo', 'Change asset')} onClick={() => { setTicker(''); setPick(null); setPriceInfo({ state: 'idle' }); }}>
                    <Icon name="x" size={16} />
                  </button>
                )}
              </div>
            ) : (
              <SymbolSearch
                value={ticker}
                onChange={(v) => { setTicker(v); setPick(null); priceManual.current = false; }}
                onEnterRaw={(v) => {
                  const t = normalizeTicker(v);
                  const cls = guessClass(t) ?? 'ACAO';
                  const cur: Currency = cls === 'EXTERIOR' ? 'USD' : 'BRL';
                  choose({ symbol: t, cls, currency: cur, market: priceMarket(cls, cur), custom: true });
                }}
                onPick={choose}
                holdings={holdingsFor('market')}
                autoFocus={!initAsset}
              />
            )}

            {resolved?.custom && !existing && (
              <div className="form-grid">
                <label className="field">
                  <span>{t('Classe', 'Class')}</span>
                  <select className="input" value={resolved.cls} onChange={(e) => { const cls = e.target.value as AssetClass; setPick({ ...resolved, cls, market: priceMarket(cls, resolved.currency) }); }}>
                    {CLASS_ORDER.filter(isMarketClass).map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>{t('Moeda', 'Currency')}</span>
                  <select className="input" value={currency} onChange={(e) => { const cur = e.target.value as Currency; setPick({ ...resolved, currency: cur, market: priceMarket(resolved.cls, cur) }); fxTouched.current = false; }}>
                    {(Object.keys(CURRENCY_LABEL) as Currency[]).map((c) => <option key={c} value={c}>{CURRENCY_SYMBOL[c]} · {CURRENCY_LABEL[c]}</option>)}
                  </select>
                </label>
                <span className="hint full">{t(`Não achamos “${resolved.symbol}” na lista — confira a classe e a moeda.`, `“${resolved.symbol}” isn't in our list — check the class and currency.`)}</span>
              </div>
            )}

            <div className="form-grid">
              <label className="field">
                <span>{t('Data', 'Date')}</span>
                <input className="input" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
                <span className="quick-dates">
                  <button type="button" className={date === today() ? 'on' : ''} onClick={() => setDateQuick(new Date())}>{t('Hoje', 'Today')}</button>
                  <button type="button" className={date === toISODate(yesterday()) ? 'on' : ''} onClick={() => setDateQuick(yesterday())}>{t('Ontem', 'Yesterday')}</button>
                </span>
              </label>
              <InstitutionField value={institution} onChange={setInstitution} options={institutions} />

              <label className="field">
                <span className="row">
                  {t('Preço', 'Price')} ({sym})
                  {priceInfo.state === 'loading' && <span className="spinner" aria-label={t('buscando', 'loading')} />}
                </span>
                <input
                  className={'input num' + (priceInfo.state === 'done' && priceInfo.result?.ok && !priceManual.current ? ' auto-filled' : '')}
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => { priceManual.current = true; setPrice(e.target.value); }}
                  placeholder={priceInfo.state === 'loading' ? 'buscando…' : '0,00'}
                />
                <PriceHint info={priceInfo} manual={priceManual.current} date={date} onReset={() => { priceManual.current = false; setRefetch((k) => k + 1); }} />
              </label>

              <label className="field">
                <span className="row">
                  {t('Quantidade', 'Quantity')}
                  {side === 'SELL' && held && held.quantity > 0 && (
                    <button type="button" className="link-btn" onClick={() => { setLastEdit('qty'); setQuantity(str(held.quantity)); }}>{t('vender tudo', 'sell all')} ({qty(held.quantity)})</button>
                  )}
                </span>
                <input
                  className="input num"
                  inputMode="decimal"
                  value={lastEdit === 'total' ? (Number.isFinite(q) && q > 0 ? str(q) : '') : quantity}
                  onChange={(e) => { setLastEdit('qty'); setQuantity(e.target.value); }}
                  placeholder="0"
                />
              </label>

              <label className="field">
                <span>{t('Valor da operação', 'Trade amount')} ({sym})</span>
                <input
                  className="input num"
                  inputMode="decimal"
                  value={lastEdit === 'total' ? totalStr : Number.isFinite(gross) && gross > 0 ? str(Math.round(gross * 100) / 100) : ''}
                  onChange={(e) => { setLastEdit('total'); setTotalStr(e.target.value); }}
                  placeholder={t('ou digite o valor total', 'or type the total')}
                />
                {lastEdit === 'total' && leftover > 0.009 && <span className="hint">{t('Compra', 'Buys')} {qty(q)} · {t('sobra', 'left over')} {fmtCurrency(leftover, currency, { always: true })}</span>}
              </label>

              <label className="field">
                <span>{t('Taxas', 'Fees')} ({sym}) · {t('opcional', 'optional')}</span>
                <input className="input num" inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} placeholder={t('0,00', '0.00')} />
              </label>

              {foreign && (
                <label className="field full">
                  <span>{CURRENCY_LABEL[currency]} {t('no dia', 'on that day')} (R$)</span>
                  <input className="input num" inputMode="decimal" value={fxRate} onChange={(e) => { fxTouched.current = true; setFxRate(e.target.value); }} />
                  <span className="hint">{t('Preenchido automaticamente pela data — usado no custo em reais e no IR.', 'Filled in automatically from the date — used for the cost in reais and for taxes.')}</span>
                </label>
              )}
            </div>

            <div className="summary">
              <div>
                <span className="muted small">{side === 'BUY' ? t('Total da compra', 'Purchase total') : t('Total da venda', 'Sale total')}</span>
                <b>{Number.isFinite(total) && total > 0 ? fmtCurrency(total, currency, { always: true }) : '—'}</b>
                {foreign && Number.isFinite(total) && fx > 0 && total > 0 && <span className="muted small">≈ {money(total * fx, { always: true })}</span>}
              </div>
              {side === 'SELL' && held && held.avg > 0 && Number.isFinite(total) && q > 0 && (
                <div style={{ textAlign: 'right' }}>
                  <span className="muted small">{t('Resultado estimado', 'Estimated result')}</span>
                  <b className={total - held.avg * q >= 0 ? 'pos' : 'neg'}>{fmtCurrency(total - held.avg * q, currency, { always: true })}</b>
                </div>
              )}
              {side === 'BUY' && held && held.quantity > 0 && Number.isFinite(total) && q > 0 && (
                <div style={{ textAlign: 'right' }}>
                  <span className="muted small">{t('Novo preço médio', 'New average price')}</span>
                  <b>{fmtCurrency((held.avg * held.quantity + total) / (held.quantity + q), currency, { always: true })}</b>
                </div>
              )}
            </div>
            {side === 'SELL' && existing && q > 0 && p > 0 && (
              <TaxPreview
                estimate={estimateSaleTax(data.assets, data.transactions, data.settings, {
                  id: editing?.id ?? '__draft', assetId: existing.id, type: 'SELL', date, quantity: q, price: p, fees: f,
                  fxRate: foreign && fx > 0 ? fx : undefined, createdAt: editing?.createdAt ?? new Date().toISOString(),
                })}
              />
            )}
          </>
        )}

        {mode === 'fixed' && (
          <>
            <div className="seg">
              <button type="button" className={side === 'BUY' ? 'on' : ''} onClick={() => setSide('BUY')}>{t('Aplicação', 'Deposit')}</button>
              <button type="button" className={side === 'SELL' ? 'on' : ''} onClick={() => setSide('SELL')}>{t('Resgate', 'Redemption')}</button>
            </div>

            {side === 'SELL' ? (
              <HoldingPicker
                label={t('Qual investimento?', 'Which investment?')}
                holdings={fixedHoldings}
                value={ticker}
                onChange={setTicker}
                sub={(a) => fixedSub(a)}
                empty={t('Você ainda não tem renda fixa lançada.', "You don't have any fixed income yet.")}
              />
            ) : (
              <>
                {existing && (
                  <div className="picked">
                    <Logo symbol={existing.ticker} market={marketOf(existing.cls, 'BRL')} cls={existing.cls} size={40} />
                    <div className="picked-info">
                      <b>{existing.ticker}</b>
                      <span>{fixedSub(existing)}</span>
                    </div>
                  </div>
                )}
                {!existing && (
                  <>
                    <div className="field">
                      <span>{t('Tipo', 'Type')}</span>
                      <div className="ftype-grid">
                        {FTYPES.map((k) => (
                          <button type="button" key={k} className={'ftype' + (fType === k ? ' on' : '')} onClick={() => chooseFType(k)}>
                            <b>{FTYPE[k].label()}</b>
                            <span>{FTYPE[k].hint()}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="form-grid">
                      <InstitutionField value={institution} onChange={setInstitution} options={institutions} label={fType.startsWith('TESOURO') ? t('Corretora', 'Broker') : t('Banco / corretora', 'Bank / broker')} />
                      {fType === 'FUNDO' && (
                        <FundSearch
                          value={customName}
                          picked={fundPick}
                          onType={(v) => { setCustomName(v); setFundPick(null); }}
                          onPick={(f) => { setFundPick(f); setCustomName(prettyFund(f.name)); }}
                          onListed={(pk) => { setMode('market'); setSide('BUY'); choose(pk); }}
                        />
                      )}
                      {fType === 'OUTRO' && (
                        <label className="field">
                          <span>{t('Código ou nome', 'Code or name')}</span>
                          <input className="input" value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder={t('Como aparece na corretora', 'As shown by your broker')} />
                        </label>
                      )}

                      {fType !== 'POUPANCA' && (
                        <label className="field">
                          <span>{fType === 'FUNDO' ? t('Rende mais ou menos (estimativa)', 'Roughly yields (estimate)') : t('Rentabilidade', 'Yield')}</span>
                          <div className="rate-row">
                            {FTYPE[fType].indexers.length > 1 && (
                              <select className="input rate-idx" value={indexer} onChange={(e) => { const ix = e.target.value as Indexer; setIndexer(ix); setRate(String(DEFAULT_RATE[ix]).replace('.', t(',', '.'))); }}>
                                {FTYPE[fType].indexers.map((ix) => <option key={ix} value={ix}>{INDEXER_LABEL[ix]}</option>)}
                              </select>
                            )}
                            {FTYPE[fType].indexers.length === 1 && <span className="rate-fixed">{indexer === 'CDI' ? '' : INDEXER_LABEL[indexer]}</span>}
                            <input className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                            <span className="muted rate-unit">{indexer === 'CDI' ? (FTYPE[fType].indexers.length > 1 ? '%' : t('% do CDI', '% of CDI')) : t('% a.a.', '% p.a.')}</span>
                          </div>
                        </label>
                      )}
                      {fType === 'POUPANCA' && (
                        <div className="field"><span>{t('Rentabilidade', 'Yield')}</span><div className="muted small" style={{ paddingTop: 10 }}>{t('Definida pelo governo: 0,5% ao mês + TR (com a Selic acima de 8,5%).', 'Set by the government: 0.5% a month + TR (with Selic above 8.5%).')}</div></div>
                      )}

                      {hasMaturity(fType) && (
                        <label className="field">
                          <span className="row">
                            {t('Vencimento', 'Maturity')}
                            {!fType.startsWith('TESOURO') && (
                              <label className="mini-check"><input type="checkbox" checked={daily} onChange={(e) => setDaily(e.target.checked)} /> {t('Liquidez diária', 'Withdraw any time')}</label>
                            )}
                          </span>
                          {daily && !fType.startsWith('TESOURO') ? (
                            <div className="input input-static muted">{t('Sem vencimento — resgata quando quiser', 'No maturity — withdraw any time')}</div>
                          ) : (
                            <input className="input" type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} />
                          )}
                        </label>
                      )}

                      {(fType === 'CDB' || fType === 'LCI' || fType === 'LCA') && (
                        <div className="field full" style={{ gap: 4 }}>
                          {!showIssuer ? (
                            <button type="button" className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowIssuer(true)}>
                              {t('Comprou pela corretora um título de outro banco?', 'Bought another bank’s bond through your broker?')}
                            </button>
                          ) : (
                            <InstitutionField value={issuer} onChange={setIssuer} options={institutions} label={t('Banco emissor (quem emitiu o título)', 'Issuing bank (who issued the bond)')} />
                          )}
                        </div>
                      )}
                    </div>

                  </>
                )}
              </>
            )}

            <div className="form-grid">
              <label className="field">
                <span>{t('Data', 'Date')}</span>
                <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label className="field">
                <span>{side === 'BUY' ? t('Valor aplicado (R$)', 'Amount invested (R$)') : t('Valor resgatado (R$)', 'Amount redeemed (R$)')}</span>
                <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('0,00', '0.00')} />
              </label>
              {side === 'SELL' && existing && (
                <label className="field full">
                  <span className="row"><input type="checkbox" checked={closes} onChange={(e) => setCloses(e.target.checked)} /> {t('Resgatei tudo (encerra o investimento)', 'I withdrew everything (closes the investment)')}</span>
                </label>
              )}
            </div>
          </>
        )}

        {mode === 'cash' && (
          <div className="stack" style={{ gap: 14 }}>
            {initAsset?.cls !== 'CAIXA' && (
              <div className="seg">
                {(['BRL', 'USD', 'EUR'] as Currency[]).map((c) => (
                  <button type="button" key={c} className={cashCur === c ? 'on' : ''} onClick={() => setCashCur(c)}>
                    {c === 'BRL' ? t('R$ Reais', 'R$ Reais') : c === 'USD' ? t('US$ Dólar', 'US$ Dollars') : '€ Euro'}
                  </button>
                ))}
              </div>
            )}
            <div className="form-grid">
              <InstitutionField value={institution} onChange={setInstitution} options={institutions} label={t('Banco / corretora', 'Bank / broker')} />
              <label className="field">
                <span>{t('Data', 'Date')}</span>
                <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <div className="field full">
                <span>{t('O que você quer registrar?', 'What do you want to record?')}</span>
                <div className="seg">
                  {!editing && <button type="button" className={cashOp === 'balance' ? 'on' : ''} onClick={() => setCashOp('balance')}>{t('Saldo de hoje', 'Current balance')}</button>}
                  <button type="button" className={cashOp === 'in' ? 'on' : ''} onClick={() => setCashOp('in')}>{t('Entrada', 'Money in')}</button>
                  <button type="button" className={cashOp === 'out' ? 'on' : ''} onClick={() => setCashOp('out')}>{t('Saída', 'Money out')}</button>
                </div>
              </div>
              <label className="field">
                <span>{cashOp === 'balance' ? t('Saldo na conta', 'Account balance') : t('Valor', 'Amount')} ({sym})</span>
                <input className="input num" inputMode="decimal" value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} placeholder={t('0,00', '0.00')} autoFocus={!!initAsset} />
                {cashAsset && <span className="hint">{t('Hoje o Walleti tem', 'Walleti has')} {fmtCurrency(cashHave, cashCur, { always: true })} {t('em', 'in')} {cashAsset.ticker}</span>}
              </label>
              {foreign && (
                <label className="field">
                  <span>{CURRENCY_LABEL[currency]} {t('no dia', 'on that day')} (R$)</span>
                  <input className="input num" inputMode="decimal" value={fxRate} onChange={(e) => { fxTouched.current = true; setFxRate(e.target.value); }} />
                </label>
              )}
            </div>
          </div>
        )}

        {mode === 'income' && (
          <div className="form-grid">
            <div className="full">
              <HoldingPicker label={t('Qual ativo pagou?', 'Which asset paid?')} holdings={marketHoldings.filter((a) => a.cls !== 'CRIPTO')} value={ticker} onChange={setTicker} sub={(a) => marketSub(a)} empty={t('Você ainda não tem ações ou FIIs lançados.', "You don't have any stocks or REITs yet.")} />
            </div>
            <label className="field">
              <span>{t('Tipo', 'Type')}</span>
              <select className="input" value={incomeType} onChange={(e) => setIncomeType(e.target.value as TxType)}>
                <option value="DIVIDEND">{t('Dividendo (isento)', 'Dividend (tax-exempt)')}</option>
                <option value="JCP">{t('Juros sobre capital próprio (JCP)', 'Interest on equity (JCP)')}</option>
                <option value="INCOME">{t('Rendimento (FII, juros, cupom)', 'Income (REIT, interest, coupon)')}</option>
              </select>
            </label>
            <label className="field">
              <span>{t('Data do pagamento', 'Payment date')}</span>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('Valor líquido recebido', 'Net amount received')} ({sym})</span>
              <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('0,00', '0.00')} />
            </label>
            <InstitutionField value={institution} onChange={setInstitution} options={institutions} />
          </div>
        )}

        {mode === 'event' && (
          <div className="form-grid">
            <div className="full">
              <HoldingPicker label={t('Ativo', 'Asset')} holdings={marketHoldings} value={ticker} onChange={setTicker} sub={(a) => marketSub(a)} empty={t('Você ainda não tem ações lançadas.', "You don't have any stocks yet.")} />
            </div>
            <label className="field">
              <span>{t('Evento', 'Event')}</span>
              <select className="input" value={eventType} onChange={(e) => setEventType(e.target.value as typeof eventType)}>
                <option value="SPLIT">{t('Desdobramento (split)', 'Stock split')}</option>
                <option value="GROUP">{t('Grupamento (inplit)', 'Reverse split')}</option>
                <option value="BONUS">{t('Bonificação em ações', 'Bonus shares')}</option>
              </select>
            </label>
            <label className="field">
              <span>{t('Data', 'Date')}</span>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            {eventType === 'BONUS' ? (
              <>
                <label className="field">
                  <span>{t('Quantidade recebida', 'Quantity received')}</span>
                  <input className="input num" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                </label>
                <label className="field">
                  <span>{t('Custo unitário atribuído', 'Assigned unit cost')}</span>
                  <input className="input num" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={t('0,00', '0.00')} />
                  <span className="hint">{t('Informado pela empresa no fato relevante. Entra no preço médio.', "Stated in the company's announcement. It goes into the average price.")}</span>
                </label>
              </>
            ) : (
              <label className="field full">
                <span>{t('Proporção', 'Ratio')}</span>
                <div className="row">
                  <input className="input num" style={{ width: 90 }} value={ratioFrom} onChange={(e) => setRatioFrom(e.target.value)} />
                  <span className="muted">{eventType === 'SPLIT' ? t('ação vira', 'share becomes') : t('ações viram', 'shares become')}</span>
                  <input className="input num" style={{ width: 90 }} value={ratioTo} onChange={(e) => setRatioTo(e.target.value)} />
                  {held && <span className="muted small">{t('Hoje', 'Today')}: {qty(held.quantity)} → {qty((held.quantity * (parseNumber(ratioTo) || 1)) / (parseNumber(ratioFrom) || 1))}</span>}
                </div>
              </label>
            )}
          </div>
        )}
        </div>

        <label className="field">
          <span>{t('Observação (opcional)', 'Note (optional)')}</span>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Subtle one-line income-tax preview for a sale. */
function TaxPreview({ estimate: e }: { estimate: SaleTaxEstimate | null }) {
  if (!e) return null;
  const pctUsed = e.limit ? Math.min(1, e.monthSales / e.limit) : 0;
  let title: React.ReactNode;
  let sub: React.ReactNode;
  let tone: 'ok' | 'due' | 'info' = 'info';
  switch (e.kind) {
    case 'exempt-stocks':
      tone = 'ok';
      title = t('Isento de IR', 'Tax-free');
      sub = t(
        `Vendas de ações neste mês: ${money(e.monthSales, { always: true })} de ${money(e.limit!, { always: true })}. Lucro de ${money(e.gain, { always: true })} livre de imposto.`,
        `Stock sales this month: ${money(e.monthSales, { always: true })} of ${money(e.limit!, { always: true })}. ${money(e.gain, { always: true })} profit tax-free.`,
      );
      break;
    case 'crypto-exempt':
      tone = 'ok';
      title = t('Isento de IR', 'Tax-free');
      sub = t(`Vendas de cripto no mês: ${money(e.monthSales, { always: true })} de ${money(e.limit!, { always: true })}.`, `Crypto sales this month: ${money(e.monthSales, { always: true })} of ${money(e.limit!, { always: true })}.`);
      break;
    case 'loss':
      title = t('Sem IR — venda com prejuízo', 'No tax — sold at a loss');
      sub = t(`Prejuízo de ${money(-e.gain, { always: true })}. Ele abate o imposto de lucros futuros.`, `A ${money(-e.gain, { always: true })} loss. It offsets tax on future gains.`);
      break;
    case 'annual':
      tone = 'due';
      title = <>{t('IR estimado', 'Estimated tax')} {money(e.tax, { always: true })}</>;
      sub = t(`15% sobre o lucro de ${money(e.gain, { always: true })}, pago na declaração anual (ações no exterior não têm isenção).`, `15% of the ${money(e.gain, { always: true })} profit, paid with the yearly return (no exemption abroad).`);
      break;
    case 'crypto':
      tone = 'due';
      title = <>{t('IR estimado', 'Estimated tax')} {money(e.tax, { always: true })}</>;
      sub = t('15% sobre o lucro · vendas de cripto acima de R$ 35 mil no mês (GCAP, até o fim do mês seguinte).', '15% of the profit · crypto sales above R$ 35k this month (GCAP, due by the end of next month).');
      break;
    default:
      tone = e.tax > 0 ? 'due' : 'info';
      title = e.tax > 0 ? <>{t('IR estimado', 'Estimated tax')} {money(e.tax, { always: true })}</> : t('Sem IR a pagar', 'No tax due');
      sub = e.tax > 0
        ? t(`${Math.round(e.rate * 100)}% sobre o lucro · DARF 6015 até ${fmtDate(e.dueDate)}.`, `${Math.round(e.rate * 100)}% of the profit · DARF 6015 due ${fmtDate(e.dueDate)}.`)
        : t('Prejuízos anteriores cobrem este lucro.', 'Earlier losses cover this profit.');
  }
  return (
    <div className={'tax-preview ' + tone}>
      <Icon name={tone === 'ok' ? 'check' : 'receipt'} size={16} />
      <div className="tp-text">
        <b>{title}</b>
        <span>{sub}</span>
        {(e.kind === 'exempt-stocks' || e.kind === 'monthly') && e.limit && (
          <span className="tp-bar"><span style={{ width: `${pctUsed * 100}%` }} /></span>
        )}
      </div>
    </div>
  );
}

function PriceHint({ info, manual, date, onReset }: { info: { state: string; result?: PriceResult }; manual: boolean; date: string; onReset: () => void }) {
  if (manual) {
    return (
      <span className="hint">
        {t('Preço digitado', 'Price typed in')} · <button type="button" className="link-btn" onClick={onReset}>{t('buscar automático', 'fetch automatically')}</button>
      </span>
    );
  }
  if (info.state !== 'done' || !info.result) return <span className="hint">&nbsp;</span>;
  const r = info.result;
  if (r.ok) {
    const when = r.source === 'saved' ? t('Última cotação salva', 'Last saved quote') : date >= today() ? t('Preço de agora', 'Current price') : r.exact ? `${t('Fechamento de', 'Close on')} ${fmtDate(r.date)}` : `${t('Último fechamento antes', 'Last close before')}: ${fmtDate(r.date)}`;
    return <span className="hint auto-hint"><Icon name="check" size={12} /> {when}{r.source !== 'saved' && ` · ${r.source}`}</span>;
  }
  return <span className="hint" style={{ color: 'var(--warn-ink)' }}>{r.hint ?? t('Preço não encontrado para essa data — digite o valor.', 'No price found for this date — type it in.')}</span>;
}

/** Bank / broker picker: a plain list (yours first), with "Outro…" to type a name. */
function InstitutionField({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: string[]; label?: string }) {
  const yours = options.filter((o) => o && !INSTITUTIONS.includes(o));
  const used = options.filter((o) => INSTITUTIONS.includes(o));
  const known = !value || INSTITUTIONS.includes(value) || yours.includes(value);
  const [typing, setTyping] = useState(!known);
  return (
    <label className="field">
      <span className="row">
        {label ?? t('Corretora / banco', 'Broker / bank')}
        {typing && <button type="button" className="link-btn" onClick={() => { setTyping(false); onChange(''); }}>{t('ver lista', 'show list')}</button>}
      </span>
      {typing ? (
        <input className="input" autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('Nome do banco ou corretora', 'Bank or broker name')} />
      ) : (
        <select
          className="input"
          value={value}
          onChange={(e) => {
            if (e.target.value === '__other') {
              setTyping(true);
              onChange('');
            } else onChange(e.target.value);
          }}
        >
          <option value="">{t('Escolha…', 'Choose…')}</option>
          {(used.length > 0 || yours.length > 0) && (
            <optgroup label={t('Que você já usa', 'You already use')}>
              {[...used, ...yours].map((o) => <option key={'u' + o} value={o}>{o}</option>)}
            </optgroup>
          )}
          <optgroup label={t('Bancos e corretoras', 'Banks and brokers')}>
            {INSTITUTIONS.filter((o) => !used.includes(o)).map((o) => <option key={o} value={o}>{o}</option>)}
          </optgroup>
          <option value="__other">{t('Outro…', 'Other…')}</option>
        </select>
      )}
    </label>
  );
}

/** Search the CVM fund registry by name or CNPJ. */
function FundSearch({ value, picked, onType, onPick, onListed }: { value: string; picked: Fund | null; onType: (v: string) => void; onPick: (f: Fund) => void; onListed: (p: Pick) => void }) {
  const [res, setRes] = useState<Fund[]>([]);
  const [listed, setListed] = useState<Pick[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (picked || value.trim().length < 2) {
      setRes([]);
      setListed([]);
      return;
    }
    let alive = true;
    setBusy(true);
    // Listed on B3 (FIIs, ETFs, stocks): instant from the built-in list, then brapi's full list.
    const local = searchDirectory(value, 4).filter((x) => x.kind !== 'U' && x.kind !== 'C').map(pickFromInfo);
    setListed(local);
    const id = setTimeout(() => {
      searchFunds(value).then((r) => alive && (setRes(r), setBusy(false), setActive(0)));
      searchSymbols(value, getData().settings).then((hits) => {
        if (!alive) return;
        const extra = hits
          .filter((h) => h.market === 'B3' && !local.some((l) => l.symbol === h.symbol))
          .slice(0, 4)
          .map((h): Pick => ({ symbol: h.symbol, cls: guessClass(h.symbol) ?? 'ACAO', currency: 'BRL', market: 'B3' }));
        setListed([...local, ...extra].slice(0, 5));
      });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [value, picked]);
  const pick = (f: Fund) => {
    onPick(f);
    setOpen(false);
  };
  return (
    <label className="field combo full">
      <span>{t('Fundo', 'Fund')}</span>
      <input
        className="input"
        value={value}
        placeholder={t('Busque pelo nome ou CNPJ (ex.: Trend DI)', 'Search by name or CNPJ (e.g. Trend DI)')}
        onChange={(e) => { onType(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !res.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, res.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); pick(res[active]); }
        }}
      />
      {picked && <span className="hint">CNPJ {picked.cnpj} · {FUND_CLASS(picked.cls, getLang() !== 'en')}</span>}
      {open && !picked && value.trim().length >= 2 && (res.length > 0 || listed.length > 0 || !busy) && (
        <div className="combo-list">
          {res.map((f, i) => (
            <div key={f.cnpj} className={'combo-item' + (i === active ? ' on' : '')} onMouseDown={() => pick(f)}>
              <span className="ci-text">
                <b>{prettyFund(f.name)}</b>
                <span>{FUND_CLASS(f.cls, getLang() !== 'en')} · CNPJ {f.cnpj}</span>
              </span>
            </div>
          ))}
          {listed.length > 0 && (
            <>
              <div className="combo-section">{t('Negociados na bolsa', 'Traded on the exchange')}</div>
              {listed.map((l) => (
                <div key={'b' + l.symbol} className="combo-item" onMouseDown={() => onListed(l)}>
                  <Logo symbol={l.symbol} market="B3" cls={l.cls} size={26} />
                  <span className="ci-text">
                    <b>{l.symbol}</b>
                    <span>{[l.name, CLASS_LABEL[l.cls]].filter(Boolean).join(' · ')} · {t('lançar em Bolsa', 'add under Market')} →</span>
                  </span>
                </div>
              ))}
            </>
          )}
          {res.length > 0 && listed.length > 0 && <div className="combo-section">{t('Fundos (CVM)', 'Funds (CVM)')}</div>}
          {!res.length && !listed.length && <div className="combo-item muted small" style={{ cursor: 'default' }}>{t('Nenhum fundo encontrado — pode deixar o nome assim mesmo.', 'No fund found — you can keep the name as typed.')}</div>}
        </div>
      )}
    </label>
  );
}

/** Pick one of your holdings from a list (no typing, no pop-ups). */
function HoldingPicker({
  label, holdings, value, onChange, sub, empty,
}: { label: string; holdings: Asset[]; value: string; onChange: (v: string) => void; sub: (a: Asset) => string; empty: string }) {
  const [q, setQ] = useState('');
  const fq = q.trim().toUpperCase();
  const list = holdings.filter((a) => !fq || a.ticker.toUpperCase().includes(fq) || (a.name ?? '').toUpperCase().includes(fq));
  return (
    <div className="field">
      <span className="row">
        {label}
        {holdings.length > 6 && <input className="picker-filter" placeholder={t('Filtrar', 'Filter')} value={q} onChange={(e) => setQ(e.target.value)} />}
      </span>
      {!holdings.length ? (
        <div className="picker-empty muted small">{empty}</div>
      ) : (
        <div className="picker" role="listbox">
          {list.map((a) => {
            const on = a.ticker.toUpperCase() === value.trim().toUpperCase();
            return (
              <button type="button" role="option" aria-selected={on} key={a.id} className={'picker-item' + (on ? ' on' : '')} onClick={() => onChange(a.ticker)}>
                <Logo symbol={a.ticker} market={marketOf(a.cls, currencyOf(a))} cls={a.cls} size={28} />
                <span className="ci-text">
                  <b>{a.ticker}</b>
                  <span>{sub(a)}</span>
                </span>
                <span className="picker-check">{on && <Icon name="check" size={15} />}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Symbol search: holdings + built-in directory (instant) + online search.

type Item =
  | { kind: 'raw'; symbol: string }
  | { kind: 'holding'; asset: Asset }
  | { kind: 'dir'; info: TickerInfo }
  | { kind: 'remote'; symbol: string; name: string; market: 'US' | 'B3' };

const tag = (k: string) => ({ A: 'B3', F: 'FII', E: 'ETF', U: t('EUA · US$', 'US · US$'), C: t('Cripto', 'Crypto') })[k] ?? k;
const POPULAR = ['PETR4', 'VALE3', 'ITUB4', 'BBAS3', 'WEGE3', 'MXRF11', 'BOVA11', 'AAPL', 'NVDA', 'AMD', 'TTWO', 'BTC'];

function SymbolSearch({
  value, onChange, onPick, onEnterRaw, holdings, autoFocus,
}: { value: string; onChange: (v: string) => void; onPick: (p: Pick) => void; onEnterRaw: (v: string) => void; holdings: Asset[]; autoFocus?: boolean }) {
  const data = useData();
  const [open, setOpen] = useState(!!autoFocus);
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<Item[]>([]);
  const [searching, setSearching] = useState(false);
  const q = value.trim();

  // Online search complements the directory (debounced).
  useEffect(() => {
    if (q.length < 2) return setRemote([]);
    let alive = true;
    setSearching(true);
    const id = setTimeout(async () => {
      const [a, b] = await Promise.all([searchSymbols(q, data.settings), twelveSearch(q)]);
      if (!alive) return;
      const seen = new Set<string>();
      const out: Item[] = [];
      for (const h of a) if (!seen.has(h.symbol)) { seen.add(h.symbol); out.push({ kind: 'remote', symbol: h.symbol, name: h.description, market: h.market }); }
      for (const h of b) if (!seen.has(h.symbol)) { seen.add(h.symbol); out.push({ kind: 'remote', symbol: h.symbol, name: h.name, market: h.market }); }
      setRemote(out);
      setSearching(false);
    }, 350);
    return () => {
      alive = false;
      clearTimeout(id);
      setSearching(false);
    };
  }, [q, data.settings]);

  const items: Item[] = useMemo(() => {
    const fq = q.toUpperCase();
    const own = holdings
      .filter((a) => !q || a.ticker.toUpperCase().includes(fq) || (a.name ?? '').toUpperCase().includes(fq))
      .slice(0, q ? 4 : 6)
      .map((asset) => ({ kind: 'holding' as const, asset }));
    const ownSet = new Set(own.map((o) => o.asset.ticker.toUpperCase()));
    const dir = (q ? searchDirectory(q, 8) : POPULAR.map((s) => searchDirectory(s, 1)[0]).filter(Boolean))
      .filter((t) => !ownSet.has(t.symbol))
      .slice(0, q ? 8 : own.length ? 6 : 10)
      .map((info) => ({ kind: 'dir' as const, info }));
    const dirSet = new Set(dir.map((d) => d.info.symbol));
    const rem = remote.filter((r) => r.kind === 'remote' && !ownSet.has(r.symbol) && !dirSet.has(r.symbol)).slice(0, 5);
    const all: Item[] = [...own, ...dir, ...rem];
    // Always offer to use exactly what was typed (for tickers not in any list).
    const typed = normalizeTicker(q);
    if (/^[A-Z0-9.\-]{1,12}$/.test(typed) && !all.some((it) => (it.kind === 'holding' ? it.asset.ticker : it.kind === 'dir' ? it.info.symbol : it.symbol).toUpperCase() === typed)) {
      all.push({ kind: 'raw', symbol: typed });
    }
    return all;
  }, [q, holdings, remote]);

  const choose = (it: Item) => {
    setOpen(false);
    if (it.kind === 'raw') onEnterRaw(it.symbol);
    else if (it.kind === 'holding') onPick(pickFromAsset(it.asset));
    else if (it.kind === 'dir') onPick(pickFromInfo(it.info));
    else if (it.market === 'US') onPick({ symbol: it.symbol, name: titleCase(it.name), cls: 'EXTERIOR', currency: 'USD', market: 'US' });
    else {
      const info = lookupTicker(it.symbol);
      onPick(info ? pickFromInfo(info) : { symbol: it.symbol, name: it.name, cls: guessClass(it.symbol) ?? 'ACAO', currency: 'BRL', market: 'B3' });
    }
  };

  const showSection = (i: number) => {
    const cur = items[i];
    const prev = items[i - 1];
    if (!prev || prev.kind !== cur.kind) {
      if (cur.kind === 'holding') return t('Na sua carteira', 'In your portfolio');
      if (cur.kind === 'dir') return q ? t('Sugestões', 'Suggestions') : t('Populares', 'Popular');
      if (cur.kind === 'raw') return null;
      return t('Mais resultados', 'More results');
    }
    return null;
  };

  return (
    <div className="field combo">
      <span>{t('Ativo', 'Asset')}</span>
      <div className="search-big">
        <Icon name="search" size={18} />
        <input
          className="input"
          value={value}
          placeholder={t('Digite o ticker ou o nome — PETR4, Take-Two, Bitcoin…', 'Type a ticker or name — PETR4, Take-Two, Bitcoin…')}
          autoFocus={autoFocus}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter' && open && items[active]) { e.preventDefault(); choose(items[active]); }
            if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
          }}
        />
        {searching && <span className="spinner" />}
      </div>
      {open && items.length > 0 && (
        <div className="combo-list big">
          {items.map((it, i) => {
            if (it.kind === 'raw') {
              return (
                <div key="raw" className={'combo-item raw' + (i === active ? ' on' : '')} onMouseDown={() => choose(it)} onMouseEnter={() => setActive(i)}>
                  <span className="avatar" style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--surface-3)', color: 'var(--text-2)' }}><Icon name="plus" size={14} /></span>
                  <span className="ci-text">
                    <b>{t('Usar', 'Use')} “{it.symbol}”</b>
                    <span>{t('Não está na lista? Adicione mesmo assim', 'Not in the list? Add it anyway')}</span>
                  </span>
                </div>
              );
            }
            const section = showSection(i);
            const sym = it.kind === 'holding' ? it.asset.ticker : it.kind === 'dir' ? it.info.symbol : it.symbol;
            const name = it.kind === 'holding' ? it.asset.name ?? CLASS_LABEL[it.asset.cls] : it.kind === 'dir' ? it.info.name : titleCase(it.name);
            const pk = it.kind === 'holding' ? pickFromAsset(it.asset) : it.kind === 'dir' ? pickFromInfo(it.info) : null;
            const logoMarket = pk ? marketOf(pk.cls, pk.currency) : it.kind === 'remote' && it.market === 'US' ? 'US' : 'B3';
            const cls = pk?.cls ?? (it.kind === 'remote' && it.market === 'US' ? 'EXTERIOR' : 'ACAO');
            const tagText = it.kind === 'holding' ? t('na carteira', 'owned') : it.kind === 'dir' ? tag(it.info.kind) : it.market === 'US' ? tag('U') : 'B3';
            return (
              <div key={it.kind + sym}>
                {section && <div className="combo-section">{section}</div>}
                <div className={'combo-item' + (i === active ? ' on' : '')} onMouseDown={() => choose(it)} onMouseEnter={() => setActive(i)}>
                  <Logo symbol={sym} market={logoMarket} cls={cls} size={30} />
                  <span className="ci-text">
                    <b>{highlight(sym, q)}</b>
                    <span>{highlight(name, q)}</span>
                  </span>
                  <span className="chip">{tagText}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const i = fold(text).indexOf(fold(q));
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function titleCase(s: string) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Inc|Corp|Ltd|Co|Sa|Plc|Etf)\b/g, (m) => m.toUpperCase());
}

/** Simple picker among your own holdings (fixed income, proventos, eventos). */
