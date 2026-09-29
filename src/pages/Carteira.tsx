import { useMemo, useState } from 'react';
import { actions, useData } from '../lib/store';
import { computePositions, type Position } from '../lib/portfolio';
import { CLASS_LABEL, CLASS_ORDER, isMarketClass, type AssetClass } from '../lib/types';
import { money, percent, qty, signedPercent, today } from '../lib/format';
import { Delta, Empty, toast, useSort } from '../components/ui';
import { Icon } from '../components/Icon';
import { fetchQuotes } from '../lib/quotes';
import { exportWorkbook } from '../lib/exporters';

type SortKey = 'ticker' | 'value' | 'cost' | 'result' | 'resultPct' | 'weight';

export function Carteira({ openAsset }: { openAsset: (id: string) => void }) {
  const data = useData();
  const [q, setQ] = useState('');
  const [cls, setCls] = useState<AssetClass | 'ALL'>('ALL');
  const [showClosed, setShowClosed] = useState(false);
  const [loading, setLoading] = useState(false);
  const sort = useSort<SortKey>('value');

  const all = useMemo(() => computePositions(data.assets, data.transactions, data.settings, today()), [data]);
  const open = all.filter((p) => !p.closed);
  const total = open.reduce((s, p) => s + p.value, 0);

  const filtered = all.filter(
    (p) =>
      (showClosed || !p.closed) &&
      (cls === 'ALL' || p.asset.cls === cls) &&
      (!q || (p.asset.ticker + ' ' + (p.asset.name ?? '') + ' ' + (p.asset.institution ?? '')).toLowerCase().includes(q.toLowerCase())),
  );
  const val = (p: Position): number | string => {
    switch (sort.key) {
      case 'ticker': return p.asset.ticker;
      case 'value': return p.value;
      case 'cost': return p.cost;
      case 'result': return p.value - p.cost;
      case 'resultPct': return p.cost ? (p.value - p.cost) / p.cost : 0;
      case 'weight': return p.value;
    }
  };
  const cmp = (a: Position, b: Position) => {
    const x = val(a), y = val(b);
    return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * sort.dir;
  };
  const groups = CLASS_ORDER.map((c) => ({ cls: c, items: filtered.filter((p) => p.asset.cls === c).sort(cmp) })).filter((g) => g.items.length);
  const classesPresent = CLASS_ORDER.filter((c) => all.some((p) => p.asset.cls === c && (!p.closed || showClosed)));

  async function refreshQuotes() {
    const targets = open.map((p) => p.asset).filter((a) => isMarketClass(a.cls) && a.cls !== 'EXTERIOR');
    if (!targets.length) return toast('Nenhum ativo de bolsa para atualizar');
    setLoading(true);
    const { prices, errors } = await fetchQuotes(targets, data.settings.brapiToken);
    setLoading(false);
    const now = new Date().toISOString();
    for (const a of targets) {
      const p = prices.get(a.ticker);
      if (p) actions.updateAsset(a.id, { currentPrice: p, priceUpdatedAt: now });
    }
    if (prices.size) toast(`${prices.size} cotação(ões) atualizada(s)${errors.length ? ` · ${errors.length} com erro` : ''}`);
    else toast(data.settings.brapiToken ? 'Não foi possível buscar as cotações' : 'Cadastre um token gratuito da brapi.dev em Configurações');
    if (errors.length) console.warn(errors);
  }

  const Th = ({ k, children, num }: { k: SortKey; children: React.ReactNode; num?: boolean }) => (
    <th className={'sortable' + (num ? ' num' : '')} onClick={() => sort.toggle(k)}>{children}{sort.arrow(k)}</th>
  );

  return (
    <div className="stack">
      <div className="row wrap">
        <div className="search" style={{ width: 260 }}>
          <Icon name="search" size={16} />
          <input className="input" placeholder="Buscar ativo, nome, instituição" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg">
          <button className={cls === 'ALL' ? 'on' : ''} onClick={() => setCls('ALL')}>Todos</button>
          {classesPresent.map((c) => (
            <button key={c} className={cls === c ? 'on' : ''} onClick={() => setCls(c)}>{CLASS_LABEL[c]}</button>
          ))}
        </div>
        <label className="row small text-2"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Mostrar encerrados</label>
        <div className="spacer" />
        <button className="btn" onClick={refreshQuotes} disabled={loading}><Icon name="refresh" size={16} /> {loading ? 'Atualizando…' : 'Atualizar cotações'}</button>
        <button className="btn" onClick={() => exportWorkbook(data)}><Icon name="download" size={16} /> Excel</button>
      </div>

      <div className="card">
        {!groups.length ? (
          <Empty title="Nada por aqui">{all.length ? 'Nenhum ativo corresponde ao filtro.' : 'Adicione seu primeiro lançamento.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <Th k="ticker">Ativo</Th>
                  <th className="num">Qtd.</th>
                  <th className="num">Preço médio</th>
                  <th className="num hide-sm">Preço atual</th>
                  <Th k="cost" num>Custo</Th>
                  <Th k="value" num>Valor atual</Th>
                  <Th k="result" num>Resultado</Th>
                  <Th k="resultPct" num>%</Th>
                  <Th k="weight" num>Carteira</Th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const gv = g.items.reduce((s, p) => s + p.value, 0);
                  const gc = g.items.reduce((s, p) => s + p.cost, 0);
                  return [
                    <tr key={g.cls} className="group">
                      <td colSpan={4}><div className="row"><span className="dot" style={{ background: `var(--c-${g.cls})` }} />{CLASS_LABEL[g.cls]} <span className="muted" style={{ fontWeight: 400 }}>· {g.items.length}</span></div></td>
                      <td className="num">{money(gc)}</td>
                      <td className="num">{money(gv)}</td>
                      <td className="num"><Delta value={gv - gc}>{money(gv - gc)}</Delta></td>
                      <td className="num"><Delta value={gv - gc}>{signedPercent(gc ? (gv - gc) / gc : 0)}</Delta></td>
                      <td className="num">{percent(total ? gv / total : 0)}</td>
                    </tr>,
                    ...g.items.map((p) => {
                      const m = isMarketClass(p.asset.cls);
                      const r = p.value - p.cost;
                      return (
                        <tr key={p.asset.id} className="clickable" onClick={() => openAsset(p.asset.id)} style={p.closed ? { opacity: 0.55 } : undefined}>
                          <td>
                            <div className="ticker">{p.asset.ticker}</div>
                            <div className="subname">{[p.asset.name, p.asset.institution].filter(Boolean).join(' · ') || ' '}</div>
                          </td>
                          <td className="num">{m ? qty(p.quantity) : ''}</td>
                          <td className="num">{m ? money(p.avgPrice) : ''}</td>
                          <td className="num hide-sm">
                            {m ? (p.asset.currentPrice ? money(p.asset.currentPrice) : <span className="muted">—</span>) : p.valueIsEstimate ? <span className="chip">estimado</span> : <span className="chip">saldo</span>}
                          </td>
                          <td className="num">{money(p.cost)}</td>
                          <td className="num">{money(p.value)}</td>
                          <td className="num">{p.closed ? <Delta value={p.realized}>{money(p.realized)}</Delta> : <Delta value={r}>{money(r)}</Delta>}</td>
                          <td className="num"><Delta value={r}>{p.closed ? '' : signedPercent(p.cost ? r / p.cost : 0)}</Delta></td>
                          <td className="num">{p.closed ? <span className="chip">encerrado</span> : percent(total ? p.value / total : 0)}</td>
                        </tr>
                      );
                    }),
                  ];
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>Total</td>
                  <td className="num">{money(filtered.reduce((s, p) => s + p.cost, 0))}</td>
                  <td className="num">{money(filtered.reduce((s, p) => s + p.value, 0))}</td>
                  <td className="num" colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
      <p className="muted small">
        Clique em um ativo para ver o histórico, editar, informar a cotação ou o saldo. Sem cotação, o valor atual considera o custo.
      </p>
    </div>
  );
}
