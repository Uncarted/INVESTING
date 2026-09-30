import { t } from './i18n';

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
  if (!key) return { ok: false, detail: t('Cole a chave primeiro.', 'Paste the key first.') };
  try {
    if (kind === 'finnhub') {
      const r = await get(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(key)}`);
      if (r.status === 401 || r.status === 403) return { ok: false, detail: t('Chave recusada pela Finnhub — confira se copiou inteira.', 'Finnhub rejected the key — check you copied all of it.') };
      const c = Number(r.body?.c);
      return c > 0 ? { ok: true, detail: `${t('Funcionando', 'Working')} · AAPL US$ ${c.toFixed(2)}` } : { ok: false, detail: t('A Finnhub não respondeu com preço. Tente de novo.', "Finnhub didn't return a price. Try again.") };
    }
    if (kind === 'brapi') {
      const r = await get(`https://brapi.dev/api/quote/PETR4?token=${encodeURIComponent(key)}`);
      if (r.status === 401 || r.status === 403) return { ok: false, detail: t('Token recusado pela brapi — confira se copiou inteiro.', 'brapi rejected the token — check you copied all of it.') };
      const results = r.body?.results as { regularMarketPrice?: number }[] | undefined;
      const p = Number(results?.[0]?.regularMarketPrice);
      return p > 0 ? { ok: true, detail: `${t('Funcionando', 'Working')} · PETR4 R$ ${p.toFixed(2)}` } : { ok: false, detail: t('A brapi não respondeu com preço. Tente de novo.', "brapi didn't return a price. Try again.") };
    }
    const r = await get(`https://api.twelvedata.com/price?symbol=AAPL&apikey=${encodeURIComponent(key)}`);
    const p = Number(r.body?.price);
    if (p > 0) return { ok: true, detail: `${t('Funcionando', 'Working')} · AAPL US$ ${p.toFixed(2)}` };
    return { ok: false, detail: String(r.body?.message ?? t('Chave recusada pela Twelve Data.', 'Twelve Data rejected the key.')) };
  } catch {
    return { ok: false, detail: t('Sem conexão com o serviço agora. A chave foi salva; tente testar de novo depois.', "Can't reach the service right now. The key was saved; it'll be checked again later.") };
  }
}
