import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, toast } from './ui';
import { Icon } from './Icon';
import { actions, getData, newAsset, useData } from '../lib/store';
import type { Asset, AssetClass, Currency, FixedKind, Indexer, Transaction, TxType } from '../lib/types';
import { CURRENCY_LABEL, CURRENCY_SYMBOL } from '../lib/types';
import { fxOnDate, searchSymbols, type SymbolHit } from '../lib/live';
import { CLASS_LABEL, CLASS_ORDER, FIXED_KIND_LABEL, INDEXER_LABEL, isMarketClass } from '../lib/types';
import { guessClass, normalizeTicker } from '../lib/classify';
import { fmtCurrency, money, parseNumber, qty, today } from '../lib/format';
import { runMarket, groupTx, currencyOf } from '../lib/portfolio';

type Mode = 'market' | 'fixed' | 'income' | 'event';

const INSTITUTIONS = [
  'XP', 'Rico', 'Clear', 'BTG Pactual', 'Nubank', 'NuInvest', 'Inter', 'Itaú', 'Íon (Itaú)', 'Bradesco', 'Ágora',
  'Santander', 'Banco do Brasil', 'Caixa', 'C6 Bank', 'Genial', 'Modal', 'Toro', 'Órama', 'Avenue', 'Binance',
  'Mercado Bitcoin', 'Tesouro Direto', 'PicPay', 'Mercado Pago', 'Warren', 'Safra',
];

export interface FormInit {
  mode?: Mode;
  asset?: Asset;
  tx?: Transaction;
}

function modeOf(tx: Transaction, asset?: Asset): Mode {
  if (tx.type === 'DIVIDEND' || tx.type === 'JCP' || tx.type === 'INCOME') return 'income';
  if (tx.type === 'SPLIT' || tx.type === 'BONUS') return 'event';
  return asset && !isMarketClass(asset.cls) ? 'fixed' : 'market';
}

const str = (n?: number) => (n === undefined || n === 0 ? '' : String(n).replace('.', ','));

export function TransactionForm({ init, onClose }: { init?: FormInit; onClose: () => void }) {
  const data = useData();
  const editing = init?.tx;
  const initAsset = init?.asset ?? (editing ? data.assets.find((a) => a.id === editing.assetId) : undefined);
  const [mode, setMode] = useState<Mode>(init?.mode ?? (editing ? modeOf(editing, initAsset) : initAsset && !isMarketClass(initAsset.cls) ? 'fixed' : 'market'));

  // shared
  const [ticker, setTicker] = useState(initAsset?.ticker ?? '');
  const [cls, setCls] = useState<AssetClass | ''>(initAsset?.cls ?? '');
  const [name, setName] = useState('');
  const [date, setDate] = useState(editing?.date ?? today());
  const [institution, setInstitution] = useState(editing?.institution ?? initAsset?.institution ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  // market
  const [side, setSide] = useState<'BUY' | 'SELL'>(editing?.type === 'SELL' ? 'SELL' : 'BUY');
  const [quantity, setQuantity] = useState(editing && mode !== 'fixed' ? str(editing.quantity) : '');
  const [price, setPrice] = useState(editing ? str(editing.price) : '');
  const [fees, setFees] = useState(editing ? str(editing.fees) : '');
  // fixed
  const [amount, setAmount] = useState(editing ? str(editing.quantity * editing.price) : '');
  const [closes, setCloses] = useState(!!editing?.closes);
  const [fixedCls, setFixedCls] = useState<AssetClass>(initAsset && !isMarketClass(initAsset.cls) ? initAsset.cls : 'RENDA_FIXA');
  const [kind, setKind] = useState<FixedKind>(initAsset?.fixed?.kind ?? 'CDB');
  const [indexer, setIndexer] = useState<Indexer>(initAsset?.fixed?.indexer ?? 'CDI');
  const [rate, setRate] = useState(str(initAsset?.fixed?.rate) || (initAsset ? '' : '100'));
  const [maturity, setMaturity] = useState(initAsset?.fixed?.maturity ?? '');
  const [issuer, setIssuer] = useState(initAsset?.fixed?.issuer ?? '');
  // income
  const [incomeType, setIncomeType] = useState<TxType>(editing && ['DIVIDEND', 'JCP', 'INCOME'].includes(editing.type) ? editing.type : 'DIVIDEND');
  // event
  const [eventType, setEventType] = useState<'SPLIT' | 'GROUP' | 'BONUS'>(
    editing?.type === 'BONUS' ? 'BONUS' : editing?.factor && editing.factor < 1 ? 'GROUP' : 'SPLIT',
  );
  const [ratioFrom, setRatioFrom] = useState(editing?.factor && editing.factor < 1 ? String(Math.round(1 / editing.factor)) : '1');
  const [ratioTo, setRatioTo] = useState(editing?.factor && editing.factor >= 1 ? String(editing.factor) : '1');

  const [error, setError] = useState('');
  // foreign currency
  const [currencyPick, setCurrencyPick] = useState<Currency | ''>(initAsset?.currency ?? '');
  const [fxRate, setFxRate] = useState(editing?.fxRate ? str(editing.fxRate) : '');
  const fxTouched = useRef(!!editing?.fxRate);
  const [hits, setHits] = useState<SymbolHit[]>([]);

  const existing = useMemo(() => {
    const t = ticker.trim().toUpperCase();
    return data.assets.find((a) => a.ticker.toUpperCase() === t || a.ticker.toUpperCase() === normalizeTicker(t));
  }, [ticker, data.assets]);

  const guessed = guessClass(ticker);
  const effectiveCls: AssetClass = existing?.cls ?? (cls || guessed || 'ACAO');
  const currency: Currency = existing
    ? currencyOf(existing)
    : mode !== 'market'
      ? 'BRL'
      : currencyPick || (effectiveCls === 'EXTERIOR' ? 'USD' : 'BRL');
  const foreign = currency !== 'BRL';
  const sym = CURRENCY_SYMBOL[currency];

  // Fetch the exchange rate for the trade date (unless typed by hand).
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

  // Search any stock (US via Finnhub, B3 via brapi) as you type.
  useEffect(() => {
    if (mode !== 'market' || existing || ticker.trim().length < 2) return setHits([]);
    const id = setTimeout(() => searchSymbols(ticker, data.settings).then(setHits), 300);
    return () => clearTimeout(id);
  }, [ticker, mode, existing, data.settings]);

  const held = useMemo(() => {
    if (!existing || !isMarketClass(existing.cls)) return null;
    const txs = (groupTx(data.transactions).get(existing.id) ?? []).filter((t) => t.id !== editing?.id);
    const st = runMarket(existing, txs, date, data.settings);
    return { quantity: st.quantity, avg: st.quantity ? st.costNative / st.quantity : 0 };
  }, [existing, data.transactions, date, editing?.id, data.settings]);
  const fx = foreign ? parseNumber(fxRate) : 1;

  const q = parseNumber(quantity);
  const p = parseNumber(price);
  const f = parseNumber(fees) || 0;
  const total = Number.isFinite(q) && Number.isFinite(p) ? q * p + (side === 'BUY' ? f : -f) : NaN;

  const suggestions = useMemo(() => {
    const t = ticker.trim().toUpperCase();
    const pool = data.assets.filter((a) =>
      mode === 'fixed' ? !isMarketClass(a.cls) : mode === 'market' ? isMarketClass(a.cls) : true,
    );
    if (!t) return pool.slice(0, 8);
    return pool.filter((a) => a.ticker.toUpperCase().includes(t) || a.name?.toUpperCase().includes(t)).slice(0, 8);
  }, [ticker, data.assets, mode]);

  function save(again: boolean) {
    setError('');
    const tk = mode === 'fixed' ? ticker.trim() : normalizeTicker(ticker);
    if (!tk) return setError(mode === 'fixed' ? 'Dê um nome ao investimento.' : 'Informe o ativo.');
    if (!date) return setError('Informe a data.');

    let asset = existing;
    let created: Asset | undefined;
    if (!asset) {
      if (mode === 'income' || mode === 'event') return setError('Ativo não encontrado. Cadastre uma compra primeiro.');
      if (mode === 'fixed' && side === 'SELL') return setError('Selecione um investimento existente para resgatar.');
      created = newAsset(
        mode === 'fixed'
          ? {
              ticker: tk, cls: fixedCls, institution: institution || undefined,
              fixed: fixedCls === 'RENDA_FIXA' ? { kind, indexer, rate: parseNumber(rate) || 0, maturity: maturity || undefined, issuer: issuer || undefined } : undefined,
            }
          : { ticker: tk, name: name || undefined, cls: effectiveCls, currency: currency !== 'BRL' ? currency : undefined, institution: institution || undefined },
      );
      asset = created;
    }

    let tx: Omit<Transaction, 'id' | 'createdAt'>;
    if (foreign && (mode === 'market' || mode === 'income') && !(fx > 0)) return setError('Informe a cotação da moeda no dia.');
    const fxPart = foreign && (mode === 'market' || mode === 'income') ? { fxRate: fx } : {};
    const base = { ...fxPart, assetId: asset.id, date, institution: institution || undefined, notes: notes || undefined, source: editing?.source ?? ('manual' as const), importKey: editing?.importKey };
    if (mode === 'market') {
      if (!(q > 0)) return setError('Quantidade inválida.');
      if (!(p >= 0) || !Number.isFinite(p)) return setError('Preço inválido.');
      if (side === 'SELL' && held && q > held.quantity + 1e-9)
        return setError(`Você tem ${qty(held.quantity)} em ${date.split('-').reverse().join('/')}. Falta lançar alguma compra?`);
      tx = { ...base, type: side, quantity: q, price: p, fees: f };
    } else if (mode === 'fixed') {
      const a = parseNumber(amount);
      if (!(a > 0)) return setError('Informe o valor.');
      tx = { ...base, type: side, quantity: 1, price: a, fees: 0, closes: side === 'SELL' ? closes : undefined };
    } else if (mode === 'income') {
      const a = parseNumber(amount);
      if (!(a > 0)) return setError('Informe o valor recebido.');
      tx = { ...base, type: incomeType, quantity: 1, price: a, fees: 0 };
    } else {
      if (eventType === 'BONUS') {
        if (!(q > 0)) return setError('Informe a quantidade recebida.');
        tx = { ...base, type: 'BONUS', quantity: q, price: Number.isFinite(p) ? p : 0, fees: 0 };
      } else {
        const from = parseNumber(ratioFrom);
        const to = parseNumber(ratioTo);
        if (!(from > 0 && to > 0) || from === to) return setError('Proporção inválida.');
        tx = { ...base, type: 'SPLIT', quantity: 0, price: 0, fees: 0, factor: to / from };
      }
    }

    if (editing) {
      actions.updateTransaction(editing.id, tx);
      toast('Lançamento atualizado');
    } else {
      actions.addTransactions([tx], created ? [created] : []);
      toast(created ? `${tk} adicionado à carteira` : 'Lançamento salvo');
    }
    if (again) {
      setTicker('');
      setQuantity('');
      setPrice('');
      setFees('');
      setAmount('');
      setNotes('');
      setName('');
      setCurrencyPick('');
      fxTouched.current = false;
    } else onClose();
  }

  const institutions = useMemo(
    () => [...new Set([...getData().assets.map((a) => a.institution).filter(Boolean), ...INSTITUTIONS])] as string[],
    [],
  );

  const assetField = (
    <AssetCombo
      label={mode === 'fixed' ? 'Investimento' : 'Ativo'}
      placeholder={mode === 'fixed' ? 'Ex.: CDB Banco Inter 2027' : 'Ticker ou nome — PETR4, AMD, TTWO, BTC…'}
      value={ticker}
      onChange={setTicker}
      suggestions={suggestions}
      hits={hits}
      onPickHit={(h) => {
        setTicker(h.symbol);
        setHits([]);
        if (h.market === 'US') {
          setCls('EXTERIOR');
          setCurrencyPick('USD');
          setName(h.description ? titleCase(h.description) : '');
        }
      }}
      autoFocus={!initAsset}
    />
  );

  return (
    <Modal
      title={editing ? 'Editar lançamento' : 'Novo lançamento'}
      onClose={onClose}
      footer={
        <>
          {error && <span className="neg small" style={{ marginRight: 'auto', alignSelf: 'center' }}>{error}</span>}
          <button className="btn" onClick={onClose}>Cancelar</button>
          {!editing && <button className="btn" onClick={() => save(true)}>Salvar e adicionar outro</button>}
          <button className="btn primary" onClick={() => save(false)}>Salvar</button>
        </>
      }
    >
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(false); }}>
        {!editing && (
          <div className="type-grid" role="tablist">
            {([
              ['market', 'Bolsa', 'Ações, FIIs, ETFs, cripto', 'chart'],
              ['fixed', 'Renda fixa', 'CDB, LCI, Tesouro, fundos', 'wallet'],
              ['income', 'Provento', 'Dividendo, JCP, rendimento', 'coins'],
              ['event', 'Evento', 'Desdobro, bonificação', 'refresh'],
            ] as [Mode, string, string, string][]).map(([m, l, d, ic]) => (
              <button type="button" key={m} className={'type-card' + (mode === m ? ' on' : '')} onClick={() => setMode(m)}>
                <Icon name={ic} size={18} />
                <b>{l}</b>
                <span>{d}</span>
              </button>
            ))}
          </div>
        )}

        {(mode === 'market' || mode === 'fixed') && (
          <div className="seg">
            <button type="button" className={side === 'BUY' ? 'on' : ''} onClick={() => setSide('BUY')}>{mode === 'fixed' ? 'Aplicação' : 'Compra'}</button>
            <button type="button" className={side === 'SELL' ? 'on' : ''} onClick={() => setSide('SELL')}>{mode === 'fixed' ? 'Resgate' : 'Venda'}</button>
          </div>
        )}

        {mode === 'market' && (
          <div className="form-grid">
            <div className="full">{assetField}</div>
            {ticker && !existing && (
              <>
                <label className="field">
                  <span>Classe</span>
                  <select className="input" value={cls || guessed || 'ACAO'} onChange={(e) => setCls(e.target.value as AssetClass)}>
                    {CLASS_ORDER.filter(isMarketClass).map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}
                  </select>
                  <span className="hint">Ativo novo — classe detectada automaticamente.</span>
                </label>
                <label className="field">
                  <span>Moeda</span>
                  <select className="input" value={currency} onChange={(e) => { setCurrencyPick(e.target.value as Currency); fxTouched.current = false; }}>
                    {(Object.keys(CURRENCY_LABEL) as Currency[]).map((c) => <option key={c} value={c}>{CURRENCY_SYMBOL[c]} · {CURRENCY_LABEL[c]}</option>)}
                  </select>
                </label>
                <label className="field full">
                  <span>Nome (opcional)</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Petrobras PN" />
                </label>
              </>
            )}
            <label className="field">
              <span>Data</span>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <InstitutionField value={institution} onChange={setInstitution} options={institutions} />
            <label className="field">
              <span>Quantidade</span>
              <input className="input num" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="100" />
              {side === 'SELL' && held && <span className="hint">Em carteira: {qty(held.quantity)} · PM {fmtCurrency(held.avg, currency, { always: true })}</span>}
            </label>
            <label className="field">
              <span>Preço unitário ({sym})</span>
              <input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" />
            </label>
            <label className="field">
              <span>Taxas e custos ({sym})</span>
              <input className="input num" inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} placeholder="0,00" />
              <span className="hint">Corretagem, emolumentos. Entram no preço médio.</span>
            </label>
            {foreign && (
              <label className="field">
                <span>Cotação do {CURRENCY_LABEL[currency].toLowerCase()} no dia (R$)</span>
                <input className="input num" inputMode="decimal" value={fxRate} onChange={(e) => { fxTouched.current = true; setFxRate(e.target.value); }} />
                <span className="hint">Preenchida automaticamente pela data. Usada no custo em reais e no IR.</span>
              </label>
            )}
            <div className="field">
              <span>Total</span>
              <div style={{ fontSize: 20, fontWeight: 650, paddingTop: 4 }}>{Number.isFinite(total) ? fmtCurrency(total, currency, { always: true }) : '—'}</div>
              {foreign && Number.isFinite(total) && fx > 0 && <span className="hint">≈ {money(total * fx, { always: true })}</span>}
              {side === 'SELL' && held && Number.isFinite(total) && q > 0 && (
                <span className="hint">
                  Resultado estimado:{' '}
                  <b className={total - held.avg * q >= 0 ? 'pos' : 'neg'}>{fmtCurrency(total - held.avg * q, currency, { always: true })}</b>
                </span>
              )}
            </div>
          </div>
        )}

        {mode === 'fixed' && (
          <div className="form-grid">
            <div className="full">{assetField}</div>
            {!existing && side === 'BUY' && ticker && (
              <>
                <label className="field">
                  <span>Categoria</span>
                  <select className="input" value={fixedCls} onChange={(e) => setFixedCls(e.target.value as AssetClass)}>
                    <option value="RENDA_FIXA">Renda fixa</option>
                    <option value="FUNDO">Fundo de investimento</option>
                    <option value="OUTRO">Outro</option>
                  </select>
                </label>
                {fixedCls === 'RENDA_FIXA' ? (
                  <>
                    <label className="field">
                      <span>Tipo</span>
                      <select className="input" value={kind} onChange={(e) => setKind(e.target.value as FixedKind)}>
                        {Object.entries(FIXED_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </label>
                    <label className="field">
                      <span>Rentabilidade</span>
                      <div className="row">
                        <select className="input" style={{ width: 140 }} value={indexer} onChange={(e) => setIndexer(e.target.value as Indexer)}>
                          {Object.entries(INDEXER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                        <input className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                        <span className="muted">{indexer === 'CDI' ? '%' : '% a.a.'}</span>
                      </div>
                    </label>
                    <label className="field">
                      <span>Vencimento</span>
                      <input className="input" type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} />
                    </label>
                    <label className="field">
                      <span>Emissor (banco)</span>
                      <input className="input" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Banco Inter" />
                    </label>
                  </>
                ) : <div />}
              </>
            )}
            <label className="field">
              <span>Data</span>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <InstitutionField value={institution} onChange={setInstitution} options={institutions} />
            <label className="field">
              <span>{side === 'BUY' ? 'Valor aplicado' : 'Valor resgatado (bruto)'}</span>
              <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" />
            </label>
            {side === 'SELL' && (
              <label className="field" style={{ justifyContent: 'flex-end' }}>
                <span className="row"><input type="checkbox" checked={closes} onChange={(e) => setCloses(e.target.checked)} /> Resgate total (encerra o investimento)</span>
              </label>
            )}
          </div>
        )}

        {mode === 'income' && (
          <div className="form-grid">
            <div className="full">{assetField}</div>
            <label className="field">
              <span>Tipo</span>
              <select className="input" value={incomeType} onChange={(e) => setIncomeType(e.target.value as TxType)}>
                <option value="DIVIDEND">Dividendo (isento)</option>
                <option value="JCP">Juros sobre capital próprio (JCP)</option>
                <option value="INCOME">Rendimento (FII, juros, cupom)</option>
              </select>
            </label>
            <label className="field">
              <span>Data do pagamento</span>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="field">
              <span>Valor líquido recebido ({sym})</span>
              <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" />
            </label>
            <InstitutionField value={institution} onChange={setInstitution} options={institutions} />
          </div>
        )}

        {mode === 'event' && (
          <div className="form-grid">
            <div className="full">{assetField}</div>
            <label className="field">
              <span>Evento</span>
              <select className="input" value={eventType} onChange={(e) => setEventType(e.target.value as typeof eventType)}>
                <option value="SPLIT">Desdobramento (split)</option>
                <option value="GROUP">Grupamento (inplit)</option>
                <option value="BONUS">Bonificação em ações</option>
              </select>
            </label>
            <label className="field">
              <span>Data</span>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            {eventType === 'BONUS' ? (
              <>
                <label className="field">
                  <span>Quantidade recebida</span>
                  <input className="input num" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                </label>
                <label className="field">
                  <span>Custo unitário atribuído</span>
                  <input className="input num" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" />
                  <span className="hint">Informado pela empresa no fato relevante. Entra no preço médio.</span>
                </label>
              </>
            ) : (
              <label className="field full">
                <span>Proporção</span>
                <div className="row">
                  <input className="input num" style={{ width: 90 }} value={ratioFrom} onChange={(e) => setRatioFrom(e.target.value)} />
                  <span className="muted">{eventType === 'SPLIT' ? 'ação vira' : 'ações viram'}</span>
                  <input className="input num" style={{ width: 90 }} value={ratioTo} onChange={(e) => setRatioTo(e.target.value)} />
                  {held && <span className="muted small">Hoje: {qty(held.quantity)} → {qty((held.quantity * (parseNumber(ratioTo) || 1)) / (parseNumber(ratioFrom) || 1))}</span>}
                </div>
              </label>
            )}
          </div>
        )}

        <label className="field">
          <span>Observação (opcional)</span>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function InstitutionField({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <label className="field">
      <span>Instituição / corretora</span>
      <input className="input" list="institutions" value={value} onChange={(e) => onChange(e.target.value)} placeholder="XP, Nubank…" />
      <datalist id="institutions">{options.map((o) => <option key={o} value={o} />)}</datalist>
    </label>
  );
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Inc|Corp|Ltd|Co|Sa|Plc)\b/g, (m) => m.toUpperCase());
}

function AssetCombo({
  label, value, onChange, suggestions, placeholder, autoFocus, hits = [], onPickHit,
}: {
  label: string; value: string; onChange: (v: string) => void; suggestions: Asset[]; placeholder: string; autoFocus?: boolean;
  hits?: SymbolHit[]; onPickHit?: (h: SymbolHit) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const own = new Set(suggestions.map((s) => s.ticker.toUpperCase()));
  const remote = hits.filter((h) => !own.has(h.symbol.toUpperCase()));
  type Item = { kind: 'own'; a: Asset } | { kind: 'hit'; h: SymbolHit };
  const items: Item[] = [...suggestions.map((a) => ({ kind: 'own' as const, a })), ...remote.map((h) => ({ kind: 'hit' as const, h }))];
  const exact = suggestions.some((s) => s.ticker.toUpperCase() === value.trim().toUpperCase());
  const show = open && items.length > 0 && !exact;
  const pick = (it: Item) => {
    if (it.kind === 'own') onChange(it.a.ticker);
    else onPickHit?.(it.h);
    setOpen(false);
  };
  return (
    <label className="field combo">
      <span>{label}</span>
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => value && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) { setOpen(true); return; }
          if (!show) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); pick(items[active]); }
        }}
      />
      {show && (
        <div className="combo-list">
          {items.map((it, i) =>
            it.kind === 'own' ? (
              <div key={it.a.id} className={'combo-item' + (i === active ? ' on' : '')} onMouseDown={() => pick(it)}>
                <span className="dot" style={{ background: `var(--c-${it.a.cls})` }} />
                <b>{it.a.ticker}</b>
                <span className="muted small">{it.a.name ?? CLASS_LABEL[it.a.cls]}</span>
                <span className="spacer" />
                <span className="chip">na carteira</span>
              </div>
            ) : (
              <div key={it.h.market + it.h.symbol} className={'combo-item' + (i === active ? ' on' : '')} onMouseDown={() => pick(it)}>
                <span className="dot" style={{ background: it.h.market === 'US' ? 'var(--c-EXTERIOR)' : 'var(--c-ACAO)' }} />
                <b>{it.h.symbol}</b>
                <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.h.market === 'US' ? titleCase(it.h.description) : it.h.description}</span>
                <span className="spacer" />
                <span className="chip">{it.h.market === 'US' ? 'EUA · US$' : 'B3 · R$'}</span>
              </div>
            ),
          )}
        </div>
      )}
      {value && !exact && open && !show && (
        <span className="hint"><Icon name="plus" size={12} /> Novo ativo</span>
      )}
    </label>
  );
}
