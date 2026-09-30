import { useMemo, useState } from 'react';
import { actions, useData } from '../lib/store';
import { allSales, computePositions, investedSeries, type Position } from '../lib/portfolio';
import { computeTaxYear } from '../lib/tax';
import { CLASS_LABEL, CLASS_ORDER, CURRENCY_LABEL, INCOME_TYPES, isMarketClass, type AssetClass } from '../lib/types';
import { MONTHS, fmtCurrency, fmtDate, money, percent, qty, signedPercent, today, toISODate } from '../lib/format';
import { useLive, withLive } from '../lib/live';
import { AreaChart } from '../components/charts';
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

  const assets = useMemo(() => withLive(data.assets, live), [data.assets, live]);
  const settings = useMemo(() => (live.fx ? { ...data.settings, fx: { ...data.settings.fx, ...live.fx } } : data.settings), [data.settings, live.fx]);
  const positions = useMemo(
    () => computePositions(assets, data.transactions, settings, tdy).filter((p) => !p.closed && (p.cost > 0.005 || p.value > 0.005)),
    [assets, data.transactions, settings, tdy],
  );
  const series = useMemo(
    () => investedSeries(data.assets, data.transactions, data.settings, tdy).map((d) => ({ month: d.month, value: d.cost })),
    [data.assets, data.transactions, data.settings, tdy],
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

  const foreign = positions.filter((p) => p.currency !== 'BRL');
  const usdValue = foreign.filter((p) => p.currency === 'USD').reduce((s, p) => s + p.valueNative, 0);
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
          <div className="badges">
            <span className={'badge ' + (result >= 0 ? 'pos' : 'neg')}>
              <Icon name={result >= 0 ? 'up' : 'down'} size={14} />
              <CountUp value={Math.abs(result)} format={(v) => money(v)} duration={1400} /> · {signedPercent(cost ? result / cost : 0)}
            </span>
            {dayChange !== 0 && (
              <span className={'badge ' + (dayChange >= 0 ? 'pos' : 'neg')} title={t('Variação desde o fechamento anterior', 'Change since the previous close')}>
                {t('Hoje', 'Today')} <Flash value={dayChange}>{dayChange >= 0 ? '+' : '−'}{money(Math.abs(dayChange))}</Flash>
              </span>
            )}
            {usdValue > 0 && (
              <button className="badge badge-btn" onClick={() => setView('moeda')} title={t('Ver por moeda', 'View by currency')}>
                <span className="dot" style={{ background: 'var(--c-ACAO)' }} /> {fmtCurrency(usdValue, 'USD')} {t('em dólar', 'in dollars')}
              </button>
            )}
            <span className="badge" title={t('Cotação do dólar', 'Dollar exchange rate')}>US$ 1 = <Flash value={settings.fx.USD}>{money(settings.fx.USD, { always: true })}</Flash></span>
          </div>
          {needsKey && (
            <button className="connect-hint" onClick={() => open('config')}>
              <Icon name="refresh" size={14} /> {t('Conecte as cotações ao vivo (grátis) →', 'Connect live quotes (free) →')}
            </button>
          )}
        </div>
        <div className="hero-chart reveal" style={{ ['--i' as string]: 2 }}>
          <div className="row" style={{ padding: '0 6px 6px' }}>
            <span className="eyebrow">{t('Valor aplicado', 'Amount invested')}</span>
            <div className="spacer" />
            <span className="muted small">{t('desde', 'since')} {fmtMonthLong(series[0]?.month)}</span>
          </div>
          <AreaChart data={series} height={170} compact />
        </div>
      </section>

      <div className="tiles">
        <button className="tile reveal" style={{ ['--i' as string]: 3 }} onClick={() => open('proventos')}>
          <span className="t-label"><Icon name="coins" size={14} /> {t('Proventos · 12 meses', 'Dividends · 12 months')}</span>
          <span className="t-value"><CountUp value={income12m} format={(v) => money(v)} /></span>
          <span className="t-sub">≈ {money(income12m / 12)} {t('por mês', 'per month')} · {percent(total ? income12m / total : 0)} {t('a.a.', 'p.a.')}</span>
        </button>
        <button className={'tile reveal' + (nextDarf ? ' alert' : '')} style={{ ['--i' as string]: 4 }} onClick={() => open('ir')}>
          <span className="t-label"><Icon name="receipt" size={14} /> {t('Imposto de renda', 'Income tax')}</span>
          <span className="t-value">{nextDarf ? money(nextDarf.darf, { always: true }) : t('Nada a pagar', 'Nothing to pay')}</span>
          <span className="t-sub">{nextDarf ? `DARF 6015 ${t('vence', 'due')} ${fmtDate(nextDarf.due)}` : t(`Relatório do IR ${year - 1} pronto →`, `${year - 1} tax report ready →`)}</span>
        </button>
        <button className="tile reveal" style={{ ['--i' as string]: 5 }} onClick={() => open('lancamentos')}>
          <span className="t-label"><Icon name="chart" size={14} /> {t('Lucro com vendas em', 'Profit from sales in')} {year}</span>
          <span className={'t-value ' + (realizedYear > 0 ? 'pos' : realizedYear < 0 ? 'neg' : '')}><CountUp value={realizedYear} format={(v) => money(v)} /></span>
          <span className="t-sub">{tax.totals.acoesExemptGain > 0 ? `${money(tax.totals.acoesExemptGain)} ${t('isento de IR', 'tax-exempt')}` : t('resultado realizado no ano', 'realized this year')}</span>
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
            const unit = p.asset.cls === 'CRIPTO' ? '' : p.asset.cls === 'ACAO' || p.asset.cls === 'EXTERIOR' ? t(' ações', ' shares') : t(' cotas', ' units');
            return (
              <div key={p.asset.id} className="h-row reveal" style={{ ['--i' as string]: Math.min(i, 14) }} onClick={() => openAsset(p.asset.id)}>
                <Logo symbol={p.asset.ticker} market={marketOf(p.asset.cls, cur)} cls={p.asset.cls} />
                <span className="h-name">
                  <b>
                    {p.asset.ticker}
                    {cur !== 'BRL' && <em className="cur-tag">{cur}</em>}
                  </b>
                  <span>{[m ? `${qty(p.quantity)}${unit}` : p.asset.name ?? CLASS_LABEL[p.asset.cls], p.asset.institution].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="h-cell hide-md">
                  {m ? (
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
                  {m ? fmtCurrency(p.avgPriceNative, cur, { always: true }) : money(p.cost)}
                  <small>{m ? `${t('custo', 'cost')} ${money(p.cost)}` : t('aplicado', 'invested')}</small>
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

/** A short, friendly line that depends on the time of day and how the day is going. */
function greeting(name: string, dayChange: number, total: number) {
  const h = new Date().getHours();
  const hello = h < 5 ? t('Boa noite', 'Good evening') : h < 12 ? t('Bom dia', 'Good morning') : h < 18 ? t('Boa tarde', 'Good afternoon') : t('Boa noite', 'Good evening');
  const who = name ? <b>{name}</b> : null;
  const dayPct = total ? dayChange / total : 0;
  if (dayPct > 0.004)
    return <>{hello}{who && <>, {who}</>}. {t('Dia bom na carteira hoje', 'Good day for your portfolio')} 📈</>;
  if (dayPct < -0.008)
    return <>{hello}{who && <>, {who}</>}. {t('Mercado agitado hoje — foco no longo prazo', 'Choppy market today — eyes on the long run')}.</>;
  // Stable per day, so the message doesn't change on every render.
  const lines = [
    <>{hello}{who && <>, {who}</>}.</>,
    <>{t('Que bom te ver de novo', 'Great to see you again')}{who && <>, {who}</>}.</>,
    <>{t('Olá de novo', 'Welcome back')}{who && <>, {who}</>}. {t('Tudo em ordem por aqui', 'Everything is in order')}.</>,
    <>{hello}{who && <>, {who}</>}. {t('Vamos ver como está sua carteira', "Let's see how your portfolio is doing")}.</>,
  ];
  return lines[new Date().getDate() % lines.length];
}

const pct = (p: Position) => (p.cost ? (p.value - p.cost) / p.cost : 0);


function splitMoney(v: number): [string, string] {
  const s = money(v);
  const i = s.lastIndexOf(getDecimal());
  return i > 0 && !s.includes('•') ? [s.slice(0, i), s.slice(i)] : [s, ''];
}

const getDecimal = () => (t(',', '.'));
function fmtMonthLong(ym?: string) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const name = MONTHS[Number(m) - 1];
  return `${t(name, name[0].toUpperCase() + name.slice(1))} ${y}`;
}

/** DARF due date: last business day of the following month (ignores holidays). */
export function darfDue(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m + 1, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return toISODate(d);
}
