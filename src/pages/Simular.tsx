import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../lib/store';
import { at } from '../lib/history';
import { fxToBRL, loadSeries, quickHit, searchAny, type Hit, type Series } from '../lib/whatif';
import { fmtCurrency, fmtDate, toISODate } from '../lib/format';
import { locale, t } from '../lib/i18n';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { LineChart } from '../components/charts';
import { CountUp } from '../components/motion';

/** "E se eu tivesse investido…": pick any stock/coin, a date and an amount; see what it'd be worth today. */

const QUICK = ['AAPL', 'NVDA', 'PETR4', 'BTC', 'MSFT', 'VALE3', 'TSLA', 'ITUB4', 'ETH', 'WEGE3'];
const AGO: { y: number; label: () => string }[] = [
  { y: 1, label: () => t('1 ano', '1 year') },
  { y: 3, label: () => t('3 anos', '3 years') },
  { y: 5, label: () => t('5 anos', '5 years') },
  { y: 10, label: () => t('10 anos', '10 years') },
];
const yearsAgo = (y: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - y);
  return toISODate(d);
};
const DAY = 86400000;
/** "1.000" / "1,000.50" / "1000,5" → number, by the language's separators. */
const parseAmount = (s: string) => {
  const en = locale() === 'en-US';
  const n = Number(s.replace(en ? /,/g : /\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
  return n > 0 ? n : 0;
};

export function Simular() {
  const data = useData();
  const [hit, setHit] = useState<Hit | null>(null);
  const [date, setDate] = useState(() => yearsAgo(5));
  const [amountText, setAmountText] = useState('1.000');
  const amount = parseAmount(amountText);
  const [inBRL, setInBRL] = useState(true);
  const [reinvest, setReinvest] = useState(true);
  const [series, setSeries] = useState<Series | null>(null);
  const [fx, setFx] = useState<{ t: number; close: number }[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'empty'>('idle');

  useEffect(() => {
    if (!hit) return;
    let alive = true;
    setStatus('loading');
    (async () => {
      const s = await loadSeries(hit, date, data.settings).catch(() => null);
      if (!alive) return;
      if (!s?.bars.length) return setStatus('empty');
      const f = s.currency === 'BRL' ? [] : await fxToBRL(s.currency, date).catch(() => []);
      if (!alive) return;
      setSeries(s);
      setFx(f);
      setStatus('done');
    })();
    return () => {
      alive = false;
    };
    // Settings only matter for the API keys; don't refetch on every price tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit, date]);

  const native = series?.currency ?? 'BRL';
  const showBRL = inBRL || native === 'BRL' || !fx.length;
  const cur = showBRL ? 'BRL' : native;
  const fmt = (v: number) => fmtCurrency(v, cur, { always: true });

  const result = useMemo(() => {
    if (!series || status !== 'done' || amount <= 0) return null;
    const start = Date.parse(date + 'T12:00:00');
    const src = reinvest && series.adj ? series.adj : series.bars;
    const conv = (b: { t: number; close: number }) => b.close * (cur === 'BRL' && native !== 'BRL' ? at(fx, b.t) ?? 0 : 1);
    let i0 = src.findIndex((b) => b.t >= start - DAY / 2);
    if (i0 < 0) i0 = src.length - 1;
    const p0 = conv(src[i0]);
    if (!(p0 > 0)) return null;
    const units = amount / p0;
    const points = src.slice(i0).map((b) => ({ t: b.t, v: units * conv(b), b: amount }));
    const now = points[points.length - 1].v;
    let best = points[0];
    let peak = points[0].v;
    let dd = 0;
    for (const p of points) {
      if (p.v > best.v) best = p;
      peak = Math.max(peak, p.v);
      dd = Math.min(dd, p.v / peak - 1);
    }
    const days = (points[points.length - 1].t - points[0].t) / DAY;
    const pct = now / amount - 1;
    const yearly = days > 360 ? Math.pow(now / amount, 365 / days) - 1 : null;
    const raw = series.bars;
    return {
      bought: src[i0].t,
      priceThen: raw[Math.min(i0, raw.length - 1)].close,
      priceNow: raw[raw.length - 1].close,
      units: amount / (raw[Math.min(i0, raw.length - 1)].close * (cur === 'BRL' && native !== 'BRL' ? at(fx, src[i0].t) ?? 1 : 1)),
      points,
      now,
      gain: now - amount,
      pct,
      yearly,
      best,
      dd,
      nativePct: raw[raw.length - 1].close / raw[Math.min(i0, raw.length - 1)].close - 1,
    };
  }, [series, status, amount, date, reinvest, cur, native, fx]);

  const tone = !result ? 'flat' : result.gain > 0.005 ? 'pos' : result.gain < -0.005 ? 'neg' : 'flat';
  const compact = useMemo(() => new Intl.NumberFormat(locale(), { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 }), [cur]);

  return (
    <div className="sim stack">
      <div className="card card-pad stack sim-inputs">
        <StockSearch hit={hit} onPick={setHit} />
        {!hit && (
          <div className="chips sim-quick">
            {QUICK.map((s) => (
              <button key={s} className="chip-btn" onClick={() => setHit(quickHit(s))}>{s}</button>
            ))}
          </div>
        )}
        <div className="sim-row">
          <label className="field">
            <span>{t('Quanto', 'Amount')}</span>
            <div className="sim-amount">
              <i>{cur === 'BRL' ? 'R$' : cur === 'USD' ? 'US$' : cur === 'EUR' ? '€' : cur}</i>
              <input className="input" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} onBlur={() => amount > 0 && setAmountText(amount.toLocaleString(locale(), { maximumFractionDigits: 2 }))} />
            </div>
          </label>
          <label className="field">
            <span>{t('Quando', 'When')}</span>
            <input className="input" type="date" value={date} max={toISODate(new Date(Date.now() - DAY))} min="1990-01-01" onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
        </div>
        <div className="sim-row wrap">
          <div className="seg">
            {AGO.map((a) => (
              <button key={a.y} className={date === yearsAgo(a.y) ? 'on' : ''} onClick={() => setDate(yearsAgo(a.y))}>{a.label()}</button>
            ))}
          </div>
          {native !== 'BRL' && fx.length > 0 && (
            <div className="seg">
              <button className={inBRL ? 'on' : ''} onClick={() => setInBRL(true)}>R$</button>
              <button className={!inBRL ? 'on' : ''} onClick={() => setInBRL(false)}>{native}</button>
            </div>
          )}
          {series?.adj && (
            <label className="sim-toggle">
              <input type="checkbox" checked={reinvest} onChange={(e) => setReinvest(e.target.checked)} />
              <span>{t('Reinvestindo dividendos', 'Dividends reinvested')}</span>
            </label>
          )}
        </div>
      </div>

      {hit && status === 'loading' && !result && (
        <div className="card card-pad sim-wait"><span className="spinner" /> {t('Buscando o histórico…', 'Fetching history…')}</div>
      )}
      {hit && status === 'empty' && (
        <div className="card card-pad muted">{t('Não achei histórico de preço para esse ativo nesse período. Tente outra data ou outro ticker.', "Couldn't find price history for that asset in this period. Try another date or ticker.")}</div>
      )}

      {hit && result && (
        <div className={'card card-pad sim-result reveal' + (status === 'loading' ? ' dim' : '')} key={hit.symbol}>
          <div className="sim-lead">
            {t('Se você tivesse investido', 'If you had invested')} <b>{fmt(amount)}</b> {t('em', 'in')} <b>{hit.ticker}</b> {t('em', 'on')} <b>{fmtDate(toISODate(new Date(result.bought)))}</b>, {t('hoje teria', "today you'd have")}
          </div>
          <div className={'sim-big ' + tone}>
            <CountUp value={result.now} format={fmt} />
          </div>
          <div className={'sim-gain ' + tone}>
            {result.gain >= 0 ? '+' : '−'}{fmt(Math.abs(result.gain))}
            <span>{(result.pct >= 0 ? '+' : '') + (result.pct * 100).toLocaleString(locale(), { maximumFractionDigits: result.pct > 9.99 ? 0 : 1 })}%</span>
            {result.yearly !== null && <em>{(result.yearly * 100).toLocaleString(locale(), { maximumFractionDigits: 1 })}% {t('ao ano', 'a year')}</em>}
          </div>

          <LineChart
            points={result.points}
            tone={tone}
            height={200}
            format={(v) => compact.format(v)}
            animKey={hit.symbol + date + cur + reinvest}
            tip={(p) => (
              <>
                <b>{fmt(p.v)}</b>
                <div className="ltip-sub"><span className={p.v >= amount ? 'pos' : 'neg'}>{(p.v / amount - 1 >= 0 ? '+' : '') + ((p.v / amount - 1) * 100).toFixed(1)}%</span></div>
              </>
            )}
          />

          <div className="sim-stats">
            <Stat label={t('Preço na época', 'Price then')} value={fmtCurrency(result.priceThen, native, { always: true })} />
            <Stat label={t('Preço hoje', 'Price now')} value={fmtCurrency(result.priceNow, native, { always: true })} sub={native !== 'BRL' ? `${result.nativePct >= 0 ? '+' : ''}${(result.nativePct * 100).toFixed(1)}% ${t('em', 'in')} ${native}` : undefined} />
            <Stat label={hit.market === 'CRYPTO' ? t('Unidades', 'Units') : t('Cotas compradas', 'Shares bought')} value={result.units.toLocaleString(locale(), { maximumFractionDigits: result.units < 10 ? 4 : 1 })} />
            <Stat label={t('Melhor momento', 'Best moment')} value={fmt(result.best.v)} sub={fmtDate(toISODate(new Date(result.best.t)))} />
            <Stat label={t('Maior queda', 'Worst drop')} value={`${(result.dd * 100).toFixed(1)}%`} tone={result.dd < -0.0005 ? 'neg' : undefined} sub={t('do topo ao fundo', 'peak to trough')} />
          </div>
          <div className="pchart-note">
            {hit.name} · {hit.exch}
            {native !== 'BRL' && cur === 'BRL' ? ` · ${t('convertido pelo câmbio de cada dia', 'converted at each day’s exchange rate')}` : ''}
            {reinvest && series?.adj ? ` · ${t('com dividendos reinvestidos', 'with dividends reinvested')}` : ''}. {t('Simulação, sem impostos e taxas.', 'Simulation, before taxes and fees.')}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="sim-stat">
      <span>{label}</span>
      <b className={tone}>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function StockSearch({ hit, onPick }: { hit: Hit | null; onPick: (h: Hit) => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q.trim().length < 1) return setList([]);
    let alive = true;
    setBusy(true);
    const id = setTimeout(async () => {
      const r = await searchAny(q).catch(() => []);
      if (!alive) return;
      setList(r);
      setActive(0);
      setBusy(false);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(id);
      setBusy(false);
    };
  }, [q]);

  const choose = (h: Hit) => {
    onPick(h);
    setQ('');
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="field combo">
      <div className="search-big">
        {hit && !q ? (
          <span className="sim-picked"><Logo symbol={hit.ticker} market={hit.market} cls={hit.market === 'CRYPTO' ? 'CRIPTO' : hit.market === 'B3' ? 'ACAO' : 'EXTERIOR'} size={28} /></span>
        ) : (
          <Icon name="search" size={18} />
        )}
        <input
          ref={input}
          className="input"
          value={q}
          placeholder={hit ? `${hit.ticker} — ${hit.name}` : t('Qualquer ação do mundo — Apple, Toyota, PETR4, Bitcoin…', 'Any stock in the world — Apple, Toyota, PETR4, Bitcoin…')}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter' && list[active]) { e.preventDefault(); choose(list[active]); }
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
          }}
        />
        {busy && <span className="spinner" />}
      </div>
      {open && list.length > 0 && (
        <div className="combo-list big">
          {list.map((h, i) => (
            <div key={h.symbol + i} className={'combo-item' + (i === active ? ' on' : '')} onMouseDown={() => choose(h)} onMouseEnter={() => setActive(i)}>
              <Logo symbol={h.ticker} market={h.market} cls={h.market === 'CRYPTO' ? 'CRIPTO' : h.market === 'B3' ? 'ACAO' : 'EXTERIOR'} size={30} />
              <span className="ci-text">
                <b>{h.ticker}</b>
                <span>{h.name}</span>
              </span>
              <span className="chip">{h.exch}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
