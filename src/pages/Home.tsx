import { useMemo, useState } from 'react';
import { actions, useData } from '../lib/store';
import { allSales, computePositions, investedSeries, type Position } from '../lib/portfolio';
import { computeTaxYear } from '../lib/tax';
import { CLASS_LABEL, CLASS_ORDER, INCOME_TYPES, isMarketClass, type AssetClass } from '../lib/types';
import { fmtDate, money, percent, qty, signedPercent, today, toISODate } from '../lib/format';
import { AreaChart } from '../components/charts';
import { Icon } from '../components/Icon';
import { toast } from '../components/ui';
import { fetchQuotes } from '../lib/quotes';
import { sampleData } from '../lib/sample';

type SortKey = 'value' | 'result' | 'name';

export function Home({ onAdd, open, openAsset }: { onAdd: () => void; open: (p: string) => void; openAsset: (id: string) => void }) {
  const data = useData();
  const t = today();
  const [filter, setFilter] = useState<AssetClass | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('value');
  const [loading, setLoading] = useState(false);

  const positions = useMemo(
    () => computePositions(data.assets, data.transactions, data.settings, t).filter((p) => !p.closed && (p.cost > 0.005 || p.value > 0.005)),
    [data, t],
  );
  const series = useMemo(
    () => investedSeries(data.assets, data.transactions, data.settings, t).map((d) => ({ month: d.month, value: d.cost })),
    [data, t],
  );
  const year = Number(t.slice(0, 4));
  const tax = useMemo(() => computeTaxYear(allSales(data.assets, data.transactions), year), [data, year]);

  if (!data.assets.length) {
    return (
      <div className="welcome">
        <div className="eyebrow">Sua carteira, num lugar só</div>
        <h1 style={{ marginTop: 18 }}>
          Tudo o que você investe,<br /><em>bonito e organizado.</em>
        </h1>
        <p>Ações, FIIs, CDBs, Tesouro e cripto — com preço médio, proventos e o imposto de renda prontos quando você precisar.</p>
        <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="pill-btn" onClick={onAdd}><Icon name="plus" /> Adicionar investimento</button>
          <button className="btn" style={{ height: 40 }} onClick={() => open('importar')}><Icon name="upload" size={16} /> Importar da B3</button>
          <button className="btn ghost" style={{ height: 40 }} onClick={() => actions.replaceAll({ ...sampleData(), settings: data.settings }, 'Exemplo carregado')}>
            Ver com dados de exemplo
          </button>
        </div>
      </div>
    );
  }

  const total = positions.reduce((s, p) => s + p.value, 0);
  const cost = positions.reduce((s, p) => s + p.cost, 0);
  const result = total - cost;
  const yearAgo = `${year - 1}${t.slice(4)}`;
  const income12m = data.transactions
    .filter((x) => INCOME_TYPES.includes(x.type) && x.date > yearAgo && x.date <= t)
    .reduce((s, x) => s + x.quantity * x.price, 0);
  const realizedYear = allSales(data.assets, data.transactions)
    .filter((s) => s.date.startsWith(String(year)))
    .reduce((s, x) => s + x.gain, 0);

  // Next DARF: the latest month with tax due whose deadline hasn't passed.
  const pending = tax.months
    .filter((m) => m.darf > 0)
    .map((m) => ({ ...m, due: darfDue(m.month) }))
    .filter((m) => m.due >= t);
  const nextDarf = pending[0];

  const byClass = new Map<AssetClass, number>();
  for (const p of positions) byClass.set(p.asset.cls, (byClass.get(p.asset.cls) ?? 0) + p.value);
  const classes = CLASS_ORDER.filter((c) => byClass.get(c)).sort((a, b) => byClass.get(b)! - byClass.get(a)!);

  const s = q.trim().toLowerCase();
  const list = positions
    .filter((p) => (!filter || p.asset.cls === filter) && (!s || `${p.asset.ticker} ${p.asset.name ?? ''} ${p.asset.institution ?? ''}`.toLowerCase().includes(s)))
    .sort((a, b) =>
      sort === 'name' ? a.asset.ticker.localeCompare(b.asset.ticker) : sort === 'result' ? pct(b) - pct(a) : b.value - a.value,
    );

  async function refreshQuotes() {
    const targets = positions.map((p) => p.asset).filter((a) => isMarketClass(a.cls) && a.cls !== 'EXTERIOR');
    if (!targets.length) return toast('Nenhum ativo de bolsa para atualizar');
    if (!data.settings.brapiToken) {
      toast('Cadastre seu token gratuito da brapi.dev nas Configurações');
      return open('config');
    }
    setLoading(true);
    const { prices, errors } = await fetchQuotes(targets, data.settings.brapiToken);
    setLoading(false);
    const now = new Date().toISOString();
    for (const a of targets) {
      const p = prices.get(a.ticker);
      if (p) actions.updateAsset(a.id, { currentPrice: p, priceUpdatedAt: now });
    }
    toast(prices.size ? `${prices.size} cotações atualizadas${errors.length ? ` · ${errors.length} falharam` : ''}` : 'Não foi possível buscar as cotações');
  }

  const [whole, cents] = splitMoney(total);

  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">Patrimônio total</div>
          <div className="big-number">
            {whole}
            {cents && <span className="cents">{cents}</span>}
          </div>
          <div className="badges">
            <span className={'badge ' + (result >= 0 ? 'pos' : 'neg')}>
              <Icon name={result >= 0 ? 'up' : 'down'} size={14} />
              {money(Math.abs(result))} · {signedPercent(cost ? result / cost : 0)}
            </span>
            <span className="badge">Investido {money(cost)}</span>
            <span className="badge">{positions.length} ativos</span>
          </div>
        </div>
        <div className="hero-chart">
          <div className="row" style={{ padding: '0 6px 6px' }}>
            <span className="eyebrow">Valor aplicado</span>
            <div className="spacer" />
            <span className="muted small">desde {fmtMonthLong(series[0]?.month)}</span>
          </div>
          <AreaChart data={series} height={170} compact />
        </div>
      </section>

      <div className="tiles">
        <button className="tile" onClick={() => open('proventos')}>
          <span className="t-label"><Icon name="coins" size={14} /> Proventos · 12 meses</span>
          <span className="t-value">{money(income12m)}</span>
          <span className="t-sub">≈ {money(income12m / 12)} por mês · {percent(total ? income12m / total : 0)} a.a.</span>
        </button>
        <button className={'tile' + (nextDarf ? ' alert' : '')} onClick={() => open('ir')}>
          <span className="t-label"><Icon name="receipt" size={14} /> Imposto de renda</span>
          <span className="t-value">{nextDarf ? money(nextDarf.darf, { always: true }) : 'Nada a pagar'}</span>
          <span className="t-sub">{nextDarf ? `DARF 6015 vence ${fmtDate(nextDarf.due)}` : `Relatório do IR ${year - 1} pronto →`}</span>
        </button>
        <button className="tile" onClick={() => open('lancamentos')}>
          <span className="t-label"><Icon name="chart" size={14} /> Lucro com vendas em {year}</span>
          <span className={'t-value ' + (realizedYear > 0 ? 'pos' : realizedYear < 0 ? 'neg' : '')}>{money(realizedYear)}</span>
          <span className="t-sub">{tax.totals.acoesExemptGain > 0 ? `${money(tax.totals.acoesExemptGain)} isento de IR` : 'resultado realizado no ano'}</span>
        </button>
      </div>

      <section className="section">
        <div className="section-head"><h2>Onde está seu dinheiro</h2></div>
        <div className="alloc-bar">
          {classes.map((c) => {
            const v = byClass.get(c)!;
            const w = v / total;
            return (
              <button
                key={c}
                className={'alloc-seg' + (filter && filter !== c ? ' dim' : '')}
                style={{ flexGrow: w, flexBasis: 0, background: `var(--c-${c})` }}
                title={`${CLASS_LABEL[c]} · ${money(v)} · ${percent(w)}`}
                onClick={() => setFilter(filter === c ? null : c)}
              >
                {w > 0.07 && <span className="pct" style={{ color: 'var(--on-series)' }}>{percent(w)}</span>}
              </button>
            );
          })}
        </div>
        <div className="alloc-legend">
          {classes.map((c) => (
            <button key={c} className={filter === c ? 'on' : ''} onClick={() => setFilter(filter === c ? null : c)}>
              <span className="sw" style={{ background: `var(--c-${c})` }} />
              {CLASS_LABEL[c]} <span className="v">{money(byClass.get(c)!)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Seus ativos</h2>
          <div className="spacer" />
          <div className="search-inline">
            <Icon name="search" size={15} />
            <input placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="round-btn" style={{ width: 34, height: 34 }} title="Atualizar cotações" onClick={refreshQuotes} disabled={loading}>
            <span style={{ display: 'inline-grid', animation: loading ? 'spin 0.8s linear infinite' : undefined }}><Icon name="refresh" size={16} /></span>
          </button>
        </div>
        <div className="chips" style={{ marginBottom: 12 }}>
          <button className={'chip-btn' + (!filter ? ' on' : '')} onClick={() => setFilter(null)}>Tudo</button>
          {classes.map((c) => (
            <button key={c} className={'chip-btn' + (filter === c ? ' on' : '')} onClick={() => setFilter(filter === c ? null : c)}>{CLASS_LABEL[c]}</button>
          ))}
        </div>

        <div className="holdings">
          <div className="h-row head">
            <span />
            <button style={{ textAlign: 'left' }} onClick={() => setSort('name')}>Ativo{sort === 'name' ? ' ↓' : ''}</button>
            <span className="h-cell hide-md">Quantidade</span>
            <span className="h-cell hide-md">Preço médio</span>
            <button className="h-cell" onClick={() => setSort('value')}>Valor{sort === 'value' ? ' ↓' : ''}</button>
            <button className="h-cell" onClick={() => setSort('result')}>Resultado{sort === 'result' ? ' ↓' : ''}</button>
          </div>
          {list.map((p) => {
            const m = isMarketClass(p.asset.cls);
            const r = p.value - p.cost;
            return (
              <div key={p.asset.id} className="h-row" onClick={() => openAsset(p.asset.id)}>
                <span className="avatar" style={{ background: `color-mix(in srgb, var(--c-${p.asset.cls}) 18%, transparent)`, color: `var(--c-${p.asset.cls})` }}>
                  {initials(p.asset.ticker, m)}
                </span>
                <span className="h-name">
                  <b>{p.asset.ticker}</b>
                  <span>{[p.asset.name ?? CLASS_LABEL[p.asset.cls], p.asset.institution].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="h-cell hide-md">
                  {m ? qty(p.quantity) : <span className="muted">{p.valueIsEstimate ? 'estimado' : 'saldo'}</span>}
                </span>
                <span className="h-cell hide-md">{m ? money(p.avgPrice) : money(p.cost)}<small>{m ? (p.asset.currentPrice ? `atual ${money(p.asset.currentPrice)}` : 'sem cotação') : 'aplicado'}</small></span>
                <span className="h-cell">
                  <span className="h-value">{money(p.value)}</span>
                  <div className="weight"><div style={{ width: `${(p.value / total) * 100}%`, background: `var(--c-${p.asset.cls})` }} /></div>
                </span>
                <span className="h-cell">
                  <span className={'delta-pill ' + (r > 0.004 ? 'pos' : r < -0.004 ? 'neg' : '')}>{signedPercent(p.cost ? r / p.cost : 0)}</span>
                </span>
              </div>
            );
          })}
          {!list.length && <div className="empty">Nenhum ativo encontrado.</div>}
        </div>
      </section>
    </>
  );
}

const pct = (p: Position) => (p.cost ? (p.value - p.cost) / p.cost : 0);

function initials(ticker: string, market: boolean) {
  if (market) return ticker.replace(/\d+$/, '').slice(0, 4);
  const words = ticker.split(/\s+/).filter((w) => /[A-Za-zÀ-ú]/.test(w));
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function splitMoney(v: number): [string, string] {
  const s = money(v);
  const i = s.lastIndexOf(',');
  return i > 0 && !s.includes('•') ? [s.slice(0, i), s.slice(i)] : [s, ''];
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function fmtMonthLong(ym?: string) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** DARF due date: last business day of the following month (ignores holidays). */
export function darfDue(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m + 1, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return toISODate(d);
}
