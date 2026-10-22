# maxProfit / maxLoss for every strategy - plan (NOT implemented)

Status: plan only, written 2026-10-22. Nothing here is built yet.

> **Update 2026-10-22:** For BulkPcr, the loss stop is `maxLossPerTrade` only. `maxLossPerDay` (and the older
> `maxLoss` key on BulkPcr) was removed and is ignored with a WARN. A breach of `maxLossPerTrade` closes that
> broker's trade and locks the broker out for the rest of the day, including across restarts and the auto-start
> re-arm. See `strategies.md` (BulkPcrStrategy section). `ContinuousStrategy` and `SupportResistanceStrategy` keep `maxLoss`.

> **Update 2026-10-22 (maxProfit for BulkPcr):** BulkPcr now has `maxProfit` (percent of `maxInvestment`, per broker,
> cumulative for the whole day across every slot cycle). Reaching it closes that broker's open slots and locks the
> broker out for the rest of the day, same as a loss trip. Its day P&L survives the auto-start re-arm. See `strategies.md`.

## 1. What exists today

**Only the `LegManager`-based strategies have the stop** (`ContinuousStrategy`, `SupportResistanceStrategy`).
It lives in `src/strategy/LegManager.ts`:

- Config keys `maxProfit` and `maxLoss`, each a percent of the **configured** `maxInvestment`
  (`"4%"` / `"6%"`, parsed by `toPercentNumber`; unset/null disables it). `config.yml` today:
  `ContinuousStrategy` has `maxProfit: 4%`, `maxLoss: 6%`; `SupportResistanceStrategy` has `maxProfit: 100%`.
- Cumulative P&L = realized since the last reset + unrealized of every open leg
  (`computeCumulativeProfit`: `(lastLtp - avgPrice) * qty`, with `lastLtp` ignoring NaN ticks).
- Evaluated on every option tick (`onOptionTick`, ~line 612). A NaN-safe `>=` / `<=` compare trips a **one-way latch**.
- Latch consequences: `closeAllLegsAndCancelReEntries()` (sells every open leg, cancels pending re-entries, retries
  the remainder next tick), and `ContinuousStrategy` / `SupportResistanceStrategy` refuse new entries
  (`isMaxProfitTripped()` / `isMaxLossTripped()`).
- The latch is persisted per day in Mongo (`strategyLatches`: `ownerType`, `userId`, `day`), so a restart does
  not re-enable trading; `reset()` clears it. `loadPersistedLatches()` restores it at startup.
- Unparseable value: logged once, not enforced (ConfigService rejects such a file on load).
- `SupportResistanceStrategy` only checks `isMaxProfitTripped()` (not `isMaxLossTripped()`) at its entry gate
  (`SupportResistanceStrategy.ts:119`) and has no `maxLoss` in config - **an existing gap** the plan fixes.

**Separate, older, per-user control** (not a strategy stop): `Monitor.isLossLimitReached(user)` compares the
user's cumulative **realized** `userPnL` with `-lossLimit` and blocks new orders (`canPlaceOrder`). It ignores
unrealized P&L, only gates *new* orders (never closes anything), and `userPnL` is in memory per process
(`monitor.ts:31`, `bookkeeping.ts:112`). It stays as is; this plan adds the strategy-level stop beside it.

**BulkPcrStrategy has neither**: no stop-loss by design (the pair re-buys until the end-of-day force-close).
`BiDirectionStrategy` has a commented-out `maxLoss` (dead code).

## 2. Strategies and how each would get the stop

Armable strategies (`config.yml` blocks) grouped by how they hold positions. P&L source and close-all
mechanism differ per group, so one shared tracker with per-group adapters is proposed (section 3).

| Strategy | Position model | Exit owner today | P&L inputs | Close-all path |
|---|---|---|---|---|
| ContinuousStrategy, SupportResistanceStrategy | LegManager legs | self (LegManager) | already built | already built |
| BulkPcrStrategy (SENSEX, NIFTY) | per-broker, per-side slots (`ant_call`, `zerodha_put`, ...) with `entryAvg`, `targetQuantity`, `soldQty`, `soldValue` | self (resting +N sells, EOD close) | realized = `soldValue - soldQty * entryAvg` per slot, summed across slots and re-buys; unrealized from `lastLtp` of held tokens (already ticked via `heldToken`) | existing EOD path (`eodSquareOff`: pull resting sells, square off the rest) - reuse it for "stop" |
| HourlyStrategy | multi-broker, one open cycle | broker GTT / exitMonitor | `Trade` rows in Mongo/bookkeeping | sell open trades via OrderClient squareOff |
| GoodMorning, GoodMorningSensex, TargetReach, Gap, RateOfChange, RuleBased | single entry, broker GTT bracket or `exitMonitor` polling | broker-side / exitMonitor | `Trade` rows (entry price, qty, `realizedPnL`) + last tick | cancel GTT/bracket then sell, or flip the exitMonitor entry to "exit now" |
| SentimentStrategy | averaged position, self-managed | self | own avg price / qty | existing sell-whole-position path |
| TopStockOptionsOpeningGapStrategy, ButterflyStrategy | multi-leg, self-managed, multi-broker | self (resting limit sells, EOD) | per-leg entry/qty/premium | existing self-managed exit/EOD paths |
| BiDirection, Diff, Pivot, HighLot, Minutes5Decision, Test, ORBPrevious | no `config.yml` block, never instantiated | n/a | n/a | out of scope (document as not covered) |

## 3. Proposed design

### 3.1 Extract a shared `PnlStop` (new file `src/strategy/PnlStop.ts`)
Lift the generic parts out of `LegManager` so both it and the other strategies use one implementation:

- Inputs: `getConfig()` (reads `maxProfit` / `maxLoss` / `maxInvestment`), `getRealized()`, `getUnrealized()`,
  `ownerType`, `userId`.
- Behavior (unchanged from `LegManager`): percent parsing, NaN-safe compare, one-way latch, Mongo
  `strategyLatches` persistence (day-keyed), `loadPersistedLatches()`, `reset()`, unparseable-value logging.
- API: `evaluate(): 'ok' | 'profit' | 'loss'`, `isTripped()`, `isProfitTripped()`, `isLossTripped()`.
- `LegManager` is refactored to delegate to it with **no behavior change** (its P&L inputs stay
  `realizedPnL - maxProfitBaseline` and the open-leg sum). Verify the existing tests/log lines still match.

### 3.2 Per-group adapters
Each adapter supplies `getRealized` / `getUnrealized` and a `closeAll()`:

1. **BulkPcr**: realized/unrealized as in the table, summed across **all brokers and all slots** of the
   instance (the pair spans ANT + Zerodha, so a single combined latch is the safe default; per-broker latch
   as a later option). Close path: `eodSquareOff`-style (pull resting sells, square off remaining qty,
   mark slots `done`). Latched => `onSlotSoldOut` re-buys, `openOppositeSide` and `retryPendingRebuys` all
   refuse, `BulkPcrAutoStartStrategy` skips arming a tripped target (new log line).
2. **GTT/bracket and exitMonitor strategies** (GoodMorning*, TargetReach, Gap, RateOfChange, RuleBased,
   Hourly): P&L from the strategy's own open `Trade`s (bookkeeping, filtered by `userId` + strategy) plus the
   latest option tick. Close path: cancel the broker-side GTT/bracket first, then a marketable sell; must go
   through the existing OrderClient square-off so bookkeeping (`recordFill`) stays correct.
3. **SentimentStrategy, TopStock, Butterfly**: adapter over each one's own position record; close path is the
   strategy's existing sell/EOD routine.

### 3.3 Where it is evaluated
- On the strategy's own option-tick handler (cheap; no new subscriptions) for strategies that already receive
  ticks for held tokens; for GTT/bracket strategies that do not receive ticks for held tokens, register the
  held token via the existing `watchToken` (as `TargetReachStrategy` does) or use a 5s timer over the cached
  last-tick map.
- Also checked after every realized fill, so a loss crystallised by a stop-out trips without waiting for a tick.
- Entry gate: every strategy's entry path checks `isTripped()` first (and logs once at a throttle).

### 3.4 Config
- Two optional keys per strategy block: `maxProfit: 4%`, `maxLoss: 6%` (same format as today; both percent of
  that block's `maxInvestment`). Absent = off, so nothing changes for existing configs.
- `maxInvestment` becomes required-in-effect for any block that sets either key. `ConfigService` validation
  rejects `maxLoss` / `maxProfit` without a usable `maxInvestment`, and rejects non-percent values (same
  file-level check that already runs on load).
- Absolute-amount variant (e.g. `maxLossAmount: 5000`) optional; avoid unless wanted, to keep one meaning.
- BulkPcr blocks note: `quantity: -1` sizes off `maxInvestment`, so the percent maps to a real rupee figure.

### 3.5 Visibility and control
- Log lines in the existing format: `MAX LOSS TRIPPED - cumulative=... threshold=-...`, plus a daily
  "stop status" line per strategy (cumulative, thresholds) so a monitor can see how close it is.
- Expose tripped state + cumulative P&L on the `/strategies` list endpoint.
- `reset()` (admin `GET /strategies/:type/reset`) clears the latch (already how LegManager works).
- Frontend: show the badge and numbers on the strategies screen (requires `cd frontend && npm run build`).

## 4. Edge cases to think through before coding (the review will look for each)

- **Multiple concurrent instances**: two `BulkPcrStrategy` blocks (SENSEX / NIFTY) and two auto-starts must keep
  separate latches (key by `userId`, not type). Latch key already uses both.
- **Multi-broker partial state**: ANT closed but Zerodha still open when the stop trips; a failed sell on one
  broker must retry next tick without re-tripping or double-selling (idempotent, same as
  `closeAllLegsAndCancelReEntries`). Include the mixed-fill case: a resting +N sell fills while the stop is
  cancelling it (use the existing `squaringOff` flag / filledQty-from-cancel accounting).
- **Chunked orders**: a position split into several freeze-quantity chunks; stop must sell all remaining chunks,
  not collapse to one boolean.
- **Entry in flight when the stop trips**: a pending buy must be cancelled (not left resting) and any fill that
  lands afterwards must be closed or recorded.
- **Restart mid-position**: latch is persisted per day; a trip right before a restart must stay tripped, and the
  close-all must resume (reconcile marks BulkPcr slots for manual review by design - decide whether a restored
  latch triggers auto-close or only blocks entries; safest: auto-close only positions the broker confirms).
- **Stale / lagging quotes**: unrealized P&L must use live quotes. Today's incident (2026-10-22): the OHLC quote
  ran 70-90 points behind on an expiry-day option; use `getLiveQuote` (ScripDetails) for any price used in a stop
  decision, and ignore NaN / zero ticks.
- **Percent base**: percent of the *configured* `maxInvestment` (not deployed capital), matching today.
- **Realized across re-buys**: BulkPcr re-buys reuse the same slot; realized must accumulate across cycles
  (`soldValue` / `soldQty` already do), not reset per re-buy.
- **Daily reset**: `latchDay()` is date-keyed, so a new trading day starts untripped; confirm the in-memory
  realized counters reset on a new day for long-running processes.
- **Interaction with `Monitor` loss limit and `capitalGate`**: all three can block; log which one blocked.
- **Config live-sync**: changing `maxLoss` in `config.yml` takes effect on the next evaluation (cfg read each
  tick), but the strategies process's in-memory `enabled` flag does not follow a hand edit - use POST /config.

## 5. Suggested build order

1. Extract `PnlStop` from `LegManager`; refactor `LegManager` to use it; no behavior change. Add the
   missing `isMaxLossTripped()` check to `SupportResistanceStrategy`'s entry gate and a `maxLoss` key for it.
2. BulkPcr adapter (highest priority: it is the live strategy with no stop today). Include auto-start skip.
3. `Hourly`, `GoodMorning*`, `TargetReach`, `Gap`, `RateOfChange`, `RuleBased` (shared GTT/bracket adapter).
4. `Sentiment`, `TopStock`, `Butterfly`.
5. Config validation, `/strategies` status fields, frontend badge, `strategies.md` section update.
6. Per step: type-check, then a scripted dry run against `MOCK_BROKER` / `MOCK_QUOTES` when tests are allowed
   again (freeze until 2026-10-28), then code review before declaring live-ready.

## 6. Decisions (owner, 2026-10-22)

1. **Scope for BulkPcr: one stop per broker.** Each pair broker (ANT, Zerodha) gets its own `PnlStop` latch and
   its own P&L (all slots of that broker, both sides, across re-buys). One broker tripping closes and blocks only
   that broker; the other keeps running until its own limit. `BulkPcrAutoStartStrategy` arms the target only for
   brokers whose latch is clear. Latch key becomes `ownerType + userId + broker + day`.
2. **Close action: close everything at a limit price, so the loss stays bounded to the configured maxLoss.**
   A marketable *limit* sell (not a market order; ICICI/AliceBlue reject market orders on options anyway), priced
   off a live bid (`getLiveQuote`, never the OHLC quote). Pull resting +N sells first, then sell the remaining
   quantity chunked by freeze limit. A limit that does not fill is re-priced against a fresh bid and retried
   (same loop as `squareOffOnBreeze` / ANT re-pricing), because a stuck stop is worse than a slightly larger loss.
   The realised loss can still overshoot the threshold by the fill slippage; log threshold vs actual.
3. **maxLoss for BulkPcr SENSEX: 10%** of `maxInvestment` (₹1,00,000 -> ₹10,000) **per broker**. maxProfit was not
   specified: leave it unset (off) for BulkPcr until the owner gives a value.
4. **Per-user limit is included.** Fold `Monitor.lossLimit` into the same mechanism instead of leaving two:
   - A per-user stop (config on the user, same percent-of-`maxInvestment` shape, or the existing `lossLimit`
     amount) that sums realized + unrealized across **all** of that user's open positions and strategies.
   - When it trips: close that user's open positions with the same limit-price close path, block that user's new
     orders (what `canPlaceOrder` does today), persist the latch per day.
   - Unlike today's realized-only check, it counts unrealized P&L. Needs a per-user position + last-price view in
     the `order` process (`bookkeeping.trades` + live quotes), since `userPnL` is per-process memory today.
   - Both layers stay active: a strategy/broker stop can trip first without the user stop, and the user stop is the
     backstop across strategies.

### Still to confirm before coding
- Per-user limit source: keep `lossLimit` as a rupee amount per user, or move to a percent of the user's
  `maxInvestment`?
- BulkPcr `maxProfit` value (if any).
- Whether a tripped broker should also stop *the other broker's* hedge opens (current plan: no, brokers are
  independent).

---

# PART B - Implementation spec (written so a smaller model can build it step by step)

**This part supersedes Part A wherever they differ.** Part A explains the why; Part B is the how.
Do the phases **in order**, one phase per commit. After each phase run `npx tsc --noEmit -p .` and fix errors.
Do **not** run `npm run test:*`, `jest`, or the `code-review` skill (project freeze until 2026-10-28).
Do not touch `LegManager.ts` (decision: no refactor, see B0). Never commit `config.yml` runtime edits or session files.

## B0. Decisions and assumptions (final)

| # | Decision |
|---|---|
| 1 | Scope of the first build: **BulkPcrStrategy only, one stop per broker** (`ant`, `zerodha`; `breeze` is out of the config but the code must stay broker-generic via `isPairBroker`). |
| 2 | Close = the **existing** `eodSquareOff(pos)` path (cancel resting +N sell, then `antSquareOffBare` for ANT / `chunkedSquareOff` for Zerodha - both are marketable **limit** sells that re-price). Do not write a new sell path and do not use market orders. |
| 3 | `maxLoss: 10%` of that block's `maxInvestment`, **per broker** (BulkPcr-SENSEX: 10% of 100000 = 10000 per broker). `maxProfit` is **not** built for BulkPcr (not requested). |
| 4 | The stop is **daily**: a tripped broker stays stopped for the rest of the day, including across restarts and across the auto-start re-arming the strategy. Only an admin `reset` clears it. |
| 5 | Brokers are independent: one tripping does not stop the other. |
| 6 | **No `LegManager` refactor.** `PnlStop` (new file) is standalone; `LegManager` keeps its own copy. (Lower risk for a live system; dedupe later.) |
| 7 | Per-user stop (Phase 3) extends the **existing** drawdown mechanism in `src/processes/order/bookkeeping.ts` (it already liquidates on a realized breach); it adds unrealized P&L. Strategy pseudo-users (e.g. `BulkPcr-SENSEX`) have no `investmentAmount` and are skipped by that mechanism - the per-broker stop in Phase 2 is their protection. |

## B1. Shared facts the implementer must know (verified in the current code)

- `toPercentNumber(v)` is in `src/prism/percentConfig.ts`; returns `number | null` ("10%" -> 10, 10 -> 10).
- Mongo latch collection already exists: `strategyLatches`, documents keyed `{ ownerType, userId, day }` where `day`
  is `YYYY-MM-DD` local (see `LegManager.latchDay()` and `persistLatch`). Reuse it, adding a `broker` field to the key.
  `Mongo.getInstance()?.db.collection(...)` may be undefined - always use optional chaining and `.catch` that only logs.
- `BulkPcrStrategy` state: `positions: Map<string, BrokerPosition>` keyed by `slotKey(broker, right)` (e.g. `ant_call`).
  `BrokerPosition` (src/strategy/BulkPcrStrategy.ts ~line 107) has `broker, right, phase ('buying'|'selling'|'pending'|'error'|'done'),
  heldTsym, heldToken, entryAvg, targetQuantity, soldQty, soldValue, entryQuantity, squaringOff?`.
- `soldQty/soldValue/targetQuantity` are **reset on every re-buy** (`placeExitSell(key, qty)` -> `placeExitSellAtTargetPrice(..., true)`),
  so a slot's own fields do **not** hold the day's realized P&L. Realized must be accumulated separately (B2.3).
- Option ticks reach `processOptionQuote(quote)` (~line 625) only for tokens in `canHandleOptionQuote` (every non-`done` slot's `heldToken`), so
  both the CALL and PUT tokens of each broker already tick. The matching slots are found with
  `this.pairSlots().filter(p => p.heldToken === token && p.phase === 'selling')`.
- `pairSlots()`, `slotsOf(broker)`, `isPairBroker(broker)`, `configuredBrokers()`, `keyOf(pos)`, `persistState()` already exist.
- Persisted doc: collection `bulkPcrStrategyState`, one doc per `userId`, shape `PersistedState { positions }` (~line 159). `reconcile()`
  (~line 1021) loads it and rebuilds `positions`.
- The auto-start calls `target.reset()` **before every scheduled slot** (BulkPcrAutoStartStrategy.ts:191), and `BulkPcrStrategy.reset()`
  (end of file) clears `positions`. Stop state must therefore **not** live in `positions` and `reset()` must be told whether to keep it (B2.6).
- A hand-edit of `config.yml` does not update the strategies process's in-memory `enabled`; use `POST /config` or the `/strategies?...&enable=` toggle. `maxLoss` itself is read live from config each time (no restart needed).

## B2. PHASE 1 - `PnlStop` helper (new file `src/strategy/PnlStop.ts`, no behavior change anywhere)

Create a small class. Exact public API (keep it this small):

```ts
import { Log } from '../tools/log';            // use the same import path other strategy files use for Log
import { Mongo } from '../tools/mongo';        // same path BulkPcrStrategy uses
import { toPercentNumber } from '../prism/percentConfig';

export interface PnlStopDeps {
    ownerType: string;                 // e.g. 'BulkPcrStrategy'
    userId: string;                    // strategy instance userId, e.g. 'BulkPcr-SENSEX'
    scope: string;                     // 'ant' | 'zerodha' | ... (the broker) - part of the latch key
    getMaxLossPct: () => unknown;      // raw config value, e.g. '10%' | 10 | undefined | null
    getMaxInvestment: () => number;    // configured maxInvestment (rupees)
}

export class PnlStop {
    private tripped = false;
    constructor(private deps: PnlStopDeps) {}
    isTripped(): boolean { return this.tripped; }
    /** Returns true only on the call that newly trips the latch. NaN-safe. Disabled (returns false) when maxLoss unset/unparseable. */
    evaluate(cumulativePnl: number): boolean { ... }
    /** Restore today's latch from Mongo at startup. */
    async load(): Promise<void> { ... }
    /** Clear in memory and in Mongo (admin reset only). */
    async clear(): Promise<void> { ... }
}
```

Rules for `evaluate` (copy the semantics of `LegManager.checkAndMaybeTripMaxLoss`, lines ~390-402):
1. `if (this.tripped) return false;`
2. `raw = deps.getMaxLossPct(); if (raw == null) return false;` (feature off)
3. `pct = toPercentNumber(raw); if (pct === null || !(pct > 0)) { log ONCE per instance "ERROR maxLoss=<raw> is not a usable percent - NOT enforced"; return false; }`
4. `threshold = (pct / 100) * deps.getMaxInvestment();` if `!(threshold > 0)` log once and return false.
5. `if (!(cumulativePnl <= -threshold)) return false;`  (this form is NaN-safe - a NaN P&L must never trip)
6. `this.tripped = true;` persist (below); `Log.log(\`[${ownerType}] [${scope}] MAX LOSS TRIPPED - cumulative=${Math.round(cumulativePnl)} threshold=-${Math.round(threshold)} (maxLoss=${pct}% of maxInvestment=${maxInvestment})\`)`; return true.

Persistence: key `{ ownerType, userId, scope, day }`, where `day` is local `YYYY-MM-DD` built exactly like `LegManager.latchDay()`.
`upsert` `{ $set: { maxLossTripped: true, updatedAt: new Date() } }`. `load()` does `findOne(key)` and sets `tripped` if `doc?.maxLossTripped`; wrap in try/catch and log
(on failure leave untripped but log loudly). `clear()` does `deleteMany({ ownerType, userId, scope })` (all days) and sets `tripped=false`.

**Phase 1 acceptance:** `npx tsc --noEmit -p .` passes; `grep -rn "PnlStop" src` shows only the new file (nothing wired yet).

## B3. PHASE 2 - Wire per-broker stop into `BulkPcrStrategy`

All edits in `src/strategy/BulkPcrStrategy.ts` unless noted. Keep the existing code style and comment density (short why-comments).

### B3.1 New fields (near `eodDone`, ~line 245)
```ts
// Per-broker daily loss stop (see maxloss.md). One latch per pair broker; a tripped broker closes its slots and takes no new buys today.
private stops = new Map<BrokerName, PnlStop>();
// Day's realized P&L per broker, accumulated across every completed slot cycle (slot fields are reset on each re-buy).
private realizedByBroker = new Map<BrokerName, number>();
// Last tick price per slot key (in-memory only; used for the unrealized part of the stop check).
private lastLtpByKey = new Map<string, number>();
```
Helper `private stopFor(broker: BrokerName): PnlStop` - lazily creates `new PnlStop({ ownerType: 'BulkPcrStrategy', userId: this.userId, scope: broker, getMaxLossPct: () => this.cfg().maxLoss, getMaxInvestment: () => this.cfg().maxInvestment ?? 0 })`.
Helper `private isBrokerStopped(broker: BrokerName): boolean { return this.stopFor(broker).isTripped(); }`.

### B3.2 Cumulative P&L per broker
```ts
private cumulativePnl(broker: BrokerName): number {
    let total = this.realizedByBroker.get(broker) ?? 0;
    for (const pos of this.slotsOf(broker)) {
        if (pos.phase !== 'selling' || !pos.heldTsym) continue;       // 'buying'/'pending' hold nothing yet
        const ltp = this.lastLtpByKey.get(this.keyOf(pos));
        const open = pos.targetQuantity - pos.soldQty;
        total += pos.soldValue - pos.soldQty * pos.entryAvg;           // partial fills of the current cycle
        if (open > 0 && ltp !== undefined && Number.isFinite(ltp) && ltp > 0) total += (ltp - pos.entryAvg) * open;
    }
    return total;
}
```
A slot with no tick yet contributes 0 unrealized (never guess a price). `lastLtpByKey` entries are deleted when a slot finishes/re-buys (see B3.4).

### B3.3 Evaluate on every relevant tick and after every realized change
- In `processOptionQuote`, **after** the momentum branch and the `eodDone` return, for each slot in `matches` set `this.lastLtpByKey.set(this.keyOf(slot), quote.ltp)` (ignore NaN/<=0), then call
  `await this.checkStops(slot.broker)` **once per distinct broker in `matches`** (before the existing opposite-side logic, so a tripped broker never opens a hedge). Only the tripped broker is affected.
- Add `private async checkStops(broker: BrokerName): Promise<void>`: `if (this.eodDone || this.isBrokerStopped(broker)) return; if (this.stopFor(broker).evaluate(this.cumulativePnl(broker))) await this.closeBroker(broker);`
- Also call `checkStops(broker)` at the end of `onSlotSoldOut` (a realized loss can cross the line without a tick).

### B3.4 Realized accounting (the part most likely to be wrong - read carefully)
Add `private bookRealized(broker, pnl)` which does `this.realizedByBroker.set(broker, (this.realizedByBroker.get(broker) ?? 0) + pnl)` and `persistState()`.
- In `onSlotSoldOut(pos)` (start of function, before `pos.phase = 'done'`): `bookRealized(pos.broker, pos.soldValue - pos.soldQty * pos.entryAvg)`; then `this.lastLtpByKey.delete(this.keyOf(pos))`.
  (`updateTrade` has already added the final fill to `soldQty/soldValue` when this runs.)
- In `eodSquareOff(pos)`: the cancel-window fills are already added to `soldQty/soldValue`. When the square-off of `remaining` succeeds, book **both**
  parts exactly once: `pnl = (pos.soldValue - pos.soldQty * pos.entryAvg)` for what had sold at resting price **plus** `remaining * (exitPrice - pos.entryAvg)` for the squared-off part.
  `exitPrice` = the average price in the object returned by `antSquareOffBare` (a `Trade`, use `.price`) or `chunkedSquareOff` (read its return shape in
  `src/processes/order/` - use its `avgPrice` if present; if neither is available fall back to `lastLtpByKey.get(key) ?? pos.entryAvg` and log that the exit price was estimated).
  If the square-off throws, book nothing (phase becomes `error`, manual review) - do not double count on a retry.
- The early-return branch "everything already sold" in `eodSquareOff` books only the `soldValue - soldQty*entryAvg` part.
- Persist `realizedByBroker` in the same Mongo doc: change `persistState()` to write `{ userId, positions, realizedByBroker: Object.fromEntries(...), realizedDay: <local YYYY-MM-DD> }` and extend `PersistedState` with the two optional fields.
  In `reconcile()` after `loadState()`, restore `realizedByBroker` **only if** `realizedDay` is today (otherwise start empty). Do this before any slot is re-created.

### B3.5 Closing a tripped broker
```ts
private async closeBroker(broker: BrokerName): Promise<void> {
    Log.log(`[BulkPcrStrategy] [${broker}] loss stop tripped - closing this broker's open slots at limit and blocking new buys for today`);
    for (const pos of this.slotsOf(broker)) {
        if (pos.phase === 'selling') await this.eodSquareOff(pos);       // cancels the resting sell first, then limit square-off
        else if (pos.phase === 'pending') pos.phase = 'done';             // nothing held
        else if (pos.phase === 'error') Log.log(`[BulkPcrStrategy] [${broker}] stop: ${pos.right} slot is in error - skipped, manual review required`);
        // 'buying' handled by buyAndExit (B3.6): it squares off the fill as soon as the buy returns.
    }
    this.persistState();
    this.finishIfFlat();
}
```
`eodSquareOff` already guards re-entry with `pos.squaringOff` and phase checks; if it fails the slot becomes `error` (manual review) - acceptable and matches EOD behavior. `closeBroker` is idempotent: it only acts on `selling` slots, so a repeat call after a partial failure re-tries only slots still `selling`.

### B3.6 Block everything new for a stopped broker (add the guard, one line each)
Add `if (this.isBrokerStopped(<broker>)) { ...; return; }` at the top of:
1. `buyAndExit(key)` - after resolving `pos`: if stopped, set `pos.phase = 'done'` (it is a not-yet-bought side), `persistState()`, `finishIfFlat()`, return.
   And in the same function, where it currently checks `if (this.eodDone)` after a successful buy, change to `if (this.eodDone || this.isBrokerStopped(pos.broker))` so a buy that was in flight when the stop tripped is squared off immediately (the existing branch sets `targetQuantity/soldQty/soldValue` then calls `eodSquareOff`).
2. `openOppositeSide(slot)` - return before registering the new slot.
3. `onSlotSoldOut(pos)` - the re-buy condition: add `&& !this.isBrokerStopped(pos.broker)`.
4. `retryPendingRebuys()` - skip slots whose broker is stopped (set them `done`).
5. The root-entry path: in the code that does `const brokers = this.configuredBrokers();` (inside `processUnderlyingQuote`, ~line 413) use
   `const brokers = this.configuredBrokers().filter((b) => !this.isBrokerStopped(b));`; if the filtered list is empty, log once and `this.phase = 'done'` (do not enter).

### B3.7 Reset and restart behavior
- Change `reset(): void` to `reset(opts?: { keepStops?: boolean }): void`. Always do the existing clearing plus `this.lastLtpByKey.clear()`.
  Only when `!opts?.keepStops`: also `this.realizedByBroker.clear()`, `void Promise.all([...this.stops.values()].map(s => s.clear()))`, `this.stops.clear()`.
  The admin route `GET /strategies/:type/reset` calls `reset()` with no args (full clear) - leave it unchanged. Check the base class `Strategy.reset()` signature in `strategy.ts` and keep `BulkPcrStrategy.reset` compatible (make the param optional).
- `BulkPcrAutoStartStrategy.ts:191` must call `target.reset({ keepStops: true })`. `target` is typed as the strategy found via `strategies.getByUserId`; cast to `BulkPcrStrategy` (it already calls BulkPcr-specific methods like `isRunning`/`hasBrokerError` - copy that pattern).
- In `reconcile()` (start, before positions are rebuilt) call `await this.stopFor(b).load()` for each `configuredBrokers()` (and each `PAIR_BROKERS` member) so today's tripped stops survive a restart. After a restart the stop only **blocks** new buys; positions the broker still shows open follow the existing reconcile rules (manual review) - do not add auto-close at reconcile.
- Realized accumulators are restored in B3.4. On a new calendar day both are empty automatically (`realizedDay` mismatch; latch `day` key differs).

### B3.8 Auto-start behavior
In `BulkPcrAutoStartStrategy.attemptStart`, after resolving `target` and before arming: compute the brokers from the slot config (`cfg.brokers`); drop any that `target.isBrokerStopped(b)` (make that method `public`). If none remain, log
`[BulkPcrAutoStart:<id>] <time> slot: every configured broker is loss-stopped for today - skipping` and `return`. Otherwise arm with the remaining brokers (write the filtered list into `bulkPcrCfg.brokers`).
Do not mutate `cfg.brokers` itself.

### B3.9 Config
Add to `config.yml` under `BulkPcr-SENSEX`: `maxLoss: 10%`. Leave NIFTY's block without it (off). `maxInvestment` is already present. Check `src/prism/config.ts` / `ConfigService` validation: `maxLoss` is already an accepted percent key for `ContinuousStrategy`; if validation is keyed per strategy type, extend it to `BulkPcrStrategy`. A config with `maxLoss` but no positive `maxInvestment` must be **rejected** by validation (not silently ignored).

### B3.10 Logging contract (so the monitor can see it)
- Trip: the `MAX LOSS TRIPPED` line from `PnlStop`.
- Per stopped broker, once: the `closeBroker` line above, then the existing `EOD force-close:` lines from `eodSquareOff` (they will say EOD - acceptable; do not rewrite them).
- Blocks: `[BulkPcrStrategy] [<broker>] loss stop active - not opening/re-buying` (throttled with the existing `logGateOnce`).

### Phase 2 acceptance checks (static - no tests allowed)
1. `npx tsc --noEmit -p .` passes.
2. `grep -n "isBrokerStopped" src/strategy/BulkPcrStrategy.ts` shows guards in: `buyAndExit`, `openOppositeSide`, `onSlotSoldOut`, `retryPendingRebuys`, `processUnderlyingQuote` (broker filter).
3. `grep -n "bookRealized" src/strategy/BulkPcrStrategy.ts` shows calls in `onSlotSoldOut` and `eodSquareOff` (both branches) and nowhere else; read each call site and confirm no path books the same cycle twice (success path, early "already fully sold" path, error path).
4. Walk through by reading: (a) ANT trips while Zerodha is fine -> only ANT slots closed, Zerodha untouched; (b) trip while a re-buy is `buying` -> buy returns, is squared off by the `isBrokerStopped` branch, slot ends `done`; (c) trip while one side's resting sell fills during the cancel -> `soldQty` already includes it via the cancel result, no double count; (d) restart after trip -> `stopFor(b).load()` makes the broker stopped before the auto-start re-arms; (e) auto-start re-arm -> `reset({keepStops:true})` keeps the stop and `realizedByBroker` (note: `reset` clears `positions` only).
5. Update `strategies.md` (BulkPcr section) with a short "Loss stop" paragraph and tick the `maxloss.md` Phase 2 box.

## B4. PHASE 3 - Per-user stop including unrealized P&L (order process)

What already exists (do not rebuild): `OrderBookkeeping.drawdownState(user, 'daily'|'weekly')` in `src/processes/order/bookkeeping.ts` (~line 445) computes **realized** P&L from the `closedTrades` collection and compares it with a percent
of the user's `investmentAmount` (`settings.maxDailyDrawdownPercent` / `maxWeeklyDrawdownPercent`, defaults in `percentConfig.ts`). On a breach `checkBreachAndNotify` fires `drawdownBreachListeners`, and `orderProcess.ts` (~line 335, "drawdown-breach liquidation") force-closes the user's positions through
`forceCloseActive` / `forceCloseStartedAt` (idempotent, cooldown protected). `canPlaceOrder` (~line 560) blocks new buys on any non-`ok` state. Users without `investmentAmount` (strategy pseudo-users) are skipped by design. The legacy `Monitor.isLossLimitReached` (`src/monitor.ts:182`, realized-only, session `lossLimit`) is in the frontend/other process and is left as is.

Change (small and additive):
1. Add `async getOpenUnrealizedPnL(user: string): Promise<number | null>` to `OrderBookkeeping`: for each open `bookkeeping.trades` row of that user (and `shortTrades`, sign reversed), get a **live** price via `ANT.getInstance().getLiveQuote(exchange, token)` (never the OHLC `getQuote`), compute `(ltp - t.price) * t.quantity` (short: `(t.price - ltp) * qty`). Deduplicate quote calls by token. Return `null` if no row could be priced; skip individual rows whose quote fails (count as 0, log once per minute). Never throw.
2. In `drawdownState`, add the unrealized part to `pnl` **only for the daily window**: `const unreal = await this.getOpenUnrealizedPnL(user); const total = (pnl ?? 0) + (unreal ?? 0)`; if `pnl === null` keep returning `'unknown'` (unchanged fail-closed rule). Pass `total` to `drawdownDecision`.
   A missing/failed quote must make `unreal` 0 - it must **never** by itself cause `'breached'`.
3. Evaluate on a timer, not only after fills: in `orderProcess.ts` startup, add a `setInterval` (every 10s) that, for each user with open trades **and** an `investmentAmount`, calls `checkBreachAndNotify(user)` (make it non-private or add a small public wrapper `evaluateDrawdown(user)`). Guard with an `inFlight` Set so overlapping runs for the same user are skipped.
4. Latch it for the day: when `checkBreachAndNotify` breaches, record `{ user, day }` in `strategyLatches` (`ownerType: 'user'`, `scope: 'drawdown'`) so `canPlaceOrder` keeps blocking after a restart even if the position closed at a better price afterwards. Load these latches at order-process startup.
5. No config change: the thresholds stay the existing `maxDailyDrawdownPercent` / `maxWeeklyDrawdownPercent` settings. (Open question for the owner if a different percent is wanted: add `maxDailyLossIncludingOpenPercent`.)

Phase 3 acceptance: `tsc` passes; read-through that (a) a user with no `investmentAmount` is untouched, (b) quote failure never triggers a breach, (c) the liquidation path is still the single shared `forceClose...` code (no second sell path), (d) the timer cannot start overlapping liquidations for the same trade (`forceCloseActive`).

## B5. Hand-off checklist for the implementer
- [x] Phase 1 committed (PnlStop only). 62fdd46
- [x] Phase 2 committed; `config.yml` change (`maxLoss: 10%` on `BulkPcr-SENSEX`) made last and **not** pushed with unrelated hand edits (use `git add -p` / only the lines you changed). 7c87ac6
- [x] `strategies.md` BulkPcr section updated; `maxloss.md` boxes ticked.
- [x] Phase 3 committed (order process, be65b19). Deploy only after the B7 verification of Phase 2.
- [ ] Phase 3 only after Phase 2 is verified in a quiet period (not mid-session); it touches the live `order` process.
- [ ] After each deploy remember: restart -> `POST /reconcile` (after checking positions), `GET /strategies/BulkPcrStrategy/reset` only if a slot is stuck in `error`, and enable via `/strategies?userId=...&enable=true`.
- [ ] Report back: what changed per file, how each acceptance check was verified (by reading, since tests are frozen), and anything ambiguous you decided.

## B6. Known risks to call out to the owner after building
1. A stop-close sell is a limit: in a gap move it can fill worse than the 10% line (slippage is logged, not capped).
2. A broker whose slot is in `error` at trip time is **not** auto-closed (manual review), same as EOD.
3. Per-broker limit is 10% of `maxInvestment` **per broker**, so two brokers can together lose 20% before both stop.
4. Phase 3 depends on live ANT quotes; if ANT's quote service is down the unrealized part is ignored (fails open on the unrealized side by design, to avoid false liquidations).

## B7. Verification after implementation (restart + /reconcile) - owner decision 2026-10-22

**Who does this:** the implementing session builds Phases 1-3 exactly as specified and stops there. The *monitoring* session (the one watching BulkPcr live) runs this B7 verification once the implementation is committed and both brokers are flat, and fixes any error it finds.

Restart recovery is NOT assumed to work (BulkPcr fails closed on restart by design and a stop latch adds new state to restore). So after Phases 1-2 are built, **test the restart path explicitly and fix whatever breaks** before calling it done:

1. Do this only when both brokers are flat (a restart abandons open legs). Check `GET /broker/ant/positions` and `GET /broker/zerodha/positions` first.
2. Set `maxLoss` on `BulkPcr-SENSEX` very small (e.g. `0.1%`, with a small `quantity`) so one broker trips quickly; run one cycle until the log shows `MAX LOSS TRIPPED`, `loss stop tripped - closing`, and that broker flat.
3. Restart the processes (`npm run processes`), then `POST /reconcile` (not before checking positions). Confirm in `orchestrator.log`:
   - no exception from `reconcile()`, `PnlStop.load()`, or `loadState()`;
   - the tripped broker is still reported stopped (its latch loaded) and `realizedByBroker` restored for today;
   - the other broker is not stopped.
4. Let the next auto-start slot fire: the tripped broker must be skipped (`every configured broker is loss-stopped` or armed with the remaining brokers only), the other must arm normally.
5. Restart once more mid-day with the stop tripped and a position open on the OTHER broker: reconcile must mark it for manual review per existing behavior and must not clear the latch or double count realized P&L.
6. Call `GET /strategies/BulkPcrStrategy/reset` (admin reset): the latch and `realizedByBroker` must clear; an auto-start re-arm must NOT clear them.
7. Any error found: fix it, re-run steps 3-6, commit. Restore the real `maxLoss: 10%` and quantity afterwards and report what was changed.
