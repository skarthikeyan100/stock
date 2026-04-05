# Momentum Stock Scanner — Implementation Plan

## Overview

New `src/momentum/` folder under `icici/` with two scripts:
1. **Daily fetcher** — run manually each evening via `npm run momentum:fetch`
2. **Weekend ranker** — run via cron on Saturday morning via `npm run momentum:rank`

---

## Momentum Formula (Volume-Weighted Price Momentum)

With only ~5 trading days of data, we use a **Volume-Weighted Price Trend** score:

```
Price Trend  = (Friday LTP - Monday LTP) / Monday LTP × 100    (weekly return %)
Volume Ratio = Avg volume (last 2 days) / Avg volume (first 2 days)
Momentum     = Price Trend × Volume Ratio
```

**Why this works:**
- A stock up 3% on rising volume (ratio 1.5) scores **4.5**
- A stock up 3% on falling volume (ratio 0.7) scores **2.1**
- Rising volume confirms institutional interest / conviction behind the move
- Declining volume on a price rise suggests weak/unsustainable momentum

Top 3 from each index (NIFTY 50 + NIFTY NEXT 50) are picked.

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/momentum/nseClient.ts` | NSE API wrapper — session cookie management, retry logic |
| `src/momentum/fetchDaily.ts` | Fetches NIFTY 50 + NIFTY NEXT 50 data, stores in MongoDB |
| `src/momentum/weeklyMomentum.ts` | Reads week's data from MongoDB, computes scores, outputs top 3 per index |

---

## Step 1: `src/momentum/nseClient.ts`

- Create an axios instance with browser-like `User-Agent` and `Referer` headers
- `getSession()` — hits `https://www.nseindia.com` to capture `set-cookie` headers
- `getIndexStocks(indexName)` — calls `/api/equity-stockIndices?index=<encoded>` with session cookies
- Returns array of `{ symbol, ltp, open, high, low, previousClose, change, pChange, totalTradedVolume }`
- Retry on 403/timeout (NSE can be flaky), max 3 attempts with 2s delay

## Step 2: `src/momentum/fetchDaily.ts`

- Standalone entry point script
- Calls `nseClient.getIndexStocks('NIFTY 50')` and `nseClient.getIndexStocks('NIFTY NEXT 50')`
- Stores each stock in MongoDB collection `momentum_daily`:
  ```json
  {
    "date": "2026-02-17",
    "index": "NIFTY 50",
    "symbol": "RELIANCE",
    "ltp": 2450.50,
    "open": 2430.00,
    "high": 2465.00,
    "low": 2425.00,
    "previousClose": 2435.00,
    "pChange": 0.64,
    "volume": 12345678
  }
  ```
- Uses `replaceOne` with `{ date, symbol }` as upsert key (safe to re-run same day)
- Prints summary to console

## Step 3: `src/momentum/weeklyMomentum.ts`

- Standalone entry point script
- Queries `momentum_daily` for all records from current week (Monday–Friday)
- For each stock:
  - `priceTrend = (latestLTP - earliestLTP) / earliestLTP × 100`
  - `volumeRatio = avgVolume(last 2 days) / avgVolume(first 2 days)`
  - `momentumScore = priceTrend × volumeRatio`
- Sorts descending, picks top 3 per index
- Stores in `momentum_picks` collection
- Prints results as a formatted table to console
## Step 4: `package.json` scripts

Add to existing scripts:
```json
"momentum:fetch": "tsc && node ./dist/momentum/fetchDaily.js",
"momentum:rank": "tsc && node ./dist/momentum/weeklyMomentum.js"
```

## Step 5: Linux Crontab for Saturday

Add to system crontab (`crontab -e`):
```
0 9 * * 6 cd /home/karthikeyan/work/icici && npm run momentum:rank >> /home/karthikeyan/work/icici/momentum.log 2>&1
```

This runs every Saturday at 9:00 AM, logs output to `momentum.log`.

---

## MongoDB

- Reuse existing Mongo singleton (`src/tools/mongo.ts`, database: `stocks`)
- New collections: `momentum_daily`, `momentum_picks`
- Create unique index on `momentum_daily`: `{ date: 1, symbol: 1 }`

## Dependencies

None new — `axios`, `mongodb`, `moment`, and `cron` are already in package.json.
