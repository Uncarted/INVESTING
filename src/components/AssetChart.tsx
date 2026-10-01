import { useState } from 'react';
import type { Asset, Currency, Settings, Transaction } from '../lib/types';
import { useAssetSeries, type Range } from '../lib/history';
import { LineChart, fmtTipDate } from './charts';
import { fmtCurrency, signedPercent } from '../lib/format';
import { t } from '../lib/i18n';
import { rangeLong, rangeShort } from './PortfolioChart';

const RANGES: Range[] = ['1D', '1W', '1M', '6M', '1Y', '5Y'];

/** Interactive price chart for one asset: drag/hover to scrub, buys and sells marked on the line. */
export function AssetChart({ asset, settings, txs, avg, cur, quantity }: { asset: Asset; settings: Settings; txs: Transaction[]; avg: number; cur: Currency; quantity: number }) {
  const [range, setRange] = useState<Range>(() => {
    try {
      return (localStorage.getItem('wallet:asset-range') as Range) || '6M';
    } catch {
      return '6M';
    }
  });
  const pick = (r: Range) => {
    setRange(r);
    try {
      localStorage.setItem('wallet:asset-range', r);
    } catch {
      /* private mode */
    }
  };
  const [hover, setHover] = useState<number | null>(null);
  const { bars, loading, intraday } = useAssetSeries(asset, range, settings);
  const mode = range === '1D' ? 'intraday' : range === '1W' ? 'hourly' : 'daily';

  const pts = (bars ?? []).map((b) => ({ t: b.t, v: b.close }));
  // For "today", compare with the previous close; otherwise with the first point of the range.
  const ref = range === '1D' && asset.prevClose ? asset.prevClose : pts[0]?.v;
  const shown = hover !== null && pts[hover] ? pts[hover] : pts[pts.length - 1];
  const ch = shown && ref ? shown.v - ref : 0;
  const pct = ref ? ch / ref : 0;
  const tone = pts.length < 2 ? 'flat' : (pts[pts.length - 1].v - (ref ?? 0)) >= 0 ? 'pos' : 'neg';

  const first = pts[0]?.t ?? 0;
  const markers = !intraday
    ? txs
        .filter((x) => (x.type === 'BUY' || x.type === 'SELL') && Date.parse(x.date + 'T12:00:00') >= first)
        .map((x) => ({ t: Date.parse(x.date + 'T12:00:00'), kind: x.type === 'BUY' ? ('buy' as const) : ('sell' as const) }))
    : undefined;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const showAvg = quantity > 0 && avg > 0 && pts.length > 1 && avg > lo - (hi - lo) * 0.6 && avg < hi + (hi - lo) * 0.6;

  const noKey = cur !== 'BRL' && asset.cls !== 'CRIPTO' && !settings.twelveDataToken;

  return (
    <div className="achart">
      <div className="achart-head">
        <div className="achart-price">{shown ? fmtCurrency(shown.v, cur, { always: true }) : asset.currentPrice ? fmtCurrency(asset.currentPrice, cur, { always: true }) : '—'}</div>
        {shown && pts.length > 1 && (
          <div className={'achart-ch ' + (ch >= 0 ? 'pos' : 'neg')}>
            {ch >= 0 ? '+' : '−'}{fmtCurrency(Math.abs(ch), cur, { always: true })} · {signedPercent(pct)}
            <span className="muted"> {hover !== null ? fmtTipDate(shown.t, mode) : rangeLong(range).toLowerCase()}</span>
          </div>
        )}
      </div>
      {loading ? (
        <div className="chart-empty" style={{ height: 170 }} />
      ) : pts.length < 2 ? (
        <div className="achart-empty muted small">
          {noKey
            ? t('Para ver o gráfico de ações dos EUA, adicione a chave grátis da Twelve Data em Ajustes.', 'To see charts for US stocks, add the free Twelve Data key in Settings.')
            : range === '1D'
              ? t('Sem negociações hoje ainda.', 'No trading yet today.')
              : t('Histórico indisponível para este ativo agora.', 'History unavailable for this asset right now.')}
        </div>
      ) : (
        <LineChart
          points={pts}
          tone={tone}
          height={170}
          mode={mode}
          format={(v) => fmtCurrency(v, cur, { always: true }).replace(/^(R\$|US\$|€)\s?/, '')}
          markers={markers}
          refLine={showAvg ? { v: avg, label: `${t('preço médio', 'avg. price')} ${fmtCurrency(avg, cur, { always: true })}` } : undefined}
          hideTip
          onHover={setHover}
          animKey={range}
        />
      )}
      <div className="range-pills" style={{ marginTop: 6 }}>
        {RANGES.map((r) => (
          <button key={r} className={r === range ? 'on' : ''} onClick={() => pick(r)}>{rangeShort(r)}</button>
        ))}
      </div>
    </div>
  );
}
