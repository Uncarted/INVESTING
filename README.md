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

## Accounts and database (Supabase)

With Supabase configured, people sign in (email/password or Google) and each person gets their own portfolio, settings and API keys, stored in a Postgres database. Row Level Security means nobody can read anyone else's data. Without it, the app runs in local-only mode (data in the browser).

**Setup (about 10 minutes, free):**

1. Create a project at [supabase.com](https://supabase.com) (New project → choose a password and the São Paulo region).
2. Go to **SQL Editor → New query**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
3. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.
4. In this folder, copy `.env.example` to `.env.local` and paste both values:
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```
5. Build and put it online:
   ```bash
   npm install
   npm run build        # creates dist/
   ```
   Drag the `dist` folder onto [app.netlify.com/drop](https://app.netlify.com/drop) (or deploy with Vercel). You'll get a URL like `https://carteira-xyz.netlify.app`.
6. Back in Supabase, go to **Authentication → URL Configuration** and set **Site URL** to that address, so confirmation and password-reset emails link to your site.
7. Optional:
   - **Google login:** go to **Authentication → Providers → Google**, turn it on and paste a Google OAuth client ID/secret (the page links to the steps).
   - **Instant sign-up:** turn off **Confirm email** under **Authentication → Providers → Email** if you don't want people to confirm their email before first login.

The anon key is safe to ship in the site: it can only do what the database's Row Level Security allows, which is each user reading and writing their own row. The first time someone logs in on a computer that already has local data, that data is uploaded to their account.

## Features

The main screen shows what matters at a glance: total value, gain/loss, dividends, tax due, where your money is, and every holding. Everything else sits behind the menu (☰) and opens as a panel.


- **Home**: total value, result, amount invested over time, dividends (12 months), the next DARF due, profit from sales this year, an allocation bar (click a class to filter), and the holdings list. Click an asset to see its history, edit it, update its price or enter the bank balance.
- **Novo lançamento** (press `N` from anywhere): buys and sells, fixed-income deposits and redemptions, dividends/JCP/income, splits, reverse splits and bonus shares. "Salvar e adicionar outro" lets you enter several in a row.
  - Type a ticker or a company name ("take two", "petrobras", "bitcoin") and suggestions appear instantly from a built-in list of about 900 B3 stocks, FIIs, ETFs, US stocks and cryptos. Online search adds anything else.
  - Picking an asset fills in class, currency, broker and **today's price**. Changing the date fills in **that day's close** (and the dollar rate for foreign assets).
  - Type either the quantity or the amount to invest, and the other is calculated. Selling has a "vender tudo" (sell all) shortcut, and the form shows the new average price or the estimated result before you save.
- **Imposto de Renda** for any year:
  - *Bens e Direitos*: group/code, a ready-to-copy description, and the position on 31/12 of the previous and current year (at cost).
  - *Apuração mensal*: the R$ 20k/month exemption for stocks, losses carried forward (stocks/ETFs/BDRs separate from FIIs), 15%/20% rates, 0.005% IRRF, and DARF 6015 with the R$ 10 minimum and due date. Crypto (R$ 35k exemption) and foreign assets (yearly) are shown separately.
  - *Rendimentos*: dividends (line 09), stock gains up to R$ 20k (line 20), FII income, and JCP (line 10).
  - Exports to Excel.
- **Importar**: the B3 Área do Investidor statements (*Negociação* and *Movimentação*), which cover every broker at once, plus a template spreadsheet. You review everything before it's saved, and rows you already imported are skipped.
- **Exportar**: positions and transactions to Excel or CSV, and a full JSON backup.
- **Live prices**: US and other foreign stocks (AMD, TTWO…) in real time through [Finnhub](https://finnhub.io/register) (free key), which also lets you search any US stock by name; B3 through [brapi.dev](https://brapi.dev) (free token), refreshed every minute; crypto in real time through Binance (no key); dollar and euro rates through AwesomeAPI. Keys go in *Ajustes*.
- **Multiple currencies**: stocks priced in dollars or euros are entered in their own currency. The exchange rate on the trade date is filled in automatically, so cost and tax stay in reais. The home screen shows how much you hold in each currency.
- **Allocation donut**: animated, and viewable by class, currency, asset or institution. Click a slice to filter your holdings.
- Fixed income is estimated from CDI/Selic/IPCA, and those rates can be fetched from the Banco Central.
- Undo for deletes, light/dark mode, and a "hide values" button.

## Limitations

- The tax figures are support calculations. Day trades, options and special cases are not calculated. Check them against your brokers' reports.
- The fixed-income value is a gross estimate that uses the *current* rate for the whole period. For an exact number, enter the balance from your bank's app.
