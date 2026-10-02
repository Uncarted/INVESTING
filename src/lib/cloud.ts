import { useSyncExternalStore } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { LOCAL_KEY, applyRemote, getData, onEdit, peekStorage, switchStorage } from './store';
import type { Data } from './types';
import { t } from './i18n';

/**
 * Accounts + cloud database (Supabase).
 *
 * Each user has one row in `portfolios` holding their whole portfolio (assets, transactions,
 * settings and API keys) as JSON. Row Level Security makes every row readable/writable only by
 * its owner. The app keeps working offline from a per-user local cache and syncs on every edit.
 *
 * Enabled when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set at build time;
 * without them the app runs in local-only mode, exactly as before.
 */

// Accept the URL as copied from any Supabase page (with or without /rest/v1/ and trailing slash).
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
export const cloudEnabled = !!(url && anon);
export const supabase: SupabaseClient | null = cloudEnabled ? createClient(url!, anon!) : null;

const TABLE = 'portfolios';

export type SyncStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'error' | 'offline';

interface CloudState {
  ready: boolean;
  session: Session | null;
  sync: SyncStatus;
  lastSavedAt?: string;
  error?: string;
  /** Opened from a "reset password" email: ask for the new password. */
  recovery?: boolean;
  /** Problem reported by Supabase in the link we came back from (expired link, Google not enabled…). */
  authError?: string;
  /** Providers the site shares keys for ("finnhub,brapi,twelve"); empty when none. */
  sharedKeys?: string;
  /** Why shared keys aren't active (shown in Ajustes to help set them up). */
  sharedStatus?: string;
}

let state: CloudState = { ready: !cloudEnabled, session: null, sync: 'idle', ...readAuthRedirect() };

/** Supabase returns to the site with #type=recovery or #error=… in the address; read it before it's cleaned. */
function readAuthRedirect(): Partial<CloudState> {
  if (typeof location === 'undefined') return {};
  const p = new URLSearchParams(location.hash.replace(/^#/, '') + '&' + location.search.replace(/^\?/, ''));
  const out: Partial<CloudState> = {};
  if (p.get('type') === 'recovery') out.recovery = true;
  const desc = p.get('error_description') ?? p.get('error');
  if (desc) {
    const code = p.get('error_code') ?? '';
    const d = desc.replace(/\+/g, ' ');
    out.authError =
      code === 'otp_expired' || /expired|invalid/i.test(d)
        ? t('Esse link expirou ou já foi usado. Peça outro em “Esqueci a senha” e abra o email mais recente. (Se você usa Hotmail/Outlook, o próprio email às vezes “abre” o link antes de você — peça outro e clique logo.)', 'This link expired or was already used. Request another one with “Forgot password” and open the newest email. (Hotmail/Outlook sometimes opens links before you do — request a new one and click it right away.)')
        : /provider is not enabled|unsupported provider/i.test(d)
          ? t('O login com Google ainda não foi ativado no Supabase.', "Google sign-in isn't enabled in Supabase yet.")
          : d;
    if (location.hash.includes('error')) history.replaceState(null, '', location.pathname + location.search.replace(/[?&]error[^#]*/, ''));
  }
  return out;
}

export function clearAuthError() {
  set({ authError: undefined });
}

/** New password after a reset link (or from Ajustes). */
export async function updatePassword(password: string) {
  const { error } = await supabase!.auth.updateUser({ password });
  if (!error) set({ recovery: false });
  return error ? translate(error.message) : null;
}
export const cancelRecovery = () => set({ recovery: false });
const listeners = new Set<() => void>();
const set = (patch: Partial<CloudState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export function useCloud(): CloudState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// ---------------------------------------------------------------------------
// Auth

if (supabase) {
  supabase.auth.getSession().then(({ data }) => handleSession(data.session));
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') set({ recovery: true });
    handleSession(session);
  });
}

let currentUser: string | null = null;

async function handleSession(session: Session | null) {
  const uid = session?.user.id ?? null;
  if (uid === currentUser) {
    set({ session, ready: true });
    return;
  }
  const previous = currentUser;
  currentUser = uid;
  if (!uid) {
    stopSync();
    // Don't leave the previous user's data on this computer (it's safe in the cloud).
    if (previous) localStorage.removeItem(`${LOCAL_KEY}:${previous}`);
    // Signed out: show an empty workspace so nothing from the previous user stays on screen.
    switchStorage('carteira:v1:signed-out');
    set({ session: null, ready: true, sync: 'idle' });
    return;
  }
  set({ session, ready: false, sync: 'loading' });
  await startSync(uid);
  set({ ready: true });
  void loadShared();
}

const redirectTo = () => (location.protocol.startsWith('http') ? location.origin + location.pathname : undefined);

export async function signIn(email: string, password: string) {
  const { error } = await supabase!.auth.signInWithPassword({ email, password });
  return error ? translate(error.message) : null;
}

export async function signUp(email: string, password: string, name: string): Promise<{ error: string | null; needsConfirm: boolean }> {
  const { data, error } = await supabase!.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectTo(), data: { full_name: name } },
  });
  if (error) return { error: translate(error.message), needsConfirm: false };
  return { error: null, needsConfirm: !data.session };
}

export async function signInWithGoogle() {
  const { error } = await supabase!.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo() } });
  return error ? translate(error.message) : null;
}

export async function resetPassword(email: string) {
  const { error } = await supabase!.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
  return error ? translate(error.message) : null;
}

/** First name from the account (sign-up form or Google profile). */
export function userFirstName(session: Session | null): string {
  const m = session?.user.user_metadata ?? {};
  const full = String(m.full_name ?? m.name ?? '').trim();
  return full.split(/\s+/)[0] ?? '';
}

export async function updateName(name: string) {
  const { data, error } = await supabase!.auth.updateUser({ data: { full_name: name } });
  if (!error && data.user) set({ session: state.session ? { ...state.session, user: data.user } : state.session });
  return error ? translate(error.message) : null;
}

export async function signOut() {
  await flush();
  await supabase?.auth.signOut();
}

function translate(msg: string) {
  const m = msg.toLowerCase();
  if (m.includes('invalid login')) return t('Email ou senha incorretos.', 'Wrong email or password.');
  if (m.includes('email not confirmed')) return t('Confirme seu email antes de entrar (veja sua caixa de entrada).', 'Confirm your email before signing in (check your inbox).');
  if (m.includes('already registered')) return t('Esse email já tem conta — use “Entrar”.', 'This email already has an account — use “Sign in”.');
  if (m.includes('password should be')) return t('A senha precisa ter pelo menos 6 caracteres.', 'The password needs at least 6 characters.');
  if (m.includes('provider is not enabled')) return t('Login com Google ainda não foi ativado no Supabase.', "Google sign-in isn't enabled in Supabase yet.");
  if (m.includes('same as the old') || m.includes('should be different')) return t('A nova senha precisa ser diferente da antiga.', 'The new password must be different from the old one.');
  if (m.includes('email rate limit') || m.includes('over_email_send_rate'))
    return t('O site atingiu o limite de emails por hora (não é culpa sua). Tente de novo em até 1 hora — ou entre com o Google.', 'The site hit its hourly email limit (not your fault). Try again within an hour — or continue with Google.');
  if (m.includes('rate limit')) return t('Muitas tentativas. Espere um pouco e tente de novo.', 'Too many attempts. Wait a bit and try again.');
  return msg;
}

// ---------------------------------------------------------------------------
// Sync

let unsubscribe: (() => void) | null = null;
let timer: number | undefined;
let pending = false;
let lastRemote = '';

async function startSync(uid: string) {
  stopSync();
  // Per-user local cache: instant load and offline use.
  switchStorage(`${LOCAL_KEY}:${uid}`);

  const { data: row, error } = await supabase!.from(TABLE).select('data, updated_at').eq('user_id', uid).maybeSingle();
  if (error) {
    set({ sync: 'offline', error: error.message });
  } else if (row) {
    lastRemote = row.updated_at;
    applyRemote(row.data as Data);
    set({ sync: 'saved', lastSavedAt: row.updated_at });
  } else {
    // First login: bring along whatever was saved on this computer before accounts existed.
    const local = peekStorage(LOCAL_KEY);
    const cached = getData();
    const initial = cached.assets.length ? cached : local && local.assets.length ? local : cached;
    if (initial !== cached) applyRemote(initial);
    await save(initial);
    if (initial === local) localStorage.removeItem(LOCAL_KEY);
  }

  unsubscribe = onEdit(() => {
    pending = true;
    set({ sync: 'saving' });
    clearTimeout(timer);
    timer = window.setTimeout(() => flush(), 1200);
  });
  window.addEventListener('focus', refreshIfNewer);
  window.addEventListener('online', flush);
}

function stopSync() {
  unsubscribe?.();
  unsubscribe = null;
  clearTimeout(timer);
  window.removeEventListener('focus', refreshIfNewer);
  window.removeEventListener('online', flush);
}

async function save(d: Data) {
  if (!supabase || !currentUser) return;
  const updated_at = new Date().toISOString();
  const { error } = await supabase.from(TABLE).upsert({ user_id: currentUser, data: d, updated_at });
  if (error) {
    set({ sync: navigator.onLine ? 'error' : 'offline', error: error.message });
    return false;
  }
  lastRemote = updated_at;
  set({ sync: 'saved', lastSavedAt: updated_at, error: undefined });
  return true;
}

export async function flush() {
  clearTimeout(timer);
  if (!pending) return;
  pending = false;
  const ok = await save(getData());
  if (ok === false) pending = true;
}

/** Another device may have saved changes: reload when the window regains focus. */
async function refreshIfNewer() {
  if (!supabase || !currentUser || pending) return;
  const { data: row } = await supabase.from(TABLE).select('data, updated_at').eq('user_id', currentUser).maybeSingle();
  if (row && row.updated_at > lastRemote && !pending) {
    lastRemote = row.updated_at;
    applyRemote(row.data as Data);
    set({ sync: 'saved', lastSavedAt: row.updated_at });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (pending) void flush();
  });
}

// ---------------------------------------------------------------------------
// AI document reading (Edge Function "read-document", which holds the Gemini key).

export interface AiItem {
  kind: 'trade' | 'dividend' | 'position' | 'cash';
  date?: string | null;
  side?: 'BUY' | 'SELL' | null;
  ticker?: string | null;
  name?: string | null;
  assetType: 'stock_br' | 'fii' | 'etf' | 'bdr' | 'stock_us' | 'crypto' | 'fixed_income' | 'fund' | 'cash' | 'other';
  quantity?: number | null;
  price?: number | null;
  amount?: number | null;
  fees?: number | null;
  currency: 'BRL' | 'USD' | 'EUR';
  rate?: string | null;
  maturity?: string | null;
  dividendType?: 'DIVIDEND' | 'JCP' | 'INCOME' | null;
}
export interface AiResult {
  institution?: string | null;
  statementDate?: string | null;
  items: AiItem[];
  used?: number;
  limit?: number;
}

export async function aiReadDocument(text: string): Promise<{ ok: true; result: AiResult } | { ok: false; reason: string }> {
  if (!supabase || !state.session) return { ok: false, reason: t('Entre na sua conta para usar a leitura com IA.', 'Sign in to use AI reading.') };
  const { data, error } = await supabase.functions.invoke('read-document', { body: { text } });
  if (!error && data?.items) return { ok: true, result: data as AiResult };
  let code = (data as { error?: string } | null)?.error ?? '';
  let detail = (data as { detail?: string } | null)?.detail ?? '';
  try {
    // functions.invoke puts the response of a non-2xx call in error.context
    const ctx = (error as { context?: Response } | null)?.context;
    if (!code && ctx?.text) {
      const body = await ctx.text();
      try {
        const j = JSON.parse(body);
        code = j?.error ?? '';
        detail = j?.detail ?? j?.message ?? body;
      } catch {
        detail = body;
      }
    }
  } catch {
    /* no body */
  }
  if (!detail && error) detail = String(error.message ?? error);
  const status = (error as { context?: { status?: number } } | null)?.context?.status;
  if (status === 404 || /not found|FunctionsFetchError|Failed to send/i.test(String(error?.message ?? '')))
    return { ok: false, reason: t('A leitura com IA ainda não foi instalada no Supabase.', "AI reading isn't set up in Supabase yet.") };
  const reasons: Record<string, string> = {
    'missing-key': t('Falta a chave do Gemini nos segredos do Supabase (GEMINI_API_KEY).', 'The Gemini key is missing from the Supabase secrets (GEMINI_API_KEY).'),
    'daily-limit': t('Limite diário de leituras com IA atingido. Tente amanhã.', 'Daily AI reading limit reached. Try again tomorrow.'),
    'gemini-quota': t('A cota grátis do Gemini acabou por hoje. Tente mais tarde.', "Gemini's free quota is used up for now. Try later."),
    'not-signed-in': t('Entre na sua conta para usar a leitura com IA.', 'Sign in to use AI reading.'),
  };
  reasons['gemini-key'] = t('O Google recusou a chave do Gemini — confira o segredo GEMINI_API_KEY no Supabase.', 'Google rejected the Gemini key — check the GEMINI_API_KEY secret in Supabase.');
  const base = reasons[code] ?? t('A IA não conseguiu ler esse documento.', "The AI couldn't read this document.");
  // Show the technical reason too, so problems can be fixed.
  const tech = [code, status ? `HTTP ${status}` : '', detail].filter(Boolean).join(' · ').slice(0, 400);
  return { ok: false, reason: tech && !reasons[code] ? `${base} (${tech})` : base };
}

// ---------------------------------------------------------------------------
// Shared market-data keys: signed-in users without their own key use the site owner's keys
// through the "quotes" Edge Function. URLs carry SHARED_KEY where the key goes; fetch() below
// sends those to the function, which swaps in the real key server-side.

export const SHARED_KEY = '__shared__';
type Provider = 'finnhub' | 'brapi' | 'twelve';
let shared: Record<Provider, boolean> = { finnhub: false, brapi: false, twelve: false };

/** The user's own key, else the shared placeholder when the site provides one. */
export function apiKey(s: { finnhubToken?: string; brapiToken?: string; twelveDataToken?: string }, p: Provider): string | undefined {
  const own = p === 'finnhub' ? s.finnhubToken : p === 'brapi' ? s.brapiToken : s.twelveDataToken;
  return own || (shared[p] ? SHARED_KEY : undefined);
}
export const usesSharedKey = (s: { finnhubToken?: string; brapiToken?: string; twelveDataToken?: string }, p: Provider) => apiKey(s, p) === SHARED_KEY;

async function loadShared() {
  if (!supabase || !state.session) return;
  try {
    const { data, error } = await supabase.functions.invoke('quotes', { body: { check: true } });
    if (data && typeof data === 'object' && 'finnhub' in data) {
      shared = { finnhub: !!data.finnhub, brapi: !!data.brapi, twelve: !!data.twelve };
      const on = (Object.keys(shared) as Provider[]).filter((k) => shared[k]);
      set({
        sharedKeys: on.join(','),
        sharedStatus: on.length === 3 ? 'ok' : t(`A função "quotes" responde, mas faltam segredos: ${(['finnhub', 'brapi', 'twelve'] as Provider[]).filter((k) => !shared[k]).map((k) => ({ finnhub: 'FINNHUB_KEY', brapi: 'BRAPI_TOKEN', twelve: 'TWELVEDATA_KEY' })[k]).join(', ')}.`, `The "quotes" function answers, but secrets are missing: ${(['finnhub', 'brapi', 'twelve'] as Provider[]).filter((k) => !shared[k]).map((k) => ({ finnhub: 'FINNHUB_KEY', brapi: 'BRAPI_TOKEN', twelve: 'TWELVEDATA_KEY' })[k]).join(', ')}.`),
      });
    } else {
      const ctx = (error as { context?: Response } | null)?.context;
      const status = ctx?.status;
      const body = ctx?.text ? await ctx.text().catch(() => '') : '';
      set({
        sharedStatus:
          status === 404
            ? t('A função "quotes" não foi encontrada no Supabase (confira o nome exato: quotes).', 'The "quotes" function was not found in Supabase (check the exact name: quotes).')
            : t(`A função "quotes" respondeu com erro ${status ?? ''} ${body.slice(0, 160)}`, `The "quotes" function returned error ${status ?? ''} ${body.slice(0, 160)}`),
      });
    }
  } catch (e) {
    set({ sharedStatus: t(`Não foi possível falar com a função "quotes": ${String(e).slice(0, 120)}`, `Couldn't reach the "quotes" function: ${String(e).slice(0, 120)}`) });
  }
}

if (typeof window !== 'undefined' && supabase) {
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.includes(SHARED_KEY)) return original(input, init);
    return original(`${url}/functions/v1/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon!, Authorization: `Bearer ${state.session?.access_token ?? anon}` },
      body: JSON.stringify({ url: href }),
    });
  };
}
