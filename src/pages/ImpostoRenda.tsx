import { useMemo, useState } from 'react';
import { useData } from '../lib/store';
import { allSales } from '../lib/portfolio';
import { bensEDireitos, computeTaxYear, incomeByAsset, ACOES_EXEMPTION } from '../lib/tax';
import { MONTHS_LONG, fmtDate, money, toISODate, today } from '../lib/format';
import { t } from '../lib/i18n';
import { Delta, Empty, toast } from '../components/ui';
import { Icon } from '../components/Icon';
import { exportTaxWorkbook } from '../lib/exporters';

type Tab = 'mensal' | 'bens' | 'rendimentos';

/** DARF due date: last business day of the following month (ignores holidays). */
function darfDue(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m + 1, 0); // last day of next month
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return toISODate(d);
}

export function ImpostoRenda({ openAsset }: { openAsset: (id: string) => void }) {
  const data = useData();
  const cur = Number(today().slice(0, 4));
  const years = useMemo(() => {
    const s = new Set(data.transactions.map((t) => Number(t.date.slice(0, 4))));
    s.add(cur);
    s.add(cur - 1);
    return [...s].sort((a, b) => b - a);
  }, [data.transactions, cur]);
  const [year, setYear] = useState(cur - 1);
  const [tab, setTab] = useState<Tab>('bens');

  const sales = useMemo(() => allSales(data.assets, data.transactions, data.settings), [data]);
  const tax = useMemo(() => computeTaxYear(sales, year), [sales, year]);
  const bens = useMemo(() => bensEDireitos(data.assets, data.transactions, data.settings, year), [data, year]);
  const income = useMemo(() => incomeByAsset(data.assets, data.transactions, year), [data, year]);

  const active = tax.months.filter((m) => m.acoesSales || m.acoesResult || m.etfResult || m.bdrResult || m.fiiSales || m.cryptoSales || m.darf);

  return (
    <div className="stack">
      <div className="row wrap">
        <div className="seg">
          {years.map((y) => <button key={y} className={y === year ? 'on' : ''} onClick={() => setYear(y)}>{y}</button>)}
        </div>
        <span className="muted small">{year < cur ? t(`Declaração entregue em ${year + 1}`, `Return filed in ${year + 1}`) : t('Ano em andamento', 'Year in progress')}</span>
        <div className="spacer" />
        <button className="btn primary" onClick={() => exportTaxWorkbook(data, year)}><Icon name="download" size={16} /> {t('Exportar IR', 'Export tax report')} {year} (Excel)</button>
      </div>

      <div className="grid grid-4">
        <div className="card card-pad kpi"><div className="label">{t('DARF (6015) no ano', 'DARF (6015) this year')}</div><div className="value">{money(tax.totals.darf)}</div><div className="sub muted">{t('ações, ETFs, BDRs e FIIs', 'stocks, ETFs, BDRs and REITs')}</div></div>
        <div className="card card-pad kpi"><div className="label">{t('Lucro isento em ações', 'Tax-exempt stock gains')}</div><div className="value">{money(tax.totals.acoesExemptGain)}</div><div className="sub muted">{t('vendas', 'sales')} ≤ {money(ACOES_EXEMPTION, { always: true })}/{t('mês', 'month')}</div></div>
        <div className="card card-pad kpi"><div className="label">{t('Prejuízo a compensar', 'Losses to offset')}</div><div className="value">{money((tax.months.at(-1)?.comumLossBalance ?? 0) + (tax.months.at(-1)?.fiiLossBalance ?? 0))}</div><div className="sub muted">{t('comum', 'regular')} {money(tax.months.at(-1)?.comumLossBalance ?? 0)} · FII {money(tax.months.at(-1)?.fiiLossBalance ?? 0)}</div></div>
        <div className="card card-pad kpi"><div className="label">{t('Proventos recebidos', 'Dividends received')}</div><div className="value">{money(income.reduce((s, r) => s + r.dividends + r.jcp + r.fiiIncome + r.other, 0))}</div><div className="sub muted">{income.length} {t('pagador(es)', 'payer(s)')}</div></div>
      </div>

      {tax.warnings.map((w) => (
        <div key={w} className="notice"><Icon name="alert" /><span>{w}</span></div>
      ))}

      <div>
        <div className="tabs">
          <button className={tab === 'bens' ? 'on' : ''} onClick={() => setTab('bens')}>{t('Bens e Direitos', 'Bens e Direitos (assets)')}</button>
          <button className={tab === 'mensal' ? 'on' : ''} onClick={() => setTab('mensal')}>{t('Apuração mensal (DARF)', 'Monthly tax (DARF)')}</button>
          <button className={tab === 'rendimentos' ? 'on' : ''} onClick={() => setTab('rendimentos')}>{t('Rendimentos isentos e exclusivos', 'Exempt and withheld income')}</button>
        </div>

        {tab === 'bens' && (
          <div className="card">
            {!bens.length ? (
              <Empty title={t(`Nenhum bem em 31/12/${year}`, `No assets on Dec 31, ${year}`)} />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>{t('Grupo / Código', 'Group / Code')}</th><th>{t('Ativo', 'Asset')}</th><th>{t('Discriminação', 'Description (Discriminação)')}</th><th className="num">31/12/{year - 1}</th><th className="num">31/12/{year}</th></tr>
                  </thead>
                  <tbody>
                    {bens.map((b) => (
                      <tr key={b.asset.id}>
                        <td title={b.codeLabel} style={{ whiteSpace: 'nowrap' }}>
                          <b>{b.group} · {b.code}</b>
                          <div className="muted small" style={{ maxWidth: 170, whiteSpace: 'normal' }}>{b.codeLabel}</div>
                        </td>
                        <td className="clickable" onClick={() => openAsset(b.asset.id)}>
                          <span className="ticker">{b.asset.ticker}</span>
                          {!b.asset.cnpj && <div className="small" style={{ color: 'var(--warn-ink)' }}>{t('sem CNPJ', 'no CNPJ')}</div>}
                        </td>
                        <td>
                          <div className="copy-cell">
                            <span className="desc">{b.description}</span>
                            <button className="icon-btn" title={t('Copiar', 'Copy')} onClick={() => { navigator.clipboard?.writeText(b.description); toast(t('Discriminação copiada', 'Description copied')); }}><Icon name="copy" size={15} /></button>
                          </div>
                        </td>
                        <td className="num">{money(b.prevCost, { always: true })}</td>
                        <td className="num">{money(b.cost, { always: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3}>Total</td>
                      <td className="num">{money(bens.reduce((s, b) => s + b.prevCost, 0), { always: true })}</td>
                      <td className="num">{money(bens.reduce((s, b) => s + b.cost, 0), { always: true })}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <p className="muted small card-pad" style={{ margin: 0 }}>
              {t('Os valores são o custo de aquisição (preço médio × quantidade), como pede a Receita — não o valor de mercado. Para renda fixa, confira com o informe de rendimentos do banco. Adicione o CNPJ de cada ativo (no detalhe do ativo) para preencher a ficha.', "Values are the acquisition cost (average price × quantity), as the Receita Federal requires — not market value. For fixed income, check your bank's annual income statement. Add each asset's CNPJ (in the asset details) to fill in the form. The description stays in Portuguese because it goes on the Brazilian tax return.")}
            </p>
          </div>
        )}

        {tab === 'mensal' && (
          <div className="stack">
            {!active.length ? (
              <div className="card"><Empty title={t(`Nenhuma venda em ${year}`, `No sales in ${year}`)}>{t('Sem vendas, não há imposto de renda variável a apurar.', 'No sales means no capital-gains tax to calculate.')}</Empty></div>
            ) : (
              <>
                {active.some((m) => m.acoesSales || m.etfResult || m.bdrResult) && (
                <div className="card">
                  <div className="card-head"><h2>{t('Operações comuns — ações, ETFs e BDRs (15%)', 'Regular trades — stocks, ETFs and BDRs (15%)')}</h2></div>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="table">
                      <thead>
                        <tr><th>{t('Mês', 'Month')}</th><th className="num">{t('Vendas de ações', 'Stock sales')}</th><th className="num">{t('Resultado ações', 'Stock result')}</th><th className="num">ETFs + BDRs</th><th className="num">{t('Prejuízo usado', 'Loss used')}</th><th className="num">{t('Base de cálculo', 'Taxable base')}</th><th className="num">{t('IR 15%', 'Tax 15%')}</th><th className="num">{t('Saldo prejuízo', 'Loss balance')}</th></tr>
                      </thead>
                      <tbody>
                        {active.filter((m) => m.acoesSales || m.etfResult || m.bdrResult || m.comumTax).map((m) => (
                          <tr key={m.month}>
                            <td>{MONTHS_LONG[Number(m.month.slice(5)) - 1]}</td>
                            <td className="num">{money(m.acoesSales, { always: true })}</td>
                            <td className="num">
                              <Delta value={m.acoesResult}>{money(m.acoesResult, { always: true })}</Delta>
                              {m.acoesExempt && m.acoesResult > 0 && <div><span className="chip">{t('isento', 'exempt')}</span></div>}
                            </td>
                            <td className="num"><Delta value={m.etfResult + m.bdrResult}>{money(m.etfResult + m.bdrResult, { always: true })}</Delta></td>
                            <td className="num">{m.comumLossUsed ? money(m.comumLossUsed, { always: true }) : ''}</td>
                            <td className="num">{money(m.comumBase, { always: true })}</td>
                            <td className="num" style={{ fontWeight: 600 }}>{money(m.comumTax, { always: true })}</td>
                            <td className="num text-2">{money(m.comumLossBalance, { always: true })}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                )}

                {active.some((m) => m.fiiSales) && (
                  <div className="card">
                    <div className="card-head"><h2>{t('Fundos imobiliários (20%)', 'Real estate funds / FIIs (20%)')}</h2></div>
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table className="table">
                        <thead><tr><th>{t('Mês', 'Month')}</th><th className="num">{t('Vendas', 'Sales')}</th><th className="num">{t('Resultado', 'Result')}</th><th className="num">{t('Prejuízo usado', 'Loss used')}</th><th className="num">{t('IR 20%', 'Tax 20%')}</th><th className="num">{t('Prejuízo acumulado', 'Loss balance')}</th></tr></thead>
                        <tbody>
                          {active.filter((m) => m.fiiSales).map((m) => (
                            <tr key={m.month}>
                              <td>{MONTHS_LONG[Number(m.month.slice(5)) - 1]}</td>
                              <td className="num">{money(m.fiiSales, { always: true })}</td>
                              <td className="num"><Delta value={m.fiiResult}>{money(m.fiiResult, { always: true })}</Delta></td>
                              <td className="num">{m.fiiLossUsed ? money(m.fiiLossUsed, { always: true }) : ''}</td>
                              <td className="num" style={{ fontWeight: 600 }}>{money(m.fiiTax, { always: true })}</td>
                              <td className="num text-2">{money(m.fiiLossBalance, { always: true })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className="card">
                  <div className="card-head"><h2>{t('DARF a pagar — código 6015', 'DARF to pay — code 6015')}</h2></div>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="table">
                      <thead><tr><th>{t('Apuração', 'Month')}</th><th className="num">{t('IR devido', 'Tax due')}</th><th className="num">{t('IRRF (dedo-duro)', 'IRRF withheld')}</th><th className="num">DARF</th><th>{t('Vencimento', 'Due date')}</th></tr></thead>
                      <tbody>
                        {active.filter((m) => m.totalTax || m.darf || m.darfCarry).map((m) => (
                          <tr key={m.month}>
                            <td>{MONTHS_LONG[Number(m.month.slice(5)) - 1]}</td>
                            <td className="num">{money(m.totalTax, { always: true })}</td>
                            <td className="num">{m.irrfUsed ? `− ${money(m.irrfUsed, { always: true })}` : ''}</td>
                            <td className="num" style={{ fontWeight: 650 }}>
                              {m.darf ? money(m.darf, { always: true }) : <span className="muted small">{m.darfCarry ? t(`< R$10, acumula (${money(m.darfCarry, { always: true })})`, `< R$10, carried over (${money(m.darfCarry, { always: true })})`) : '—'}</span>}
                            </td>
                            <td>{m.darf ? fmtDate(darfDue(m.month)) : ''}</td>
                          </tr>
                        ))}
                        {!active.some((m) => m.totalTax) && <tr><td colSpan={5} className="muted">{t('Nenhum imposto devido no ano. 🎉', 'No tax due this year. 🎉')}</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>

                {active.some((m) => m.cryptoSales) && (
                  <div className="card">
                    <div className="card-head"><h2>{t('Criptoativos — isenção de R$ 35 mil/mês em vendas', 'Crypto — exempt up to R$ 35k/month in sales')}</h2></div>
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table className="table">
                        <thead><tr><th>{t('Mês', 'Month')}</th><th className="num">{t('Vendas', 'Sales')}</th><th className="num">{t('Ganho', 'Gain')}</th><th>{t('Situação', 'Status')}</th><th className="num">{t('IR (GCAP, cód. 4600)', 'Tax (GCAP, code 4600)')}</th></tr></thead>
                        <tbody>
                          {active.filter((m) => m.cryptoSales).map((m) => (
                            <tr key={m.month}>
                              <td>{MONTHS_LONG[Number(m.month.slice(5)) - 1]}</td>
                              <td className="num">{money(m.cryptoSales, { always: true })}</td>
                              <td className="num"><Delta value={m.cryptoGain}>{money(m.cryptoGain, { always: true })}</Delta></td>
                              <td>{m.cryptoExempt ? <span className="chip">{t('isento', 'exempt')}</span> : <span className="chip">{t('tributável', 'taxable')}</span>}</td>
                              <td className="num">{money(m.cryptoTax, { always: true })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {tax.exterior.sales > 0 && (
                  <div className="card card-pad">
                    <h2 style={{ fontSize: 15, marginTop: 0 }}>{t('Exterior (apuração anual — Lei 14.754/2023)', 'Foreign assets (yearly — Law 14.754/2023)')}</h2>
                    <p className="text-2" style={{ margin: 0 }}>
                      {t('Vendas', 'Sales')} {money(tax.exterior.sales, { always: true })} · {t('resultado', 'result')} <Delta value={tax.exterior.result}>{money(tax.exterior.result, { always: true })}</Delta> · {t('IR estimado 15%', 'Estimated tax 15%')}: <b>{money(tax.exterior.tax, { always: true })}</b>{t(', pago na declaração anual. Valores em reais pela cotação do dia de cada operação.', ', paid with the annual return. Converted to reais at each trade-date exchange rate.')}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'rendimentos' && (
          <div className="stack">
            <div className="card">
              <div className="card-head"><h2>{t('Rendimentos isentos e não tributáveis', 'Exempt income (Rendimentos isentos)')}</h2></div>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="table">
                  <thead><tr><th>{t('Linha', 'Line')}</th><th>{t('Descrição', 'Description')}</th><th className="num">{t('Valor', 'Amount')}</th></tr></thead>
                  <tbody>
                    <tr><td>20</td><td>{t('Ganhos líquidos em operações com ações — vendas até R$ 20 mil/mês', 'Net stock gains — months with sales up to R$ 20k')}</td><td className="num">{money(tax.totals.acoesExemptGain, { always: true })}</td></tr>
                    {income.filter((r) => r.dividends).map((r) => (
                      <tr key={'d' + r.asset.id}><td>09</td><td>{t('Dividendos', 'Dividends')} — {r.asset.ticker}{r.asset.cnpj ? ` (CNPJ ${r.asset.cnpj})` : ''}</td><td className="num">{money(r.dividends, { always: true })}</td></tr>
                    ))}
                    {income.filter((r) => r.fiiIncome).map((r) => (
                      <tr key={'f' + r.asset.id}><td>99</td><td>{t('Rendimentos de FII', 'REIT (FII) income')} — {r.asset.ticker}{r.asset.cnpj ? ` (CNPJ ${r.asset.cnpj})` : ''}</td><td className="num">{money(r.fiiIncome, { always: true })}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>{t('Rendimentos sujeitos à tributação exclusiva', 'Income taxed at source (tributação exclusiva)')}</h2></div>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="table">
                  <thead><tr><th>{t('Linha', 'Line')}</th><th>{t('Descrição', 'Description')}</th><th className="num">{t('Valor líquido', 'Net amount')}</th></tr></thead>
                  <tbody>
                    {income.filter((r) => r.jcp).map((r) => (
                      <tr key={'j' + r.asset.id}><td>10</td><td>{t('Juros sobre capital próprio', 'Interest on equity (JCP)')} — {r.asset.ticker}{r.asset.cnpj ? ` (CNPJ ${r.asset.cnpj})` : ''}</td><td className="num">{money(r.jcp, { always: true })}</td></tr>
                    ))}
                    {!income.some((r) => r.jcp) && <tr><td colSpan={3} className="muted">{t(`Nenhum JCP lançado em ${year}.`, `No JCP in ${year}.`)}</td></tr>}
                  </tbody>
                </table>
              </div>
              <p className="muted small card-pad" style={{ margin: 0 }}>{t('Rendimentos de CDB, Tesouro e fundos também entram aqui (linha 06), com os valores do informe de rendimentos de cada banco.', "CDB, Tesouro and fund income also goes here (line 06), using each bank's annual income statement.")}</p>
            </div>
          </div>
        )}
      </div>

      <div className="notice info">
        <Icon name="info" />
        <span>
          {t('Cálculos de apoio seguindo as regras gerais (preço médio com custos, isenção de R$ 20 mil para ações, prejuízos compensados por categoria, IRRF de 0,005%, DARF mínimo de R$ 10). Day trade, opções e casos especiais não são apurados. Confira com os informes das corretoras ou um contador antes de declarar.', "Helper calculations following the general Brazilian rules (average price with fees, R$ 20k stock exemption, losses offset by category, 0.005% IRRF, R$ 10 DARF minimum). Day trades, options and special cases aren't calculated. Check against your brokers' statements or an accountant before filing.")}
        </span>
      </div>
    </div>
  );
}
