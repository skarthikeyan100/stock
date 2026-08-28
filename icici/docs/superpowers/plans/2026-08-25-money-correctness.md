# Money-Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six money-correctness bugs from the Priority Punch List's "Money-correctness" section in `/home/karthikeyan/work/icici/Analysis.md` — payout computation, fill idempotency, the consistency-rule math, the legacy `monitor.ts` P&L bugs, and Prism's silent order-failure swallowing.

**Architecture:** Each bug is fixed in place, in its existing file. Where the buggy logic is pure (no Mongo/network I/O), it is pulled out into a small named function so it can be verified with a plain Node script, matching this repo's existing `src/test/*.ts` convention (hand-rolled `assert()`, run via `npm run build && node dist/test/<name>.js` — there is no jest/mocha harness wired up in this repo, see `Analysis.md` §6, which is out of scope for this plan).

**Tech Stack:** TypeScript, Node.js, MongoDB (via `src/tools/mongo.ts`). No new dependencies.

**Spec:** `/home/karthikeyan/work/icici/Analysis.md` — Priority Punch List "Money-correctness" items 1-5 (each covering `src/payout.ts`, `src/processes/order/bookkeeping.ts`, `src/monitor.ts`), plus punch-list item 2 ("Prism/Shoonya order-placement failures are silently swallowed...", full detail in `## 2. Broker & Order Execution` Critical Bug #1) which the punch list itself files under Money-correctness even though it lives in a Broker-execution file (`src/prism.ts`) — covered here as Task 6, not left for the separate Reliability plan.

## Global Constraints

- No new npm dependencies. No jest/mocha/ts-jest — verification scripts follow the existing `src/test/*.ts` hand-rolled-`assert()` convention (see `src/test/strategyTest.ts`, `src/test/continuousStrategyTest.ts`), compiled via the existing `npm run build` (`tsc`) and run with plain `node`.
- Every new/changed pure function used by a test must be `export`ed from its module.
- Do not touch security/authz (missing route auth, etc.) or build out a general test harness — both explicitly out of scope for this plan.

---

## File Structure

- `src/payout.ts` — modify: add two exported pure functions (`isNonPositiveProfitBlocked`, `computeConsistencyBreach`) and wire them into `computePayout`.
- `src/model/model.ts` — modify: add `brokerOrderId?: string` to `Trade`.
- `src/processes/order/bookkeeping.ts` — modify: dedup fills in `recordFill`/`updateTradeFromPrismMessage`.
- `src/processes/order/zerodhaExecutor.ts`, `src/processes/order/antExecutor.ts`, `src/processes/order/pendingLimitOrders.ts` — modify: set `trade.brokerOrderId` at each fill-producing call site that already has an order id in scope.
- `src/monitor.ts` — modify: fix partial-sell handling and the realized/unrealized P&L conflation.
- `src/prism.ts` — modify: stop silently swallowing order-placement failures in `_placeOrderWithForce`/`buyContract`/`sellContract`.
- `src/processes/order/prismExecutor.ts` — modify: `sellContract` wrapper uses the real filled quantity.
- `src/test/payoutRules.test.ts` (new) — verifies the two extracted `payout.ts` pure functions.
- `src/test/bookkeepingDedup.test.ts` (new) — verifies fill dedup in `bookkeeping.ts`.
- `src/test/monitorPartialSell.test.ts` (new) — verifies the two `monitor.ts` fixes.

---

## Task 1: `computePayout` blocks payouts with no profit to pay out

**Files:**
- Modify: `src/payout.ts:66-169` (`computePayout`)
- Test: `src/test/payoutRules.test.ts` (new)

**Interfaces:**
- Produces: `export function isNonPositiveProfitBlocked(grossProfit: number): boolean` — `true` iff `grossProfit <= 0`.

**Context:** `computePayout` (`src/payout.ts:66-169`) never checks `grossProfit <= 0` except as a side-effect of the drawdown-forfeiture block (`:127-148`), which only fires when `investmentAmount > 0` and the loss breaches 25%/50%. A user with no `investmentAmount` set (e.g. a strategy pseudo-user), or a small net loss that doesn't breach drawdown, sails through with `blocked=false` and a negative `splitAmount`/`netAmount` that `markPayoutDecision` (`:236-244`) can later mark `'paid'` with no sign check.

- [ ] **Step 1: Write the failing test**

Create `src/test/payoutRules.test.ts`:

```ts
/**
 * Verifies the pure payout-blocking rules extracted from src/payout.ts.
 * Run: npm run build (compile), then: node ./dist/test/payoutRules.test.js
 */

import { isNonPositiveProfitBlocked, computeConsistencyBreach } from '../payout';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

console.log('isNonPositiveProfitBlocked:');
assert(isNonPositiveProfitBlocked(-100) === true, 'blocks a net loss');
assert(isNonPositiveProfitBlocked(0) === true, 'blocks exactly zero profit');
assert(isNonPositiveProfitBlocked(50) === false, 'allows a positive profit through');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/payoutRules.test.js`
Expected: compile error — `isNonPositiveProfitBlocked` is not exported from `../payout` (doesn't exist yet).

- [ ] **Step 3: Add the pure function and wire it into `computePayout`**

In `src/payout.ts`, add near the top (after the existing interfaces, before `payoutsCollection()`):

```ts
// A period with zero or negative net profit has nothing to pay out - block
// unconditionally, independent of the drawdown-forfeiture check below (which
// only fires once investmentAmount > 0 and the loss breaches 25%/50%).
export function isNonPositiveProfitBlocked(grossProfit: number): boolean {
    return grossProfit <= 0;
}
```

In `computePayout`, right after the safety-buffer block (`:87-96`) and before the existing consistency-rule block (`:100-119`), insert:

```ts
    if (!blocked && isNonPositiveProfitBlocked(grossProfit)) {
        blocked = true;
        blockReason = `This period has no profit to pay out (gross ₹${grossProfit.toFixed(2)}).`;
        blockDetail = { cumulativePnL: grossProfit };
    }
```

Then simplify the existing consistency-rule guard from `if (!blocked && grossProfit > 0) {` to `if (!blocked) {` — `grossProfit > 0` is now guaranteed by the block just added whenever `!blocked` is true, so the old guard is dead weight left over from before this fix.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc && node dist/test/payoutRules.test.js`
Expected: all three `isNonPositiveProfitBlocked` assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add src/payout.ts src/test/payoutRules.test.ts
git commit -m "fix: block payouts for periods with no net profit"
```

---

## Task 2: Fix the payout consistency-rule math so it can no longer exceed 100%

**Files:**
- Modify: `src/payout.ts:98-119` (consistency-rule block inside `computePayout`)
- Test: `src/test/payoutRules.test.ts` (extend from Task 1)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function computeConsistencyBreach(periodTrades: Array<{ exitTime: any; realizedPnL?: number }>, grossProfit: number, consistencyLimitPercent: number): { worstDay?: string; worstPnL: number; worstPercent: number; tradeIds: any[]; breached: boolean }`.

**Context:** `worstPercent = (worstDay's pnl / grossProfit) * 100` (`payout.ts:107`) uses **net** profit as the denominator. With a strong winning day and any losing day, net `grossProfit` is smaller than the single best day's own pnl, so `worstPercent` routinely exceeds 100% (e.g. +₹10,000 day / a −₹6,000 day elsewhere → `grossProfit` ₹4,000 → 250%). The fix: measure the winning day's share of **gross winnings** (sum of positive days only), not net profit — this can never exceed 100%, and it's the correct measure of "did one day carry the whole payout."

- [ ] **Step 1: Add the failing assertions**

Append to `src/test/payoutRules.test.ts`:

```ts
console.log('computeConsistencyBreach:');

const bigWinAndLoss = [
    { exitTime: '2026-08-01T10:00:00Z', realizedPnL: 10000 },
    { exitTime: '2026-08-02T10:00:00Z', realizedPnL: -6000 },
];
const r1 = computeConsistencyBreach(bigWinAndLoss, 4000, 90);
assert(r1.worstPercent <= 100, `worstPercent never exceeds 100% (got ${r1.worstPercent})`);
assert(r1.worstPercent === 100, 'a single winning day among a loss is 100% of gross winnings');
assert(r1.breached === true, 'breaches a 90% limit since it is the only winning day');

const twoEvenWins = [
    { exitTime: '2026-08-01T10:00:00Z', realizedPnL: 5000 },
    { exitTime: '2026-08-02T10:00:00Z', realizedPnL: 5000 },
];
const r2 = computeConsistencyBreach(twoEvenWins, 10000, 90);
assert(r2.worstPercent === 50, `two even winning days split 50/50 (got ${r2.worstPercent})`);
assert(r2.breached === false, 'does not breach a 90% limit when no day dominates');

const allLosses = [
    { exitTime: '2026-08-01T10:00:00Z', realizedPnL: -1000 },
    { exitTime: '2026-08-02T10:00:00Z', realizedPnL: -500 },
];
const r3 = computeConsistencyBreach(allLosses, -1500, 90);
assert(r3.breached === false, 'never breaches when there are no winning days at all');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/payoutRules.test.js`
Expected: compile error — `computeConsistencyBreach` not exported yet.

- [ ] **Step 3: Implement `computeConsistencyBreach` and wire it into `computePayout`**

In `src/payout.ts`, add after `isNonPositiveProfitBlocked`:

```ts
// Measures a period's worst-day concentration against gross winnings (sum of
// positive days only), not net profit - net profit can be deflated below any
// single winning day's own total by an unrelated loss elsewhere in the
// period, which previously let worstPercent exceed 100% and over-block
// legitimate payouts. Gross-winnings-based percent is mathematically capped
// at 100% (a day can be at most the sum of all winning days).
export function computeConsistencyBreach(
    periodTrades: Array<{ exitTime: any; realizedPnL?: number }>,
    grossProfit: number,
    consistencyLimitPercent: number
): { worstDay?: string; worstPnL: number; worstPercent: number; tradeIds: any[]; breached: boolean } {
    const byDay = groupByDay(periodTrades);
    let worstDay: string | undefined;
    let worstPnL = -Infinity;
    let grossWinnings = 0;
    for (const [day, entry] of byDay) {
        if (entry.pnl > worstPnL) { worstPnL = entry.pnl; worstDay = day; }
        if (entry.pnl > 0) grossWinnings += entry.pnl;
    }
    const worstPercent = worstDay && grossWinnings > 0 ? (worstPnL / grossWinnings) * 100 : 0;
    const breached = !!worstDay && worstPercent > consistencyLimitPercent;
    return { worstDay, worstPnL, worstPercent, tradeIds: worstDay ? byDay.get(worstDay)!.tradeIds : [], breached };
}
```

`groupByDay` is already defined above in the same file (`:49-59`) — no change needed there, just reuse it.

Replace the existing consistency-rule block (`:100-119`, now starting with `if (!blocked) {` from Task 1 Step 3) with:

```ts
    if (!blocked) {
        const consistency = computeConsistencyBreach(periodTrades, grossProfit, consistencyLimitPercent);
        if (consistency.breached) {
            blocked = true;
            blockReason = `${consistency.worstDay} contributed ${consistency.worstPercent.toFixed(0)}% of this period's winning days (limit ${consistencyLimitPercent}%).`;
            blockDetail = {
                day: consistency.worstDay,
                dayPnL: consistency.worstPnL,
                consistencyPercent: consistency.worstPercent,
                consistencyLimit: consistencyLimitPercent,
                tradeIds: consistency.tradeIds,
            };
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc && node dist/test/payoutRules.test.js`
Expected: all assertions PASS, including `worstPercent <= 100` on the case that used to produce 250%.

- [ ] **Step 5: Commit**

```bash
git add src/payout.ts src/test/payoutRules.test.ts
git commit -m "fix: cap payout consistency-rule percent at gross winnings, not net profit"
```

---

## Task 3: Idempotent fill recording — dedup redelivered fills in `bookkeeping.ts`

**Files:**
- Modify: `src/model/model.ts` (`Trade` class)
- Modify: `src/processes/order/bookkeeping.ts:343-369` (`recordFill`, `updateTradeFromPrismMessage`)
- Modify: `src/processes/order/zerodhaExecutor.ts` (5 call sites)
- Modify: `src/processes/order/antExecutor.ts` (1 call site)
- Modify: `src/processes/order/pendingLimitOrders.ts` (1 call site)
- Test: `src/test/bookkeepingDedup.test.ts` (new)

**Interfaces:**
- Produces: `Trade.brokerOrderId?: string` — set by callers when a broker order id is available at the point of construction.
- Produces (bookkeeping.ts): `recordFill(tradeEvent: Trade): Promise<void>` (signature unchanged) now dedupes on `tradeEvent.brokerOrderId` when present.

**Context:** Every executor calls `bookkeeping.recordFill(trade)` directly with no fill/order-id tracked for dedup (`bookkeeping.ts:343-346`). A redelivered fill event (reconnect replay, webhook retry) re-runs the sell branch, double-subtracting `sellQty` and double-`persistClosedTrade`-ing — double-counting both in-memory `userPnL` and the Mongo `closedTrades` collection that `payout.ts`'s `grossProfit` sums directly. Fix: thread the broker's own order id through onto `Trade.brokerOrderId` at every call site where one is already available (all of them, except Prism's synchronous `buyContract`/`sellContract` REST wrappers, which aren't subject to redelivery — each call already corresponds to exactly one real order placement, not an async fill-notification channel), and dedupe on it in `recordFill`.

- [ ] **Step 1: Write the failing test**

Create `src/test/bookkeepingDedup.test.ts`:

```ts
/**
 * Verifies bookkeeping.recordFill ignores a redelivered fill for the same
 * brokerOrderId instead of double-booking P&L.
 * Run: npm run build (compile), then: node ./dist/test/bookkeepingDedup.test.js
 */

import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function buy(brokerOrderId: string): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tok1';
    t.quantity = 65;
    t.price = 100;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = 'DedupTestUser';
    t.brokerOrderId = brokerOrderId;
    return t;
}

function sell(brokerOrderId: string, price: number): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tok1';
    t.quantity = 65;
    t.price = price;
    t.action = 'Sell';
    t.status = 'COMPLETE';
    t.user = 'DedupTestUser';
    t.brokerOrderId = brokerOrderId;
    return t;
}

async function main() {
    await bookkeeping.recordFill(buy('order-1'));
    await bookkeeping.recordFill(sell('order-2', 120));
    const pnlAfterOneSell = bookkeeping.userPnL.get('DedupTestUser') || 0;
    assert(pnlAfterOneSell === 1300, `first sell books real P&L (got ${pnlAfterOneSell})`);

    // Redeliver the exact same sell fill (same brokerOrderId) - must be ignored.
    await bookkeeping.recordFill(sell('order-2', 120));
    const pnlAfterRedelivery = bookkeeping.userPnL.get('DedupTestUser') || 0;
    assert(pnlAfterRedelivery === 1300, `redelivered fill is not double-booked (got ${pnlAfterRedelivery})`);

    // A genuinely new order id must still be processed normally.
    await bookkeeping.recordFill(buy('order-3'));
    await bookkeeping.recordFill(sell('order-4', 110));
    const pnlAfterSecondTrade = bookkeeping.userPnL.get('DedupTestUser') || 0;
    assert(pnlAfterSecondTrade === 1950, `a new brokerOrderId is processed normally (got ${pnlAfterSecondTrade})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/bookkeepingDedup.test.js`
Expected: compile error — `Trade.brokerOrderId` doesn't exist yet. (After adding the field alone, but before the dedup logic, the "redelivered fill" assertion would FAIL at runtime with `pnlAfterRedelivery === 2600`.)

- [ ] **Step 3: Add `brokerOrderId` to `Trade`**

In `src/model/model.ts`, in the `Trade` class (`:82-113`), add next to the other optional broker-reference fields:

```ts
    gttTriggerId: number // Zerodha GTT trigger id, if a bracket was placed at entry (setTargetStopLoss modifies it later)
    antOrderNo?: string // AliceBlue BO order number, if a bracket was placed at entry
    brokerOrderId?: string // broker's own order id for this specific fill, when the caller has one - used by bookkeeping.recordFill to dedup a redelivered fill event (reconnect replay, webhook retry)
```

- [ ] **Step 4: Dedup in `bookkeeping.recordFill`**

In `src/processes/order/bookkeeping.ts`, add a new field on the class (near `userPnL`/`pendingUsers`, `:38-39`):

```ts
    // brokerOrderId values already processed by recordFill, so a redelivered
    // fill event (reconnect replay, webhook retry) doesn't double-book P&L.
    // In-memory/per-process-lifetime only - matches this file's existing
    // in-memory-state conventions (see CLAUDE.md).
    private processedFillIds: Set<string> = new Set();
```

Replace `recordFill` (`:343-346`) with:

```ts
    async recordFill(tradeEvent: Trade): Promise<void> {
        if (tradeEvent.brokerOrderId) {
            if (this.processedFillIds.has(tradeEvent.brokerOrderId)) {
                Log.log(`[order] Ignoring redelivered fill for broker order ${tradeEvent.brokerOrderId} (${tradeEvent.tsym}) - already processed`);
                return;
            }
            this.processedFillIds.add(tradeEvent.brokerOrderId);
        }
        await this._processTradeEvent(tradeEvent);
        for (const l of this.fillListeners) l(tradeEvent.user || 'Default', tradeEvent);
    }
```

In `updateTradeFromPrismMessage` (`:349-369`), set the field on `tradeEvent` right after `tradeEvent.user = user;`:

```ts
        tradeEvent.user = user;
        tradeEvent.brokerOrderId = data.norenordno;
```

- [ ] **Step 5: Thread `brokerOrderId` through the Zerodha executor**

In `src/processes/order/zerodhaExecutor.ts`:

`buyIndexOnZerodha` (after `trade.user = req.userId;`, `:119`):
```ts
    trade.user = req.userId;
    trade.brokerOrderId = orderId;
```

`buyContractOnZerodha` (after `trade.user = userId;`, `:191`):
```ts
    trade.user = userId;
    trade.brokerOrderId = orderId;
```

`squareOffOnZerodha` (after `trade.user = userId;`, `:244`):
```ts
    trade.user = userId;
    trade.brokerOrderId = response.order_id;
```

`marketBuyBareOnZerodha` (after `trade.user = userId;`, `:274`):
```ts
    trade.user = userId;
    trade.brokerOrderId = orderId;
```

`marketSellBareOnZerodha` (after `trade.user = userId;`, `:304`):
```ts
    trade.user = userId;
    trade.brokerOrderId = response.order_id;
```

- [ ] **Step 6: Thread `brokerOrderId` through the ANT executor**

In `src/processes/order/antExecutor.ts`, in the buy-entry function (after `trade.user = userId;`, the line right after `trade.action = 'Buy';` in the block that follows `waitForFill(orderNo)`):

```ts
    trade.user = userId;
    trade.brokerOrderId = orderNo;
```

- [ ] **Step 7: Thread `brokerOrderId` through the pending-limit-order poller**

In `src/processes/order/pendingLimitOrders.ts`, in `pollPendingLimitOrders`'s fill branch, after `trade.user = order.userId;`:

```ts
                trade.user = order.userId;
                trade.brokerOrderId = orderId;
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx tsc && node dist/test/bookkeepingDedup.test.js`
Expected: `ALL TESTS PASSED`, all three assertions PASS.

- [ ] **Step 9: Commit**

```bash
git add src/model/model.ts src/processes/order/bookkeeping.ts src/processes/order/zerodhaExecutor.ts src/processes/order/antExecutor.ts src/processes/order/pendingLimitOrders.ts src/test/bookkeepingDedup.test.ts
git commit -m "fix: dedup redelivered broker fills so P&L is never double-booked"
```

---

## Task 4: Fix `monitor.ts`'s partial-sell handling

**Files:**
- Modify: `src/monitor.ts:437-465` (`_processTradeEvent`, sell branch)
- Test: `src/test/monitorPartialSell.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new (behavioral fix only — brings `monitor.ts`'s sell branch to parity with the already-correct `bookkeeping.ts:392-446`).

**Context:** `src/monitor.ts:445`: `realizedPnL = (tradeEvent.price - buyTrade.price) * buyTrade.quantity` uses the **whole open quantity**, not the quantity actually sold in this fill, then unconditionally `splice`s the whole position out of tracking (`:455`) regardless of whether the sell was partial. `bookkeeping.ts:408-440` already does this correctly (reduce by `sellQty`, only remove once `buyTrade.quantity <= 0`) — port that same logic into `monitor.ts`. `monitor.ts` is legacy/off the live order-execution path (see `[[live_trading_process_split]]` in project memory) but its class/methods are still fully wired live code per `Analysis.md` §4 Critical #4, so this is a real fix, not dead-code cleanup.

- [ ] **Step 1: Write the failing test**

Create `src/test/monitorPartialSell.test.ts`:

```ts
/**
 * Verifies monitor.ts's sell branch reduces by the sold quantity instead of
 * closing the whole position on a partial sell.
 * Run: npm run build (compile), then: node ./dist/test/monitorPartialSell.test.js
 */

import Monitor from '../monitor';
import { Trade, OptionQuote } from '../model/model';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function buy(qty: number, price: number): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tokPartial';
    t.quantity = qty;
    t.price = price;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = 'PartialSellTestUser';
    return t;
}

function sell(qty: number, price: number): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tokPartial';
    t.quantity = qty;
    t.price = price;
    t.action = 'Sell';
    t.status = 'COMPLETE';
    t.user = 'PartialSellTestUser';
    return t;
}

async function main() {
    const monitor = Monitor.getInstance();
    await (monitor as any)._processTradeEvent(buy(100, 100));

    // Sell only 40 of the 100 - a partial fill.
    await (monitor as any)._processTradeEvent(sell(40, 120));

    const remaining = monitor.trades.find((t: Trade) => t.tsym === 'NIFTY26AUG24100CE' && t.user === 'PartialSellTestUser');
    assert(!!remaining, 'the remaining 60 stays tracked as an open position');
    assert(remaining?.quantity === 60, `remaining open quantity is 60 (got ${remaining?.quantity})`);

    const pnl = monitor.userPnL.get('PartialSellTestUser') || 0;
    assert(pnl === 800, `realized P&L is on the 40 actually sold, not the full 100 (got ${pnl})`);

    // Sell the rest - position should now close out.
    await (monitor as any)._processTradeEvent(sell(60, 130));
    const afterFullClose = monitor.trades.find((t: Trade) => t.tsym === 'NIFTY26AUG24100CE' && t.user === 'PartialSellTestUser');
    assert(!afterFullClose, 'position is removed once fully closed');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/monitorPartialSell.test.js`
Expected: FAIL — `remaining` is `undefined` (the whole position was spliced out on the partial sell), and the P&L assertion fails (`(130-100)*100 = 3000` booked instead of `800`).

- [ ] **Step 3: Port `bookkeeping.ts`'s reduce-by-sellQty logic into `monitor.ts`**

Replace the sell branch in `src/monitor.ts:437-465` with:

```ts
        } else {
            // Match by tsym AND user so each strategy's sell only closes its own trade
            const index = this.trades.findIndex(t => t.tsym == tradeEvent.tsym && t.user == tradeEvent.user);

            if (index != -1) {
                const buyTrade = this.trades[index];
                Log.log('buyTrade: ', buyTrade)
                const user = buyTrade.user || 'Default';

                // Reduce by the sold quantity instead of closing the whole
                // position - a sell can be partial (matches bookkeeping.ts's
                // already-correct handling, src/processes/order/bookkeeping.ts:408-440).
                let sellQty = tradeEvent.quantity;
                if (sellQty > buyTrade.quantity) {
                    Log.log(`[Monitor] WARNING: sell qty ${sellQty} for ${tradeEvent.tsym} (${user}) exceeds tracked open qty ${buyTrade.quantity} - clamping`);
                    sellQty = buyTrade.quantity;
                }

                const realizedPnL = (tradeEvent.price - buyTrade.price) * sellQty;
                buyTrade.realizedPnL = realizedPnL
                const cumulative = (this.userPnL.get(user) || 0) + realizedPnL;
                this.userPnL.set(user, cumulative);
                Log.log(`[Monitor] User '${user}' closed. P&L: ${realizedPnL.toFixed(2)}, Cumulative: ${cumulative.toFixed(2)}`);

                Log.log('Trade is closed ', tradeEvent.tsym, ' ', tradeEvent.quantity, ' Enabled auto trade: ', Config.auto)

                buyTrade.quantity -= sellQty;
                if (buyTrade.quantity <= 0) {
                    buyTrade.open = false;
                    this.closedTrades.push(buyTrade);
                    this.trades.splice(index, 1)
                    // Only unsubscribe if no other strategy still holds this token
                    const stillHeld = this.trades.some(t => t.token === tradeEvent.token);
                    if (!stillHeld) {
                        Log.log(`[MOCK] Unsubscribing token ${tradeEvent.token} (no more holders)`);
                        try { await AntStream.getInstance()?.unsubscribeOption(tradeEvent.token); } catch (e) { /* AntStream not available */ }
                    } else {
                        Log.log(`[MOCK] Keeping subscription for token ${tradeEvent.token} (other strategies still hold it)`);
                    }
                }
            }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc && node dist/test/monitorPartialSell.test.js`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/monitor.ts src/test/monitorPartialSell.test.ts
git commit -m "fix: monitor.ts reduces by sold quantity on a partial sell instead of closing the whole position"
```

---

## Task 5: Fix `monitor.ts` conflating unrealized and realized P&L on open trades

**Files:**
- Modify: `src/monitor.ts:338-343` (`updateQuote`)
- Test: `src/test/monitorPartialSell.test.ts` (extend from Task 4)

**Interfaces:** none new.

**Context:** `src/monitor.ts:343` sets `matchingTrade.realizedPnL = (lastTradePrice - price) * quantity` on **every tick** for an open trade, only overwritten with the true realized value on close (now `:` inside the sell branch fixed in Task 4). Any consumer reading `trade.realizedPnL` on an open position would see unrealized (mark-to-market) P&L mislabeled as realized. Fix: track the live mark-to-market number as `trade.lastTradePrice`-derived unrealized P&L on a distinct field (the `Trade` model already has no dedicated unrealized field — add one, `unrealizedPnL`) and stop writing `realizedPnL` on open trades entirely; it should only ever be set once, at close.

- [ ] **Step 1: Add the failing assertion**

Append to `src/test/monitorPartialSell.test.ts`, inside `main()` before the final `if (process.exitCode === 1)` block:

```ts
    // A fresh open position must not have realizedPnL set from live ticks -
    // that field means "P&L booked at close", not "current mark-to-market".
    await (monitor as any)._processTradeEvent(buy(50, 100));
    const openTrade = monitor.trades.find((t: Trade) => t.tsym === 'NIFTY26AUG24100CE' && t.user === 'PartialSellTestUser');
    const tickQuote = Object.assign(new OptionQuote(), { token: 'tokPartial', ltp: 150 });
    await monitor.updateQuote(tickQuote);
    assert(openTrade?.realizedPnL === undefined, `realizedPnL stays unset on an open trade after a tick (got ${openTrade?.realizedPnL})`);
    assert(openTrade?.unrealizedPnL === 2500, `unrealizedPnL reflects the live mark-to-market (got ${openTrade?.unrealizedPnL})`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/monitorPartialSell.test.js`
Expected: FAIL — `realizedPnL` is `2500` (wrongly set by the live tick), and `unrealizedPnL` is `undefined` (field doesn't exist yet).

- [ ] **Step 3: Add `unrealizedPnL` to `Trade` and fix `updateQuote`**

In `src/model/model.ts`'s `Trade` class, next to `realizedPnL`:

```ts
    realizedPnL: number
    unrealizedPnL: number // live mark-to-market on an open position - distinct from realizedPnL, which is only ever set once, at close
```

In `src/monitor.ts:338-343`, change:

```ts
                matchingTrade.lastTradePrice = optionQuote.ltp;
                matchingTrade.realizedPnL = (matchingTrade.lastTradePrice - matchingTrade.price) * matchingTrade.quantity;
```

to:

```ts
                matchingTrade.lastTradePrice = optionQuote.ltp;
                matchingTrade.unrealizedPnL = (matchingTrade.lastTradePrice - matchingTrade.price) * matchingTrade.quantity;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc && node dist/test/monitorPartialSell.test.js`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/model/model.ts src/monitor.ts src/test/monitorPartialSell.test.ts
git commit -m "fix: monitor.ts stops mislabeling unrealized P&L as realizedPnL on open trades"
```

---

## Task 6: Stop silently swallowing Prism order-placement failures

**Files:**
- Modify: `src/prism.ts:1127-1156` (`_placeOrderWithForce`), `:635-661` (`sellContract`), `:773-818` (`buyContract`)
- Modify: `src/processes/order/prismExecutor.ts:92-111` (`sellContract` wrapper)

**Interfaces:**
- Changes: `Prism.sellContract(contract, qty, price, user?)` return type changes from `Promise<void>` to `Promise<{ filledQty: number }>`. Every other existing caller (`monitor.ts:82`, `strategy.ts:156`, and several strategy files — all `await` it and discard the return value) is source-compatible with this change; only `prismExecutor.ts`'s wrapper is updated to use the new return value.
- Changes: `Prism.buyContract(...)`'s existing return shape is unchanged (`{ contract, qty, price, ... }`), but `qty` now reflects the actually-filled quantity, not the originally requested one.

**Context:** `_placeOrderWithForce` (`:1127-1156`) catches the broker call's exception, logs it, and returns `undefined` — never re-throws. `sellContract` (`:635-661`) loops per-leg over `splitQty(qty)` (splits orders above the exchange's max single-order size) and ignores the return value entirely — a failed leg is invisible. `buyContract` (`:773-818`) does the same, then unconditionally sets `response.qty = qty` (`:817`) — the originally *requested* quantity, not what actually filled; if an earlier leg fails and a later one succeeds, the response silently reflects only the last leg's data at full requested size. Both flow into `prismExecutor.ts:54-71`/`:92-111`, which call `bookkeeping.recordFill(trade)` unconditionally — recording a fill that may not have happened (or happened at a smaller quantity), corrupting position/P&L/limit accounting with no alert.

Fix: (1) `_placeOrderWithForce` stops swallowing the exception — it re-throws, wrapped in a `try/finally` so the pending-order tracking it sets up before the broker call is still cleaned up on failure (the current code only clears it on success, `:1135-1138` — removing the `catch` without a `finally` would introduce a *new* leak of stuck pending-order entries, so this is added alongside the un-swallow, not left as a follow-up). (2) `buyContract`'s and `sellContract`'s per-leg loops catch a leg failure locally, stop the loop, and report the real filled quantity — throwing only if *zero* legs filled (so `prismExecutor.ts` never calls `recordFill` for a trade that never happened), and logging a clear PARTIAL FILL warning otherwise (so a partial fill is recorded at its real size instead of either "phantom full size" or "lost entirely").

- [ ] **Step 1: Write the failing test**

Create `src/test/prismOrderFailures.test.ts`:

```ts
/**
 * Verifies Prism.buyContract reports the real filled quantity (not the
 * requested one) when a later leg fails, and throws rather than silently
 * succeeding when every leg fails.
 * Run: npm run build (compile), then: node ./dist/test/prismOrderFailures.test.js
 */

import Prism from '../prism';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    const prism = Prism.getInstance() as any;

    // Stub _placeOrderWithForce: succeed on the first call, throw on the second.
    let call = 0;
    prism._placeOrderWithForce = async (order: any) => {
        call++;
        if (call === 2) throw new Error('simulated broker rejection');
        return { contract: order.tsym, qty: order.qty, price: order.prc, token: 'tok', profit: 0, status: 'ORDERED' };
    };
    prism.getToken = async () => 'tok';
    prism.findLotSizeByContract = async () => '1';
    prism.getStockOptionQuote = async () => ({ ltp: 100 });

    // Force a 2-leg split by requesting a quantity splitQty() will divide -
    // check src/prism.ts's splitQty threshold and adjust the requested qty
    // here if 3600 doesn't actually split into exactly 2 legs.
    let threw = false;
    let partialResponse: any = null;
    try {
        partialResponse = await prism.buyContract('NIFTY26AUG24100CE', 3600, 100, undefined);
    } catch (e) {
        threw = true;
    }
    assert(!threw, 'a partial fill (leg 1 ok, leg 2 fails) does not throw - it reports the real filled qty');
    assert(partialResponse?.qty < 3600, `reported qty reflects only what actually filled (got ${partialResponse?.qty})`);

    // All legs fail -> must throw, not silently return a phantom full fill.
    call = 0;
    prism._placeOrderWithForce = async () => { throw new Error('simulated broker rejection'); };
    let allFailedThrew = false;
    try {
        await prism.buyContract('NIFTY26AUG24100CE', 65, 100, undefined);
    } catch (e) {
        allFailedThrew = true;
    }
    assert(allFailedThrew, 'buyContract throws when every leg fails, instead of returning a phantom fill');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/prismOrderFailures.test.js`
Expected: FAIL — today, a leg failure inside `_placeOrderWithForce` is swallowed (returns `undefined`), so `buyContract`'s loop doesn't throw on either case the way this test expects, and `response.qty` is the originally-requested `qty`, not a reduced real amount.

- [ ] **Step 3: Fix `_placeOrderWithForce`**

In `src/prism.ts:1127-1156`:

```ts
    _placeOrderWithForce = async (order, user?: string) => {
        Log.log('Place Order ', order);
        if (user) {
            bookkeeping.trackPendingOrder(order.tsym, user);
        }
        try {
            const response = await NorenRestApi.place_order(order) as any;
            Log.log('User: ', user, 'Response from place_order: ', response)
            if (user && response?.norenordno) {
                bookkeeping.trackOrder(response.norenordno, user);
            }
            const token = await this.getToken(order.tsym);
            if (!MOCK_BROKER) {
                await delay(2000)
            }
            Log.log('Returning price ', order.prc, ' for ', order.tsym)

            return {
                "contract": order.tsym,
                "qty": order.qty,
                "price": order.prc,
                "lastOrderedPrice": order.prc,
                "token": token,
                "profit": 0,
                "status": OrderStatus.ORDERED
            }
        } finally {
            if (user) bookkeeping.clearPendingOrder(order.tsym, user);
        }
    }
```

(No more `catch` — a broker-call failure now propagates to the caller. `clearPendingOrder` moves into `finally` so it still runs on failure, not just success — otherwise removing the catch would leak a stuck pending-order entry on every failed order.)

- [ ] **Step 4: Fix `buyContract`'s loop**

In `src/prism.ts:773-818`, replace the per-leg loop and trailing `response.qty = qty`:

```ts
        const transactionType = 'B'
        const limit = "LMT"
        const nse = "NFO"
        const normal = "M" //for fno
        let response: any = {};
        let filledQty = 0;
        let lastError: any = null;

        const parts = splitQty(qty)
        for (let i = 0; i < parts.length; i++) {
            const partQty = parts[i];
            const order = {
                "trantype": transactionType,
                "prd": normal,
                "exch": nse,
                "tsym": contract,
                "qty": partQty,
                "prctyp": limit,
                "prc": price
            }

            try {
                response = await this._placeOrderWithForce(order, user)
                Log.log(`[Order] Placed ${response?.tsym} orderId=${response?.norenordno} qty=${response?.qty} price=${response?.prc}`)
                filledQty += partQty;
            } catch (e) {
                lastError = e;
                Log.log(`[Order] Leg ${i + 1}/${parts.length} FAILED for ${contract} (qty ${partQty}) - stopping, ${filledQty} already filled:`, e);
                break;
            }
        }

        if (filledQty === 0) {
            throw lastError ?? new Error(`buyContract: no leg filled for ${contract} (requested qty ${qty})`);
        }
        if (lastError) {
            Log.log(`[Order] buyContract PARTIAL FILL for ${contract}: ${filledQty}/${qty} - recording the real filled quantity, not the requested one`);
        }
        response.qty = filledQty
        return response
```

- [ ] **Step 5: Fix `sellContract`'s loop and return type**

In `src/prism.ts:635-661`:

```ts
    sellContract = async(contract, qty, price, user?: string): Promise<{ filledQty: number }> => {

        Log.log('In Sell Contract contract: ', contract, ' price: ', price)
        if (!price) {
            const quote = await this.getStockOptionQuote(contract);
            price = quote.ltp
        }

        const transactionType = 'S'
        const limit = "LMT"
        const nse = "NFO"
        const normal = "M" //for fno

        let filledQty = 0;
        let lastError: any = null;
        const parts = splitQty(qty)
        for (let i = 0; i < parts.length; i++) {
            const order = {
                "trantype": transactionType,
                "prd": normal,
                "exch": nse,
                "tsym": contract,
                "qty": parts[i],
                "prctyp": limit,
                "prc": price
            }

            try {
                await this._placeOrderWithForce(order, user)
                filledQty += parts[i];
            } catch (e) {
                lastError = e;
                Log.log(`[Order] sellContract leg ${i + 1}/${parts.length} FAILED for ${contract} (qty ${parts[i]}) - stopping, ${filledQty} already sold:`, e);
                break;
            }
        }

        if (filledQty === 0) {
            throw lastError ?? new Error(`sellContract: no leg filled for ${contract} (requested qty ${qty})`);
        }
        if (lastError) {
            Log.log(`[Order] sellContract PARTIAL FILL for ${contract}: ${filledQty}/${qty}`);
        }
        return { filledQty };
    }
```

- [ ] **Step 6: Update `prismExecutor.ts`'s `sellContract` wrapper to use the real filled quantity**

In `src/processes/order/prismExecutor.ts:92-111`:

```ts
export async function sellContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
    Log.log(`[order] Selling (Prism) ${contract} qty=${quantity} for ${userId}`);
    const resolvedPrice = price ?? (await Prism.getInstance().getStockOptionQuote(contract)).ltp;
    const { filledQty } = await Prism.getInstance().sellContract(contract, quantity, resolvedPrice, userId);

    const trade = new Trade();
    trade.tsym = contract;
    trade.token = await Prism.getInstance().getToken(contract);
    trade.quantity = filledQty;
    trade.price = resolvedPrice;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;

    await bookkeeping.recordFill(trade);
    return trade;
}
```

(`buyContract`'s wrapper, `prismExecutor.ts:54-71`, already uses `response.qty` from `Prism.buyContract`'s return value — no change needed there, it automatically picks up the now-correct filled quantity from Step 4.)

- [ ] **Step 7: Run test to verify it passes**

Run: `npx tsc && node dist/test/prismOrderFailures.test.js`
Expected: `ALL TESTS PASSED`. If the "2-leg split" assumption in Step 1's test doesn't actually produce 2 legs for a requested qty of 3600 (check `splitQty`'s threshold in `src/prism.ts` — grep `function splitQty` or `splitQty =`), adjust the requested quantity in the test to whatever genuinely splits into 2+ legs.

- [ ] **Step 8: Commit**

```bash
git add src/prism.ts src/processes/order/prismExecutor.ts src/test/prismOrderFailures.test.ts
git commit -m "fix: Prism order placement no longer silently swallows failures or reports phantom full-quantity fills"
```

---

## Self-Review Notes

- **Spec coverage:** Punch-list items 1-5 are each covered by exactly one task (1→Task 1, 2→Task 6, 3→Task 2, 4→Task 4, 5→Task 5) — item 2 (Prism silent failures) was initially miscategorized as belonging to the Reliability plan and omitted; corrected during self-review by adding Task 6.
- **Placeholder scan:** none — every step has real code, real file:line anchors, real run commands.
- **Type consistency:** `Trade.brokerOrderId`/`Trade.unrealizedPnL` are declared once (Tasks 3 and 5) and used with the same names everywhere they're referenced afterward. `Prism.sellContract`'s new `Promise<{ filledQty: number }>` return type (Task 6) is consumed only by the one call site updated in the same task.
- Tasks 1-2 (both in `payout.ts`) and Tasks 4-5 (both in `monitor.ts`) are ordered so the second task's diff lands cleanly on top of the first's — execute each plan's tasks in order. Task 6 (`src/prism.ts`) is independent of Tasks 1-5 and can run in any order relative to them.
