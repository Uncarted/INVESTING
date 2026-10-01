// Wallet — "read-document" Edge Function.
// Reads the text of a brokerage/bank statement with Google Gemini and returns the trades,
// dividends and balances it finds as JSON. The Gemini key lives only here, as the secret
// GEMINI_API_KEY; the website never sees it. Only signed-in users can call it, and each
// account has a daily limit (DAILY_LIMIT) so nobody can drain the free quota.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via editor → name "read-document"
// → paste this file → Deploy. Then add the secret GEMINI_API_KEY (Edge Functions → Secrets).

import { createClient } from 'npm:@supabase/supabase-js@2';

const DAILY_LIMIT = 20;
const MODELS = [Deno.env.get('GEMINI_MODEL'), 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean) as string[];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const PROMPT = `You read Brazilian and US brokerage and bank documents (trade confirmations, notas de corretagem,
monthly statements, custody statements, bank statements) and extract investment data.
Return every item you find:
- kind "trade": a buy or sell of a stock, REIT (FII), ETF, BDR, crypto, or a deposit/withdrawal (aplicação/resgate) in a fixed-income product.
- kind "dividend": dividends, JCP, FII income, interest paid in cash. Use the net amount received.
- kind "position": a holding on the statement date (quantity and price for stocks; balance for fixed income and funds).
- kind "cash": cash balance sitting in an account.
Rules: dates as YYYY-MM-DD. Numbers as plain numbers (no thousands separators; Brazilian "1.234,56" is 1234.56).
Tickers exactly as listed (PETR4, HGLG11, TTWO). Do not invent data: skip anything not clearly in the document.
For fixed income, put the rate text in "rate" (e.g. "130% CDI", "IPCA + 6%", "12% a.a.") and the product name in "name".`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    institution: { type: 'STRING', description: 'Broker or bank that issued the document', nullable: true },
    statementDate: { type: 'STRING', description: 'Reference date of the document, YYYY-MM-DD', nullable: true },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['trade', 'dividend', 'position', 'cash'] },
          date: { type: 'STRING', nullable: true },
          side: { type: 'STRING', enum: ['BUY', 'SELL'], nullable: true },
          ticker: { type: 'STRING', nullable: true },
          name: { type: 'STRING', nullable: true },
          assetType: { type: 'STRING', enum: ['stock_br', 'fii', 'etf', 'bdr', 'stock_us', 'crypto', 'fixed_income', 'fund', 'cash', 'other'] },
          quantity: { type: 'NUMBER', nullable: true },
          price: { type: 'NUMBER', nullable: true },
          amount: { type: 'NUMBER', nullable: true },
          fees: { type: 'NUMBER', nullable: true },
          currency: { type: 'STRING', enum: ['BRL', 'USD', 'EUR'] },
          rate: { type: 'STRING', nullable: true },
          maturity: { type: 'STRING', nullable: true },
          dividendType: { type: 'STRING', enum: ['DIVIDEND', 'JCP', 'INCOME'], nullable: true },
        },
        required: ['kind', 'assetType', 'currency'],
      },
    },
  },
  required: ['items'],
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) return json({ error: 'missing-key' }, 500);

    // Who is calling (the gateway already checked the token).
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: who } = await admin.auth.getUser(token);
    const uid = who?.user?.id;
    if (!uid) return json({ error: 'not-signed-in' }, 401);

    // Daily limit per account.
    const day = new Date().toISOString().slice(0, 10);
    const { data: usage } = await admin.from('ai_usage').select('count').eq('user_id', uid).eq('day', day).maybeSingle();
    const used = usage?.count ?? 0;
    if (used >= DAILY_LIMIT) return json({ error: 'daily-limit', limit: DAILY_LIMIT }, 429);

    const { text } = await req.json();
    if (typeof text !== 'string' || text.trim().length < 20) return json({ error: 'empty' }, 400);
    const body = {
      contents: [{ role: 'user', parts: [{ text: `${PROMPT}\n\nDOCUMENT:\n${text.slice(0, 120000)}` }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 },
    };

    let lastError = '';
    for (const model of MODELS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        lastError = `${model}: ${r.status} ${(await r.text()).slice(0, 300)}`;
        if (r.status === 429) return json({ error: 'gemini-quota', detail: lastError }, 429);
        continue; // try the next model name
      }
      const out = await r.json();
      const raw = out?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
      const parsed = JSON.parse(raw);
      await admin.from('ai_usage').upsert({ user_id: uid, day, count: used + 1 });
      return json({ ...parsed, model, used: used + 1, limit: DAILY_LIMIT });
    }
    return json({ error: 'gemini-failed', detail: lastError }, 502);
  } catch (e) {
    return json({ error: 'failed', detail: String(e) }, 500);
  }
});
