import { describe, expect, it } from 'vitest';
import type { Asset, Settings, Transaction } from './types';
import { allSales, computePositions, runMarket } from './portfolio';
import { computeTaxYear, bensEDireitos } from './tax';
import { guessClass, normalizeTicker } from './classify';
import { parseNumber, parseDate } from './format';

const settings: Settings = { cdiRate: 10, ipcaRate: 4, selicRate: 10, theme: 'system', hideValues: false, fx: { USD: 5, EUR: 6 }, livePrices: false };
const asset = (id: string, ticker: string, cls: Asset['cls'], extra: Partial<Asset> = {}): Asset => ({
  id, ticker, cls, createdAt: '2024-01-01', ...extra,
});
let n = 0;
const tx = (assetId: string, type: Transaction['type'], date: string, quantity: number, price: number, extra: Partial<Transaction> = {}): Transaction => ({
  id: `t${n++}`, assetId, type, date, quantity, price, fees: 0, createdAt: `2024-01-01T00:00:${String(n).padStart(2, '0')}`, ...extra,
});

describe('preço médio', () => {
  it('includes fees in cost and keeps the average on sells', () => {
    const a = asset('a', 'PETR4', 'ACAO');
    const st = runMarket(a, [
      tx('a', 'BUY', '2024-01-10', 100, 30, { fees: 10 }),
      tx('a', 'BUY', '2024-02-10', 100, 40),
      tx('a', 'SELL', '2024-03-10', 50, 50, { fees: 5 }),
    ]);
    // cost 3010 + 4000 = 7010 → avg 35.05
    expect(st.quantity).toBe(150);
    expect(st.cost).toBeCloseTo(35.05 * 150, 6);
    expect(st.sales[0].gain).toBeCloseTo(50 * 50 - 5 - 35.05 * 50, 6);
  });

  it('handles splits and bonus shares', () => {
    const a = asset('a', 'ITSA4', 'ACAO');
    const st = runMarket(a, [
      tx('a', 'BUY', '2024-01-10', 100, 10),
      tx('a', 'SPLIT', '2024-02-01', 0, 0, { factor: 2 }),
      tx('a', 'BONUS', '2024-03-01', 20, 5),
    ]);
    expect(st.quantity).toBe(220);
    expect(st.cost).toBe(1100);
  });
});

describe('IR', () => {
  it('exempts ações sales up to R$20k and taxes above', () => {
    const a = asset('a', 'VALE3', 'ACAO');
    const txs = [
      tx('a', 'BUY', '2024-01-02', 1000, 10),
      tx('a', 'SELL', '2024-02-05', 100, 15), // 1.5k sale, 500 gain, exempt
      tx('a', 'SELL', '2024-03-05', 900, 30), // 27k sale, 18k gain, taxed
    ];
    const y = computeTaxYear(allSales([a], txs), 2024);
    expect(y.months[1].acoesExempt).toBe(true);
    expect(y.months[1].acoesExemptGain).toBe(500);
    expect(y.months[2].acoesExempt).toBe(false);
    expect(y.months[2].comumTax).toBeCloseTo(18000 * 0.15, 6);
    // IRRF 0,005% deducted
    // IRRF from February (R$1.5k sale) also carries into March
    expect(y.months[2].darf).toBeCloseTo(2700 - 28500 * 0.00005, 1);
  });

  it('carries losses forward and keeps FII separate', () => {
    const a = asset('a', 'BBAS3', 'ACAO');
    const f = asset('f', 'HGLG11', 'FII');
    const txs = [
      tx('a', 'BUY', '2024-01-02', 1000, 30),
      tx('a', 'SELL', '2024-01-20', 1000, 25), // 25k sale, −5k loss
      tx('a', 'BUY', '2024-02-02', 1000, 20),
      tx('a', 'SELL', '2024-03-20', 1000, 28), // 28k sale, +8k gain → base 3k
      tx('f', 'BUY', '2024-01-02', 10, 100),
      tx('f', 'SELL', '2024-03-02', 10, 150), // +500 FII, 20%
    ];
    const y = computeTaxYear(allSales([a, f], txs), 2024);
    expect(y.months[0].comumLossBalance).toBe(5000);
    expect(y.months[2].comumBase).toBe(3000);
    expect(y.months[2].fiiTax).toBe(100);
  });

  it('bens e direitos shows previous and current year-end cost', () => {
    const a = asset('a', 'WEGE3', 'ACAO', { institution: 'XP' });
    const txs = [tx('a', 'BUY', '2023-05-02', 10, 30), tx('a', 'BUY', '2024-05-02', 10, 40)];
    const b = bensEDireitos([a], txs, settings, 2024);
    expect(b[0].prevCost).toBe(300);
    expect(b[0].cost).toBe(700);
    expect(b[0].group).toBe('03');
    expect(b[0].description).toContain('WEGE3');
  });
});

describe('renda fixa', () => {
  it('compounds the rate and closes on full redemption', () => {
    const a = asset('c', 'CDB X', 'RENDA_FIXA', { fixed: { kind: 'CDB', indexer: 'CDI', rate: 100 } });
    const txs = [tx('c', 'BUY', '2024-01-01', 1, 1000)];
    const [p] = computePositions([a], txs, settings, '2024-12-31');
    expect(p.cost).toBe(1000);
    expect(p.value).toBeGreaterThan(1090);
    expect(p.value).toBeCloseTo(1100, 0);
    const [q] = computePositions([a], [...txs, tx('c', 'SELL', '2024-07-01', 1, 1050, { closes: true })], settings, '2024-12-31');
    expect(q.closed).toBe(true);
    expect(q.realized).toBe(50);
  });
});

describe('parsing', () => {
  it('parses numbers, dates and tickers', () => {
    expect(parseNumber('R$ 1.234,56')).toBe(1234.56);
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseDate('05/03/2024')).toBe('2024-03-05');
    expect(normalizeTicker('petr4f')).toBe('PETR4');
    expect(guessClass('HGLG11')).toBe('FII');
    expect(guessClass('BOVA11')).toBe('ETF');
    expect(guessClass('AAPL34')).toBe('BDR');
    expect(guessClass('TAEE11')).toBe('ACAO');
  });
});

describe('importers', () => {
  it('reads B3 negociação rows and dedupes on re-import', async () => {
    const { buildPreview, materialize, prettyInstitution } = await import('./importers');
    const rows = [
      { 'Data do Negócio': '15/01/2025', 'Tipo de Movimentação': 'Compra', Mercado: 'Mercado Fracionário', Instituição: 'XP INVESTIMENTOS CCTVM S/A', 'Código de Negociação': 'PETR4F', Quantidade: 7, Preço: 38.5 },
      { 'Data do Negócio': '15/01/2025', 'Tipo de Movimentação': 'Compra', Mercado: 'Opção de Compra', Instituição: 'XP', 'Código de Negociação': 'PETRD400', Quantidade: 100, Preço: 0.5 },
    ];
    const p = buildPreview(rows, { assets: [], transactions: [] });
    expect(p.format).toBe('negociacao');
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].ticker).toBe('PETR4');
    expect(p.rows[0].tx.institution).toBe('XP');
    const { created, txs } = materialize(p.rows, []);
    const again = buildPreview(rows, { assets: created, transactions: txs.map((t, i) => ({ ...t, id: String(i), createdAt: '' })) });
    expect(again.rows[0].duplicate).toBe(true);
    expect(prettyInstitution('NU INVEST CORRETORA DE VALORES S.A.')).toBe('NuInvest');
  });
});

describe('moeda estrangeira', () => {
  it('converts USD trades at the trade-date rate and values at today’s rate', () => {
    const a = asset('u', 'AMD', 'EXTERIOR', { currentPrice: 150 });
    const txs = [
      tx('u', 'BUY', '2025-01-10', 10, 100, { fxRate: 6 }),
      tx('u', 'SELL', '2025-06-10', 4, 120, { fxRate: 5.5 }),
    ];
    const [p] = computePositions([a], txs, settings, '2025-12-31');
    expect(p.currency).toBe('USD');
    expect(p.avgPriceNative).toBe(100);
    expect(p.cost).toBe(6 * 100 * 6);
    expect(p.valueNative).toBe(900);
    expect(p.value).toBe(900 * 5);
    const [s] = allSales([a], txs, settings);
    expect(s.gain).toBeCloseTo(4 * 120 * 5.5 - 4 * 600, 6);
  });
});

describe('busca de tickers', () => {
  it('finds by ticker and by company name', async () => {
    const { searchDirectory } = await import('./tickers');
    expect(searchDirectory('ttwo')[0].symbol).toBe('TTWO');
    expect(searchDirectory('take')[0].symbol).toBe('TTWO');
    expect(searchDirectory('petrobras')[0].symbol).toBe('PETR4');
    expect(searchDirectory('amd')[0].symbol).toBe('AMD');
    expect(searchDirectory('bitcoin')[0].symbol).toBe('BTC');
    expect(searchDirectory('hglg')[0].kind).toBe('F');
    expect(searchDirectory('itau').map((t) => t.symbol)).toContain('ITUB4');
  });
});

describe('IR de uma venda', () => {
  it('estimates exempt, taxable, FII and foreign sales', async () => {
    const { estimateSaleTax } = await import('./tax');
    const acao = asset('b', 'BBAS3', 'ACAO');
    const fii = asset('f', 'HGLG11', 'FII');
    const us = asset('u', 'TTWO', 'EXTERIOR', { currency: 'USD' });
    const txs = [
      tx('b', 'BUY', '2025-01-02', 1000, 20),
      tx('f', 'BUY', '2025-01-02', 100, 100),
      tx('u', 'BUY', '2025-01-02', 10, 150, { fxRate: 5 }),
    ];
    const all = [acao, fii, us];
    const sell = (id: string, date: string, q: number, p: number, extra: Partial<Transaction> = {}) => tx(id, 'SELL', date, q, p, extra);

    // 500 × 30 = R$ 15k sold in the month → exempt
    const e1 = estimateSaleTax(all, txs, settings, sell('b', '2025-03-10', 500, 30))!;
    expect(e1.kind).toBe('exempt-stocks');
    expect(e1.tax).toBe(0);
    expect(e1.gain).toBe(5000);

    // 1000 × 30 = R$ 30k → 15% of R$ 10k
    const e2 = estimateSaleTax(all, txs, settings, sell('b', '2025-03-10', 1000, 30))!;
    expect(e2.kind).toBe('monthly');
    expect(e2.tax).toBeCloseTo(1500, 6);
    expect(e2.dueDate).toBe('2025-04-30');

    // FII: 20% with no exemption
    const e3 = estimateSaleTax(all, txs, settings, sell('f', '2025-03-10', 100, 110))!;
    expect(e3.tax).toBeCloseTo(200, 6);

    // Foreign: 15% of the gain in BRL, no exemption, paid yearly
    const e4 = estimateSaleTax(all, txs, settings, sell('u', '2025-03-10', 10, 200, { fxRate: 5 }))!;
    expect(e4.kind).toBe('annual');
    expect(e4.tax).toBeCloseTo(0.15 * (10 * 200 * 5 - 10 * 150 * 5), 6);
  });
});

describe('importar corretora dos EUA', () => {
  it('reconhece compras, vendas e dividendos em dólar', async () => {
    const { buildPreview } = await import('./importers');
    const rows = [
      { Date: '03/15/2024', Symbol: 'TTWO', Action: 'Buy', Quantity: '2', Price: '$150.25', Amount: '-$300.50', Fees: '0' },
      { Date: '04/20/2024', Symbol: 'TTWO', Action: 'Sell', Quantity: '1', Price: '160', Amount: '160', Fees: '0' },
      { Date: '05/02/2024', Symbol: 'AAPL', Action: 'Dividend', Quantity: '', Price: '', Amount: '1.20', Fees: '' },
      { Date: '05/02/2024', Symbol: 'AAPL', Action: 'Dividend Tax', Quantity: '', Price: '', Amount: '-0.36', Fees: '' },
    ];
    const p = buildPreview(rows, { assets: [], transactions: [] });
    expect(p.format).toBe('us-broker');
    expect(p.rows.map((r) => [r.tx.type, r.tx.date, r.ticker, r.cls, r.tx.quantity, r.tx.price])).toEqual([
      ['BUY', '2024-03-15', 'TTWO', 'EXTERIOR', 2, 150.25],
      ['SELL', '2024-04-20', 'TTWO', 'EXTERIOR', 1, 160],
      ['DIVIDEND', '2024-05-02', 'AAPL', 'EXTERIOR', 1, 1.2],
    ]);
  });
});

describe('importar extrato do banco', () => {
  it('pega só caixinha/RDB do CSV do Nubank', async () => {
    const { buildPreview, materialize } = await import('./importers');
    const rows = [
      { Data: '05/01/2026', Valor: '-1000.00', Identificador: 'a1', 'Descrição': 'Aplicação RDB' },
      { Data: '06/01/2026', Valor: '-45.90', Identificador: 'a2', 'Descrição': 'Compra no débito - Padaria' },
      { Data: '20/02/2026', Valor: '300.00', Identificador: 'a3', 'Descrição': 'Resgate RDB' },
      { Data: '01/03/2026', Valor: '2500.00', Identificador: 'a4', 'Descrição': 'Transferência recebida pelo Pix' },
    ];
    const p = buildPreview(rows, { assets: [], transactions: [] });
    expect(p.format).toBe('bank');
    expect(p.rows.map((r) => [r.tx.type, r.tx.date, r.tx.price, r.ticker])).toEqual([
      ['BUY', '2026-01-05', 1000, 'CDB Nubank 100% CDI liquidez diária'],
      ['SELL', '2026-02-20', 300, 'CDB Nubank 100% CDI liquidez diária'],
    ]);
    const { created } = materialize(p.rows, []);
    expect(created).toHaveLength(1);
    expect(created[0].fixed).toMatchObject({ kind: 'CDB', indexer: 'CDI', rate: 100, daily: true });
    expect(created[0].institution).toBe('Nubank');
  });

  it('lê OFX', async () => {
    const { parseOfx, buildPreview } = await import('./importers');
    const ofx = `OFXHEADER:100\n<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>Banco Inter</ORG></FI></SONRS></SIGNONMSGSRSV1><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260110120000<TRNAMT>-500.00<MEMO>Aplicação CDB Liquidez Diária</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260111<TRNAMT>-80.00<MEMO>Pix enviado</STMTTRN>
</BANKTRANLIST></OFX>`;
    const { rows, bank } = parseOfx(ofx);
    expect(bank).toBe('Inter');
    const p = buildPreview(rows, { assets: [], transactions: [] }, { bank });
    expect(p.rows.map((r) => [r.tx.type, r.tx.date, r.tx.price])).toEqual([['BUY', '2026-01-10', 500]]);
  });
});

describe('extrato de custódia (PDF)', () => {
  const lines = [
    'Custódia em: 30/09/2026',
    ' | NU PAGAMENTOS S.A.',
    ' | Custódia em Caixinhas',
    ' | Caixinha "Viagem"',
    ' | Tipo de Ativo | Emissor | Saldo Bruto (R$) | IR (R$) | IOF (R$) | Saldo Líquido (R$) | Disponível em',
    ' | RDB Resgate Imediato | Nubank | 1.234,56 | 10,00 | 0,00 | 1.224,56 | No mesmo dia',
    ' | Custódia em Renda Fixa',
    ' | CDB Pós-fixado',
    'Nubank | 30/11/2027 | 120% CDI | 2.000,00 | 15/01/2026 | 2.150,00 | 20,00 | 0,00 | 2.130,00 | No vencimento',
  ];
  it('cria caixinhas e CDBs com o saldo do dia', async () => {
    const { buildCustodyPreview, materialize } = await import('./importers');
    const p = buildCustodyPreview(lines, { assets: [], transactions: [] });
    expect(p.rows.map((r) => [r.ticker, r.tx.date, r.tx.price, r.balance?.value])).toEqual([
      ['Caixinha Viagem', '2026-09-30', 1234.56, 1234.56],
      ['CDB Nubank 120% CDI 2027', '2026-01-15', 2000, 2150],
    ]);
    expect(p.rows[1].fixed).toMatchObject({ kind: 'CDB', indexer: 'CDI', rate: 120, maturity: '2027-11-30' });
    const m = materialize(p.rows, []);
    // Importing again later only updates balances.
    const again = buildCustodyPreview(lines, { assets: m.created, transactions: [] });
    expect(again.rows.every((r) => r.balanceOnly)).toBe(true);
    expect(materialize(again.rows, m.created).txs).toHaveLength(0);
  });
});
