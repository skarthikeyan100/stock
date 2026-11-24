# Process Architecture

Kept out of `CLAUDE.md` on purpose (that file is loaded on every prompt). Read this when touching `src/orchestrator.ts`, `src/processes/*`, or when proposing to merge/split processes.

## Overview

`npm run processes` runs `tsc -w` and `dist/orchestrator.js` side by side (`package.json`). The orchestrator spawns four sibling processes, wires their stdio, and restarts **only the child whose compiled output changed**. The orchestrator itself is never restarted by `tsc -w`, so a save never tears down every child at once. That is the point of the split. Logs go to `logs/orchestrator-YYYY-MM-DD.log` (per day, append-only across restarts; `orchestrator.log` is a symlink to today's file) via `scripts/orchestrator-log.sh`.

## Crash respawner give-up policy

(`src/orchestratorPolicy.ts`, decided by the user 2026-11-24.) The orchestrator respawns a crashed child, but gives up on it after repeated quick crashes or failed spawns: **10** for the other roles (`data`, `frontend`), **2** for `trading`. `trading` is deliberately strict so it does not retry continuously while it keeps being rejected or crashing. This means two early failures in a row (for example Mongo or a broker unreachable at startup) leave `trading` down for the day: no strategies or orders run until a code change (which resets the counters) or an orchestrator restart. An ALERT line is logged to the orchestrator log when it gives up. Raise `MAX_QUICK_CRASHES_TRADING` if a longer retry window is wanted.

## Broker naming

Exactly four real brokers are supported, plus the internal `paper` broker (2026-11-17: in-memory fills for strategies only, nothing in Mongo, no login; `src/processes/order/paperExecutor.ts`, see `docs/guides/strategies.md`). Use only the canonical name in code, config, Mongo, API, UI and docs.

| Use | Never use |
|---|---|
| `ant` | AliceBlue, Alice Blue |
| `kite` | Zerodha |
| `breeze` | ICICI, ICICI Direct (as a broker name) |
| `prism` | Shoonya |
| `paper` | (none: not a real broker) |

Legacy names are accepted on read only, through `normalizeBrokerName()` in `src/util/brokerName.ts`
(config lists, user settings, IPC and API parameters). Writers always emit the canonical name.
`config.yml` may still say `zerodha`; it is normalised on load. One-off Mongo migration:
`node scripts/migrate-broker-names.js` (idempotent, `--dry-run` supported). External names that keep
the vendor spelling: the `kiteconnect` package and its fields, `api.kite.trade`, `zerodha.com` URLs.

## Processes

Three processes since 2026-10-29 (review decision 2 merged `order` and `strategies`; decisions 3 and 4 keep `frontend` and `data` apart).

| Process | Entry | Owns |
|---|---|---|
| `data` | `src/processes/dataProcess.ts` | Broker tick WebSockets (ANT via `AntDataStream`, Breeze via `BreezeDataStream`). Serves ticks, and takes subscribe / unsubscribe / reconnect commands, on `DATA_IPC_SOCKET` (default `/tmp/icici-data.sock`, `DataServer`). **Never restarted automatically** (decision 5): a crash raises an alert and an operator restarts the run outside market hours. |
| `trading` | `src/processes/tradingProcess.ts` | `order` + `strategies` in one process. Order side (`orderProcess.ts`): the only code that places, cancels and exits broker orders (ANT, Kite, Breeze, Prism executors in `processes/order/`), per-user bookkeeping and P&L, chunked orders, pending limit orders, order-notify streams, `exitMonitor.ts`. Strategy side (`strategiesProcess.ts`): strategy logic (`src/strategy/`), tick routing (`tokenRouter`), candle / stats builders. Strategies call the order side in-process (`OrderClient.useLocalServer`); it still serves `ORDER_IPC_SOCKET` and `STRATEGIES_IPC_SOCKET` for `frontend`. On start it restores open positions from Mongo alone (no broker read, no login) and then every strategy's state (`startupReconcile`, `Strategy.stateLoaded`); a reconcile never places an order (`OrderClient.withNoOrders`). Mongo is kept equal to the brokers by the end-of-day sync (15:45, `settings.eodReconcileTime`) and `npm run sync`. |
| `frontend` | `src/server.ts` (`dist/server.js`) | Express REST + SSE API, auth, OAuth callbacks, config endpoints, serves the static React bundle from `public/`. Relays to `trading` over its two sockets and takes ticks from `data`. |

`orderProcess.ts` and `strategiesProcess.ts` still start standalone (`node dist/processes/orderProcess.js`) for debugging the old two-process topology; the orchestrator does not use that.

## Wiring

```
   data  ── DATA_IPC_SOCKET ──►  trading   (ticks in; subscribe / unsubscribe out, via ipc/DataLink)
                          └───►  frontend  (ticks in; reconnect out)

   frontend ──► trading   ORDER_IPC_SOCKET, STRATEGIES_IPC_SOCKET
```

Subscriptions are reference-counted twice: per owner inside a process (`DataLink`: the strategy router and the exit monitor) and per client inside `data` (`DataServer`: a token stays subscribed while any client holds it, and a client's holds are released when its connection closes). A client replays what it holds whenever it (re)connects, so a restarted `data` needs no resync step. Protocol helpers live in `src/ipc/` (`jsonLines.ts`, `orderProtocol.ts`, `strategiesProtocol.ts`, `dataProtocol.ts`, `DataLink.ts`, `feedSource.ts`).

## Why they are separate

- **`data` apart from `trading`.** `data` holds the tick WebSockets (including the ANT `createWsSess` session setup). A `trading` restart, which is routine in dev, never drops the feed, and a feed crash never takes order execution with it.
- **`frontend` apart from `trading`.** It holds the Express API, OAuth callbacks, payouts, KYC and OCR, the most change-prone code. A UI or payout bug, or a restart of it, cannot stop trading.
- **Orders and strategies together.** One startup sequence (preflight, restore from Mongo, then ticks) and plain in-process calls instead of an IPC hop. The old reason for the split, "a strategy restart must not orphan an in-flight order", is now covered by the startup restore (open positions rebuilt from Mongo, then each strategy's no-order `reconcile()`) rather than by a process boundary, so restarting `trading` with open positions still needs care.
- **Network quirks are scoped per process.** Kite and ANT allow only IPv4 for order placement; Breeze's registered static IP is the IPv6 address. Forcing IPv4 process-wide broke Breeze (tried 2026-09-25), so `installIpv4OnlyHostOverride()` (`processes/order/kiteDns.ts`) is applied only in `trading` and `data`, only for specific hostnames.

## Restart matrix

Each child watches its own entry/dir plus shared dirs under `dist/` (`HOT_RESTART=false` disables all of this). Debounce 300 ms. `data` is not watched at all.

| Child restarts when these change | Effect of the restart |
|---|---|
| `trading`: `processes/order`, `orderProcess.js`, `strategy`, `processes/strategies`, `strategiesProcess.js`, `tradingProcess.js`, `ant`, `kite`, `breeze`, `model`, `util`, `prism`, `tools`, `ipc`, `lib` | Order-notify streams, exit monitor and all strategy state restart; the startup reconcile rebuilds legs from the brokers' open positions. Per-user `sessionPnL` resets to 0 (not resynced from Mongo, see `docs/archive/analysis/Analysis.md`). **Avoid with open positions.** |
| `frontend`: `server.js`, `ant`, `kite`, `breeze`, `model`, `util`, `prism`, `tools`, `ipc`, `middleware`, `lib` | API and SSE clients reconnect. Broker connections untouched. |

Shared dirs (`ant`, `model`, `util`, `prism`, `tools`, `ipc`) restart `trading` and `frontend` together. Edit them with that in mind.

## Gotchas

- **stdout/stderr are plain logs** in every process now (the stdout tick pipes and the `console.log = console.error` redirects are gone). Ticks and feed commands only travel over the sockets above.
- **Frontend has two meanings.** The React app (`frontend/src/`) builds into `public/` with `cd frontend && npm run build` and needs no process restart. The `frontend` *process* is `server.ts`; backend edits there do need a restart.
- `npm run server` starts only the frontend-equivalent process. It cannot exercise orders or streaming.

## Decision record: merging into fewer processes (2026-10-25, superseded 2026-10-29)

Superseded: on 2026-10-29 the user decided `order` and `strategies` merge into `trading`, `frontend` and `data` stay separate. The 2026-10-25 record follows for the reasoning behind keeping those two apart.


Proposal: two processes, `strategies` and "others". Rejected as stated, because `frontend` would share a process with `data` and `order`, so every `server.ts` / route edit would drop the broker WebSockets and order monitors.

| Option | Verdict |
|---|---|
| Keep four processes | **Recommended.** IPC code already exists and works. |
| Three: `strategies`, `frontend`, `core` (data + order) | Possible. Removes the data-to-order subscribe hop, but ties tick-feed restarts to order-code edits and needs the IPv4/Breeze IP handling re-checked. |
| Two: `strategies` + everything else | Only viable if `server.ts` is rarely edited during market hours, or its hot-restart is turned off. |

Revisit if the IPC layer becomes a real maintenance or latency problem.


## Research portal (2026-11-16)

Where the portal's code runs, so a restart or a hot-restart is predictable:

| Piece | Process | Notes |
|---|---|---|
| Invites, acceptance, `/owner/*`, `/contractor/*`, `/recommendations`, `/forecast`, statements, the contractor guard | `frontend` (`server.ts`) | Editing these restarts `frontend` only. The guard (`src/contractors/guard.ts`) is an `app.use` before every route and acts only on `role: 'contractor'`. |
| Forecast engine (`src/forecast/engine.ts`): latest NIFTY, 1-minute candles, the 1-per-second tick store, the future's depth, both filters, scoring every 30 s | `frontend` | It reads the same ticks as the SSE streams (`DataLink.onTick`) and asks `data` for the NIFTY future's depth feed (`subscribeDepth`). Not in `trading`, so a trading restart does not lose it; a `frontend` restart rebuilds the candles from the stored ticks. |
| Orders | `trading` (order process, the same `manualBuy` as Search & Buy) | No strategy block is involved (the per-contractor `Recommendation-S..`/`Forecast-S..` slot pool was removed 2026-11-16). An approved recommendation, or a Beginner forecast that passed both filters, is placed as a normal user order under the contractor's own user id (their email): `src/contractors/order.ts` -> `manualBuy` a recommendation rests as a limit buy at the recommended price with its target/stop attached on the fill (`order/entryExits.ts`), a forecast buys at once; sized from `forecast.orders.maxInvestment` (`bookkeeping.resolveContractorQuantity`); the admin mirrors contractors like any user. |
| `data` | additive only | `AntDataStream.onFutTick` also carries `tbq`/`tsq` on the `fut` tick when the depth feed is subscribed. Nothing else reads them. |

Data flow of a Beginner forecast: `POST /forecast` -> record (write-once) -> both filters -> `decisions` row -> (only if `forecast.orders.enabled`) arm the slot block -> `RecommendationStrategy` places the order. Nothing in the response tells the contractor whether or how it was used. An Advanced recommendation waits as PENDING until the owner approves it on `/console` (persistent pop-up), which arms the slot the same way.

## Adding a strategy: registration, candles, contracts (2026-11-16)

**How a strategy gets registered** (all of these, for a new type `FooStrategy`):
- `src/strategy/StrategyFactory.ts`: `STRATEGY_REGISTRY.set('FooStrategy', FooStrategy)` (type name -> class; the constructor takes the `userId`). `createStrategy` sets `enabled` from the block.
- `src/util/strategyInstances.ts`: a type in `MULTI_BROKER_TYPES` is ONE instance that fans out over `brokers:` itself (per-broker legs inside its state); any other type is expanded in
  memory into `<id>`, `<id>-ANT`, `<id>-Breeze` instances. The LimitEntry family (Recommendation, NiftyChange, MomentumAtFixedTime, NextWeek, Breakout, GammaBurst) is multi-broker, one cycle across all brokers.
- `src/prism/configValidation.ts`: per-type required keys (`requiredByType`, the global target/stop list, the fixed-`quantity` NIFTY-lot check). Only enabled blocks are validated.
- `config.yml`: a block with `type`, `enabled`, `userId`, `brokers: [...]`. Blocks are never deleted, only disabled. Global keys under `settings` apply unless the block sets its own.
- `enabled` is the one switch and is enforced centrally (`strategiesProcess.ts` / `tokenRouter.ts`): a disabled strategy gets no ticks, fills or cancellations. A new strategy gets it for free.
- Ticks: `strategiesProcess.onTick` calls `processNiftyQuote` (and `receive` with the shared 300 s stats). Option ticks reach a strategy through `tokenRouter`: it must hold the token
  (`registerTrade`, or `watchTokenOnSource('ant', token, this, exchange)` for a contract it only watches) and `canHandleOptionQuote` must accept the quote before `processOptionQuote` runs.
- `reconcile()` (startup and `POST /reconcile`) runs inside `OrderClient.withNoOrders`: it rebuilds state and never places, cancels or modifies an order. Exits and entries start from ticks and
  housekeeping. Class chain: `Strategy` -> `LimitEntryStrategy` (legs, persisted state, fills, entry timeout, EOD close) -> `CandleEntryStrategy` (fixed quantity, target/stop) -> the strategy.
- The global `settings.maxProfit` needs no per-strategy code: `processes/strategies/globalMaxProfit.ts` judges every strategy that has no profit stop of its own and latches in Mongo; the
  order process then refuses its buys. A block-level `maxProfit` is not read for those strategies.

**Is there a candle builder?** Yes, for NIFTY index ticks: `src/processes/strategies/niftyStatsBuilder.ts`, `createStatsBuilder(bucketSeconds, { aligned: true })`, built on `lib/candle-builder.ts`.
`record(ltp, ltt)` returns `{ oldStats, newStats }` only when a candle CLOSES (`newStats` = the closed candle with `open/high/low/close/candleTime`; the tick that closes it belongs to the next
candle). `closes()` returns closes only, so a strategy that needs OHLC keeps its own array (see `NextWeekStrategy.liveToday`); `seed(candles)` preloads history (Yahoo `^NSEI` via
`lib/yahooCandles.ts`, cached in Mongo, today's own candles in `candles15Live`). `strategiesProcess` keeps one shared 300 s builder and hands its closes to `receive()`; the LimitEntry family does not
use it and builds its own (`NextWeek`/`Breakout`: 900 s, aligned to 09:15; `GammaBurst`: 120 s on the 09:15 grid via `originSeconds`, its own Mongo `candles2Live`). `decision.ts` is NOT a live candle source (only `/replay` instantiates it). There is no candle builder for option prices:

**How an option contract is selected:** the strategy picks a strike and side, `OrderClient.resolveOptionContract(userId, { broker, index, strike, right, skipNearestExpiryDay, expiryOffset })`
returns `{ tsym, token, exchange }` for that broker (nearest expiry; `expiryOffset: 1` = the next one). The LimitEntry strategies use `atmStrike(ltp) = round(ltp / 50) * 50` of the last NIFTY tick,
via `LimitEntryStrategy.startCycle`, which resolves the contract per broker, takes the entry price from `getOptionLtp` (a LIMIT buy at the prevailing LTP), sizes it (`quantity` for the Candle family,
a rupee budget for the others), splits it at the freeze quantity and persists the leg BEFORE the order goes out. The expiry-day skip (`skipNearestExpiryOnExpiryDay`, `skipNearestExpiryOnEve`) is a
global setting a block can override (`util/expirySkip.ts`); an explicit `expiryOffset` is never bumped. The half-days-to-expiry OTM shift (`AntContractMaster.entryStrike`) applies only to spot-index buys
(`chunkedBuyIndex`), not to these strategies, which pass an explicit strike.

### Demo subscribe lease limitation
`/demo/subscribe` holds are leased for 30 minutes and refreshed only while an IP that subscribed the token (counted per IP, removed when it unsubscribes) has a `/demo/optionstream` open (`src/routes/demoLease.ts`). A client whose subscribe and stream calls come from different IPs (IPv4/IPv6, mobile network switch) is not recognised as a holder and loses its tokens when the lease lapses while streaming. A per-client id shared by both calls would fix it but needs a frontend change.
