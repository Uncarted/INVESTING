import { useMemo, useState } from 'react';
import { Drawer, ClassChip, Delta, toast } from './ui';
import { Icon } from './Icon';
import { actions, useData } from '../lib/store';
import type { Asset, AssetClass, FixedKind, Indexer, Settings, Transaction } from '../lib/types';
import { CLASS_LABEL, CLASS_ORDER, FIXED_KIND_LABEL, INDEXER_LABEL, TX_LABEL, isMarketClass } from '../lib/types';
import { computePositions, sortTx, fixedAnnualRate, currencyOf } from '../lib/portfolio';
import { useLive, withLive } from '../lib/live';
import { Flash } from './motion';
import { t as tr } from '../lib/i18n';
import { estimateSaleTax } from '../lib/tax';
import { CURRENCY_SYMBOL } from '../lib/types';
import { fmtCurrency, fmtDate, money, numStr, parseNumber, percent, qty, signedPercent, today } from '../lib/format';
import type { FormInit } from './TransactionForm';
import { AssetChart } from './AssetChart';

export function AssetDrawer({ assetId, onClose, onAdd }: { assetId: string; onClose: () => void; onAdd: (i: FormInit) => void }) {
  const data = useData();
  const live = useLive();
  const stored = data.assets.find((a) => a.id === assetId);
  const asset = useMemo(() => (stored ? withLive([stored], live)[0] : undefined), [stored, live]);
  const settings = useMemo(() => (live.fx ? { ...data.settings, fx: { ...data.settings.fx, ...live.fx } } : data.settings), [data.settings, live.fx]);
  const [editing, setEditing] = useState(false);
  const txs = useMemo(() => sortTx(data.transactions.filter((t) => t.assetId === assetId)).reverse(), [data.transactions, assetId]);
  const pos = useMemo(
    () => (asset ? computePositions([asset], txs, settings, today())[0] : null),
    [asset, txs, settings],
  );
  if (!asset || !pos) return null;
  const market = isMarketClass(asset.cls);
  const result = pos.value - pos.cost;

  return (
    <Drawer onClose={onClose}>
      <div className="modal-head" style={{ paddingTop: 22 }}>
        <div>
          <div className="row">
            <h2 style={{ margin: 0 }}>{asset.ticker}</h2>
            <ClassChip cls={asset.cls} />
          </div>
          <div className="muted small" style={{ marginTop: 2 }}>
            {[asset.name, asset.institution, asset.fixed && `${FIXED_KIND_LABEL[asset.fixed.kind]} · ${fmtRate(asset)}`, asset.fixed?.maturity && `${tr('vence', 'matures')} ${fmtDate(asset.fixed.maturity)}`]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className="spacer" />
        <button className="icon-btn" title={tr('Editar ativo', 'Edit asset')} onClick={() => setEditing((e) => !e)}><Icon name="edit" /></button>
        <button className="icon-btn" onClick={onClose} aria-label={tr('Fechar', 'Close')}><Icon name="x" /></button>
      </div>

      <div className="modal-body stack">
        {editing ? (
          <AssetEditor asset={asset} onDone={() => setEditing(false)} onDeleted={onClose} />
        ) : (
          <>
            {market && asset.cls !== 'CAIXA' && <AssetChart asset={asset} settings={settings} txs={txs} avg={pos.avgPriceNative} cur={pos.currency} quantity={pos.quantity} />}
            <div className="grid grid-2" style={{ gap: 10 }}>
              {market && <Stat label={tr('Quantidade', 'Quantity')} value={qty(pos.quantity)} />}
              {market && <Stat label={tr('Preço médio', 'Average price')} value={<>{fmtCurrency(pos.avgPriceNative, pos.currency)}{pos.currency !== 'BRL' && <small className="muted"> · {money(pos.avgPrice)}</small>}</>} />}
              {market && asset.currentPrice ? (
                <Stat
                  label={tr('Cotação', 'Quote') + (asset.prevClose ? ` · ${tr('hoje', 'today')} ${signedPercent(asset.currentPrice / asset.prevClose - 1)}` : '')}
                  value={<Flash value={asset.currentPrice}>{fmtCurrency(asset.currentPrice, pos.currency, { always: true })}</Flash>}
                />
              ) : null}
              <Stat label={market ? tr('Custo total', 'Total cost') : tr('Valor aplicado', 'Amount invested')} value={money(pos.cost)} />
              <Stat
                label={pos.valueIsEstimate && !market ? tr('Valor estimado', 'Estimated value') : tr('Valor atual', 'Current value')}
                value={<>{money(pos.value)}{pos.currency !== 'BRL' && <small className="muted"> · {fmtCurrency(pos.valueNative, pos.currency)}</small>}</>}
              />
              <Stat
                label={tr('Resultado', 'Return')}
                value={<Delta value={result}>{money(result)} <span className="small">({signedPercent(pos.cost ? result / pos.cost : 0)})</span></Delta>}
              />
              <Stat label={tr('Proventos recebidos', 'Dividends received')} value={money(pos.income)} />
              {pos.realized !== 0 && <Stat label={tr('Lucro/prejuízo realizado', 'Realized gain/loss')} value={<Delta value={pos.realized}>{money(pos.realized)}</Delta>} />}
            </div>
            {market && asset.cls !== 'CAIXA' && pos.quantity > 0 && (
              <div className="sell-row">
                <SellAllHint assetId={asset.id} quantity={pos.quantity} price={asset.currentPrice} settings={settings} />
                <button className="btn sm sell-btn" onClick={() => onAdd({ asset, mode: 'market', side: 'SELL' })}>
                  <Icon name="down" size={14} /> {tr('Vender', 'Sell')}
                </button>
              </div>
            )}
            <PriceEditor asset={asset} />
          </>
        )}

        <div className="row">
          <h3 style={{ margin: 0, fontSize: 15 }}>{tr('Histórico', 'History')}</h3>
          <div className="spacer" />
          <button className="btn sm primary" onClick={() => onAdd({ asset })}><Icon name="plus" size={14} /> {tr('Lançamento', 'Transaction')}</button>
        </div>
        <div className="card" style={{ boxShadow: 'none' }}>
          <table className="table">
            <tbody>
              {txs.map((t) => <TxRow key={t.id} t={t} market={market} onEdit={() => onAdd({ tx: t, asset })} />)}
              {!txs.length && <tr><td className="muted">{tr('Nenhum lançamento.', 'No transactions.')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Drawer>
  );
}

/** "If you sold everything today": profit and estimated income tax, in one quiet line. */
function SellAllHint({ assetId, quantity, price, settings }: { assetId: string; quantity: number; price?: number; settings: Settings }) {
  const data = useData();
  if (!price) return <span className="muted small">{tr('Informe a cotação para ver o IR de uma venda.', 'Add a price to see the tax on a sale.')}</span>;
  const asset = data.assets.find((a) => a.id === assetId);
  const e = estimateSaleTax(data.assets, data.transactions, settings, {
    id: '__sellall', assetId, type: 'SELL', date: today(), quantity, price, fees: 0,
    fxRate: asset && currencyOf(asset) !== 'BRL' ? settings.fx[currencyOf(asset) as 'USD' | 'EUR'] : undefined,
    createdAt: new Date().toISOString(),
  });
  if (!e) return null;
  return (
    <span className="small text-2">
      {tr('Vendendo tudo hoje:', 'Selling everything today:')}{' '}
      <b className={e.gain >= 0 ? 'pos' : 'neg'}>{e.gain >= 0 ? '+' : ''}{money(e.gain)}</b>
      {' · '}
      {e.tax > 0 ? <>{tr('IR', 'tax')} ≈ <b>{money(e.tax)}</b></> : e.gain > 0 ? <span className="pos">{tr('isento', 'tax-free')}</span> : tr('sem IR', 'no tax')}
    </span>
  );
}

function fmtRate(a: Asset) {
  const f = a.fixed!;
  if (f.indexer === 'CDI') return `${qty(f.rate)}% ${tr('do CDI', 'of CDI')}`;
  if (f.indexer === 'PRE') return `${qty(f.rate)}% ${tr('a.a.', 'p.a.')}`;
  return `${f.indexer} + ${qty(f.rate)}%`;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '10px 12px' }}>
      <div className="muted small">{label}</div>
      <div style={{ fontWeight: 650, fontSize: 16, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function TxRow({ t, market, onEdit }: { t: Transaction; market: boolean; onEdit: () => void }) {
  const detail =
    t.type === 'SPLIT'
      ? `${tr('fator', 'factor')} ${qty(t.factor)}`
      : market && (t.type === 'BUY' || t.type === 'SELL' || t.type === 'BONUS')
        ? `${qty(t.quantity)} × ${money(t.price, { always: true })}`
        : '';
  const label = !market && t.type === 'BUY' ? tr('Aplicação', 'Deposit') : !market && t.type === 'SELL' ? (t.closes ? tr('Resgate total', 'Full redemption') : tr('Resgate', 'Redemption')) : TX_LABEL[t.type];
  return (
    <tr>
      <td style={{ width: 96 }} className="text-2">{fmtDate(t.date)}</td>
      <td>
        <div>{label}</div>
        {detail && <div className="muted small">{detail}</div>}
      </td>
      <td className="num">{t.type === 'SPLIT' ? '' : money(t.quantity * t.price + (t.type === 'BUY' ? t.fees : -t.fees))}</td>
      <td style={{ width: 72, whiteSpace: 'nowrap' }}>
        <button className="icon-btn" title={tr('Editar', 'Edit')} onClick={onEdit}><Icon name="edit" size={16} /></button>
        <button
          className="icon-btn"
          title={tr('Excluir', 'Delete')}
          onClick={() => {
            actions.deleteTransactions([t.id]);
            toast(tr('Lançamento excluído', 'Transaction deleted'), { undo: true });
          }}
        >
          <Icon name="trash" size={16} />
        </button>
      </td>
    </tr>
  );
}

function PriceEditor({ asset }: { asset: Asset }) {
  const data = useData();
  const market = isMarketClass(asset.cls);
  const [val, setVal] = useState('');
  if (market) {
    return (
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const v = parseNumber(val);
          if (!(v > 0)) return;
          actions.updateAsset(asset.id, { currentPrice: v, priceUpdatedAt: new Date().toISOString() });
          setVal('');
          toast(tr('Cotação atualizada', 'Quote updated'));
        }}
      >
        <input className="input num" style={{ maxWidth: 160 }} inputMode="decimal" placeholder={`${tr('Preço atual', 'Current price')} (${CURRENCY_SYMBOL[currencyOf(asset)]})`} value={val} onChange={(e) => setVal(e.target.value)} />
        <button className="btn sm">{tr('Atualizar preço', 'Update price')}</button>
        <span className="muted small">{asset.priceUpdatedAt ? `${tr('Atualizado em', 'Updated')} ${fmtDate(asset.priceUpdatedAt.slice(0, 10))}` : asset.currentPrice ? tr('Cotação informada manualmente.', 'Price entered manually.') : tr('Sem cotação — usando o custo.', 'No quote — using cost.')}</span>
      </form>
    );
  }
  const rate = fixedAnnualRate(asset, data.settings);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          const v = parseNumber(val);
          if (!(v >= 0)) return;
          actions.updateAsset(asset.id, { manualValue: v, manualValueDate: today() });
          setVal('');
          toast(tr('Saldo atualizado', 'Balance updated'));
        }}
      >
        <input className="input num" style={{ maxWidth: 170 }} inputMode="decimal" placeholder={tr('Saldo atual no banco', 'Current bank balance')} value={val} onChange={(e) => setVal(e.target.value)} />
        <button className="btn sm">{tr('Informar saldo', 'Set balance')}</button>
        {asset.manualValue !== undefined && (
          <button type="button" className="btn sm ghost" onClick={() => actions.updateAsset(asset.id, { manualValue: undefined, manualValueDate: undefined })}>{tr('Usar estimativa', 'Use estimate')}</button>
        )}
      </form>
      <span className="muted small">
        {asset.manualValue !== undefined
          ? tr(`Saldo informado em ${fmtDate(asset.manualValueDate)}: ${money(asset.manualValue)}${rate ? `, corrigido a ${percent(rate / 100)} a.a. desde então` : ''}.`, `Balance set on ${fmtDate(asset.manualValueDate)}: ${money(asset.manualValue)}${rate ? `, grown at ${percent(rate / 100)} p.a. since then` : ''}.`)
          : rate
            ? tr(`Valor estimado a ${percent(rate / 100)} a.a. (bruto, antes do IR) com as taxas das Configurações. Informe o saldo do app do banco para ficar exato.`, `Estimated at ${percent(rate / 100)} p.a. (gross, before tax) using the rates in Settings. Enter the balance from your bank's app to make it exact.`)
            : tr('Sem taxa definida — mostrando o valor aplicado. Informe o saldo atual.', 'No rate set — showing the amount invested. Enter the current balance.')}
      </span>
    </div>
  );
}

function AssetEditor({ asset, onDone, onDeleted }: { asset: Asset; onDone: () => void; onDeleted: () => void }) {
  const [a, setA] = useState<Asset>(asset);
  const set = <K extends keyof Asset>(k: K, v: Asset[K]) => setA((x) => ({ ...x, [k]: v }));
  const setFixed = (patch: Partial<NonNullable<Asset['fixed']>>) =>
    setA((x) => ({ ...x, fixed: { kind: 'CDB', indexer: 'CDI', rate: 100, ...x.fixed, ...patch } }));
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="form-grid">
        <label className="field"><span>{tr('Código / nome', 'Ticker / name')}</span><input className="input" value={a.ticker} onChange={(e) => set('ticker', e.target.value)} /></label>
        <label className="field">
          <span>{tr('Classe', 'Class')}</span>
          <select className="input" value={a.cls} onChange={(e) => set('cls', e.target.value as AssetClass)}>
            {CLASS_ORDER.map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}
          </select>
        </label>
        <label className="field"><span>{tr('Instituição', 'Institution')}</span><input className="input" list="institutions" value={a.institution ?? ''} onChange={(e) => set('institution', e.target.value || undefined)} /></label>
        {a.cls === 'RENDA_FIXA' && (
          <>
            <label className="field">
              <span>{tr('Tipo', 'Type')}</span>
              <select className="input" value={a.fixed?.kind ?? 'CDB'} onChange={(e) => setFixed({ kind: e.target.value as FixedKind })}>
                {Object.entries(FIXED_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="field">
              <span>{tr('Rentabilidade', 'Yield')}</span>
              <div className="row">
                <select className="input" style={{ width: 130 }} value={a.fixed?.indexer ?? 'CDI'} onChange={(e) => setFixed({ indexer: e.target.value as Indexer })}>
                  {Object.entries(INDEXER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <input className="input num" defaultValue={numStr(a.fixed?.rate)} onChange={(e) => setFixed({ rate: parseNumber(e.target.value) || 0 })} />
              </div>
            </label>
            <label className="field"><span>{tr('Vencimento', 'Maturity')}</span><input className="input" type="date" value={a.fixed?.maturity ?? ''} onChange={(e) => setFixed({ maturity: e.target.value || undefined })} /></label>
            <label className="field"><span>{tr('Emissor', 'Issuer')}</span><input className="input" value={a.fixed?.issuer ?? ''} onChange={(e) => setFixed({ issuer: e.target.value || undefined })} /></label>
          </>
        )}
        <label className="field full"><span>{tr('Anotações', 'Notes')}</span><textarea className="input" rows={2} value={a.notes ?? ''} onChange={(e) => set('notes', e.target.value || undefined)} /></label>
      </div>
      <div className="row">
        <button
          className="btn danger"
          onClick={() => {
            if (!confirm(tr(`Excluir ${asset.ticker} e todos os seus lançamentos?`, `Delete ${asset.ticker} and all its transactions?`))) return;
            actions.deleteAsset(asset.id);
            toast(tr(`${asset.ticker} excluído`, `${asset.ticker} deleted`), { undo: true });
            onDeleted();
          }}
        >
          <Icon name="trash" size={16} /> {tr('Excluir ativo', 'Delete asset')}
        </button>
        <div className="spacer" />
        <button className="btn" onClick={onDone}>{tr('Cancelar', 'Cancel')}</button>
        <button
          className="btn primary"
          onClick={() => {
            actions.updateAsset(asset.id, { ...a, ticker: a.ticker.trim() || asset.ticker });
            toast(tr('Ativo atualizado', 'Asset updated'));
            onDone();
          }}
        >
          {tr('Salvar', 'Save')}
        </button>
      </div>
    </div>
  );
}
