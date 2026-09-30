import { useMemo, useState } from 'react';
import { useData } from '../lib/store';
import { allSales } from '../lib/portfolio';
import { bensEDireitos, computeTaxYear, incomeByAsset, ACOES_EXEMPTION } from '../lib/tax';
import { MONTHS_LONG, fmtDate, money, toISODate, today } from '../lib/format';
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
        <span className="muted small">{year < cur ? `Declaração entregue em ${year + 1}` : 'Ano em andamento'}</span>
        <div className="spacer" />
        <button className="btn primary" onClick={() => exportTaxWorkbook(data, year)}><Icon name="download" size={16} /> Exportar IR {year} (Excel)</button>
      </div>

      <div className="grid grid-4">
        <div className="card card-pad kpi"><div className="label">DARF (6015) no ano</div><div className="value">{money(tax.totals.darf)}</div><div className="sub muted">ações, ETFs, BDRs e FIIs</div></div>
        <div className="card card-pad kpi"><div className="label">Lucro isento em ações</div><div className="value">{money(tax.totals.acoesExemptGain)}</div><div className="sub muted">vendas ≤ {money(ACOES_EXEMPTION, { always: true })}/mês</div></div>
        <div className="card card-pad kpi"><div className="label">Prejuízo a compensar</div><div className="value">{money((tax.months.at(-1)?.comumLossBalance ?? 0) + (tax.months.at(-1)?.fiiLossBalance ?? 0))}</div><div className="sub muted">comum {money(tax.months.at(-1)?.comumLossBalance ?? 0)} · FII {money(tax.months.at(-1)?.fiiLossBalance ?? 0)}</div></div>
        <div className="card card-pad kpi"><div className="label">Proventos recebidos</div><div className="value">{money(income.reduce((s, r) => s + r.dividends + r.jcp + r.fiiIncome + r.other, 0))}</div><div className="sub muted">{income.length} pagador(es)</div></div>
      </div>

      {tax.warnings.map((w) => (
        <div key={w} className="notice"><Icon name="alert" /><span>{w}</span></div>
      ))}

      <div>
        <div className="tabs">
          <button className={tab === 'bens' ? 'on' : ''} onClick={() => setTab('bens')}>Bens e Direitos</button>
          <button className={tab === 'mensal' ? 'on' : ''} onClick={() => setTab('mensal')}>Apuração mensal (DARF)</button>
          <button className={tab === 'rendimentos' ? 'on' : ''} onClick={() => setTab('rendimentos')}>Rendimentos isentos e exclusivos</button>
        </div>

        {tab === 'bens' && (
          <div className="card">
            {!bens.length ? (
              <Empty title={`Nenhum bem em 31/12/${year}`} />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Grupo / Código</th><th>Ativo</th><th>Discriminação</th><th className="num">31/12/{year - 1}</th><th className="num">31/12/{year}</th></tr>
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
                          {!b.asset.cnpj && <div className="small" style={{ color: 'var(--warn-ink)' }}>sem CNPJ</div>}
                        </td>
                        <td>
                          <div className="copy-cell">
                            <span className="desc">{b.description}</span>
                            <button className="icon-btn" title="Copiar" onClick={() => { navigator.clipboard?.writeText(b.description); toast('Discriminação copiada'); }}><Icon name="copy" size={15} /></button>
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
              Os valores são o <b>custo de aquisição</b> (preço médio × quantidade), como pede a Receita — não o valor de mercado. Para renda fixa, confira com o informe de rendimentos do banco. Adicione o CNPJ de cada ativo (no detalhe do ativo) para preencher a ficha.
            </p>
          </div>
        )}

        {tab === 'mensal' && (
          <div className="stack">
            {!active.length ? (
              <div className="card"><Empty title={`Nenhuma venda em ${year}`}>Sem vendas, não há imposto de renda variável a apurar.</Empty></div>
            ) : (
              <>
                {active.some((m) => m.acoesSales || m.etfResult || m.bdrResult) && (
                <div className="card">
                  <div className="card-head"><h2>Operações comuns — ações, ETFs e BDRs (15%)</h2></div>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="table">
                      <thead>
                        <tr><th>Mês</th><th className="num">Vendas de ações</th><th className="num">Resultado ações</th><th className="num">ETFs + BDRs</th><th className="num">Prejuízo usado</th><th className="num">Base de cálculo</th><th className="num">IR 15%</th><th className="num">Saldo prejuízo</th></tr>
                      </thead>
                      <tbody>
                        {active.filter((m) => m.acoesSales || m.etfResult || m.bdrResult || m.comumTax).map((m) => (
                          <tr key={m.month}>
                            <td>{MONTHS_LONG[Number(m.month.slice(5)) - 1]}</td>
                            <td className="num">{money(m.acoesSales, { always: true })}</td>
                            <td className="num">
                              <Delta value={m.acoesResult}>{money(m.acoesResult, { always: true })}</Delta>
                              {m.acoesExempt && m.acoesResult > 0 && <div><span className="chip">isento</span></div>}
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
                    <div className="card-head"><h2>Fundos imobiliários (20%)</h2></div>
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table className="table">
                        <thead><tr><th>Mês</th><th className="num">Vendas</th><th className="num">Resultado</th><th className="num">Prejuízo usado</th><th className="num">IR 20%</th><th className="num">Prejuízo acumulado</th></tr></thead>
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
                  <div className="card-head"><h2>DARF a pagar — código 6015</h2></div>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="table">
                      <thead><tr><th>Apuração</th><th className="num">IR devido</th><th className="num">IRRF (dedo-duro)</th><th className="num">DARF</th><th>Vencimento</th></tr></thead>
                      <tbody>
                        {active.filter((m) => m.totalTax || m.darf || m.darfCarry).map((m) => (
                          <tr key={m.month}>
                            <td>{MONTHS_LONG[Number(m.month.slice(5)) - 1]}</td>
                            <td className="num">{money(m.totalTax, { always: true })}</td>
                            <td className="num">{m.irrfUsed ? `− ${money(m.irrfUsed, { always: true })}` : ''}</td>
                            <td className="num" style={{ fontWeight: 650 }}>
                              {m.darf ? money(m.darf, { always: true }) : <span className="muted small">{m.darfCarry ? `< R$10, acumula (${money(m.darfCarry, { always: true })})` : '—'}</span>}
                            </td>
                            <td>{m.darf ? fmtDate(darfDue(m.month)) : ''}</td>
                          </tr>
                        ))}
                        {!active.some((m) => m.totalTax) && <tr><td colSpan={5} className="muted">Nenhum imposto devido no ano. 🎉</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>

                {active.some((m) => m.cryptoSales) && (
                  <div className="card">
                    <div className="card-head"><h2>Criptoativos — isenção de R$ 35 mil/mês em vendas</h2></div>
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table className="table">
                        <thead><tr><th>Mês</th><th className="num">Vendas</th><th className="num">Ganho</th><th>Situação</th><th className="num">IR (GCAP, cód. 4600)</th></tr></thead>
                        <tbody>
                          {active.filter((m) => m.cryptoSales).map((m) => (
                            <tr key={m.month}>
                              <td>{MONTHS_LONG[Number(m.month.slice(5)) - 1]}</td>
                              <td className="num">{money(m.cryptoSales, { always: true })}</td>
                              <td className="num"><Delta value={m.cryptoGain}>{money(m.cryptoGain, { always: true })}</Delta></td>
                              <td>{m.cryptoExempt ? <span className="chip">isento</span> : <span className="chip">tributável</span>}</td>
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
                    <h2 style={{ fontSize: 15, marginTop: 0 }}>Exterior (apuração anual — Lei 14.754/2023)</h2>
                    <p className="text-2" style={{ margin: 0 }}>
                      Vendas {money(tax.exterior.sales, { always: true })} · resultado <Delta value={tax.exterior.result}>{money(tax.exterior.result, { always: true })}</Delta> · IR estimado 15%: <b>{money(tax.exterior.tax, { always: true })}</b>, pago na declaração anual. Valores considerados em reais conforme lançados.
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
              <div className="card-head"><h2>Rendimentos isentos e não tributáveis</h2></div>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="table">
                  <thead><tr><th>Linha</th><th>Descrição</th><th className="num">Valor</th></tr></thead>
                  <tbody>
                    <tr><td>20</td><td>Ganhos líquidos em operações com ações — vendas até R$ 20 mil/mês</td><td className="num">{money(tax.totals.acoesExemptGain, { always: true })}</td></tr>
                    {income.filter((r) => r.dividends).map((r) => (
                      <tr key={'d' + r.asset.id}><td>09</td><td>Dividendos — {r.asset.ticker}{r.asset.cnpj ? ` (CNPJ ${r.asset.cnpj})` : ''}</td><td className="num">{money(r.dividends, { always: true })}</td></tr>
                    ))}
                    {income.filter((r) => r.fiiIncome).map((r) => (
                      <tr key={'f' + r.asset.id}><td>99</td><td>Rendimentos de FII — {r.asset.ticker}{r.asset.cnpj ? ` (CNPJ ${r.asset.cnpj})` : ''}</td><td className="num">{money(r.fiiIncome, { always: true })}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Rendimentos sujeitos à tributação exclusiva</h2></div>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="table">
                  <thead><tr><th>Linha</th><th>Descrição</th><th className="num">Valor líquido</th></tr></thead>
                  <tbody>
                    {income.filter((r) => r.jcp).map((r) => (
                      <tr key={'j' + r.asset.id}><td>10</td><td>Juros sobre capital próprio — {r.asset.ticker}{r.asset.cnpj ? ` (CNPJ ${r.asset.cnpj})` : ''}</td><td className="num">{money(r.jcp, { always: true })}</td></tr>
                    ))}
                    {!income.some((r) => r.jcp) && <tr><td colSpan={3} className="muted">Nenhum JCP lançado em {year}.</td></tr>}
                  </tbody>
                </table>
              </div>
              <p className="muted small card-pad" style={{ margin: 0 }}>Rendimentos de CDB, Tesouro e fundos também entram aqui (linha 06), com os valores do informe de rendimentos de cada banco.</p>
            </div>
          </div>
        )}
      </div>

      <div className="notice info">
        <Icon name="info" />
        <span>
          Cálculos de apoio seguindo as regras gerais (preço médio com custos, isenção de R$ 20 mil para ações, prejuízos compensados por categoria, IRRF de 0,005%, DARF mínimo de R$ 10). Day trade, opções e casos especiais não são apurados. Confira com os informes das corretoras ou um contador antes de declarar.
        </span>
      </div>
    </div>
  );
}
