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

| Process | Entry | Owns |
|---|---|---|
| `data` | `src/processes/dataProcess.ts` | Broker tick WebSockets (ANT via `AntDataStream`, Breeze via `BreezeDataStream`). stdout = tick feed to the other three. stdin = subscribe / unsubscribe / reconnect commands. |
| `order` | `src/processes/orderProcess.ts` | The only process that places, cancels and exits broker orders (ANT, Zerodha/Kite, Breeze, Prism executors in `processes/order/`). Per-user bookkeeping and P&L, chunked orders, pending limit orders, order-notify streams, and `exitMonitor.ts` (watches `useGTT=false` trades against live ticks). Unix socket `ORDER_IPC_SOCKET` (default `/tmp/icici-order.sock`). |
| `strategies` | `src/processes/strategiesProcess.ts` | Strategy logic (`src/strategy/`), tick routing by token (`tokenRouter`), Nifty candle / stats / quote-history builders. Places orders through `OrderClient`; asks `data` for tokens through `DataClient`. Unix socket `STRATEGIES_IPC_SOCKET` (default `/tmp/icici-strategies.sock`) for control/admin calls. |
| `frontend` | `src/server.ts` (`dist/server.js`) | Express REST + SSE API, auth, OAuth callbacks, config endpoints, serves the static React bundle from `public/`. Relays to `order` and `strategies` over IPC. |

## Wiring

```
                 data.stdout (tick feed)
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   strategies       frontend        order
        │              │              │
        └──────────────┴──────────────┘
          each stdout -> data.stdin
          (subscribe / unsubscribe / reconnect)

   Unix sockets:  strategies / frontend  ──►  order (ORDER_IPC_SOCKET)
                  frontend               ──►  strategies (STRATEGIES_IPC_SOCKET)
```

`order`'s tick pipe exists only for `exitMonitor.ts`. Protocol helpers live in `src/ipc/` (`jsonLines.ts`, `orderProtocol.ts`, `strategiesProtocol.ts`, `feedSource.ts`).

## Why they are separate

- **Connections survive strategy edits.** `data` holds the tick WebSockets (including the ANT `createWsSess` session setup). `order` holds order-notify streams and in-flight state. Editing a strategy restarts only `strategies`.
- **In-flight orders are never orphaned by a strategy restart.** A resting limit sell or a watched stop lives in `order`. A stuck limit sell caused a real loss on 2026-09-21, so this boundary matters.
- **Failure isolation.** A bug, event-loop block or crash in strategy code cannot stall order placement or the tick feed.
- **Network quirks are scoped per process.** Kite and ANT allow only IPv4 for order placement; Breeze's registered static IP is the IPv6 address. Forcing IPv4 process-wide broke Breeze (tried 2026-09-25), so `installIpv4OnlyHostOverride()` (`processes/order/kiteDns.ts`) is applied only in `order` and `data`, only for specific hostnames.

## Restart matrix

Each child watches its own entry/dir plus shared dirs under `dist/` (`HOT_RESTART=false` disables all of this). Debounce 300 ms.

| Child restarts when these change | Effect of the restart |
|---|---|
| `data`: `processes/data`, `dataProcess.js`, `ant`, `model`, `util`, `prism`, `tools`, `ipc` | Tick WS drops, then reconnects via exponential backoff using the persisted `.ant_session.json`. Fast and automatic. |
| `order`: `processes/order`, `orderProcess.js`, `ant`, `zerodha`, `model`, `util`, `prism`, `tools`, `ipc` | Order-notify streams and exit monitor restart; per-user `sessionPnL` resets to 0 (not resynced from Mongo, see `Analysis.md`). **Avoid with open positions.** |
| `strategies`: `strategy`, `processes/strategies`, `strategiesProcess.js`, `ant`, `model`, `util`, `prism`, `tools`, `ipc`, `lib` | Strategy state rebuilt; BulkPcr armed slots restored from `.bulkpcr_armed_slots*.json`. Broker connections untouched. |
| `frontend`: `server.js`, `ant`, `zerodha`, `model`, `util`, `prism`, `tools`, `ipc` | API and SSE clients reconnect. Broker connections untouched. |

Shared dirs (`ant`, `model`, `util`, `prism`, `tools`, `ipc`) restart several children at once. Edit them with that in mind.

## Gotchas

- **stdout is a protocol channel** in `data`, `order`, `strategies` and `frontend`. Each entry file sets `console.log = console.error` before any import, so logs go to stderr. A stray `process.stdout.write` corrupts the protocol.
- **Unread `pipe` stdio deadlocks the child** once the OS buffer fills. Only stdout that is actually consumed is `pipe`; the rest is `inherit`.
- **Frontend has two meanings.** The React app (`frontend/src/`) builds into `public/` with `cd frontend && npm run build` and needs no process restart. The `frontend` *process* is `server.ts`; backend edits there do need a restart.
- `npm run server` starts only the frontend-equivalent process. It cannot exercise orders or streaming.

## Decision record: merging into fewer processes (2026-10-25)

Proposal: two processes, `strategies` and "others". Rejected as stated, because `frontend` would share a process with `data` and `order`, so every `server.ts` / route edit would drop the broker WebSockets and order monitors.

| Option | Verdict |
|---|---|
| Keep four processes | **Recommended.** IPC code already exists and works. |
| Three: `strategies`, `frontend`, `core` (data + order) | Possible. Removes the data-to-order subscribe hop, but ties tick-feed restarts to order-code edits and needs the IPv4/Breeze IP handling re-checked. |
| Two: `strategies` + everything else | Only viable if `server.ts` is rarely edited during market hours, or its hot-restart is turned off. |

Revisit if the IPC layer becomes a real maintenance or latency problem.
