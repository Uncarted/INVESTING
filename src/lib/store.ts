import { useSyncExternalStore } from 'react';
import type { Asset, Data, Settings, Transaction } from './types';
import { uid } from './format';

/** Local storage key; each logged-in user gets their own (see switchStorage). */
export const LOCAL_KEY = 'carteira:v1';
let KEY = LOCAL_KEY;

export const DEFAULT_SETTINGS: Settings = {
  cdiRate: 14.9,
  ipcaRate: 4.5,
  selicRate: 15,
  fx: { USD: 5.4, EUR: 6.3 },
  livePrices: true,
  theme: 'dark',
  hideValues: false,
};

const empty = (): Data => ({ version: 1, assets: [], transactions: [], settings: { ...DEFAULT_SETTINGS } });

function load(key = KEY): Data {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return empty();
    return normalize(JSON.parse(raw));
  } catch {
    return empty();
  }
}

export function normalize(d: Partial<Data>): Data {
  return {
    version: 1,
    assets: Array.isArray(d.assets) ? d.assets : [],
    transactions: Array.isArray(d.transactions) ? d.transactions : [],
    settings: { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) },
  };
}

let state: Data = load();
let undoStack: { label: string; data: Data }[] = [];
const listeners = new Set<() => void>();
/** Listeners for local edits only (not remote loads) — used by cloud sync. */
const editListeners = new Set<(d: Data) => void>();

/** Switches to another local cache (e.g. per logged-in user) and loads it. */
export function switchStorage(key: string) {
  KEY = key;
  state = load(key);
  undoStack = [];
  listeners.forEach((l) => l());
}

/** Reads the data saved under another key without switching (e.g. local data to migrate). */
export const peekStorage = (key: string): Data | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
};

/** Replaces data with a copy loaded from the cloud (no undo, no re-upload). */
export function applyRemote(d: Partial<Data>) {
  state = normalize(d);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full */
  }
  listeners.forEach((l) => l());
}

export function onEdit(fn: (d: Data) => void) {
  editListeners.add(fn);
  return () => editListeners.delete(fn);
}

function commit(next: Data, undoLabel?: string, background = false) {
  if (undoLabel) undoStack = [...undoStack.slice(-19), { label: undoLabel, data: state }];
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Falha ao salvar', e);
  }
  // Background saves (latest prices) only refresh the local copy: the screen already shows
  // them live, and they don't need to go to the cloud.
  if (background) return;
  listeners.forEach((l) => l());
  editListeners.forEach((l) => l(state));
}

// Keep tabs in sync.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      state = load();
      listeners.forEach((l) => l());
    }
  });
}

export function useData(): Data {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const getData = () => state;

const now = () => new Date().toISOString();

export const actions = {
  addAsset(a: Omit<Asset, 'id' | 'createdAt'>): Asset {
    const asset: Asset = { ...a, id: uid(), createdAt: now() };
    commit({ ...state, assets: [...state.assets, asset] });
    return asset;
  },
  updateAsset(id: string, patch: Partial<Asset>) {
    commit({ ...state, assets: state.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  },
  deleteAsset(id: string) {
    const a = state.assets.find((x) => x.id === id);
    commit(
      {
        ...state,
        assets: state.assets.filter((x) => x.id !== id),
        transactions: state.transactions.filter((t) => t.assetId !== id),
      },
      `Ativo ${a?.ticker ?? ''} removido`,
    );
  },
  addTransactions(txs: Omit<Transaction, 'id' | 'createdAt'>[], newAssets: Asset[] = []) {
    const created = txs.map((t, i) => ({
      ...t,
      id: uid(),
      createdAt: new Date(Date.now() + i).toISOString(),
    }));
    commit(
      {
        ...state,
        assets: [...state.assets, ...newAssets],
        transactions: [...state.transactions, ...created],
      },
      newAssets.length || txs.length > 1 ? `${txs.length} lançamento(s) adicionados` : undefined,
    );
    return created;
  },
  updateTransaction(id: string, patch: Partial<Transaction>) {
    commit({
      ...state,
      transactions: state.transactions.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  },
  deleteTransactions(ids: string[]) {
    const set = new Set(ids);
    commit(
      { ...state, transactions: state.transactions.filter((t) => !set.has(t.id)) },
      `${ids.length} lançamento(s) excluído(s)`,
    );
  },
  /** Saves quotes without creating undo history. */
  updatePrices(prices: Map<string, { price: number; prevClose?: number }>) {
    let changed = false;
    const now = new Date().toISOString();
    const assets = state.assets.map((a) => {
      const p = prices.get(a.ticker.toUpperCase());
      if (!p || (p.price === a.currentPrice && p.prevClose === a.prevClose)) return a;
      changed = true;
      return { ...a, currentPrice: p.price, prevClose: p.prevClose ?? a.prevClose, priceUpdatedAt: now };
    });
    if (changed) commit({ ...state, assets }, undefined, true);
  },
  updateSettings(patch: Partial<Settings>) {
    commit({ ...state, settings: { ...state.settings, ...patch } });
  },
  replaceAll(d: Data, label = 'Dados substituídos') {
    commit(normalize(d), label);
  },
  undo(): string | null {
    const last = undoStack.pop();
    if (!last) return null;
    commit(last.data);
    return last.label;
  },
  canUndo: () => undoStack.length > 0,
};

/** Finds an asset by ticker (case-insensitive) or creates the object for a new one (not saved). */
export function findAsset(ticker: string): Asset | undefined {
  const t = ticker.trim().toUpperCase();
  return state.assets.find((a) => a.ticker.toUpperCase() === t);
}

export function newAsset(a: Omit<Asset, 'id' | 'createdAt'>): Asset {
  return { ...a, id: uid(), createdAt: now() };
}
