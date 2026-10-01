// Builds dist/funds.json: Brazilian investment funds open to the public, from the CVM registry
// (dados.cvm.gov.br). Reads both the new registry (Resolução CVM 175: registro_fundo_classe.zip)
// and the legacy cad_fi.csv. Runs in CI before publishing; never fails the build.
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = 'https://dados.cvm.gov.br/dados/FI/CAD/DADOS/';
const OUT = process.argv[2] ?? 'dist/funds.json';
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
const CLASS = { 'RENDA FIXA': 'R', MULTIMERCADO: 'M', ACOES: 'A', CAMBIAL: 'C' };

/** Parses one CVM CSV (';'-separated, latin1) into [name, cnpj, class] rows. */
export function parse(text, log = () => {}) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(';').map((h) => fold(h).replace(/"/g, ''));
  log('columns: ' + head.join(', '));
  const find = (...names) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iName = find('DENOMINACAO_SOCIAL', 'DENOM_SOCIAL');
  const iCnpj = find('CNPJ_CLASSE', 'CNPJ_FUNDO', 'CNPJ');
  const iSit = find('SITUACAO', 'SIT');
  const iCls = find('CLASSIFICACAO', 'CLASSE');
  const iExcl = find('EXCLUSIVO', 'FUNDO_EXCLUSIVO');
  const iTipo = find('TIPO_CLASSE', 'TP_FUNDO', 'TIPO_FUNDO');
  if (iName < 0 || iCnpj < 0) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const c = line.split(';').map((x) => x.replace(/^"|"$/g, ''));
    if (iSit >= 0 && !/FUNCIONAMENTO NORMAL/.test(fold(c[iSit]))) continue;
    if (iExcl >= 0 && fold(c[iExcl]).startsWith('S')) continue;
    if (iTipo >= 0 && /FII|FIP|FIDC|FIAGRO|IMOBILIARIO|DIREITOS CREDITORIOS|PARTICIPACOES/.test(fold(c[iTipo]))) continue;
    const clsText = fold(c[iCls]);
    const cls = CLASS[clsText] ?? Object.entries(CLASS).find(([k]) => clsText.includes(k))?.[1];
    if (!cls) continue;
    const cnpj = (c[iCnpj] ?? '').trim();
    const name = (c[iName] ?? '').trim().replace(/\s+/g, ' ');
    if (cnpj && name) out.push([name, cnpj, cls]);
  }
  return out;
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
const latin1 = (buf) => new TextDecoder('latin1').decode(buf);

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [];
  const log = (m) => console.log('funds:', m);
  try {
    const zip = await get(BASE + 'registro_fundo_classe.zip');
    const dir = '/tmp/cvm-registro';
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + '/r.zip', zip);
    execSync(`unzip -o -q ${dir}/r.zip -d ${dir}`);
    for (const f of readdirSync(dir).filter((f) => /classe/i.test(f) && !/subclasse/i.test(f) && f.endsWith('.csv'))) {
      const r = parse(latin1(readFileSync(`${dir}/${f}`)), log);
      log(`${f}: ${r.length}`);
      rows.push(...r);
    }
  } catch (e) {
    log('registro_fundo_classe failed — ' + e.message);
  }
  try {
    const r = parse(latin1(await get(BASE + 'cad_fi.csv')), log);
    log(`cad_fi.csv: ${r.length}`);
    rows.push(...r);
  } catch (e) {
    log('cad_fi failed — ' + e.message);
  }
  const seen = new Set();
  const uniq = rows.filter(([, cnpj]) => (seen.has(cnpj) ? false : (seen.add(cnpj), true)));
  log(`total ${uniq.length}`);
  mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(OUT, JSON.stringify(uniq));
  if (!existsSync(OUT)) process.exit(0);
}
