import { useMemo, useState } from 'react';
import { actions, useData } from '../lib/store';
import { allSales, computePositions, type Position } from '../lib/portfolio';
import { computeTaxYear } from '../lib/tax';
import { CLASS_LABEL, CLASS_ORDER, CURRENCY_LABEL, INCOME_TYPES, isMarketClass, type AssetClass } from '../lib/types';
import { fmtCurrency, fmtDate, money, percent, qty, signedPercent, today, toISODate } from '../lib/format';
import { useLive, withLive } from '../lib/live';
import { PortfolioChart } from '../components/PortfolioChart';
import type { Range } from '../lib/history';
import { Donut, type DonutSlice } from '../components/Donut';
import { CountUp, Flash } from '../components/motion';
import { Icon } from '../components/Icon';
import { Logo, marketOf } from '../components/Logo';
import { sampleData } from '../lib/sample';
import { t } from '../lib/i18n';
import { useCloud, userFirstName } from '../lib/cloud';

type SortKey = 'value' | 'result' | 'day' | 'name';
type View = 'classe' | 'moeda' | 'ativo' | 'instituicao';
type Filter = { view: View; key: string } | null;

const PALETTE = ['var(--c-ACAO)', 'var(--c-FII)', 'var(--c-RENDA_FIXA)', 'var(--c-ETF)', 'var(--c-FUNDO)', 'var(--c-EXTERIOR)', 'var(--c-BDR)', 'var(--c-CRIPTO)'];
const CURRENCY_COLOR: Record<string, string> = { BRL: 'var(--c-RENDA_FIXA)', USD: 'var(--c-ACAO)', EUR: 'var(--c-BDR)', CRIPTO: 'var(--c-ETF)' };

/** Which "currency bucket" a position belongs to. Crypto gets its own. */
const bucketOf = (p: Position) => (p.asset.cls === 'CRIPTO' ? 'CRIPTO' : p.currency);
const bucketLabel = (k: string) => (k === 'CRIPTO' ? t('Cripto', 'Crypto') : CURRENCY_LABEL[k as keyof typeof CURRENCY_LABEL] ?? k);
const NO_INST = '__none';
const instLabel = (k: string) => (k === NO_INST ? t('Sem instituição', 'No institution') : k);

export function Home({ onAdd, open, openAsset }: { onAdd: () => void; open: (p: string) => void; openAsset: (id: string) => void }) {
  const data = useData();
  const live = useLive();
  const cloud = useCloud();
  const firstName = userFirstName(cloud.session);
  const tdy = today();
  const [filter, setFilter] = useState<Filter>(null);
  const [view, setView] = useState<View>('classe');
  const [hover, setHover] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('value');
  const [range, setRangeState] = useState<Range>(() => {
    try {
      return (localStorage.getItem('wallet:range') as Range) || '1M';
    } catch {
      return '1M';
    }
  });
  const setRange = (r: Range) => {
    setRangeState(r);
    try {
      localStorage.setItem('wallet:range', r);
    } catch {
      /* private mode */
    }
  };

  const assets = useMemo(() => withLive(data.assets, live), [data.assets, live]);
  const settings = useMemo(() => (live.fx ? { ...data.settings, fx: { ...data.settings.fx, ...live.fx } } : data.settings), [data.settings, live.fx]);
  const positions = useMemo(
    () => computePositions(assets, data.transactions, settings, tdy).filter((p) => !p.closed && (p.cost > 0.005 || p.value > 0.005)),
    [assets, data.transactions, settings, tdy],
  );
  const year = Number(tdy.slice(0, 4));
  const sales = useMemo(() => allSales(data.assets, data.transactions, data.settings), [data.assets, data.transactions, data.settings]);
  const tax = useMemo(() => computeTaxYear(sales, year), [sales, year]);

  if (!data.assets.length) {
    return (
      <div className="welcome reveal">
        <div className="eyebrow">
          {firstName ? t(`Que bom ter você aqui, ${firstName}!`, `Great to have you here, ${firstName}!`) : t('Sua carteira, num lugar só', 'Your portfolio, all in one place')}
        </div>
        <h1 style={{ marginTop: 18 }}>
          {t('Tudo o que você investe,', 'Everything you invest,')}<br /><em>{t('bonito e organizado.', 'beautiful and organized.')}</em>
        </h1>
        <p>{t('Ações daqui e de fora, FIIs, CDBs, Tesouro e cripto — com cotação ao vivo, preço médio, proventos e o imposto de renda prontos quando você precisar.', 'Brazilian and foreign stocks, REITs, CDBs, Tesouro and crypto — with live quotes, average prices, dividends and your tax report ready whenever you need them.')}</p>
        <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="pill-btn" onClick={onAdd}><Icon name="plus" /> {t('Adicionar investimento', 'Add an investment')}</button>
          <button className="btn" style={{ height: 40 }} onClick={() => open('importar')}><Icon name="upload" size={16} /> {t('Importar da B3', 'Import from B3')}</button>
          <button className="btn ghost" style={{ height: 40 }} onClick={() => actions.replaceAll({ ...sampleData(), settings: data.settings }, 'Exemplo carregado')}>
            {t('Ver com dados de exemplo', 'Try it with sample data')}
          </button>
        </div>
      </div>
    );
  }

  const total = positions.reduce((s, p) => s + p.value, 0);
  const cost = positions.reduce((s, p) => s + p.cost, 0);
  const result = total - cost;
  const dayChange = positions.reduce((s, p) => s + p.dayChange, 0);
  const yearAgo = `${year - 1}${tdy.slice(4)}`;
  const income12m = data.transactions
    .filter((x) => INCOME_TYPES.includes(x.type) && x.date > yearAgo && x.date <= tdy)
    .reduce((s, x) => s + x.quantity * x.price, 0);
  const realizedYear = sales.filter((s) => s.date.startsWith(String(year))).reduce((s, x) => s + x.gain, 0);
  const nextDarf = tax.months
    .filter((m) => m.darf > 0)
    .map((m) => ({ ...m, due: darfDue(m.month) }))
    .find((m) => m.due >= tdy);

  const yearTax = tax.totals.darf + tax.months.reduce((s, m) => s + m.cryptoTax, 0) + tax.exterior.tax;
  const isLive = Object.values(live.status).some((s) => s === 'live' || s === 'polling');
  const needsKey = live.status.us === 'needs-key' || live.status.b3 === 'needs-key';

  // ----- Donut groups for the selected view -----
  const groupKey = (p: Position): string =>
    view === 'classe' ? p.asset.cls : view === 'moeda' ? bucketOf(p) : view === 'ativo' ? p.asset.id : p.asset.institution || NO_INST;
  const groups = new Map<string, number>();
  for (const p of positions) groups.set(groupKey(p), (groups.get(groupKey(p)) ?? 0) + p.value);
  let slices: DonutSlice[] = [...groups]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v], i) => ({
      key: k,
      value: v,
      label:
        view === 'classe' ? CLASS_LABEL[k as AssetClass] : view === 'moeda' ? bucketLabel(k) : view === 'ativo' ? positions.find((p) => p.asset.id === k)!.asset.ticker : instLabel(k),
      color: view === 'classe' ? `var(--c-${k})` : view === 'moeda' ? CURRENCY_COLOR[k] : PALETTE[i % PALETTE.length],
      sub:
        view === 'moeda' && (k === 'USD' || k === 'EUR')
          ? fmtCurrency(positions.filter((p) => p.currency === k && p.asset.cls !== 'CRIPTO').reduce((s, p) => s + p.valueNative, 0), k)
          : undefined,
    }));
  if (slices.length > 8) {
    const rest = slices.slice(7);
    slices = [...slices.slice(0, 7), { key: '__outros', label: `${t('Outros', 'Other')} (${rest.length})`, value: rest.reduce((s, x) => s + x.value, 0), color: 'var(--c-OUTRO)' }];
  }
  if (view === 'classe') slices.sort((a, b) => CLASS_ORDER.indexOf(a.key as AssetClass) - CLASS_ORDER.indexOf(b.key as AssetClass));

  const selectSlice = (k: string) => {
    if (k === '__outros') return;
    if (view === 'ativo') return openAsset(k);
    setFilter(filter?.key === k ? null : { view, key: k });
  };

  // ----- Holdings list -----
  const s = q.trim().toLowerCase();
  const matchFilter = (p: Position) => {
    if (!filter) return true;
    const v = filter.view;
    return (v === 'classe' ? p.asset.cls : v === 'moeda' ? bucketOf(p) : p.asset.institution || NO_INST) === filter.key;
  };
  const dayPct = (p: Position) => {
    const r = p.asset.prevClose && p.asset.currentPrice ? p.asset.currentPrice / p.asset.prevClose : 1;
    return r < 1.5 && r > 0.67 ? r - 1 : 0;
  };
  const list = positions
    .filter((p) => matchFilter(p) && (!s || `${p.asset.ticker} ${p.asset.name ?? ''} ${p.asset.institution ?? ''}`.toLowerCase().includes(s)))
    .sort((a, b) =>
      sort === 'name' ? a.asset.ticker.localeCompare(b.asset.ticker) : sort === 'result' ? pct(b) - pct(a) : sort === 'day' ? dayPct(b) - dayPct(a) : b.value - a.value,
    );
  const classes = CLASS_ORDER.filter((c) => positions.some((p) => p.asset.cls === c));

  const [, cents] = splitMoney(total);

  return (
    <>
      <div className="greeting">{greeting(firstName, dayChange, total)}</div>
      <section className="hero" style={{ paddingTop: 8 }}>
        <div className="reveal">
          <div className="eyebrow row" style={{ gap: 10 }}>
            {t('Patrimônio total', 'Total net worth')}
            {isLive && <span className="live-dot" title={t('Cotações ao vivo', 'Live quotes')}>{t('ao vivo', 'live')}</span>}
          </div>
          <div className="big-number">
            <CountUp value={total} format={(v) => splitMoney(v)[0]} duration={1400} />
            {cents && <span className="cents">{cents}</span>}
          </div>
          <div className="perf">
            <button className={'perf-item' + (range === '1D' ? ' on' : '')} onClick={() => setRange('1D')} title={t('Ver no gráfico', 'Show on the chart')}>
              <span className="perf-label">{t('Hoje', 'Today')}</span>
              <span className={'perf-val ' + toneOf(dayChange)}>
                <Flash value={dayChange}>{signedMoney(dayChange)}</Flash>
                <small>{signedPercent(total - dayChange ? dayChange / (total - dayChange) : 0)}</small>
              </span>
            </button>
            <span className="perf-sep" />
            <button className={'perf-item' + (range === 'ALL' ? ' on' : '')} onClick={() => setRange('ALL')} title={t('Ver no gráfico', 'Show on the chart')}>
              <span className="perf-label">{t('Desde o início', 'All time')}</span>
              <span className={'perf-val ' + toneOf(result)}>
                <CountUp value={result} format={(v) => signedMoney(v)} duration={1400} />
                <small>{signedPercent(cost ? result / cost : 0)}</small>
              </span>
            </button>
          </div>
          <div className="fx-row">
            <FxQuote sym="US$" now={settings.fx.USD} prev={live.fx?.USDprev} />
            <FxQuote sym="€" now={settings.fx.EUR} prev={live.fx?.EURprev} />
          </div>
          {needsKey && (
            <button className="connect-hint" onClick={() => open('config')}>
              <Icon name="refresh" size={14} /> {t('Conecte as cotações ao vivo (grátis) →', 'Connect live quotes (free) →')}
            </button>
          )}
        </div>
        <div className="hero-chart reveal" style={{ ['--i' as string]: 2 }}>
          <PortfolioChart
            range={range}
            onRange={setRange}
            assets={assets}
            txs={data.transactions}
            settings={settings}
            positions={positions}
            total={total}
            cost={cost}
            dayChange={dayChange}
            openAsset={openAsset}
          />
        </div>
      </section>

      <div className="tiles">
        <button className="tile reveal" style={{ ['--i' as string]: 3 }} onClick={() => open('proventos')}>
          <span className="t-label"><Icon name="coins" size={14} /> {t('Proventos · 12 meses', 'Dividends · 12 months')}</span>
          <span className="t-value"><CountUp value={income12m} format={(v) => money(v)} /></span>
          <span className="t-sub">≈ {money(income12m / 12)} {t('por mês', 'per month')} · {percent(total ? income12m / total : 0)} {t('a.a.', 'p.a.')}</span>
        </button>
        <button className={'tile reveal' + (nextDarf ? ' alert' : '')} style={{ ['--i' as string]: 4 }} onClick={() => open('ir')}>
          <span className="t-label"><Icon name="receipt" size={14} /> {t(`IR sobre vendas de ${year}`, `Tax on ${year} sales`)}</span>
          <span className="t-value"><CountUp value={yearTax} format={(v) => money(v)} /></span>
          <span className="t-sub">
            {nextDarf
              ? t(`DARF de ${money(nextDarf.darf)} vence ${fmtDate(nextDarf.due)}`, `DARF of ${money(nextDarf.darf)} due ${fmtDate(nextDarf.due)}`)
              : tax.exterior.tax > 0.005
                ? yearTax - tax.exterior.tax > 0.005
                  ? t(`${money(tax.exterior.tax)} na declaração de ${year + 1} · resto via DARF →`, `${money(tax.exterior.tax)} with your ${year + 1} return · rest via DARF →`)
                  : t(`A pagar na declaração de ${year + 1} →`, `Due with your ${year + 1} return →`)
                : yearTax > 0.005
                  ? t('Pago mês a mês via DARF →', 'Paid monthly via DARF →')
                  : t('Nenhum imposto sobre o que vendeu até agora', 'No tax on what you sold so far')}
          </span>
        </button>
        <button className="tile reveal" style={{ ['--i' as string]: 5 }} onClick={() => open('lancamentos')}>
          <span className="t-label"><Icon name="chart" size={14} /> {t('Lucro com vendas em', 'Profit from sales in')} {year}</span>
          <span className={'t-value ' + (realizedYear > 0 ? 'pos' : realizedYear < 0 ? 'neg' : '')}><CountUp value={realizedYear} format={(v) => money(v)} /></span>
          <span className="t-sub">{tax.totals.acoesExemptGain > 0 ? `${money(tax.totals.acoesExemptGain)} ${t('isento de IR', 'tax-exempt')}` : t('Resultado realizado no ano', 'Realized this year')}</span>
        </button>
      </div>

      <section className="section reveal" style={{ ['--i' as string]: 6 }}>
        <div className="section-head">
          <h2>{t('Onde está seu dinheiro', 'Where your money is')}</h2>
          <div className="spacer" />
          <div className="seg">
            {([['classe', t('Classe', 'Class')], ['moeda', t('Moeda', 'Currency')], ['ativo', t('Ativo', 'Asset')], ['instituicao', t('Instituição', 'Institution')]] as [View, string][]).map(([v, l]) => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => { setView(v); setHover(null); }}>{l}</button>
            ))}
          </div>
        </div>
        {!positions.length ? (
          <div className="card empty">{t('Nada investido no momento — tudo foi vendido ou resgatado.', 'Nothing invested right now — everything was sold or redeemed.')}</div>
        ) : (
        <div className="alloc">
          <Donut
            slices={slices}
            active={hover ?? (filter?.view === view ? filter.key : null)}
            onHover={setHover}
            onSelect={selectSlice}
            centerLabel={view === 'moeda' ? t('Por moeda', 'By currency') : view === 'ativo' ? t('Por ativo', 'By asset') : view === 'instituicao' ? t('Por instituição', 'By institution') : t('Por classe', 'By class')}
            centerValue={total}
          />
          <div className="alloc-list">
            {slices.map((sl, i) => {
              const on = hover === sl.key || (filter?.view === view && filter.key === sl.key);
              return (
                <button
                  key={view + sl.key}
                  className={'alloc-item' + (on ? ' on' : '') + (hover && hover !== sl.key ? ' dim' : '')}
                  style={{ ['--i' as string]: i }}
                  onMouseEnter={() => setHover(sl.key)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => selectSlice(sl.key)}
                >
                  <span className="sw" style={{ background: sl.color }} />
                  <span className="al-name">
                    {sl.label}
                    {sl.sub && <small>{sl.sub}</small>}
                  </span>
                  <span className="al-val">{money(sl.value)}</span>
                  <span className="al-pct">{percent(sl.value / total)}</span>
                  <span className="al-bar"><span style={{ width: `${(sl.value / Math.max(...slices.map((x) => x.value))) * 100}%`, background: sl.color }} /></span>
                </button>
              );
            })}
          </div>
        </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{t('Seus ativos', 'Your holdings')}</h2>
          <div className="spacer" />
          <div className="search-inline">
            <Icon name="search" size={15} />
            <input placeholder={t('Buscar', 'Search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="chips" style={{ marginBottom: 12 }}>
          <button className={'chip-btn' + (!filter ? ' on' : '')} onClick={() => setFilter(null)}>{t('Tudo', 'All')}</button>
          {classes.map((c) => {
            const on = filter?.view === 'classe' && filter.key === c;
            return (
              <button key={c} className={'chip-btn' + (on ? ' on' : '')} onClick={() => setFilter(on ? null : { view: 'classe', key: c })}>
                {CLASS_LABEL[c]}
              </button>
            );
          })}
          {filter && filter.view !== 'classe' && (
            <button className="chip-btn on" onClick={() => setFilter(null)}>
              {filter.view === 'moeda' ? bucketLabel(filter.key) : instLabel(filter.key)} <Icon name="x" size={13} />
            </button>
          )}
        </div>

        <div className="holdings">
          <div className="h-row head">
            <span />
            <button style={{ textAlign: 'left' }} onClick={() => setSort('name')}>{t('Ativo', 'Asset')}{sort === 'name' ? ' ↓' : ''}</button>
            <button className="h-cell hide-md" onClick={() => setSort('day')}>{t('Preço · hoje', 'Price · today')}{sort === 'day' ? ' ↓' : ''}</button>
            <span className="h-cell hide-md">{t('Preço médio', 'Avg. price')}</span>
            <button className="h-cell" onClick={() => setSort('value')}>{t('Valor', 'Value')}{sort === 'value' ? ' ↓' : ''}</button>
            <button className="h-cell" onClick={() => setSort('result')}>{t('Resultado', 'Return')}{sort === 'result' ? ' ↓' : ''}</button>
          </div>
          {list.map((p, i) => {
            const m = isMarketClass(p.asset.cls);
            const r = p.value - p.cost;
            const cur = p.currency;
            const dp = dayPct(p);
            const unit = p.asset.cls === 'CRIPTO' || p.asset.cls === 'CAIXA' ? '' : p.asset.cls === 'ACAO' || p.asset.cls === 'EXTERIOR' ? t(' ações', ' shares') : t(' cotas', ' units');
            return (
              <div key={p.asset.id} className="h-row reveal" style={{ ['--i' as string]: Math.min(i, 14) }} onClick={() => openAsset(p.asset.id)}>
                <Logo symbol={p.asset.cls === 'CAIXA' ? 'US$' : p.asset.ticker} market={marketOf(p.asset.cls, cur)} cls={p.asset.cls} />
                <span className="h-name">
                  <b>
                    {p.asset.ticker}
                    {cur !== 'BRL' && <em className="cur-tag">{cur}</em>}
                  </b>
                  <span>{[m ? (p.asset.cls === 'CAIXA' ? fmtCurrency(p.quantity, cur) : `${qty(p.quantity)}${unit}`) : p.asset.name ?? CLASS_LABEL[p.asset.cls], p.asset.institution].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="h-cell hide-md">
                  {p.asset.cls === 'CAIXA' ? (
                    <>
                      <span className="price">{money(settings.fx[cur as 'USD' | 'EUR'] ?? 0, { always: true })}</span>
                      <small>{t('dólar hoje', 'dollar today')}</small>
                    </>
                  ) : m ? (
                    p.asset.currentPrice ? (
                      <>
                        <Flash value={p.asset.currentPrice} className="price">{fmtCurrency(p.asset.currentPrice, cur, { always: true })}</Flash>
                        <small className={dp > 0 ? 'pos' : dp < 0 ? 'neg' : ''}>{dp ? signedPercent(dp) : t('sem variação', 'no change')}</small>
                      </>
                    ) : (
                      <span className="muted">{t('sem cotação', 'no quote')}</span>
                    )
                  ) : (
                    <span className="muted">{p.valueIsEstimate ? t('estimado', 'estimated') : t('saldo', 'balance')}</span>
                  )}
                </span>
                <span className="h-cell hide-md">
                  {p.asset.cls === 'CAIXA' ? money(p.avgPrice, { always: true }) : m ? fmtCurrency(p.avgPriceNative, cur, { always: true }) : money(p.cost)}
                  <small>{p.asset.cls === 'CAIXA' ? t('dólar médio', 'avg. dollar') : m ? `${t('custo', 'cost')} ${money(p.cost)}` : t('aplicado', 'invested')}</small>
                </span>
                <span className="h-cell">
                  <Flash value={p.value} className="h-value">{money(p.value)}</Flash>
                  {cur !== 'BRL' ? <small>{fmtCurrency(p.valueNative, cur)}</small> : null}
                  <div className="weight"><div style={{ width: `${(p.value / total) * 100}%`, background: `var(--c-${p.asset.cls})` }} /></div>
                </span>
                <span className="h-cell">
                  <span className={'delta-pill ' + (r > 0.004 ? 'pos' : r < -0.004 ? 'neg' : '')}>{signedPercent(p.cost ? r / p.cost : 0)}</span>
                </span>
              </div>
            );
          })}
          {!list.length && <div className="empty">{t('Nenhum ativo encontrado.', 'No holdings found.')}</div>}
        </div>
      </section>
    </>
  );
}

/** One line per day: the same all day long, a new one tomorrow. */
const dayIndex = () => {
  const d = new Date();
  return d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate();
};

type Line = [pt: string, en: string];

// "{n}" is replaced by the person's first name (or dropped, with its comma, when we don't know it).
const LINES: Record<'quiet' | 'great' | 'good' | 'flat' | 'meh' | 'bad', Line[]> = {
  quiet: [
    ['Mercado fechado, {n}. Seu dinheiro também tem direito a folga.', 'Market’s closed, {n}. Your money gets a day off too.'],
    ['Nada se mexe hoje, {n}. Aproveite enquanto ninguém perde nada.', 'Nothing’s moving today, {n}. Enjoy it while nobody’s losing.'],
    ['Silêncio na bolsa, {n}. Nem o Ibovespa quer trabalhar hoje.', 'Silence on the exchange, {n}. Even the index called in sick.'],
    ['Tudo parado, {n}. Ótimo dia pra fingir que você é investidor de longo prazo.', 'All quiet, {n}. Great day to pretend you’re a long-term investor.'],
    ['Zero movimento, {n}. Seu patrimônio está meditando.', 'Zero movement, {n}. Your net worth is meditating.'],
    ['Mercado dormindo, {n}. Não acorde ele.', 'Market’s asleep, {n}. Don’t wake it up.'],
  ],
  great: [
    ['Dia histórico, {n}. Pode ligar pro gerente e falar grosso.', 'Historic day, {n}. Go ahead, call your banker and talk big.'],
    ['Olha o Warren Buffett aí, {n}. Só não conta pra Receita ainda.', 'Look at you, Warren Buffett. Just don’t tell the taxman yet, {n}.'],
    ['Hoje a bolsa trabalhou pra você, {n}. Folga merecida.', 'The market worked for you today, {n}. Take the afternoon off.'],
    ['{n}, se fosse todo dia assim, você já estaria em Mônaco.', '{n}, if every day were like this you’d be in Monaco by now.'],
    ['Que dia, {n}. Tira print antes que acabe.', 'What a day, {n}. Screenshot it before it’s gone.'],
    ['Verde que dói o olho, {n}. Bom demais pra ser verdade.', 'Green so bright it hurts, {n}. Almost too good to be true.'],
    ['{n}, hoje você é o gênio do grupo da família. Aproveite, dura pouco.', '{n}, today you’re the family genius. Enjoy it, it won’t last.'],
  ],
  good: [
    ['Dia bom, {n}. Nada de champanhe, mas um cafezinho caro tá liberado.', 'Good day, {n}. No champagne, but the fancy coffee is on you.'],
    ['Subindo devagarinho, {n}. Do jeito que os chatos recomendam.', 'Slowly climbing, {n}. Exactly how the boring people recommend.'],
    ['{n}, sua carteira acordou de bom humor. Não estraga.', '{n}, your portfolio woke up in a good mood. Don’t ruin it.'],
    ['Verdinho, {n}. Juros compostos agradecem sua paciência.', 'A little green, {n}. Compound interest thanks you for your patience.'],
    ['Dia positivo, {n}. Ainda não dá pra largar o emprego.', 'Positive day, {n}. Still not quit-your-job positive.'],
    ['{n}, hoje o mercado concordou com você. Raro, aproveite.', '{n}, the market agreed with you today. Rare. Savor it.'],
    ['Pequena vitória, {n}. As grandes são feitas delas.', 'Small win, {n}. The big ones are made of these.'],
  ],
  flat: [
    ['Dia morno, {n}. Nem pra comemorar, nem pra chorar.', 'Lukewarm day, {n}. Nothing to celebrate, nothing to cry about.'],
    ['O mercado está de lado, {n}. Você não precisa ficar olhando.', 'Market’s going sideways, {n}. You don’t have to watch it.'],
    ['Tudo estável, {n}. Quase entediante, que é exatamente o objetivo.', 'All stable, {n}. Almost boring, which is the whole point.'],
    ['{n}, hoje nada aconteceu. Seu yoga financeiro está em dia.', '{n}, nothing happened today. Your financial yoga is on point.'],
    ['Placar zerado, {n}. Empate também é resultado.', 'Scoreless draw, {n}. A tie still counts.'],
    ['Nem sobe nem desce, {n}. A bolsa está em modo elevador quebrado.', 'Not up, not down, {n}. The market’s a broken elevator today.'],
  ],
  meh: [
    ['Um vermelhinho, {n}. Nada que um café forte não resolva.', 'A bit of red, {n}. Nothing a strong coffee can’t fix.'],
    ['Pequena queda, {n}. O longo prazo nem ficou sabendo.', 'Small dip, {n}. The long run didn’t even notice.'],
    ['{n}, o mercado acordou de mau humor. Não leve pro pessoal.', '{n}, the market woke up grumpy. Don’t take it personally.'],
    ['Respira, {n}. É oscilação, não é o fim do mundo.', 'Breathe, {n}. It’s a wobble, not the apocalypse.'],
    ['Dia meio torto, {n}. Feche o app e vá viver um pouco.', 'Slightly crooked day, {n}. Close the app and go live a little.'],
    ['{n}, hoje é dia de lembrar por que você não opera day trade.', '{n}, today’s a reminder of why you don’t day-trade.'],
  ],
  bad: [
    ['Dia feio, {n}. Talvez seja melhor não abrir o app de novo hoje.', 'Ugly day, {n}. Maybe don’t open the app again today.'],
    ['Promoção na bolsa, {n}. Tudo mais barato, inclusive sua autoestima.', 'Stocks are on sale, {n}. So is your self-esteem.'],
    ['{n}, o mercado decidiu testar seus nervos. Não reprove.', '{n}, the market is testing your nerves. Don’t fail.'],
    ['Vermelho sangue, {n}. Quem vende no pânico financia quem compra.', 'Blood red, {n}. Panic sellers fund the people buying.'],
    ['Hoje doeu, {n}. Amanhã a gente finge que não viu.', 'Today hurt, {n}. Tomorrow we pretend it didn’t happen.'],
    ['{n}, respira fundo e lembre: só perde quem vende.', '{n}, deep breath: it’s only a loss if you sell.'],
    ['Dia de guerra, {n}. Capacete, café e nada de decisão burra.', 'War day, {n}. Helmet on, coffee in hand, no dumb decisions.'],
  ],
};

/** A short, one-a-day line that depends on how the portfolio is doing today. */
function greeting(name: string, dayChange: number, total: number) {
  const p = total ? dayChange / (total - dayChange || total) : 0;
  const mood = dayChange === 0 ? 'quiet' : p >= 0.015 ? 'great' : p > 0.003 ? 'good' : p >= -0.003 ? 'flat' : p > -0.015 ? 'meh' : 'bad';
  const list = LINES[mood];
  const [pt, en] = list[dayIndex() % list.length];
  const text = t(pt, en);
  if (!name) {
    // Drop the name and the punctuation around it.
    const clean = text.replace(/,?\s*\{n\}[,.]?\s*/, (m) => (m.trim().endsWith('.') ? '. ' : m.startsWith(',') ? ' ' : '')).replace(/\s+([.,])/g, '$1').trim();
    return <>{clean.charAt(0).toUpperCase() + clean.slice(1)}</>;
  }
  const [before, after] = text.split('{n}');
  return (
    <>
      {before}
      <b>{name}</b>
      {after}
    </>
  );
}

const toneOf = (v: number) => (v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : '');
const signedMoney = (v: number) => (v >= 0 ? '+' : '−') + money(Math.abs(v));

/** "US$ 5,18 +0,3%": today's rate and its change since yesterday. */
function FxQuote({ sym, now, prev }: { sym: string; now: number; prev?: number }) {
  const ch = prev && prev > 0 ? now / prev - 1 : 0;
  return (
    <span className="fx-q" title={t('Cotação de hoje em reais', "Today's rate in reais")}>
      <span className="muted">{sym}</span> <Flash value={now}>{numFx(now)}</Flash>
      {ch !== 0 && <small className={ch > 0 ? 'pos' : 'neg'}>{signedPercent(ch)}</small>}
    </span>
  );
}
const numFx = (v: number) => money(v, { always: true }).replace(/R\$\s?/, '');

const pct = (p: Position) => (p.cost ? (p.value - p.cost) / p.cost : 0);


function splitMoney(v: number): [string, string] {
  const s = money(v);
  const i = s.lastIndexOf(getDecimal());
  return i > 0 && !s.includes('•') ? [s.slice(0, i), s.slice(i)] : [s, ''];
}

const getDecimal = () => (t(',', '.'));

/** DARF due date: last business day of the following month (ignores holidays). */
export function darfDue(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m + 1, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return toISODate(d);
}
