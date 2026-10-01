import { useRef, useState } from 'react';
import { actions, getData, normalize } from '../lib/store';
import { bankName, buildGenericPreview, buildPdfPreview, buildPreview, readPdfLines, downloadTemplate, FORMAT_LABEL, materialize, parseOfx, readSheet, type ImportPreview } from '../lib/importers';
import { exportBackup } from '../lib/exporters';
import { TX_LABEL, isMarketClass } from '../lib/types';
import { fmtCurrency, fmtDate, qty } from '../lib/format';
import { ClassChip, toast } from '../components/ui';
import { Icon } from '../components/Icon';
import { t } from '../lib/i18n';
import { cloudEnabled } from '../lib/cloud';
import { fxOnDate } from '../lib/live';

/** "NU_2025.csv" → Nubank, "Extrato Inter.ofx" → Inter. */
const guessBank = (file: string) => {
  const b = bankName(file.replace(/\.[a-z]+$/i, '').replace(/[_-]/g, ' '));
  return b === file.replace(/\.[a-z]+$/i, '').replace(/[_-]/g, ' ') ? undefined : b;
};

export function Importar() {
  const [preview, setPreview] = useState<(ImportPreview & { file: string }) | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [over, setOver] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);

  async function handle(files: FileList | null) {
    setErr('');
    const file = files?.[0];
    if (!file) return;
    try {
      let p: ImportPreview;
      if (/\.pdf$/i.test(file.name)) {
        setBusy(t('Lendo o PDF…', 'Reading the PDF…'));
        p = buildPdfPreview(await readPdfLines(file).finally(() => setBusy('')), getData());
      } else if (/\.ofx$/i.test(file.name)) {
        const { rows, bank } = parseOfx(await file.text());
        p = buildPreview(rows, getData(), { bank: bank ?? guessBank(file.name) });
      } else {
        const rows = await readSheet(file);
        p = buildPreview(rows, getData(), { bank: guessBank(file.name) });
        // Unknown layout: look for trade lines anywhere in the sheet.
        if (p.format === 'desconhecido' && rows.length) {
          const lines = [Object.keys(rows[0]).join(' | '), ...rows.map((r) => Object.values(r).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ''))).join(' | '))];
          p = buildGenericPreview(lines, getData());
        }
      }
      if (p.format === 'desconhecido') {
        setErr(t('Não encontrei negociações nem posições nesse arquivo. Funciona com: extratos da B3, notas/confirmações de compra e venda, extratos mensais e de custódia (PDF), extratos do banco (CSV/OFX) e a planilha modelo. Se for outro formato, me mande o arquivo que eu ensino o Wallet a ler.', "Couldn't find trades or holdings in this file. Works with: B3 statements, trade confirmations, monthly and custody statements (PDF), bank statements (CSV/OFX) and the template. If it's another format, send it over and I'll teach Wallet to read it."));
        return;
      }
      setPreview({ ...p, file: file.name });
      setSel(new Set(p.rows.filter((r) => !r.duplicate).map((r) => r.key)));
    } catch (e) {
      setErr(t('Não foi possível ler o arquivo: ', "Couldn't read the file: ") + (e as Error).message);
    }
  }

  async function confirm() {
    if (!preview || busy) return;
    const chosen = preview.rows.filter((r) => sel.has(r.key));
    // Dollar trades: store the PTAX-like rate of each trade date (needed for cost in reais and IR).
    const usd = chosen.filter((r) => (r.cls === 'EXTERIOR' || r.cls === 'CAIXA') && r.tx.fxRate === undefined);
    const dates = [...new Set(usd.map((r) => r.tx.date))];
    if (dates.length) {
      const rates = new Map<string, number>();
      for (let i = 0; i < dates.length; i++) {
        setBusy(t(`Buscando dólar do dia… ${i + 1}/${dates.length}`, `Fetching dollar rates… ${i + 1}/${dates.length}`));
        const v = await fxOnDate('USD', dates[i]);
        if (v) rates.set(dates[i], v);
      }
      setBusy('');
      for (const r of usd) {
        const v = rates.get(r.tx.date) ?? getData().settings.fx?.USD;
        if (v) r.tx = { ...r.tx, fxRate: v };
      }
    }
    const { created, txs, balances } = materialize(chosen, getData().assets);
    if (txs.length || created.length) actions.addTransactions(txs, created);
    // Custody statements: the balance on the statement date becomes the investment's current value.
    for (const b of balances) actions.updateAsset(b.assetId, { manualValue: b.value, manualValueDate: b.date });
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
          <button className="btn primary" disabled={!sel.size || !!busy} onClick={confirm}>{busy ? <><span className="spinner" /> {busy}</> : <><Icon name="check" size={16} /> {t('Importar', 'Import')} {sel.size}</>}</button>
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
                    <td>{r.balanceOnly ? t('Atualiza saldo', 'Balance update') : r.cls === 'CAIXA' ? (r.tx.type === 'BUY' ? t('Entrada', 'Deposit') : t('Saída', 'Withdrawal')) : isMarketClass(r.cls) ? TX_LABEL[r.tx.type] : r.tx.type === 'BUY' ? t('Aplicação', 'Deposit') : t('Resgate', 'Redemption')}</td>
                    <td><div className="row"><span className="ticker">{r.ticker}</span><ClassChip cls={r.cls} /></div></td>
                    <td className="num">{r.cls !== 'CAIXA' && isMarketClass(r.cls) && (r.tx.quantity !== 1 || r.tx.type === 'BUY' || r.tx.type === 'SELL') ? qty(r.tx.quantity) : ''}</td>
                    <td className="num">{r.cls === 'CAIXA' ? fmtCurrency(r.tx.quantity, 'USD', { always: true }) : fmtCurrency(r.tx.price, r.cls === 'EXTERIOR' ? 'USD' : 'BRL', { always: true })}</td>
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
        <div className="muted">{t('Excel, CSV, OFX ou PDF — B3, extratos do banco, Nomad/Avenue ou planilha modelo. Você revisa tudo antes de importar.', 'Excel, CSV, OFX or PDF — B3, bank statements, Nomad/Avenue or the template. You review everything before importing.')}</div>
        <input ref={input} type="file" accept=".xlsx,.xls,.csv,.ofx,.pdf" hidden onChange={(e) => { handle(e.target.files); e.target.value = ''; }} />
      </div>
      {err && <div className="notice"><Icon name="alert" /><span>{err}</span></div>}
      {busy && <div className="notice info"><span className="spinner" /><span>{busy}</span></div>}

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
            <h2 style={{ fontSize: 15, marginTop: 0 }}>{t('Caixinhas e aplicações do banco', 'Bank savings boxes and deposits')}</h2>
            <p className="text-2" style={{ marginTop: 0 }}>{t('Caixinhas, RDBs e CDBs do banco não aparecem na B3. Mais fácil: o Extrato de Custódia em PDF (Nubank: Investimentos → Extratos → Custódia) — cada caixinha e CDB entra com o saldo certo, e importar um mais novo só atualiza os saldos. Também aceitamos o extrato da conta (CSV ou OFX).', "Bank savings boxes, RDBs and CDBs don't show up at B3. Easiest: the custody statement PDF (Nubank: Investments → Statements → Custody) — every savings box and CDB comes in with the right balance, and importing a newer one just updates the balances. Account statements (CSV or OFX) work too.")}</p>
          </div>
          <div className="card card-pad">
            <h2 style={{ fontSize: 15, marginTop: 0 }}>{t('Corretora dos EUA (Nomad, Avenue…)', 'US broker (Nomad, Avenue…)')}</h2>
            <p className="text-2" style={{ marginTop: 0 }}>{t('A B3 não vê o que você tem lá fora. Na Nomad, baixe o extrato mensal da conta de investimentos (PDF) — entram suas ações, compras, vendas e dividendos — e o extrato da conta em dólar (PDF), que vira seu saldo em dólar. Também aceitamos CSV/Excel de outras corretoras.', "B3 can't see what you hold abroad. In Nomad, download the investment account's monthly statement (PDF) — your stocks, buys, sells and dividends come in — and the dollar account statement (PDF), which becomes your dollar balance. CSV/Excel from other brokers works too.")}</p>
          </div>
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
