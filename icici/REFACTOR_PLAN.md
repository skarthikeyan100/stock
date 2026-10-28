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

**Status (2026-10-28):** steps 1-3, 4 (BrokerClient for login/callback/reads, exchange on cancel, Breeze side map removed), 5 (shared cancel-on-timeout tail) and 7 (server BROKERS registry) are done; step 6 is done for the generic Bare family (the ANT-only duplicates are removed; the generic requests take an explicit `broker`). Still ANT-specific on purpose: `antBuyTargetOnly`, `antPlaceLimitSellBare` (they carry ANT-only fields: underlyingOpen/marketProtection, product) and `antPlaceCoverOrder`.

**Steps**
1. Extend `BrokerExecutor` with the missing operations: `enterShort`, `buyToClose`, `marketBuy`, `marketSell`, `placeLimitBuy`, `resolveContract`, `getContractByPriceRange`, `findPendingOrders`, plus `capabilities: { enterShort: boolean, ... }` so an unsupported operation is a flag, not a throw in one branch.
2. Move the `BreezeExecutor` object next to the other three (`brokerExecutors.ts`); make `getBrokerExecutor` throw on an unknown broker name instead of falling back to Kite.
3. Replace the if/else chains in `orderProcess.ts` one request type at a time (each is behaviour-preserving: same executor function, reached through the interface).
4. Client layer: a small `BrokerClient` interface (`getLoginUrl`, `exchangeToken`, `getTrades`, `getPositions`) implemented by the Kite/ANT/Breeze/Prism wrappers (`src/broker/`) and used by `server.ts` - **done**. `BrokerExecutor.cancelOrder` takes an optional `exchange` (passed by the pending-order lookup) - **done**; Breeze's order->exchange side map is still the fallback for callers that pass none (`cancelOrderBare`, `squareOffOnBreeze`'s retry loop) - **pending**: pass the exchange everywhere, then drop the map.
5. Fill-wait result type (A2 3): one `FillResult { status, filledQuantity, avgPrice }` and one cancel-on-timeout helper; wrappers keep their old error classes as subclasses so callers keep working.
6. Strategies: one `BrokerOps` resolved from a registry by broker name (replaces `antLegOps` vs `defaultLegOps`, the `ant*` Bare ops and the per-user Bare ops; delete the duplicates last).
7. `server.ts`: a `BROKERS` registry (`getTrades`, `getPositions`, `loginUrl`, `handleCallback`, `reconnectCmd`) replaces the if-chains and the four callback handlers; `isBrokerName()` in both validators.

**Compatibility:** IPC request names are kept (old names stay as thin aliases until every caller is migrated); no persisted field changes.

## 3. Vocabulary (A1 30-34, A2 10, A3 10, A3b 11, A4 10, A5 10)

**Status (2026-10-28):** done - (1) types and internals: `Trade.tradingSymbol` accessor alias for the stored `tsym` (a prototype accessor, never an own property, so stored documents and JSON are unchanged), `BuyRequest.brokerToken` (was `instrumentId`), `OptionExchange`, one `ALL_BROKERS` list, `FillResult`/`ChunkedFillResult`, the new tracker/executor/client interfaces use `tradingSymbol`/`token`; (2) IPC payloads: the strategies->order requests that carried `tsym` (`chunkedSquareOff`, `chunkedSquareOffLimit`, `cancelRestingLimitSells`, `breezeSquareOff`) send `tradingSymbol`, and the order process accepts both names on read. Also done (expand phase, 2026-10-28): user documents `lotLimit`/`accountCapital`/`strategyCapital` (both names stored, either accepted on read, startup backfill, API/admin UI/frontend use the canonical names) and config.yml `settings.targetPoints`/`stopLossPoints` and `<strategy>.maxExposure` (read from either name, canonical wins, both kept in memory and written; admin UI edits the canonical keys). Pending-order documents also store the canonical `token` beside the broker-specific field (read from either); `Trade.realizedPnl`/`unrealizedPnl` are prototype accessors over the stored `realizedPnL`/`unrealizedPnL`. Dropping the old names is the contract phase and is deliberately not done: it needs one release in which nothing reads them. NOT done (remaining): the contract phase for everything above; the `investmentMode` stored VALUES (`lotCount`/`investmentAmount`); the notification type strings and `drawdown*` code names; `qty` in internal code; `instrumentId` as the parameter name in the ANT client API and executors; and the ~270 `.tsym` reads on `Trade` (the stored field name stays `tsym` - a Mongo document key - so moving the storage to `tradingSymbol` is itself an expand/contract change). Each needs its dual-read shipped first (user documents, `config.yml`, the admin UI and the frontend all read the old names), then a release writing the new name, then dropping the old one - that sequence spans deployments and cannot be done in one commit without breaking stored data.

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
