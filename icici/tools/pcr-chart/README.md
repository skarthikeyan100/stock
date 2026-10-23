# PCR vs Nifty change

Standalone React + d3 viewer for the stored `Pcr` documents. Not wired into the main app.

## Run

```bash
cd tools/pcr-chart
npm install
npm run data   # rebuilds public/data/*.json from data/<YYYY-MM-DD>/{Pcr,Quote}.csv
npm run dev    # or: npm run build && npm run preview
```

`npm run data` takes an optional data directory and day folder names:
`node scripts/buildData.mjs <dataDir> 2026-10-23`.

## Adding a day

`stocks.Pcr` and `stocks.Quote` are exported to CSV and cleared after the close
(`backupAndClearStocks`, in the data project). Copy that day's `Pcr.csv` and `Quote.csv` from its
`backups/<Mon-DD>/csv/` folder into `data/<YYYY-MM-DD>/` here, then run `npm run data`.

## What it shows

- **PCR (OI)**: the stored Pcr document, total put OI / total call OI over the NIFTY contracts the data
  process subscribes to (about 12, near the money, so not the full-chain PCR). One document a minute,
  09:30–15:29; per bucket the last minute's value is shown.
- **Buildup bias**: from the Pcr document's per-contract `buildup` statuses. Contracts reading bullish for
  NIFTY (call long buildup / short covering, put short buildup / long unwinding) minus those reading bearish.
  Hover shows the CE/PE counts per status.
- **Nifty Δ pts**: bucket close minus the previous bucket's close (the first bucket is measured from the day's open),
  from the `Quote` ticks.
- Timeframes 1, 5, 10, 15, 20, 30 min are clock-aligned. 1 min is wide and scrolls horizontally;
  the y-axes stay pinned while you scroll. Hover to see the values for that bucket.

## Price-action analysis

`node scripts/analyze.mjs [dataDir] [day ...]` prints, per day and pooled: ATM straddle and implied vol,
IV/skew vs Nifty, OI walls, opening-range breaks, autocorrelation by hour, and hit rates of a few signals
over the next 5/15/30 min. It also uses `FutureQuote.csv` / `VixQuote.csv` (futures buildup, VWAP, basis,
VIX regime) when they are in the day folder; those parts are untested on real data. Needs `OptionQuote.csv`
(75 MB, gitignored) in `data/<day>/`. One day is indicative only.

## Data

`scripts/buildData.mjs` writes `public/data/<YYYY-MM-DD>.json` (one row per minute) and `public/data/index.json`
(per-day coverage summary). `public/` is gitignored; regenerate with `npm run data`.
