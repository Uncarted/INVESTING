import { useSyncExternalStore } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { LOCAL_KEY, applyRemote, getData, onEdit, peekStorage, switchStorage } from './store';
import type { Data } from './types';

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

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
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
}

let state: CloudState = { ready: !cloudEnabled, session: null, sync: 'idle' };
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
  supabase.auth.onAuthStateChange((_event, session) => handleSession(session));
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
}

const redirectTo = () => (location.protocol.startsWith('http') ? location.origin + location.pathname : undefined);

export async function signIn(email: string, password: string) {
  const { error } = await supabase!.auth.signInWithPassword({ email, password });
  return error ? translate(error.message) : null;
}

export async function signUp(email: string, password: string): Promise<{ error: string | null; needsConfirm: boolean }> {
  const { data, error } = await supabase!.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo() } });
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

export async function signOut() {
  await flush();
  await supabase?.auth.signOut();
}

function translate(msg: string) {
  const m = msg.toLowerCase();
  if (m.includes('invalid login')) return 'Email ou senha incorretos.';
  if (m.includes('email not confirmed')) return 'Confirme seu email antes de entrar (veja sua caixa de entrada).';
  if (m.includes('already registered')) return 'Esse email já tem conta — use “Entrar”.';
  if (m.includes('password should be')) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (m.includes('provider is not enabled')) return 'Login com Google ainda não foi ativado no Supabase.';
  if (m.includes('rate limit')) return 'Muitas tentativas. Espere um pouco e tente de novo.';
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
