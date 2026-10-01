import { useMemo } from 'react';
import type { Asset, Settings, Transaction } from '../lib/types';
import type { Position } from '../lib/portfolio';
import { usePortfolioHistory, type Range } from '../lib/history';
import { LineChart } from './charts';
import { money, moneyCompact, signedPercent } from '../lib/format';
import { t } from '../lib/i18n';

export const PORTFOLIO_RANGES: Range[] = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', 'ALL'];
export const rangeShort = (r: Range) =>
  ({ '1D': '1D', '1W': t('1S', '1W'), '1M': '1M', '3M': '3M', '6M': '6M', YTD: t('Ano', 'YTD'), '1Y': t('1A', '1Y'), '5Y': t('5A', '5Y'), ALL: t('Tudo', 'All') })[r];
export const rangeLong = (r: Range) =>
  ({
    '1D': t('Hoje', 'Today'),
    '1W': t('Na semana', 'This week'),
    '1M': t('No mês', 'Past month'),
    '3M': t('Em 3 meses', 'Past 3 months'),
    '6M': t('Em 6 meses', 'Past 6 months'),
    YTD: t('No ano', 'Year to date'),
    '1Y': t('Em 12 meses', 'Past 12 months'),
    '5Y': t('Em 5 anos', 'Past 5 years'),
    ALL: t('Desde o início', 'All time'),
  })[r];

const tone = (v: number) => (v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : 'flat');
const signed = (v: number) => (v >= 0 ? '+' : '−') + money(Math.abs(v));

export function PortfolioChart({
  range,
  onRange,
  assets,
  txs,
  settings,
  positions,
  total,
  cost,
  dayChange,
  openAsset,
}: {
  range: Range;
  onRange: (r: Range) => void;
  assets: Asset[];
  txs: Transaction[];
  settings: Settings;
  positions: Position[];
  total: number;
  cost: number;
  dayChange: number;
  openAsset: (id: string) => void;
}) {
  const now = useMemo(() => ({ value: total, invested: cost }), [total, cost]);
  const { points, loading, missing } = usePortfolioHistory(range, assets, txs, settings, now);

  let gain = 0;
  let pct = 0;
  if (range === '1D') {
    gain = dayChange;
    pct = total - dayChange ? dayChange / (total - dayChange) : 0;
  } else if (range === 'ALL') {
    // Same numbers as "Desde o início" in the header.
    gain = total - cost;
    pct = cost ? gain / cost : 0;
  } else if (points.length > 1) {
    const a = points[0];
    const b = points[points.length - 1];
    const flow = b.invested - a.invested;
    gain = b.value - a.value - flow;
    const basis = a.value + Math.max(0, flow);
    pct = basis > 0 ? gain / basis : 0;
  }
  const tn = tone(gain);

  return (
    <div className="pchart">
      <div className="pchart-head">
        <div>
          <div className="eyebrow">{rangeLong(range)}</div>
          <div className={'pchart-gain ' + tn}>
            {signed(gain)} <span>{signedPercent(pct)}</span>
          </div>
        </div>
        <div className="spacer" />
        {loading && range !== '1D' && <span className="spinner sm" title={t('Carregando histórico…', 'Loading history…')} />}
      </div>

      {range === '1D' ? (
        <Movers positions={positions} openAsset={openAsset} />
      ) : (
        <LineChart
          points={points.map((p) => ({ t: p.t, v: p.value, b: p.invested }))}
          tone={tn}
          height={190}
          format={(v) => moneyCompact(v)}
          animKey={range}
          tip={(p) => (
            <>
              <b>{money(p.v)}</b>
              <div className="ltip-sub">
                {t('aplicado', 'invested')} {money(p.b ?? 0)} · <span className={tone(p.v - (p.b ?? 0))}>{signed(p.v - (p.b ?? 0))}</span>
              </div>
            </>
          )}
        />
      )}

      <div className="pchart-foot">
        <div className="range-pills" role="tablist">
          {PORTFOLIO_RANGES.map((r) => (
            <button key={r} className={r === range ? 'on' : ''} onClick={() => onRange(r)}>{rangeShort(r)}</button>
          ))}
        </div>
        {range !== '1D' && (
          <span className="legend">
            <i className="lg-line" /> {t('patrimônio', 'net worth')} <i className="lg-dash" /> {t('aplicado', 'invested')}
          </span>
        )}
      </div>
      {range !== '1D' && !loading && missing.length > 0 && (
        <div className="pchart-note">
          {t('Sem histórico de preço para', 'No price history for')} {missing.slice(0, 4).join(', ')}{missing.length > 4 ? '…' : ''} — {t('usando a cotação atual', 'using the current price')}.
        </div>
      )}
    </div>
  );
}

/** Today: which holdings moved the portfolio, as diverging bars. */
function Movers({ positions, openAsset }: { positions: Position[]; openAsset: (id: string) => void }) {
  const list = positions
    .filter((p) => Math.abs(p.dayChange) > 0.005)
    .sort((a, b) => Math.abs(b.dayChange) - Math.abs(a.dayChange))
    .slice(0, 6);
  const max = Math.max(1, ...list.map((p) => Math.abs(p.dayChange)));
  if (!list.length)
    return <div className="movers-empty muted small">{t('Nenhuma variação hoje ainda — mercado fechado ou cotações desligadas.', 'No moves yet today — market closed or live quotes off.')}</div>;
  return (
    <div className="movers">
      {list.map((p, i) => {
        const w = (Math.abs(p.dayChange) / max) * 50;
        const up = p.dayChange >= 0;
        const base = p.value - p.dayChange;
        return (
          <button key={p.asset.id} className="mover" style={{ ['--i' as string]: i }} onClick={() => openAsset(p.asset.id)}>
            <span className="mv-name">{p.asset.ticker}</span>
            <span className="mv-track">
              <span className={'mv-bar ' + (up ? 'pos' : 'neg')} style={up ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
            </span>
            <span className={'mv-val ' + (up ? 'pos' : 'neg')}>
              {signed(p.dayChange)}
              <small>{signedPercent(base ? p.dayChange / base : 0)}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}
