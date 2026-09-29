import { useMemo, useState } from 'react';
import { actions, useData } from '../lib/store';
import { TX_LABEL, isMarketClass, type TxType } from '../lib/types';
import { fmtDate, money, qty } from '../lib/format';
import { ClassChip, Empty, toast } from '../components/ui';
import { Icon } from '../components/Icon';
import { exportCSV, exportWorkbook } from '../lib/exporters';
import type { FormInit } from '../components/TransactionForm';

const PAGE = 100;

export function Lancamentos({ onEdit }: { onEdit: (i: FormInit) => void }) {
  const data = useData();
  const [q, setQ] = useState('');
  const [type, setType] = useState<TxType | 'ALL'>('ALL');
  const [year, setYear] = useState('ALL');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);

  const byId = useMemo(() => new Map(data.assets.map((a) => [a.id, a])), [data.assets]);
  const years = useMemo(() => [...new Set(data.transactions.map((t) => t.date.slice(0, 4)))].sort().reverse(), [data.transactions]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return data.transactions
      .filter((t) => {
        const a = byId.get(t.assetId);
        return (
          (type === 'ALL' || t.type === type) &&
          (year === 'ALL' || t.date.startsWith(year)) &&
          (!s || `${a?.ticker} ${a?.name ?? ''} ${t.institution ?? ''} ${t.notes ?? ''}`.toLowerCase().includes(s))
        );
      })
      .sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1));
  }, [data.transactions, byId, q, type, year]);

  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="stack">
      <div className="row wrap">
        <div className="search" style={{ width: 240 }}>
          <Icon name="search" size={16} />
          <input className="input" placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input" style={{ width: 170 }} value={type} onChange={(e) => setType(e.target.value as TxType | 'ALL')}>
          <option value="ALL">Todos os tipos</option>
          {Object.entries(TX_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className="input" style={{ width: 120 }} value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="ALL">Todos os anos</option>
          {years.map((y) => <option key={y}>{y}</option>)}
        </select>
        <div className="spacer" />
        {sel.size > 0 && (
          <button
            className="btn danger"
            onClick={() => {
              actions.deleteTransactions([...sel]);
              toast(`${sel.size} lançamento(s) excluído(s)`, { undo: true });
              setSel(new Set());
            }}
          >
            <Icon name="trash" size={16} /> Excluir {sel.size}
          </button>
        )}
        <button className="btn" onClick={() => exportCSV(data)}><Icon name="download" size={16} /> CSV</button>
        <button className="btn" onClick={() => exportWorkbook(data)}><Icon name="download" size={16} /> Excel</button>
      </div>

      <div className="card">
        {!rows.length ? (
          <Empty title="Nenhum lançamento">{data.transactions.length ? 'Ajuste os filtros.' : 'Use o botão “Novo lançamento”.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}><input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Selecionar todos" /></th>
                  <th>Data</th>
                  <th>Tipo</th>
                  <th>Ativo</th>
                  <th className="num">Qtd.</th>
                  <th className="num">Preço</th>
                  <th className="num hide-sm">Taxas</th>
                  <th className="num">Total</th>
                  <th className="hide-sm">Instituição</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((t) => {
                  const a = byId.get(t.assetId);
                  const m = a ? isMarketClass(a.cls) : true;
                  const typeLabel = !m && t.type === 'BUY' ? 'Aplicação' : !m && t.type === 'SELL' ? 'Resgate' : TX_LABEL[t.type];
                  const isTrade = t.type === 'BUY' || t.type === 'SELL' || t.type === 'BONUS';
                  return (
                    <tr key={t.id} className="clickable" onClick={() => onEdit({ tx: t, asset: a })}>
                      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} /></td>
                      <td className="text-2" style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.date)}</td>
                      <td><span className={t.type === 'SELL' ? 'neg' : t.type === 'BUY' ? '' : 'pos'}>{typeLabel}</span></td>
                      <td>
                        <div className="row"><span className="ticker">{a?.ticker ?? '?'}</span>{a && <span className="hide-sm"><ClassChip cls={a.cls} /></span>}</div>
                      </td>
                      <td className="num">{t.type === 'SPLIT' ? `× ${qty(t.factor)}` : m && isTrade ? qty(t.quantity) : ''}</td>
                      <td className="num">{m && isTrade ? money(t.price) : ''}</td>
                      <td className="num hide-sm">{t.fees ? money(t.fees) : ''}</td>
                      <td className="num">{t.type === 'SPLIT' ? '' : money(t.quantity * t.price + (t.type === 'BUY' ? t.fees : -t.fees))}</td>
                      <td className="hide-sm text-2">{t.institution ?? ''}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button className="icon-btn" title="Excluir" onClick={() => { actions.deleteTransactions([t.id]); toast('Lançamento excluído', { undo: true }); }}>
                          <Icon name="trash" size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length > limit && (
              <div className="row" style={{ justifyContent: 'center', padding: 12 }}>
                <button className="btn sm" onClick={() => setLimit((l) => l + PAGE)}>Mostrar mais ({rows.length - limit})</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
