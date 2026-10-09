// Walleti — "quotes" Edge Function: lets signed-in users use the site owner's market-data keys.
// The app sends the provider URL with "__shared__" where the key goes; this function swaps in the
// real key (kept here as a secret, never sent to the browser), fetches, and returns the answer.
// Secrets: FINNHUB_KEY, BRAPI_TOKEN, TWELVEDATA_KEY (any of them can be missing).
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!(await signedIn(req))) return json({ error: 'not-signed-in' }, 401);
    const body = await req.json();
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
