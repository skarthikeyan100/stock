# Process Architecture

Kept out of `CLAUDE.md` on purpose (that file is loaded on every prompt). Read this when touching `src/orchestrator.ts`, `src/processes/*`, or when proposing to merge/split processes.

## Overview

`npm run processes` runs `tsc -w` and `dist/orchestrator.js` side by side (`package.json`). The orchestrator spawns four sibling processes, wires their stdio, and restarts **only the child whose compiled output changed**. The orchestrator itself is never restarted by `tsc -w`, so a save never tears down every child at once. That is the point of the split. Logs go to `orchestrator.log`.

## Broker naming

Exactly four brokers are supported. Use only the canonical name in code, config, Mongo, API, UI and docs.

| Use | Never use |
|---|---|
| `ant` | AliceBlue, Alice Blue |
| `kite` | Zerodha |
| `breeze` | ICICI, ICICI Direct (as a broker name) |
| `prism` | Shoonya |

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
| `trading` | `src/processes/tradingProcess.ts` | `order` + `strategies` in one process. Order side (`orderProcess.ts`): the only code that places, cancels and exits broker orders (ANT, Kite, Breeze, Prism executors in `processes/order/`), per-user bookkeeping and P&L, chunked orders, pending limit orders, order-notify streams, `exitMonitor.ts`. Strategy side (`strategiesProcess.ts`): strategy logic (`src/strategy/`), tick routing (`tokenRouter`), candle / stats builders. Strategies call the order side in-process (`OrderClient.useLocalServer`); it still serves `ORDER_IPC_SOCKET` and `STRATEGIES_IPC_SOCKET` for `frontend`. On start it reconciles broker positions and every strategy before any tick is delivered (`startupReconcile`, `Strategy.stateLoaded`). |
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
- **Orders and strategies together.** One startup sequence (preflight, reconcile, then ticks) and plain in-process calls instead of an IPC hop. The old reason for the split, "a strategy restart must not orphan an in-flight order", is now covered by the startup reconcile rather than by a process boundary, so restarting `trading` with open positions still needs care.
- **Network quirks are scoped per process.** Kite and ANT allow only IPv4 for order placement; Breeze's registered static IP is the IPv6 address. Forcing IPv4 process-wide broke Breeze (tried 2026-09-25), so `installIpv4OnlyHostOverride()` (`processes/order/kiteDns.ts`) is applied only in `trading` and `data`, only for specific hostnames.

## Restart matrix

Each child watches its own entry/dir plus shared dirs under `dist/` (`HOT_RESTART=false` disables all of this). Debounce 300 ms. `data` is not watched at all.

| Child restarts when these change | Effect of the restart |
|---|---|
| `trading`: `processes/order`, `orderProcess.js`, `strategy`, `processes/strategies`, `strategiesProcess.js`, `tradingProcess.js`, `ant`, `kite`, `breeze`, `model`, `util`, `prism`, `tools`, `ipc`, `lib` | Order-notify streams, exit monitor and all strategy state restart; the startup reconcile rebuilds legs from the brokers' open positions. Per-user `sessionPnL` resets to 0 (not resynced from Mongo, see `Analysis.md`). **Avoid with open positions.** |
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
