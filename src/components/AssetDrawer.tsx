import { useMemo, useState } from 'react';
import { Drawer, ClassChip, Delta, toast } from './ui';
import { Icon } from './Icon';
import { actions, useData } from '../lib/store';
import type { Asset, AssetClass, FixedKind, Indexer, Transaction } from '../lib/types';
import { CLASS_LABEL, CLASS_ORDER, FIXED_KIND_LABEL, INDEXER_LABEL, TX_LABEL, isMarketClass } from '../lib/types';
import { computePositions, sortTx, fixedAnnualRate, currencyOf } from '../lib/portfolio';
import { useLive, withLive } from '../lib/live';
import { Flash } from './motion';
import { CURRENCY_SYMBOL } from '../lib/types';
import { fmtCurrency, fmtDate, money, parseNumber, percent, qty, signedPercent, today } from '../lib/format';
import type { FormInit } from './TransactionForm';

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
            {[asset.name, asset.institution, asset.fixed && `${FIXED_KIND_LABEL[asset.fixed.kind]} · ${fmtRate(asset)}`, asset.fixed?.maturity && `vence ${fmtDate(asset.fixed.maturity)}`]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className="spacer" />
        <button className="icon-btn" title="Editar ativo" onClick={() => setEditing((e) => !e)}><Icon name="edit" /></button>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar"><Icon name="x" /></button>
      </div>

      <div className="modal-body stack">
        {editing ? (
          <AssetEditor asset={asset} onDone={() => setEditing(false)} onDeleted={onClose} />
        ) : (
          <>
            <div className="grid grid-2" style={{ gap: 10 }}>
              {market && <Stat label="Quantidade" value={qty(pos.quantity)} />}
              {market && <Stat label="Preço médio" value={<>{fmtCurrency(pos.avgPriceNative, pos.currency)}{pos.currency !== 'BRL' && <small className="muted"> · {money(pos.avgPrice)}</small>}</>} />}
              {market && asset.currentPrice ? (
                <Stat
                  label={'Cotação' + (asset.prevClose ? ` · hoje ${signedPercent(asset.currentPrice / asset.prevClose - 1)}` : '')}
                  value={<Flash value={asset.currentPrice}>{fmtCurrency(asset.currentPrice, pos.currency, { always: true })}</Flash>}
                />
              ) : null}
              <Stat label={market ? 'Custo total' : 'Valor aplicado'} value={money(pos.cost)} />
              <Stat
                label={pos.valueIsEstimate && !market ? 'Valor estimado' : 'Valor atual'}
                value={<>{money(pos.value)}{pos.currency !== 'BRL' && <small className="muted"> · {fmtCurrency(pos.valueNative, pos.currency)}</small>}</>}
              />
              <Stat
                label="Resultado"
                value={<Delta value={result}>{money(result)} <span className="small">({signedPercent(pos.cost ? result / pos.cost : 0)})</span></Delta>}
              />
              <Stat label="Proventos recebidos" value={money(pos.income)} />
              {pos.realized !== 0 && <Stat label="Lucro/prejuízo realizado" value={<Delta value={pos.realized}>{money(pos.realized)}</Delta>} />}
            </div>
            <PriceEditor asset={asset} />
          </>
        )}

        <div className="row">
          <h3 style={{ margin: 0, fontSize: 15 }}>Histórico</h3>
          <div className="spacer" />
          <button className="btn sm primary" onClick={() => onAdd({ asset })}><Icon name="plus" size={14} /> Lançamento</button>
        </div>
        <div className="card" style={{ boxShadow: 'none' }}>
          <table className="table">
            <tbody>
              {txs.map((t) => <TxRow key={t.id} t={t} market={market} onEdit={() => onAdd({ tx: t, asset })} />)}
              {!txs.length && <tr><td className="muted">Nenhum lançamento.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Drawer>
  );
}

function fmtRate(a: Asset) {
  const f = a.fixed!;
  if (f.indexer === 'CDI') return `${qty(f.rate)}% do CDI`;
  if (f.indexer === 'PRE') return `${qty(f.rate)}% a.a.`;
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
      ? `fator ${qty(t.factor)}`
      : market && (t.type === 'BUY' || t.type === 'SELL' || t.type === 'BONUS')
        ? `${qty(t.quantity)} × ${money(t.price, { always: true })}`
        : '';
  const label = !market && t.type === 'BUY' ? 'Aplicação' : !market && t.type === 'SELL' ? (t.closes ? 'Resgate total' : 'Resgate') : TX_LABEL[t.type];
  return (
    <tr>
      <td style={{ width: 96 }} className="text-2">{fmtDate(t.date)}</td>
      <td>
        <div>{label}</div>
        {detail && <div className="muted small">{detail}</div>}
      </td>
      <td className="num">{t.type === 'SPLIT' ? '' : money(t.quantity * t.price + (t.type === 'BUY' ? t.fees : -t.fees))}</td>
      <td style={{ width: 72, whiteSpace: 'nowrap' }}>
        <button className="icon-btn" title="Editar" onClick={onEdit}><Icon name="edit" size={16} /></button>
        <button
          className="icon-btn"
          title="Excluir"
          onClick={() => {
            actions.deleteTransactions([t.id]);
            toast('Lançamento excluído', { undo: true });
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
          toast('Cotação atualizada');
        }}
      >
        <input className="input num" style={{ maxWidth: 160 }} inputMode="decimal" placeholder={`Preço atual (${CURRENCY_SYMBOL[currencyOf(asset)]})`} value={val} onChange={(e) => setVal(e.target.value)} />
        <button className="btn sm">Atualizar preço</button>
        <span className="muted small">{asset.priceUpdatedAt ? `Atualizado em ${fmtDate(asset.priceUpdatedAt.slice(0, 10))}` : asset.currentPrice ? 'Cotação informada manualmente.' : 'Sem cotação — usando o custo.'}</span>
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
          toast('Saldo atualizado');
        }}
      >
        <input className="input num" style={{ maxWidth: 170 }} inputMode="decimal" placeholder="Saldo atual no banco" value={val} onChange={(e) => setVal(e.target.value)} />
        <button className="btn sm">Informar saldo</button>
        {asset.manualValue !== undefined && (
          <button type="button" className="btn sm ghost" onClick={() => actions.updateAsset(asset.id, { manualValue: undefined, manualValueDate: undefined })}>Usar estimativa</button>
        )}
      </form>
      <span className="muted small">
        {asset.manualValue !== undefined
          ? `Saldo informado em ${fmtDate(asset.manualValueDate)}: ${money(asset.manualValue)}${rate ? `, corrigido a ${percent(rate / 100)} a.a. desde então` : ''}.`
          : rate
            ? `Valor estimado a ${percent(rate / 100)} a.a. (bruto, antes do IR) com as taxas das Configurações. Informe o saldo do app do banco para ficar exato.`
            : 'Sem taxa definida — mostrando o valor aplicado. Informe o saldo atual.'}
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
        <label className="field"><span>Código / nome</span><input className="input" value={a.ticker} onChange={(e) => set('ticker', e.target.value)} /></label>
        <label className="field">
          <span>Classe</span>
          <select className="input" value={a.cls} onChange={(e) => set('cls', e.target.value as AssetClass)}>
            {CLASS_ORDER.map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}
          </select>
        </label>
        <label className="field"><span>Nome / razão social</span><input className="input" value={a.name ?? ''} onChange={(e) => set('name', e.target.value || undefined)} /></label>
        <label className="field"><span>CNPJ (para o IR)</span><input className="input" value={a.cnpj ?? ''} onChange={(e) => set('cnpj', e.target.value || undefined)} placeholder="00.000.000/0001-00" /></label>
        <label className="field"><span>Instituição</span><input className="input" list="institutions" value={a.institution ?? ''} onChange={(e) => set('institution', e.target.value || undefined)} /></label>
        {a.cls === 'RENDA_FIXA' && (
          <>
            <label className="field">
              <span>Tipo</span>
              <select className="input" value={a.fixed?.kind ?? 'CDB'} onChange={(e) => setFixed({ kind: e.target.value as FixedKind })}>
                {Object.entries(FIXED_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Rentabilidade</span>
              <div className="row">
                <select className="input" style={{ width: 130 }} value={a.fixed?.indexer ?? 'CDI'} onChange={(e) => setFixed({ indexer: e.target.value as Indexer })}>
                  {Object.entries(INDEXER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <input className="input num" defaultValue={String(a.fixed?.rate ?? '').replace('.', ',')} onChange={(e) => setFixed({ rate: parseNumber(e.target.value) || 0 })} />
              </div>
            </label>
            <label className="field"><span>Vencimento</span><input className="input" type="date" value={a.fixed?.maturity ?? ''} onChange={(e) => setFixed({ maturity: e.target.value || undefined })} /></label>
            <label className="field"><span>Emissor</span><input className="input" value={a.fixed?.issuer ?? ''} onChange={(e) => setFixed({ issuer: e.target.value || undefined })} /></label>
          </>
        )}
        <label className="field full"><span>Anotações</span><textarea className="input" rows={2} value={a.notes ?? ''} onChange={(e) => set('notes', e.target.value || undefined)} /></label>
      </div>
      <div className="row">
        <button
          className="btn danger"
          onClick={() => {
            if (!confirm(`Excluir ${asset.ticker} e todos os seus lançamentos?`)) return;
            actions.deleteAsset(asset.id);
            toast(`${asset.ticker} excluído`, { undo: true });
            onDeleted();
          }}
        >
          <Icon name="trash" size={16} /> Excluir ativo
        </button>
        <div className="spacer" />
        <button className="btn" onClick={onDone}>Cancelar</button>
        <button
          className="btn primary"
          onClick={() => {
            actions.updateAsset(asset.id, { ...a, ticker: a.ticker.trim() || asset.ticker });
            toast('Ativo atualizado');
            onDone();
          }}
        >
          Salvar
        </button>
      </div>
    </div>
  );
}
