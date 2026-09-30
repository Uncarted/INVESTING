import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, toast } from './ui';
import { Icon } from './Icon';
import { Logo, marketOf } from './Logo';
import { actions, getData, newAsset, useData } from '../lib/store';
import type { Asset, AssetClass, Currency, FixedKind, Indexer, Transaction, TxType } from '../lib/types';
import { CLASS_LABEL, CLASS_ORDER, CURRENCY_LABEL, CURRENCY_SYMBOL, FIXED_KIND_LABEL, INDEXER_LABEL, isMarketClass } from '../lib/types';
import { fxOnDate, searchSymbols, useLive } from '../lib/live';
import { priceOn, twelveSearch, type Market, type PriceResult } from '../lib/prices';
import { lookupTicker, searchDirectory, type TickerInfo } from '../lib/tickers';
import { guessClass, normalizeTicker } from '../lib/classify';
import { fmtCurrency, fmtDate, money, numStr, parseNumber, qty, today, toISODate } from '../lib/format';
import { t } from '../lib/i18n';
import { runMarket, groupTx, currencyOf } from '../lib/portfolio';
import { estimateSaleTax, type SaleTaxEstimate } from '../lib/tax';

type Mode = 'market' | 'fixed' | 'income' | 'event';

const INSTITUTIONS = [
  'XP', 'Rico', 'Clear', 'BTG Pactual', 'Nubank', 'NuInvest', 'Inter', 'Itaú', 'Íon (Itaú)', 'Bradesco', 'Ágora',
  'Santander', 'Banco do Brasil', 'Caixa', 'C6 Bank', 'Genial', 'Modal', 'Toro', 'Órama', 'Avenue', 'Nomad', 'Binance',
  'Mercado Bitcoin', 'Tesouro Direto', 'PicPay', 'Mercado Pago', 'Warren', 'Safra', 'Interactive Brokers', 'Charles Schwab',
];

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
  const [mode, setMode] = useState<Mode>(init?.mode ?? (editing ? modeOf(editing, initAsset) : initAsset && !isMarketClass(initAsset.cls) ? 'fixed' : 'market'));

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
  const [fixedCls, setFixedCls] = useState<AssetClass>(initAsset && !isMarketClass(initAsset.cls) ? initAsset.cls : 'RENDA_FIXA');
  const [kind, setKind] = useState<FixedKind>(initAsset?.fixed?.kind ?? 'CDB');
  const [indexer, setIndexer] = useState<Indexer>(initAsset?.fixed?.indexer ?? 'CDI');
  const [rate, setRate] = useState(str(initAsset?.fixed?.rate) || (initAsset ? '' : '100'));
  const [maturity, setMaturity] = useState(initAsset?.fixed?.maturity ?? '');
  const [issuer, setIssuer] = useState(initAsset?.fixed?.issuer ?? '');
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
    mode === 'fixed' ? 'BRL' : mode === 'market' ? resolved?.currency ?? 'BRL' : incomeAsset ? currencyOf(incomeAsset) : 'BRL';
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
  }, [symbolForPrice, marketForPrice, date, refetch, data.settings.finnhubToken, data.settings.brapiToken, data.settings.twelveDataToken]);

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

  function save(again: boolean) {
    setError('');
    const tk = mode === 'fixed' ? ticker.trim() : mode === 'market' ? pick?.symbol ?? '' : normalizeTicker(ticker);
    if (!tk) return setError(mode === 'fixed' ? t('Dê um nome ao investimento.', 'Give the investment a name.') : t('Escolha o ativo.', 'Choose the asset.'));
    if (!date) return setError(t('Informe a data.', 'Enter the date.'));

    let asset = existing;
    let created: Asset | undefined;
    if (!asset) {
      if (mode === 'income' || mode === 'event') return setError(t('Esse ativo não está na sua carteira. Lance uma compra primeiro.', "This asset isn't in your portfolio. Add a buy first."));
      if (mode === 'fixed' && side === 'SELL') return setError(t('Selecione um investimento existente para resgatar.', 'Pick an existing investment to redeem.'));
      created = newAsset(
        mode === 'fixed'
          ? {
              ticker: tk, cls: fixedCls, institution: institution || undefined,
              fixed: fixedCls === 'RENDA_FIXA' ? { kind, indexer, rate: parseNumber(rate) || 0, maturity: maturity || undefined, issuer: issuer || undefined } : undefined,
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

  const liveNow = resolved ? live.quotes.get(resolved.symbol.toUpperCase()) : undefined;

  return (
    <Modal
      title={editing ? t('Editar lançamento', 'Edit transaction') : t('Novo lançamento', 'New transaction')}
      onClose={onClose}
      footer={
        <>
          {error && <span className="neg small" style={{ marginRight: 'auto', alignSelf: 'center' }}>{error}</span>}
          <button className="btn" onClick={onClose}>{t('Cancelar', 'Cancel')}</button>
          {!editing && <button className="btn" onClick={() => save(true)}>{t('Salvar e adicionar outro', 'Save and add another')}</button>}
          <button className="btn primary" onClick={() => save(false)}>{t('Salvar', 'Save')}</button>
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
            ] as [Mode, string, string, string][]).map(([m, l, d, ic]) => (
              <button type="button" key={m} className={'type-card' + (mode === m ? ' on' : '')} onClick={() => setMode(m)}>
                <Icon name={ic} size={18} />
                <b>{l}</b>
                <span>{d}</span>
              </button>
            ))}
          </div>
        )}

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
            <div className="form-grid">
              <div className="full">
                <HoldingCombo
                  label={t('Investimento', 'Investment')}
                  placeholder={t('Ex.: CDB Banco Inter 2027', 'E.g. CDB Banco Inter 2027')}
                  value={ticker}
                  onChange={setTicker}
                  holdings={holdingsFor('fixed')}
                  autoFocus={!initAsset}
                />
              </div>
              {!existing && side === 'BUY' && ticker && (
                <>
                  <label className="field">
                    <span>{t('Categoria', 'Category')}</span>
                    <select className="input" value={fixedCls} onChange={(e) => setFixedCls(e.target.value as AssetClass)}>
                      <option value="RENDA_FIXA">{t('Renda fixa', 'Fixed income')}</option>
                      <option value="FUNDO">{t('Fundo de investimento', 'Investment fund')}</option>
                      <option value="OUTRO">{t('Outro', 'Other')}</option>
                    </select>
                  </label>
                  {fixedCls === 'RENDA_FIXA' ? (
                    <>
                      <label className="field">
                        <span>{t('Tipo', 'Type')}</span>
                        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as FixedKind)}>
                          {Object.entries(FIXED_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </label>
                      <label className="field">
                        <span>{t('Rentabilidade', 'Yield')}</span>
                        <div className="row">
                          <select className="input" style={{ width: 140 }} value={indexer} onChange={(e) => setIndexer(e.target.value as Indexer)}>
                            {Object.entries(INDEXER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                          </select>
                          <input className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                          <span className="muted">{indexer === 'CDI' ? '%' : t('% a.a.', '% p.a.')}</span>
                        </div>
                      </label>
                      <label className="field">
                        <span>{t('Vencimento', 'Maturity')}</span>
                        <input className="input" type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} />
                      </label>
                      <label className="field">
                        <span>{t('Emissor (banco)', 'Issuer (bank)')}</span>
                        <input className="input" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Banco Inter" />
                      </label>
                    </>
                  ) : <div />}
                </>
              )}
              <label className="field">
                <span>{t('Data', 'Date')}</span>
                <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <InstitutionField value={institution} onChange={setInstitution} options={institutions} />
              <label className="field">
                <span>{side === 'BUY' ? t('Valor aplicado', 'Amount invested') : t('Valor resgatado (bruto)', 'Amount redeemed (gross)')}</span>
                <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('0,00', '0.00')} />
              </label>
              {side === 'SELL' && (
                <label className="field" style={{ justifyContent: 'flex-end' }}>
                  <span className="row"><input type="checkbox" checked={closes} onChange={(e) => setCloses(e.target.checked)} /> {t('Resgate total (encerra o investimento)', 'Full redemption (closes the investment)')}</span>
                </label>
              )}
            </div>
          </>
        )}

        {mode === 'income' && (
          <div className="form-grid">
            <div className="full">
              <HoldingCombo label={t('Ativo que pagou', 'Paying asset')} placeholder={t('Ex.: ITSA4, HGLG11', 'E.g. ITSA4, HGLG11')} value={ticker} onChange={setTicker} holdings={holdingsFor('market')} autoFocus={!initAsset} />
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
              <HoldingCombo label={t('Ativo', 'Asset')} placeholder={t('Ex.: WEGE3', 'E.g. WEGE3')} value={ticker} onChange={setTicker} holdings={holdingsFor('market')} autoFocus={!initAsset} />
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

function InstitutionField({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <label className="field">
      <span>{t('Corretora / banco', 'Broker / bank')}</span>
      <input className="input" list="institutions" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('XP, Nubank, Avenue…', 'XP, Nubank, Avenue…')} />
      <datalist id="institutions">{options.map((o) => <option key={o} value={o} />)}</datalist>
    </label>
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
function HoldingCombo({
  label, value, onChange, holdings, placeholder, autoFocus,
}: { label: string; value: string; onChange: (v: string) => void; holdings: Asset[]; placeholder: string; autoFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const fq = value.trim().toUpperCase();
  const list = holdings.filter((a) => !fq || a.ticker.toUpperCase().includes(fq) || (a.name ?? '').toUpperCase().includes(fq)).slice(0, 8);
  const exact = holdings.some((a) => a.ticker.toUpperCase() === fq);
  const show = open && list.length > 0 && !exact;
  return (
    <label className="field combo">
      <span>{label}</span>
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); onChange(list[active].ticker); setOpen(false); }
        }}
      />
      {show && (
        <div className="combo-list">
          {list.map((a, i) => (
            <div key={a.id} className={'combo-item' + (i === active ? ' on' : '')} onMouseDown={() => { onChange(a.ticker); setOpen(false); }}>
              <Logo symbol={a.ticker} market={marketOf(a.cls, currencyOf(a))} cls={a.cls} size={26} />
              <span className="ci-text">
                <b>{a.ticker}</b>
                <span>{a.name ?? CLASS_LABEL[a.cls]}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </label>
  );
}
