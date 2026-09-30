export type AssetClass =
  | 'ACAO'
  | 'FII'
  | 'ETF'
  | 'BDR'
  | 'RENDA_FIXA'
  | 'FUNDO'
  | 'CRIPTO'
  | 'EXTERIOR'
  | 'OUTRO';

/** Classes valued by quantity × price. The rest are valued by amount (R$ aplicado). */
export const MARKET_CLASSES: AssetClass[] = ['ACAO', 'FII', 'ETF', 'BDR', 'CRIPTO', 'EXTERIOR'];
export const isMarketClass = (c: AssetClass) => MARKET_CLASSES.includes(c);

export const CLASS_LABEL: Record<AssetClass, string> = {
  ACAO: 'Ações',
  FII: 'FIIs',
  ETF: 'ETFs',
  BDR: 'BDRs',
  RENDA_FIXA: 'Renda fixa',
  FUNDO: 'Fundos',
  CRIPTO: 'Cripto',
  EXTERIOR: 'Exterior',
  OUTRO: 'Outros',
};

export const CLASS_ORDER: AssetClass[] = [
  'ACAO', 'FII', 'ETF', 'BDR', 'RENDA_FIXA', 'FUNDO', 'CRIPTO', 'EXTERIOR', 'OUTRO',
];

export type FixedKind =
  | 'CDB' | 'LCI' | 'LCA' | 'LC' | 'TESOURO' | 'DEBENTURE' | 'DEBENTURE_INCENTIVADA'
  | 'CRI' | 'CRA' | 'POUPANCA' | 'OUTRO';

export const FIXED_KIND_LABEL: Record<FixedKind, string> = {
  CDB: 'CDB',
  LCI: 'LCI',
  LCA: 'LCA',
  LC: 'LC',
  TESOURO: 'Tesouro Direto',
  DEBENTURE: 'Debênture',
  DEBENTURE_INCENTIVADA: 'Debênture incentivada',
  CRI: 'CRI',
  CRA: 'CRA',
  POUPANCA: 'Poupança',
  OUTRO: 'Outro',
};

export type Indexer = 'CDI' | 'SELIC' | 'IPCA' | 'PRE';

export const INDEXER_LABEL: Record<Indexer, string> = {
  CDI: '% do CDI',
  SELIC: 'Selic +',
  IPCA: 'IPCA +',
  PRE: 'Prefixado',
};

export interface FixedIncomeInfo {
  kind: FixedKind;
  indexer: Indexer;
  /** CDI: percentage of CDI (e.g. 110). SELIC/IPCA: spread in % a.a. PRE: rate in % a.a. */
  rate: number;
  maturity?: string;
  issuer?: string;
}

export type Currency = 'BRL' | 'USD' | 'EUR';
export const CURRENCY_LABEL: Record<Currency, string> = { BRL: 'Real', USD: 'Dólar', EUR: 'Euro' };
export const CURRENCY_SYMBOL: Record<Currency, string> = { BRL: 'R$', USD: 'US$', EUR: '€' };

export interface Asset {
  id: string;
  /** Ticker (PETR4) or a short name for fixed income (CDB Banco X 2028). */
  ticker: string;
  name?: string;
  cls: AssetClass;
  cnpj?: string;
  institution?: string;
  /** Currency prices are quoted in (default BRL). */
  currency?: Currency;
  /** Last known price, in the asset's currency. */
  currentPrice?: number;
  /** Previous close, for the day change. */
  prevClose?: number;
  priceUpdatedAt?: string;
  /** Value-based assets: manually informed current balance. */
  manualValue?: number;
  manualValueDate?: string;
  fixed?: FixedIncomeInfo;
  notes?: string;
  createdAt: string;
}

export type TxType =
  | 'BUY'
  | 'SELL'
  | 'DIVIDEND'
  | 'JCP'
  | 'INCOME'
  | 'SPLIT'
  | 'BONUS';

export const TX_LABEL: Record<TxType, string> = {
  BUY: 'Compra',
  SELL: 'Venda',
  DIVIDEND: 'Dividendo',
  JCP: 'JCP',
  INCOME: 'Rendimento',
  SPLIT: 'Desdobro/Grupamento',
  BONUS: 'Bonificação',
};

export const INCOME_TYPES: TxType[] = ['DIVIDEND', 'JCP', 'INCOME'];

export interface Transaction {
  id: string;
  assetId: string;
  type: TxType;
  /** YYYY-MM-DD */
  date: string;
  /**
   * BUY/SELL (market): units. BONUS: units received.
   * Value-based assets (renda fixa, fundos): always 1, amount in `price`.
   * Income: 1, amount in `price` (net received).
   */
  quantity: number;
  price: number;
  fees: number;
  /** SPLIT: new shares per old share (2 = desdobro 1:2, 0.1 = grupamento 10:1). */
  factor?: number;
  /** Value-based SELL: closes the position (resgate total). */
  closes?: boolean;
  /** Foreign assets: BRL per unit of the asset's currency on the trade date. */
  fxRate?: number;
  institution?: string;
  notes?: string;
  source?: 'manual' | 'b3' | 'csv';
  /** Dedupe key for imported rows. */
  importKey?: string;
  createdAt: string;
}

export interface Settings {
  /** CDI % a.a. used to estimate fixed income. */
  cdiRate: number;
  ipcaRate: number;
  selicRate: number;
  brapiToken?: string;
  finnhubToken?: string;
  twelveDataToken?: string;
  /** BRL per unit of foreign currency. */
  fx: { USD: number; EUR: number; updatedAt?: string };
  livePrices: boolean;
  theme: 'system' | 'light' | 'dark';
  hideValues: boolean;
  lastBackupAt?: string;
}

export interface Data {
  version: 1;
  assets: Asset[];
  transactions: Transaction[];
  settings: Settings;
}
