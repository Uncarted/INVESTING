/** Quick checks that an API key works, so the user gets immediate feedback. */
export type KeyCheck = { ok: true; detail: string } | { ok: false; detail: string };

async function get(url: string) {
  const res = await fetch(url);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: body as Record<string, unknown> | null };
}

/** People often paste keys with spaces, quotes or "token=" in front. */
export const cleanKey = (k: string) => k.trim().replace(/^["']|["']$/g, '').replace(/^(token|apikey|key)=/i, '').trim();

export async function checkKey(kind: 'finnhub' | 'brapi' | 'twelve', rawKey: string): Promise<KeyCheck> {
  const key = cleanKey(rawKey);
  if (!key) return { ok: false, detail: 'Cole a chave primeiro.' };
  try {
    if (kind === 'finnhub') {
      const r = await get(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(key)}`);
      if (r.status === 401 || r.status === 403) return { ok: false, detail: 'Chave recusada pela Finnhub — confira se copiou inteira.' };
      const c = Number(r.body?.c);
      return c > 0 ? { ok: true, detail: `Funcionando · AAPL US$ ${c.toFixed(2)}` } : { ok: false, detail: 'A Finnhub não respondeu com preço. Tente de novo.' };
    }
    if (kind === 'brapi') {
      const r = await get(`https://brapi.dev/api/quote/PETR4?token=${encodeURIComponent(key)}`);
      if (r.status === 401 || r.status === 403) return { ok: false, detail: 'Token recusado pela brapi — confira se copiou inteiro.' };
      const results = r.body?.results as { regularMarketPrice?: number }[] | undefined;
      const p = Number(results?.[0]?.regularMarketPrice);
      return p > 0 ? { ok: true, detail: `Funcionando · PETR4 R$ ${p.toFixed(2)}` } : { ok: false, detail: 'A brapi não respondeu com preço. Tente de novo.' };
    }
    const r = await get(`https://api.twelvedata.com/price?symbol=AAPL&apikey=${encodeURIComponent(key)}`);
    const p = Number(r.body?.price);
    if (p > 0) return { ok: true, detail: `Funcionando · AAPL US$ ${p.toFixed(2)}` };
    return { ok: false, detail: String(r.body?.message ?? 'Chave recusada pela Twelve Data.') };
  } catch {
    return { ok: false, detail: 'Sem conexão com o serviço agora. A chave foi salva; tente testar de novo depois.' };
  }
}
