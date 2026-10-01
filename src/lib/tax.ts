import type { Asset, AssetClass, Settings, Transaction } from './types';
import { isMarketClass } from './types';
import { allSales, computePositions, groupTx, type Position, type Sale } from './portfolio';
import { FIXED_KIND_PT, t as tr } from './i18n';

export const ACOES_EXEMPTION = 20000;
export const CRYPTO_EXEMPTION = 35000;
const IRRF_RATE = 0.00005; // 0,005% "dedo-duro" on swing-trade sales
const DARF_MIN = 10;

export interface MonthTax {
  month: string; // YYYY-MM
  acoesSales: number;
  acoesResult: number;
  acoesExempt: boolean;
  /** Exempt profit from ações (goes to Rendimentos Isentos). */
  acoesExemptGain: number;
  etfResult: number;
  bdrResult: number;
  comumResult: number;
  comumLossUsed: number;
  comumLossBalance: number;
  comumBase: number;
  comumTax: number;
  fiiSales: number;
  fiiResult: number;
  fiiLossUsed: number;
  fiiLossBalance: number;
  fiiBase: number;
  fiiTax: number;
  irrf: number;
  irrfUsed: number;
  totalTax: number;
  /** Amount of the DARF 6015 to pay this month (after IRRF and the R$10 minimum carry). */
  darf: number;
  darfCarry: number;
  cryptoSales: number;
  cryptoGain: number;
  cryptoExempt: boolean;
  cryptoTax: number;
  dayTrades: number;
  oversold: number;
}

export interface TaxYear {
  year: number;
  months: MonthTax[];
  exterior: { sales: number; result: number; tax: number };
  totals: {
    comumTax: number;
    fiiTax: number;
    darf: number;
    acoesExemptGain: number;
    cryptoTax: number;
  };
  warnings: string[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function computeTaxYear(sales: Sale[], year: number): TaxYear {
  const byMonth = new Map<string, Sale[]>();
  for (const s of sales) {
    const ym = s.date.slice(0, 7);
    const arr = byMonth.get(ym);
    if (arr) arr.push(s);
    else byMonth.set(ym, [s]);
  }

  let comumLoss = 0;
  let fiiLoss = 0;
  let irrfBalance = 0;
  let darfCarry = 0;
  const months: MonthTax[] = [];
  const warnings: string[] = [];
  let exterior = { sales: 0, result: 0, tax: 0 };

  const firstYear = sales.length ? Number(sales[0].date.slice(0, 4)) : year;
  for (let y = Math.min(firstYear, year); y <= year; y++) {
    irrfBalance = 0; // IRRF compensates only within the same calendar year
    let extSales = 0;
    let extResult = 0;
    for (let m = 1; m <= 12; m++) {
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      const list = byMonth.get(ym) ?? [];
      const sum = (cls: AssetClass, f: (s: Sale) => number) =>
        list.filter((s) => s.cls === cls).reduce((a, s) => a + f(s), 0);

      const acoesSales = sum('ACAO', (s) => s.grossValue);
      const acoesResult = sum('ACAO', (s) => s.gain);
      const acoesExempt = acoesSales <= ACOES_EXEMPTION;
      const acoesExemptGain = acoesExempt && acoesResult > 0 ? acoesResult : 0;
      const etfResult = sum('ETF', (s) => s.gain);
      const bdrResult = sum('BDR', (s) => s.gain);
      const comumResult = (acoesExempt ? Math.min(acoesResult, 0) : acoesResult) + etfResult + bdrResult;

      let comumLossUsed = 0;
      let comumBase = 0;
      if (comumResult > 0) {
        comumLossUsed = Math.min(comumLoss, comumResult);
        comumLoss -= comumLossUsed;
        comumBase = comumResult - comumLossUsed;
      } else comumLoss += -comumResult;
      const comumTax = comumBase * 0.15;

      const fiiSales = sum('FII', (s) => s.grossValue);
      const fiiResult = sum('FII', (s) => s.gain);
      let fiiLossUsed = 0;
      let fiiBase = 0;
      if (fiiResult > 0) {
        fiiLossUsed = Math.min(fiiLoss, fiiResult);
        fiiLoss -= fiiLossUsed;
        fiiBase = fiiResult - fiiLossUsed;
      } else fiiLoss += -fiiResult;
      const fiiTax = fiiBase * 0.2;

      const swingSales =
        acoesSales + fiiSales + sum('ETF', (s) => s.grossValue) + sum('BDR', (s) => s.grossValue);
      const irrf = swingSales * IRRF_RATE;
      irrfBalance += irrf;
      const totalTax = comumTax + fiiTax;
      const irrfUsed = Math.min(irrfBalance, totalTax);
      irrfBalance -= irrfUsed;
      const due = totalTax - irrfUsed + darfCarry;
      const darf = due >= DARF_MIN ? due : 0;
      darfCarry = due >= DARF_MIN ? 0 : due;

      const cryptoSales = sum('CRIPTO', (s) => s.grossValue);
      const cryptoGain = sum('CRIPTO', (s) => s.gain);
      const cryptoExempt = cryptoSales <= CRYPTO_EXEMPTION;
      const cryptoTax = cryptoExempt ? 0 : Math.max(0, cryptoGain) * 0.15;

      extSales += sum('EXTERIOR', (s) => s.grossValue);
      extResult += sum('EXTERIOR', (s) => s.gain);

      const dayTrades = list.filter((s) => s.dayTrade && s.cls !== 'CRIPTO' && s.cls !== 'EXTERIOR').length;
      const oversold = list.filter((s) => s.oversold).length;

      if (y === year) {
        months.push({
          month: ym, acoesSales, acoesResult, acoesExempt, acoesExemptGain, etfResult, bdrResult,
          comumResult, comumLossUsed, comumLossBalance: comumLoss, comumBase, comumTax,
          fiiSales, fiiResult, fiiLossUsed, fiiLossBalance: fiiLoss, fiiBase, fiiTax,
          irrf, irrfUsed, totalTax, darf: r2(darf), darfCarry,
          cryptoSales, cryptoGain, cryptoExempt, cryptoTax, dayTrades, oversold,
        });
        if (dayTrades) warnings.push(tr(`${ym}: ${dayTrades} venda(s) no mesmo dia de uma compra (possível day trade, tributado a 20% e apurado separadamente). O cálculo aqui trata tudo como operação comum — confira.`, `${ym}: ${dayTrades} sale(s) on the same day as a buy (possible day trade, taxed at 20% and calculated separately). This report treats everything as regular trades — please check.`));
        if (oversold) warnings.push(tr(`${ym}: venda maior do que a quantidade em carteira. Falta algum lançamento de compra, bonificação ou desdobro?`, `${ym}: sold more than you held. Is a buy, bonus or split missing?`));
      }
    }
    if (y === year) {
      // Lei 14.754/2023: foreign investments taxed yearly at 15%, losses offset within the year.
      exterior = { sales: extSales, result: extResult, tax: Math.max(0, extResult) * 0.15 };
    }
  }

  const tot = (f: (m: MonthTax) => number) => months.reduce((a, m) => a + f(m), 0);
  return {
    year,
    months,
    exterior,
    totals: {
      comumTax: tot((m) => m.comumTax),
      fiiTax: tot((m) => m.fiiTax),
      darf: tot((m) => m.darf),
      acoesExemptGain: tot((m) => m.acoesExemptGain),
      cryptoTax: tot((m) => m.cryptoTax),
    },
    warnings,
  };
}

// ---------- Bens e Direitos ----------

export interface BemDireito {
  asset: Asset;
  group: string;
  code: string;
  codeLabel: string;
  prevCost: number;
  cost: number;
  quantity: number;
  prevQuantity: number;
  avgPrice: number;
  description: string;
}

function irCode(a: Asset): { group: string; code: string; label: string } {
  switch (a.cls) {
    case 'ACAO':
      return { group: '03', code: '01', label: 'Ações (inclusive listadas em bolsa)' };
    case 'CAIXA':
      return { group: '06', code: '01', label: 'Depósito em conta corrente ou conta pagamento — exterior' };
    case 'EXTERIOR':
      return { group: '03', code: '01', label: 'Ações — localização: exterior' };
    case 'FII':
      return { group: '07', code: '03', label: 'Fundos de Investimento Imobiliário (FII)' };
    case 'ETF':
      return { group: '07', code: '—', label: 'Fundos de Índice (ETF) — confira o código no programa' };
    case 'BDR':
      return { group: '04', code: '04', label: 'Ativos negociados em bolsa no Brasil (BDRs, opções e outros)' };
    case 'FUNDO':
      return { group: '07', code: '—', label: 'Fundos de investimento — código conforme o tipo do fundo' };
    case 'CRIPTO': {
      const t = a.ticker.toUpperCase();
      if (t === 'BTC') return { group: '08', code: '01', label: 'Criptoativo Bitcoin (BTC)' };
      if (['USDT', 'USDC', 'DAI', 'BUSD'].includes(t)) return { group: '08', code: '03', label: 'Stablecoins' };
      return { group: '08', code: '02', label: 'Outros criptoativos (altcoins)' };
    }
    case 'RENDA_FIXA': {
      const k = a.fixed?.kind;
      if (k === 'POUPANCA') return { group: '04', code: '01', label: 'Depósito em conta poupança' };
      if (k === 'LCI' || k === 'LCA' || k === 'CRI' || k === 'CRA' || k === 'DEBENTURE_INCENTIVADA')
        return { group: '04', code: '03', label: 'Títulos isentos de tributação (LCI, LCA, CRI, CRA…)' };
      return { group: '04', code: '02', label: 'Títulos sujeitos à tributação (Tesouro, CDB, RDB…)' };
    }
    default:
      return { group: '99', code: '99', label: 'Outros bens e direitos' };
  }
}

// The Discriminação goes on the Brazilian tax return: always Portuguese, pt-BR formatting.
const ptBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const ptNum = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 });
const ptMoney = (v: number) => ptBRL.format(v);
const ptQty = (v: number) => ptNum.format(v);
const ptDate = (iso?: string) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

function describe(a: Asset, p: Position): string {
  const inst = a.institution ? `, custodiado(a) em ${a.institution}` : '';
  const cnpj = a.cnpj ? ` CNPJ ${a.cnpj}.` : '';
  const name = a.name ? ` - ${a.name}` : '';
  if (a.cls === 'CAIXA') {
    const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(p.quantity);
    return `Saldo de ${usd} em conta${inst ? inst.replace(', custodiado(a) em', ' na') : ''} no exterior. Custo em reais ${ptMoney(p.cost)}.`;
  }
  if (isMarketClass(a.cls)) {
    const unit =
      a.cls === 'ACAO' || a.cls === 'EXTERIOR' ? 'ações' : a.cls === 'CRIPTO' ? 'unidades de' : 'cotas de';
    return `${ptQty(p.quantity)} ${unit} ${a.ticker}${name}, preço médio de ${ptMoney(p.avgPrice)}${inst}.${cnpj}`;
  }
  const f = a.fixed;
  const kindLabel = f ? FIXED_KIND_PT[f.kind] : '';
  const kind = kindLabel && !a.ticker.toLowerCase().startsWith(kindLabel.toLowerCase()) ? kindLabel + ' ' : '';
  const issuer = f?.issuer ? ` emitido por ${f.issuer}` : '';
  const venc = f?.maturity ? `, vencimento em ${ptDate(f.maturity)}` : '';
  return `${kind}${a.ticker}${issuer}${venc}. Valor aplicado ${ptMoney(p.cost)}${inst}.${cnpj}`;
}

export function bensEDireitos(
  assets: Asset[],
  txs: Transaction[],
  settings: Settings,
  year: number,
): BemDireito[] {
  const endPrev = `${year - 1}-12-31`;
  const end = `${year}-12-31`;
  const cur = computePositions(assets, txs, settings, end);
  const prev = computePositions(assets, txs, settings, endPrev);
  const prevById = new Map(prev.map((p) => [p.asset.id, p]));
  const hasTx = groupTx(txs);
  const out: BemDireito[] = [];
  for (const p of cur) {
    const pp = prevById.get(p.asset.id);
    if (!hasTx.get(p.asset.id)?.some((t) => t.date <= end)) continue;
    if (p.cost < 0.01 && (!pp || pp.cost < 0.01)) continue;
    const c = irCode(p.asset);
    out.push({
      asset: p.asset,
      group: c.group,
      code: c.code,
      codeLabel: c.label,
      prevCost: pp?.cost ?? 0,
      cost: p.cost,
      quantity: p.quantity,
      prevQuantity: pp?.quantity ?? 0,
      avgPrice: p.avgPrice,
      description: describe(p.asset, p),
    });
  }
  return out.sort((a, b) => (a.group + a.code + a.asset.ticker).localeCompare(b.group + b.code + b.asset.ticker));
}

// ---------- Proventos ----------

export interface IncomeRow {
  asset: Asset;
  dividends: number;
  jcp: number;
  fiiIncome: number;
  other: number;
}

export function incomeByAsset(assets: Asset[], txs: Transaction[], year: number): IncomeRow[] {
  const map = new Map<string, IncomeRow>();
  const assetById = new Map(assets.map((a) => [a.id, a]));
  for (const t of txs) {
    if (!t.date.startsWith(String(year))) continue;
    if (t.type !== 'DIVIDEND' && t.type !== 'JCP' && t.type !== 'INCOME') continue;
    const a = assetById.get(t.assetId);
    if (!a) continue;
    let row = map.get(a.id);
    if (!row) map.set(a.id, (row = { asset: a, dividends: 0, jcp: 0, fiiIncome: 0, other: 0 }));
    const v = t.quantity * t.price;
    if (t.type === 'DIVIDEND') row.dividends += v;
    else if (t.type === 'JCP') row.jcp += v;
    else if (a.cls === 'FII') row.fiiIncome += v;
    else row.other += v;
  }
  return [...map.values()].sort((a, b) => a.asset.ticker.localeCompare(b.asset.ticker));
}

// ---------- Tax preview for a single sale ----------

/** DARF due date: last business day of the month after the sale (ignores holidays). */
export function darfDue(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m + 1, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export interface SaleTaxEstimate {
  /** Result of this sale in BRL (proceeds − cost at average price). */
  gain: number;
  /** Extra income tax this sale causes, in BRL. */
  tax: number;
  /**
   * How the tax works for this asset:
   * - exempt-stocks: B3 stocks, month's stock sales ≤ R$ 20k (gain is tax-free)
   * - monthly: DARF 6015 by the end of next month (stocks > 20k, ETFs, BDRs, FIIs)
   * - crypto: GCAP, exempt when month's crypto sales ≤ R$ 35k
   * - annual: foreign assets (Lei 14.754/2023), 15% paid with the yearly return
   * - loss: no tax; the loss offsets future gains
   */
  kind: 'exempt-stocks' | 'monthly' | 'crypto' | 'crypto-exempt' | 'annual' | 'loss';
  /** Rate applied (0.15 / 0.2). */
  rate: number;
  /** Stock (or crypto) sales in the month including this one, for the exemption limit. */
  monthSales: number;
  limit?: number;
  dueDate?: string;
}

/** What this sale would add to the user's income tax, using the same engine as the IR report. */
export function estimateSaleTax(
  assets: Asset[],
  txs: Transaction[],
  settings: Pick<Settings, 'fx'>,
  draft: Transaction,
): SaleTaxEstimate | null {
  const asset = assets.find((a) => a.id === draft.assetId);
  if (!asset || !isMarketClass(asset.cls) || draft.type !== 'SELL') return null;
  const others = txs.filter((t) => t.id !== draft.id);
  const before = allSales(assets, others, settings);
  const after = allSales(assets, [...others, draft], settings);
  const sale = after.find((s) => s.txId === draft.id);
  if (!sale) return null;
  const year = Number(draft.date.slice(0, 4));
  const ym = draft.date.slice(0, 7);
  const tb = computeTaxYear(before, year);
  const ta = computeTaxYear(after, year);
  const mb = tb.months.find((m) => m.month === ym)!;
  const ma = ta.months.find((m) => m.month === ym)!;
  const base = { gain: sale.gain, monthSales: 0 };

  if (asset.cls === 'EXTERIOR') {
    const tax = Math.max(0, ta.exterior.tax - tb.exterior.tax);
    return { ...base, tax, rate: 0.15, kind: sale.gain < 0 ? 'loss' : 'annual' };
  }
  if (asset.cls === 'CRIPTO') {
    const tax = Math.max(0, ma.cryptoTax - mb.cryptoTax);
    return {
      ...base, tax, rate: 0.15, monthSales: ma.cryptoSales, limit: CRYPTO_EXEMPTION,
      kind: sale.gain < 0 ? 'loss' : ma.cryptoExempt ? 'crypto-exempt' : 'crypto',
    };
  }
  const tax = Math.max(0, ma.totalTax - mb.totalTax);
  if (asset.cls === 'ACAO') {
    return {
      ...base, tax, rate: 0.15, monthSales: ma.acoesSales, limit: ACOES_EXEMPTION,
      kind: sale.gain < 0 ? 'loss' : ma.acoesExempt ? 'exempt-stocks' : 'monthly',
      dueDate: tax > 0 ? darfDue(ym) : undefined,
    };
  }
  return {
    ...base, tax, rate: asset.cls === 'FII' ? 0.2 : 0.15,
    kind: sale.gain < 0 ? 'loss' : 'monthly',
    dueDate: tax > 0 ? darfDue(ym) : undefined,
  };
}
