const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCompact = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 });
const pct = new Intl.NumberFormat('pt-BR', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

let hidden = false;
export const setHideValues = (v: boolean) => {
  hidden = v;
};

export const money = (v: number | undefined, opts?: { always?: boolean }) =>
  v === undefined || Number.isNaN(v) ? '—' : hidden && !opts?.always ? 'R$ •••••' : brl.format(v);
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
  return `${d}/${m}/${y}`;
};
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const MONTHS_LONG = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
export const fmtMonth = (ym: string) => {
  const [y, m] = ym.split('-');
  return `${MONTHS[Number(m) - 1]}/${y.slice(2)}`;
};

/** Parses "1.234,56", "1234.56", "R$ 1.234,56" → number. */
export function parseNumber(input: unknown): number {
  if (typeof input === 'number') return input;
  if (input === null || input === undefined) return NaN;
  let s = String(input).trim().replace(/R\$|\s/g, '');
  if (s === '' || s === '-') return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
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
