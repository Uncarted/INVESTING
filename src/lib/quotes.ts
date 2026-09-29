import type { Asset } from './types';

/** Fetches last prices from brapi.dev (free token at brapi.dev). Returns ticker → price. */
export async function fetchQuotes(assets: Asset[], token?: string): Promise<{ prices: Map<string, number>; errors: string[] }> {
  const prices = new Map<string, number>();
  const errors: string[] = [];
  const auth = token ? `token=${encodeURIComponent(token)}` : '';
  const b3 = assets.filter((a) => ['ACAO', 'FII', 'ETF', 'BDR'].includes(a.cls));
  const crypto = assets.filter((a) => a.cls === 'CRIPTO');

  // The free plan allows one ticker per request, so fetch individually (a few in parallel).
  const queue = [...b3];
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      try {
        const res = await fetch(`https://brapi.dev/api/quote/${encodeURIComponent(a.ticker)}?${auth}`);
        if (!res.ok) throw new Error(res.status === 401 ? 'token necessário' : `HTTP ${res.status}`);
        const j = await res.json();
        const p = j?.results?.[0]?.regularMarketPrice;
        if (typeof p === 'number') prices.set(a.ticker, p);
        else errors.push(`${a.ticker}: sem cotação`);
      } catch (e) {
        errors.push(`${a.ticker}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  if (crypto.length) {
    try {
      const coins = crypto.map((a) => a.ticker).join(',');
      const res = await fetch(`https://brapi.dev/api/v2/crypto?coin=${coins}&currency=BRL&${auth}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      for (const c of j?.coins ?? []) if (typeof c.regularMarketPrice === 'number') prices.set(c.coin, c.regularMarketPrice);
    } catch (e) {
      errors.push(`Cripto: ${(e as Error).message}`);
    }
  }
  return { prices, errors };
}

/** Latest annualized CDI (SGS 4389), Selic meta (432) and IPCA 12m (13522) from Banco Central. */
export async function fetchRates(): Promise<{ cdi?: number; selic?: number; ipca?: number }> {
  const get = async (serie: number) => {
    try {
      const res = await fetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados/ultimos/1?formato=json`);
      const j = await res.json();
      const v = Number(String(j?.[0]?.valor).replace(',', '.'));
      return Number.isFinite(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const [cdi, selic, ipca] = await Promise.all([get(4389), get(432), get(13522)]);
  return { cdi, selic, ipca };
}
