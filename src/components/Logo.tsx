import { useState } from 'react';
import type { AssetClass } from '../lib/types';

export type LogoMarket = 'US' | 'B3' | 'CRYPTO' | 'OTHER';

const failed = new Set<string>();

function logoUrl(symbol: string, market: LogoMarket) {
  const s = symbol.toUpperCase();
  if (market === 'US') return `https://financialmodelingprep.com/image-stock/${encodeURIComponent(s)}.png`;
  if (market === 'B3') return `https://icons.brapi.dev/icons/${encodeURIComponent(s)}.svg`;
  if (market === 'CRYPTO') return `https://assets.coincap.io/assets/icons/${encodeURIComponent(s.toLowerCase())}@2x.png`;
  return null;
}

export function initials(ticker: string, market: boolean) {
  if (market) return ticker.replace(/\d+$/, '').slice(0, 4);
  const words = ticker.split(/\s+/).filter((w) => /[A-Za-zÀ-ú]/.test(w));
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

/** Company/coin logo with a colored-initials fallback (offline, unknown or failed). */
export function Logo({ symbol, market, cls, size = 40 }: { symbol: string; market: LogoMarket; cls: AssetClass; size?: number }) {
  const url = logoUrl(symbol, market);
  const [broken, setBroken] = useState(!url || failed.has(url));
  const style = {
    width: size,
    height: size,
    borderRadius: size * 0.3,
    fontSize: size * 0.27,
    background: `color-mix(in srgb, var(--c-${cls}) 18%, transparent)`,
    color: `var(--c-${cls})`,
  };
  if (broken || !url) {
    return <span className="avatar" style={style}>{initials(symbol, market !== 'OTHER')}</span>;
  }
  return (
    <span className="avatar logo" style={{ ...style, background: '#fff' }}>
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={() => {
          failed.add(url);
          setBroken(true);
        }}
      />
    </span>
  );
}

export function marketOf(cls: AssetClass, currency: string): LogoMarket {
  if (cls === 'CRIPTO') return 'CRYPTO';
  if (currency !== 'BRL' || cls === 'EXTERIOR') return 'US';
  if (cls === 'ACAO' || cls === 'FII' || cls === 'ETF' || cls === 'BDR') return 'B3';
  return 'OTHER';
}
