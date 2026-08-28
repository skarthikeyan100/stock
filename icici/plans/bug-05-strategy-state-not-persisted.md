# Bug: Strategy state isn't persisted across restarts

## Problem

`BuySellStrategy`'s "position already open" flag (`this.ordered`) and its cooldown
timer (`Strategy.lastTriggerTime`, gated via `isCooldownElapsed()`) live only in
the `strategies` process's memory. The `strategies` process is restarted
frequently in normal dev (it runs under `tsc-watch` and is explicitly designed
to be "killed and respawned on every strategy code change" — see the comment
block at the top of `src/processes/strategiesProcess.ts`).

On every such restart, a fresh `BuySellStrategy` instance is constructed with
`ordered = false` and `lastTriggerTime = 0`, with **no knowledge of whether the
`order` process is still holding an open position from before the restart**.
If NIFTY entry conditions still hold on the very next tick after restart,
`processNiftyQuote()` will happily fire a second, duplicate entry order against
a position `order` already holds — because nothing in the `strategies` process
today ever asks `order` "do I already have an open position for this user?"
before firing.

`OrderClient.stats()` (`src/processes/strategies/OrderClient.ts`) already
exists and can answer exactly that question (it round-trips to the `order`
process and returns, among other things, the process-wide list of currently
open `trades`), but it is never called during `BuySellStrategy` construction or
`strategies` process startup — this is the gap this plan closes.

## Root cause (exact files/lines)

- `src/strategy/strategy.ts:22` — base `Strategy` class field `ordered = false`
  (in-memory only, no persistence).
- `src/strategy/strategy.ts:37-40` — `isCooldownElapsed()`, gated by
  `Strategy.lastTriggerTime` (`src/strategy/strategy.ts:35`), which is also
  in-memory only and reset to `0` on every restart (fresh instance).
- `src/strategy/BuySellStrategy.ts:212` — `BuySellStrategy` shadows the base
  field with its own `ordered = false`.
- `src/strategy/BuySellStrategy.ts:215-220` — constructor does not consult the
  `order` process at all; a freshly constructed instance always starts
  believing no position is open.
- `src/strategy/BuySellStrategy.ts:267-268` — `processNiftyQuote()`'s entry gate:
  `if (enabled && this.isTimeInRange() && !this.ordered && this.isCooldownElapsed(...))`
  — this is the exact condition that can fire a duplicate entry order on the
  first qualifying tick after a restart, since `!this.ordered` is `true` for
  every freshly constructed instance regardless of what `order` is actually
  holding.
- `src/processes/strategies/OrderClient.ts` — `stats()` method (near the end of
  the class) exists and is never called from `BuySellStrategy` or from
  `strategies` process startup (`src/strategy/strategies.ts`'s `initialize()`,
  `src/strategy/StrategyFactory.ts`'s `createStrategy()`, or
  `src/processes/strategiesProcess.ts`'s `main()`).

### Supporting investigation (confirmed by reading the code)

- `OrderClient.stats(userId = 'Default')` signature:
  ```ts
  async stats(userId = 'Default'): Promise<{ trades: any[]; closedTrades: any[]; userPnL: Record<string, number> }> {
      const res = await this.request('stats', userId, {});
      if (!res.ok) throw new Error(res.error);
      return res.result;
  }
  ```
  The corresponding IPC handler in `src/processes/orderProcess.ts` (the
  `case 'stats':` branch) **ignores `req.userId` entirely** and always returns
  the full, process-wide state:
  ```ts
  case 'stats':
      return {
          kind: 'response',
          id: req.id,
          ok: true,
          result: {
              trades: bookkeeping.trades,
              closedTrades: bookkeeping.closedTrades,
              userPnL: Object.fromEntries(bookkeeping.userPnL),
          },
      };
  ```
  So the caller (our reconciliation code) must filter `result.trades` by
  `t.user === this.userId` itself — `stats()` does not do per-user filtering
  server-side despite taking a `userId` argument.

- `bookkeeping.trades` (`src/processes/order/bookkeeping.ts:37`) is a flat,
  process-wide array of currently-**open** `Trade` objects (closed trades are
  spliced out into `closedTrades` — see `bookkeeping.ts:479`). Each `Trade`
  (`src/model/model.ts:99+`) carries `user: string`, `tsym: string`,
  `token: string`, `price: number`, `quantity: number` — enough to both find a
  match for a given strategy userId and to rehydrate `BuySellStrategy`'s
  `Contract` state (symbol/token/price/qty) for that match.

- `BuySellStrategy` is instantiated via `createStrategy()` in
  `src/strategy/StrategyFactory.ts` (`new StrategyClass(userId)`), which is
  called from `createStrategiesFromConfig()`, called from
  `src/strategy/strategies.ts`'s `Strategies.initialize()`, called from
  `src/processes/strategiesProcess.ts`'s `main()`:
  ```ts
  OrderClient.getInstance().connect();   // fire-and-forget: kicks off net.createConnection, does NOT await 'connect'
  startStrategiesServer();
  ...
  await strategies.initialize();          // constructs all strategies, including BuySellStrategy, synchronously in a .map()
  ```
  Critically, `OrderClient.connect()` (`src/processes/strategies/OrderClient.ts`)
  is **not awaited to actually finish connecting** — it calls
  `net.createConnection(...)` and returns immediately; `this.connected` only
  flips to `true` later, asynchronously, on the socket's `'connect'` event.
  `OrderClient.request()` immediately rejects with `Error('Not connected to
  order process')` if `!this.connected` at call time. This means: **the very
  first `stats()` call made from inside a strategy's constructor, at process
  startup, will very likely fail** because the IPC socket to `order` has not
  finished connecting yet. Any reconciliation logic must tolerate and retry
  through this race, not treat a single failure as "no open position."

- `ordered`/cooldown is **not** a base-class-only concern: `grep -n "ordered"
  src/strategy/*.ts` shows `BuySellStrategy`, `DiffStrategy`, `HighLotStrategy`,
  `PivotStrategy`, `SentimentStrategy`, `BiDirectionStrategy`,
  `ContinuousStrategy`, and `IntermittentStrategy` **all** declare their own
  shadowing `ordered = false` field and manage it with their own, strategy-specific
  gating logic (different signal conditions, different reset triggers, etc.) —
  there is no single shared code path all of them funnel through. A fully
  general fix would need to touch every one of those files' individual
  entry-gate logic, which is out of scope for this bug (the bug report is
  explicitly scoped to `BuySellStrategy`). **This plan fixes `BuySellStrategy`
  only.** The same pattern (a small, self-contained `reconcileOrderState()`
  method invoked from the constructor, following the exact shape below) can be
  copied into the other strategy classes in a follow-up — flag this to the user
  after this fix lands, but do not do it as part of this plan.

## Fix design (approach + rationale)

1. **Fail-safe default, not fail-open.** The moment a `BuySellStrategy` is
   constructed, before any network round trip to `order` can possibly
   complete, set `this.ordered = true`. This is a deliberate defensive choice:
   the failure mode of "we think a position is open when it actually is not"
   is a missed entry (recoverable — the strategy will simply try again on the
   next qualifying tick after `enabled`/`isTimeInRange` conditions are still
   met, since `ordered` gets corrected to `false` moments later once
   reconciliation completes). The failure mode of the *opposite* default
   (`ordered = false` until proven otherwise) is a duplicate live order against
   a real position — an actual money-losing bug, and the exact bug being
   fixed here. Fail-safe direction is unambiguous: default to blocked.

2. **Reconcile asynchronously, retry through the startup connection race.**
   `OrderClient.stats()` is a network round trip over the strategies↔order
   Unix socket (see `OrderClient.request()`), and that socket is frequently
   *not yet connected* this early in `strategies` process startup (see
   investigation notes above: `connect()` is fire-and-forget, `strategies.initialize()`
   runs immediately after without waiting for the `'connect'` event).
   TypeScript constructors cannot be `async`, so the constructor kicks off a
   new `private async reconcileOrderState()` method without awaiting it
   (fire-and-forget from the constructor's point of view), and that method
   retries on failure with a fixed delay (15 attempts × 2s = up to ~30s of
   grace) before giving up. If it exhausts all retries, it deliberately leaves
   `ordered = true` (the fail-safe default from step 1) rather than falling
   back to `false` — a stuck-safe strategy (blocked from entering) is the
   correct failure mode; it can be manually cleared via the existing
   `POST /strategies/reset`-style admin path (`Strategy.reset()`, already
   wired to an existing endpoint per `src/processes/strategiesProcess.ts`'s
   `case 'reset':`) once the operator has confirmed there is in fact no open
   position.

3. **Match on `userId`, not on instrument/token.** `bookkeeping.trades` (what
   `stats().trades` returns) carries a `user` field that is exactly the same
   `userId` string `BuySellStrategy` uses to attribute all of its own orders
   (`this.userId`, passed into every `OrderClient` call). Since each configured
   `BuySellStrategy` instance trades under its own dedicated `userId` (per
   `StrategyFactory.createStrategy()`: `const userId = config.userId || config.type`),
   `t.user === this.userId` is a sufficient and correct match condition — no
   separate instrument/token matching is needed (and token matching would
   actually be *wrong*: `BuySellStrategy` picks its own contract via
   `getContractByPriceRange()` fresh on every real entry, it doesn't have a
   fixed instrument to match against ahead of time).

4. **Rehydrate `this.contract`, not just the boolean.** Setting `ordered = true`
   alone would permanently freeze this strategy instance (it would never place
   a duplicate entry, but it would also never process option ticks for the
   position it's supposedly protecting, since `canHandleOptionQuote()` checks
   `this.contract.token`, which would be `undefined` on a bare, un-rehydrated
   `Contract`). So when a matching open trade is found, reconciliation also
   constructs a fresh `Contract` and fills in `contract`/`token`/`price`/`qty`/
   `lastOrderedPrice`/`lastOrderedQuantity` from the matched `Trade`, so the
   instance behaves, from that point on, indistinguishably from one that placed
   the entry itself in this process lifetime.

5. **Fresh cooldown, not recovered cooldown.** The `order` process does not
   record *when* a trade was originally opened in a form `stats()` exposes
   (no reliable `entryTime` guarantee is asserted here — do not depend on one).
   So the original cooldown start time is unrecoverable. Per the bug's own
   guidance: when a matching open position is found, call
   `this.recordTriggerTime()` to start a **fresh** cooldown window immediately,
   so that the instant this reconciled position later closes (via the normal
   `updateTrade()` → `this.ordered = false` path), the strategy does not
   immediately re-fire a brand new entry on the very next tick — it still has
   to wait out one full cooldown window, same as a normal freshly-closed trade
   would.

## Exact code changes

### File: `src/strategy/BuySellStrategy.ts`

Locate this exact block (currently lines 209-222):

```typescript
export default class BuySellStrategy extends Strategy {
    contract: Contract = {} as Contract
    name: string;
    ordered = false


    constructor(userId?: string) {
        super(userId);
        this.tradeMap = new Map();
        this.name = 'BuySellStrategy';
        this.enabled = true
    }

    getMonitorConfig() {
```

Replace it with:

```typescript
export default class BuySellStrategy extends Strategy {
    contract: Contract = {} as Contract
    name: string;
    ordered = false
    // True until reconcileOrderState() (kicked off from the constructor) has
    // resolved at least once. Informational only - `ordered` is what actually
    // gates entries (see the fail-safe default set in the constructor below).
    reconciling = true


    constructor(userId?: string) {
        super(userId);
        this.tradeMap = new Map();
        this.name = 'BuySellStrategy';
        this.enabled = true
        // Fail-safe against duplicate entry orders across a `strategies` process
        // restart (e.g. tsc-watch in dev): default to "already ordered" until
        // reconcileOrderState() confirms - via the `order` process, the source of
        // truth for open positions - whether a position for this userId is
        // actually still open. Without this, a fresh instance would start with
        // ordered=false and could fire a duplicate entry order the moment a
        // qualifying tick arrives, even though `order` still holds a position
        // from before the restart. See reconcileOrderState() below.
        this.ordered = true;
        this.reconcileOrderState().catch((e) => {
            Log.log(this.userId, ' BuySellStrategy: reconcileOrderState failed permanently: ', e);
        });
    }

    // Reconciles in-memory `ordered`/`contract` state against the order
    // process's live trade list on startup. OrderClient.stats() is a network
    // round trip over the strategies<->order Unix socket, and that socket is
    // frequently not yet connected this early in `strategies` process startup
    // (see strategiesProcess.ts's main(): OrderClient.getInstance().connect()
    // is fired, then strategies.initialize() constructs strategies immediately
    // after, without waiting for the 'connect' event) - so this retries with a
    // fixed delay instead of giving up on the first failure.
    //
    // Cooldown state (lastTriggerTime) cannot be recovered exactly - the order
    // process does not record when the entry order was originally placed, only
    // that a trade is currently open. When a matching open trade is found, we
    // conservatively start a FRESH cooldown (recordTriggerTime()) rather than
    // leaving lastTriggerTime at 0, so this strategy instance does not
    // immediately re-fire the moment the reconciled position later closes.
    private async reconcileOrderState(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const stats = await OrderClient.getInstance().stats(this.userId);
                const openTrade = (stats.trades || []).find((t) => t.user === this.userId);
                if (openTrade) {
                    this.ordered = true;
                    this.contract = new Contract(this, openTrade.tsym);
                    this.contract.update(openTrade.token);
                    this.contract.price = openTrade.price;
                    this.contract.qty = openTrade.quantity;
                    this.contract.lastOrderedPrice = openTrade.price;
                    this.contract.lastOrderedQuantity = openTrade.quantity;
                    this.recordTriggerTime();
                    Log.log(this.userId, ' BuySellStrategy: reconciled - existing open trade found (', openTrade.tsym, '), ordered=true, cooldown restarted');
                } else {
                    this.ordered = false;
                    Log.log(this.userId, ' BuySellStrategy: reconciled - no existing open trade, ordered=false');
                }
                this.reconciling = false;
                return;
            } catch (e: any) {
                Log.log(this.userId, ` BuySellStrategy: reconcileOrderState attempt ${attempt}/${maxAttempts} failed: `, e?.message ?? e);
                if (attempt === maxAttempts) {
                    Log.log(this.userId, ' BuySellStrategy: reconcileOrderState exhausted retries - staying ordered=true (fail-safe) until a manual /strategies/reset');
                    this.reconciling = false;
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            }
        }
    }

    getMonitorConfig() {
```

Nothing else in `BuySellStrategy.ts` needs to change. Do not touch
`processNiftyQuote()`, `reset()`, `closeStrategy()`, or `updateTrade()` — their
existing `this.ordered = false`/`true` assignments are correct as-is and
compose correctly with the new constructor-time default (e.g. `reset()`
already unconditionally sets `this.ordered = false`, which remains the correct
manual override / recovery path if reconciliation ever gets stuck in the
exhausted-retries state).

No other files need code changes. (`OrderClient.ts`, `orderProcess.ts`,
`strategy.ts`, `strategiesProcess.ts`, `StrategyFactory.ts`, `strategies.ts`
are all read-only for this fix — `stats()` already returns everything needed.)

## New test file

Create `src/test/buySellStrategyReconciliation.test.ts` with exactly this
content:

```typescript
/**
 * Verifies BuySellStrategy reconciles its `ordered`/cooldown state against the
 * `order` process's live trade list on construction, so a `strategies` process
 * restart does not fire a duplicate entry order against a position `order`
 * still holds (see reconcileOrderState() in BuySellStrategy.ts).
 *
 * Follows continuousStrategyTest.ts's pattern of monkey-patching
 * (OrderClient as any).instance with a MockOrderClient instead of a live
 * `order` process/IPC/broker.
 *
 * Run: npm run build (compile), then: MOCK_BROKER=true node ./dist/test/buySellStrategyReconciliation.test.js
 */

import { NiftyQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import BuySellStrategy from '../strategy/BuySellStrategy';

// --- Mock OrderClient ---

class MockOrderClient {
    buyContractCalls: any[] = [];
    sellContractCalls: any[] = [];

    // What stats() returns - set per-test before constructing the strategy.
    statsTrades: any[] = [];

    private tokenCounter = 0;

    async calculateRight(_userId: string, _ltp?: number): Promise<string> {
        return 'call';
    }

    async getContractByPriceRange(_userId: string, right: string): Promise<string> {
        this.tokenCounter += 1;
        return `NIFTY-${right === 'call' ? 'CE' : 'PE'}-${24000 + this.tokenCounter}`;
    }

    async buyContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
        this.buyContractCalls.push({ userId, contract, quantity, price });
        this.tokenCounter += 1;
        return { contract, price: price ?? 100, qty: quantity, token: 'TOKEN_' + this.tokenCounter };
    }

    async sellContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
        this.sellContractCalls.push({ userId, contract, quantity, price });
        return { contract, price: price ?? 100, qty: quantity, token: 'SELL_TOKEN' };
    }

    async stats(_userId = 'Default'): Promise<{ trades: any[]; closedTrades: any[]; userPnL: Record<string, number> }> {
        return { trades: this.statsTrades, closedTrades: [], userPnL: {} };
    }
}

let mock: MockOrderClient;

function installMock() {
    mock = new MockOrderClient();
    (OrderClient as any).instance = mock;
}

// --- Config helper ---

function setConfig(overrides: Record<string, any> = {}) {
    const base = {
        type: 'BuySellStrategy',
        enabled: true,
        right: 'call',
        targetPrice: 10,
        averageThreshold: 5,
        initialQuantity: 65,
        activateIntermittentCount: 3,
        maxIterationCount: 5,
        incrementFactor: 'iteration',
        incrementQuantity: 65,
        logEnabled: false,
    };
    configService.config.strategies = [{ ...base, ...overrides }];
    configService.config.settings = {
        ...(configService.config.settings || {}),
        cooldownSeconds: 0,
        targetPriceDiff: 10,
        stopLossPriceDiff: 10,
        trailingDistance: 5,
    } as any;
}

function mockNiftyQuote(ltp: number): NiftyQuote {
    const q = new NiftyQuote();
    q.ltp = ltp;
    q.token = 'NIFTY';
    return q;
}

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Tests ---

async function testDefensiveDefaultOrderedTrueImmediatelyAfterConstruction() {
    console.log('\n--- Test 1: ordered defaults to true immediately after construction (before reconciliation resolves) ---');
    setConfig();
    installMock();
    mock.statsTrades = []; // no open position - but reconciliation has not run yet at this point
    const s = new BuySellStrategy('TestUserFailSafe') as any;

    assert(s.ordered === true, 'ordered is true synchronously right after construction, before the async reconcile resolves');
}

async function testReconciliationFindsExistingOpenTrade() {
    console.log('\n--- Test 2: reconciliation finds an existing open trade for this userId -> ordered stays true, contract rehydrated, no duplicate entry ---');
    setConfig();
    installMock();
    const existingTrade = new Trade();
    existingTrade.tsym = 'NIFTY-CE-24500';
    existingTrade.token = 'EXISTING_TOKEN';
    existingTrade.price = 120;
    existingTrade.quantity = 65;
    existingTrade.user = 'TestUserExisting';
    mock.statsTrades = [existingTrade];

    const s = new BuySellStrategy('TestUserExisting') as any;
    await sleep(20); // let the constructor's fire-and-forget reconcileOrderState() resolve

    assert(s.ordered === true, 'ordered is true after reconciliation finds a matching open trade');
    assert(s.reconciling === false, 'reconciling flag cleared once reconciliation resolves');
    assert(s.contract.contract === 'NIFTY-CE-24500', 'contract symbol rehydrated from the existing trade');
    assert(s.contract.token === 'EXISTING_TOKEN', 'contract token rehydrated from the existing trade');
    assert(s.contract.price === 120, 'contract price rehydrated from the existing trade');
    assert(s.contract.qty === 65, 'contract qty rehydrated from the existing trade');

    // A subsequent qualifying tick must NOT fire a duplicate entry order.
    await s.processNiftyQuote(mockNiftyQuote(24500));

    assert(mock.buyContractCalls.length === 0, 'no duplicate entry order placed for a tick after reconciliation found an existing open trade');
}

async function testReconciliationFindsNoOpenTrade() {
    console.log('\n--- Test 3: reconciliation finds no open trade at all -> ordered becomes false, entries resume normally ---');
    setConfig();
    installMock();
    mock.statsTrades = []; // order process reports no open positions at all

    const s = new BuySellStrategy('TestUserNoTrade') as any;
    await sleep(20);

    assert(s.ordered === false, 'ordered is false after reconciliation finds no matching open trade');

    await s.processNiftyQuote(mockNiftyQuote(24500));

    assert(mock.buyContractCalls.length === 1, 'a qualifying tick fires a normal entry once reconciliation clears ordered');
}

async function testReconciliationIgnoresOtherUsersTrades() {
    console.log('\n--- Test 4: an open trade exists, but for a different userId -> ordered becomes false for this instance ---');
    setConfig();
    installMock();
    const otherUsersTrade = new Trade();
    otherUsersTrade.tsym = 'NIFTY-PE-23000';
    otherUsersTrade.token = 'OTHER_TOKEN';
    otherUsersTrade.price = 90;
    otherUsersTrade.quantity = 65;
    otherUsersTrade.user = 'SomeOtherStrategyUserId';
    mock.statsTrades = [otherUsersTrade];

    const s = new BuySellStrategy('TestUserDistinct') as any;
    await sleep(20);

    assert(s.ordered === false, 'ordered is false - the only open trade belongs to a different userId, not this instance');

    await s.processNiftyQuote(mockNiftyQuote(24500));

    assert(mock.buyContractCalls.length === 1, 'entry fires normally - the other user\'s open trade must not block this instance');
}

// --- Run All Tests ---

async function runAllTests() {
    console.log('=== BuySellStrategy Reconciliation Tests ===\n');

    const tests: Array<[string, () => Promise<void>]> = [
        ['Defensive default ordered=true immediately after construction', testDefensiveDefaultOrderedTrueImmediatelyAfterConstruction],
        ['Reconciliation finds existing open trade', testReconciliationFindsExistingOpenTrade],
        ['Reconciliation finds no open trade', testReconciliationFindsNoOpenTrade],
        ['Reconciliation ignores other users\' trades', testReconciliationIgnoresOtherUsersTrades],
    ];

    for (const [name, fn] of tests) {
        try {
            await fn();
        } catch (e: any) {
            console.log(`  ERROR in ${name}:`, e?.message ?? e);
            process.exitCode = 1;
        }
    }

    console.log('\n=== Tests Complete ===');
    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

runAllTests();
```

## Verification steps for orchestrator

Run these exact commands, in this order, from the repo root
(`/home/karthikeyan/work/icici`):

1. Typecheck the whole project (no `build` npm script exists - this is a
   pre-existing gap, use `npx tsc` directly):
   ```bash
   npx tsc --noEmit
   ```
   Expected output: **no output at all** (empty stdout/stderr, exit code 0).
   This matches the pre-fix baseline (confirmed clean before this change was
   made) - if this prints any errors, the edit introduced a type error and
   must be fixed before proceeding.

2. Compile to `dist/` (needed to actually run the test, since there is no
   ts-node/jest pipeline - see repo conventions):
   ```bash
   npx tsc
   ```
   Expected: exits 0, no output. `dist/test/buySellStrategyReconciliation.test.js`
   and `dist/strategy/BuySellStrategy.js` must now exist:
   ```bash
   ls dist/test/buySellStrategyReconciliation.test.js dist/strategy/BuySellStrategy.js
   ```

3. Run the new test (MOCK_BROKER=true bypasses `isTimeInRange()`'s market-hours
   check, matching the header comment in the test file and the convention used
   by `continuousStrategyTest.ts`):
   ```bash
   MOCK_BROKER=true node ./dist/test/buySellStrategyReconciliation.test.js
   ```
   Expected output: every line printed is `PASS:` (no `FAIL:` lines, no
   `ERROR in` lines), ending with:
   ```
   === Tests Complete ===
   ALL TESTS PASSED
   ```
   Expected exit code: `0`. If any assertion fails, the script prints `FAIL:`
   for that assertion, sets `process.exitCode = 1`, and the final line reads
   `SOME TESTS FAILED` instead - this must not happen.

4. Sanity-check the existing, unrelated `BuySellStrategy` test still passes
   (this fix must not change per-instance isolation behavior):
   ```bash
   node ./dist/test/buySellStrategyState.test.js
   ```
   Expected: `ALL TESTS PASSED`.

If all four steps pass exactly as described, the fix is verified complete.

## Files touched

- `src/strategy/BuySellStrategy.ts` (modified — constructor + new
  `reconcileOrderState()` private method, per "Exact code changes" above)
- `src/test/buySellStrategyReconciliation.test.ts` (new file, full content
  above)
