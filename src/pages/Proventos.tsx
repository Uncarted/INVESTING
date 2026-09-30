import { useMemo, useState } from 'react';
import { useData } from '../lib/store';
import { incomeByAsset } from '../lib/tax';
import { INCOME_TYPES } from '../lib/types';
import { MONTHS, money, today } from '../lib/format';
import { t as tr } from '../lib/i18n';
import { MonthBars } from '../components/charts';
import { ClassChip, Empty } from '../components/ui';



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
  const monthly = MONTHS.map((label, i) => ({
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
        <div className="card card-pad kpi"><div className="label">{tr('Total no ano', 'Total this year')}</div><div className="value">{money(total)}</div><div className="sub muted">{tr('média', 'avg.')} {money(total / 12)}/{tr('mês', 'month')}</div></div>
        <div className="card card-pad kpi"><div className="label">{tr('Dividendos', 'Dividends')}</div><div className="value">{money(sum((r) => r.dividends))}</div><div className="sub muted">{tr('isentos', 'tax-exempt')}</div></div>
        <div className="card card-pad kpi"><div className="label">JCP</div><div className="value">{money(sum((r) => r.jcp))}</div><div className="sub muted">{tr('tributação exclusiva (15% na fonte)', '15% withheld at source')}</div></div>
        <div className="card card-pad kpi"><div className="label">{tr('Rendimentos FII e outros', 'REIT income and other')}</div><div className="value">{money(sum((r) => r.fiiIncome + r.other))}</div><div className="sub muted">{tr('FII: isentos p/ pessoa física', 'FIIs: tax-exempt for individuals')}</div></div>
      </div>
      <div className="card">
        <div className="card-head"><h2>{tr('Recebido por mês', 'Received per month')}</h2></div>
        <div className="card-pad"><MonthBars data={monthly} /></div>
      </div>
      <div className="card">
        {!rows.length ? (
          <Empty title={tr(`Nenhum provento em ${year}`, `No dividends in ${year}`)}>{tr('Lance dividendos, JCP e rendimentos em “Adicionar → Provento”, ou importe a Movimentação da B3.', 'Add dividends, JCP and income via “Add → Dividend”, or import the B3 Movimentação statement.')}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>{tr('Ativo', 'Asset')}</th><th className="num">{tr('Dividendos', 'Dividends')}</th><th className="num">JCP</th><th className="num">{tr('Rend. FII', 'REIT income')}</th><th className="num">{tr('Outros', 'Other')}</th><th className="num">Total</th></tr>
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
