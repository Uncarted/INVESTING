import * as XLSX from 'xlsx';
import type { Asset, AssetClass, FixedIncomeInfo, Transaction, TxType } from './types';
import { CLASS_LABEL, isMarketClass } from './types';
import { guessClass, normalizeTicker } from './classify';
import { groupTx, runMarket } from './portfolio';
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
  /** Fixed-income details for a new asset (bank statement imports). */
  fixed?: FixedIncomeInfo;
  /** Balance on the statement date (custody statements): sets the asset's current value. */
  balance?: { value: number; date: string };
  /** The asset already exists: only update its balance, don't add a transaction. */
  balanceOnly?: boolean;
  /** Extra fields for a new asset (e.g. currency, fixed price for cash). */
  assetExtra?: Partial<Asset>;
}

export interface ImportPreview {
  format: string;
  rows: PreviewRow[];
  skipped: Record<string, number>;
}

/** Bank statements in OFX (Nubank, Inter, Itaú… all export it): one row per transaction. */
export function parseOfx(text: string): { rows: Row[]; bank?: string } {
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'))?.[1]?.trim();
  const rows: Row[] = [];
  for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|<\/BANKTRANLIST>)/gi)) {
    const b = m[1];
    const d = tag(b, 'DTPOSTED') ?? '';
    const amt = Number((tag(b, 'TRNAMT') ?? '').replace(',', '.'));
    if (!/^\d{8}/.test(d) || !Number.isFinite(amt)) continue;
    rows.push({ Data: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, Valor: amt, Descricao: [tag(b, 'NAME'), tag(b, 'MEMO')].filter(Boolean).join(' — ') });
  }
  const org = tag(text, 'ORG');
  return { rows, bank: org ? bankName(org) : undefined };
}

const BANKS: [RegExp, string][] = [
  [/nu ?pagamentos|nubank|\bnu\b/i, 'Nubank'], [/inter/i, 'Inter'], [/ita[uú]/i, 'Itaú'], [/bradesco/i, 'Bradesco'],
  [/santander/i, 'Santander'], [/caixa/i, 'Caixa'], [/banco do brasil|\bbb\b/i, 'Banco do Brasil'], [/c6/i, 'C6 Bank'],
  [/picpay/i, 'PicPay'], [/mercado ?pago/i, 'Mercado Pago'], [/pagbank|pagseguro/i, 'PagBank'], [/btg/i, 'BTG Pactual'], [/neon/i, 'Neon'],
];
export const bankName = (s: string) => BANKS.find(([re]) => re.test(s))?.[1] ?? s;

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

function detect(rows: Row[]): 'negociacao' | 'movimentacao' | 'template' | 'us-broker' | 'bank' | null {
  if (!rows.length) return null;
  const keys = new Set(Object.keys(rows[0]).map(norm));
  if (keys.has('codigodenegociacao') && keys.has('tipodemovimentacao')) return 'negociacao';
  if (keys.has('entradasaida') && keys.has('movimentacao') && keys.has('produto')) return 'movimentacao';
  if (keys.has('data') && keys.has('tipo') && keys.has('ativo') && keys.has('classe')) return 'template';
  if (hasAny(keys, US_COLS.date) && hasAny(keys, US_COLS.symbol) && hasAny(keys, US_COLS.action) && (hasAny(keys, US_COLS.qty) || hasAny(keys, US_COLS.amount)))
    return 'us-broker';
  if ((keys.has('data') || keys.has('date')) && (keys.has('valor') || keys.has('amount') || keys.has('quantia')) && hasAny(keys, ['descricao', 'historico', 'lancamento', 'description', 'identificador', 'detalhes']))
    return 'bank';
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

export function buildPreview(rows: Row[], existing: { assets: Asset[]; transactions: Transaction[] }, opts: { bank?: string } = {}): ImportPreview {
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
  if (format === 'bank') {
    // Bank statement: keep only money moved into / out of caixinhas, RDBs, CDBs, savings.
    const first = getter(rows[0]);
    const bank = opts.bank ?? (first('identificador') !== undefined ? 'Nubank' : t('Banco', 'Bank'));
    const mine = existing.assets.find((a) => a.fixed?.daily && (a.institution ?? '').toLowerCase() === bank.toLowerCase());
    const ticker = mine?.ticker ?? `CDB ${bank} 100% CDI ${t('liquidez diária', 'daily')}`;
    const k = keyer('bank');
    const INVEST = /caixinha|cofrinho|porquinho|guardad|guardar|reserva|rdb|cdb|aplica|resgat|investiment|poupan|meta/;
    for (const r of rows) {
      const g = getter(r);
      const date = parseDate(g('data', 'date'));
      const desc = String(g('descricao', 'descrição', 'historico', 'histórico', 'lancamento', 'lançamento', 'description', 'detalhes') ?? '');
      const value = parseNumber(g('valor', 'amount', 'quantia'));
      const d = norm(desc);
      if (!date || !Number.isFinite(value) || !value) continue;
      if (!INVEST.test(d)) {
        skip(t('Movimentação da conta (não é investimento)', 'Account activity (not an investment)'));
        continue;
      }
      const type: TxType = /resgat|retirad/.test(d) ? 'SELL' : /aplica|guardad|guardar/.test(d) ? 'BUY' : value < 0 ? 'BUY' : 'SELL';
      const amount = Math.abs(value);
      const key = k([date, type, amount, d]);
      out.push({
        key, ticker, cls: 'RENDA_FIXA',
        tx: { type, date, quantity: 1, price: amount, fees: 0, institution: bank, source: 'csv', importKey: key, notes: desc || undefined },
        duplicate: keys.has(key),
        fixed: { kind: 'CDB', indexer: 'CDI', rate: 100, daily: true },
      });
    }
    return { format, rows: out, skipped };
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

// ---------------------------------------------------------------------------
// Custody statements (PDF): what you hold today, e.g. Nubank's "Extrato de Custódia".

/** Text lines of a PDF, in reading order, cells separated by " | ". pdf.js is loaded from a CDN only when needed. */
export async function readPdfLines(file: File): Promise<string[]> {
  const url = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs';
  const pdfjs = await import(/* @vite-ignore */ url);
  pdfjs.GlobalWorkerOptions.workerSrc = url.replace('pdf.min.mjs', 'pdf.worker.min.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(...pdfLines(tc.items as PdfItem[]));
  }
  return out;
}

export interface PdfItem {
  str: string;
  transform: number[];
  width: number;
}

/** Groups pdf.js text items into lines; pieces that touch are glued, gaps become " | ". */
export function pdfLines(items: PdfItem[]): string[] {
  const rows = new Map<number, PdfItem[]>();
  for (const it of items) {
    if (!it.str) continue;
    const y = Math.round(it.transform[5]);
    (rows.get(y) ?? rows.set(y, []).get(y)!).push(it);
  }
  const out: string[] = [];
  for (const [, row] of [...rows].sort((a, b) => b[0] - a[0])) {
    row.sort((a, b) => a.transform[4] - b.transform[4]);
    let line = '';
    let end = -Infinity;
    let sep = false;
    for (const it of row) {
      if (!it.str.trim()) {
        sep = true; // a blank item between two pieces of text separates cells
        continue;
      }
      const x = it.transform[4];
      const size = Math.abs(it.transform[0]) || 8;
      // Touching pieces (e.g. "Confirma" + "çã" + "o") are one word; any real gap is a new cell.
      if (line && (sep || x - end > size * 0.12)) line += ' | ';
      line += it.str.trim();
      sep = /\s$/.test(it.str);
      end = x + (it.width || 0);
    }
    line = line.replace(/\s*\|\s*(\|\s*)+/g, ' | ').trim();
    if (line.replace(/[|\s]/g, '')) out.push(line);
  }
  return out;
}

const MONEY = /^-?\d{1,3}(\.\d{3})*,\d{2}$/;
const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const toISO = (d: string) => d.split('/').reverse().join('-');
const cellsOf = (line: string) => line.split('|').map((c) => c.trim()).filter(Boolean);

/** "130% CDI" · "IPCA + 6,2%" · "12,5% a.a." → indexer and rate. */
function parseRate(s: string): { indexer: 'CDI' | 'IPCA' | 'PRE' | 'SELIC'; rate: number } | null {
  const n = (x: string) => parseNumber(x.replace('%', ''));
  let m = s.match(/([\d.,]+)\s*%\s*(do\s*)?CDI/i);
  if (m) return { indexer: 'CDI', rate: n(m[1]) };
  m = s.match(/IPCA\s*\+\s*([\d.,]+)/i);
  if (m) return { indexer: 'IPCA', rate: n(m[1]) };
  m = s.match(/SELIC\s*\+\s*([\d.,]+)/i);
  if (m) return { indexer: 'SELIC', rate: n(m[1]) };
  m = s.match(/([\d.,]+)\s*%\s*(a\.?a|pr[eé])/i);
  if (m) return { indexer: 'PRE', rate: n(m[1]) };
  return null;
}

export function buildCustodyPreview(lines: string[], existing: { assets: Asset[]; transactions: Transaction[] }): ImportPreview {
  const text = lines.join('\n');
  const date = toISO(text.match(/Cust[óo]dia em:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? '') || new Date().toISOString().slice(0, 10);
  const bank = /nu ?pagamentos|nubank|nu invest/i.test(text) ? 'Nubank' : bankName(text.match(/(Banco [A-Z][\wÀ-ú]+|Inter|Itaú|Bradesco|BTG Pactual|XP)/)?.[1] ?? t('Banco', 'Bank'));
  const keys = new Set(existing.transactions.map((x) => x.importKey).filter(Boolean));
  const out: PreviewRow[] = [];
  const skipped: Record<string, number> = {};
  const find = (ticker: string) => existing.assets.find((a) => a.ticker.toLowerCase() === ticker.toLowerCase());

  const push = (ticker: string, fixed: FixedIncomeInfo, invested: number, appliedOn: string, balance: number, note: string) => {
    const has = find(ticker);
    const key = `custody|${ticker}|${appliedOn}|${invested}`;
    out.push({
      key, ticker, cls: 'RENDA_FIXA',
      tx: { type: 'BUY', date: appliedOn, quantity: 1, price: invested, fees: 0, institution: bank, source: 'csv', importKey: key, notes: note },
      duplicate: false,
      fixed,
      balance: { value: balance, date },
      balanceOnly: !!has || keys.has(key),
      warning: has || keys.has(key) ? t(`Já existe — só atualiza o saldo para ${balance.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`, `Already there — only updates the balance`) : undefined,
    });
  };

  let section: 'caixinha' | 'fixa' | null = null;
  let caixinha = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/Cust[óo]dia em Caixinhas/i.test(line)) section = 'caixinha';
    else if (/Cust[óo]dia em Renda Fixa/i.test(line)) section = 'fixa';
    const cx = line.match(/Caixinha\s+["“](.+?)["”]/i);
    if (cx) {
      caixinha = cx[1].trim();
      section = 'caixinha';
      continue;
    }
    const cells = cellsOf(line);
    const money = cells.filter((c) => MONEY.test(c));
    if (section === 'caixinha' && caixinha && /^(RDB|CDB|LCI|LCA)/i.test(cells[0] ?? '') && money.length) {
      const balance = parseNumber(money[0]);
      const kind = /^LCI/i.test(cells[0]) ? 'LCI' : /^LCA/i.test(cells[0]) ? 'LCA' : 'CDB';
      // A caixinha's history isn't in the statement: start it at today's balance.
      push(`Caixinha ${caixinha}`, { kind, indexer: 'CDI', rate: 100, daily: true }, balance, date, balance, `${cells[0]} · ${t('saldo do extrato de custódia', 'custody statement balance')}`);
      caixinha = '';
      continue;
    }
    if (section === 'fixa' && money.length >= 2 && cells.some((c) => DATE.test(c)) && cells.some((c) => /%/.test(c))) {
      // Columns: emissor · vencimento · taxa · valor aplicado · data de aplicação · saldo bruto · IR · IOF · líquido · disponível
      const kindLine = [lines[i - 1] ?? '', line].map((l) => cellsOf(l)[0] ?? '').find((c) => /^(CDB|LCI|LCA|LC|RDB|CRI|CRA|Deb|Tesouro)/i.test(c)) ?? 'CDB';
      const kind: FixedIncomeInfo['kind'] = /^LCI/i.test(kindLine) ? 'LCI' : /^LCA/i.test(kindLine) ? 'LCA' : /^CRI/i.test(kindLine) ? 'CRI' : /^CRA/i.test(kindLine) ? 'CRA' : /^Deb/i.test(kindLine) ? 'DEBENTURE' : /^Tesouro/i.test(kindLine) ? 'TESOURO' : 'CDB';
      const dates = cells.filter((c) => DATE.test(c));
      const rate = parseRate(cells.find((c) => /%/.test(c)) ?? '') ?? { indexer: 'CDI' as const, rate: 100 };
      const issuer = cells.find((c) => !MONEY.test(c) && !DATE.test(c) && !/%/.test(c) && !/^(CDB|LCI|LCA|RDB)/i.test(c)) ?? bank;
      const around = [lines[i - 1], line, lines[i + 1]].join(' ');
      const daily = /liquidez di[áa]ria/i.test(around);
      const maturity = dates[0] ? toISO(dates[0]) : undefined;
      const appliedOn = dates[1] ? toISO(dates[1]) : date;
      const invested = parseNumber(money[0]);
      const balance = parseNumber(money[1]);
      const label = kind === 'TESOURO' ? 'Tesouro' : kind === 'DEBENTURE' ? 'Debênture' : kind;
      const rateStr = rate.indexer === 'CDI' ? `${numFmt(rate.rate)}% CDI` : rate.indexer === 'IPCA' ? `IPCA+${numFmt(rate.rate)}%` : rate.indexer === 'SELIC' ? `Selic+${numFmt(rate.rate)}%` : `${numFmt(rate.rate)}% a.a.`;
      const ticker = [label, issuer, rateStr, maturity?.slice(0, 4)].filter(Boolean).join(' ');
      push(ticker, { kind, indexer: rate.indexer, rate: rate.rate, maturity, issuer: issuer !== bank ? issuer : undefined, daily: daily || undefined }, invested, appliedOn, balance, `${kindLine}${daily ? ' · liquidez diária' : ''}`);
    }
  }
  if (!out.length) skipped[t('Nenhuma posição reconhecida no PDF', 'No positions recognized in the PDF')] = 1;
  return { format: 'custody', rows: out, skipped };
}
// ---------------------------------------------------------------------------
// Nomad (and other US brokers cleared by Apex): monthly account statement PDF.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const TICKER = /^[A-Z][A-Z.]{0,5}$/;
const usNum = (s: string) => {
  const neg = /^\(.*\)$/.test(s.trim()) || s.trim().startsWith('-');
  return Math.abs(Number(s.replace(/[$,()\s-]/g, ''))) * (neg ? -1 : 1);
};
const isNum = (s: string) => /^\(?-?\$?[\d,]+(\.\d+)?\)?$/.test(s.trim());
const usIso = (s: string) => (ISO_DATE.test(s) ? s : US_DATE.test(s) ? `${s.slice(6)}-${s.slice(0, 2)}-${s.slice(3, 5)}` : '');

export function buildBrokerStatementPreview(lines: string[], existing: { assets: Asset[]; transactions: Transaction[] }): ImportPreview {
  const text = lines.join('\n');
  const period = text.match(/Statement Date:?\s*\|?\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/i);
  const date = period?.[2] ?? new Date().toISOString().slice(0, 10);
  const broker = /nomad/i.test(text) ? 'Nomad' : /avenue/i.test(text) ? 'Avenue' : t('Corretora EUA', 'US broker');
  const keys = new Set(existing.transactions.map((x) => x.importKey).filter(Boolean));
  const out: PreviewRow[] = [];
  const skipped: Record<string, number> = {};
  const k = keyer('trade'); // same key as the generic reader: a confirmation + the monthly statement don't double-count
  const holdings: { symbol: string; qty: number; price: number; desc: string }[] = [];
  const divs = new Map<string, { date: string; symbol: string; amount: number }>();
  let section: 'portfolio' | 'trades' | 'pending' | 'other' | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\W*PORTFOLIO\b/i.test(line)) { section = 'portfolio'; continue; }
    if (/TRADING ACTIVITY PENDING/i.test(line)) { section = 'pending'; continue; }
    if (/^\W*TRADING ACTIVIT/i.test(line)) { section = 'trades'; continue; }
    if (/NON-TRADING ACTIVITY/i.test(line)) { section = 'other'; continue; }
    if (/Investment objectives|Disclosures/i.test(line)) section = null;
    const cells = cellsOf(line);
    if (!section || cells.length < 3) continue;
    const symIdx = cells.findIndex((c, j) => j > 0 && TICKER.test(c) && !/^(USD|N\/A|BUY|SELL|DIV)$/.test(c));
    if (section === 'portfolio' && symIdx > 0) {
      const nums = cells.slice(symIdx + 1).filter(isNum).map(usNum);
      // Quantity · securities on loan · price · market value · previous value · % change · % of total
      if (nums.length >= 3 && nums[0] > 0) holdings.push({ symbol: cells[symIdx], qty: nums[0], price: nums[2] > 0 ? nums[2] : nums[1], desc: cells.slice(0, symIdx).join(' ') });
    } else if (section === 'trades' && symIdx > 0) {
      const act = cells[0].toUpperCase();
      const type: TxType | null = /BUY|BOT|BOUGHT|PURCH/.test(act) ? 'BUY' : /SELL|SLD|SOLD/.test(act) ? 'SELL' : null;
      const tradeDate = usIso(cells.find((c) => ISO_DATE.test(c) || US_DATE.test(c)) ?? '');
      const nums = cells.slice(symIdx + 1).filter(isNum).map(usNum);
      if (!tradeDate) continue; // header / "No Information" lines
      if (!type || nums.length < 2) {
        skip(t('Linha de negociação não reconhecida', 'Unrecognized trade line'));
        continue;
      }
      const [quantity, price, , commission] = [Math.abs(nums[0]), Math.abs(nums[1]), nums[2], Math.abs(nums[3] ?? 0)];
      const symbol = cells[symIdx];
      const key = k([tradeDate, symbol, type, quantity, price]);
      out.push({
        key, ticker: symbol, cls: 'EXTERIOR', name: cells.slice(1, symIdx).filter((c) => !ISO_DATE.test(c) && !US_DATE.test(c)).join(' ') || undefined,
        tx: { type, date: tradeDate, quantity, price, fees: commission || 0, institution: broker, source: 'csv', importKey: key },
        duplicate: keys.has(key),
      });
    } else if (section === 'other') {
      const d = usIso(cells.find((c) => ISO_DATE.test(c) || US_DATE.test(c)) ?? '');
      const kind = cells.join(' ').toUpperCase();
      const nums = cells.filter(isNum).map(usNum);
      const symbol = symIdx > 0 ? cells[symIdx] : '';
      if (!d || !symbol || !nums.length) continue;
      const amount = nums[nums.length - 1];
      if (!/DIV|TAX|WITHH|NRA/.test(kind)) continue;
      const id = `${d}|${symbol}`;
      const cur = divs.get(id) ?? { date: d, symbol, amount: 0 };
      cur.amount += /TAX|WITHH|NRA/.test(kind) ? -Math.abs(amount) : Math.abs(amount);
      divs.set(id, cur);
    }
  }
  function skip(r: string) {
    skipped[r] = (skipped[r] ?? 0) + 1;
  }

  for (const d of divs.values()) {
    if (d.amount <= 0.004) continue;
    const key = `apex-div|${d.date}|${d.symbol}|${d.amount.toFixed(2)}`;
    out.push({ key, ticker: d.symbol, cls: 'EXTERIOR', tx: { type: 'DIVIDEND', date: d.date, quantity: 1, price: Math.round(d.amount * 100) / 100, fees: 0, institution: broker, source: 'csv', importKey: key }, duplicate: keys.has(key) });
  }

  // Positions: if Wallet has fewer shares than the statement, add the missing ones at the statement price.
  const byAsset = groupTx(existing.transactions);
  for (const h of holdings) {
    const asset = existing.assets.find((a) => a.ticker.toUpperCase() === h.symbol);
    const have = asset ? runMarket(asset, byAsset.get(asset.id) ?? [], date, { fx: { USD: 1, EUR: 1 } } as never).quantity : 0;
    const imported = out.filter((r) => r.ticker === h.symbol && !r.duplicate && (r.tx.type === 'BUY' || r.tx.type === 'SELL')).reduce((s, r) => s + (r.tx.type === 'BUY' ? r.tx.quantity : -r.tx.quantity), 0);
    const diff = Math.round((h.qty - have - imported) * 1e6) / 1e6;
    if (Math.abs(diff) < 1e-6) {
      skip(t(`${h.symbol}: já confere com o extrato (${h.qty})`, `${h.symbol}: already matches the statement (${h.qty})`));
      continue;
    }
    if (diff < 0) {
      skip(t(`${h.symbol}: o Walleti tem ${have + imported}, o extrato mostra ${h.qty} — falta lançar alguma venda`, `${h.symbol}: Walleti has ${have + imported}, the statement shows ${h.qty} — a sale is missing`));
      continue;
    }
    const key = `apex-pos|${date}|${h.symbol}|${diff}`;
    out.push({
      key, ticker: h.symbol, cls: 'EXTERIOR', name: h.desc ? h.desc.replace(/\s+COM$/i, '') : undefined,
      tx: { type: 'BUY', date, quantity: diff, price: h.price, fees: 0, institution: broker, source: 'csv', importKey: key, notes: t('Posição do extrato mensal — preço do fim do mês como custo', 'Monthly statement position — month-end price as cost') },
      duplicate: keys.has(key),
      warning: t('Custo = preço no fim do mês. Se souber o preço que pagou, edite depois (ou importe o extrato do mês da compra).', 'Cost = month-end price. If you know what you paid, edit it later (or import the statement from the month you bought).'),
    });
  }
  return { format: 'apex', rows: out, skipped };
}

/** Nomad banking account (dollars in the account): the balance at the end of the period. */
/** A balance in dollars sitting in an account → the matching "Dólar <broker>" cash asset. */
function usdBalancePreview(existing: { assets: Asset[]; transactions: Transaction[] }, broker: string, balance: number, date: string): ImportPreview {
  const ticker = `${t('Dólar', 'Dollars')} ${broker}`;
  const shown = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(balance);
  const asset = existing.assets.find((a) => a.cls === 'CAIXA' && a.ticker.toLowerCase() === ticker.toLowerCase());
  const have = asset ? runMarket(asset, groupTx(existing.transactions).get(asset.id) ?? [], date, { fx: { USD: 1, EUR: 1 } } as never).quantity : 0;
  const diff = Math.round((balance - have) * 100) / 100;
  if (Math.abs(diff) < 0.005) return { format: 'usd-cash', rows: [], skipped: { [t(`Saldo já confere: ${shown}`, `Balance already matches: ${shown}`)]: 1 } };
  const key = `usd-cash|${broker}|${date}|${balance}`;
  return {
    format: 'usd-cash',
    rows: [{
      key, ticker, cls: 'CAIXA',
      tx: { type: diff > 0 ? 'BUY' : 'SELL', date, quantity: Math.abs(diff), price: 1, fees: 0, institution: broker, source: 'csv', importKey: key, notes: t(`Saldo do extrato: ${shown}`, `Statement balance: ${shown}`) },
      duplicate: existing.transactions.some((x) => x.importKey === key),
      assetExtra: { currency: 'USD', currentPrice: 1 },
      warning: asset ? t(`Ajusta o saldo de US$ ${have.toFixed(2)} para ${shown}`, `Adjusts the balance from US$ ${have.toFixed(2)} to ${shown}`) : undefined,
    }],
    skipped: {},
  };
}

const MONTHS_ANY: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  enero: 1, febrero: 2, marzo: 3, mayo: 5, junio: 6, julio: 7, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const monthNum = (m: string) => MONTHS_ANY[m.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()] ?? 0;

/** Nomad banking account (dollars in the account): the balance at the end of the period. */
export function buildUsdCashPreview(lines: string[], existing: { assets: Asset[]; transactions: Transaction[] }): ImportPreview {
  const text = lines.join('\n');
  const end = text.match(/at[ée]\s+(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/i);
  const date = end && monthNum(end[2]) ? `${end[3]}-${String(monthNum(end[2])).padStart(2, '0')}-${end[1].padStart(2, '0')}` : new Date().toISOString().slice(0, 10);
  const li = lines.findIndex((l) => /Saldo final/i.test(l));
  const vals = li >= 0 ? (lines[li + 1] ?? '').match(/US\$\s*[\d.]+,\d{2}/g) ?? [] : [];
  if (!vals.length) return { format: 'usd-cash', rows: [], skipped: { [t('Saldo não encontrado', 'Balance not found')]: 1 } };
  const broker = /nomad/i.test(text) ? 'Nomad' : t('Conta EUA', 'US account');
  return usdBalancePreview(existing, broker, parseNumber(vals[0].replace('US$', '')), date);
}

/** DolarApp (Arq) "Estado de Cuenta": dollars / USDc held in the app → final balance. */
export function buildDolarAppPreview(lines: string[], existing: { assets: Asset[]; transactions: Transaction[] }): ImportPreview {
  const text = lines.join('\n');
  const bal = text.match(/Balance Final\s*\|?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!bal) return { format: 'usd-cash', rows: [], skipped: { [t('Saldo não encontrado', 'Balance not found')]: 1 } };
  const balance = Number(bal[1].replace(/,/g, ''));
  // "Fecha de fin … 30 September … 2026"
  const m = text.match(/Fecha de fin[\s\S]{0,80}?(\d{1,2})\s+([A-Za-zÀ-ú]+)[\s\S]{0,120}?(\d{4})/i);
  const date = m && monthNum(m[2]) ? `${m[3]}-${String(monthNum(m[2])).padStart(2, '0')}-${m[1].padStart(2, '0')}` : new Date().toISOString().slice(0, 10);
  return usdBalancePreview(existing, 'DolarApp', balance, date);
}

// ---------------------------------------------------------------------------
// Generic: any document where a line has a date, a ticker, a quantity and a price,
// with "compra/venda/bought/sold" nearby (trade confirmations, notes, broker reports…).

const NOT_TICKERS = new Set(['USD', 'BRL', 'EUR', 'COM', 'DESC', 'TETO', 'EUA', 'INC', 'CORP', 'LTD', 'BUY', 'SELL', 'BOT', 'SLD', 'QTD', 'CDB', 'LCI', 'LCA', 'CPF', 'CNPJ', 'IR', 'IOF', 'TOTAL', 'DATA', 'DATE', 'AGENCY', 'PAGE', 'FEE', 'FEES', 'SEC', 'TAF', 'CUSIP', 'ISIN', 'NA', 'N', 'S', 'C', 'V', 'D', 'BR', 'US', 'SP', 'RJ', 'FL', 'ON', 'PN', 'UNT', 'FII', 'ETF', 'BDR']);
const B3_TICKER = /^[A-Z]{4}\d{1,2}F?$/;
const US_TICKER = /^[A-Z]{1,5}(\.[A-Z])?$/;

export function buildGenericPreview(lines: string[], existing: { assets: Asset[]; transactions: Transaction[] }): ImportPreview {
  const text = lines.join('\n');
  // Decimal comma (1.234,56) or decimal point (1,234.56)? Count both patterns in the document.
  const commaDec = (text.match(/\d,\d{2}(?![\d.,])/g) ?? []).length + (text.match(/\d,\d{4,}/g) ?? []).length;
  const pointDec = (text.match(/\d\.\d{2}(?![\d.,])/g) ?? []).length + (text.match(/\d\.\d{4,}/g) ?? []).length;
  const ptNumbers = commaDec > pointDec;
  const num = (c: string): number | null => {
    let x = c.replace(/[R$US€\s]/g, '').replace(/^\((.*)\)$/, '-$1');
    if (!/^-?[\d.,]+$/.test(x) || !/\d/.test(x)) return null;
    if (x.includes('.') && x.includes(',')) x = x.lastIndexOf(',') > x.lastIndexOf('.') ? x.replace(/\./g, '').replace(',', '.') : x.replace(/,/g, '');
    else if (x.includes(',')) x = ptNumbers ? x.replace(',', '.') : x.replace(/,/g, '');
    else if (x.includes('.') && ptNumbers && /\.\d{3}$/.test(x)) x = x.replace(/\./g, '');
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  const toDate = (c: string): string => {
    let m = c.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = c.match(/^(\d{2})[/.](\d{2})[/.](\d{4})$/);
    if (!m) return '';
    // dd/mm/yyyy in Brazilian documents, mm/dd/yyyy in American ones (unless impossible).
    const [a, b] = [Number(m[1]), Number(m[2])];
    const dmy = ptNumbers ? b <= 12 || a > 12 : a > 12;
    return dmy ? `${m[3]}-${m[2]}-${m[1]}` : `${m[3]}-${m[1]}-${m[2]}`;
  };
  const broker = DOC_BROKERS.find(([re]) => re.test(text))?.[1];
  const keys = new Set(existing.transactions.map((x) => x.importKey).filter(Boolean));
  const out: PreviewRow[] = [];
  const skipped: Record<string, number> = {};
  const k = keyer('trade');
  let side: 'BUY' | 'SELL' | null = null;
  for (const line of lines) {
    const flat = line.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*\|\s*/g, ' ');
    const cells = cellsOf(line);
    const date = cells.map(toDate).find(Boolean) ?? '';
    // Section headers like "Você comprou" / "You sold" set the side for the lines below.
    const ctx = /\b(comprou|compras?|comprad[oa]s?|bought|buys?|purchases?)\b/.test(flat) ? 'BUY' : /\b(vendeu|vendas?|vendid[oa]s?|sold|sells?)\b/.test(flat) ? 'SELL' : null;
    if (!date) {
      if (ctx && cells.length <= 4) side = ctx;
      continue;
    }
    const tIdx = cells.findIndex((c) => (B3_TICKER.test(c) || US_TICKER.test(c)) && !NOT_TICKERS.has(c));
    if (tIdx < 0) continue;
    const inline = cells.map((c) => c.toUpperCase()).find((c) => /^(BUY|SELL|BOT|SLD|B|S|C|V|COMPRA|VENDA)$/.test(c));
    const type: TxType | null = inline ? (/^(BUY|BOT|B|C|COMPRA)$/.test(inline) ? 'BUY' : 'SELL') : ctx ?? side;
    const nums = cells.slice(tIdx + 1).map(num).filter((n): n is number => n !== null);
    if (nums.length < 2) continue;
    if (!type) {
      skipped[t('Linha sem compra/venda indicada', 'Line without buy/sell')] = (skipped[t('Linha sem compra/venda indicada', 'Line without buy/sell')] ?? 0) + 1;
      continue;
    }
    const ticker = cells[tIdx];
    const quantity = Math.abs(nums[0]);
    const price = Math.abs(nums[1]);
    if (!(quantity > 0 && price > 0)) continue;
    const isB3 = B3_TICKER.test(ticker);
    const cls: AssetClass = existing.assets.find((a) => a.ticker.toUpperCase() === ticker)?.cls ?? (isB3 ? guessClass(ticker) ?? 'ACAO' : 'EXTERIOR');
    const key = k([date, ticker, type, quantity, price]);
    out.push({ key, ticker, cls, tx: { type, date, quantity, price, fees: 0, institution: broker, source: 'csv', importKey: key }, duplicate: keys.has(key) });
  }
  return { format: out.length ? 'generic' : 'desconhecido', rows: out, skipped };
}
const DOC_BROKERS: [RegExp, string][] = [
  [/nomad|apex clearing/i, 'Nomad'], [/avenue/i, 'Avenue'], [/inter ?(global|invest)/i, 'Inter'], [/xp invest/i, 'XP'], [/\brico\b/i, 'Rico'], [/\bclear\b/i, 'Clear'],
  [/btg/i, 'BTG Pactual'], [/nu ?invest|nubank/i, 'NuInvest'], [/ita[uú]/i, 'Itaú'], [/genial/i, 'Genial'], [/toro/i, 'Toro'], [/c6/i, 'C6 Bank'],
  [/interactive brokers/i, 'Interactive Brokers'], [/schwab/i, 'Charles Schwab'], [/binance/i, 'Binance'],
];

// ---------------------------------------------------------------------------
// AI reading: personal data is removed before the text leaves the browser.

export function redactForAi(lines: string[]): string {
  const PII = /(cpf|cnpj do cliente|endere[çc]o|address|e-?mail|telefone|phone|celular|cep\b|account number|n[úu]mero da conta|ag[êe]ncia|routing|cliente:|titular|rua |avenida|av\. )/i;
  return lines
    // Legal/explanatory sentences (many words, no amounts) only slow the AI down; PII lines go away.
    .filter((l) => l.length <= 400 && !PII.test(l) && !(l.split(/\s+/).length > 14 && !/\d[.,]\d/.test(l)))
    .map((l) =>
      l
        .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[cpf]')
        .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
        .replace(/\+?\d{2}\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g, '[tel]')
        .replace(/\b\d{5}-?\d{3}\b/g, (m) => (/^\d{8}$|^\d{5}-\d{3}$/.test(m) ? '[cep]' : m)),
    )
    .join('\n');
}

/** Turns what the AI found into the usual review rows. */
export function buildAiPreview(ai: { institution?: string | null; statementDate?: string | null; items: AiItemLike[] }, existing: { assets: Asset[]; transactions: Transaction[] }): ImportPreview {
  const out: PreviewRow[] = [];
  const skipped: Record<string, number> = {};
  const keys = new Set(existing.transactions.map((x) => x.importKey).filter(Boolean));
  const k = keyer('trade');
  const inst = ai.institution ? DOC_BROKERS.find(([re]) => re.test(ai.institution!))?.[1] ?? bankName(ai.institution) : undefined;
  const today = new Date().toISOString().slice(0, 10);
  const asOf = ISO_DATE.test(ai.statementDate ?? '') ? ai.statementDate! : today;
  const byAsset = groupTx(existing.transactions);
  const skip = (r: string) => (skipped[r] = (skipped[r] ?? 0) + 1);
  const CLS: Record<string, AssetClass> = { stock_br: 'ACAO', fii: 'FII', etf: 'ETF', bdr: 'BDR', stock_us: 'EXTERIOR', crypto: 'CRIPTO', fixed_income: 'RENDA_FIXA', fund: 'FUNDO', cash: 'CAIXA', other: 'OUTRO' };
  const held = (ticker: string) => {
    const a = existing.assets.find((x) => x.ticker.toUpperCase() === ticker.toUpperCase());
    return a ? runMarket(a, byAsset.get(a.id) ?? [], asOf, { fx: { USD: 1, EUR: 1 } } as never).quantity : 0;
  };
  for (const raw of ai.items ?? []) {
    let it = raw;
    // Stablecoins / "digital dollars" (USDC, USDT, USDc) are dollars in an account, not crypto to price.
    if (/^(USDC|USDT|USD|USDC\.E)$/i.test(it.ticker ?? '') || /usdc|usdt|d[óo]lar(es)? digita/i.test(it.name ?? '')) {
      if (it.kind === 'position' || it.kind === 'cash') it = { ...it, kind: 'cash', assetType: 'cash', currency: 'USD', amount: it.amount ?? it.quantity };
      else {
        skip(t('Movimentação em dólar digital (o saldo final é o que conta)', 'Digital-dollar movement (the final balance is what counts)'));
        continue;
      }
    }
    const cls = CLS[it.assetType] ?? 'OUTRO';
    const date = ISO_DATE.test(it.date ?? '') ? it.date! : asOf;
    const ticker = (it.ticker ?? '').trim().toUpperCase();
    const market = cls === 'ACAO' || cls === 'FII' || cls === 'ETF' || cls === 'BDR' || cls === 'EXTERIOR' || cls === 'CRIPTO';
    // Crypto is priced in reais (Binance BRL pairs); US stocks default to dollars.
    const extra: Partial<Asset> | undefined = it.currency !== 'BRL' && cls !== 'EXTERIOR' && cls !== 'CRIPTO' ? { currency: it.currency } : undefined;
    if (it.kind === 'trade' && market && ticker && it.side && (it.quantity ?? 0) > 0) {
      const price = (it.price ?? 0) > 0 ? it.price! : (it.amount ?? 0) / it.quantity!;
      if (!(price > 0)) { skip(t('Negociação sem preço', 'Trade without price')); continue; }
      const key = k([date, ticker, it.side, it.quantity, price]);
      out.push({ key, ticker, name: it.name ?? undefined, cls, assetExtra: extra, tx: { type: it.side, date, quantity: Math.abs(it.quantity!), price, fees: Math.abs(it.fees ?? 0), institution: inst, source: 'csv', importKey: key }, duplicate: keys.has(key) });
    } else if (it.kind === 'dividend' && ticker && (it.amount ?? 0) > 0) {
      const type: TxType = it.dividendType ?? (cls === 'FII' ? 'INCOME' : 'DIVIDEND');
      const key = `ai-div|${date}|${ticker}|${type}|${it.amount}`;
      out.push({ key, ticker, cls, assetExtra: extra, tx: { type, date, quantity: 1, price: it.amount!, fees: 0, institution: inst, source: 'csv', importKey: key }, duplicate: keys.has(key) });
    } else if (it.kind === 'position' && market && ticker && (it.quantity ?? 0) > 0) {
      const diff = Math.round((it.quantity! - held(ticker) - out.filter((r) => r.ticker === ticker && (r.tx.type === 'BUY' || r.tx.type === 'SELL')).reduce((s, r) => s + (r.tx.type === 'BUY' ? r.tx.quantity : -r.tx.quantity), 0)) * 1e6) / 1e6;
      if (Math.abs(diff) < 1e-6) { skip(t(`${ticker}: já confere`, `${ticker}: already matches`)); continue; }
      if (diff < 0) { skip(t(`${ticker}: o documento mostra menos do que o Walleti — falta alguma venda`, `${ticker}: the document shows fewer shares — a sale is missing`)); continue; }
      const price = (it.price ?? 0) > 0 ? it.price! : (it.amount ?? 0) / it.quantity!;
      if (!(price > 0)) { skip(t('Posição sem preço', 'Position without price')); continue; }
      const key = `ai-pos|${asOf}|${ticker}|${diff}`;
      out.push({ key, ticker, name: it.name ?? undefined, cls, assetExtra: extra, tx: { type: 'BUY', date: asOf, quantity: diff, price, fees: 0, institution: inst, source: 'csv', importKey: key, notes: t('Posição do documento — custo = preço na data', 'Document position — cost = price on that date') }, duplicate: keys.has(key), warning: t('Custo = preço na data do documento. Edite se souber o preço pago.', 'Cost = price on the document date. Edit it if you know what you paid.') });
    } else if ((it.kind === 'position' || it.kind === 'trade') && (cls === 'RENDA_FIXA' || cls === 'FUNDO' || cls === 'OUTRO') && (it.amount ?? 0) > 0) {
      const rate = parseRate(it.rate ?? '') ?? { indexer: 'CDI' as const, rate: 100 };
      const name = (it.name || ticker || t('Renda fixa', 'Fixed income')).trim();
      const label = [name, inst && !name.toLowerCase().includes(inst.toLowerCase()) ? inst : '', it.rate ?? ''].filter(Boolean).join(' ').replace(/\s+/g, ' ');
      const maturity = ISO_DATE.test(it.maturity ?? '') ? it.maturity! : undefined;
      const has = existing.assets.find((a) => a.ticker.toLowerCase() === label.toLowerCase());
      if (it.kind === 'position') {
        const key = `ai-fix|${label}|${asOf}`;
        out.push({ key, ticker: label, cls: cls === 'OUTRO' ? 'RENDA_FIXA' : cls, tx: { type: 'BUY', date: asOf, quantity: 1, price: it.amount!, fees: 0, institution: inst, source: 'csv', importKey: key }, duplicate: false, fixed: { kind: /lci/i.test(name) ? 'LCI' : /lca/i.test(name) ? 'LCA' : /tesouro/i.test(name) ? 'TESOURO' : 'CDB', indexer: rate.indexer, rate: rate.rate, maturity, daily: /liquidez|di[áa]ria|caixinha/i.test(name) || undefined }, balance: { value: it.amount!, date: asOf }, balanceOnly: !!has, warning: has ? t('Já existe — só atualiza o saldo', 'Already there — only updates the balance') : undefined });
      } else {
        const type: TxType = it.side === 'SELL' ? 'SELL' : 'BUY';
        const key = `ai-fixtx|${label}|${date}|${type}|${it.amount}`;
        out.push({ key, ticker: label, cls: cls === 'OUTRO' ? 'RENDA_FIXA' : cls, tx: { type, date, quantity: 1, price: it.amount!, fees: 0, institution: inst, source: 'csv', importKey: key }, duplicate: keys.has(key), fixed: { kind: 'CDB', indexer: rate.indexer, rate: rate.rate, maturity } });
      }
    } else if (it.kind === 'cash' && (it.amount ?? 0) >= 0 && it.amount !== null && it.amount !== undefined) {
      const cur = it.currency;
      const tk = `${cur === 'USD' ? t('Dólar', 'Dollars') : cur === 'EUR' ? 'Euro' : t('Reais', 'Reais')} ${inst ?? ''}`.trim();
      const diff = Math.round((it.amount - held(tk)) * 100) / 100;
      if (Math.abs(diff) < 0.005) { skip(t(`${tk}: saldo já confere`, `${tk}: balance already matches`)); continue; }
      const key = `ai-cash|${tk}|${asOf}|${it.amount}`;
      out.push({ key, ticker: tk, cls: 'CAIXA', assetExtra: { currency: cur, currentPrice: 1 }, tx: { type: diff > 0 ? 'BUY' : 'SELL', date: asOf, quantity: Math.abs(diff), price: 1, fees: 0, institution: inst, source: 'csv', importKey: key }, duplicate: keys.has(key) });
    } else {
      skip(t('Item que a IA não soube classificar', "Item the AI couldn't classify"));
    }
  }
  return { format: 'ai', rows: out, skipped };
}
type AiItemLike = {
  kind: string; date?: string | null; side?: 'BUY' | 'SELL' | null; ticker?: string | null; name?: string | null; assetType: string;
  quantity?: number | null; price?: number | null; amount?: number | null; fees?: number | null; currency: 'BRL' | 'USD' | 'EUR';
  rate?: string | null; maturity?: string | null; dividendType?: 'DIVIDEND' | 'JCP' | 'INCOME' | null;
};

/** Which kind of PDF is this? */
export function buildPdfPreview(lines: string[], existing: { assets: Asset[]; transactions: Transaction[] }): ImportPreview {
  const text = lines.join('\n');
  if (/Extrato de Cust[óo]dia|Cust[óo]dia em/i.test(text)) return buildCustodyPreview(lines, existing);
  if (/Account Statement/i.test(text) && /PORTFOLIO|TRADING ACTIVIT/i.test(text)) return buildBrokerStatementPreview(lines, existing);
  if (/conta dep[óo]sito|Saldo final do per[íi]odo/i.test(text) && /US\$/.test(text)) return buildUsdCashPreview(lines, existing);
  if (/d[óo]lar ?app|arqfinance|D[óo]lares digitales/i.test(text) && /Balance Final/i.test(text)) return buildDolarAppPreview(lines, existing);
  return buildGenericPreview(lines, existing);
}

const numFmt = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',');

export const FORMAT_LABEL = (): Record<string, string> => ({
  custody: t('Extrato de custódia (PDF) — posição de hoje', 'Custody statement (PDF) — current holdings'),
  apex: t('Extrato mensal da corretora dos EUA (PDF)', 'US broker monthly statement (PDF)'),
  generic: t('Negociações encontradas no documento', 'Trades found in the document'),
  ai: t('Lido com IA (Gemini) — confira antes de importar', 'Read with AI (Gemini) — check before importing'),
  'usd-cash': t('Saldo em dólar na conta (PDF)', 'Dollar account balance (PDF)'),
  negociacao: 'B3 — Negociação',
  movimentacao: 'B3 — Movimentação',
  template: t('Planilha modelo', 'Template spreadsheet'),
  'us-broker': t('Corretora dos EUA (Nomad, Avenue…)', 'US broker (Nomad, Avenue…)'),
  bank: t('Extrato do banco — caixinhas e aplicações', 'Bank statement — savings boxes and deposits'),
  desconhecido: t('Formato não reconhecido', 'Unrecognized format'),
});

/** Turns selected preview rows into transactions + any new assets needed. */
export function materialize(rows: PreviewRow[], assets: Asset[]) {
  const byTicker = new Map(assets.map((a) => [a.ticker.toUpperCase(), a]));
  const created: Asset[] = [];
  const txs: Omit<Transaction, 'id' | 'createdAt'>[] = [];
  const balances: { assetId: string; value: number; date: string }[] = [];
  for (const r of rows) {
    let a = byTicker.get(r.ticker.toUpperCase());
    if (!a) {
      const tesouro = r.cls === 'RENDA_FIXA' && r.ticker.toLowerCase().startsWith('tesouro');
      a = newAsset({
        ...r.assetExtra,
        ticker: r.ticker,
        name: r.name,
        cls: r.cls,
        institution: r.tx.institution,
        fixed: r.fixed
          ? r.fixed
          : tesouro
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
    if (r.balance) balances.push({ assetId: a.id, ...r.balance });
    if (!r.balanceOnly) txs.push({ ...r.tx, assetId: a.id });
  }
  return { created, txs, balances };
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
  XLSX.writeFile(wb, 'modelo-importacao-wallet.xlsx');
}
