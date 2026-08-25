# ContinuousStrategy Implementation Plan

## Context

`spec.md` (repo root) specifies a new trading strategy, `ContinuousStrategy`, that opens an initial leg (T1) using `BuySellStrategy`-style entry-trigger conventions, then self-monitors every open leg's own price against a target and five stacked adverse levels (1x-5x of a configured SL distance). A target hit closes the leg and places a limit re-entry order at the original entry price; each 1x-4x adverse level spawns an independent new leg in the opposite direction with escalating quantity; the 5x level squares off just that one leg. Chaining is unbounded by design (no max depth/concurrent-legs cap — declined explicitly in the spec). All orders execute on Zerodha, with contract selection by premium-range lookup (floor of 100, configurable) rather than ATM, and target/SL monitoring is done by the strategy itself from live tick data rather than the existing GTT/`exitMonitor` mechanism (which has no equivalent for multi-level 1x-5x logic).

Three rounds of codebase research (summarized in "Verified codebase facts" below) turned up that a meaningful chunk of the infrastructure this needs **does not exist yet** and must be built alongside the strategy itself:
- Zerodha has no IPC-exposed `buyContract`/`sellContract` path (only Prism does) and no standalone LIMIT-order primitive (LIMIT only exists inside the SELL-only OCO GTT bracket).
- Zerodha's own quote API is unusable for this account (`getLTP` returns 403), so there's no live premium data to walk strikes against on the Zerodha side. The existing workaround elsewhere in the codebase (`antExecutor.estimateOptionPrice`) resolves the *same* strike via AliceBlue's contract master purely to read a live premium, while still trading the Zerodha-resolved contract. This plan replicates that pattern for a new Zerodha-side `getContractByPriceRange`.
- `strategiesProcess.ts` does not await each tick before reading the next one, so a strategy's tick handler must update its own "already fired" state *synchronously, before any `await`*, or a fast burst of ticks for the same token can double-fire a spawn/close.
- `bookkeeping.ts` keys open trades by `(tsym, user)`, not by token — if `ContinuousStrategy` ever opened two legs on the identical contract for the same user concurrently, bookkeeping would silently merge them into one row and corrupt P&L on the next partial close. This is avoided by excluding already-open strikes (same direction) from every contract-selection call.

Confirmed with the user before finalizing this plan:
- **Unfilled re-entry limit orders**: poll indefinitely; no auto-cancel/timeout. The order just sits at the broker until it fills or someone cancels it manually in Kite.
- **T1 re-arming**: once a chain fully closes out (no open legs, no pending re-entries), the entry gate re-opens automatically and a new T1 can fire again the same day — matches `BuySellStrategy`'s existing re-arm-on-close convention.
- **Root vs. nested refill**: only the root leg is ever eligible for target-hit refill or a
  5x-triggered restart; every nested leg closes for good on its own target/5x, no re-entry.
- **Deferred root refill**: if the root hits target while nested legs are open, the refill intent
  is queued and fires automatically the instant the last nested leg closes.
- **Level slots are reusable, at every depth**: a level (1x-4x) re-arms the instant its occupying
  child leg closes (any reason), and can fire again immediately on a later qualifying tick — same
  rule recursively at every depth, not just the root.
- **Capital cap replaces the repeat-count cap**: no `maxReEntryCount` field — the sole limiter on
  chain growth is `allottedCapital` (Section 5a of `spec.md`): before any order that adds
  exposure, running `sum(quantity × entryPrice)` across open legs and pending re-entries plus the
  new order's own projected cost must stay under `allottedCapital`, or the order is skipped.
- **Quantity mode**: new `spawnQuantityMode: 'same' | 'multiplied'` toggle (default
  `'multiplied'`), applied uniformly across all four levels.

## Verified codebase facts (read directly, not inferred)

- **`src/strategy/strategy.ts`** — abstract `Strategy` base class. Subclasses must implement `receive`, `processNiftyQuote`, `processOptionQuote`. Override `canHandleOptionQuote` (default `false`) to receive any option ticks at all. `updateTrade = async (trade: Trade) => {...}` is a no-op placeholder by default — override to react to fills. Helpers available: `isCooldownElapsed`/`recordTriggerTime` (shared `lastTriggerTime`), `isSentimentAligned(quote, right)`, `isTimeInRange()` (10:00-15:00, bypassed under `MOCK_BROKER`), `recordOutcome('win'|'loss'|'timeout', pnl)` (feeds `getStats()`).
- **`src/strategy/BuySellStrategy.ts:262-293`** — the T1 entry model: gate order is `enabled && isTimeInRange() && !this.ordered && isCooldownElapsed(...)`; `right` resolved via `OrderClient.calculateRight(userId, ltp)` if config value is `"none"`; sentiment check *after* right resolution, resets `this.ordered = false` on misalignment (so it retries later); contract picked via `OrderClient.getContractByPriceRange`, then `super.buyContract(contract, qty)`.
- **`src/strategy/StrategyFactory.ts`** — `STRATEGY_REGISTRY = new Map<string, new(userId?) => Strategy>()`; register with one import + one `.set()` call. `userId` defaults to `config.userId || config.type` (single global instance unless a specific `userId` is configured in `config.yml` — the existing convention, no multi-instance expansion needed).
- **`src/processes/strategiesProcess.ts:40-57`** (`onTick`) — nifty/sensex quotes broadcast to every `strategy.enabled` instance; option quotes go through `routeOptionTick`. Critically: `readJsonLines(process.stdin, (tick) => { onTick(tick).catch(...) })` — **not awaited**, so ticks can overlap in-flight.
- **`src/processes/strategies/tokenRouter.ts`** + **`strategiesProcess.ts:25-38`** (`onFill`) — on every Buy/Sell fill notification, `registerTrade(trade.token, strategy)` / `unregisterTrade(...)` is called automatically (keyed by `strategies.getByUserId(userId)`), then `strategy.updateTrade(trade)`. A strategy instance can be registered against many tokens simultaneously (Set-per-token registry) — no manual `watchToken` calls needed for legs that come from a synchronous buy/sell response; only genuinely async fills (limit re-entries) need `updateTrade` to do real work.
- **`src/processes/order/zerodhaExecutor.ts`** — `buyContractOnZerodha` (internal, not IPC-exposed, line 173) and `squareOffOnZerodha` (line 225, exported but **does not set `trade.token`** on the Sell trade it builds — a pre-existing gap, confirmed by reading the file, that would break `tokenRouter.unregisterTrade` if reused as-is). `finalizeEntry` (line 27) is the shared post-buy path that places a GTT bracket or registers with `exitMonitor` depending on `bookkeeping.getUserUseGTT(userId)` — `ContinuousStrategy` must bypass this entirely (self-monitored).
- **`src/zerodha/Zerodha.ts:182-198`** — `buyOption()` hardcodes `order_type: 'MARKET'` with a required `market_protection: -1` param (Kite rejects MARKET orders without it). **No standalone LIMIT-buy method exists** — `order_type: 'LIMIT'` only appears inside `placeTargetStopLossGTT`/`modifyTargetStopLossGTT` (lines 223-278), a SELL-only OCO bracket, not reusable as a general primitive. `getFillPrice(orderId, maxAttempts=12, intervalMs=5000)` (line 203) polls up to 60s then throws — designed for near-instant market fills, not adequate for a limit order that may sit for a long time.
- **`src/zerodha/ZerodhaContractMaster.ts`** — static CSV-backed instrument master only (`data/zerodha/{NFO,BFO}_instruments.csv`), **zero live premium data**. `findNearestExpiryOption(strike, optionType, symbol='NIFTY', expiryOffset=0)` returns `{tradingSymbol, instrumentToken, lotSize, exchange}` — confirmed signature, this is the shared resolution primitive to build on. `STRIKE_STEP = {NIFTY: 50, SENSEX: 100}`.
- **`src/prism.ts:666-721`** — `Prism.getContractByPriceRange(right)`, the only existing premium-range implementation (Prism/Shoonya-only): ATM strike from NIFTY LTP, walks OTM depth 0-4 (50pt steps) checking live LTP via `getOptionQuote` against global `settings.minPrice`/`maxPrice`, falls back to ITM depth 1-4. Returns just a contract symbol string. This is the pattern to mirror for the Zerodha version (strike-walk shape), not the code to reuse (different broker, different premium source).
- **`src/processes/order/antExecutor.ts:168-182`** — `estimateOptionPrice(symbol, strike, optionType)`: resolves the strike via `AntContractMaster.getInstance().findNearestExpiryOption(...)` to get an ANT token, reads a live premium via `safeAntQuote`/`ANT.getInstance().getQuote(...)`, swallows errors → returns 0. Already imported into `zerodhaExecutor.ts` and used to price Zerodha-side strikes for sizing, specifically because Zerodha has no live quotes for this account. **This is the exact pattern the new premium-range lookup replicates**: resolve the tradable contract via `ZerodhaContractMaster`, but read its premium via this ANT cross-reference.
- **`src/ipc/orderProtocol.ts`** — `OrderRequestType` is a plain string union; `payload`/`OrderResponse` are `any`-typed. Trivial to extend with new request types.
- **`src/processes/order/bookkeeping.ts:371-416`** (`_processTradeEvent`) — Buy fills are matched/merged by `(tsym, user)` (line 381: `this.trades.findIndex(t => t.tsym == tradeEvent.tsym && t.user == tradeEvent.user)`); if found, quantity/price are averaged into the existing row rather than creating a second one. Sell fills close the *entire* matched row using `buyTrade.quantity` (not the sell fill's own quantity) as the P&L multiplier. **Two concurrently-open `ContinuousStrategy` legs on the identical contract for the same user would corrupt this bookkeeping** — mitigated by excluding already-open strikes (same direction) from every contract-selection call, and by giving `ContinuousStrategy` its own dedicated `userId` so it never collides with other strategies' trades on the same tsym.
- **`config.yml`/`config.mock.yml`** — flat YAML array under `strategies:`, each `{type, enabled, ...freeform}`. `AppConfig.StrategyInstanceConfig` has an open index signature, no interface change needed. `configToFlat()` auto-derives the frontend key `continuousStrategy` from the class name — no `ConfigService` changes needed.
- **`src/constants.ts`**: `CALL = 'call'`, `PUT = 'put'` (lowercase).
- **`src/model/model.ts`**: `Trade` fields confirmed — `tsym`, `token`, `right`, `action`, `quantity`, `price`, `status`, `user`, `gttTriggerId`.
- Test convention: no working jest setup (`jest` in `package.json` is vestigial — no config, no `.test.ts` files). The real convention is `src/test/strategyTest.ts` — hand-rolled `assert()`, mock-quote builders, monkey-patched singletons (`Monitor.instance = ...`), compiled+run via `"test:strategy": "tsc && node ./dist/test/strategyTest.js"` in `package.json`. Follow this exact style for `ContinuousStrategy`'s tests, monkey-patching `(OrderClient as any).instance` instead.

## Approach

### Task Group A — Zerodha bare execution primitives (new capability, no existing IPC path)

**`src/zerodha/Zerodha.ts`** — add a genuine LIMIT buy method alongside `buyOption` (after line 198):
```ts
async placeLimitBuyOption(tradingSymbol: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
    if (!this.accessToken) throw new Error('No active session. Please login first.');
    const response = await this.kc.placeOrder('regular', {
        exchange, tradingsymbol: tradingSymbol, transaction_type: 'BUY',
        quantity, product: 'NRML', order_type: 'LIMIT', price,
    });
    return { orderId: response.order_id };
}
```
No `market_protection` param here — that's MARKET/SL-M only; Kite accepts a plain `price` for LIMIT orders.

**`src/processes/order/zerodhaExecutor.ts`** — add three new exported functions, deliberately bypassing `finalizeEntry` (no GTT, no `exitMonitor` registration — `ContinuousStrategy` self-monitors):
- `marketBuyBareOnZerodha(userId, tradingSymbol, instrumentToken, quantity, exchange)` — calls `zerodha.buyOption` + `getFillPrice`, builds a `Trade` (setting `token`), calls `bookkeeping.recordFill(trade)` directly. Mirrors `prismExecutor.ts`'s simpler no-bracket flow.
- `marketSellBareOnZerodha(userId, tradingSymbol, instrumentToken, quantity, exchange)` — same shape as `squareOffOnZerodha` but **does** set `trade.token` (fixing the gap `squareOffOnZerodha` has, without touching that existing function — new function, lower blast radius, since `squareOffOnZerodha` is used elsewhere and changing its behavior isn't in scope here).
- `placeLimitBuyBareOnZerodha(userId, tradingSymbol, instrumentToken, quantity, price, exchange)` — calls `zerodha.placeLimitBuyOption`, then registers the order with the new pending-order tracker (below) instead of waiting for a fill. Returns `{orderId}` immediately.

**New file `src/processes/order/pendingLimitOrders.ts`** — in-memory `Map<orderId, {userId, tradingSymbol, instrumentToken, quantity, exchange}>` plus:
- `trackPendingLimitOrder(order)` — adds to the map.
- `pollPendingLimitOrders()` — for every tracked order, calls `kc.getOrderHistory(orderId)`; on `COMPLETE`, builds a Buy `Trade` and calls `bookkeeping.recordFill(trade)` (which flows through the existing `fillListeners` → IPC broadcast → `OrderClient.onFill` → `strategiesProcess.ts`'s `onFill` → `strategy.updateTrade(trade)` path, same as any other fill); on `REJECTED`/`CANCELLED`, drops it and logs; otherwise leaves it pending for the next poll. No timeout/cancellation (per confirmed decision) — state is in-memory only, so a process restart loses tracking of it (the broker-side order is unaffected and will still fill/show up in Kite's own order book).

**`src/processes/orderProcess.ts`** — wire a `setInterval(() => pollPendingLimitOrders().catch(...), 15_000)` next to the existing `pollGttFills` interval (15s — shorter than `pollGttFills`'s 60s since a re-entry filling promptly matters more to a live chain).

**IPC wiring** (`src/ipc/orderProtocol.ts`, `src/processes/orderProcess.ts`, `src/processes/strategies/OrderClient.ts`) — add three new `OrderRequestType`s (`'buyContractZerodhaBare'`, `'sellContractZerodhaBare'`, `'placeLimitBuyZerodhaBare'`), three new `case`s in `orderProcess.ts`'s `handleRequest` (following the exact `canPlaceOrder`/`pendingUsers.add` gating pattern used by the existing `'buyContract'` case at line 133), and three new `OrderClient` methods (following the exact `request()`/`res.ok`/`res.error`/`res.result` pattern used by `buyContract`/`sellContract` at line 135).

### Task Group B — Zerodha premium-range contract lookup

**`src/processes/order/zerodhaExecutor.ts`** — add `getContractByPriceRangeOnZerodha(underlyingLtp, optionType, index, minPremium, excludeStrikes)`:
- Compute ATM strike from `ZerodhaContractMaster`'s strike step (50 NIFTY / 100 SENSEX).
- Walk OTM depth 0-4, then ITM depth 1-4 (mirroring `Prism.getContractByPriceRange`'s order), skipping any strike in `excludeStrikes`.
- For each candidate strike: resolve the **tradable** contract via `ZerodhaContractMaster.getInstance().findNearestExpiryOption(strike, optionType, index)`, and separately check its **live premium** via `estimateOptionPrice(index, strike, optionType)` (the existing ANT cross-reference from `antExecutor.ts`, already imported into this file).
- Return the first candidate whose premium `>= minPremium` (floor only, no upper bound — unlike Prism's min/max range, because an adverse leg here can move up to 5x the SL distance further away from its own entry, so headroom above the floor is wanted, not capped).
- Throw if nothing found within the walk.

**IPC wiring** — add `'getContractByPriceRangeZerodha'` request type, an `orderProcess.ts` case (`excludeStrikes` travels as a plain array over JSON, rehydrated into a `Set` in the handler since `Set` doesn't survive JSON), and an `OrderClient.getContractByPriceRangeZerodha(userId, underlyingLtp, optionType, minPremium, index, excludeStrikes)` method.

**Pre-flight check** (no code change): confirm `data/zerodha/NFO_instruments.csv` and `BFO_instruments.csv` exist and are reasonably fresh before relying on this in testing — `ls -la data/zerodha/`; re-run `scripts/download-zerodha-master.sh` if stale/missing.

### Task Group C — `ContinuousStrategy` class (`src/strategy/ContinuousStrategy.ts`, new file)

**Data model**:
```ts
interface Leg {
    legId: string;
    token: string;
    tsym: string;
    strike: number;
    exchange: 'NFO' | 'BFO';
    right: string;               // CALL | PUT
    entryPrice: number;          // E
    quantity: number;
    isRoot: boolean;             // true only for T1 and any later refill/restart of T1
    parentLegId: string | null;  // null for root legs
    parentLevel: number | null;  // 1-4: which slot on the parent this leg occupies; null for root
    childByLevel: Map<number, string>;   // level (1-4) -> currently-open child legId; absent/removed = free
    status: 'OPEN' | 'CLOSING';
}
interface PendingReEntry {
    slotId: string; tsym: string; exchange: 'NFO' | 'BFO'; strike: number; right: string;
    quantity: number; isRoot: true;   // only roots ever get a PendingReEntry now
}
```
`legsByToken: Map<string, Leg>`, `pendingReEntries: Map<string, PendingReEntry>` (root refills
only, keyed by the limit order's resulting token — used to match the eventual `updateTrade` fill
back to the right pending intent), and a new `deferredRootRefill: PendingReEntry | null` — set
when the root hits target while nested legs are still open; converted into an actual placed limit
order (and moved into `pendingReEntries`) the moment `legsByToken` contains no more nested legs.

**`processNiftyQuote`** — T1 entry, modeled directly on `BuySellStrategy.ts:262-293`: same gate order (`enabled && isTimeInRange() && !ordered && isCooldownElapsed`), same `right` resolution via `calculateRight` when config is `"none"`, same sentiment-alignment check (resets `ordered = false` on misalignment so it retries). Contract comes from the new `OrderClient.getContractByPriceRangeZerodha(userId, ltp, optionType, minPremium)`; run `capitalCheck` (below) before ordering. Order via the new `OrderClient.buyContractZerodhaBare(...)`. On success, insert a `Leg` (`isRoot: true, parentLegId: null, parentLevel: null, childByLevel: new Map()`) into `legsByToken` keyed by the fill's token and call `recordTriggerTime()`. On failure, reset `ordered = false` so the next qualifying tick retries.

**`canHandleOptionQuote(quote)`** — `this.legsByToken.has(String(quote.token))` (must check against *every* open leg's token, not a single field — this instance manages many concurrent legs).

**`capitalCheck(newQty: number, estimatedPremium: number): boolean`** — sums `quantity × entryPrice` over `legsByToken.values()`, plus `quantity × estimated-or-limit-price` over `pendingReEntries.values()`, plus `newQty × estimatedPremium`; returns whether that total stays under `cfg.allottedCapital`. Called by every code path below that places a new order (T1 entry, level spawns, root refill placement).

**`processOptionQuote(quote)`** — the core self-monitoring logic. For the leg matching `quote.token` (`leg`):
- **Target hit** (`ltp >= entryPrice + D`): mutate `leg.status = 'CLOSING'` and `legsByToken.delete(token)` **synchronously, before any `await`** (required — `strategiesProcess.ts` does not await ticks sequentially, so a burst of ticks for the same token could otherwise double-fire this). Then `await` a market sell via `OrderClient.sellContractZerodhaBare(...)`, `recordOutcome('win', ...)`.
  - If `leg.isRoot`: check whether any nested legs remain in `legsByToken` (any leg with `isRoot === false`). If none, run `capitalCheck` and — if it passes — immediately place the limit re-entry via `OrderClient.placeLimitBuyZerodhaBare(...)` at `entryPrice`, tracked in `pendingReEntries` keyed by the same token. If nested legs remain, set `this.deferredRootRefill` to the same intent instead of placing the order now.
  - If NOT `leg.isRoot`: no re-entry of any kind for this leg. Look up `leg.parentLegId` in `legsByToken`; if the parent is still open, delete `leg.parentLevel` from the parent's `childByLevel` map (freeing that slot). Then call `maybePromoteDeferredRootRefill()` (below).
- **Adverse 1x-4x** (`level = Math.min(5, Math.floor((entryPrice - ltp) / D))`, computed once): if `level >= 1 && level <= 4 && !leg.childByLevel.has(level)` (slot free): compute the spawn quantity per `cfg.spawnQuantityMode` (`'multiplied'`: `leg.quantity * level`; `'same'`: `leg.quantity`), run `capitalCheck` with that quantity and the estimated premium from contract selection — if it fails, skip (slot stays free, naturally re-evaluated on the next qualifying tick). If it passes: **synchronously**, before any `await`, reserve the slot with a placeholder (e.g. set `leg.childByLevel.set(level, PENDING)`) — same reasoning as the original watermark guard, to stop a burst of ticks from double-spawning — then spawn one new opposite-direction leg via a market buy with `isRoot: false, parentLegId: leg.legId, parentLevel: level`, and on success replace the placeholder with the new leg's real `legId`. Contract selection passes `excludeStrikes = openStrikesFor(oppositeRight)` (every currently-open leg's strike with that same right) to the premium-range lookup, avoiding the same-contract bookkeeping collision described above.
- **Adverse 5x** (`level === 5`): mark `CLOSING`, remove from `legsByToken` synchronously, `await` a market sell, `recordOutcome('loss', ...)`. No spawn.
  - If `leg.isRoot`: no special handling beyond the existing `maybeRearmEntry()` check below (nested legs no longer refill themselves, so the chain now naturally drains to empty).
  - If NOT `leg.isRoot`: same parent-slot-freeing / `maybePromoteDeferredRootRefill()` logic as the target-hit nested-leg case above — a nested leg closing via 5x also frees its parent's slot and can unblock a deferred root refill. Children this leg previously spawned (still in `legsByToken` under their own entries) are untouched — no cascade, matching spec 4.2's explicit note.
- **`maybePromoteDeferredRootRefill()`** — if `this.deferredRootRefill` is set and `legsByToken` now contains no more nested legs (`isRoot === false`), run `capitalCheck` and — if it passes — place the limit order for the deferred intent (move it into `pendingReEntries`, keyed by token) and clear `this.deferredRootRefill`.
- After any leg-closing branch, check `maybeRearmEntry()`: if `legsByToken` and `pendingReEntries` are both empty **and `deferredRootRefill` is null**, set `this.ordered = false` (confirmed decision: auto re-arm once fully flat — a pending deferred refill still owes an order, so it must not re-arm early).

**`updateTrade(trade)`** — only meaningful for root-refill limit fills (every other fill — T1/spawn/target-close market buys and sells — is already handled synchronously by the code path that placed it, since those all return the fill directly). Must be idempotent for every other echoed fill:
```ts
updateTrade = async (trade: Trade): Promise<void> => {
    if (trade.action !== 'Buy') return; // Sell echoes: already handled synchronously
    const intent = this.pendingReEntries.get(trade.token);
    if (!intent) return; // redundant echo of a market buy already handled synchronously
    this.pendingReEntries.delete(trade.token);
    const legId = this.nextLegId();
    this.legsByToken.set(trade.token, { legId, token: trade.token, tsym: intent.tsym,
        strike: intent.strike, exchange: intent.exchange, right: intent.right, entryPrice: trade.price,
        quantity: trade.quantity, isRoot: true, parentLegId: null, parentLevel: null,
        childByLevel: new Map(), status: 'OPEN' });
};
```

**`reset()`** — `super.reset()` then clear `legsByToken`/`pendingReEntries`, `deferredRootRefill = null`, `ordered = false`.
**`getMonitorConfig()`** — override to return `null` for clarity (this strategy never goes through the base's GTT/exitMonitor bracket path — it's unused, but overriding documents intent against future accidental use).
Do not override `getStats()` — rely on the inherited aggregation via `recordOutcome`.

**Tests** (`src/test/continuousStrategyTest.ts`, new file, following `strategyTest.ts`'s hand-rolled `assert()`/mock-quote/monkey-patched-singleton style, run via a new `"test:continuousStrategy": "tsc && node ./dist/test/continuousStrategyTest.js"` npm script):
1. No legs open → `canHandleOptionQuote` returns `false` for any token.
2. `reset()` clears all legs and re-arms `ordered = false`.
3. T1 entry (mocked `OrderClient`) opens a tracked root leg on the returned token.
4. Root target hit (no nested legs open) removes the leg from `legsByToken` and adds a pending re-entry immediately.
5. **Gapped tick fires only the deepest free level** — a tick that jumps straight past 1x/2x into 3x territory spawns exactly one leg (at the 3x-configured quantity) and occupies only the 3x slot.
6. **A level whose slot is still occupied does not re-fire** even if price is at/beyond a deeper threshold on a later tick that doesn't cross further.
7. **Slot re-arm** — a child leg closing (target or 5x) frees its parent's slot for that level; a subsequent qualifying tick on the parent fires that level again (new leg, new legId).
8. **Root-only refill** — a nested leg hitting its own target does not create any `PendingReEntry`/`deferredRootRefill`; only a root leg's target hit does.
9. **Deferred root refill** — root hits target while a nested leg is open → `deferredRootRefill` is set, no limit order placed yet; when the nested leg then closes, the limit order is placed (moves into `pendingReEntries`) and `deferredRootRefill` clears.
10. **Capital cap blocks a spawn** — with `allottedCapital` set just below what a 1x spawn would need, an adverse 1x tick does not spawn a new leg (slot stays free); a subsequent tick after capital frees up (another leg closes) does spawn.
11. **Quantity mode** — `spawnQuantityMode: 'same'` produces a 4x-level spawn with the same quantity as the parent, not 4x the parent's quantity.
12. **5x squares off only this leg** — a previously-spawned child leg (from this leg's own 1x trigger) remains open and trackable after the parent hits 5x.
13. **Concurrent-tick safety** — firing `processOptionQuote` twice back-to-back without awaiting the first (`Promise.all([...])`) for a tick that crosses a free level results in exactly one spawn, not two (proves the synchronous slot-reservation guard works given `strategiesProcess.ts`'s unawaited tick dispatch).
14. `updateTrade` ignores a Buy fill with no matching pending re-entry (idempotency against redundant echoes).
15. `updateTrade` resolves a pending root refill into a fresh open root leg.

### Task Group D — Registration

- **`src/strategy/StrategyFactory.ts`**: `import ContinuousStrategy from './ContinuousStrategy'` + `STRATEGY_REGISTRY.set('ContinuousStrategy', ContinuousStrategy)`.
- **`config.yml`** and **`config.mock.yml`**: new block after the `BuySellStrategy` entry:
  ```yaml
    - type: ContinuousStrategy
      enabled: false
      initialQuantity: 75
      slDistance: 10
      minPremium: 100
      allottedCapital: 500000     # sum(qty * entryPrice) across open legs + pending re-entries must stay under this
      spawnQuantityMode: multiplied   # 'same' | 'multiplied'
      right: none
      cooldownSeconds: 60
      logEnabled: false
  ```
  (`config.mock.yml`'s copy sets `logEnabled: true`, matching that file's existing convention for the mock/dev config.)
- **`frontend/src/pages/AdminPage.tsx`**: new `<Card>` block after the Buy-Sell Strategy card (~line 749-776), using `renderConfigField(label, ['continuousStrategy', field], config.continuousStrategy?.field, type?)` for `enabled` (boolean), `initialQuantity`, `slDistance`, `minPremium`, `allottedCapital`, `spawnQuantityMode` (text/select: same | multiplied), `right` (text), `cooldownSeconds`, `logEnabled` (boolean) — same `Row`/`Col md={...}` grid layout as the surrounding cards.
- **`frontend/frontEnd.md`**: add a `**ContinuousStrategy:**` bullet (after the BuySellStrategy line, ~line 188/191) listing the same fields, matching the existing one-line-per-strategy doc convention.

## Known limitations (explicitly out of scope for this pass)

- **No max chain-depth/concurrent-legs *count* cap** — exposure is bounded instead by the capital cap (`allottedCapital`, Section 5a of `spec.md`); existing account-level risk limits (lot limit, investment cap, drawdown) remain an additional backstop.
- **Rare same-tick strike collision**: two different parent legs spawning opposite-direction children in the same processing window could theoretically both compute `openStrikesFor()` before either's new leg is inserted into `legsByToken`, landing on the same strike. Given ticks for different tokens are dispatched from separate `processOptionQuote` calls and each spawn's `buyContractZerodhaBare` await happens before the leg is added to the map, this is a real but narrow race; not hardened against in this pass (would need a synchronous strike-reservation step) — flagging it here rather than silently ignoring it.
- **Process-restart loses in-memory pending-limit-order tracking** (`pendingLimitOrders.ts`) — the broker-side order is unaffected and will still fill, but `bookkeeping.recordFill`/`updateTrade` won't fire for it until/unless a reconciliation pass is added later. Same limitation as the existing `exitMonitor`/`AntStream` in-memory-only patterns already documented in `CLAUDE.md`.
- **`squareOffOnZerodha`'s pre-existing `trade.token` gap** is left as-is (not fixed) — `ContinuousStrategy` uses its own new `marketSellBareOnZerodha` instead, which does set `token` correctly.

## Verification

1. **Build**: `npm run build` (or let `tsc --watch` pick up the changes) — must compile cleanly with no new TypeScript errors.
2. **Unit tests**: `npm run test:continuousStrategy` (new script) — all 15 `assert()` cases above must print `PASS`.
3. **Existing tests still pass**: `npm run test:strategy` (unaffected by these changes, but confirms nothing in shared files like `strategy.ts` broke).
4. **Config sanity**: `GET /config` (with the server running) should return a `continuousStrategy` key with the new fields once `config.yml`'s new block is added; `POST /config` with an edited value should round-trip.
5. **Frontend spot-check**: load `/app`'s Admin page in a browser (`npm run server`, then the frontend dev server) and confirm the new "Continuous Strategy" card renders with all fields editable and saves correctly via `POST /config`.
6. **Manual/paper smoke test** (during market hours, `enabled: true` on a test account with a small `initialQuantity`): watch `server.log`/`server_logs.txt` for `[ContinuousStrategy]`-prefixed log lines confirming T1 entry, a spawn on an adverse move, and a target-hit re-entry order placement — full live-fire verification of order placement correctness is out of scope for this plan (would need real market movement) but the log trail should make each transition visible for manual confirmation.
