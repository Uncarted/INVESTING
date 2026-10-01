// Builds dist/funds.json: Brazilian investment funds open to the public, from the CVM registry
// (dados.cvm.gov.br). Runs in CI before publishing; never fails the build.
import { writeFileSync, mkdirSync } from 'node:fs';

const URL = 'https://dados.cvm.gov.br/dados/FI/CAD/DADOS/cad_fi.csv';
const OUT = process.argv[2] ?? 'dist/funds.json';
const CLASS = { 'RENDA FIXA': 'R', MULTIMERCADO: 'M', 'AÇÕES': 'A', ACOES: 'A', CAMBIAL: 'C' };

export function parse(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(';').map((h) => h.trim().toUpperCase());
  const ix = (n) => head.indexOf(n);
  const [iName, iCnpj, iSit, iCls, iExcl, iTipo] = ['DENOM_SOCIAL', 'CNPJ_FUNDO', 'SIT', 'CLASSE', 'FUNDO_EXCLUSIVO', 'TP_FUNDO'].map(ix);
  const seen = new Set();
  const out = [];
  for (const line of lines.slice(1)) {
    const c = line.split(';');
    if (iSit >= 0 && !/FUNCIONAMENTO NORMAL/i.test(c[iSit] ?? '')) continue;
    if (iExcl >= 0 && (c[iExcl] ?? '').trim().toUpperCase() === 'S') continue;
    if (iTipo >= 0 && /FII|FIP|FIDC|FIAGRO/i.test(c[iTipo] ?? '')) continue;
    const cls = CLASS[(c[iCls] ?? '').trim().toUpperCase()];
    if (!cls) continue;
    const cnpj = (c[iCnpj] ?? '').trim();
    const name = (c[iName] ?? '').trim().replace(/\s+/g, ' ');
    if (!cnpj || !name || seen.has(cnpj)) continue;
    seen.add(cnpj);
    out.push([name, cnpj, cls]);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let rows = [];
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = new TextDecoder('latin1').decode(await res.arrayBuffer());
    rows = parse(text);
    console.log(`funds.json: ${rows.length} funds`);
  } catch (e) {
    console.warn('funds.json: could not download the CVM registry —', e.message);
  }
  mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(OUT, JSON.stringify(rows));
}
