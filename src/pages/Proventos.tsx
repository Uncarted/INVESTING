import { useMemo, useState } from 'react';
import { actions, useData } from '../lib/store';
import { incomeByAsset } from '../lib/tax';
import { INCOME_TYPES, TX_LABEL } from '../lib/types';
import { MONTHS, fmtCurrency, fmtDate, money, today } from '../lib/format';
import { t as tr } from '../lib/i18n';
import { MonthBars } from '../components/charts';
import { ClassChip, Empty, toast } from '../components/ui';
import { Icon } from '../components/Icon';
import { syncDividends, useDividends } from '../lib/dividends';
import { currencyOf } from '../lib/portfolio';



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

  const auto = data.settings.autoDividends !== false;
  const div = useDividends();
  const recent = incomeTx
    .filter((x) => x.date.startsWith(year))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 12);
  const assetOf = (id: string) => data.assets.find((a) => a.id === id);
  const check = async () => {
    const n = await syncDividends(true);
    toast(n ? tr(`${n} provento(s) novo(s) adicionado(s)`, `${n} new payment(s) added`) : tr('Nenhum provento novo encontrado', 'No new payments found'));
  };

  return (
    <div className="stack">
      <div className="card card-pad div-auto">
        <div className="div-auto-text">
          <b>{tr('Proventos automáticos', 'Automatic dividends')}</b>
          <span className="muted small">
            {tr(
              'Para cada ação, FII ou ação dos EUA que você tem, buscamos os pagamentos da empresa e calculamos quanto você recebeu pela quantidade que tinha na data com. JCP já vem com os 15% descontados; dos EUA, com os 30% retidos lá.',
              'For each stock, REIT or US stock you hold, we fetch the company’s payments and work out what you received from the shares you held on the record date. JCP comes net of 15%; US dividends net of the 30% withheld there.',
            )}
          </span>
          {div.notes.map((n) => <span key={n} className="small" style={{ color: 'var(--warn-ink)' }}>{n}</span>)}
        </div>
        <div className="div-auto-actions">
          <label className="switch">
            <input type="checkbox" checked={auto} onChange={(e) => actions.updateSettings({ autoDividends: e.target.checked })} />
            <span />
          </label>
          <button className="btn sm ghost" disabled={div.status === 'loading'} onClick={check}>
            {div.status === 'loading' ? <span className="spinner" /> : <Icon name="refresh" size={14} />} {tr('Verificar agora', 'Check now')}
          </button>
        </div>
      </div>

      {div.upcoming.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>{tr('A receber', 'Coming up')}</h2></div>
          <div className="pay-list">
            {div.upcoming.map((f) => (
              <div key={f.key} className="pay-row">
                <span className="pay-date">{fmtDate(f.date)}</span>
                <b>{f.ticker}</b>
                <span className="muted small">{TX_LABEL[f.type]} · {f.shares} × {fmtCurrency(f.perShare, f.currency, { always: true })}</span>
                <span className="pay-amt pos">{fmtCurrency(f.net, f.currency, { always: true })}</span>
              </div>
            ))}
          </div>
        </div>
      )}

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
      {recent.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>{tr('Últimos recebidos', 'Latest payments')}</h2></div>
          <div className="pay-list">
            {recent.map((x) => {
              const a = assetOf(x.assetId);
              const cur = a ? currencyOf(a) : 'BRL';
              return (
                <div key={x.id} className="pay-row clickable" onClick={() => a && openAsset(a.id)}>
                  <span className="pay-date">{fmtDate(x.date)}</span>
                  <b>{a?.ticker ?? '—'}</b>
                  <span className="muted small">
                    {TX_LABEL[x.type]}
                    {x.source === 'auto' ? ` · ${tr('automático', 'automatic')}` : x.source === 'b3' ? ' · B3' : ''}
                  </span>
                  <span className="pay-amt">{fmtCurrency(x.quantity * x.price, cur, { always: true })}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
