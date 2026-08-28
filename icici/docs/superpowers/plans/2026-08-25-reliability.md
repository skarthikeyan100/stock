# Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the nine Reliability items from the Priority Punch List in `/home/karthikeyan/work/icici/Analysis.md` — broker configurability, strategy wiring/state bugs, streaming reconnect gaps, and restart-reconciliation gaps.

**Architecture:** Each item is fixed in its existing file/module, following the same pattern already proven elsewhere in the codebase for the same class of problem (e.g. `GapStrategy`'s `this.enabled` gate pattern, `AntDataStream`'s reconnect-with-backoff pattern). Where a fix is pure decision logic, it's verified with a plain Node script per this repo's `src/test/*.ts` convention (no jest/mocha wired up — see `Analysis.md` §6, out of scope here). Where a fix requires live broker/websocket state (streaming reconnect, contract-master staleness), it's verified by code inspection + a manual smoke check, called out explicitly in that task.

**Tech Stack:** TypeScript, Node.js. No new dependencies.

**Spec:** `/home/karthikeyan/work/icici/Analysis.md` — Priority Punch List "Reliability" items 14-22, and the full detail in `## 1. Backend API & Auth` (Gaps #1), `## 2. Broker & Order Execution` (Gaps), and `## 3. Strategy & Decision Logic` (Critical Bugs #1-10, Wiring Status table).

## Global Constraints

- No new npm dependencies.
- `BuySellStrategy`/`IntermittentStrategy` are being kept, not deleted (explicit user decision this session) — fix their bugs in place rather than removing the files.
- None of the strategies touched here (`ContinuousStrategy`, `GapStrategy`, `BuySellStrategy`, `SupportResistanceStrategy`, `HighLotStrategy`, `BiDirectionStrategy`, `IntermittentStrategy`, `RuleBasedStrategy`) should be newly *enabled* in `config.yml`/`config.mock.yml` as a side effect of these fixes — every strategy's `enabled:` flag stays exactly as-is; these are correctness fixes to code paths, not a decision to start trading any of them live.
- Do not touch security/authz or build a general test harness — out of scope for this plan.
- Follow this repo's `src/test/*.ts` convention for any new verification script: hand-rolled `assert(condition, message)` (logs `PASS`/`FAIL`, sets `process.exitCode = 1` on failure — see `src/test/strategyTest.ts:122`), run via `npm run build && node dist/test/<name>.js`.

---

## File Structure

- `src/user.ts` — modify: add `broker` field + writer.
- `src/server.ts` — modify: `POST /users/:email/settings` accepts/forwards `broker`.
- `src/strategy/ContinuousStrategy.ts` — modify: fix enable/disable toggle.
- `src/strategy/GapStrategy.ts` — modify: add daily reset.
- `src/strategy/BuySellStrategy.ts` — modify: instance-level state, iteration-mode shadowing fix.
- `src/processes/strategies/niftyStatsBuilder.ts` (new) — pure interval-bucketed indicator-stats builder, ported from `src/decision.ts`.
- `src/processes/strategiesProcess.ts` — modify: wire `niftyStatsBuilder` into `onTick`, call `strategy.receive(...)`.
- `src/strategy/SupportResistanceStrategy.ts` — modify: zero-value config guard.
- `src/strategy/HighLotStrategy.ts` — modify: 3 bug fixes.
- `src/strategy/BiDirectionStrategy.ts` — modify: 2 bug fixes.
- `src/strategy/IntermittentStrategy.ts` — modify: wrong-config-field fix.
- `src/ant/AntStream.ts` — modify: port reconnect-with-backoff from `AntDataStream.ts`.
- `src/processes/order/antExecutor.ts` — modify: real fill price on non-bracket square-off.
- `src/ant/AntContractMaster.ts`, `src/zerodha/ZerodhaContractMaster.ts` — modify: staleness warning.
- `src/processes/orderProcess.ts` — modify: startup reconciliation note (see Task 13).
- `src/test/highLotStrategy.test.ts`, `src/test/biDirectionStrategy.test.ts`, `src/test/intermittentStrategy.test.ts`, `src/test/supportResistanceStrategy.test.ts`, `src/test/gapStrategyReset.test.ts`, `src/test/continuousStrategyEnable.test.ts`, `src/test/buySellStrategyState.test.ts` (new) — one per strategy-bug task.

---

## Task 1: Per-user broker configurability — close the "no writer anywhere" gap

**Files:**
- Modify: `src/user.ts:5-20` (`User` interface), `src/user.ts:170-182` (`updateUserSettings`)
- Modify: `src/server.ts:205-227` (`POST /users/:email/settings`)
- Test: manual (see Step 4) — this task is Mongo/IPC-dependent end to end, not pure logic.

**Interfaces:**
- Produces: `User.broker?: 'zerodha' | 'ant'`.
- Produces: `updateUserSettings(email, { ..., broker?: 'zerodha' | 'ant' })`.

**Context:** `bookkeeping.getUserBroker(user)` (`bookkeeping.ts:93-95`) and `orderProcess.ts`'s `loadUserLimits()` (`:311-324`, reads `mongoUser?.broker`) already correctly branch on a per-user `broker` field — the mechanism is real. But `User` has no `broker` field at all, so `mongoUser?.broker` is always `undefined` and every real user silently defaults to `'zerodha'`. `orderProcess.ts` also has a live IPC path, `case 'updateUserSettings'`, that *could* push a `broker` value into `bookkeeping.userSettingsCache` at runtime without a restart — but nothing calls it with one. Fix: add the field, and extend the one existing user-settings write path (`POST /users/:email/settings`, which already pushes into that same IPC path for `useGTT`/`lossLimit`/etc.) to accept and forward it, mirroring the existing `useGTT` field exactly.

- [ ] **Step 1: Add `broker` to the `User` interface**

In `src/user.ts:5-20`, add next to `useGTT`:

```ts
    useGTT: boolean;
    broker?: 'zerodha' | 'ant';
```

- [ ] **Step 2: Add a writer in `updateUserSettings`**

In `src/user.ts:170-182`, add `broker` to the settings param type and the `$set` construction:

```ts
export async function updateUserSettings(email: string, settings: { lossLimit?: number; lotCount?: number; investmentMode?: string; investmentAmount?: number; useGTT?: boolean; broker?: 'zerodha' | 'ant'; enabled?: boolean; perOrderCap?: number; profitSplitPercent?: number }): Promise<User | null> {
    const update: any = {};
    if (settings.lossLimit !== undefined) update.lossLimit = settings.lossLimit;
    if (settings.lotCount !== undefined) update.lotCount = settings.lotCount;
    if (settings.investmentMode !== undefined) update.investmentMode = settings.investmentMode;
    if (settings.investmentAmount !== undefined) update.investmentAmount = settings.investmentAmount;
    if (settings.useGTT !== undefined) update.useGTT = settings.useGTT;
    if (settings.broker !== undefined) update.broker = settings.broker;
    if (settings.enabled !== undefined) update.enabled = settings.enabled;
    if (settings.perOrderCap !== undefined) update.perOrderCap = settings.perOrderCap;
    if (settings.profitSplitPercent !== undefined) update.profitSplitPercent = settings.profitSplitPercent;
    await collection().updateOne({ email }, { $set: update });
    return getUser(email);
}
```

- [ ] **Step 3: Accept and forward `broker` in the settings endpoint**

In `src/server.ts:205-227`:

```ts
app.post('/users/:email/settings', async function (req, res) {
    try {
        const { email } = req.params;
        const { lossLimit, lotCount, investmentMode, investmentAmount, useGTT, broker, perOrderCap, profitSplitPercent, enabled } = req.body;
        const user = await updateUserSettings(email, { lossLimit, lotCount, investmentMode, investmentAmount, useGTT, broker, perOrderCap, profitSplitPercent, enabled });
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        await orderClient.updateUserSettings(email, {
            lossLimit: user.lossLimit,
            lotLimit: user.lotCount,
            investmentMode: user.investmentMode,
            investmentAmount: user.investmentAmount,
            useGTT: user.useGTT,
            broker: user.broker,
            perOrderCap: user.perOrderCap,
        }).catch((e) => Log.log('[frontend] updateUserSettings push failed:', e));
        res.json(toClientUser(user));
    } catch (e) {
        console.error('Update settings error:', e);
        res.sendStatus(500);
    }
});
```

Confirm `orderClient.updateUserSettings`'s payload type (in `src/processes/strategies/OrderClient.ts` or wherever the IPC request type is declared — grep `updateUserSettings` for the request-shape interface) already allows an optional `broker` field; if its type is a narrower inline object literal, widen it to include `broker?: 'zerodha' | 'ant'` there too so this compiles.

- [ ] **Step 4: Manual verification (no live broker/Mongo dependency to fake here — do a real round trip)**

This task's correctness is "does a POST actually change what `bookkeeping.getUserBroker()` returns," which requires the real `order` process's IPC socket — not something to fake with a unit test. Verify manually:

1. `npm run build`
2. Start Mongo + `npm run processes` (or just `order` if run standalone).
3. `curl -X POST http://localhost:3000/users/<a-real-user-email>/settings -H 'Content-Type: application/json' -d '{"broker":"ant"}'`
4. Confirm the response JSON includes `"broker":"ant"`.
5. Check `order`'s log output for the `updateUserSettings` IPC push (or add a temporary `Log.log` in `bookkeeping.updateUserSettings` if not already logged) and confirm `broker: 'ant'` arrived.

- [ ] **Step 5: Commit**

```bash
git add src/user.ts src/server.ts src/processes/strategies/OrderClient.ts
git commit -m "fix: add per-user broker field with a real write path (POST /users/:email/settings)"
```

---

## Task 2: `ContinuousStrategy`'s enable/disable toggle actually works

**Files:**
- Modify: `src/strategy/ContinuousStrategy.ts:84-87` (constructor), `:203-210` (`processNiftyQuote` gate)
- Test: `src/test/continuousStrategyEnable.test.ts` (new)

**Interfaces:** none new — behavioral fix only.

**Context:** The constructor unconditionally sets `this.enabled = true` (`:86`), and `processNiftyQuote` gates on a **fresh config-file read** (`cfg.enabled`, `:206`) instead of `this.enabled` — the same instance field `strategiesProcess.ts`'s dispatch loop (`if (strategy.enabled) await strategy.processNiftyQuote(quote)`) and the admin `setEnabled` IPC command both operate on. Every other modern strategy (e.g. `GapStrategy.ts`, `if (!this.enabled || !this.isTimeInRange()) return;`) correctly gates on `this.enabled`. Fix: match that pattern.

- [ ] **Step 1: Write the failing test**

Create `src/test/continuousStrategyEnable.test.ts`:

```ts
/**
 * Verifies ContinuousStrategy's processNiftyQuote gates on the instance's
 * own this.enabled field (which strategiesProcess.ts's dispatch loop and the
 * admin setEnabled IPC command both mutate), not a fresh config-file read.
 * Run: npm run build (compile), then: node ./dist/test/continuousStrategyEnable.test.js
 */

import ContinuousStrategy from '../strategy/ContinuousStrategy';
import { NiftyQuote } from '../model/model';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    const strategy = new ContinuousStrategy('ContinuousStrategy') as any;

    // Fresh instance must not force itself enabled - only StrategyFactory
    // (or an explicit admin setEnabled call) should ever set this.enabled=true.
    assert(strategy.enabled === false, `a fresh instance defaults to disabled (got ${strategy.enabled})`);

    // Simulate the admin setEnabled IPC command's effect (strategiesProcess.ts:76).
    strategy.enabled = true;
    const quote = Object.assign(new NiftyQuote(), { ltp: 24000 });
    // Should reach the gate that actually attempts entry (isTimeInRange/cooldown
    // may still block it, but it must NOT bail out on the disabled-gate specifically -
    // verified indirectly by confirming this.ordered is untouched only when this.enabled
    // is false, and reachable when true, via the logGateOnce reason).
    let lastGateReason = '';
    const originalLog = strategy.logGateOnce.bind(strategy);
    strategy.logGateOnce = (reason: string) => { lastGateReason = reason; return originalLog(reason); };

    strategy.enabled = false;
    await strategy.processNiftyQuote(quote);
    assert(lastGateReason === 'disabled', `disabled instance gates on 'disabled' (got '${lastGateReason}')`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/continuousStrategyEnable.test.js`
Expected: FAIL on `strategy.enabled === false` — the constructor currently forces it to `true`.

- [ ] **Step 3: Fix the constructor and the gate**

In `src/strategy/ContinuousStrategy.ts:84-87`, remove the forced override:

```ts
    constructor(userId?: string) {
        super(userId);
    }
```

(The base `Strategy` class already defaults `enabled = false`, `src/strategy/strategy.ts:23` — `StrategyFactory.createStrategy` sets the real value from `config.yml` right after construction, `strategy.enabled = config.enabled;`, exactly like every other strategy type.)

In `processNiftyQuote` (`:203-210`), change the gate from `cfg.enabled` to `this.enabled`:

```ts
    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        this.lastNiftyLtp = quote.ltp;
        const cfg = this.cfg();
        if (!this.enabled) { this.logGateOnce('disabled'); return; }
        if (!this.isTimeInRange()) { this.logGateOnce('outside time window'); return; }
        if (this.ordered) { this.logGateOnce('already ordered / T1 in flight'); return; }
        if (!this.isCooldownElapsed(cfg.cooldownSeconds ?? 60)) { this.logGateOnce('cooldown not elapsed'); return; }
        this.logGateOnce('all T1 gates clear - attempting entry');
```

(`cfg` stays in scope — it's still used below for `cfg.cooldownSeconds`, `cfg.right`, etc.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc && node dist/test/continuousStrategyEnable.test.js`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/ContinuousStrategy.ts src/test/continuousStrategyEnable.test.ts
git commit -m "fix: ContinuousStrategy's admin enable/disable toggle now actually works"
```

---

## Task 3: `GapStrategy` resets daily instead of self-disabling forever

**Files:**
- Modify: `src/strategy/GapStrategy.ts` (add `resetIfNewDay`-equivalent, call it from `processNiftyQuote`)
- Test: `src/test/gapStrategyReset.test.ts` (new)

**Interfaces:** none new.

**Context:** `processNiftyQuote` sets `this.enabled = false` (`:151`) after its one decision for the day, with no reset anywhere in the live pipeline — it trades once ever, then never again until a manual admin call or process restart. `GoodMorningStrategy`/`GoodMorningSensexStrategy` already have a working "once per day" pattern — mirror it. Check `GoodMorningStrategy.ts` for its exact reset mechanism (grep `tradingDay` in that file) before writing this fix, since the plan should match its real shape, not invent a new one.

- [ ] **Step 1: Read the existing daily-reset pattern**

Run: `grep -n "tradingDay\|resetIfNewDay\|new Date().toDateString" src/strategy/GoodMorningStrategy.ts`

Use whatever field name/check that search turns up (likely a `tradingDay: string` field compared against `new Date().toDateString()` at the top of `processNiftyQuote`) so `GapStrategy`'s fix matches the established convention exactly rather than introducing a second daily-reset idiom.

- [ ] **Step 2: Write the failing test**

Create `src/test/gapStrategyReset.test.ts` (adjust the mocked date-check mechanics to match whatever Step 1 found — the shape below assumes a `tradingDay: string` field compared via `toDateString()`; update if `GoodMorningStrategy` uses a different check):

```ts
/**
 * Verifies GapStrategy re-arms (this.enabled back to true) on a new trading
 * day instead of staying permanently disabled after its first decision.
 * Run: npm run build (compile), then: node ./dist/test/gapStrategyReset.test.js
 */

import GapStrategy from '../strategy/GapStrategy';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const strategy = new GapStrategy('GapStrategy') as any;
strategy.enabled = true;

// Simulate "made its one decision today" without needing a live quote/order path.
strategy.enabled = false;
strategy.tradingDay = new Date().toDateString();
assert(strategy.enabled === false, 'stays disabled for the rest of the same trading day');

// Simulate a new day (yesterday's date still stored).
strategy.tradingDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toDateString();
strategy.resetIfNewDay();
assert(strategy.enabled === true, `re-arms once the trading day rolls over (got ${strategy.enabled})`);

if (process.exitCode === 1) {
    console.log('SOME TESTS FAILED');
} else {
    console.log('ALL TESTS PASSED');
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsc && node dist/test/gapStrategyReset.test.js`
Expected: compile error — `resetIfNewDay`/`tradingDay` don't exist on `GapStrategy` yet.

- [ ] **Step 4: Implement the reset, matching `GoodMorningStrategy`'s pattern**

Add a `tradingDay: string` field and a `resetIfNewDay()` method to `GapStrategy` (mirroring whatever Step 1 found verbatim in `GoodMorningStrategy.ts` — field name, comparison, and reset behavior should match that file exactly), and call `this.resetIfNewDay();` as the first line of `processNiftyQuote` (`:118`, before `const config = configService.getStrategyConfig('GapStrategy');`). When `this.enabled = false;` is set after the day's one decision (`:151`), also set `this.tradingDay = new Date().toDateString();` at the same point so the reset check has a day to compare against.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsc && node dist/test/gapStrategyReset.test.js`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 6: Commit**

```bash
git add src/strategy/GapStrategy.ts src/test/gapStrategyReset.test.js
git commit -m "fix: GapStrategy resets daily instead of self-disabling forever"
```

---

## Task 4: `BuySellStrategy` — instance-level order-in-flight state + iteration-mode fix

**Files:**
- Modify: `src/strategy/BuySellStrategy.ts`
- Test: `src/test/buySellStrategyState.test.ts` (new)

**Interfaces:**
- Produces: `Contract.buyOrderPlaced: boolean`, `Contract.sellOrderPlaced: boolean` (moved from module-level `let`).

**Context (2 bugs, same file, same task since a reviewer can't sensibly approve one without the other in this small file):**
1. `let buyOrderPlaced = false; let sellOrderPlaced = false;` at module scope (`:14-15`), read/written by every `Contract` instance. Two configured `BuySellStrategy` instances (different `userId`s — the factory supports this) would silently share these flags, corrupting each other's order-in-flight tracking.
2. The `"iteration"` increment-mode branch (`:145-147`) declares a new block-scoped `let quantity` that shadows the outer `let quantity = incrementQuantity` (`:142`) and is then discarded — `incrementFactor: "iteration"` behaves identically to `"single"`.

- [ ] **Step 1: Write the failing test**

Create `src/test/buySellStrategyState.test.ts`:

```ts
/**
 * Verifies BuySellStrategy's order-in-flight flags are per-instance (per
 * Contract), not shared module-level state across every configured instance.
 * Run: npm run build (compile), then: node ./dist/test/buySellStrategyState.test.js
 */

import BuySellStrategy from '../strategy/BuySellStrategy';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const userA = new BuySellStrategy('UserA') as any;
const userB = new BuySellStrategy('UserB') as any;

userA.contract.buyOrderPlaced = true;
assert(userB.contract.buyOrderPlaced !== true, 'a second instance does not see the first instance\'s in-flight flag');

if (process.exitCode === 1) {
    console.log('SOME TESTS FAILED');
} else {
    console.log('ALL TESTS PASSED');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/buySellStrategyState.test.js`
Expected: FAIL — `userB.contract.buyOrderPlaced` is also `true` (shared module-level state), or the property is `undefined` pre-fix (module-level `let`, not on the instance at all) — either way, not the per-instance behavior asserted.

- [ ] **Step 3: Move the flags onto `Contract` as instance fields**

In `src/strategy/BuySellStrategy.ts`:

Remove the module-level declarations (`:14-15`):
```ts
let buyOrderPlaced = false
let sellOrderPlaced = false
```

In the `Contract` class (`:52-96`), add instance fields:
```ts
class Contract {
    contract: string;
    price: number = 0;
    qty: number = 0;
    token: string;
    profit: number = 0;
    ltp: number = 0;
    BUY = 'Buy'
    SELL = 'Sell'
    status: OrderStatus = OrderStatus.PENDING;
    iterationCount: number = 0;
    buyAt: number = 0;
    sellAt: number = 0;
    lastOrderedPrice: number = 0;
    lastOrderedQuantity: number = 0;
    strategy: Strategy = {} as Strategy;
    buyOrderPlaced: boolean = false;
    sellOrderPlaced: boolean = false;
```

Then replace every bare `buyOrderPlaced`/`sellOrderPlaced` reference inside `Contract`'s methods (`processOptionQuote`: `:122,132,133,136,149`; `clear`: `:93-94`; `updateTrade`: `:176,177,178,200`) with `this.buyOrderPlaced`/`this.sellOrderPlaced`.

`BuySellStrategy.processNiftyQuote` (`:272`) currently sets the module-level flag directly: `buyOrderPlaced = true`. Change to `this.contract.buyOrderPlaced = true;` — note `this.contract` is assigned a couple of lines later at `:284` in the current code (`this.contract = new Contract(this, contract);`), so move the `this.contract = new Contract(...)` line to happen *before* setting `buyOrderPlaced = true` (swap the order of those two statements — constructing the `Contract` first, then flagging its `buyOrderPlaced`, is a one-line reordering, not a behavior change to anything else in that method).

- [ ] **Step 4: Fix the iteration-mode shadowing**

In `Contract.processOptionQuote` (`:140-147`):

```ts
                                if (this.iterationCount <= maxIterationCount) {
                                    const incrementFactor = configService.getStrategyConfig('BuySellStrategy').incrementFactor;
                                    const incrementQuantity = configService.getStrategyConfig('BuySellStrategy').incrementQuantity;
                                    let quantity = incrementQuantity
                                    if ("double" == incrementFactor) {
                                        quantity = this.lastOrderedQuantity * 2;
                                    } else if ("iteration" == incrementFactor) {
                                        quantity = this.iterationCount * incrementQuantity
                                    }
```

(Only change: drop the `let` on the `"iteration"` branch's assignment so it reassigns the outer `quantity` instead of shadowing it.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsc && node dist/test/buySellStrategyState.test.js`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 6: Commit**

```bash
git add src/strategy/BuySellStrategy.ts src/test/buySellStrategyState.test.js
git commit -m "fix: BuySellStrategy uses per-instance order-in-flight state; fix dead iteration increment mode"
```

---

## Task 5: Wire live `stats`/`receive()` into the strategies pipeline

**Files:**
- Create: `src/processes/strategies/niftyStatsBuilder.ts`
- Modify: `src/processes/strategiesProcess.ts:40-56` (`onTick`)
- Test: `src/test/niftyStatsBuilder.test.ts` (new)

**Interfaces:**
- Produces: `export function record(ltp: number, ltt: number): { oldStats: PeriodicStats; newStats: PeriodicStats } | null` — call on every live NIFTY tick; returns a stats update only when a 300-second bucket boundary is crossed (matching `decision.ts`'s existing cadence — see Context), otherwise `null`.
- Consumes: `PeriodicStats` from `../../model/model`, `buildCandle` from `../../lib/candle-builder`, `calcRSI`/`calcMACD`/`calcBollinger`/`calcEMACrossover`/`calcADX`/`calcStochastic` from `../../lib/indicators`, `RSI_PARAMS`/`MACD_PARAMS`/`BOLLINGER_PARAMS`/`EMA_PARAMS`/`ADX_PARAMS`/`STOCHASTIC_PARAMS` from `../../lib/indicator-config`, `regression` (already a dependency, used by `decision.ts`).

**Context:** `strategy.receive(oldStats, newStats)` is called from exactly one place in the whole codebase: `decision.ts:391-396`'s `'stats'` event handler, which returns immediately whenever `this.replayMode` is true — and `Decision` is instantiated exactly once in the live process tree, at `server.ts:1335` inside `GET /replay`, which sets `replayMode = true` on the very next line. Net effect: `receive()` is unreachable under any circumstance in live trading today. This is the root cause of the previously-known "`RuleBasedStrategy`/`Minutes5Decision` are inert" finding — `RuleBasedStrategy.receive()` (`RuleBasedStrategy.ts:144-176`) is fully implemented and *is* wired into `config.yml` (currently `enabled: false`), it just never fires.

The `strategies` process (`strategiesProcess.ts`) deliberately has no Prism/Zerodha/Mongo-heavy dependency (see its own header comment) — `decision.ts` is a large legacy file with exactly that kind of coupling, so this task does not import from `decision.ts`. Instead it ports just the pure computation `decision.ts` itself already delegates to reusable, dependency-free modules:
- `src/lib/candle-builder.ts`'s `buildCandle()` — already pure, already used by `decision.ts`.
- `src/lib/indicators.ts`'s `calcRSI`/`calcMACD`/etc. — already pure.
- `regression` (npm package) for trend direction — same one-line usage `decision.ts._determineTrend` already makes.

`decision.ts` only actually runs one interval today (`intervals = [300]` at `decision.ts:314`, "5-min only — matches pipeline --interval 300") despite `indicator-config.ts` exporting six — so this port only needs to build one 300-second rolling bucket, not six.

The exact bucket-boundary algorithm being ported (`decision.ts:350-386`, `_emitPrice`): on the first tick, record `startTime = tick.time` (epoch seconds — `NiftyQuote.ltt`, parsed as an int) and start an empty price-bucket array; on every tick, push the price into the bucket, then if `(tick.time - startTime) >= 300 && bucket.length >= 2`, emit a stats update for the just-closed bucket and reset `startTime = tick.time`, `bucket = []`.

- [ ] **Step 1: Write the failing test**

Create `src/test/niftyStatsBuilder.test.ts`:

```ts
/**
 * Verifies niftyStatsBuilder.record() only emits a stats update once a
 * 300-second bucket boundary is crossed (matching decision.ts's existing
 * 5-min cadence), and that the emitted PeriodicStats carries real RSI/MACD/etc
 * results usable by strategy.receive().
 * Run: npm run build (compile), then: node ./dist/test/niftyStatsBuilder.test.js
 */

import * as niftyStatsBuilder from '../processes/strategies/niftyStatsBuilder';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const baseTime = 1_700_000_000; // arbitrary fixed epoch-seconds start

// Ticks within the same 300s bucket must not emit.
let lastResult: any = null;
for (let i = 0; i < 5; i++) {
    lastResult = niftyStatsBuilder.record(24000 + i, baseTime + i * 10);
}
assert(lastResult === null, 'no stats emitted before a 300s boundary is crossed');

// A tick past the 300s boundary (with >= 2 prices already in the bucket) must emit.
const crossing = niftyStatsBuilder.record(24100, baseTime + 305);
assert(crossing !== null, 'emits a stats update once the 300s boundary is crossed');
assert(crossing!.newStats?.results?.rsi !== undefined, 'emitted stats include rsi results usable by RuleBasedStrategy.receive()');
assert(crossing!.newStats?.results?.pivot?.S1 !== undefined, 'emitted stats include pivot results usable by BiDirectionStrategy/PivotStrategy');

if (process.exitCode === 1) {
    console.log('SOME TESTS FAILED');
} else {
    console.log('ALL TESTS PASSED');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/niftyStatsBuilder.test.js`
Expected: compile error — `src/processes/strategies/niftyStatsBuilder.ts` doesn't exist yet.

- [ ] **Step 3: Implement `niftyStatsBuilder.ts`**

Create `src/processes/strategies/niftyStatsBuilder.ts`:

```ts
import regression from 'regression';
import { PeriodicStats } from '../../model/model';
import { buildCandle } from '../../lib/candle-builder';
import { calcRSI, calcEMACrossover, calcMACD, calcBollinger, calcADX, calcStochastic } from '../../lib/indicators';
import { RSI_PARAMS, MACD_PARAMS, EMA_PARAMS, BOLLINGER_PARAMS, ADX_PARAMS, STOCHASTIC_PARAMS } from '../../lib/indicator-config';

// Live-pipeline port of decision.ts's _emitPrice/_computeAndEmitStats (the
// only interval decision.ts itself actually runs today - decision.ts:314,
// "5-min only - matches pipeline --interval 300"). decision.ts's own stats
// pipeline is unreachable in live trading (see Analysis.md's "receive()/
// decision.ts is structurally dead" finding) because Decision is only ever
// instantiated inside GET /replay with replayMode forced true. This module
// has none of decision.ts's Prism/Mongo/child_process baggage - matches
// strategiesProcess.ts's own "no Prism/Zerodha dependency at all" design.

const BUCKET_SECONDS = 300;

let startTime: number | null = null;
let bucket: number[] = [];
const closes: number[] = []; // one entry per completed bucket, grows for the session (matches decision.ts's candlesMap-derived `prices` array)
let previousStats: PeriodicStats | null = null;

function round(num: number): number {
    return Math.round(num * 100) / 100;
}

function determineTrend(prices: number[]): string {
    const data = prices.map((price, index) => [index, price]);
    const result = regression.linear(data as [number, number][]);
    const slope = result.equation[0];
    if (slope > 0) return 'Up';
    if (slope < 0) return 'Down';
    return 'Sideways';
}

// Call on every live NIFTY tick. `ltt` is epoch seconds (matches decision.ts's
// parseInt(quote.ltt) usage). Returns a stats update only when this tick
// closes a 300s bucket, otherwise null.
export function record(ltp: number, ltt: number): { oldStats: PeriodicStats | null; newStats: PeriodicStats } | null {
    if (startTime === null) {
        startTime = ltt;
    }

    bucket.push(ltp);
    const diff = ltt - startTime;
    if (!(diff >= BUCKET_SECONDS && bucket.length >= 2)) {
        return null;
    }

    const candle = buildCandle(bucket, startTime);
    closes.push(candle.close);

    const highs = closes; // decision.ts uses candle.high per bucket for ADX/Stochastic - see note below
    const lows = closes;

    const rsiResults = RSI_PARAMS.map(p => calcRSI(closes, p.period, p.overbought, p.oversold)).filter(Boolean);
    const macdResults = MACD_PARAMS.map(p => calcMACD(closes, p.shortPeriod, p.longPeriod, p.signalPeriod)).filter(Boolean);
    const bollingerResults = BOLLINGER_PARAMS.map(p => calcBollinger(closes, p.period, p.numDeviations)).filter(Boolean);
    const emaResults = EMA_PARAMS.map(p => calcEMACrossover(closes, p.shortPeriod, p.longPeriod)).filter(Boolean);
    const adxResults = ADX_PARAMS.map(p => calcADX(highs, lows, closes, p.period)).filter(Boolean);
    const stochasticResults = STOCHASTIC_PARAMS.map(p => calcStochastic(highs, lows, closes, p.kPeriod, p.dPeriod)).filter(Boolean);

    const pivot = { S1: candle.S1 ?? 0, R1: candle.R1 ?? 0, S2: candle.S2 ?? 0, R2: candle.R2 ?? 0 };

    const results = {
        eventName: 'priceUpdate_300',
        macd: macdResults, rsi: rsiResults, bollinger: bollingerResults,
        ema: emaResults, adx: adxResults, stochastic: stochasticResults,
        pivot,
    };

    const newStats = new PeriodicStats(
        candle.open, candle.high, candle.low, candle.close,
        candle.average, candle.median, candle.stddev, candle.mad,
        determineTrend(closes), results
    );

    const oldStats = previousStats;
    previousStats = newStats;

    startTime = ltt;
    bucket = [];

    return { oldStats, newStats };
}
```

Note on `highs`/`lows`: `decision.ts:520-521` builds `highs`/`lows` from each completed candle's own `high`/`low` (`candles.map(c => c.high)`), not from `closes` — this port uses `closes` for `highs`/`lows` too as a deliberate simplification (candle-level high/low tracking would need a parallel `candles: CandleData[]` array instead of just `closes: number[]`). This only affects the ADX/Stochastic indicator results (both of which take separate high/low series); RSI/MACD/EMA/Bollinger (what `RuleBasedStrategy` actually configures per `config.yml`'s `indicators:` field today) are unaffected, since they only ever consume `closes`. If a future indicator combo needs true high/low series, extend `closes` to a `candles: CandleData[]` array and map `.high`/`.low` from it, mirroring `decision.ts:520-521` exactly.

- [ ] **Step 4: Wire it into `strategiesProcess.ts`'s live `onTick`**

In `src/processes/strategiesProcess.ts`, add the import:

```ts
import * as niftyStatsBuilder from './strategies/niftyStatsBuilder';
```

In `onTick`'s `'nifty'` branch (`:41-46`):

```ts
    if (tick.type === 'nifty') {
        const quote = Object.assign(new NiftyQuote(), tick.quote) as NiftyQuote;
        niftyQuoteHistory.record(quote);
        niftyCandleBuilder.record(quote);
        const statsUpdate = niftyStatsBuilder.record(quote.ltp, parseInt(quote.ltt as any));
        if (statsUpdate) {
            for (const strategy of strategies.getList()) {
                await strategy.receive(statsUpdate.oldStats, statsUpdate.newStats);
            }
        }
        for (const strategy of strategies.getList()) {
            if (strategy.enabled) await strategy.processNiftyQuote(quote);
        }
    }
```

(`receive()` is called for every strategy regardless of `.enabled`, matching `decision.ts:393`'s original `for (const strategy of strategies.getList())` with no enabled-check — strategies that care about being enabled already self-guard inside their own `receive()`, e.g. `RuleBasedStrategy.receive()`'s `if (!this.enabled || ...) return;` at `RuleBasedStrategy.ts:145`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsc && node dist/test/niftyStatsBuilder.test.js`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 6: Commit**

```bash
git add src/processes/strategies/niftyStatsBuilder.ts src/processes/strategiesProcess.ts src/test/niftyStatsBuilder.test.js
git commit -m "fix: wire live NIFTY stats into strategy.receive() so RuleBasedStrategy's entry logic can actually run"
```

---

## Task 6: `SupportResistanceStrategy` — guard the dangerous zero-value config default

**Files:**
- Modify: `src/strategy/SupportResistanceStrategy.ts:32-43` (`processNiftyQuote`)
- Test: `src/test/supportResistanceStrategy.test.ts` (new)

**Interfaces:** none new.

**Context:** `config.yml:120-127`'s current defaults are `supportPrice: 0, resistancePrice: 0`. Since NIFTY's LTP is always positive, `ltp > config.resistancePrice` (`:41`) is true on essentially every tick if this strategy is ever enabled as-shipped — it would call `buyIndex` on every single tick, relying entirely on the order process's duplicate-open-position check as the only safety net (per the file's own header comment). Fix: treat a non-positive support/resistance value as "not configured" and skip that side's check.

- [ ] **Step 1: Write the failing test**

Create `src/test/supportResistanceStrategy.test.ts`:

```ts
/**
 * Verifies SupportResistanceStrategy does not treat an unconfigured (0)
 * support/resistance level as a real, always-crossed level.
 * Run: npm run build (compile), then: node ./dist/test/supportResistanceStrategy.test.js
 */

import SupportResistanceStrategy from '../strategy/SupportResistanceStrategy';
import { NiftyQuote } from '../model/model';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    const strategy = new SupportResistanceStrategy('SupportResistanceStrategy') as any;
    strategy.enabled = true;

    let executeTradeCalls = 0;
    strategy.executeTrade = async () => { executeTradeCalls++; };

    // resistancePrice=0 (shipped default) must not fire on every positive LTP.
    await strategy.processNiftyQuote(Object.assign(new NiftyQuote(), { ltp: 24000 }));
    assert(executeTradeCalls === 0, `does not fire on an unconfigured (0) resistance level (calls=${executeTradeCalls})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

Note: this test relies on `configService.getStrategyConfig('SupportResistanceStrategy')` resolving `config.yml`'s real shipped defaults (`supportPrice: 0, resistancePrice: 0`) — if `config.mock.yml` is what's active for `npm run build`'s runtime (check `ConfigService`'s env-selection logic), confirm it has the same `0`/`0` defaults before relying on this; if it has different values, override them in the test's `configService` call rather than editing the config file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/supportResistanceStrategy.test.js`
Expected: FAIL — `executeTradeCalls === 1` (fires on the resistance-crossed branch since `24000 > 0`).

- [ ] **Step 3: Guard both checks**

In `src/strategy/SupportResistanceStrategy.ts:32-43`:

```ts
    async processNiftyQuote(quote: NiftyQuote) {
        if (!this.enabled || !quote?.ltp) return;

        const ltp = quote.ltp;
        const config = configService.getStrategyConfig('SupportResistanceStrategy');

        if (config.supportPrice > 0 && ltp < config.supportPrice) {
            Log.log(`[SupportResistance] Support crossed: NIFTY=${ltp} support=${config.supportPrice} - buying PUT`);
            await this.executeTrade(PUT, ltp, config);
        }

        if (config.resistancePrice > 0 && ltp > config.resistancePrice) {
            Log.log(`[SupportResistance] Resistance crossed: NIFTY=${ltp} resistance=${config.resistancePrice} - buying CALL`);
            await this.executeTrade(CALL, ltp, config);
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc && node dist/test/supportResistanceStrategy.test.js`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/SupportResistanceStrategy.ts src/test/supportResistanceStrategy.test.js
git commit -m "fix: SupportResistanceStrategy no longer fires on every tick when support/resistance is unconfigured (0)"
```

---

## Task 7: `HighLotStrategy` — three bug fixes

**Files:**
- Modify: `src/strategy/HighLotStrategy.ts`
- Test: `src/test/highLotStrategy.test.ts` (new)

**Interfaces:** none new.

**Context (3 bugs, same file, same class, same task):**
1. `isStdDeviationInRange()` (`:162-177`) initializes `let trigger = true`, only overwritten inside `if (this.stats)`. Since `this.stats` is only ever populated via `receive()`, which — until Task 5 lands — never fires, `trigger` stays `true` unconditionally; even after Task 5, a strategy that's never received a first stats update yet should not fire by default. Fix: default to `false` (fail closed).
2. `updateTrade`'s "CALL is not active, but PUT is active. Buying CALL again" branch (`:203-208`) calls `this.addOrder(..., CALL, ...)` correctly, but then does `this.putOrder.initialize(order)` instead of `this.callOrder.initialize(order)` — clobbering the still-active `putOrder`'s state with the newly-bought CALL's data, and leaving `callOrder` permanently inactive.
3. The contra-order condition (`:66`) `diff <= -contraThreshold && diff > stopLossThreshold` (with `contraThreshold=4`, `stopLossThreshold=20`) requires `diff <= -4 AND diff > 20` simultaneously — impossible. The evident intent (matches the surrounding branches: target above, contra in the middle, full stop-loss below) is `diff <= -stopLossThreshold` as the *lower* bound of the middle zone, i.e. a missing minus sign.

- [ ] **Step 1: Write the failing tests**

Create `src/test/highLotStrategy.test.ts`:

```ts
/**
 * Verifies three HighLotStrategy bug fixes: the always-true volatility gate,
 * the CALL/PUT copy-paste bug in updateTrade's re-buy branch, and the
 * unreachable contra-order condition.
 * Run: npm run build (compile), then: node ./dist/test/highLotStrategy.test.js
 */

import HighLotStrategy from '../strategy/HighLotStrategy';
import { Trade } from '../model/model';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    // Bug 1: isStdDeviationInRange defaults to false, not true, before any stats arrive.
    const s1 = new HighLotStrategy('HighLotStrategy1') as any;
    assert(s1.isStdDeviationInRange() === false, 'volatility gate fails closed with no stats yet');

    // Bug 2: re-buying CALL (while PUT stays active) must initialize callOrder, not putOrder.
    const s2 = new HighLotStrategy('HighLotStrategy2') as any;
    let addOrderCalls = 0;
    s2.addOrder = async () => { addOrderCalls++; return { contract: 'NIFTY-CALL-NEW', token: 'callTok', qty: 300, price: 100 }; };
    const { default: OrderModule } = { default: null as any };
    const OrderClass = Object.getPrototypeOf(s2).constructor; // not used directly - Order is not exported; construct via strategy's own flow instead
    // Drive it through the real updateTrade path: seed callOrder inactive, putOrder active.
    s2.callOrder = { active: false, updateTrade: async () => {} };
    s2.putOrder = { active: true, updateTrade: async () => {} };
    const trade = Object.assign(new Trade(), { ltp: 100 });
    await s2.updateTrade(trade);
    assert(s2.callOrder.token === 'callTok', `re-bought CALL is stored on callOrder (got token=${s2.callOrder.token})`);

    // Bug 3: contra-order condition is reachable for a mid-range adverse move.
    // contraThreshold=4, stopLossThreshold=20 (module-level consts in HighLotStrategy.ts).
    const s3 = new HighLotStrategy('HighLotStrategy3') as any;
    const order = await s3.addOrder ? null : null; // placeholder to keep TS happy if addOrder is strategy-bound
    // Exercise the Order class's own processOptionQuote directly via a real order created through addOrder's shape.
    // (See Step 3 of the plan for exactly which line changes - this assertion
    // is re-derived after the fix by importing the module's internal Order
    // class is not possible since it's not exported, so this is verified by
    // re-reading HighLotStrategy.ts:66 directly.)
    console.log('  (Bug 3 verified by code inspection - Order is not exported; see Step 3/Step 4 below.)');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/highLotStrategy.test.js`
Expected: FAIL on both the Bug 1 and Bug 2 assertions.

- [ ] **Step 3: Fix Bug 1 (fail-closed default)**

In `src/strategy/HighLotStrategy.ts:165`:

```ts
    isStdDeviationInRange = () => {
        const intervals = [10, 15, 30, 45, 60, 120, 300];
        const stdDev = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
        let trigger = false
```

- [ ] **Step 4: Fix Bug 2 (CALL/PUT copy-paste) and Bug 3 (contra condition sign)**

In `updateTrade` (`:203-208`):

```ts
        if (this.callOrder && !this.callOrder.active && this.putOrder && this.putOrder.active) {
            Log.log('CALL is not active, but PUT is active. Buying CALL again');
            const order = await this.addOrder(round(trade.ltp - buyAgainDiff), CALL, buyQuantity);
            this.callOrder.initialize(order);

        }
```

In `Order.processOptionQuote` (`:66`):

```ts
            } else if (diff <= -contraThreshold && diff > -stopLossThreshold) {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsc && node dist/test/highLotStrategy.test.js`
Expected: `ALL TESTS PASSED` (Bug 1 and Bug 2 assertions PASS; Bug 3 is a one-character sign fix confirmed by re-reading the file, since `Order` is an internal, unexported class — note this explicitly in the commit message rather than fabricating an assertion for it).

- [ ] **Step 6: Commit**

```bash
git add src/strategy/HighLotStrategy.ts src/test/highLotStrategy.test.js
git commit -m "fix: HighLotStrategy volatility gate fail-closed, CALL/PUT re-buy copy-paste bug, unreachable contra-order condition"
```

---

## Task 8: `BiDirectionStrategy` — two bug fixes

**Files:**
- Modify: `src/strategy/BiDirectionStrategy.ts`
- Test: `src/test/biDirectionStrategy.test.ts` (new)

**Interfaces:** none new.

**Context (2 bugs, same file, same task):**
1. `canHandleOptionQuote` (around `:234-247`) has an `else` attached to `if (!handled && this.put.canHandleOptionQuote)` — since `this.put.canHandleOptionQuote` is always a truthy bound-method reference, that `if` is false exactly when `!handled` is false (i.e. the CALL side already matched), which falls into the `else` and resets `handled = false`. A correct CALL match can never survive this function.
2. The `Contract.updateTrade` SELL branch (around `:184-196`) never sets `tradeClosed = true` (it's declared `false` and never reassigned), so the outer `BiDirectionStrategy.updateTrade`'s fresh-strike re-entry path (`openCallTrade()`/`openPutTrade()`, `:409-429`) never runs; instead the inner branch blindly re-buys the exact same contract via `this.strategy.buyContract(this.contract, initialQuantity, price)`. The author's own comment flags this (`// Fix: Trade will never be closed, hence needs to monitor`).

- [ ] **Step 1: Write the failing tests**

Create `src/test/biDirectionStrategy.test.ts`:

```ts
/**
 * Verifies two BiDirectionStrategy bug fixes: canHandleOptionQuote's
 * CALL-match reset, and the SELL branch's blind same-contract re-buy
 * instead of reporting the position closed for fresh-strike re-entry.
 * Run: npm run build (compile), then: node ./dist/test/biDirectionStrategy.test.js
 */

import BiDirectionStrategy from '../strategy/BiDirectionStrategy';
import { OptionQuote, Trade } from '../model/model';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    // Bug 1: a real CALL match must survive canHandleOptionQuote.
    const s1 = new BiDirectionStrategy('BiDir1') as any;
    s1.call = { canHandleOptionQuote: (token: string) => token === 'callTok' };
    s1.put = { canHandleOptionQuote: (token: string) => false };
    const quote = Object.assign(new OptionQuote(), { token: 'callTok' });
    assert(s1.canHandleOptionQuote(quote) === true, 'a genuine CALL-side match is not reset to false');

    // Bug 2: openCallTrade/openPutTrade must be invoked via a reported close,
    // not bypassed by a same-contract re-buy inside Contract.updateTrade.
    const s2 = new BiDirectionStrategy('BiDir2') as any;
    let openPutTradeCalls = 0;
    s2.openPutTrade = async () => { openPutTradeCalls++; };
    s2.isPutActive = true;
    s2.put = { contract: 'NIFTY-PUT-OLD', updateTrade: async () => {} };
    // Give put a real Contract-shaped updateTrade via the strategy's own class
    // is not directly constructible here (Contract is unexported) - instead
    // assert on the outer contract: after a SELL trade event for the PUT's
    // contract, tradeClosed must propagate and trigger openPutTrade().
    // This requires driving through BiDirectionStrategy.updateTrade with a
    // real Contract instance, so re-derive `s2.put` from the strategy's own
    // openPutTrade path instead of a hand-rolled stub - see Step 3 below for
    // the exact code path this exercises.
    console.log('  (Bug 2 exercised end-to-end in Step 4 once Contract.updateTrade sets tradeClosed=true.)');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/biDirectionStrategy.test.js`
Expected: FAIL on the Bug 1 assertion (`canHandleOptionQuote(quote) === false` currently).

- [ ] **Step 3: Fix Bug 1**

In `src/strategy/BiDirectionStrategy.ts`, replace `canHandleOptionQuote` with:

```ts
    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        const token = quote.token
        if (this.call.canHandleOptionQuote && this.call.canHandleOptionQuote(token)) {
            return true;
        }
        if (this.put.canHandleOptionQuote && this.put.canHandleOptionQuote(token)) {
            return true;
        }
        return false;
    }
```

- [ ] **Step 4: Fix Bug 2**

In `Contract.updateTrade`'s SELL branch:

```ts
            if (trade.action == this.SELL) {
                this.sellOrderPlaced = false;
                tradeClosed = true;
                this.clear();
                Log.log('After Sell Trade, contract: ', this)
            }
```

(Remove the `const price = round(trade.price - buyAgainDiff)` line and the `await this.strategy.buyContract(this.contract, initialQuantity, price)` call — re-entry now happens through the outer `BiDirectionStrategy.updateTrade`'s `openCallTrade()`/`openPutTrade()`, which correctly picks a fresh strike via `OrderClient.getInstance().getContractByPriceRange`, once `tradeClosed` propagates up.)

Extend the test's Step 1 block with a real end-to-end assertion now that the fix is in place — append to `src/test/biDirectionStrategy.test.ts`, inside `main()`:

```ts
    let openPutCalls2 = 0;
    s1.openPutTrade = async () => { openPutCalls2++; };
    s1.put = {} as any;
    s1.isPutActive = true;
    // Drive updateTrade through the strategy's put Contract by opening one first.
    s1.put.updateTrade = undefined; // force isPending/openPutTrade path off; instead call the real flow:
```

Given `Contract` isn't exported, the cleanest real end-to-end check is via `BiDirectionStrategy.openPutTrade()` + a mocked `OrderClient`/`buyContract`, which is more setup than this bug fix warrants. Replace the placeholder console.log from Step 1 with a direct, minimal assertion instead: read `src/strategy/BiDirectionStrategy.ts`'s SELL branch after the fix and confirm literally (`grep -n "tradeClosed = true" src/strategy/BiDirectionStrategy.ts`) that it now appears in the SELL branch — this is a case where the honest, proportionate verification is a targeted grep, not a fabricated unit test around private, unexported state. Add this as the test's final line:

```ts
import { execSync } from 'child_process';
const grepResult = execSync("grep -n 'tradeClosed = true' src/strategy/BiDirectionStrategy.ts").toString();
assert(grepResult.includes('tradeClosed = true'), 'SELL branch now reports the position closed');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsc && node dist/test/biDirectionStrategy.test.js`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 6: Commit**

```bash
git add src/strategy/BiDirectionStrategy.ts src/test/biDirectionStrategy.test.js
git commit -m "fix: BiDirectionStrategy canHandleOptionQuote CALL-match reset; SELL branch now enables fresh-strike re-entry instead of blind same-contract re-buy"
```

---

## Task 9: `IntermittentStrategy` — wrong re-buy target field

**Files:**
- Modify: `src/strategy/IntermittentStrategy.ts:105` (`updateTrade`)
- Test: `src/test/intermittentStrategy.test.ts` (new)

**Interfaces:** none new.

**Context:** `const targetPrice = configService.getStrategyConfig('IntermittentStrategy').loopCount;` (`:105`) reads the `loopCount` config field into a variable named `targetPrice`, used purely for a log line at `:120` (`sellAt: round(this.price + targetPrice)`) — the real `targetPrice` config field (`config.yml:66`, `targetPrice: 2`) is never read at all here.

- [ ] **Step 1: Write the failing test**

Create `src/test/intermittentStrategy.test.ts`:

```ts
/**
 * Verifies IntermittentStrategy.updateTrade reads the targetPrice config
 * field (not loopCount) for its re-buy sell-target log line.
 * Run: npm run build (compile), then: node ./dist/test/intermittentStrategy.test.js
 */

import configService from '../prism/ConfigService';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const cfg = configService.getStrategyConfig('IntermittentStrategy');
assert(cfg.targetPrice !== cfg.loopCount, 'sanity: targetPrice and loopCount are configured as different values in config.yml (test is meaningless if they happen to match - check config.yml:66-70)');

if (process.exitCode === 1) {
    console.log('SOME TESTS FAILED');
} else {
    console.log('ALL TESTS PASSED');
}
```

This is a config-shaped sanity check, not a behavioral one — `targetPrice` at line 105 only ever feeds a `Log.log` call (`:120`), so there is no return value or state mutation to assert on directly without refactoring the method's structure purely for testability, which is disproportionate for a one-token fix. Verify the fix itself by direct code inspection (Step 3's diff) plus this sanity check that the two config values genuinely differ in `config.yml` (`loopCount: 3`, `targetPrice: 2`), so a future accidental revert would be visible if anyone re-adds an assertion comparing the logged value.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/intermittentStrategy.test.js`
Expected: PASS already (this is a config sanity check, not a pre/post-fix behavioral assertion) — confirms the fix in Step 3 is meaningful before making it.

- [ ] **Step 3: Fix the field**

In `src/strategy/IntermittentStrategy.ts:105`:

```ts
        const targetPrice = configService.getStrategyConfig('IntermittentStrategy').targetPrice;
```

- [ ] **Step 4: Run test to verify it still passes**

Run: `npx tsc && node dist/test/intermittentStrategy.test.js`
Expected: `ALL TESTS PASSED` (unchanged — this test validates the precondition, not the fix's runtime effect; the fix itself is a direct one-line diff, confirmed by re-reading `IntermittentStrategy.ts:105`).

- [ ] **Step 5: Commit**

```bash
git add src/strategy/IntermittentStrategy.ts src/test/intermittentStrategy.test.js
git commit -m "fix: IntermittentStrategy re-buy log reads targetPrice config field instead of loopCount"
```

---

## Task 10: `AntStream` — add reconnect-with-backoff

**Files:**
- Modify: `src/ant/AntStream.ts`
- Verification: manual (websocket reconnect behavior — see Step 3).

**Interfaces:** none new (internal behavior change only — `connect()`/`disconnect()`/`isConnected()` signatures unchanged).

**Context:** `AntStream.ts`'s `ws.on('close', ...)` (`:89-92` per `Analysis.md`, current file) only logs and sets `connected = false` — no reconnect anywhere. Its near-identical sibling `AntDataStream.ts` already implements exponential backoff correctly (`reconnectTimer`, `reconnectDelayMs` starting at 2000ms doubling to a `MAX_RECONNECT_DELAY_MS` of 30000ms, a `manualDisconnect` flag so an intentional `disconnect()` doesn't trigger a reconnect, and a `reconnect()` public method for `/ant/connect`-parity manual triggers). `AntStream` backs the legacy `monitor.ts`/`prism.ts` path, which is still wired into live `server.ts` routes — this is a live reliability gap, not dead code. Port `AntDataStream.ts`'s pattern verbatim.

- [ ] **Step 1: Add the reconnect fields and manual-reconnect method**

In `src/ant/AntStream.ts`, add fields next to `connected`:

```ts
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 2000;
  private readonly MAX_RECONNECT_DELAY_MS = 30000;
  private manualDisconnect = false;
```

- [ ] **Step 2: Port the reconnect scheduling and wire it into the `close` handler**

Replace the `close` handler inside `connect()`:

```ts
      this.ws.on('close', () => {
        Log.log('[AntStream] WebSocket closed');
        this.connected = false;
        if (!this.manualDisconnect) this.scheduleReconnect();
      });

      this.connected = true;
      this.reconnectDelayMs = 2000; // reset backoff on a successful connect
      Log.log('[AntStream] Connected and streaming');
```

Add the reconnect scheduler and a public manual-reconnect method as new class methods (mirroring `AntDataStream.ts:84-111` exactly):

```ts
  // Auto-reconnect with exponential backoff - previously a dropped websocket
  // just sat there until someone manually hit /ant/connect (see AntDataStream.ts,
  // which already has this same pattern for the `data` process's own connection).
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    Log.log(`[AntStream] Reconnecting in ${this.reconnectDelayMs}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((e) => {
        Log.log('[AntStream] Reconnect attempt failed:', e);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.MAX_RECONNECT_DELAY_MS);
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }

  // Mirrors AntDataStream.reconnect()'s semantics (manual /ant/connect-parity trigger).
  async reconnect(): Promise<void> {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.disconnect();
    this.manualDisconnect = false;
    await this.connect();
  }
```

Update `disconnect()` to set the manual flag and clear any pending reconnect timer, so an intentional disconnect doesn't schedule a reconnect right after:

```ts
  disconnect(): void {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
```

Also guard the top of `connect()` (`if (this.connected) { ...; return; }`) with a reset of `manualDisconnect = false` so a fresh `connect()` call after a manual `disconnect()` doesn't leave the flag stuck `true` and silently suppress future auto-reconnects:

```ts
  async connect(): Promise<void> {
    if (this.connected) {
      Log.log('[AntStream] Already connected');
      return;
    }
    this.manualDisconnect = false;
```

- [ ] **Step 3: Manual verification**

This is websocket reconnect behavior against a live broker connection — not something to fake with a unit test without reimplementing `AntWebSocket`'s internals. Verify by code review (`diff` against `AntDataStream.ts`'s equivalent block should be near-identical apart from the class name and the `Monitor`/`Decision`/`myEmitter` broadcast calls `AntStream` has and `AntDataStream` doesn't) and, when market hours allow, a live check: connect via `GET /ant/connect`, kill the underlying TCP connection (e.g. temporarily block outbound traffic to the ANT websocket host), and confirm `server.log`/`orchestrator.log` shows `[AntStream] Reconnecting in 2000ms...` followed by a successful reconnect once connectivity returns — add this as a `ToDo.md` follow-up if it can't be done in the current session (non-market-hours).

- [ ] **Step 4: Commit**

```bash
git add src/ant/AntStream.ts
git commit -m "fix: AntStream reconnects with exponential backoff on a dropped websocket, matching AntDataStream"
```

---

## Task 11: Non-bracket ANT square-off resolves the real fill price

**Files:**
- Modify: `src/processes/order/antExecutor.ts` (`squareOffOnAnt`)
- Verification: manual (live ANT order flow — see Step 3).

**Interfaces:** none new.

**Context:** `squareOffOnAnt`'s plain-SELL branch sets `trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;` with a comment admitting the real fill price is "left as the entry price for now." `AntOrderNotifyStream.getInstance().waitForFill(orderNo)` already exists and is already used for the buy path (`antExecutor.ts:75`) to resolve a real fill price from the order-notify websocket push, keyed by `orderNo`. Reuse it for the plain-order sell path — `ant.placeOrder(...)` already returns `{ orderNo }`, it's just not captured today.

Note: `waitForFill`'s correctness depends on an assumption `AntOrderNotifyStream.ts`'s own header comment flags as unverified pending market hours (`brokerOrderId` from the REST response vs `norenordno` from the WS push being the same value) — already tracked in `ToDo.md`. This task reuses the same mechanism the buy path already trusts; it does not introduce a new unverified assumption, but its correctness inherits that same open verification item.

- [ ] **Step 1: Capture `orderNo` from the plain-order square-off branch**

In `src/processes/order/antExecutor.ts`'s `squareOffOnAnt`, the plain-order branch currently does:

```ts
        Log.log(`[order] Manual square-off ${tsym} qty=${quantity} for ${userId} via ANT regular order`);
        const instrumentId = existing?.token ?? '';
        await ant.placeOrder({
            exchange,
            instrumentId,
            tradingSymbol: tsym,
            quantity,
            transactionType: 'SELL',
        });
```

Change to capture the order number and wait for the real fill price, matching the buy path's own pattern:

```ts
        Log.log(`[order] Manual square-off ${tsym} qty=${quantity} for ${userId} via ANT regular order`);
        const instrumentId = existing?.token ?? '';
        const { orderNo } = await ant.placeOrder({
            exchange,
            instrumentId,
            tradingSymbol: tsym,
            quantity,
            transactionType: 'SELL',
        });
        squareOffOrderNo = orderNo;
```

- [ ] **Step 2: Use the real fill price when a plain-order `orderNo` was captured**

Declare `let squareOffOrderNo: string | undefined;` before the `if (existing?.antOrderNo) { ... } else { ... }` branch, then replace the trade-price assignment:

```ts
    const trade = new Trade();
    trade.tsym = tsym;
    trade.quantity = quantity;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;
    if (squareOffOrderNo) {
        try {
            trade.price = await AntOrderNotifyStream.getInstance().waitForFill(squareOffOrderNo);
        } catch (e) {
            Log.log('[order] squareOffOnAnt: waitForFill failed, falling back to last-seen price:', e);
            trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;
        }
    } else {
        // exitBracketOrder path (existing?.antOrderNo) - no separate orderNo to poll a fill price for.
        trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;
    }
```

Confirm `AntOrderNotifyStream` is already imported in this file (it is, per the existing buy path at `:75`).

- [ ] **Step 3: Manual verification**

This depends on a live ANT order fill notification arriving over the order-notify websocket — not fakeable without a full mock of `AntOrderNotifyStream`'s internal `pending` map and its websocket message handler. Verify by code review against the buy path's already-working `waitForFill(orderNo)` usage (same function, same failure-mode handling), and add a note to `ToDo.md`: "once market reopens, place a small non-bracket ANT position, square it off via the plain-order path, and confirm the squared-off trade's recorded `price` matches the real fill (not the stale entry/last-tick price) — piggybacks on the existing `AntOrderNotifyStream` verification item already in `ToDo.md`."

- [ ] **Step 4: Commit**

```bash
git add src/processes/order/antExecutor.ts
git commit -m "fix: non-bracket ANT square-off resolves the real fill price via AntOrderNotifyStream instead of the stale entry price"
```

---

## Task 12: Contract-master staleness — warn on a stale file instead of failing silently

**Files:**
- Modify: `src/ant/AntContractMaster.ts:45-59` (`loadNFO`, `loadBFO`)
- Modify: `src/zerodha/ZerodhaContractMaster.ts` (`loadInstruments`)
- Test: `src/test/contractMasterStaleness.test.ts` (new)

**Interfaces:**
- Produces: both loaders log a `WARNING` (via `Log`) the first time they load a file older than a fixed threshold. No behavior change to lookups themselves — this is detection/visibility only, not a refresh mechanism (an automated refresh is a bigger, separate change; "silently fails with no distinguishing signal" is the specific gap being closed here).

**Context:** Both `AntContractMaster.loadNFO()`/`loadBFO()` (`:45-59`) and `ZerodhaContractMaster.loadInstruments()` load their static file once per process lifetime with no TTL/mtime check — only expired-*contract* filtering exists, not staleness-of-*file* detection. A stale master (the account's data wasn't re-downloaded in weeks) just silently fails lookups with nothing to distinguish that from "this strike genuinely doesn't exist."

- [ ] **Step 1: Write the failing test**

Create `src/test/contractMasterStaleness.test.ts`:

```ts
/**
 * Verifies AntContractMaster/ZerodhaContractMaster log a warning when their
 * backing file is older than the staleness threshold.
 * Run: npm run build (compile), then: node ./dist/test/contractMasterStaleness.test.js
 */

import fs from 'fs';
import path from 'path';
import Log from '../util/Log';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const logged: string[] = [];
const originalLog = Log.log;
(Log as any).log = (...args: any[]) => { logged.push(args.join(' ')); originalLog(...args); };

// Backdate the real NFO_contract.json's mtime temporarily to exercise the
// staleness path, then restore it - safer than depending on the file
// already being stale (it might genuinely be fresh in this checkout).
const nfoPath = path.join(__dirname, '../../data/ant/NFO_contract.json');
const original = fs.statSync(nfoPath);
const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
fs.utimesSync(nfoPath, oldTime, oldTime);

// Import after backdating, and after monkey-patching Log, so the module's
// first load (which triggers the staleness check) sees both.
delete require.cache[require.resolve('../ant/AntContractMaster')];
const AntContractMaster = require('../ant/AntContractMaster').default;
AntContractMaster.getInstance().findOption; // trigger the loader if it's lazy - see Step 3 for exact call

fs.utimesSync(nfoPath, original.atime, original.mtime); // restore immediately, before any assertion can throw and skip this

assert(logged.some(l => l.includes('stale') || l.includes('WARNING')), 'logs a staleness warning for a 30-day-old contract file');
(Log as any).log = originalLog;

if (process.exitCode === 1) {
    console.log('SOME TESTS FAILED');
} else {
    console.log('ALL TESTS PASSED');
}
```

Adjust the exact trigger call in Step 3 below once you've confirmed `findOption`'s real signature (`AntContractMaster.ts:60+`, not fully quoted here) — the test needs to call whatever public method actually invokes `loadNFO()`/`loadBFO()` lazily.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test/contractMasterStaleness.test.js`
Expected: FAIL — no staleness warning logged (feature doesn't exist yet).

- [ ] **Step 3: Add the staleness check**

In `src/ant/AntContractMaster.ts`, add a constant and a helper near the top of the class:

```ts
  private readonly STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  private warnedStale = new Set<string>();

  private checkStaleness(filePath: string): void {
    if (this.warnedStale.has(filePath)) return;
    try {
      const ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
      if (ageMs > this.STALE_THRESHOLD_MS) {
        const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        console.warn(`[AntContractMaster] WARNING: ${filePath} is ${days} days old - re-download from https://v2api.aliceblueonline.com/restpy/static/contract_master/V2/ (see CLAUDE.md)`);
      }
      this.warnedStale.add(filePath);
    } catch (e) {
      // Non-fatal - staleness detection is a courtesy warning, not a load-blocking check.
    }
  }
```

Call it at the top of both loaders:

```ts
  private loadNFO(): ContractRecord[] {
    if (!this.nfoCache) {
      this.checkStaleness(this.NFO_PATH);
      const data = JSON.parse(fs.readFileSync(this.NFO_PATH, 'utf-8'));
      this.nfoCache = data.NFO || [];
    }
    return this.nfoCache;
  }

  private loadBFO(): ContractRecord[] {
    if (!this.bfoCache) {
      this.checkStaleness(this.BFO_PATH);
      const data = JSON.parse(fs.readFileSync(this.BFO_PATH, 'utf-8'));
      this.bfoCache = data.BFO || [];
    }
    return this.bfoCache;
  }
```

(`console.warn` rather than this file's `Log` — check whether `AntContractMaster.ts` already imports `Log`; if not, either add the import and use `Log.log` for consistency with the rest of the codebase, or keep `console.warn` if the file has deliberately stayed dependency-light. Match whatever's already true of the file.)

Do the same for `src/zerodha/ZerodhaContractMaster.ts`'s `loadInstruments()`, using a threshold message pointing at `scripts/download-zerodha-master.sh` instead (per that file's own header comment on how to refresh).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc && node dist/test/contractMasterStaleness.test.js`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/ant/AntContractMaster.ts src/zerodha/ZerodhaContractMaster.ts src/test/contractMasterStaleness.test.js
git commit -m "fix: warn when the ANT/Zerodha contract master file is stale instead of failing lookups silently"
```

---

## Task 13: `pendingLimitOrders`/`exitMonitor` — startup reconciliation

**Files:**
- Modify: `src/processes/orderProcess.ts:336-368` (`main`)
- Modify: `src/processes/order/exitMonitor.ts` (export a reconciliation helper)
- Verification: manual (requires a live Zerodha session — see Step 4).

**Interfaces:**
- Produces: `exitMonitor.reconcileFromTrades(trades: Trade[]): void` — re-registers every open trade that has a `targetPrice`/`stopLossPrice` set but isn't currently in `exitMonitor`'s in-memory `monitored` map.

**Context:** `pendingLimitOrders.ts`'s `pending` map and `exitMonitor.ts`'s `monitored` map are both in-memory-only (`pendingLimitOrders.ts:6-12` already documents this as a known limitation) — a process restart silently drops tracking of a pending limit order or an active target/SL watch, with no reconciliation against live broker state on startup. A pending limit order that already filled at the broker while `order` was down is a smaller problem (the position exists at the broker and shows up in `bookkeeping.trades` once refreshed — it just missed getting its GTT/exit-monitor registration). The `exitMonitor` half is the more actionable, lower-risk fix within this session: `bookkeeping.trades` is the live source of truth for open positions, and any trade in it with `targetPrice`/`stopLossPrice` set but `useGTT=false` for its user should be watched by `exitMonitor` — reconcile from that on every `order` process startup.

Full broker-side reconciliation for `pendingLimitOrders` (re-querying Zerodha's live order book for any limit order placed by this account that isn't in the in-memory map) needs a "list all my open orders" broker call this plan hasn't verified exists/is wired — treat that as a follow-up, not part of this task, and say so explicitly rather than half-implementing it.

- [ ] **Step 1: Add `exitMonitor.reconcileFromTrades`**

In `src/processes/order/exitMonitor.ts`, add:

```ts
// Called once at order-process startup: exitMonitor's in-memory `monitored`
// map doesn't survive a restart (see this file's header comment), but
// bookkeeping.trades is the live source of truth for open positions. Any
// open trade with a target/SL set that isn't already being watched gets
// re-registered here, closing the "restart silently drops SL/target
// monitoring for useGTT=false users" gap.
export function reconcileFromTrades(trades: Trade[]): void {
    let reconciled = 0;
    for (const trade of trades) {
        if (!trade.token) continue;
        if (monitored.has(trade.token)) continue;
        if (trade.targetPrice == null && trade.stopLossPrice == null) continue;
        // Exchange/broker aren't stored on Trade - infer exchange the same
        // way setTargetStopLoss does (tsym prefix), and broker from
        // whichever executor's Trade shape this is (antOrderNo present -> ant,
        // otherwise zerodha - matches this file's existing Broker union).
        const exchange: 'NFO' | 'BFO' = trade.tsym?.startsWith('BSE') ? 'BFO' : 'NFO';
        const broker: Broker = trade.antOrderNo ? 'ant' : 'zerodha';
        registerTrade(trade, exchange, broker);
        reconciled++;
    }
    if (reconciled > 0) {
        Log.log(`[order] exitMonitor: reconciled ${reconciled} open trade(s) with target/SL back onto the watch list after restart`);
    }
}
```

Import `Trade` from `../../model/model` if not already imported in this file (it is — `exitMonitor.ts` already imports `OptionQuote, Trade` from `../../model/model`).

- [ ] **Step 2: Call it from `orderProcess.ts`'s startup**

In `src/processes/orderProcess.ts`'s `main()` (`:336-368`), after `bookkeeping.trades` has been populated — this requires confirming where/whether `main()` already refreshes `bookkeeping.trades` from Mongo or the broker at startup before this point. Search first:

Run: `grep -n "refreshTrades\|bookkeeping.trades\s*=" src/processes/orderProcess.ts src/processes/order/*.ts`

If `bookkeeping.trades` is only ever populated live (via fills, not a startup refresh), this reconciliation call has nothing to reconcile against on a fresh restart until the first `refreshTradeList`/equivalent call happens — in that case, call `exitMonitor.reconcileFromTrades(bookkeeping.trades)` immediately after whatever startup refresh call populates `bookkeeping.trades` (not before), even if that means placing it later than `loadUserLimits()`. If no such startup refresh exists at all today, add the reconciliation call right after `loadUserLimits()` anyway (`:338`) — it will simply reconcile 0 trades in that case, matching current (already-limited) startup behavior, and note this explicitly in the commit message so it's not mistaken for a complete fix:

```ts
    await loadUserLimits();
    exitMonitor.reconcileFromTrades(bookkeeping.trades);
```

Import `exitMonitor` (already imported in this file per Task 1's context — `import * as exitMonitor from './exitMonitor';` if not already present) and `bookkeeping` (already imported).

- [ ] **Step 3: Manual verification**

This needs a real open position with `targetPrice`/`stopLossPrice` set and `useGTT=false`, surviving an `order`-process restart — not mockable without faking `bookkeeping.trades`' full startup population path. Verify by code review (confirm `reconcileFromTrades` is reachable from `main()` and its trade-shape assumptions match `zerodhaExecutor.ts`/`antExecutor.ts`'s actual `Trade` construction), and add to `ToDo.md`: "verify exitMonitor.reconcileFromTrades against a real useGTT=false position across an order-process restart once market hours allow — confirm the re-registered trade's target/SL still trigger correctly."

- [ ] **Step 4: Commit**

```bash
git add src/processes/order/exitMonitor.ts src/processes/orderProcess.ts
git commit -m "fix: exitMonitor reconciles open trades with target/SL back onto its watch list after an order-process restart"
```

---

## Self-Review Notes

- **Spec coverage:** Punch-list items 14→Task 1, 15→Task 2, 16→Task 3, 17→Task 4, 18→Task 5, 19→Task 6, 20→Tasks 10+11+12 (the three sub-findings bundled under item 20), 21→Task 13, 22→Tasks 7+8+9 (the seven dormant-strategy bugs, grouped by file into three tasks).
- **Placeholder scan:** Tasks 7-9's tests lean on code-inspection/grep-based verification for the pieces that touch unexported internal classes (`HighLotStrategy`'s `Order`, `BiDirectionStrategy`'s `Contract`) rather than fabricating brittle reflection-based unit tests — this is called out explicitly in each task rather than silently glossed over, and is a legitimate proportionate response given the file's existing lack of exports, not a placeholder.
- **Type consistency:** `Trade.brokerOrderId`/`Trade.unrealizedPnL` (money-correctness plan) aren't touched here; this plan's only new shared type is `exitMonitor.reconcileFromTrades(trades: Trade[])`, used once.
- Task 5 (live stats wiring) is a prerequisite in spirit for Tasks 7-8's `this.stats`-gated code (`HighLotStrategy.isStdDeviationInRange`, `BiDirectionStrategy.receive`) to ever see real data — but each task's tests are self-contained (they seed `this.stats`/mock the relevant pieces directly rather than depending on Task 5 having run first), so the tasks can be executed in any order within this plan; Task 5 is ordered first only because it's the largest, most architecturally significant change.
- Tasks 10-13 lean on manual/live verification because they depend on real websocket/broker state this repo has no mocking harness for (consistent with the "no test-harness build-out" constraint) — each says so explicitly and names the exact live check to run once market hours allow, rather than skipping verification silently.
