import * as XLSX from 'xlsx';
import type { Data } from './types';
import { CLASS_LABEL, FIXED_KIND_LABEL, INDEXER_LABEL, TX_LABEL, isMarketClass } from './types';
import { allSales, computePositions } from './portfolio';
import { bensEDireitos, computeTaxYear, incomeByAsset } from './tax';
import { today, MONTHS_LONG } from './format';

const r2 = (v: number) => Math.round(v * 100) / 100;

function sheet(rows: Record<string, unknown>[], widths?: number[]) {
  const ws = XLSX.utils.json_to_sheet(rows);
  if (rows.length) {
    const keys = Object.keys(rows[0]);
    ws['!cols'] = keys.map((k, i) => ({ wch: widths?.[i] ?? Math.max(10, k.length + 2) }));
  }
  return ws;
}

export function positionsRows(d: Data) {
  return computePositions(d.assets, d.transactions, d.settings, today())
    .filter((p) => !p.closed)
    .map((p) => ({
      Ativo: p.asset.ticker,
      Nome: p.asset.name ?? '',
      Classe: CLASS_LABEL[p.asset.cls],
      Instituição: p.asset.institution ?? '',
      Quantidade: isMarketClass(p.asset.cls) ? p.quantity : '',
      'Preço médio': isMarketClass(p.asset.cls) ? r2(p.avgPrice) : '',
      'Custo total': r2(p.cost),
      'Preço atual': p.asset.currentPrice ?? '',
      'Valor atual': r2(p.value),
      'Resultado (R$)': r2(p.value - p.cost),
      'Resultado (%)': p.cost ? r2(((p.value - p.cost) / p.cost) * 100) : '',
      'Proventos recebidos': r2(p.income),
      Indexador: p.asset.fixed ? `${INDEXER_LABEL[p.asset.fixed.indexer]} ${p.asset.fixed.rate}` : '',
      Vencimento: p.asset.fixed?.maturity ?? '',
      Tipo: p.asset.fixed ? FIXED_KIND_LABEL[p.asset.fixed.kind] : '',
    }));
}

export function transactionRows(d: Data) {
  const byId = new Map(d.assets.map((a) => [a.id, a]));
  return [...d.transactions]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((t) => {
      const a = byId.get(t.assetId);
      return {
        Data: t.date,
        Tipo: TX_LABEL[t.type],
        Ativo: a?.ticker ?? '?',
        Classe: a ? CLASS_LABEL[a.cls] : '',
        Quantidade: t.type === 'SPLIT' ? `fator ${t.factor}` : t.quantity,
        Preço: t.price,
        Taxas: t.fees || 0,
        Total: r2(t.quantity * t.price),
        Instituição: t.institution ?? '',
        Observação: t.notes ?? '',
      };
    });
}

export function exportWorkbook(d: Data, year?: number) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(positionsRows(d)), 'Posições');
  XLSX.utils.book_append_sheet(wb, sheet(transactionRows(d)), 'Lançamentos');
  if (year) addTaxSheets(wb, d, year);
  XLSX.writeFile(wb, `carteira-${today()}.xlsx`);
}

export function exportTaxWorkbook(d: Data, year: number) {
  const wb = XLSX.utils.book_new();
  addTaxSheets(wb, d, year);
  XLSX.writeFile(wb, `imposto-de-renda-${year}.xlsx`);
}

function addTaxSheets(wb: XLSX.WorkBook, d: Data, year: number) {
  const bens = bensEDireitos(d.assets, d.transactions, d.settings, year);
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      bens.map((b) => ({
        Grupo: b.group,
        Código: b.code,
        Ativo: b.asset.ticker,
        CNPJ: b.asset.cnpj ?? '',
        Discriminação: b.description,
        [`Situação em 31/12/${year - 1}`]: r2(b.prevCost),
        [`Situação em 31/12/${year}`]: r2(b.cost),
      })),
      [7, 7, 14, 20, 90, 20, 20],
    ),
    `Bens e Direitos ${year}`,
  );

  const tax = computeTaxYear(allSales(d.assets, d.transactions), year);
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      tax.months.map((m) => ({
        Mês: MONTHS_LONG[Number(m.month.slice(5)) - 1],
        'Vendas ações': r2(m.acoesSales),
        'Resultado ações': r2(m.acoesResult),
        'Ações isento (≤ R$20k)': m.acoesExempt ? 'Sim' : 'Não',
        'Resultado ETFs': r2(m.etfResult),
        'Resultado BDRs': r2(m.bdrResult),
        'Resultado comum tributável': r2(m.comumResult),
        'Prejuízo compensado': r2(m.comumLossUsed),
        'Prejuízo a compensar': r2(m.comumLossBalance),
        'IR comum (15%)': r2(m.comumTax),
        'Vendas FII': r2(m.fiiSales),
        'Resultado FII': r2(m.fiiResult),
        'Prejuízo FII a compensar': r2(m.fiiLossBalance),
        'IR FII (20%)': r2(m.fiiTax),
        'IRRF (0,005%)': r2(m.irrf),
        'DARF 6015 a pagar': r2(m.darf),
        'Vendas cripto': r2(m.cryptoSales),
        'Ganho cripto': r2(m.cryptoGain),
        'IR cripto (GCAP)': r2(m.cryptoTax),
      })),
    ),
    `Renda Variável ${year}`,
  );

  const inc = incomeByAsset(d.assets, d.transactions, year);
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      inc.map((r) => ({
        Ativo: r.asset.ticker,
        'CNPJ pagadora': r.asset.cnpj ?? '',
        'Dividendos (isento, linha 09)': r2(r.dividends),
        'Rendimentos FII (isento)': r2(r.fiiIncome),
        'JCP (exclusiva, linha 10)': r2(r.jcp),
        Outros: r2(r.other),
      })),
    ),
    `Proventos ${year}`,
  );
}

export function exportCSV(d: Data) {
  const ws = XLSX.utils.json_to_sheet(transactionRows(d));
  const csv = XLSX.utils.sheet_to_csv(ws, { FS: ';' });
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `lancamentos-${today()}.csv`);
}

export function exportBackup(d: Data) {
  download(
    new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }),
    `carteira-backup-${today()}.json`,
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
