import { useRef, useState } from 'react';
import { actions, getData, normalize } from '../lib/store';
import { buildPreview, downloadTemplate, FORMAT_LABEL, materialize, readSheet, type ImportPreview } from '../lib/importers';
import { exportBackup } from '../lib/exporters';
import { TX_LABEL } from '../lib/types';
import { fmtDate, money, qty } from '../lib/format';
import { ClassChip, toast } from '../components/ui';
import { Icon } from '../components/Icon';
import { t } from '../lib/i18n';
import { cloudEnabled } from '../lib/cloud';

export function Importar() {
  const [preview, setPreview] = useState<(ImportPreview & { file: string }) | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [over, setOver] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);

  async function handle(files: FileList | null) {
    setErr('');
    const file = files?.[0];
    if (!file) return;
    try {
      const rows = await readSheet(file);
      const p = buildPreview(rows, getData());
      if (p.format === 'desconhecido') {
        setErr(t('Não reconheci o formato. Use os extratos de Negociação ou Movimentação da B3, ou a planilha modelo.', "Unrecognized format. Use the B3 Negociação or Movimentação statements, or the template spreadsheet."));
        return;
      }
      setPreview({ ...p, file: file.name });
      setSel(new Set(p.rows.filter((r) => !r.duplicate).map((r) => r.key)));
    } catch (e) {
      setErr(t('Não foi possível ler o arquivo: ', "Couldn't read the file: ") + (e as Error).message);
    }
  }

  function confirm() {
    if (!preview) return;
    const chosen = preview.rows.filter((r) => sel.has(r.key));
    const { created, txs } = materialize(chosen, getData().assets);
    actions.addTransactions(txs, created);
    toast(t(`${txs.length} lançamento(s) importado(s)${created.length ? `, ${created.length} ativo(s) novo(s)` : ''}`, `${txs.length} transaction(s) imported${created.length ? `, ${created.length} new asset(s)` : ''}`), { undo: true });
    setPreview(null);
  }

  if (preview) {
    const dup = preview.rows.filter((r) => r.duplicate).length;
    const skipped = Object.entries(preview.skipped);
    return (
      <div className="stack">
        <div className="row wrap">
          <div>
            <h2 style={{ margin: 0, fontSize: 17 }}>{FORMAT_LABEL()[preview.format]}</h2>
            <div className="muted small">{preview.file} · {preview.rows.length} {t('linhas reconhecidas', 'rows recognized')}{dup ? ` · ${dup} ${t('já importadas (desmarcadas)', 'already imported (unchecked)')}` : ''}</div>
          </div>
          <div className="spacer" />
          <button className="btn" onClick={() => setPreview(null)}>{t('Cancelar', 'Cancel')}</button>
          <button className="btn primary" disabled={!sel.size} onClick={confirm}><Icon name="check" size={16} /> {t('Importar', 'Import')} {sel.size}</button>
        </div>
        {skipped.length > 0 && (
          <div className="notice info">
            <Icon name="info" />
            <span>{t('Ignorados', 'Skipped')}: {skipped.map(([k, v]) => `${k} (${v})`).join(', ')}.</span>
          </div>
        )}
        {preview.rows.some((r) => r.warning) && (
          <div className="notice"><Icon name="alert" /><span>{t('Algumas linhas precisam de atenção depois de importar (veja a coluna de avisos).', 'Some rows need attention after importing (see the notes column).')}</span></div>
        )}
        <div className="card">
          <div className="table-wrap" style={{ maxHeight: '65vh' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox" checked={sel.size === preview.rows.length} onChange={(e) => setSel(e.target.checked ? new Set(preview.rows.map((r) => r.key)) : new Set())} />
                  </th>
                  <th>{t('Data', 'Date')}</th><th>{t('Tipo', 'Type')}</th><th>{t('Ativo', 'Asset')}</th><th className="num">{t('Qtd.', 'Qty.')}</th><th className="num">{t('Preço / valor', 'Price / amount')}</th><th>{t('Instituição', 'Institution')}</th><th>{t('Aviso', 'Note')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.key} style={r.duplicate ? { opacity: 0.5 } : undefined}>
                    <td><input type="checkbox" checked={sel.has(r.key)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })} /></td>
                    <td className="text-2">{fmtDate(r.tx.date)}</td>
                    <td>{TX_LABEL[r.tx.type]}</td>
                    <td><div className="row"><span className="ticker">{r.ticker}</span><ClassChip cls={r.cls} /></div></td>
                    <td className="num">{r.tx.quantity !== 1 ? qty(r.tx.quantity) : ''}</td>
                    <td className="num">{money(r.tx.price, { always: true })}</td>
                    <td className="text-2">{r.tx.institution}</td>
                    <td className="small" style={{ color: 'var(--warn-ink)' }}>{r.duplicate ? t('já importado', 'already imported') : r.warning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div
        className={'dropzone card' + (over ? ' over' : '')}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); handle(e.dataTransfer.files); }}
      >
        <Icon name="upload" size={28} />
        <h3 style={{ margin: '8px 0 4px' }}>{t('Arraste um arquivo aqui ou clique para escolher', 'Drop a file here or click to choose')}</h3>
        <div className="muted">{t('Excel (.xlsx) ou CSV — extratos da B3 ou planilha modelo. Você revisa tudo antes de importar.', 'Excel (.xlsx) or CSV — B3 statements or the template. You review everything before importing.')}</div>
        <input ref={input} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { handle(e.target.files); e.target.value = ''; }} />
      </div>
      {err && <div className="notice"><Icon name="alert" /><span>{err}</span></div>}

      <div className="grid grid-2">
        <div className="card card-pad">
          <h2 style={{ fontSize: 15, marginTop: 0 }}>{t('Da B3 (todas as corretoras de uma vez)', 'From B3 (all brokers at once)')}</h2>
          <ol className="text-2" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.7 }}>
            <li>{t('Entre na', 'Log in to the')} <b>Área do Investidor</b> {t('da B3 (investidor.b3.com.br) com seu gov.br.', 'at B3 (investidor.b3.com.br) with your gov.br account.')}</li>
            <li>{t('Vá em', 'Go to')} <b>Extratos → Negociação</b>{t(', escolha o período e baixe em Excel. Isso traz suas compras e vendas de ações, FIIs, ETFs e BDRs.', ', pick the period and download as Excel. It has your buys and sells of stocks, REITs, ETFs and BDRs.')}</li>
            <li>{t('Em', 'In')} <b>Extratos → Movimentação</b>{t(', baixe também: traz dividendos, JCP, rendimentos, desdobramentos, bonificações e Tesouro Direto.', ', download that too: it has dividends, JCP, income, splits, bonus shares and Tesouro Direto.')}</li>
            <li>{t('Arraste os dois arquivos aqui (um de cada vez). Linhas já importadas são detectadas.', 'Drop both files here (one at a time). Rows already imported are detected.')}</li>
          </ol>
          <p className="muted small">{t('A B3 não informa corretagem nem taxas; se quiser que entrem no preço médio, edite o lançamento depois. CDBs, LCIs e fundos de banco não passam pela B3: adicione pelo formulário.', "B3 doesn't include brokerage fees; edit the transaction later if you want them in the average price. Bank CDBs, LCIs and funds don't go through B3: add them with the form.")}</p>
        </div>
        <div className="stack">
          <div className="card card-pad">
            <h2 style={{ fontSize: 15, marginTop: 0 }}>{t('Planilha modelo', 'Template spreadsheet')}</h2>
            <p className="text-2" style={{ marginTop: 0 }}>{t('Tem um histórico em planilha? Copie para o modelo (colunas data, tipo, ativo, classe, quantidade, preço, taxas, instituição) e importe.', 'Have your history in a spreadsheet? Copy it into the template (columns data, tipo, ativo, classe, quantidade, preco, taxas, instituicao) and import it.')}</p>
            <button className="btn" onClick={downloadTemplate}><Icon name="download" size={16} /> {t('Baixar modelo', 'Download template')}</button>
          </div>
          <div className="card card-pad">
            <h2 style={{ fontSize: 15, marginTop: 0 }}>{t('Backup completo', 'Full backup')}</h2>
            <p className="text-2" style={{ marginTop: 0 }}>{cloudEnabled ? t('Seus dados já ficam salvos na sua conta. O backup é uma cópia extra em arquivo.', 'Your data is already saved in your account. A backup is an extra copy as a file.') : t('Seus dados ficam só neste navegador. Faça backup de vez em quando — ou para levar para outro computador.', 'Your data lives only in this browser. Back it up now and then — or to move it to another computer.')}</p>
            <div className="row wrap">
              <button className="btn" onClick={() => { exportBackup(getData()); actions.updateSettings({ lastBackupAt: new Date().toISOString() }); }}><Icon name="download" size={16} /> {t('Salvar backup', 'Save backup')}</button>
              <button className="btn" onClick={() => backupInput.current?.click()}><Icon name="upload" size={16} /> {t('Restaurar backup', 'Restore backup')}</button>
              <input
                ref={backupInput}
                type="file"
                accept=".json"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  try {
                    const d = normalize(JSON.parse(await f.text()));
                    if (!window.confirm(t(`Substituir os dados atuais por ${d.assets.length} ativos e ${d.transactions.length} lançamentos do backup?`, `Replace your current data with ${d.assets.length} assets and ${d.transactions.length} transactions from the backup?`))) return;
                    actions.replaceAll(d, 'Backup restaurado');
                    toast(t('Backup restaurado', 'Backup restored'), { undo: true });
                  } catch {
                    toast(t('Arquivo de backup inválido', 'Invalid backup file'));
                  }
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
