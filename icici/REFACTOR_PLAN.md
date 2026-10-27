# Refactor plan: broker interface, duplicate trackers, vocabulary

These are the three tasks from `REVIEW_FINDINGS.md` that are still open after the correctness, unused-code and small-duplicate rounds. Each is its own task: plan, migrate with aliases where persisted data or the running frontend is affected, `tsc`, `code-review`, commit. Do them in this order; each one makes the next smaller.

## 1. One pending-order tracker (A1 21) and one chunked-buy resolver (A1 22)

**Status (2026-10-28):** steps 1-4 done - `pendingOrderTracker.ts` (generic loop + `BrokerOrderAdapter`), all four brokers ported (Prism, Breeze, Kite, ANT; ANT via the `resolveFill` / `onPollError` / `ignoreStaleStatus` hooks), `pendingTrackers.ts` registry used by `orderProcess.ts`. Still open: step 5 (`resolveChunkedContract` + shared `buyChunked` tail) and the per-adapter tests; open items 19-23 in `open-review-items.md` list the known tracker follow-ups.

**Why:** `pendingLimitOrders.ts` (Kite), `pendingAntLimitOrders.ts`, `breezePendingLimitOrders.ts`, `pendingPrismLimitOrders.ts` are four copies of one loop (track, poll, book fill, book partial on cancel, fire cancelled listeners, untrack). Fixes landed in one copy only (ANT Buy partials, Prism missing fill price). `orderProcess.ts` repeats the per-broker wiring at the load/poll/cancel-listener/find sites, and the four `chunkedBuyIndex` branches repeat contract resolution.

**Steps**
1. `PendingOrderTracker<T extends PendingOrder>` in `src/processes/order/pendingOrderTracker.ts`: `track/untrack/find(userId, tsym)/loadFromMongo/poll/onCancelled`. Per-broker part is a `BrokerOrderAdapter { collection, fetchStatuses(), statusOf(order, snapshot) -> {status, fillPrice?, filledQuantity?}, tradeBookFallback?(order), isPastClose }`.
2. Port Prism first (smallest), then Breeze, Kite, ANT (ANT has the extra position-verification fallback; keep it as an adapter hook).
3. Persisted shape stays identical (same Mongo collections, same field names), so no migration is needed; assert that with a load test against a captured document per broker.
4. `orderProcess.ts`: replace the per-broker maps with `trackerFor(broker)`.
5. `resolveChunkedContract(broker, req)` returns `{ tradingSymbol, instrumentToken, feedToken, exchange, quantity }`; the four branches share one guarded `buyChunked` tail.

**Verification:** the existing `orderAreaFixes` / pending-order tests, plus one new test per adapter feeding recorded statuses.

## 2. Broker interface for all four brokers (A1 26-29, A2 7, A3 8, A3b 8, A5 9)

**Why:** broker dispatch is if/else chains in `orderProcess.ts`, `server.ts`, strategies and scripts; each new broker needs about 15 edits.

**Done already:** `squareOffLimit` is required and returns the placed quantity; the never-short guard and resting-sell cancel are shared helpers used by ANT, Breeze and Prism; `getLiveQuantity` is an order-process IPC; `exchangeForTsym/exchangeForIndex` replace ~20 inline rules; broker-prefixed in-flight keys.

**Steps**
1. Extend `BrokerExecutor` with the missing operations: `enterShort`, `buyToClose`, `marketBuy`, `marketSell`, `placeLimitBuy`, `resolveContract`, `getContractByPriceRange`, `findPendingOrders`, plus `capabilities: { enterShort: boolean, ... }` so an unsupported operation is a flag, not a throw in one branch.
2. Move the `BreezeExecutor` object next to the other three (`brokerExecutors.ts`); make `getBrokerExecutor` throw on an unknown broker name instead of falling back to Kite.
3. Replace the if/else chains in `orderProcess.ts` one request type at a time (each is behaviour-preserving: same executor function, reached through the interface).
4. Client layer: a small `BrokerClient` interface (`hasValidSession`, `getLoginUrl`, `exchangeToken`, `cancelOrder(orderId, exchange?)`, `getTrades`, `getPositions`) implemented by the Kite/ANT/Breeze/Prism wrappers; add `exchange` to `cancelOrder` so Breeze drops its side map.
5. Fill-wait result type (A2 3): one `FillResult { status, filledQuantity, avgPrice }` and one cancel-on-timeout helper; wrappers keep their old error classes as subclasses so callers keep working.
6. Strategies: one `BrokerOps` resolved from a registry by broker name (replaces `antLegOps` vs `defaultLegOps`, the `ant*` Bare ops and the per-user Bare ops; delete the duplicates last).
7. `server.ts`: a `BROKERS` registry (`getTrades`, `getPositions`, `loginUrl`, `handleCallback`, `reconnectCmd`) replaces the if-chains and the four callback handlers; `isBrokerName()` in both validators.

**Compatibility:** IPC request names are kept (old names stay as thin aliases until every caller is migrated); no persisted field changes.

## 3. Vocabulary (A1 30-34, A2 10, A3 10, A3b 11, A4 10, A5 10)

**Rule:** rename only with a compatibility alias at every persisted or wire boundary; rename internals mechanically with the compiler as the check.

| Concept | Canonical | Notes |
|---|---|---|
| trading symbol | `tradingSymbol` | `Trade.tsym` is persisted in Mongo (`Trade`, `closedTrades`, `legLineage`), used in query strings (`/order/squareoff?tsym=`) and by the frontend. Keep `tsym` as a getter/alias on `Trade` and accept both in queries; do not rewrite stored documents. |
| instrument id | `token` for the ANT common token, `brokerToken` for a broker's own id, `feedToken` for the streaming key | `instrumentId` / `instrumentToken` / `antToken` become aliases first. A Kite instrument token must never be stored as `trade.token` (AntContractMaster warns about it). |
| exchange | `exchange` | wire names `exch`/`exchangeCode` are mapped at the broker boundary only. |
| quantity | `quantity`, `filledQuantity` | `qty` only in broker wire payloads. |
| capital | `accountCapital` (drawdown base, was `investmentAmount`), `maxExposure` (spend cap, was `maxInvestment`), `strategyCapital` (was `allottedCapital`), `openExposure`, `orderValue`, `pendingExposure` | `investmentAmount`/`maxInvestment`/`allottedCapital` are in user documents, `config.yml` and the admin UI: dual-read for one release, write the new name, then drop the old. |
| pnl | `pnl`, `realizedPnl`, `unrealizedPnl`, `sessionPnl` | `lossLimitAlert` for the notification; `drawdown` only for the liquidating percent limit (the notification type strings `drawdown_warning/breach` are stored in Mongo and read by the frontend: keep the stored values, rename the code names). |
| target / stop | `targetPoints` / `stopLossPoints` (offsets), `targetPrice` / `stopLossPrice` (absolute) | `targetPriceDiff` / `stopLossPriceDiff` in `config.yml` become aliases; `targetPrice` in Sentiment/RoC/Gap/Hourly configs is an offset today, so migrate those config keys with a read alias. |
| open / pending | `open` for positions, `pending` for reservations | |
| lots | `lotLimit` | `lotCount` is stored on users and sent by the frontend: alias. |

**Order of work:** (1) types and internal locals with no persisted/wire exposure (compiler-checked), (2) IPC payload field names with both names accepted on read, (3) Mongo/config/API names last, each with a dual-read and a one-line migration note here before the old name is dropped. Rebuild the frontend (`cd frontend && npm run build`) after any API field change.
