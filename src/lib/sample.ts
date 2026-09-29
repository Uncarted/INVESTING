import type { Asset, Data, Transaction } from './types';
import { DEFAULT_SETTINGS } from './store';

/** Demo portfolio so the app can be explored before entering real data. */
export function sampleData(): Data {
  const at = '2024-01-01T00:00:00.000Z';
  const assets: Asset[] = [
    { id: 's-itsa', ticker: 'ITSA4', name: 'Itaúsa PN', cls: 'ACAO', institution: 'XP', cnpj: '61.532.644/0001-15', currentPrice: 11.2, createdAt: at },
    { id: 's-wege', ticker: 'WEGE3', name: 'WEG ON', cls: 'ACAO', institution: 'XP', cnpj: '84.429.695/0001-11', currentPrice: 44.9, createdAt: at },
    { id: 's-bbas', ticker: 'BBAS3', name: 'Banco do Brasil ON', cls: 'ACAO', institution: 'Nubank', currentPrice: 22.4, createdAt: at },
    { id: 's-hglg', ticker: 'HGLG11', name: 'CSHG Logística', cls: 'FII', institution: 'XP', currentPrice: 158.3, createdAt: at },
    { id: 's-mxrf', ticker: 'MXRF11', name: 'Maxi Renda', cls: 'FII', institution: 'Nubank', currentPrice: 9.6, createdAt: at },
    { id: 's-ivvb', ticker: 'IVVB11', name: 'iShares S&P 500', cls: 'ETF', institution: 'XP', currentPrice: 392.5, createdAt: at },
    { id: 's-btc', ticker: 'BTC', name: 'Bitcoin', cls: 'CRIPTO', institution: 'Binance', currentPrice: 610000, createdAt: at },
    {
      id: 's-cdb', ticker: 'CDB Inter 2027', cls: 'RENDA_FIXA', institution: 'Inter', createdAt: at,
      fixed: { kind: 'CDB', indexer: 'CDI', rate: 105, maturity: '2027-06-15', issuer: 'Banco Inter' },
    },
    {
      id: 's-lci', ticker: 'LCI Nubank', cls: 'RENDA_FIXA', institution: 'Nubank', createdAt: at,
      fixed: { kind: 'LCI', indexer: 'CDI', rate: 92, maturity: '2026-12-10', issuer: 'Nu Financeira' },
    },
    {
      id: 's-ipca', ticker: 'Tesouro IPCA+ 2035', cls: 'RENDA_FIXA', institution: 'Tesouro Direto', createdAt: at,
      fixed: { kind: 'TESOURO', indexer: 'IPCA', rate: 6.2, maturity: '2035-05-15' },
    },
  ];
  let n = 0;
  const t = (assetId: string, type: Transaction['type'], date: string, quantity: number, price: number, fees = 0, extra: Partial<Transaction> = {}): Transaction => ({
    id: `s-t${n}`, assetId, type, date, quantity, price, fees, institution: assets.find((a) => a.id === assetId)?.institution,
    createdAt: new Date(Date.parse(at) + n++ * 1000).toISOString(), ...extra,
  });
  const transactions: Transaction[] = [
    t('s-itsa', 'BUY', '2024-02-06', 500, 9.85, 4.9),
    t('s-itsa', 'BUY', '2024-08-12', 300, 10.4, 4.9),
    t('s-itsa', 'DIVIDEND', '2024-07-01', 1, 96.0),
    t('s-itsa', 'JCP', '2024-12-20', 1, 142.8),
    t('s-itsa', 'BONUS', '2024-12-23', 40, 1.49),
    t('s-itsa', 'JCP', '2025-08-29', 1, 168.3),
    t('s-wege', 'BUY', '2024-03-11', 100, 36.2, 4.9),
    t('s-wege', 'BUY', '2025-01-15', 60, 52.8, 4.9),
    t('s-wege', 'JCP', '2025-03-12', 1, 34.6),
    t('s-bbas', 'BUY', '2024-04-02', 400, 28.1, 0),
    t('s-bbas', 'SPLIT', '2024-04-16', 0, 0, 0, { factor: 2 }),
    t('s-bbas', 'SELL', '2025-02-18', 800, 27.5, 0),
    t('s-bbas', 'BUY', '2025-06-03', 500, 21.3, 0),
    t('s-bbas', 'DIVIDEND', '2025-09-12', 1, 88.5),
    t('s-hglg', 'BUY', '2024-01-22', 30, 162.4, 0),
    t('s-hglg', 'BUY', '2025-04-08', 20, 151.0, 0),
    ...['2024-06-14', '2024-09-13', '2024-12-13', '2025-03-14', '2025-06-13', '2025-09-15', '2026-03-13', '2026-06-15', '2026-09-15'].map((d) => t('s-hglg', 'INCOME', d, 1, 55 + (d > '2025-04' ? 45 : 0))),
    t('s-mxrf', 'BUY', '2024-05-10', 1000, 10.4, 0),
    t('s-mxrf', 'SELL', '2025-11-05', 400, 9.95, 0),
    ...['2024-07-15', '2024-10-15', '2025-01-15', '2025-04-15', '2025-07-15', '2025-10-15', '2026-01-15', '2026-04-15', '2026-07-15'].map((d) => t('s-mxrf', 'INCOME', d, 1, d > '2025-11' ? 60 : 100)),
    t('s-ivvb', 'BUY', '2024-06-20', 20, 318.0, 0),
    t('s-ivvb', 'BUY', '2025-09-02', 10, 375.5, 0),
    t('s-ivvb', 'SELL', '2026-03-10', 8, 402.0, 0),
    t('s-btc', 'BUY', '2024-03-01', 0.02, 310000, 0),
    t('s-btc', 'BUY', '2025-05-20', 0.015, 590000, 0),
    t('s-cdb', 'BUY', '2024-06-15', 1, 10000),
    t('s-cdb', 'BUY', '2025-02-10', 1, 5000),
    t('s-lci', 'BUY', '2024-12-10', 1, 8000),
    t('s-ipca', 'BUY', '2025-05-15', 1, 6000),
    t('s-wege', 'BUY', '2026-05-04', 40, 47.1, 4.9),
    t('s-itsa', 'BUY', '2026-02-10', 200, 10.9, 4.9),
  ];
  return { version: 1, assets, transactions, settings: { ...DEFAULT_SETTINGS } };
}
