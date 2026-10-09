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

/**
 * "E se…?": a small button in the bottom-left corner that opens a compact card —
 * pick any stock/coin, a period and an amount; see what it'd be worth today.
 */

const QUICK = ['AAPL', 'NVDA', 'PETR4', 'BTC', 'TSLA', 'VALE3'];
type Period = '1D' | '1W' | '1M' | '6M' | '1Y' | '5Y' | '10Y' | 'DATE';
const PERIODS: Exclude<Period, 'DATE'>[] = ['1D', '1W', '1M', '6M', '1Y', '5Y', '10Y'];
const periodLabel = (p: Period) =>
  ({ '1D': '1D', '1W': t('1S', '1W'), '1M': '1M', '6M': '6M', '1Y': t('1A', '1Y'), '5Y': t('5A', '5Y'), '10Y': t('10A', '10Y'), DATE: '' })[p];
const DAY = 86400000;
function startOf(p: Period, date: string) {
  if (p === 'DATE') return Date.parse(date + 'T12:00:00');
  const d = new Date();
  if (p === '1D') return d.getTime() - DAY;
  if (p === '1W') return d.getTime() - 7 * DAY;
  if (p === '1M') d.setMonth(d.getMonth() - 1);
  else if (p === '6M') d.setMonth(d.getMonth() - 6);
  else d.setFullYear(d.getFullYear() - (p === '1Y' ? 1 : p === '5Y' ? 5 : 10));
  return Date.parse(toISODate(d) + 'T12:00:00');
}
/** "1.000" / "1,000.50" / "1000,5" → number, by the language's separators. */
const parseAmount = (s: string) => {
  const en = locale() === 'en-US';
  const n = Number(s.replace(en ? /,/g : /\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
  return n > 0 ? n : 0;
};
const logoCls = (h: Hit) => (h.market === 'CRYPTO' ? 'CRIPTO' : h.market === 'B3' ? 'ACAO' : 'EXTERIOR');

export function WhatIf() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = () => {
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 160);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    // Capture phase: picking a search result removes it from the page, so checking after React
    // handled the click would wrongly look like a click outside.
    const onDown = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && close();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  return (
    <div className="whatif" ref={box}>
      {open && <WhatIfCard closing={closing} />}
      <button className={'whatif-fab' + (open ? ' on' : '')} onClick={() => (open ? close() : setOpen(true))} aria-label={t('E se…?', 'What if…?')}>
        <Icon name={open ? 'x' : 'chart'} size={17} />
        <span>{t('E se…?', 'What if…?')}</span>
      </button>
    </div>
  );
}

function WhatIfCard({ closing }: { closing: boolean }) {
  const data = useData();
  const [hit, setHit] = useState<Hit | null>(null);
  const [period, setPeriod] = useState<Period>('1Y');
  const [date, setDate] = useState(() => toISODate(new Date(Date.now() - 365 * DAY)));
  const [amountText, setAmountText] = useState(() => (1000).toLocaleString(locale()));
  const amount = parseAmount(amountText);
  const [inBRL, setInBRL] = useState(true);
  const [series, setSeries] = useState<Series | null>(null);
  const [fx, setFx] = useState<{ t: number; close: number }[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'empty'>('idle');
  const hoverIdx = useRef<number | null>(null);
  const start = useMemo(() => startOf(period, date), [period, date]);

  useEffect(() => {
    if (!hit) return;
    let alive = true;
    setStatus('loading');
    (async () => {
      const s = await loadSeries(hit, start, data.settings).catch(() => null);
      if (!alive) return;
      if (!s?.bars.length) return setStatus('empty');
      const f = s.currency === 'BRL' ? [] : await fxToBRL(s.currency, start).catch(() => []);
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
  }, [hit, start]);

  const native = series?.currency ?? 'BRL';
  const cur = inBRL || native === 'BRL' || !fx.length ? 'BRL' : native;
  const fmt = (v: number) => fmtCurrency(v, cur, { always: true });
  const intraday = period === '1D' || period === '1W';

  const result = useMemo(() => {
    if (!series || status !== 'done' || amount <= 0) return null;
    // Dividends reinvested when the source has adjusted prices (total return).
    const src = series.adj ?? series.bars;
    const rate = (tm: number) => (cur === 'BRL' && native !== 'BRL' ? at(fx, tm) ?? 0 : 1);
    let i0 = src.findIndex((b) => b.t >= start - (intraday ? 0 : DAY / 2));
    if (i0 < 0) i0 = Math.max(0, src.length - 2);
    const p0 = src[i0].close * rate(src[i0].t);
    if (!(p0 > 0)) return null;
    const units = amount / p0;
    const points = src.slice(i0).map((b) => ({ t: b.t, v: units * b.close * rate(b.t), b: amount }));
    const now = points[points.length - 1].v;
    const days = (points[points.length - 1].t - points[0].t) / DAY;
    return {
      i0,
      bought: src[i0].t,
      priceThen: series.bars[i0]?.close ?? 0,
      priceNow: series.bars[series.bars.length - 1].close,
      points,
      now,
      gain: now - amount,
      pct: now / amount - 1,
      yearly: days > 420 ? Math.pow(now / amount, 365 / days) - 1 : null,
    };
  }, [series, status, amount, start, cur, native, fx, intraday]);

  const tone = !result ? 'flat' : result.gain > 0.005 ? 'pos' : result.gain < -0.005 ? 'neg' : 'flat';
  const compact = useMemo(() => new Intl.NumberFormat(locale(), { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 }), [cur]);
  const pctStr = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toLocaleString(locale(), { maximumFractionDigits: Math.abs(v) > 9.99 ? 0 : 1 }) + '%';
  const sym = cur === 'BRL' ? 'R$' : cur === 'USD' ? 'US$' : cur === 'EUR' ? '€' : cur;

  return (
    <div className={'whatif-card' + (closing ? ' out' : '')} role="dialog" aria-label={t('E se…?', 'What if…?')}>
      <div className="wi-title">{t('E se…?', 'What if…?')}</div>
      <StockSearch hit={hit} onPick={setHit} />
      {!hit && (
        <div className="wi-quick">
          {QUICK.map((s) => (
            <button key={s} onClick={() => setHit(quickHit(s))}>{s}</button>
          ))}
        </div>
      )}

      <div className="wi-row">
        <label className="wi-amount">
          <i>{sym}</i>
          <input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} onBlur={() => amount > 0 && setAmountText(amount.toLocaleString(locale(), { maximumFractionDigits: 2 }))} aria-label={t('Quanto', 'Amount')} />
        </label>
        {native !== 'BRL' && fx.length > 0 && (
          <div className="wi-cur">
            <button className={cur === 'BRL' ? 'on' : ''} onClick={() => setInBRL(true)}>R$</button>
            <button className={cur !== 'BRL' ? 'on' : ''} onClick={() => setInBRL(false)}>{native}</button>
          </div>
        )}
      </div>

      <div className="wi-periods">
        {PERIODS.map((p) => (
          <button key={p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>{periodLabel(p)}</button>
        ))}
        <label className={'wi-date' + (period === 'DATE' ? ' on' : '')} title={t('Escolher data', 'Pick a date')}>
          {period === 'DATE' ? fmtDate(date) : <CalendarGlyph />}
          <input type="date" value={date} min="1990-01-01" max={toISODate(new Date(Date.now() - DAY))} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setPeriod('DATE'); } }} />
        </label>
      </div>

      {hit && status === 'loading' && !result && <div className="wi-wait"><span className="spinner sm" /> {t('Buscando o histórico…', 'Fetching history…')}</div>}
      {hit && status === 'empty' && <div className="wi-wait">{t('Sem histórico para esse período. Tente outro.', 'No history for that period. Try another.')}</div>}

      {hit && result && (
        <div className={'wi-result' + (status === 'loading' ? ' dim' : '')}>
          <div className="wi-lead">
            {fmtDate(toISODate(new Date(result.bought)))} → {t('hoje', 'today')}
          </div>
          <div className="wi-big-row">
            <div className={'wi-big ' + tone}><CountUp value={result.now} format={fmt} /></div>
            <div className={'wi-pct ' + tone}>{pctStr(result.pct)}</div>
          </div>
          <div className="wi-sub">
            <span className={tone}>{result.gain >= 0 ? '+' : '−'}{fmt(Math.abs(result.gain))}</span>
            {result.yearly !== null && <span> · {pctStr(result.yearly)} {t('ao ano', 'a year')}</span>}
          </div>
          <div
            className={'wi-chart' + (intraday ? '' : ' pickable')}
            onClick={() => {
              // Click a day on the chart to start the simulation there.
              const i = hoverIdx.current;
              if (intraday || i === null || i <= 0) return;
              setDate(toISODate(new Date(result.points[i].t)));
              setPeriod('DATE');
            }}
          >
          <LineChart
            points={result.points}
            onHover={(i) => { if (i !== null) hoverIdx.current = i; }}
            tone={tone}
            height={96}
            axis={false}
            mode={period === '1D' ? 'intraday' : period === '1W' ? 'hourly' : 'daily'}
            format={(v) => compact.format(v)}
            animKey={hit.symbol + start + cur}
            tip={(p, i) => (
              <>
                <b>{fmt(p.v)}</b>
                {series?.bars[result.i0 + i] && <div className="ltip-sub">{hit.ticker} {fmtCurrency(series.bars[result.i0 + i].close, native, { always: true })}</div>}
                <div className="ltip-sub"><span className={p.v >= amount ? 'pos' : 'neg'}>{pctStr(p.v / amount - 1)}</span></div>
                {!intraday && <div className="ltip-sub">{t('Clique para começar aqui', 'Click to start here')}</div>}
              </>
            )}
          />
          </div>
          <div className="wi-foot">
            <span>{fmtCurrency(result.priceThen, native, { always: true })} → {fmtCurrency(result.priceNow, native, { always: true })}</span>
            <span>{series?.adj ? t('c/ dividendos', 'incl. dividends') : hit.exch}</span>
          </div>
        </div>
      )}
    </div>
  );
}

const CalendarGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="16" rx="3" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);

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
    <div className="wi-search">
      {hit && !q ? <Logo symbol={hit.ticker} market={hit.market} cls={logoCls(hit)} size={22} /> : <Icon name="search" size={15} />}
      <input
        ref={input}
        autoFocus={!hit}
        className={hit && !q ? 'picked' : ''}
        value={q}
        placeholder={hit ? `${hit.ticker} · ${hit.name}` : t('Qualquer ação do mundo…', 'Any stock in the world…')}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter' && list[active]) { e.preventDefault(); choose(list[active]); }
          if (e.key === 'Escape' && open && list.length) { e.stopPropagation(); setOpen(false); }
        }}
      />
      {busy && <span className="spinner sm" />}
      {open && list.length > 0 && (
        <div className="wi-list">
          {list.map((h, i) => (
            <div key={h.symbol + i} className={'wi-item' + (i === active ? ' on' : '')} onMouseDown={() => choose(h)} onMouseEnter={() => setActive(i)}>
              <Logo symbol={h.ticker} market={h.market} cls={logoCls(h)} size={24} />
              <span className="wi-item-text"><b>{h.ticker}</b><span>{h.name}</span></span>
              <small>{h.exch}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
