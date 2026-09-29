import { useMemo } from 'react';
import { actions, useData } from '../lib/store';
import { sampleData } from '../lib/sample';
import { computePositions, investedSeries } from '../lib/portfolio';
import { CLASS_LABEL, INCOME_TYPES, type AssetClass } from '../lib/types';
import { money, percent, signedPercent, today } from '../lib/format';
import { Allocation, AreaChart, type Slice } from '../components/charts';
import { Delta, Empty } from '../components/ui';
import { Icon } from '../components/Icon';

export function Dashboard({ onAdd, go, openAsset }: { onAdd: () => void; go: (p: string) => void; openAsset: (id: string) => void }) {
  const data = useData();
  const t = today();
  const positions = useMemo(
    () => computePositions(data.assets, data.transactions, data.settings, t).filter((p) => !p.closed && (p.cost > 0.005 || p.value > 0.005)),
    [data, t],
  );
  const series = useMemo(
    () => investedSeries(data.assets, data.transactions, data.settings, t).map((d) => ({ month: d.month, value: d.cost })),
    [data, t],
  );

  const total = positions.reduce((s, p) => s + p.value, 0);
  const cost = positions.reduce((s, p) => s + p.cost, 0);
  const result = total - cost;
  const yearAgo = `${Number(t.slice(0, 4)) - 1}${t.slice(4)}`;
  const income12m = data.transactions
    .filter((x) => INCOME_TYPES.includes(x.type) && x.date > yearAgo && x.date <= t)
    .reduce((s, x) => s + x.quantity * x.price, 0);
  const estimates = positions.filter((p) => p.valueIsEstimate).length;

  const byClass = new Map<AssetClass, number>();
  const byInst = new Map<string, number>();
  for (const p of positions) {
    byClass.set(p.asset.cls, (byClass.get(p.asset.cls) ?? 0) + p.value);
    const inst = p.asset.institution || 'Sem instituição';
    byInst.set(inst, (byInst.get(inst) ?? 0) + p.value);
  }
  const classSlices: Slice[] = [...byClass].map(([k, v]) => ({ key: k, label: CLASS_LABEL[k], value: v, color: `var(--c-${k})` }));
  const instColors = ['var(--c-ACAO)', 'var(--c-FII)', 'var(--c-RENDA_FIXA)', 'var(--c-ETF)', 'var(--c-FUNDO)', 'var(--c-EXTERIOR)', 'var(--c-BDR)', 'var(--c-CRIPTO)'];
  const instSorted = [...byInst].sort((a, b) => b[1] - a[1]);
  const instSlices: Slice[] = instSorted.slice(0, 7).map(([k, v], i) => ({ key: k, label: k, value: v, color: instColors[i] }));
  if (instSorted.length > 7) {
    instSlices.push({ key: 'outros', label: 'Outras', value: instSorted.slice(7).reduce((s, x) => s + x[1], 0), color: 'var(--c-OUTRO)' });
  }

  const top = [...positions].sort((a, b) => b.value - a.value).slice(0, 8);

  if (!data.assets.length) {
    return (
      <div className="card">
        <Empty title="Sua carteira está vazia">
          <p style={{ margin: 0 }}>Comece adicionando uma compra, uma aplicação em renda fixa — ou importe seus extratos da B3.</p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
            <button className="btn primary" onClick={onAdd}><Icon name="plus" /> Novo lançamento</button>
            <button className="btn" onClick={() => go('importar')}><Icon name="upload" /> Importar da B3</button>
            <button className="btn ghost" onClick={() => actions.replaceAll({ ...sampleData(), settings: data.settings }, 'Exemplo carregado')}>Ver com dados de exemplo</button>
          </div>
        </Empty>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="grid grid-4">
        <div className="card card-pad kpi">
          <div className="label">Patrimônio</div>
          <div className="value">{money(total)}</div>
          <div className="sub muted">{positions.length} ativos</div>
        </div>
        <div className="card card-pad kpi">
          <div className="label">Valor aplicado</div>
          <div className="value">{money(cost)}</div>
          <div className="sub muted">custo pelo preço médio</div>
        </div>
        <div className="card card-pad kpi">
          <div className="label">Resultado</div>
          <div className="value"><Delta value={result}>{money(result)}</Delta></div>
          <div className="sub"><Delta value={result}>{signedPercent(cost ? result / cost : 0)}</Delta></div>
        </div>
        <div className="card card-pad kpi">
          <div className="label">Proventos (12 meses)</div>
          <div className="value">{money(income12m)}</div>
          <div className="sub muted">{total ? `${percent(income12m / total)} do patrimônio` : ''}</div>
        </div>
      </div>

      {estimates > 0 && (
        <div className="notice info">
          <Icon name="info" />
          <span>
            {estimates} ativo(s) sem cotação atual ou com valor estimado. Atualize as cotações na <a href="#/carteira">Carteira</a> ou informe o saldo da renda fixa para o patrimônio ficar exato.
          </span>
        </div>
      )}

      <div className="grid grid-3-2">
        <div className="card">
          <div className="card-head"><h2>Valor aplicado ao longo do tempo</h2></div>
          <div className="card-pad"><AreaChart data={series} /></div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Por classe</h2></div>
          <div className="card-pad"><Allocation slices={classSlices} onSelect={() => go('carteira')} /></div>
        </div>
      </div>

      <div className="grid grid-3-2">
        <div className="card">
          <div className="card-head">
            <h2>Maiores posições</h2>
            <div className="spacer" />
            <button className="btn sm ghost" onClick={() => go('carteira')}>Ver carteira →</button>
          </div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table">
              <thead>
                <tr><th>Ativo</th><th className="num">Valor</th><th className="num">Resultado</th><th className="num hide-sm">% carteira</th></tr>
              </thead>
              <tbody>
                {top.map((p) => (
                  <tr key={p.asset.id} className="clickable" onClick={() => openAsset(p.asset.id)}>
                    <td>
                      <div className="row"><span className="dot" style={{ background: `var(--c-${p.asset.cls})` }} /><span className="ticker">{p.asset.ticker}</span></div>
                    </td>
                    <td className="num">{money(p.value)}</td>
                    <td className="num"><Delta value={p.value - p.cost}>{signedPercent(p.cost ? (p.value - p.cost) / p.cost : 0)}</Delta></td>
                    <td className="num hide-sm">{percent(total ? p.value / total : 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Por instituição</h2></div>
          <div className="card-pad"><Allocation slices={instSlices} /></div>
        </div>
      </div>
    </div>
  );
}
