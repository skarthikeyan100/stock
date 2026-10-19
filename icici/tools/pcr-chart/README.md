# PCR vs Nifty change (Sep 1–4)

Standalone React + d3 viewer for the stored option-chain backups. Not wired into the main app.

## Run

```bash
cd tools/pcr-chart
npm install
npm run data   # rebuilds public/data/*.json from /home/karthikeyan/work/data/backups
npm run dev    # or: npm run build && npm run preview
```

`npm run data` takes an optional backups directory and day folder names:
`node scripts/buildData.mjs <backupsDir> Sep-02 Sep-03`.

## What it shows

- **PCR (premium)**: per bucket, the last minute's PCR. Bars use the minute-level value of
  `sum(PE LTP) / sum(CE LTP)` over strikes within 300 points of the futures spot, where both legs have a
  price observed within the last 5 minutes.
- **Nifty Δ pts**: bucket close minus the previous bucket's close (the first bucket is measured from the day's open).
- Timeframes 1, 5, 10, 15, 20, 30 min are clock-aligned. 1 min is wide and scrolls horizontally;
  the y-axes stay pinned while you scroll. Hover to see the values for that bucket.

## Caveat: this is not OI PCR

The backups store no open interest. `OptionChain.csv` only holds contract metadata and the futures
spot, and `OptionQuote.csv` holds LTPs only, for the 08-SEP weekly expiry, with partial strike
coverage that varies by day. So the PCR here is a premium ratio, and levels are not directly comparable
across days.

## Data

`scripts/buildData.mjs` writes `public/data/<YYYY-MM-DD>.json` (one row per minute) and `public/data/index.json`
(per-day coverage summary). Re-run it if the backups change.
