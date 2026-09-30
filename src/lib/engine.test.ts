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
