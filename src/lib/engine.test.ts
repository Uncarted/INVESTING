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

describe('extrato mensal Nomad (PDF)', () => {
  it('lê posições, negociações e dividendos', async () => {
    const { buildPdfPreview } = await import('./importers');
    const lines = [
      'Nomad Investment Services Inc.', ' | Account Statement', 'Statement Date: | 2026-03-01 - 2026-03-31',
      ' | PORTFOLIO',
      ' | Description |   | Symbol | Quantity |   | Securities on | Price($) |   | Market Value',
      ' | APPLE INC COM |   | AAPL | 3 |   | 0 |   | 200.00 |   | 600.00 |   | 0.00 |   | 0 |   | 100.00',
      ' | TRADING ACTIVITIES',
      'Type | Date | Date | CUSIP | Amount($) | Fee($) | Fees($)',
      ' | BUY | 2026-03-10 | 2026-03-12 | APPLE INC COM | AAPL | 2 | 190.00 | (380.00) | 0.00',
      ' | NON-TRADING ACTIVITY',
      ' | 2026-03-20 | DIV | APPLE INC CASH DIV | AAPL | 0 | 1.00',
      ' | 2026-03-20 | NRA TAX | APPLE INC NRA WITHHOLD | AAPL | 0 | (0.30)',
    ];
    const p = buildPdfPreview(lines, { assets: [], transactions: [] });
    expect(p.format).toBe('apex');
    expect(p.rows.map((r) => [r.tx.type, r.tx.date, r.ticker, r.tx.quantity, r.tx.price])).toEqual([
      ['BUY', '2026-03-10', 'AAPL', 2, 190],
      ['DIVIDEND', '2026-03-20', 'AAPL', 1, 0.7],
      ['BUY', '2026-03-31', 'AAPL', 1, 200], // the share bought before this statement
    ]);
  });
});

describe('leitor genérico de negociações', () => {
  it('confirmação de compra (Nomad/Apex em português)', async () => {
    const { buildGenericPreview } = await import('./importers');
    const lines = [
      'Confirmação', 'Você | comprou',
      'negociação | liquidação | Símbolo | QTD | Preço | bruto | COM | transação | adicionais | Valor líquido',
      '2026-02-04 | 2026-02-05 | TTWO | 2,44498 | 204,50 | 500,00 | 0,00 | 0,00 | 0,00 | 500,00',
      'DESC: | TAKE-TWO INTERACTIVE SOFTWARE COM | Trade#: | 14RR5RZVB1J',
    ];
    const p = buildGenericPreview(lines, { assets: [], transactions: [] });
    expect(p.rows.map((r) => [r.tx.type, r.tx.date, r.ticker, r.cls, r.tx.quantity, r.tx.price])).toEqual([['BUY', '2026-02-04', 'TTWO', 'EXTERIOR', 2.44498, 204.5]]);
  });
  it('planilha qualquer com C/V e ticker da B3', async () => {
    const { buildGenericPreview } = await import('./importers');
    const lines = ['Dia | Operação | Papel | Qtde | Preço', '15/03/2026 | C | PETR4 | 100 | 38,50', '20/03/2026 | V | PETR4 | 50 | 41,20'];
    const p = buildGenericPreview(lines, { assets: [], transactions: [] });
    expect(p.rows.map((r) => [r.tx.type, r.tx.date, r.ticker, r.tx.quantity, r.tx.price])).toEqual([
      ['BUY', '2026-03-15', 'PETR4', 100, 38.5],
      ['SELL', '2026-03-20', 'PETR4', 50, 41.2],
    ]);
  });
});

describe('leitura com IA', () => {
  it('remove dados pessoais antes de enviar', async () => {
    const { redactForAi } = await import('./importers');
    const text = redactForAi([
      'Cliente: | FULANO DE TAL', 'CPF: 123.456.789-09', 'Rua das Flores, 10 - CEP 01234-567', 'E-mail: a@b.com', 'obs a@b.com',
      '2026-02-04 | TTWO | 2,5 | 200,00', 'Telefone: +55 (11) 98765-4321',
    ]);
    expect(text).toBe('obs [email]\n2026-02-04 | TTWO | 2,5 | 200,00');
  });
  it('converte itens da IA em lançamentos', async () => {
    const { buildAiPreview } = await import('./importers');
    const p = buildAiPreview(
      {
        institution: 'XP Investimentos', statementDate: '2026-05-31',
        items: [
          { kind: 'trade', date: '2026-05-10', side: 'BUY', ticker: 'petr4', assetType: 'stock_br', quantity: 100, price: 38.5, currency: 'BRL' },
          { kind: 'dividend', date: '2026-05-20', ticker: 'ITSA4', assetType: 'stock_br', amount: 42.1, currency: 'BRL', dividendType: 'JCP' },
          { kind: 'position', ticker: 'CDB Banco X', name: 'CDB Banco X', assetType: 'fixed_income', amount: 5100, rate: '110% CDI', maturity: '2028-01-01', currency: 'BRL' },
          { kind: 'cash', assetType: 'cash', amount: 250, currency: 'BRL' },
        ],
      },
      { assets: [], transactions: [] },
    );
    expect(p.rows.map((r) => [r.cls, r.tx.type, r.ticker, r.tx.quantity, r.tx.price])).toEqual([
      ['ACAO', 'BUY', 'PETR4', 100, 38.5],
      ['ACAO', 'JCP', 'ITSA4', 1, 42.1],
      ['RENDA_FIXA', 'BUY', 'CDB Banco X XP 110% CDI', 1, 5100],
      ['CAIXA', 'BUY', 'Reais XP', 250, 1],
    ]);
    expect(p.rows[2].fixed).toMatchObject({ indexer: 'CDI', rate: 110, maturity: '2028-01-01' });
  });
});

describe('dólar digital (DolarApp / USDc)', () => {
  it('extrato da DolarApp vira saldo em dólar', async () => {
    const { buildPdfPreview } = await import('./importers');
    const lines = [
      'Dólares digitales Estado de Cuenta', 'DÓLARAPP MÉXICO S.A. DE C.V.',
      'Fecha de inicio | 1 September | Balance de inicio | $ 4,038.28', '2026 | Ingresos | $ 7,167.17', 'Fecha de fin',
      'Duración | 30 September | Retiros | $ 5,503.00', 'Balance Final | $ 5,702.45', '2026',
    ];
    const p = buildPdfPreview(lines, { assets: [], transactions: [] });
    expect(p.rows.map((r) => [r.ticker, r.cls, r.tx.date, r.tx.quantity])).toEqual([['Dólar DolarApp', 'CAIXA', '2026-09-30', 5702.45]]);
  });
  it('IA: USDC vira dólar em conta, não cripto', async () => {
    const { buildAiPreview } = await import('./importers');
    const p = buildAiPreview({ institution: 'DolarApp', items: [
      { kind: 'position', ticker: 'USDC', assetType: 'crypto', quantity: 5702.45, currency: 'USD' },
      { kind: 'trade', side: 'SELL', ticker: 'USDC', assetType: 'crypto', quantity: 1000, price: 5.13, currency: 'BRL' },
    ] }, { assets: [], transactions: [] });
    expect(p.rows.map((r) => [r.cls, r.tx.quantity, r.assetExtra?.currency])).toEqual([['CAIXA', 5702.45, 'USD']]);
  });
  it('cripto é sempre cotada em reais', async () => {
    const { currencyOf } = await import('./portfolio');
    expect(currencyOf({ id: 'x', ticker: 'USDC', cls: 'CRIPTO', currency: 'USD', createdAt: '' })).toBe('BRL');
  });
});

describe('B3 posição', () => {
  it('confere quantidades: ajusta, adiciona e zera', async () => {
    const { buildPreview, materialize } = await import('./importers');
    const bbas = asset('p1', 'BBAS3', 'ACAO');
    const itsa = asset('p2', 'ITSA4', 'ACAO');
    const old = asset('p3', 'MXRF11', 'FII');
    const txs = [tx('p1', 'BUY', '2024-01-10', 1000, 30), tx('p2', 'BUY', '2024-01-10', 100, 10), tx('p3', 'BUY', '2024-01-10', 50, 10)];
    const rows = [
      { Produto: 'BBAS3 - BANCO DO BRASIL S/A', 'Instituição': 'XP INVESTIMENTOS CCTVM S/A', 'Código de Negociação': 'BBAS3', Quantidade: 2000, 'Preço de Fechamento': 15 },
      { Produto: 'ITSA4 - ITAUSA S.A.', 'Instituição': 'XP INVESTIMENTOS CCTVM S/A', 'Código de Negociação': 'ITSA4', Quantidade: 100, 'Preço de Fechamento': 11 },
      { Produto: 'WEGE3 - WEG S.A.', 'Instituição': 'XP INVESTIMENTOS CCTVM S/A', 'Código de Negociação': 'WEGE3', Quantidade: 10, 'Preço de Fechamento': 40 },
    ];
    const p = buildPreview(rows, { assets: [bbas, itsa, old], transactions: txs });
    expect(p.format).toBe('posicao');
    expect(p.rows.map((r) => [r.ticker, r.tx.type, r.tx.factor ?? r.tx.quantity])).toEqual([
      ['BBAS3', 'SPLIT', 2],
      ['WEGE3', 'BUY', 10],
      ['MXRF11', 'SPLIT', 0],
    ]);
    const { txs: added } = materialize(p.rows, [bbas, itsa, old]);
    const all = [...txs, ...added.map((x, i) => ({ ...x, id: 'n' + i, createdAt: '2025-01-01' }))];
    const b = runMarket(bbas, all.filter((x) => x.assetId === 'p1'));
    expect(b.quantity).toBe(2000);
    expect(b.cost).toBe(30000); // average price 15
    expect(runMarket(old, all.filter((x) => x.assetId === 'p3')).quantity).toBe(0);
  });
});
