import type { AssetClass } from './types';

// Common B3 ETFs (end in 11 like FIIs and units, so they need a list).
const KNOWN_ETFS = new Set([
  'BOVA11', 'BOVV11', 'BOVB11', 'BOVX11', 'IVVB11', 'SMAL11', 'SMAC11', 'HASH11', 'QBTC11', 'BITH11',
  'ETHE11', 'QETH11', 'SPXI11', 'SPXB11', 'NASD11', 'XINA11', 'EURP11', 'ACWI11', 'GOLD11', 'DIVO11',
  'FIND11', 'MATB11', 'ECOO11', 'BRAX11', 'PIBB11', 'XBOV11', 'BBSD11', 'IMAB11', 'IB5M11', 'FIXA11',
  'B5P211', 'IRFM11', 'NTNS11', 'DEBB11', 'LFTS11', 'LFTB11', 'WRLD11', 'TECK11', 'USDB11', 'NDIV11',
  'TRIG11', 'GOVE11', 'ESGB11', 'BOVS11', 'SMAB11', 'DIVD11', 'UTEC11', 'AGRI11', 'BDEF11', 'ALUG11',
  'SHOT11', 'TECB11', 'CHIP11', 'WEB311', 'META11', 'DEFI11', 'NFTS11', 'CRPT11', 'BITI11', 'SOLH11',
]);

// Units (end in 11 but are shares packages, taxed as ações).
const KNOWN_UNITS = new Set([
  'TAEE11', 'SANB11', 'KLBN11', 'ALUP11', 'BPAC11', 'ENGI11', 'SAPR11', 'TIET11', 'IGTI11', 'BRBI11',
  'CPLE11', 'AESB11', 'RNEW11', 'SULA11', 'STBP11', 'CEAB11', 'ITSA11', 'PPLA11', 'BIDI11', 'INTB11',
]);

const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'XRP', 'ADA', 'DOGE', 'DOT', 'MATIC', 'LTC', 'AVAX', 'LINK', 'TRX', 'TON']);

/** Removes the fractional-market "F" suffix (PETR4F → PETR4). */
export function normalizeTicker(t: string): string {
  const s = t.trim().toUpperCase();
  const m = s.match(/^([A-Z0-9]{4}\d{1,2})F$/);
  return m ? m[1] : s;
}

export function guessClass(ticker: string): AssetClass | null {
  const t = normalizeTicker(ticker);
  if (CRYPTO.has(t)) return 'CRIPTO';
  if (KNOWN_ETFS.has(t)) return 'ETF';
  if (KNOWN_UNITS.has(t)) return 'ACAO';
  if (/^[A-Z]{4}(3|4|5|6|7|8)$/.test(t)) return 'ACAO';
  if (/^[A-Z]{4}3[2-5]$/.test(t)) return 'BDR';
  if (/^[A-Z]{4}11$/.test(t)) return 'FII';
  if (/^[A-Z]{1,5}$/.test(t)) return 'EXTERIOR';
  return null;
}
