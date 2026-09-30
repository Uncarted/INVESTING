import { useCallback, useEffect, useRef, useState } from 'react';
import { actions, getData, useData } from './lib/store';
import { setHideValues } from './lib/format';
import { exportWorkbook } from './lib/exporters';
import { flushLive, startLive } from './lib/live';
import { cloudEnabled, signOut, useCloud } from './lib/cloud';
import { AuthScreen, Splash } from './components/AuthScreen';
import { Icon } from './components/Icon';
import { Toasts } from './components/ui';
import { TransactionForm, type FormInit } from './components/TransactionForm';
import { AssetDrawer } from './components/AssetDrawer';
import { Home } from './pages/Home';
import { Lancamentos } from './pages/Lancamentos';
import { Proventos } from './pages/Proventos';
import { ImpostoRenda } from './pages/ImpostoRenda';
import { Importar } from './pages/Importar';
import { Configuracoes } from './pages/Configuracoes';

const PANELS = {
  lancamentos: { title: 'Lançamentos', sub: 'Tudo o que você comprou, vendeu, aplicou e resgatou', icon: 'list' },
  proventos: { title: 'Proventos', sub: 'Dividendos, JCP e rendimentos recebidos', icon: 'coins' },
  ir: { title: 'Imposto de Renda', sub: 'Bens e direitos, DARFs e rendimentos — pronto para declarar', icon: 'receipt' },
  importar: { title: 'Importar & backup', sub: 'Extratos da B3, planilhas e cópia de segurança', icon: 'upload' },
  config: { title: 'Ajustes', sub: 'Taxas, cotações, aparência e dados', icon: 'settings' },
} as const;
type PanelId = keyof typeof PANELS;

const readHash = (): PanelId | null => {
  const h = location.hash.replace(/^#\/?/, '');
  return h in PANELS ? (h as PanelId) : null;
};

function useSystemDark() {
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq?.addEventListener('change', on);
    return () => mq?.removeEventListener('change', on);
  }, []);
  return dark;
}

export function App() {
  const data = useData();
  const cloud = useCloud();
  const [panel, setPanel] = useState<PanelId | null>(readHash);
  const [form, setForm] = useState<FormInit | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const systemDark = useSystemDark();

  setHideValues(data.settings.hideValues);

  useEffect(() => {
    const onHash = () => setPanel(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Live quotes: (re)start whenever the tickers or keys change.
  const s = data.settings;
  useEffect(() => {
    startLive(data.assets, s);
  }, [data.assets, s]);
  useEffect(() => {
    window.addEventListener('beforeunload', flushLive);
    return () => window.removeEventListener('beforeunload', flushLive);
  }, []);

  const theme = data.settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : data.settings.theme;
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const open = useCallback((p: string) => {
    setMenu(false);
    location.hash = '/' + p;
  }, []);
  const close = useCallback(() => {
    history.pushState('', '', location.pathname + location.search);
    setPanel(null);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menu]);

  // Keyboard: N = new, Esc = close panel/menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === 'Escape' && !form && !assetId) {
        if (menu) setMenu(false);
        else if (panel) close();
        return;
      }
      if (el.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === 'n' && !form) {
        e.preventDefault();
        setForm({});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [form, assetId, menu, panel, close]);

  const hidden = data.settings.hideValues;
  const backupDays = data.settings.lastBackupAt ? (Date.now() - Date.parse(data.settings.lastBackupAt)) / 86400000 : Infinity;
  // With accounts, data lives in the cloud: no backup nagging.
  const needsBackup = !cloudEnabled && data.transactions.length >= 10 && backupDays > 30;

  const topbarActions = (
    <>
      <button className="round-btn" title={hidden ? 'Mostrar valores' : 'Ocultar valores'} onClick={() => actions.updateSettings({ hideValues: !hidden })}>
        <Icon name={hidden ? 'eyeOff' : 'eye'} size={17} />
      </button>
      <button className="pill-btn" onClick={() => setForm({})} title="Atalho: N">
        <Icon name="plus" size={17} /> <span className="lbl">Adicionar</span>
      </button>
    </>
  );

  if (cloudEnabled && !cloud.ready) return <Splash />;
  if (cloudEnabled && !cloud.session) return <AuthScreen />;

  return (
    <>
      <div className="shell">
        <header className="topbar">
          <div className="wordmark">carteira<i>.</i></div>
          <div className="spacer" />
          {topbarActions}
          <div className="menu-wrap" ref={menuRef}>
            <button className={'round-btn' + (menu ? ' on' : '')} onClick={() => setMenu((m) => !m)} aria-label="Menu" style={{ position: 'relative' }}>
              <Icon name="menu" size={18} />
              {needsBackup && <span style={{ position: 'absolute', top: 7, right: 7, width: 8, height: 8, borderRadius: 9, background: 'var(--warn-ink)' }} />}
            </button>
            {menu && (
              <div className="menu" role="menu">
                {cloudEnabled && cloud.session && (
                  <>
                    <div className="menu-account">
                      <span className="acct-avatar">{(cloud.session.user.email ?? '?')[0].toUpperCase()}</span>
                      <span style={{ minWidth: 0 }}>
                        <b>{cloud.session.user.email}</b>
                        <span className="sub"><SyncLabel status={cloud.sync} /></span>
                      </span>
                      <button className="btn sm" onClick={() => { setMenu(false); void signOut(); }}>Sair</button>
                    </div>
                    <div className="menu-sep" />
                  </>
                )}
                {(['lancamentos', 'proventos', 'ir'] as PanelId[]).map((id) => (
                  <MenuItem key={id} icon={PANELS[id].icon} title={PANELS[id].title} sub={PANELS[id].sub} onClick={() => open(id)} />
                ))}
                <div className="menu-sep" />
                <MenuItem icon="upload" title="Importar da B3" sub="Negociação e movimentação, todas as corretoras" onClick={() => open('importar')} />
                <MenuItem icon="download" title="Baixar planilha" sub="Posições e lançamentos em Excel" onClick={() => { setMenu(false); exportWorkbook(getData()); }} />
                <MenuItem
                  icon="file"
                  title="Backup"
                  sub={needsBackup ? 'Faz tempo que você não salva um backup' : 'Salvar ou restaurar seus dados'}
                  onClick={() => open('importar')}
                  warn={needsBackup}
                />
                <div className="menu-sep" />
                <MenuItem
                  icon={theme === 'dark' ? 'sun' : 'moon'}
                  title={theme === 'dark' ? 'Modo claro' : 'Modo escuro'}
                  onClick={() => actions.updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' })}
                />
                <MenuItem icon="settings" title="Ajustes" onClick={() => open('config')} />
              </div>
            )}
          </div>
        </header>

        <Home onAdd={() => setForm({})} open={open} openAsset={setAssetId} />
      </div>

      {panel && (
        <div className="panel">
          <div className="panel-inner">
            <header className="panel-head">
              <button className="round-btn" onClick={close} aria-label="Voltar"><Icon name="back" /></button>
              <div>
                <h1>{PANELS[panel].title}</h1>
                <p>{PANELS[panel].sub}</p>
              </div>
              <div className="spacer" />
              {topbarActions}
            </header>
            {panel === 'lancamentos' && <Lancamentos onEdit={setForm} />}
            {panel === 'proventos' && <Proventos openAsset={setAssetId} />}
            {panel === 'ir' && <ImpostoRenda openAsset={setAssetId} />}
            {panel === 'importar' && <Importar />}
            {panel === 'config' && <Configuracoes />}
          </div>
        </div>
      )}

      {assetId && <AssetDrawer assetId={assetId} onClose={() => setAssetId(null)} onAdd={setForm} />}
      {form && <TransactionForm init={form} onClose={() => setForm(null)} />}
      <Toasts />
    </>
  );
}

function MenuItem({ icon, title, sub, onClick, warn }: { icon: string; title: string; sub?: string; onClick: () => void; warn?: boolean }) {
  return (
    <button className="menu-item" role="menuitem" onClick={onClick}>
      <span className="ic" style={warn ? { color: 'var(--warn-ink)' } : undefined}><Icon name={icon} size={18} /></span>
      <span>
        <b>{title}</b>
        {sub && <span className="sub">{sub}</span>}
      </span>
      <span />
    </button>
  );
}

function SyncLabel({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    idle: ['', 'var(--muted)'],
    loading: ['Carregando…', 'var(--muted)'],
    saving: ['Salvando…', 'var(--muted)'],
    saved: ['✓ Salvo na nuvem', 'var(--pos)'],
    error: ['Erro ao salvar — tentando de novo', 'var(--neg)'],
    offline: ['Sem internet — salvo neste computador', 'var(--warn-ink)'],
  };
  const [label, color] = map[status] ?? map.idle;
  return <span style={{ color }}>{label}</span>;
}
