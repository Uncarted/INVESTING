/**
 * Brazilian investment funds (CVM registry), published next to the site as funds.json
 * by the deploy workflow. Loaded on first search only.
 */
export interface Fund {
  name: string;
  cnpj: string;
  cls: 'R' | 'M' | 'A' | 'C';
}

let list: Promise<{ f: Fund; key: string }[]> | null = null;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const src = () => (location.protocol.startsWith('http') ? './funds.json' : 'https://uncarted.github.io/INVESTING/funds.json');

function load() {
  list ??= fetch(src())
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: [string, string, Fund['cls']][]) => rows.map(([name, cnpj, cls]) => ({ f: { name, cnpj, cls }, key: fold(name) + ' ' + cnpj.replace(/\D/g, '') })))
    .catch(() => {
      list = null;
      return [];
    });
  return list;
}

export async function searchFunds(q: string, limit = 10): Promise<Fund[]> {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const all = await load();
  const hits: { f: Fund; score: number }[] = [];
  for (const x of all) {
    if (!words.every((w) => x.key.includes(w))) continue;
    hits.push({ f: x.f, score: (x.key.startsWith(words[0]) ? 0 : 1) * 1000 + x.key.length });
    if (hits.length > 400) break;
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, limit).map((h) => h.f);
}

const SHORT: [RegExp, string][] = [
  [/FUNDO DE INVESTIMENTO EM COTAS DE FUNDOS DE INVESTIMENTO/g, 'FIC FI'],
  [/FUNDO DE INVESTIMENTO EM COTAS DE FUNDO DE INVESTIMENTO/g, 'FIC FI'],
  [/FUNDO DE INVESTIMENTO FINANCEIRO/g, 'FIF'],
  [/FUNDO DE INVESTIMENTO/g, 'FI'],
  [/RESPONSABILIDADE LIMITADA/g, 'RL'],
  [/CR[EÉ]DITO PRIVADO/g, 'CP'],
  [/LONGO PRAZO/g, 'LP'],
  [/MULTIMERCADO/g, 'MULTIMERCADO'],
];
const KEEP_UPPER = new Set(['FI', 'FIC', 'FIF', 'RL', 'CP', 'LP', 'DI', 'IPCA', 'BTG', 'XP', 'ITAU', 'BB', 'CDI', 'RF', 'FIA', 'FIM', 'II', 'III', 'IV', 'ESG', 'USD', 'IMA', 'IMA-B', 'IRF-M', 'S.A.', 'SA']);

/** "TREND DI FUNDO DE INVESTIMENTO RENDA FIXA SIMPLES" → "Trend DI FI Renda Fixa Simples". */
export function prettyFund(name: string) {
  let s = name.toUpperCase();
  for (const [re, to] of SHORT) s = s.replace(re, to);
  return s
    .split(' ')
    .map((w) => (KEEP_UPPER.has(w) || /\d/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ')
    .replace(/\s+-\s+/g, ' – ');
}

export const FUND_CLASS = (c: Fund['cls'], pt: boolean) =>
  ({ R: pt ? 'Renda fixa' : 'Fixed income', M: pt ? 'Multimercado' : 'Multi-market', A: pt ? 'Ações' : 'Equity', C: pt ? 'Cambial' : 'FX' })[c];
