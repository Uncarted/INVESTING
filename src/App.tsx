import { useCallback, useEffect, useState } from 'react';
import { actions, useData } from './lib/store';
import { setHideValues } from './lib/format';
import { Icon } from './components/Icon';
import { Toasts } from './components/ui';
import { TransactionForm, type FormInit } from './components/TransactionForm';
import { AssetDrawer } from './components/AssetDrawer';
import { Dashboard } from './pages/Dashboard';
import { Carteira } from './pages/Carteira';
import { Lancamentos } from './pages/Lancamentos';
import { Proventos } from './pages/Proventos';
import { ImpostoRenda } from './pages/ImpostoRenda';
import { Importar } from './pages/Importar';
import { Configuracoes } from './pages/Configuracoes';

const PAGES = [
  { id: 'inicio', label: 'Visão geral', icon: 'home', sub: 'Seu patrimônio em um só lugar' },
  { id: 'carteira', label: 'Carteira', icon: 'wallet', sub: 'Posições, preço médio e resultado de cada ativo' },
  { id: 'lancamentos', label: 'Lançamentos', icon: 'list', sub: 'Compras, vendas, aplicações e eventos' },
  { id: 'proventos', label: 'Proventos', icon: 'coins', sub: 'Dividendos, JCP e rendimentos recebidos' },
  { id: 'ir', label: 'Imposto de Renda', icon: 'receipt', sub: 'Bens e direitos, apuração mensal e rendimentos' },
  { id: 'importar', label: 'Importar / Backup', icon: 'upload', sub: 'Extratos da B3, planilhas e backup' },
  { id: 'config', label: 'Configurações', icon: 'settings', sub: 'Taxas, cotações e dados' },
] as const;
type PageId = (typeof PAGES)[number]['id'];

const readHash = (): PageId => {
  const h = location.hash.replace(/^#\/?/, '');
  return (PAGES.find((p) => p.id === h)?.id ?? 'inicio') as PageId;
};

export function App() {
  const data = useData();
  const [page, setPage] = useState<PageId>(readHash);
  const [form, setForm] = useState<FormInit | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);

  setHideValues(data.settings.hideValues);

  useEffect(() => {
    const onHash = () => setPage(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (data.settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', data.settings.theme);
  }, [data.settings.theme]);

  const go = useCallback((p: string) => {
    location.hash = '/' + p;
  }, []);

  // "N" opens the new-transaction form from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === 'n' && !form) {
        e.preventDefault();
        setForm({});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [form]);

  const meta = PAGES.find((p) => p.id === page)!;
  const backupDays = data.settings.lastBackupAt ? (Date.now() - Date.parse(data.settings.lastBackupAt)) / 86400000 : Infinity;
  const needsBackup = data.transactions.length >= 10 && backupDays > 30;

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-logo"><Icon name="chart" size={16} /></div>
          Carteira
        </div>
        {PAGES.map((p) => (
          <a key={p.id} href={`#/${p.id}`} className={'nav-item' + (page === p.id ? ' active' : '')} title={p.label}>
            <Icon name={p.icon} />
            <span>{p.label}</span>
          </a>
        ))}
        <div className="sidebar-foot">
          {needsBackup && (
            <a href="#/importar" className="notice" style={{ textDecoration: 'none', marginBottom: 8 }}>
              <Icon name="alert" size={16} />
              <span>Faça um backup dos seus dados.</span>
            </a>
          )}
          <button className="nav-item" onClick={() => actions.updateSettings({ hideValues: !data.settings.hideValues })}>
            <Icon name={data.settings.hideValues ? 'eyeOff' : 'eye'} />
            <span>{data.settings.hideValues ? 'Mostrar valores' : 'Ocultar valores'}</span>
          </button>
        </div>
      </nav>

      <main className="main">
        <header className="page-head">
          <div>
            <h1>{meta.label}</h1>
            <p>{meta.sub}</p>
          </div>
          <div className="spacer" />
          <button className="btn primary" onClick={() => setForm({})} title="Atalho: N">
            <Icon name="plus" /> Novo lançamento <span className="kbd" style={{ color: 'rgba(255,255,255,.8)', borderColor: 'rgba(255,255,255,.4)' }}>N</span>
          </button>
        </header>

        {page === 'inicio' && <Dashboard onAdd={() => setForm({})} go={go} openAsset={setAssetId} />}
        {page === 'carteira' && <Carteira openAsset={setAssetId} />}
        {page === 'lancamentos' && <Lancamentos onEdit={setForm} />}
        {page === 'proventos' && <Proventos openAsset={setAssetId} />}
        {page === 'ir' && <ImpostoRenda openAsset={setAssetId} />}
        {page === 'importar' && <Importar />}
        {page === 'config' && <Configuracoes />}
      </main>

      {assetId && <AssetDrawer assetId={assetId} onClose={() => setAssetId(null)} onAdd={setForm} />}
      {form && <TransactionForm init={form} onClose={() => setForm(null)} />}
      <Toasts />
    </div>
  );
}
