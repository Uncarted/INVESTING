import { getLang, locale, onLangChange } from './i18n';

// Formatters follow the UI language (pt-BR: "R$ 1.234,56" · en-US: "R$1,234.56").
let brl: Intl.NumberFormat;
let brlCompact: Intl.NumberFormat;
let num: Intl.NumberFormat;
let pct: Intl.NumberFormat;
function buildFormatters() {
  const l = locale();
  brl = new Intl.NumberFormat(l, { style: 'currency', currency: 'BRL' });
  brlCompact = new Intl.NumberFormat(l, { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
  num = new Intl.NumberFormat(l, { maximumFractionDigits: 8 });
  pct = new Intl.NumberFormat(l, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  fmtCache.clear();
  const m = getLang() === 'en' ? MONTHS_EN : MONTHS_PT;
  MONTHS.splice(0, 12, ...m[0]);
  MONTHS_LONG.splice(0, 12, ...m[1]);
}
onLangChange(buildFormatters);

const fmtCache = new Map<string, Intl.NumberFormat>();
let hidden = false;
export const setHideValues = (v: boolean) => {
  hidden = v;
};

export const money = (v: number | undefined, opts?: { always?: boolean }) =>
  v === undefined || Number.isNaN(v) ? '—' : hidden && !opts?.always ? 'R$ •••••' : brl.format(v);
/** Formats in any currency: fmtCurrency(12.5, 'USD') → "US$ 12,50". */
export const fmtCurrency = (v: number | undefined, cur: string, opts?: { always?: boolean }) => {
  if (v === undefined || Number.isNaN(v)) return '—';
  if (cur === 'BRL') return money(v, opts);
  const sym = cur === 'USD' ? 'US$' : cur === 'EUR' ? '€' : cur;
  if (hidden && !opts?.always) return `${sym} •••••`;
  const small = Math.abs(v) < 1 && v !== 0;
  const key = cur + (small ? ':s' : '');
  let f = fmtCache.get(key);
  if (!f) fmtCache.set(key, (f = new Intl.NumberFormat(locale(), { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: small ? 4 : 2 })));
  const out = f.format(v);
  // en-US shows plain "$"; always make dollars explicit next to reais.
  return cur === 'USD' && !out.includes('US$') ? out.replace('$', 'US$') : out;
};
export const moneyCompact = (v: number) => (hidden ? '•••' : brlCompact.format(v));
export const qty = (v: number | undefined) => (v === undefined ? '—' : num.format(v));
export const percent = (v: number | undefined) =>
  v === undefined || !Number.isFinite(v) ? '—' : pct.format(v);
export const signedPercent = (v: number | undefined) =>
  v === undefined || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + pct.format(v);

export const today = () => toISODate(new Date());
export const toISODate = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
export const fmtDate = (iso?: string) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return getLang() === 'en' ? `${MONTHS[Number(m) - 1][0].toUpperCase()}${MONTHS[Number(m) - 1].slice(1)} ${Number(d)}, ${y}` : `${d}/${m}/${y}`;
};
const MONTHS_PT: [string[], string[]] = [
  ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'],
  ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'],
];
const MONTHS_EN: [string[], string[]] = [
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
];
/** Short month names in the current language (mutated on language change). */
export const MONTHS = [...MONTHS_PT[0]];
export const MONTHS_LONG = [...MONTHS_PT[1]];
export const fmtMonth = (ym: string) => {
  const [y, m] = ym.split('-');
  return `${MONTHS[Number(m) - 1]}/${y.slice(2)}`;
};

/** Parses "1.234,56", "1234.56", "R$ 1.234,56" → number. */
export function parseNumber(input: unknown): number {
  if (typeof input === 'number') return input;
  if (input === null || input === undefined) return NaN;
  let s = String(input).trim().replace(/R\$|US\$|€|\s/g, '');
  if (s === '' || s === '-') return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  // English UI: "1,500" is fifteen hundred; "1,5" is still read as 1.5.
  if (getLang() === 'en' && hasComma && !hasDot && /,\d{3}(?!\d)/.test(s)) return Number(s.replace(/,/g, ''));
  if (hasComma && hasDot) {
    // whichever comes last is the decimal separator
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  return Number(s);
}

/** Accepts DD/MM/YYYY, YYYY-MM-DD, or an Excel serial / Date. */
export function parseDate(input: unknown): string | null {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return toISODate(input);
  if (typeof input === 'number') {
    // Excel serial date
    const d = new Date(Math.round((input - 25569) * 86400 * 1000));
    return toISODate(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  if (typeof input !== 'string') return null;
  const s = input.trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));

/** Number → text for input fields, with the current decimal separator. */
export const numStr = (n?: number) =>
  n === undefined || n === 0 || !Number.isFinite(n) ? '' : String(Math.round(n * 1e8) / 1e8).replace('.', getLang() === 'en' ? '.' : ',');

buildFormatters();
