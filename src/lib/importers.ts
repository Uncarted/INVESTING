import * as XLSX from 'xlsx';
import type { Asset, AssetClass, Transaction, TxType } from './types';
import { CLASS_LABEL, isMarketClass } from './types';
import { guessClass, normalizeTicker } from './classify';
import { parseDate, parseNumber } from './format';
import { newAsset } from './store';
import { t } from './i18n';

export type Row = Record<string, unknown>;

export interface PreviewRow {
  key: string;
  ticker: string;
  name?: string;
  cls: AssetClass;
  tx: Omit<Transaction, 'id' | 'createdAt' | 'assetId'>;
  duplicate: boolean;
  warning?: string;
}

export interface ImportPreview {
  format: string;
  rows: PreviewRow[];
  skipped: Record<string, number>;
}

export async function readSheet(file: File): Promise<Row[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true, raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Row>(ws, { defval: '', raw: true });
}

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Case/accent-insensitive column getter. */
function getter(row: Row) {
  const map = new Map(Object.keys(row).map((k) => [norm(k), k]));
  return (...names: string[]) => {
    for (const n of names) {
      const k = map.get(norm(n));
      if (k !== undefined) return row[k];
    }
    return undefined;
  };
}

// Column names used by US brokers (Nomad, Avenue, Inter Global, IBKR, Schwab…), in English or Portuguese.
const US_COLS = {
  date: ['tradedate', 'date', 'transactiondate', 'activitydate', 'settledate', 'datadaoperacao', 'datadanegociacao', 'data'],
  symbol: ['symbol', 'ticker', 'instrument', 'stock', 'simbolo', 'ativo', 'codigo'],
  action: ['action', 'side', 'type', 'transactiontype', 'activity', 'activitytype', 'buysell', 'operacao', 'tipo', 'tipodeoperacao'],
  qty: ['quantity', 'qty', 'shares', 'units', 'quantidade', 'qtd'],
  price: ['price', 'priceusd', 'unitprice', 'tradeprice', 'preco', 'precounitario', 'precomedio'],
  amount: ['amount', 'netamount', 'total', 'value', 'grossamount', 'proceeds', 'valor', 'valortotal'],
  fees: ['commission', 'commissions', 'fees', 'fee', 'taxas', 'corretagem'],
};
const hasAny = (keys: Set<string>, names: string[]) => names.some((n) => keys.has(n));

function detect(rows: Row[]): 'negociacao' | 'movimentacao' | 'template' | 'us-broker' | null {
  if (!rows.length) return null;
  const keys = new Set(Object.keys(rows[0]).map(norm));
  if (keys.has('codigodenegociacao') && keys.has('tipodemovimentacao')) return 'negociacao';
  if (keys.has('entradasaida') && keys.has('movimentacao') && keys.has('produto')) return 'movimentacao';
  if (keys.has('data') && keys.has('tipo') && keys.has('ativo') && keys.has('classe')) return 'template';
  if (hasAny(keys, US_COLS.date) && hasAny(keys, US_COLS.symbol) && hasAny(keys, US_COLS.action) && (hasAny(keys, US_COLS.qty) || hasAny(keys, US_COLS.amount)))
    return 'us-broker';
  if (keys.has('data') && keys.has('tipo') && keys.has('ativo')) return 'template';
  return null;
}

/** US exports often use MM/DD/YYYY; Brazilian apps DD/MM/YYYY. Decide from the whole file. */
function dateOrder(values: unknown[]): 'dmy' | 'mdy' {
  for (const v of values) {
    const m = typeof v === 'string' && v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (!m) continue;
    if (Number(m[1]) > 12) return 'dmy';
    if (Number(m[2]) > 12) return 'mdy';
  }
  return 'mdy';
}
function parseDateOrder(v: unknown, order: 'dmy' | 'mdy'): string | null {
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (m) {
      const [a, b] = order === 'dmy' ? [m[1], m[2]] : [m[2], m[1]];
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    }
  }
  return parseDate(v);
}
/** "$1,234.56", "(12.50)", "-3" → number (US formatting). */
function usNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return NaN;
  let s = String(v).trim();
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()$\s-]|USD|US\$/gi, '');
  // "1.234,56" (Brazilian style) vs "1,234.56"
  if (s.includes(',') && (!s.includes('.') || s.lastIndexOf(',') > s.lastIndexOf('.'))) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return neg ? -n : n;
}

/** Builds an order-stable dedupe key: identical rows in the same file get #1, #2… */
function keyer(prefix: string) {
  const seen = new Map<string, number>();
  return (parts: unknown[]) => {
    const base = prefix + '|' + parts.map((p) => String(p)).join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  };
}

export function buildPreview(rows: Row[], existing: { assets: Asset[]; transactions: Transaction[] }): ImportPreview {
  const format = detect(rows);
  const keys = new Set(existing.transactions.map((t) => t.importKey).filter(Boolean));
  const out: PreviewRow[] = [];
  const skipped: Record<string, number> = {};
  const skip = (r: string) => (skipped[r] = (skipped[r] ?? 0) + 1);
  const clsOf = (ticker: string, fallback: AssetClass = 'ACAO') =>
    existing.assets.find((a) => a.ticker === ticker)?.cls ?? guessClass(ticker) ?? fallback;

  if (format === 'negociacao') {
    const k = keyer('b3n');
    for (const r of rows) {
      const g = getter(r);
      const date = parseDate(g('Data do Negócio'));
      const kind = String(g('Tipo de Movimentação') ?? '').toLowerCase();
      const mercado = String(g('Mercado') ?? '').toLowerCase();
      const code = String(g('Código de Negociação') ?? '');
      const q = parseNumber(g('Quantidade'));
      const price = parseNumber(g('Preço'));
      if (!date || !code || !Number.isFinite(q) || !Number.isFinite(price)) {
        skip(t('Linha incompleta', 'Incomplete row'));
        continue;
      }
      if (mercado.includes('opç') || mercado.includes('opc') || mercado.includes('termo') || mercado.includes('futuro')) {
        skip(t('Opções/termo/futuro (não suportado)', 'Options/forwards/futures (not supported)'));
        continue;
      }
      const type: TxType | null = kind.startsWith('compra') ? 'BUY' : kind.startsWith('venda') ? 'SELL' : null;
      if (!type) {
        skip(`${t('Tipo', 'Type')} "${kind}"`);
        continue;
      }
      const ticker = normalizeTicker(code);
      const inst = prettyInstitution(String(g('Instituição') ?? '')) ?? '';
      const key = k([date, ticker, type, q, price, inst]);
      out.push({
        key, ticker, cls: clsOf(ticker),
        tx: { type, date, quantity: q, price, fees: 0, institution: inst || undefined, source: 'b3', importKey: key },
        duplicate: keys.has(key),
      });
    }
  } else if (format === 'movimentacao') {
    const k = keyer('b3m');
    for (const r of rows) {
      const g = getter(r);
      const date = parseDate(g('Data'));
      const io = norm(String(g('Entrada/Saída') ?? ''));
      const mov = String(g('Movimentação') ?? '').trim();
      const movN = norm(mov);
      const produto = String(g('Produto') ?? '');
      const inst = prettyInstitution(String(g('Instituição') ?? '')) ?? '';
      const q = parseNumber(g('Quantidade'));
      const unit = parseNumber(g('Preço unitário'));
      const total = parseNumber(g('Valor da Operação'));
      if (!date || !produto) {
        skip(t('Linha incompleta', 'Incomplete row'));
        continue;
      }
      const [codePart, ...nameParts] = produto.split(' - ');
      const ticker = normalizeTicker(codePart);
      const name = nameParts.join(' - ').trim() || undefined;
      const credit = io.startsWith('credito');
      const isTesouro = norm(produto).startsWith('tesouro');

      let type: TxType | null = null;
      let quantity = 1;
      let price = 0;
      let cls = clsOf(ticker);
      let warning: string | undefined;
      let rowTicker = ticker;
      let closes: boolean | undefined;

      if (credit && (movN === 'dividendo' || movN === 'jurossobrecapitalproprio' || movN === 'rendimento')) {
        type = movN === 'dividendo' ? 'DIVIDEND' : movN === 'rendimento' ? 'INCOME' : 'JCP';
        price = Number.isFinite(total) ? total : q * unit;
      } else if (credit && movN === 'desdobro') {
        type = 'BONUS'; // new shares at zero cost — same effect on preço médio as a split
        quantity = q;
      } else if (credit && movN.startsWith('bonificacaoemativos')) {
        type = 'BONUS';
        quantity = q;
        price = Number.isFinite(unit) ? unit : 0;
        if (!price) warning = t('Informe o custo atribuído pela empresa (fato relevante)', "Enter the unit cost the company assigned (see its announcement)");
      } else if (isTesouro && (movN === 'compra' || movN === 'venda' || movN === 'resgate' || movN === 'vencimento')) {
        type = movN === 'compra' ? 'BUY' : 'SELL';
        closes = movN === 'resgate' || movN === 'vencimento' ? true : undefined;
        price = Number.isFinite(total) ? total : q * unit;
        cls = 'RENDA_FIXA';
        rowTicker = produto.trim();
      } else {
        skip(mov || t('Sem tipo', 'No type'));
        continue;
      }
      if (!Number.isFinite(price) || !Number.isFinite(quantity)) {
        skip(t('Valor inválido', 'Invalid value'));
        continue;
      }
      const key = k([date, rowTicker, mov, q, total, inst]);
      out.push({
        key, ticker: rowTicker, name, cls,
        tx: { type, date, quantity, price, fees: 0, closes, institution: inst || undefined, source: 'b3', importKey: key },
        duplicate: keys.has(key),
        warning,
      });
    }
  } else if (format === 'template') {
    const k = keyer('csv');
    const typeMap: Record<string, TxType> = {
      compra: 'BUY', buy: 'BUY', aplicacao: 'BUY',
      venda: 'SELL', sell: 'SELL', resgate: 'SELL',
      dividendo: 'DIVIDEND', dividend: 'DIVIDEND',
      jcp: 'JCP', jurossobrecapitalproprio: 'JCP',
      rendimento: 'INCOME', income: 'INCOME',
      bonificacao: 'BONUS', desdobro: 'SPLIT', grupamento: 'SPLIT',
    };
    const classMap = new Map<string, AssetClass>(
      Object.entries(CLASS_LABEL).flatMap(([c, l]) => [[norm(l), c as AssetClass], [norm(c), c as AssetClass]]),
    );
    classMap.set('acao', 'ACAO');
    classMap.set('rendafixa', 'RENDA_FIXA');
    classMap.set('fundo', 'FUNDO');
    for (const r of rows) {
      const g = getter(r);
      const date = parseDate(g('data'));
      const tipo = norm(String(g('tipo') ?? ''));
      const ticker = normalizeTicker(String(g('ativo') ?? ''));
      const type = typeMap[tipo];
      if (!date || !ticker || !type) {
        skip(!type ? `Tipo "${g('tipo')}"` : 'Linha incompleta');
        continue;
      }
      const clsRaw = norm(String(g('classe') ?? ''));
      const cls = classMap.get(clsRaw) ?? clsOf(ticker, 'OUTRO');
      let quantity = parseNumber(g('quantidade'));
      let price = parseNumber(g('preco', 'preço', 'valor'));
      const fees = parseNumber(g('taxas', 'custos')) || 0;
      let factor: number | undefined;
      if (type === 'SPLIT') {
        factor = parseNumber(g('fator', 'quantidade'));
        if (tipo === 'grupamento' && factor > 1) factor = 1 / factor;
        quantity = 0;
        price = 0;
      } else if (!isMarketClass(cls) || type === 'DIVIDEND' || type === 'JCP' || type === 'INCOME') {
        // Value-based: amount goes to price.
        const amount = Number.isFinite(quantity) && Number.isFinite(price) && quantity !== 1 ? quantity * price : price;
        price = Number.isFinite(amount) ? amount : quantity;
        quantity = 1;
      }
      if (!Number.isFinite(quantity) || !Number.isFinite(price)) {
        skip(t('Valor inválido', 'Invalid value'));
        continue;
      }
      const inst = String(g('instituicao', 'instituição', 'corretora') ?? '').trim();
      const key = k([date, ticker, type, quantity, price, inst]);
      out.push({
        key, ticker, cls,
        tx: {
          type, date, quantity, price, fees, factor, institution: inst || undefined,
          notes: String(g('observacao', 'observação', 'obs') ?? '') || undefined, source: 'csv', importKey: key,
        },
        duplicate: keys.has(key),
      });
    }
  }
  if (format === 'us-broker') {
    const k = keyer('us');
    const first = getter(rows[0]);
    const pick = (names: string[]) => names.find((n) => first(n) !== undefined);
    const col = {
      date: pick(US_COLS.date)!, symbol: pick(US_COLS.symbol)!, action: pick(US_COLS.action)!,
      qty: pick(US_COLS.qty), price: pick(US_COLS.price), amount: pick(US_COLS.amount), fees: pick(US_COLS.fees),
    };
    const order = dateOrder(rows.map((r) => getter(r)(col.date)));
    for (const r of rows) {
      const g = getter(r);
      const date = parseDateOrder(g(col.date), order);
      const rawSym = String(g(col.symbol) ?? '').trim().toUpperCase().split(/[\s:]/)[0];
      const act = norm(String(g(col.action) ?? ''));
      if (!date || !rawSym) {
        skip(t('Linha incompleta', 'Incomplete row'));
        continue;
      }
      const type: TxType | null =
        /^(buy|bought|compra|purchase|b)$|buy|compra/.test(act) ? 'BUY'
        : /^(sell|sold|venda|s)$|sell|venda/.test(act) ? 'SELL'
        : /div/.test(act) && !/tax|withh|imposto/.test(act) ? 'DIVIDEND'
        : null;
      if (!type) {
        skip(`${t('Tipo', 'Type')} "${g(col.action)}"`);
        continue;
      }
      let quantity = Math.abs(usNumber(col.qty ? g(col.qty) : NaN));
      let price = Math.abs(usNumber(col.price ? g(col.price) : NaN));
      const amount = Math.abs(usNumber(col.amount ? g(col.amount) : NaN));
      const fees = Math.abs(usNumber(col.fees ? g(col.fees) : 0)) || 0;
      if (type === 'DIVIDEND') {
        price = Number.isFinite(amount) ? amount : quantity * price;
        quantity = 1;
      } else if (!Number.isFinite(price) && Number.isFinite(amount) && quantity > 0) {
        price = amount / quantity;
      }
      if (!(quantity > 0) || !Number.isFinite(price)) {
        skip(t('Valor inválido', 'Invalid value'));
        continue;
      }
      const ticker = rawSym.replace(/\.US$/, '');
      const known = existing.assets.find((a) => a.ticker.toUpperCase() === ticker);
      const cls: AssetClass = known?.cls ?? (guessClass(ticker) === 'CRIPTO' ? 'CRIPTO' : 'EXTERIOR');
      const key = k([date, ticker, type, quantity, price]);
      out.push({
        key, ticker, cls,
        tx: { type, date, quantity, price, fees, source: 'csv', importKey: key },
        duplicate: keys.has(key),
      });
    }
  }
  return { format: format ?? 'desconhecido', rows: out, skipped };
}

const BROKERS: [RegExp, string][] = [
  [/^XP /, 'XP'], [/^RICO/, 'Rico'], [/^CLEAR/, 'Clear'], [/^NU INVEST|^NUINVEST|EASYNVEST/, 'NuInvest'],
  [/BTG/, 'BTG Pactual'], [/^INTER /, 'Inter'], [/ITAU|ITAÚ/, 'Itaú'], [/AGORA|ÁGORA/, 'Ágora'],
  [/BRADESCO/, 'Bradesco'], [/SANTANDER/, 'Santander'], [/GENIAL/, 'Genial'], [/TORO/, 'Toro'],
  [/^BB |BANCO DO BRASIL/, 'Banco do Brasil'], [/^C6 /, 'C6 Bank'], [/MODAL/, 'Modal'], [/ORAMA|ÓRAMA/, 'Órama'],
  [/WARREN/, 'Warren'], [/SAFRA/, 'Safra'], [/CAIXA/, 'Caixa'], [/MERCADO PAGO/, 'Mercado Pago'], [/PICPAY/, 'PicPay'],
];

/** "XP INVESTIMENTOS CCTVM S/A" → "XP". */
export function prettyInstitution(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const up = s.toUpperCase();
  for (const [re, name] of BROKERS) if (re.test(up)) return name;
  return s;
}

export const FORMAT_LABEL = (): Record<string, string> => ({
  negociacao: 'B3 — Negociação',
  movimentacao: 'B3 — Movimentação',
  template: t('Planilha modelo', 'Template spreadsheet'),
  'us-broker': t('Corretora dos EUA (Nomad, Avenue…)', 'US broker (Nomad, Avenue…)'),
  desconhecido: t('Formato não reconhecido', 'Unrecognized format'),
});

/** Turns selected preview rows into transactions + any new assets needed. */
export function materialize(rows: PreviewRow[], assets: Asset[]) {
  const byTicker = new Map(assets.map((a) => [a.ticker.toUpperCase(), a]));
  const created: Asset[] = [];
  const txs: Omit<Transaction, 'id' | 'createdAt'>[] = [];
  for (const r of rows) {
    let a = byTicker.get(r.ticker.toUpperCase());
    if (!a) {
      const tesouro = r.cls === 'RENDA_FIXA' && r.ticker.toLowerCase().startsWith('tesouro');
      a = newAsset({
        ticker: r.ticker,
        name: r.name,
        cls: r.cls,
        institution: r.tx.institution,
        fixed: tesouro
          ? {
              kind: 'TESOURO',
              indexer: /selic/i.test(r.ticker) ? 'SELIC' : /ipca/i.test(r.ticker) ? 'IPCA' : 'PRE',
              rate: /selic/i.test(r.ticker) ? 0.1 : /ipca/i.test(r.ticker) ? 6 : 12,
            }
          : r.cls === 'RENDA_FIXA'
            ? { kind: 'OUTRO', indexer: 'CDI', rate: 100 }
            : undefined,
      });
      byTicker.set(a.ticker.toUpperCase(), a);
      created.push(a);
    } else if (!a.name && r.name) {
      a.name = r.name;
    }
    txs.push({ ...r.tx, assetId: a.id });
  }
  return { created, txs };
}

export const TEMPLATE_HEADERS = ['data', 'tipo', 'ativo', 'classe', 'quantidade', 'preco', 'taxas', 'instituicao', 'observacao'];

export function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    TEMPLATE_HEADERS,
    ['15/01/2025', 'compra', 'PETR4', 'Ações', 100, '38,50', '0', 'XP', ''],
    ['20/02/2025', 'venda', 'PETR4', 'Ações', 50, '41,20', '0', 'XP', ''],
    ['10/03/2025', 'dividendo', 'PETR4', 'Ações', 1, '52,30', '', 'XP', 'valor total recebido'],
    ['05/04/2025', 'compra', 'HGLG11', 'FIIs', 10, '160', '', 'Rico', ''],
    ['01/05/2025', 'compra', 'CDB Banco X 2027', 'Renda fixa', 1, '5000', '', 'Nubank', 'valor aplicado'],
    ['10/06/2025', 'desdobro', 'WEGE3', 'Ações', 2, '', '', '', 'fator: 1 ação vira 2'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lançamentos');
  XLSX.writeFile(wb, 'modelo-importacao-carteira.xlsx');
}
