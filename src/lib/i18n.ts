/**
 * Minimal i18n: every UI string is written inline as t('português', 'English').
 * The language lives in settings (synced with the account); App calls setLang on each render.
 * Official Brazilian tax terms (DARF, Bens e Direitos…) stay in Portuguese in both languages.
 */
import {
  CLASS_LABEL, CURRENCY_LABEL, FIXED_KIND_LABEL, INDEXER_LABEL, TX_LABEL,
  type AssetClass, type Currency, type FixedKind, type Indexer, type TxType,
} from './types';

export type Lang = 'pt' | 'en';

let lang: Lang = 'pt';
const listeners = new Set<() => void>();

export const getLang = () => lang;
export const t = (pt: string, en: string) => (lang === 'en' ? en : pt);
export const locale = () => (lang === 'en' ? 'en-US' : 'pt-BR');

export const detectLang = (): Lang =>
  typeof navigator !== 'undefined' && !navigator.language?.toLowerCase().startsWith('pt') ? 'en' : 'pt';

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  applyLabels();
  if (typeof document !== 'undefined') document.documentElement.lang = next === 'en' ? 'en' : 'pt-BR';
  listeners.forEach((l) => l());
}
export const onLangChange = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// Shared label maps (mutated in place so every import sees the current language).
const CLASS: Record<Lang, Record<AssetClass, string>> = {
  pt: { ACAO: 'Ações BR', FII: 'FIIs', ETF: 'ETFs', BDR: 'BDRs', RENDA_FIXA: 'Renda fixa', FUNDO: 'Fundos', CRIPTO: 'Cripto', EXTERIOR: 'Ações EUA', OUTRO: 'Outros' },
  en: { ACAO: 'BR stocks', FII: 'REITs (FIIs)', ETF: 'ETFs', BDR: 'BDRs', RENDA_FIXA: 'Fixed income', FUNDO: 'Funds', CRIPTO: 'Crypto', EXTERIOR: 'US stocks', OUTRO: 'Other' },
};
const TX: Record<Lang, Record<TxType, string>> = {
  pt: { BUY: 'Compra', SELL: 'Venda', DIVIDEND: 'Dividendo', JCP: 'JCP', INCOME: 'Rendimento', SPLIT: 'Desdobro/Grupamento', BONUS: 'Bonificação' },
  en: { BUY: 'Buy', SELL: 'Sell', DIVIDEND: 'Dividend', JCP: 'JCP (interest on equity)', INCOME: 'Income', SPLIT: 'Split/Reverse split', BONUS: 'Bonus shares' },
};
const CUR: Record<Lang, Record<Currency, string>> = {
  pt: { BRL: 'Real', USD: 'Dólar', EUR: 'Euro' },
  en: { BRL: 'Real', USD: 'Dollar', EUR: 'Euro' },
};
const KIND: Record<Lang, Record<FixedKind, string>> = {
  pt: { CDB: 'CDB', LCI: 'LCI', LCA: 'LCA', LC: 'LC', TESOURO: 'Tesouro Direto', DEBENTURE: 'Debênture', DEBENTURE_INCENTIVADA: 'Debênture incentivada', CRI: 'CRI', CRA: 'CRA', POUPANCA: 'Poupança', CONTA: 'Conta remunerada / caixinha', OUTRO: 'Outro' },
  en: { CDB: 'CDB', LCI: 'LCI', LCA: 'LCA', LC: 'LC', TESOURO: 'Tesouro Direto', DEBENTURE: 'Debenture', DEBENTURE_INCENTIVADA: 'Tax-free debenture', CRI: 'CRI', CRA: 'CRA', POUPANCA: 'Savings (poupança)', CONTA: 'Yield account / caixinha', OUTRO: 'Other' },
};
const IDX: Record<Lang, Record<Indexer, string>> = {
  pt: { CDI: '% do CDI', SELIC: 'Selic +', IPCA: 'IPCA +', PRE: 'Prefixado' },
  en: { CDI: '% of CDI', SELIC: 'Selic +', IPCA: 'IPCA +', PRE: 'Fixed rate' },
};

/** Portuguese names, for text that goes on Brazilian tax forms. */
export const FIXED_KIND_PT = KIND.pt;

function applyLabels() {
  Object.assign(CLASS_LABEL, CLASS[lang]);
  Object.assign(TX_LABEL, TX[lang]);
  Object.assign(CURRENCY_LABEL, CUR[lang]);
  Object.assign(FIXED_KIND_LABEL, KIND[lang]);
  Object.assign(INDEXER_LABEL, IDX[lang]);
}
