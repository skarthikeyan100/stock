# Run Mock Mode

Say **"run mock mode"** to have Claude execute these steps automatically.

## Steps

1. **Set mock flags** in [src/constants.ts](src/constants.ts):
   - `MOCK_BROKER = true`
   - `MOCK_QUOTES = true`
   - `MOCK_DATE` = latest date from `stocks.Quote` MongoDB collection
     - Query: `mongosh stocks --eval "db.Quote.find().sort({ltt:-1}).limit(1).forEach(d => print(d.date))"`

2. **Start the server** (background):
   ```
   cd /home/karthikeyan/work/icici
   npm run server > /tmp/server.log 2>&1  (run in background)
   ```
   Wait ~10s for TypeScript compilation and startup.

3. **Invoke `/connect`**:
   ```
   curl http://localhost:3000/connect
   ```
   This starts the mock WebSocket, loads Quote records for `MOCK_DATE`, and begins replaying NIFTY quotes.

4. **Wait for stream to exhaust**, then read logs and summarize:
   - Server startup / compilation errors
   - Strategies loaded (enabled/disabled)
   - Number of Quote records replayed
   - Any trades placed per strategy
   - Final backtest stats table (Trades / Wins / Losses / P&L)

5. **Kill the server**:
   ```
   pkill -f "node ./dist/server.js"
   ```
   Or if tsc-watch is still running:
   ```
   pkill -f "tsc-watch"
   ```

## Notes

- After mock run, remember to **reset** `MOCK_BROKER = false` and `MOCK_QUOTES = false` in [src/constants.ts](src/constants.ts) before live trading.
- The `MOCK_DATE` env var can override the hardcoded date: `MOCK_DATE=2026-03-02 npm run server`
- Mock option LTP = NIFTY LTP (not realistic option prices) — P&L figures will be inflated.
