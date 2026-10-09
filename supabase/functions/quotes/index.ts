// Walleti — "quotes" Edge Function: lets signed-in users use the site owner's market-data keys.
// The app sends the provider URL with "__shared__" where the key goes; this function swaps in the
// real key (kept here as a secret, never sent to the browser), fetches, and returns the answer.
// Secrets: FINNHUB_KEY, BRAPI_TOKEN, TWELVEDATA_KEY (any of them can be missing).
// {mood:true} returns today's market mood (Ibovespa, S&P 500, Bitcoin, dollar) and, with the
// GEMINI_API_KEY secret, a short funny line about it — made once every few hours for everyone.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via editor → name "quotes" → paste → Deploy.

import { createClient } from 'npm:@supabase/supabase-js@2';

const KEYS: Record<string, string | undefined> = {
  'finnhub.io': Deno.env.get('FINNHUB_KEY'),
  'brapi.dev': Deno.env.get('BRAPI_TOKEN'),
  'api.twelvedata.com': Deno.env.get('TWELVEDATA_KEY'),
};
const SHARED = '__shared__';
// Keyless sources the browser can't call directly (no CORS): Yahoo Finance, for stocks worldwide.
const OPEN = new Set(['query1.finance.yahoo.com', 'query2.finance.yahoo.com']);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Small in-memory caches: answers (shared by all users, saves the free quotas) and signed-in tokens.
const cache = new Map<string, { at: number; status: number; body: string }>();
const users = new Map<string, number>();
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function signedIn(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const seen = users.get(token);
  if (seen && Date.now() - seen < 10 * 60_000) return true;
  const { data } = await admin.auth.getUser(token);
  if (!data?.user) return false;
  users.set(token, Date.now());
  return true;
}

// --- Market mood ---------------------------------------------------------------
const MARKETS: [string, string][] = [['^BVSP', 'Ibovespa'], ['^GSPC', 'S&P 500'], ['BTC-USD', 'Bitcoin'], ['BRL=X', 'Dólar (R$)']];
let moodCache: { at: number; body: unknown } | null = null;

async function marketSnapshot() {
  const out: { name: string; day: number; week: number }[] = [];
  await Promise.all(
    MARKETS.map(async ([sym, name]) => {
      try {
        const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0 (Walleti)' } });
        const j = await r.json();
        const res = j?.chart?.result?.[0];
        const closes: number[] = (res?.indicators?.quote?.[0]?.close ?? []).filter((c: number | null) => c && c > 0);
        const last = Number(res?.meta?.regularMarketPrice) || closes[closes.length - 1];
        const prev = Number(res?.meta?.chartPreviousClose) && closes.length < 2 ? Number(res.meta.chartPreviousClose) : closes[closes.length - 2];
        const weekAgo = closes[Math.max(0, closes.length - 6)];
        if (last && prev && weekAgo) out.push({ name, day: (last / prev - 1) * 100, week: (last / weekAgo - 1) * 100 });
      } catch {
        /* skip this market */
      }
    }),
  );
  return MARKETS.map(([, n]) => out.find((o) => o.name === n)).filter(Boolean) as typeof out;
}

async function moodLine(snap: { name: string; day: number; week: number }[]) {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key || !snap.length) return null;
  const facts = snap.map((m) => `${m.name}: ${m.day >= 0 ? '+' : ''}${m.day.toFixed(2)}% today, ${m.week >= 0 ? '+' : ''}${m.week.toFixed(2)}% in 5 days`).join('; ');
  const prompt = `Market today — ${facts}. (For "Dólar (R$)", up means the real got weaker.)
Write ONE short, witty, slightly edgy line (max 95 characters) for a Brazilian investing app's home screen that captures how the market is feeling right now. Dry humor, no emoji, no hashtags, no financial advice, don't list all the numbers (you may mention one market). Give it in Brazilian Portuguese (natural, informal) and in English (same joke, adapted).
Answer ONLY with JSON: {"pt": "...", "en": "...", "mood": "great|good|flat|meh|bad"}`;
  for (const model of [Deno.env.get('GEMINI_MODEL'), 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'].filter(Boolean)) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 1.1 } }),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
      const o = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
      if (o?.pt && o?.en) return { pt: String(o.pt).slice(0, 140), en: String(o.en).slice(0, 140), mood: String(o.mood ?? '') };
    } catch {
      /* next model */
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!(await signedIn(req))) return json({ error: 'not-signed-in' }, 401);
    const body = await req.json();
    if (body?.mood) {
      if (moodCache && Date.now() - moodCache.at < 3 * 3600_000) return json(moodCache.body);
      const markets = await marketSnapshot();
      const line = await moodLine(markets);
      const out = { markets, line };
      if (markets.length) moodCache = { at: Date.now(), body: out };
      return json(out);
    }
    if (body?.check) return json({ finnhub: !!KEYS['finnhub.io'], brapi: !!KEYS['brapi.dev'], twelve: !!KEYS['api.twelvedata.com'], yahoo: true });

    const url = new URL(String(body?.url ?? ''));
    const open = OPEN.has(url.hostname);
    const key = KEYS[url.hostname];
    if (url.protocol !== 'https:' || (!key && !open)) return json({ error: 'not-allowed' }, 400);
    if (open) url.searchParams.delete('_k');
    const target = open ? url.toString() : url.toString().split(SHARED).join(encodeURIComponent(key!));

    // Prices change often; history, search and dividends don't.
    const slow = /time_series|dividends|range=|candle|search|available|symbol_search|v8\/finance|v1\/finance/.test(url.search + url.pathname);
    const ttl = slow ? 6 * 3600_000 : 60_000;
    const hit = cache.get(url.toString());
    if (hit && Date.now() - hit.at < ttl) return new Response(hit.body, { status: hit.status, headers: { ...cors, 'Content-Type': 'application/json' } });

    const r = await fetch(target, open ? { headers: { 'User-Agent': 'Mozilla/5.0 (Walleti)' } } : undefined);
    const text = await r.text();
    if (r.ok) {
      cache.set(url.toString(), { at: Date.now(), status: r.status, body: text });
      if (cache.size > 2000) cache.delete(cache.keys().next().value!);
    }
    return new Response(text, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    return json({ error: 'failed', detail: String(e) }, 500);
  }
});
