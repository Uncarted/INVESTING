import { useState } from 'react';
import { actions, useData } from '../lib/store';
import { fetchRates } from '../lib/quotes';
import { checkKey, cleanKey } from '../lib/keys';
import { cloudEnabled } from '../lib/cloud';
import { useLive, type FeedStatus } from '../lib/live';
import { fmtDate, money, parseNumber } from '../lib/format';
import { toast } from '../components/ui';
import { Icon } from '../components/Icon';
import { exportBackup } from '../lib/exporters';
import { sampleData } from '../lib/sample';

export function Configuracoes() {
  const data = useData();
  const live = useLive();
  const cloud = cloudEnabled;
  const s = data.settings;
  const [loading, setLoading] = useState(false);

  const rateField = (label: string, key: 'cdiRate' | 'ipcaRate' | 'selicRate', hint: string) => (
    <label className="field">
      <span>{label}</span>
      <div className="row">
        <input
          key={s[key]}
          className="input num"
          defaultValue={String(s[key]).replace('.', ',')}
          onBlur={(e) => {
            const v = parseNumber(e.target.value);
            if (Number.isFinite(v)) actions.updateSettings({ [key]: v });
          }}
        />
        <span className="muted">% a.a.</span>
      </div>
      <span className="hint">{hint}</span>
    </label>
  );

  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="card card-pad stack">
        <div className="row">
          <h2 style={{ fontSize: 15, margin: 0 }}>Taxas para estimar a renda fixa</h2>
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
                toast('Taxas atualizadas pelo Banco Central');
              } else toast('Não foi possível acessar o Banco Central');
            }}
          >
            <Icon name="refresh" size={14} /> {loading ? 'Buscando…' : 'Buscar no Banco Central'}
          </button>
        </div>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
          {rateField('CDI', 'cdiRate', 'Para títulos % do CDI')}
          {rateField('Selic', 'selicRate', 'Para Tesouro Selic')}
          {rateField('IPCA (12 meses)', 'ipcaRate', 'Para títulos IPCA+')}
        </div>
        <p className="muted small" style={{ margin: 0 }}>O valor da renda fixa é uma estimativa bruta. Para precisão, informe o saldo do banco no detalhe de cada investimento.</p>
      </div>

      <div className="card card-pad stack">
        <div className="row">
          <h2 style={{ fontSize: 15, margin: 0 }}>Cotações ao vivo</h2>
          <div className="spacer" />
          <label className="row small text-2">
            <input type="checkbox" checked={s.livePrices} onChange={(e) => actions.updateSettings({ livePrices: e.target.checked })} /> Ligado
          </label>
        </div>
        <div className="feeds">
          <Feed name="Ações dos EUA e exterior" detail="Finnhub · tempo real" status={live.status.us} />
          <Feed name="B3 — ações, FIIs, ETFs, BDRs" detail="brapi · a cada minuto" status={live.status.b3} />
          <Feed name="Cripto" detail="Binance · tempo real, sem cadastro" status={live.status.crypto} />
          <Feed name="Dólar e euro" detail={`AwesomeAPI · US$ 1 = ${money(s.fx.USD, { always: true })} · € 1 = ${money(s.fx.EUR, { always: true })}`} status={live.status.fx} />
        </div>
        <KeyField
          label="Finnhub — ações dos EUA ao vivo (AMD, TTWO, AAPL…)"
          kind="finnhub"
          value={s.finnhubToken}
          onSave={(v) => actions.updateSettings({ finnhubToken: v })}
          help={<>Grátis em <a href="https://finnhub.io/register" target="_blank" rel="noreferrer">finnhub.io/register</a> → depois de entrar, a chave aparece em “API Key” no painel.</>}
        />
        <KeyField
          label="brapi — ações, FIIs e ETFs da B3"
          kind="brapi"
          value={s.brapiToken}
          onSave={(v) => actions.updateSettings({ brapiToken: v })}
          help={<>Grátis em <a href="https://brapi.dev/dashboard" target="_blank" rel="noreferrer">brapi.dev/dashboard</a> → copie o token do painel.</>}
        />
        <KeyField
          label="Twelve Data — preço de datas passadas (EUA) · opcional"
          kind="twelve"
          value={s.twelveDataToken}
          onSave={(v) => actions.updateSettings({ twelveDataToken: v })}
          help={<>Grátis em <a href="https://twelvedata.com/register" target="_blank" rel="noreferrer">twelvedata.com/register</a> → menu “API Keys”.</>}
        />
        <p className="muted small" style={{ margin: 0 }}>{cloud ? 'As chaves ficam salvas na sua conta — valem em qualquer computador.' : 'As chaves ficam salvas neste navegador.'}</p>
      </div>

      <div className="card card-pad stack">
        <h2 style={{ fontSize: 15, margin: 0 }}>Aparência</h2>
        <div className="seg">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} className={s.theme === t ? 'on' : ''} onClick={() => actions.updateSettings({ theme: t })}>
              {t === 'system' ? 'Automático' : t === 'light' ? 'Claro' : 'Escuro'}
            </button>
          ))}
        </div>
      </div>

      <div className="card card-pad stack">
        <h2 style={{ fontSize: 15, margin: 0 }}>Dados</h2>
        <p className="text-2" style={{ margin: 0 }}>
          {data.assets.length} ativos · {data.transactions.length} lançamentos · salvos apenas neste navegador.
          {s.lastBackupAt ? ` Último backup em ${fmtDate(s.lastBackupAt.slice(0, 10))}.` : ' Nenhum backup feito ainda.'}
        </p>
        <div className="row wrap">
          <button className="btn" onClick={() => { exportBackup(data); actions.updateSettings({ lastBackupAt: new Date().toISOString() }); }}>
            <Icon name="download" size={16} /> Salvar backup
          </button>
          {!data.assets.length && (
            <button className="btn" onClick={() => { actions.replaceAll({ ...sampleData(), settings: s }, 'Exemplo carregado'); toast('Dados de exemplo carregados', { undo: true }); }}>
              Carregar dados de exemplo
            </button>
          )}
          <div className="spacer" />
          <button
            className="btn danger"
            onClick={() => {
              if (!window.confirm('Apagar TODOS os ativos e lançamentos? (Dá para desfazer logo em seguida.)')) return;
              actions.replaceAll({ ...data, assets: [], transactions: [] }, 'Tudo apagado');
              toast('Dados apagados', { undo: true });
            }}
          >
            <Icon name="trash" size={16} /> Apagar tudo
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS: Record<FeedStatus, [string, string]> = {
  off: ['Desligado', 'var(--muted)'],
  ready: ['Pronto', 'var(--pos)'],
  connecting: ['Conectando…', 'var(--warn-ink)'],
  live: ['Ao vivo', 'var(--pos)'],
  polling: ['Atualizando', 'var(--pos)'],
  error: ['Sem conexão', 'var(--neg)'],
  'needs-key': ['Precisa de chave', 'var(--warn-ink)'],
};

function Feed({ name, detail, status }: { name: string; detail: string; status: FeedStatus }) {
  const [label, color] = STATUS[status];
  if (status === 'ready') detail += ' · liga sozinho quando você tiver ativos desse mercado';
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

function KeyField({
  label, kind, value, onSave, help,
}: { label: string; kind: 'finnhub' | 'brapi' | 'twelve'; value?: string; onSave: (v: string | undefined) => void; help: React.ReactNode }) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(!value);
  const [state, setState] = useState<{ status: 'idle' | 'testing' | 'ok' | 'bad'; detail?: string }>({ status: 'idle' });

  async function save() {
    const key = cleanKey(draft);
    if (!key) return setState({ status: 'bad', detail: 'Cole a chave primeiro.' });
    onSave(key);
    setEditing(false);
    setDraft('');
    setState({ status: 'testing' });
    const r = await checkKey(kind, key);
    setState({ status: r.ok ? 'ok' : 'bad', detail: r.detail });
    toast(r.ok ? 'Chave salva e funcionando' : 'Chave salva — mas o teste falhou');
  }
  async function test() {
    if (!value) return;
    setState({ status: 'testing' });
    const r = await checkKey(kind, value);
    setState({ status: r.ok ? 'ok' : 'bad', detail: r.detail });
  }

  return (
    <div className="field keyfield">
      <span>{label}</span>
      {editing ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="cole aqui a chave" autoComplete="off" spellCheck={false} />
          <button className="btn primary" type="submit">Salvar</button>
          {value && <button className="btn ghost" type="button" onClick={() => { setEditing(false); setDraft(''); }}>Cancelar</button>}
        </form>
      ) : (
        <div className="row key-saved">
          <span className="key-mask"><Icon name="check" size={14} /> Chave salva · ••••{value?.slice(-4)}</span>
          <div className="spacer" />
          <button className="btn sm" onClick={test} disabled={state.status === 'testing'}>{state.status === 'testing' ? 'Testando…' : 'Testar'}</button>
          <button className="btn sm ghost" onClick={() => { setEditing(true); setState({ status: 'idle' }); }}>Trocar</button>
          <button className="btn sm ghost danger" onClick={() => { onSave(undefined); setEditing(true); setState({ status: 'idle' }); }}>Remover</button>
        </div>
      )}
      {state.status === 'testing' && <span className="hint">Testando a chave…</span>}
      {state.status === 'ok' && <span className="hint" style={{ color: 'var(--pos)' }}>✓ {state.detail}</span>}
      {state.status === 'bad' && <span className="hint" style={{ color: 'var(--neg)' }}>✗ {state.detail}</span>}
      <span className="hint">{help}</span>
    </div>
  );
}
