# Carteira: investment tracker

A personal investment tracker built for Brazilian investors. It keeps stocks, FIIs, ETFs, BDRs, crypto, CDBs/LCIs/Tesouro and funds in one place. It works out your **preço médio** and **results**, and it gives you what you need for the **Imposto de Renda**.

Everything runs in your browser. There is no server and no account, and your data never leaves your computer.

## How to use

**Easiest way:** download `Carteira.html` and double-click it. That's the whole app in a single file.

> Your data is saved in the browser you open it with (localStorage). Use the same browser each time, and make a backup now and then (*Importar / Backup → Salvar backup*).

**For development:**

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # calculation engine tests
npm run release   # rebuilds Carteira.html
```

## Features

- **Visão geral**: total portfolio value, amount invested, result, dividends from the last 12 months, allocation by asset class and by bank/broker, and how much you've invested over time.
- **Carteira**: every position grouped by class, with quantity, preço médio, cost, current value, result and % of the portfolio. Click an asset to see its history, edit it, update its price or enter the bank balance.
- **Novo lançamento** (press `N` from anywhere): buys and sells, fixed-income deposits and redemptions, dividends/JCP/income, splits, reverse splits and bonus shares. The asset class is detected from the ticker. "Salvar e adicionar outro" lets you enter several in a row.
- **Imposto de Renda** for any year:
  - *Bens e Direitos*: group/code, a ready-to-copy description, and the position on 31/12 of the previous and current year (at cost).
  - *Apuração mensal*: the R$ 20k/month exemption for stocks, losses carried forward (stocks/ETFs/BDRs separate from FIIs), 15%/20% rates, 0.005% IRRF, and DARF 6015 with the R$ 10 minimum and due date. Crypto (R$ 35k exemption) and foreign assets (yearly) are shown separately.
  - *Rendimentos*: dividends (line 09), stock gains up to R$ 20k (line 20), FII income, and JCP (line 10).
  - Exports to Excel.
- **Importar**: the B3 Área do Investidor statements (*Negociação* and *Movimentação*), which cover every broker at once, plus a template spreadsheet. You review everything before it's saved, and rows you already imported are skipped.
- **Exportar**: positions and transactions to Excel or CSV, and a full JSON backup.
- **Prices**: one-click update through [brapi.dev](https://brapi.dev) (free token). Fixed income is estimated from CDI/Selic/IPCA, and those rates can be fetched from the Banco Central.
- Undo for deletes, light/dark mode, and a "hide values" button.

## Limitations

- The tax figures are support calculations. Day trades, options and special cases are not calculated. Check them against your brokers' reports.
- The fixed-income value is a gross estimate that uses the *current* rate for the whole period. For an exact number, enter the balance from your bank's app.
