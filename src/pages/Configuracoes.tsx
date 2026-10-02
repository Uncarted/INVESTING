import { useEffect, useState } from 'react';
import { actions, useData } from '../lib/store';
import { fetchRates } from '../lib/quotes';
import { checkKey, cleanKey } from '../lib/keys';
import { cloudEnabled, updateName, updatePassword, useCloud } from '../lib/cloud';
import { getLang, t } from '../lib/i18n';
import { useLive, type FeedStatus } from '../lib/live';
import { fmtDate, money, numStr, parseNumber } from '../lib/format';
import { toast } from '../components/ui';
import { Icon } from '../components/Icon';
import { exportBackup, exportWorkbook } from '../lib/exporters';
import { sampleData } from '../lib/sample';

export function Configuracoes() {
  const data = useData();
  const live = useLive();
  const cloud = cloudEnabled;
  const s = data.settings;
  const { sharedKeys } = useCloud();
  const [loading, setLoading] = useState(false);

  const rateField = (label: string, key: 'cdiRate' | 'ipcaRate' | 'selicRate', hint: string) => (
    <label className="field">
      <span>{label}</span>
      <div className="row">
        <input
          className="input num"
          key={s[key] + getLang()}
          defaultValue={numStr(s[key])}
          onBlur={(e) => {
            const v = parseNumber(e.target.value);
            if (Number.isFinite(v)) actions.updateSettings({ [key]: v });
          }}
        />
        <span className="muted" style={{ whiteSpace: 'nowrap' }}>{t('% a.a.', '% p.a.')}</span>
      </div>
      <span className="hint">{hint}</span>
    </label>
  );

  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      {cloud && <AccountCard />}
      <div className="card card-pad stack">
        <h2 style={{ fontSize: 15, margin: 0 }}>Idioma · Language</h2>
        <div className="seg" style={{ width: 'fit-content' }}>
          <button className={getLang() === 'pt' ? 'on' : ''} onClick={() => actions.updateSettings({ language: 'pt' })}>Português</button>
          <button className={getLang() === 'en' ? 'on' : ''} onClick={() => actions.updateSettings({ language: 'en' })}>English</button>
        </div>
      </div>

      <div className="card card-pad stack">
        <div className="row">
          <h2 style={{ fontSize: 15, margin: 0 }}>{t('Taxas para estimar a renda fixa', 'Rates used to estimate fixed income')}</h2>
          <div className="spacer" />
          <button
            className="btn sm"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              const r = await fetchRates();
              setLoading(false);
              const patch = { ...(r.cdi && { cdiRate: r.cdi }), ...(r.selic && { selicRate: r.selic }), ...(r.ipca && { ipcaRate: r.ipca }) };
              if (Object.keys(patch).length) {
                actions.updateSettings(patch);
                toast(t('Taxas atualizadas pelo Banco Central', 'Rates updated from the Banco Central'));
              } else toast(t('Não foi possível acessar o Banco Central', "Couldn't reach the Banco Central"));
            }}
          >
            <Icon name="refresh" size={14} /> {loading ? t('Buscando…', 'Fetching…') : t('Buscar no Banco Central', 'Fetch from Banco Central')}
          </button>
        </div>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
          {rateField('CDI', 'cdiRate', t('Para títulos % do CDI', 'For % of CDI bonds'))}
          {rateField('Selic', 'selicRate', t('Para Tesouro Selic', 'For Tesouro Selic'))}
          {rateField(t('IPCA (12 meses)', 'IPCA (12 months)'), 'ipcaRate', t('Para títulos IPCA+', 'For IPCA+ bonds'))}
        </div>
        <p className="muted small" style={{ margin: 0 }}>{t('O valor da renda fixa é uma estimativa bruta. Para precisão, informe o saldo do banco no detalhe de cada investimento.', "Fixed-income values are gross estimates. For exact values, enter your bank balance in each investment's details.")}</p>
      </div>

      <div className="card card-pad stack">
        <div className="row">
          <h2 style={{ fontSize: 15, margin: 0 }}>{t('Cotações ao vivo', 'Live quotes')}</h2>
          <div className="spacer" />
          <label className="row small text-2">
            <input type="checkbox" checked={s.livePrices} onChange={(e) => actions.updateSettings({ livePrices: e.target.checked })} /> {t('Ligado', 'On')}
          </label>
        </div>
        <div className="feeds">
          <Feed name={t('Ações dos EUA e exterior', 'US & foreign stocks')} detail={t('Finnhub · tempo real', 'Finnhub · real time')} status={live.status.us} />
          <Feed name={t('B3 — ações, FIIs, ETFs, BDRs', 'B3 — stocks, REITs, ETFs, BDRs')} detail={t('brapi · a cada minuto', 'brapi · every minute')} status={live.status.b3} />
          <Feed name={t('Cripto', 'Crypto')} detail={t('Binance · tempo real, sem cadastro', 'Binance · real time, no signup')} status={live.status.crypto} />
          <Feed name={t('Dólar e euro', 'Dollar and euro')} detail={`AwesomeAPI · US$ 1 = ${money(s.fx.USD, { always: true })} · € 1 = ${money(s.fx.EUR, { always: true })}`} status={live.status.fx} />
        </div>
        {sharedKeys && (
          <div className="notice info">
            <Icon name="check" />
            <span>{t('Já está tudo conectado: o Walleti fornece as chaves de cotação para você. Só preencha abaixo se quiser usar uma chave sua (ela passa a ter prioridade).', "You're all set: Walleti provides the quote keys for you. Only fill these in if you want to use your own key (it then takes priority).")}</span>
          </div>
        )}
        <KeyField
          label={t('Finnhub — ações dos EUA ao vivo (AMD, TTWO, AAPL…)', 'Finnhub — live US stocks (AMD, TTWO, AAPL…)')}
          kind="finnhub"
          value={s.finnhubToken}
          onSave={(v) => actions.updateSettings({ finnhubToken: v })}
          help={<>{t('Grátis em', 'Free at')} <a href="https://finnhub.io/register" target="_blank" rel="noreferrer">finnhub.io/register</a> {t('→ depois de entrar, a chave aparece em “API Key” no painel.', '→ after you log in, the key is under “API Key” on the dashboard.')}</>}
        />
        <KeyField
          label={t('brapi — ações, FIIs e ETFs da B3', 'brapi — B3 stocks, REITs and ETFs')}
          kind="brapi"
          value={s.brapiToken}
          onSave={(v) => actions.updateSettings({ brapiToken: v })}
          help={<>{t('Grátis em', 'Free at')} <a href="https://brapi.dev/dashboard" target="_blank" rel="noreferrer">brapi.dev/dashboard</a> {t('→ copie o token do painel.', '→ copy the token from the dashboard.')}</>}
        />
        <KeyField
          label={t('Twelve Data — preço de datas passadas (EUA) · opcional', 'Twelve Data — past-date prices (US) · optional')}
          kind="twelve"
          value={s.twelveDataToken}
          onSave={(v) => actions.updateSettings({ twelveDataToken: v })}
          help={<>{t('Grátis em', 'Free at')} <a href="https://twelvedata.com/register" target="_blank" rel="noreferrer">twelvedata.com/register</a> → {t('menu “API Keys”.', '“API Keys” menu.')}</>}
        />
        <p className="muted small" style={{ margin: 0 }}>{cloud ? t('As chaves ficam salvas na sua conta — valem em qualquer computador.', 'Keys are saved to your account — they work on any computer.') : t('As chaves ficam salvas neste navegador.', 'Keys are saved in this browser.')}</p>
      </div>

      <div className="card card-pad stack">
        <h2 style={{ fontSize: 15, margin: 0 }}>{t('Aparência', 'Appearance')}</h2>
        <div className="seg">
          {(['system', 'light', 'dark'] as const).map((th) => (
            <button key={th} className={s.theme === th ? 'on' : ''} onClick={() => actions.updateSettings({ theme: th })}>
              {th === 'system' ? t('Automático', 'Automatic') : th === 'light' ? t('Claro', 'Light') : t('Escuro', 'Dark')}
            </button>
          ))}
        </div>
      </div>

      <div className="card card-pad stack">
        <h2 style={{ fontSize: 15, margin: 0 }}>{t('Dados', 'Data')}</h2>
        <p className="text-2" style={{ margin: 0 }}>
          {data.assets.length} {t('ativos', 'assets')} · {data.transactions.length} {t('lançamentos', 'transactions')} · {cloud ? t('salvos na sua conta.', 'saved to your account.') : t('salvos apenas neste navegador.', 'saved only in this browser.')}
          {s.lastBackupAt ? ` ${t('Último backup em', 'Last backup')} ${fmtDate(s.lastBackupAt.slice(0, 10))}.` : cloud ? '' : ` ${t('Nenhum backup feito ainda.', 'No backup yet.')}`}
        </p>
        <div className="row wrap">
          <button className="btn" onClick={() => exportWorkbook(data)}>
            <Icon name="download" size={16} /> {t('Baixar planilha (Excel)', 'Download spreadsheet (Excel)')}
          </button>
          <button className="btn" onClick={() => { exportBackup(data); actions.updateSettings({ lastBackupAt: new Date().toISOString() }); }}>
            <Icon name="download" size={16} /> {t('Salvar backup', 'Save backup')}
          </button>
          {!data.assets.length && (
            <button className="btn" onClick={() => { actions.replaceAll({ ...sampleData(), settings: s }, 'Exemplo carregado'); toast(t('Dados de exemplo carregados', 'Sample data loaded'), { undo: true }); }}>
              {t('Carregar dados de exemplo', 'Load sample data')}
            </button>
          )}
          <div className="spacer" />
          <button
            className="btn danger"
            onClick={() => {
              if (!window.confirm(t('Apagar TODOS os ativos e lançamentos? (Dá para desfazer logo em seguida.)', 'Delete ALL assets and transactions? (You can undo right after.)'))) return;
              actions.replaceAll({ ...data, assets: [], transactions: [] }, 'Tudo apagado');
              toast(t('Dados apagados', 'Data deleted'), { undo: true });
            }}
          >
            <Icon name="trash" size={16} /> {t('Apagar tudo', 'Delete everything')}
          </button>
        </div>
      </div>
    </div>
  );
}

const statusLabel = (st: FeedStatus): [string, string] =>
  ({
    off: [t('Desligado', 'Off'), 'var(--muted)'],
    ready: [t('Pronto', 'Ready'), 'var(--pos)'],
    connecting: [t('Conectando…', 'Connecting…'), 'var(--warn-ink)'],
    live: [t('Ao vivo', 'Live'), 'var(--pos)'],
    polling: [t('Atualizando', 'Updating'), 'var(--pos)'],
    error: [t('Sem conexão', 'No connection'), 'var(--neg)'],
    'needs-key': [t('Precisa de chave', 'Needs a key'), 'var(--warn-ink)'],
  })[st] as [string, string];

function Feed({ name, detail, status }: { name: string; detail: string; status: FeedStatus }) {
  const [label, color] = statusLabel(status);
  if (status === 'ready') detail += t(' · liga sozinho quando você tiver ativos desse mercado', ' · starts by itself once you hold assets from this market');
  return (
    <div className="feed">
      <span className={'feed-dot' + (status === 'live' ? ' live' : '')} style={{ background: color }} />
      <span>
        <b>{name}</b>
        <small>{detail}</small>
      </span>
      <span className="small" style={{ color }}>{label}</span>
    </div>
  );
}

/** Quiet key input: saves when you leave the field (or press Enter) and shows a small ✓/✗ from a live test. */
function AccountCard() {
  const { session } = useCloud();
  const current = String(session?.user.user_metadata?.full_name ?? session?.user.user_metadata?.name ?? '');
  return (
    <div className="card card-pad stack">
      <h2 style={{ fontSize: 15, margin: 0 }}>{t('Sua conta', 'Your account')}</h2>
      <div className="form-grid">
        <label className="field">
          <span>{t('Nome', 'Name')}</span>
          <input
            key={current}
            className="input"
            defaultValue={current}
            placeholder={t('Como você quer ser chamado', 'What should we call you')}
            onBlur={async (e) => {
              const v = e.currentTarget.value.trim();
              if (v === current) return;
              const err = await updateName(v);
              toast(err ?? t('Nome salvo', 'Name saved'));
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </label>
        <label className="field">
          <span>Email</span>
          <input className="input" value={session?.user.email ?? ''} disabled />
        </label>
        <label className="field">
          <span>{t('Nova senha', 'New password')}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={t('Digite e aperte Enter para trocar', 'Type it and press Enter to change')}
            onKeyDown={async (e) => {
              if (e.key !== 'Enter') return;
              const el = e.currentTarget;
              if (el.value.length < 6) return toast(t('A senha precisa ter pelo menos 6 caracteres.', 'The password needs at least 6 characters.'));
              const err = await updatePassword(el.value);
              if (!err) el.value = '';
              toast(err ?? t('Senha alterada', 'Password changed'));
            }}
          />
          <span className="hint">{t('Também serve para criar uma senha se você entrou com o Google.', 'Also sets a password if you signed in with Google.')}</span>
        </label>
      </div>
    </div>
  );
}

function KeyField({
  label, kind, value, onSave, help,
}: { label: string; kind: 'finnhub' | 'brapi' | 'twelve'; value?: string; onSave: (v: string | undefined) => void; help: React.ReactNode }) {
  const [state, setState] = useState<{ status: 'idle' | 'testing' | 'ok' | 'bad'; detail?: string }>({ status: 'idle' });

  async function test(key: string) {
    setState({ status: 'testing' });
    const r = await checkKey(kind, key);
    setState({ status: r.ok ? 'ok' : 'bad', detail: r.detail });
  }

  // Check the saved key once when the page opens.
  useEffect(() => {
    if (value) void test(value);
    // Only on mount: re-testing on every render would spam the providers.
  }, []);

  function commit(el: HTMLInputElement) {
    const key = cleanKey(el.value);
    el.value = key;
    if (key === (value ?? '')) return;
    onSave(key || undefined);
    if (key) {
      toast(t('Chave salva', 'Key saved'));
      void test(key);
    } else setState({ status: 'idle' });
  }

  return (
    <label className="field">
      <span>{label}</span>
      <span className="key-input">
        <input
          className="input"
          type="password"
          defaultValue={value ?? ''}
          placeholder={t('cole aqui a chave', 'paste the key here')}
          autoComplete="off"
          spellCheck={false}
          onBlur={(e) => commit(e.currentTarget)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {state.status !== 'idle' && (
          <span className={'key-status ' + state.status} title={state.detail}>
            {state.status === 'testing' ? <span className="spinner" /> : state.status === 'ok' ? '✓' : '✗'}
          </span>
        )}
      </span>
      <span className="hint">{state.status === 'bad' ? <span className="neg">{state.detail}</span> : help}</span>
    </label>
  );
}
