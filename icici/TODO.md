# Pending tasks

## From today's session

1. **`login.sh` should be able to log into all 3 brokers.**
   `scripts/login.sh` already opens `/prism/login`, `/ant/login`, `/kite/login` in Firefox — all three routes are live in today's ported `server.ts`. Nothing new to write; the open item is verifying it actually works end-to-end against the new 4-process split (session files get written, `order`/`data` pick them up).

2. **Does login also call connect in case of ANT? If not, test connect from the frontend.**
   Confirmed by reading `server.ts`: `/ant/callback` only exchanges the auth code and writes `.ant_session.json` — it never triggers a reconnect. `data` auto-connects once at boot using whatever session already exists at that time, but won't pick up a *later* fresh login on its own. `/ant/connect` is what does that now (sends `data` a `reconnect` command over the frontend->data stdout/stdin pipe). Test it explicitly after a fresh `/ant/login`.

3. **GoodMorningStrategy should work.**
   Needs a live end-to-end trading-day test now that it goes through `OrderClient` -> `order` -> Zerodha (buy + GTT) instead of calling Zerodha directly.

   3a. **The time window should change if not traded, to the next 30 mins.**
   This already exists in code: `RETRY_MINUTES = 30` in `src/strategy/GoodMorningStrategy.ts` pushes both the snapshot and confirm times out by 30 minutes and retries if the trend check fails, capped at `MAX_CONFIRM_HOUR`/`MAX_CONFIRM_MINUTE` (14:45). Not touched during today's migration (only its order-execution call sites were rewired). Open item is live verification, not new logic.

4. **Changes to GoodMorningStrategy should not need a restart.**
   This is the core mechanism the whole 4-process split was built for (`src/orchestrator.ts`'s `watchAndRestart('strategies', ...)`) — already built and smoke-tested with a generic strategy edit, but not specifically confirmed with a `GoodMorningStrategy.ts` change end-to-end.

## Suggested additional tests (things today's build touched but never exercised live)

- A real (small-size) order placement through `manualBuy`/`buyIndex`, confirming a GTT is actually placed and its `trigger_id` captured on the trade.
- `/prism/settarget` modifying that GTT afterward (`setTargetStopLoss` + `KiteConnect.modifyGTT`) — built today, never exercised against a live GTT.
- `/positionstream` pushing a live update on an actual fill/close (only the initial snapshot push was tested today).
- `data`'s auto-reconnect-with-backoff — force a websocket drop, confirm it recovers without manual intervention.
- `/niftystream`/`/optionstream` tick delivery during real market hours (today's testing was after-hours with sparse ticks; the pipe itself was proven via `/candles`, but not these two streams directly).
- `userToken.txt`'s new path fix — run `npm run processes` from a non-repo-root `cwd`, confirm Prism-routed calls still find the token.
- GridFS document upload/download round trip.
- `/strategies?enable=` taking effect on the next tick, and `/strategies/:type/reset`.
- Kite OAuth login end-to-end, confirming `order`'s Zerodha singleton picks up a fresh token via `reloadSession` without a restart.
