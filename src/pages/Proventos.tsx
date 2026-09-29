import { useMemo, useState } from 'react';
import { useData } from '../lib/store';
import { incomeByAsset } from '../lib/tax';
import { INCOME_TYPES } from '../lib/types';
import { money, today } from '../lib/format';
import { MonthBars } from '../components/charts';
import { ClassChip, Empty } from '../components/ui';

const M = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function Proventos({ openAsset }: { openAsset: (id: string) => void }) {
  const data = useData();
  const incomeTx = data.transactions.filter((t) => INCOME_TYPES.includes(t.type));
  const years = useMemo(() => {
    const s = new Set(incomeTx.map((t) => t.date.slice(0, 4)));
    s.add(today().slice(0, 4));
    return [...s].sort().reverse();
  }, [incomeTx]);
  const [year, setYear] = useState(years[0]);
  const rows = incomeByAsset(data.assets, data.transactions, Number(year));
  const monthly = M.map((label, i) => ({
    label,
    value: incomeTx.filter((t) => t.date.startsWith(`${year}-${String(i + 1).padStart(2, '0')}`)).reduce((s, t) => s + t.quantity * t.price, 0),
  }));
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const total = sum((r) => r.dividends + r.jcp + r.fiiIncome + r.other);

  return (
    <div className="stack">
      <div className="row">
        <div className="seg">
          {years.map((y) => <button key={y} className={y === year ? 'on' : ''} onClick={() => setYear(y)}>{y}</button>)}
        </div>
      </div>
      <div className="grid grid-4">
        <div className="card card-pad kpi"><div className="label">Total no ano</div><div className="value">{money(total)}</div><div className="sub muted">média {money(total / 12)}/mês</div></div>
        <div className="card card-pad kpi"><div className="label">Dividendos</div><div className="value">{money(sum((r) => r.dividends))}</div><div className="sub muted">isentos</div></div>
        <div className="card card-pad kpi"><div className="label">JCP</div><div className="value">{money(sum((r) => r.jcp))}</div><div className="sub muted">tributação exclusiva (15% na fonte)</div></div>
        <div className="card card-pad kpi"><div className="label">Rendimentos FII e outros</div><div className="value">{money(sum((r) => r.fiiIncome + r.other))}</div><div className="sub muted">FII: isentos p/ pessoa física</div></div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Recebido por mês</h2></div>
        <div className="card-pad"><MonthBars data={monthly} /></div>
      </div>
      <div className="card">
        {!rows.length ? (
          <Empty title={`Nenhum provento em ${year}`}>Lance dividendos, JCP e rendimentos pelo “Novo lançamento → Provento”, ou importe a Movimentação da B3.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Ativo</th><th className="num">Dividendos</th><th className="num">JCP</th><th className="num">Rend. FII</th><th className="num">Outros</th><th className="num">Total</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.asset.id} className="clickable" onClick={() => openAsset(r.asset.id)}>
                    <td><div className="row"><span className="ticker">{r.asset.ticker}</span><ClassChip cls={r.asset.cls} /></div></td>
                    <td className="num">{r.dividends ? money(r.dividends) : ''}</td>
                    <td className="num">{r.jcp ? money(r.jcp) : ''}</td>
                    <td className="num">{r.fiiIncome ? money(r.fiiIncome) : ''}</td>
                    <td className="num">{r.other ? money(r.other) : ''}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money(r.dividends + r.jcp + r.fiiIncome + r.other)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
