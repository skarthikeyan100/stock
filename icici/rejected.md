# Rejected buys, margin-aware hedge, maxLossPerTrade / maxLossPerDay - implementation plan

Written 2026-10-22 after a live incident. Status: implemented 2026-10-22 (T1-T6 in the commits listed in `git log`;
T5 `config.yml` left uncommitted, see the final report). Not yet verified live. This file is written so a smaller model can
implement it task by task. Read section 0 first, then do the tasks in order. Do not skip ahead.

## 0. Rules for the implementer (read before touching anything)

1. **Never edit `src/` while a trading process or any BulkPcr position is live.** `tsc -w` rebuilds and the
   orchestrator restarts the child processes; a restart mid-position fails closed (reconcile marks slots for
   manual review). Before the first edit run `pgrep -fa "dist/orchestrator|dist/processes" || echo none`. It must
   print `none`. If it prints anything, STOP and ask the user.
2. **Freeze until 2026-10-28 (CLAUDE.md):** do NOT run the `code-review` skill and do NOT run any test script
   (`npm run test:*`, `jest`). Verify with `npx tsc --noEmit -p .` and by re-reading your own diff only.
3. Work on the current branch (`bulkpcr-loss-stop`). Commit and push after each task group (T1-T3, T4, T5-T6)
   with specific `git add <files>` (never `git add -A`: the tree has many unrelated modified/untracked files,
   and token files `.zerodha_session.json`, `.breeze_session.json`, `.ant_session.json` must never be committed).
   Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
4. Match the surrounding code style: this codebase uses long explanatory comments that say WHY (with the live
   incident date). Keep comments, but short. Use `Log.log(...)` with the `[BulkPcrStrategy] [${broker}]` prefix.
5. Think through variations before calling a task done: both option sides (CALL and PUT), a position split into
   several chunks, a restart mid-state (persisted state + reconcile), and one broker stopped while another runs.
6. Do not change anything not listed here. If something in this plan does not match the code you find, STOP and
   ask the user rather than guessing.

Files you will touch: `src/strategy/BulkPcrStrategy.ts` (main), `src/processes/order/antExecutor.ts` (T3),
`src/strategy/PnlStop.ts` (log text only, T5), `src/prism/percentConfig.ts` and `src/prism/configValidation.ts` (T5),
`config.yml` (T5), `scripts/monitor-bulkpcr-events.sh` (T6), `maxloss.md` and `strategies.md` (T7), this file (T7).

## 1. What happened (live, 2026-10-22, NIFTY)

- 14:25 slot: put entered on ant/zerodha/breeze, qty 780 each (ANT 780 @ 121.55, about 94.8k).
- 14:32:35: each put fell `slDistance` (10) points below its own entry, so each broker opened its call hedge
  (`openOppositeSide`, qty 780). Zerodha and Breeze hedged fine and cycled +2 sells and re-buys.
- ANT's hedge buy was rejected by the broker: `RED:Margin Shortfall:INR 32491.91 Available:INR 233123.35`.
  The strategy treated it as "did not fill" (`isNothingBought`), set the side `pending`, and retried the
  identical order every 10 s: 18 rejections between 14:32:36 and 14:35:28. Each retry also tried to cancel an
  already-rejected order ("SAF:order is not open to cancel").
- ANT's put ran unhedged while the call premium rose 169 -> 190+. ANT's daily loss stop tripped at 14:35:31
  (cumulative -10,309 vs -10,000). Zerodha tripped 14:48:09 (-10,101), Breeze 14:48:15 (-10,011): the put
  losses carried each broker to its stop while the call hedges kept cycling +2. Slots after 14:45 skipped.

Margin data (ANT, qty 780): order value minus the reported shortfall was a constant, about 99,640, on all 18
rejections, while "Available" stayed 233,123.35. So only about 99.6k was usable for the order. Entries are
sized to `maxInvestment` 100,000 (845 x 117 = 98,865), which is why one leg fits and a 132-149k second leg
never does. Affordable hedge quantity was about 590 at premium 169 and about 520 at 190, not 780.

## 2. Decisions already made (do not re-decide)

- **Margin rejection = deterministic.** Never retry the same order. Make ONE reduced-quantity attempt (only when
  the ANT rejection text can be parsed); if that is rejected or no reduced size exists, abandon that side for
  the rest of the cycle with one `ALERT` log line.
- **Other "nothing bought" failures** (timeouts etc.): retry at most 3 times with doubling backoff, then abandon.
- **Abandoned hedge:** keep the other side's resting +2 sell; do NOT close it. The loss stops and the end-of-day
  close are the backstop. Never re-open an abandoned hedge in the same cycle.
- **Root entry** (`enterOnBroker`): a margin rejection is not retried and not resized; the slot is marked `done`
  with one `ALERT`.
- **Two stop levels, both a percent of the block's `maxInvestment` (same `"10%"` form, parsed with `toPercentNumber`):**
  - `maxLossPerDay` = the EXISTING `maxLoss`, renamed, behaviour UNCHANGED: cumulative for the day per broker (day's
    realized + open P&L), one-way latch persisted for the day in Mongo, the broker closes its slots and takes no new
    buys until an admin `reset`.
  - `maxLossPerTrade` = NEW: a per-slot cap. One "trade" = one auto-start slot = one cycle on one broker = everything
    since the last `reset()` (the auto-start calls `reset({ keepStops: true })` before each slot). Trade P&L = realized
    since that reset + open P&L of that broker's selling slots (both sides, across re-buys). When it trips: cancel the
    resting sells, close every open leg of that broker (reuse `closeBroker`), block that broker's buys until the next
    `reset()`, log ONE `ALERT`. It does NOT latch for the day: the broker is armable again at the next slot (unless
    `maxLossPerDay` has latched). Its realized loss still counts toward `maxLossPerDay`.
  - Why (user, 2026-10-22): profit from earlier slots must not raise the loss a later slot may take. Slot 1 +2, limit
    10: the cumulative stop lets slot 2 lose 12 (day ends -10); a per-trade cap stops slot 2 at -10 (day ends -8).
    Today's ANT: its six earlier slots made about +8,580 (1,430 + 1,430 + 1,300 + 1,430 + 1,300 + 1,690) and the stop
    tripped at a cumulative -10,309, so the 14:25 trade had actually lost about 18,900 against a 10,000 budget.
  - Both keys are optional (unset = off). `maxLossPerTrade` ships UNSET (the user picks the value). `maxLossPerDay`
    keeps the value the old `maxLoss` had (10%).
- **Rename scope:** only the two `BulkPcrStrategy` blocks in `config.yml` rename `maxLoss` -> `maxLossPerDay`.
  `ContinuousStrategy` / `SupportResistanceStrategy` keep `maxLoss` (a different implementation in `LegManager`, left
  alone). Ask the user only if they want those renamed too.
- **A forgotten rename must not silently disable the stop:** `BulkPcrStrategy` reads `maxLossPerDay`, and if that is
  absent but the old `maxLoss` is present it uses it and logs one `WARN` that the key was renamed.
- **Value caution (tell the user):** the hedge opens when the put is `slDistance` (10) points down, about 7,800 on 780
  qty. A `maxLossPerTrade` at or below that makes the hedge pointless; at 10% (10,000) only about 2,200 is left after
  the hedge opens. Suggested pairing: `maxLossPerTrade` <= `maxLossPerDay`.
- Out of scope here (separate work): sizing ANT's entry so put + hedge both fit; a max cycle age.

## 3. Tasks

### T1. Helpers and constants in `BulkPcrStrategy.ts`

Near the top of the file, next to `REBUY_RETRY_THROTTLE_MS` (line ~28) and `MARGIN_SHORTFALL_REASON_PATTERN`
(line ~53), add:

```ts
// A buy that was rejected or unfilled is retried at most this many times (transient failures only; a margin
// rejection is never retried as-is - see onBuyNotFilled). Live 2026-10-22: ANT's hedge buy was retried 18 times.
const MAX_BUY_RETRIES = 3;
// Headroom kept when shrinking a hedge to fit margin: the premium moves between attempts.
const MARGIN_RESIZE_BUFFER = 0.05;
// Lot sizes needed to round a reduced quantity down to a whole lot. Same values as
// bookkeeping.getInstrumentLotSize, which lives in the order process and is not importable here.
const LOT_SIZE: Record<'NIFTY' | 'SENSEX', number> = { NIFTY: 65, SENSEX: 20 };
```

Add this pure function next to `isNothingBought` (line ~107):

```ts
// Parses an ANT margin rejection out of buyChunked's error text. The text embeds the broker order JSON, e.g.
//   ... REJECTED: {..."quantity":780,..."price":169.4,..."rejectionReason":"RED:Margin Shortfall:INR 32491.91 Available:INR 233123.35 for ..."...}
// Returns null if any field is missing (a non-ANT broker's wording differs), so the caller abandons instead of guessing.
function parseAntMarginReject(message: string): { quantity: number; price: number; shortfall: number } | null {
    const qty = /"quantity":\s*(\d+)/.exec(message);
    const price = /"price":\s*([0-9.]+)/.exec(message);
    const short = /Margin Shortfall:INR\s*([0-9.]+)/i.exec(message);
    if (!qty || !price || !short) return null;
    const quantity = Number(qty[1]);
    const p = Number(price[1]);
    const shortfall = Number(short[1]);
    if (!(quantity > 0) || !(p > 0) || !(shortfall > 0)) return null;
    return { quantity, price: p, shortfall };
}
```

Add these optional fields to `interface BrokerPosition` (line ~116), with a one-line comment each:

```ts
    // Failed buy attempts since the last successful buy of this slot (transient-failure retry cap).
    buyAttempts?: number;
    // True once this slot's buy was shrunk after a margin rejection (only one resize per slot).
    marginResized?: boolean;
    // True when this slot's buy was given up for this cycle (margin, or retry cap). Blocks reopening the hedge.
    abandoned?: boolean;
```

These live on the position, so `persistState()` already saves them and reconcile restores them (positions are
persisted whole). Nothing else to persist for T1-T3.

Done when: `npx tsc --noEmit -p .` passes.

### T2. Stop blind retries and resize the hedge (`BulkPcrStrategy.ts`)

**T2a. `buyAndExit` catch block** (line ~896, the `if (isNothingBought(e))` branch). Replace the branch body
`pos.phase = 'pending'; Log.log(... did not fill - will retry on the next tick ...)` with a call to a new method,
keep the `else` (error) branch exactly as is:

```ts
            if (isNothingBought(e)) {
                this.onBuyNotFilled(pos, message);
            } else {
```

On success (right after `pos.entryAvg = result.avgPrice;` in the same try block) add `pos.buyAttempts = 0;`.

**T2b. New methods**, placed directly after `buyAndExit`:

```ts
    // A buy provably filled nothing. A margin rejection is deterministic: the identical order can never succeed, so
    // it is never retried as-is (live 2026-10-22: 18 identical rejected ANT hedge buys). It gets ONE smaller attempt
    // when the rejection can be parsed; anything else retries a capped number of times with doubling backoff.
    private onBuyNotFilled(pos: BrokerPosition, message: string): void {
        pos.buyAttempts = (pos.buyAttempts ?? 0) + 1;
        if (MARGIN_SHORTFALL_REASON_PATTERN.test(message)) {
            const reduced = pos.marginResized ? null : this.marginReducedQuantity(pos, message);
            if (reduced !== null) {
                Log.log(`[BulkPcrStrategy] [${pos.broker}] ALERT: ${pos.right} buy rejected for margin - retrying ONCE with reduced qty ${pos.entryQuantity} -> ${reduced}`);
                pos.entryQuantity = reduced;
                pos.marginResized = true;
                pos.phase = 'pending';
                pos.lastBuyAttemptAt = 0; // retry on the next tick instead of waiting out the throttle
                return;
            }
            this.abandonBuy(pos, pos.marginResized ? 'margin rejection again after the reduced-size attempt' : 'margin rejection and no affordable reduced size');
            return;
        }
        if (pos.buyAttempts >= MAX_BUY_RETRIES) {
            this.abandonBuy(pos, `${pos.buyAttempts} failed attempts: ${message.slice(0, 200)}`);
            return;
        }
        pos.phase = 'pending';
        Log.log(`[BulkPcrStrategy] [${pos.broker}] ${pos.right} buy did not fill - will retry on the next tick (attempt ${pos.buyAttempts}/${MAX_BUY_RETRIES}): ${message}`);
    }

    // Quantity that fits the margin the broker implied, rounded down to a whole lot, or null if none fits.
    // usable = price x qty - shortfall (what the rejection says WAS affordable); keep a 5% buffer.
    private marginReducedQuantity(pos: BrokerPosition, message: string): number | null {
        const parsed = parseAntMarginReject(message);
        if (!parsed) return null;
        const lot = LOT_SIZE[this.index()];
        if (!(pos.entryQuantity && pos.entryQuantity % lot === 0)) return null; // unexpected size: do not guess
        const usable = parsed.price * parsed.quantity - parsed.shortfall;
        const units = Math.floor((usable * (1 - MARGIN_RESIZE_BUFFER)) / parsed.price);
        const reduced = Math.floor(units / lot) * lot;
        return reduced >= lot && reduced < pos.entryQuantity ? reduced : null;
    }

    // Gives up this side's buy for the rest of the cycle. 'done' + abandoned: nothing is held, the other side's
    // resting +2 sell is left alone, and openOppositeSide will not reopen this hedge (see its guard).
    private abandonBuy(pos: BrokerPosition, why: string): void {
        pos.phase = 'done';
        pos.abandoned = true;
        Log.log(`[BulkPcrStrategy] [${pos.broker}] ALERT: ${pos.right} buy abandoned for this cycle - ${why}`);
    }
```

**T2c. `retryPendingRebuys`** (line ~913): replace the throttle line
`if (Date.now() - (pos.lastBuyAttemptAt ?? 0) < REBUY_RETRY_THROTTLE_MS) continue;` with:

```ts
            // Doubling backoff per failed attempt (10s, 20s, 40s), so a failing buy never fires every tick.
            const wait = REBUY_RETRY_THROTTLE_MS * 2 ** Math.max(0, (pos.buyAttempts ?? 1) - 1);
            if (Date.now() - (pos.lastBuyAttemptAt ?? 0) < wait) continue;
```

**T2d. Never reopen an abandoned hedge.** In `processOptionQuote` loop (line ~777, the `for (const slot of matches)`),
add as the first guard after the `isBrokerStopped` check:

```ts
            if (this.slotsOf(slot.broker).some((p) => p.abandoned)) continue; // hedge given up this cycle
```

(The existing check `filter(p => p.phase !== 'done').length !== 1` would otherwise let the lone put reopen the
hedge on every tick, because the abandoned side is 'done'.)

**T2e. Root entry** (`enterOnBroker`, line ~592 catch). Before the existing `if (nothingWasBought && !isRetry)`
add:

```ts
            if (nothingWasBought && MARGIN_SHORTFALL_REASON_PATTERN.test(message)) {
                // Deterministic: waiting 10s and re-sending the same order cannot succeed.
                Log.log(`[BulkPcrStrategy] [${broker}] ALERT: ${right} entry rejected for margin - not retrying: ${message.slice(0, 200)}`);
                const slot = this.positions.get(key);
                if (slot) { slot.phase = 'done'; slot.abandoned = true; }
                this.persistState();
                this.finishIfFlat();
                return;
            }
```

Variations to check: PUT and CALL; Zerodha/Breeze margin wording (resize returns null -> abandoned, correct);
`marginResized` already true -> abandoned; re-buy (not hedge) path uses the same `buyAndExit`, so it is covered.

Done when: tsc passes and a re-read shows no path that re-sends a margin-rejected order unchanged.

### T3. Do not cancel an already-rejected ANT order (`src/processes/order/antExecutor.ts`)

In `resolveUnconfirmedAntBuy` (line ~165), directly after the block
`if (before && before.quantity === requested) return before;` add:

```ts
    // The broker already REJECTED this order: it never reached the exchange, so nothing filled and there is nothing to
    // cancel (the cancel only produced "order is not open to cancel" noise on every retry, live 2026-10-22).
    if (/\bREJECTED\b/.test(String(pollErr?.message ?? '')) && !(before && before.quantity > 0)) {
        Log.log(`[order] ANT order ${orderNo} was REJECTED at the broker - nothing filled, not cancelling`);
        throw pollErr;
    }
```

The thrown `pollErr` still carries the broker JSON, which T2 parses. Keep the original `before.quantity > 0`
partial-fill path untouched (it falls through to the existing logic).

Done when: tsc passes. Commit T1-T3 together:
`git add src/strategy/BulkPcrStrategy.ts src/processes/order/antExecutor.ts`.

### T4. maxLossPerTrade: the per-slot cap (`BulkPcrStrategy.ts`)

**T4a. State.** Next to `private realizedByBroker` (line ~260) add:

```ts
    // Per-trade loss cap (maxLossPerTrade). A trade = one auto-start slot = everything since the last reset().
    // cycleRealizedByBroker is the current trade's realized P&L; cycleStopped holds brokers whose trade was closed by the
    // cap (cleared by reset(), so the next slot can arm). Live 2026-10-22: ANT's 14:25 trade lost about 18,900 against a
    // 10,000 limit because six winning slots offset it in the day's cumulative total.
    private cycleRealizedByBroker = new Map<BrokerName, number>();
    private cycleStopped = new Set<BrokerName>();
```

**T4b. Book into both totals.** In `bookRealized` (line ~403) after the existing `this.realizedByBroker.set(...)` line add:
`this.cycleRealizedByBroker.set(broker, (this.cycleRealizedByBroker.get(broker) ?? 0) + pnl);`

**T4c. Persist/restore.** Add `cycleRealizedByBroker?: Partial<Record<BrokerName, number>>;` to `interface PersistedState`
(line ~161). In `persistState` (line ~345) add `cycleRealizedByBroker: Object.fromEntries(this.cycleRealizedByBroker),`
next to `realizedByBroker`. In the reconcile restore block (line ~1247, the
`for ... of Object.entries(persisted.realizedByBroker ?? {})` loop) add the same loop for
`persisted.cycleRealizedByBroker` into `this.cycleRealizedByBroker`. In `ensureToday` (line ~365) add
`this.cycleRealizedByBroker.clear(); this.cycleStopped.clear();`. (`cycleStopped` is in memory only, on purpose: after a
restart the slots are reconciled and the cap simply re-evaluates on the first tick.)

**T4d. Reset = new trade.** In `reset()` (line ~1631) add `this.cycleRealizedByBroker.clear(); this.cycleStopped.clear();`
at the TOP of the method, before the `if (opts?.keepStops)` branch, so both reset modes start a fresh trade. The
`keepStops` path keeps the day latch and the DAY's `realizedByBroker`, but the trade starts at 0.

**T4e. Make the cap block buying.** In `isBrokerStopped` (line ~390), right after the pair-broker check, add
`if (this.cycleStopped.has(broker as BrokerName)) return true;` so every existing guard (`buyAndExit`, `openOppositeSide`,
`retryPendingRebuys`, `onSlotSoldOut`'s re-buy, `closeBroker` callers) treats a cap-stopped broker like a stopped one
for the rest of THIS trade. Then in `tripIfBreached` (line ~432) replace
`if (this.isBrokerStopped(broker)) return false;` with
`if (this.stopFor(broker).isTripped()) return false;`
so the DAILY stop keeps being evaluated while a cap close is running (otherwise the cap-close's realized loss could cross
the daily line unnoticed, and the next slot would arm, buy and trip at once).

**T4f. The check.** Add next to `tripIfBreached`:

```ts
    // Trade P&L = this trade's realized + open P&L of the broker's selling slots. cumulativePnl() already adds the DAY's
    // realized, so swap that part for the trade's.
    private tradePnl(broker: BrokerName): number {
        return this.cumulativePnl(broker) - (this.realizedByBroker.get(broker) ?? 0) + (this.cycleRealizedByBroker.get(broker) ?? 0);
    }

    // True only on the call that newly caps the trade, so the caller starts closeBroker exactly once. Disabled when
    // maxLossPerTrade is unset or unusable. Same percent-of-maxInvestment form as maxLossPerDay.
    private tripTradeIfBreached(broker: BrokerName): boolean {
        if (!isPairBroker(broker) || this.eodDone || this.cycleStopped.has(broker) || this.stopFor(broker).isTripped()) return false;
        const raw = this.cfg().maxLossPerTrade;
        if (raw == null) return false;
        const pct = toPercentNumber(raw);
        const maxInvestment = this.cfg().maxInvestment ?? 0;
        const threshold = pct !== null && pct > 0 ? (pct / 100) * maxInvestment : 0;
        if (!(threshold > 0)) return false; // unusable value: not enforced (config validation reports it)
        const pnl = this.tradePnl(broker);
        if (!Number.isFinite(pnl) || pnl > -threshold) return false;
        this.cycleStopped.add(broker);
        Log.log(`[BulkPcrStrategy] [${broker}] ALERT: MAX LOSS PER TRADE TRIPPED - trade P&L=${Math.round(pnl)} threshold=-${Math.round(threshold)} (maxLossPerTrade=${pct}% of maxInvestment=${maxInvestment}) - closing this broker's open slots at limit`);
        return true;
    }
```

Add `import { toPercentNumber } from '../prism/percentConfig';` to the imports.

**T4g. Call sites.** (1) `processOptionQuote`, right after the existing daily-stop block (the `tripped` array and its
`closeBroker` loop, line ~766-772) add:

```ts
        const tradeTripped = Array.from(new Set(matches.map((m) => m.broker))).filter((b) => this.tripTradeIfBreached(b));
        if (tradeTripped.length > 0) await Promise.all(tradeTripped.map((b) => this.closeBroker(b)));
```

(2) `onSlotSoldOut` (line ~929): a realized loss can cross the line with no tick, so directly after
`const tripped = this.tripIfBreached(pos.broker);` add `const tradeTripped = this.tripTradeIfBreached(pos.broker);`
(this must come BEFORE the re-buy check below it, which is already blocked by `isBrokerStopped` once the broker is in
`cycleStopped`), and after the existing `if (tripped) {...}` block add
`if (tradeTripped) this.closeBroker(pos.broker).catch((e) => Log.log(\`[BulkPcrStrategy] [${pos.broker}] trade-cap close failed:\`, e));`.

Variations to check: the cap fires while a side is `buying` (`buyAndExit` squares it off when its buy returns, because
`isBrokerStopped` is true), `pending` (`retryPendingRebuys` marks it `done`), one side abandoned (T2), a restart
mid-trade (the trade's realized P&L is restored; the cap re-evaluates on the first tick), the next slot (the auto-start's
`reset()` clears `cycleStopped`, so the broker is armable unless the DAILY stop latched), and both stops crossing on the
same tick (the daily check runs first; `tripTradeIfBreached` returns false once the daily latch is set).

Done when: tsc passes. Commit: `git add src/strategy/BulkPcrStrategy.ts`.

### T5. Rename `maxLoss` -> `maxLossPerDay` (BulkPcr only) and register both keys

1. `src/strategy/BulkPcrStrategy.ts`, `stopFor` (line ~381): replace
   `getMaxLossPct: () => this.cfg().maxLoss,` with `getMaxLossPct: () => this.maxLossPerDayRaw(),` and add:

```ts
    // maxLossPerDay was called maxLoss until 2026-10-22. An old config still carrying maxLoss must not silently lose its
    // stop, so fall back to it (once-only warning) when the new key is absent.
    private maxLossWarned = false;
    private maxLossPerDayRaw(): unknown {
        const cfg = this.cfg();
        if (cfg.maxLossPerDay != null) return cfg.maxLossPerDay;
        if (cfg.maxLoss != null) {
            if (!this.maxLossWarned) {
                this.maxLossWarned = true;
                Log.log(`[BulkPcrStrategy] WARN: config key maxLoss was renamed maxLossPerDay - using maxLoss=${JSON.stringify(cfg.maxLoss)} for now, please rename it in config.yml`);
            }
            return cfg.maxLoss;
        }
        return undefined;
    }
```

2. `src/strategy/PnlStop.ts`: change the three log strings that print `maxLoss=` / the doc comment "when maxLoss is unset" to say
   `maxLossPerDay` (only BulkPcr uses `PnlStop`). Do not change logic or the `MAX LOSS TRIPPED` prefix (the monitor matches it).
3. `src/prism/percentConfig.ts`: add `'maxLossPerDay',` and `'maxLossPerTrade',` to `PERCENT_KEYS` (keep `'maxLoss'`: `LegManager`
   strategies still use it).
4. `src/prism/configValidation.ts`: add both new keys to `PERCENT_POSITIVE_FIELDS` (line ~60, keep `'maxLoss'`), and in the
   BulkPcr maxInvestment check (line ~145) extend the condition to
   `(obj.maxLoss != null || obj.maxLossPerDay != null || obj.maxLossPerTrade != null)` with the message naming the key
   that is set (use `obj.maxLossPerDay != null ? 'maxLossPerDay' : obj.maxLossPerTrade != null ? 'maxLossPerTrade' : 'maxLoss'`).
5. `config.yml`: in the two `BulkPcrStrategy` blocks (`BulkPcr-SENSEX` line ~144, `BulkPcr-NIFTY` line ~159) rename the
   line `maxLoss: 10%` to `maxLossPerDay: 10%` (same value) and add directly below it a commented, disabled example:
   `# maxLossPerTrade: 10%   # per slot (one trade); closes that broker's trade, broker re-arms next slot (unset = off)`.
   Leave `ContinuousStrategy` `maxLoss: 6%` and every other strategy untouched.

Done when: tsc passes and `node -e "require('js-yaml').load(require('fs').readFileSync('config.yml','utf8'))"` runs
without error. Commit: `git add src/strategy/BulkPcrStrategy.ts src/strategy/PnlStop.ts src/prism/percentConfig.ts src/prism/configValidation.ts config.yml`
(if `config.yml` carries unrelated uncommitted edits, commit only the lines you changed with `git add -p`, or tell the
user it is left uncommitted).

### T6. Monitor script (`scripts/monitor-bulkpcr-events.sh`)

The final rule already prints any line containing `ALERT`, `Cycle complete` or `loss stop tripped`, so the new
`ALERT: ... buy abandoned`, `ALERT: ... retrying ONCE` and `ALERT: MAX LOSS PER TRADE TRIPPED` lines appear with no
change; the existing `MAX LOSS TRIPPED` / `loss stop tripped` lines are unchanged. Verify that with the script's `--once` mode after a dry reading of the sed rule. Also add a rule so the
SELL fills of loss-stop/cap closes show: find the sell-fill log line in `eodSquareOff` (grep `Log.log` between
`private async eodSquareOff` and the next method in `BulkPcrStrategy.ts`), then add one sed rule modelled on the
existing `Exit fill:` rule for that exact text, e.g. `... \U\2\E CLOSE FILLED \3 qty=\4 @\5`. If no such line
exists, add a `Log.log` in `eodSquareOff` after the square-off returns, in the form
`[BulkPcrStrategy] [${broker}] Close fill: ${tsym} qty=${qty} @${avg}`, and match that.

Done when: `scripts/monitor-bulkpcr-events.sh --once | tail` still runs. Commit:
`git add scripts/monitor-bulkpcr-events.sh src/strategy/BulkPcrStrategy.ts` (if you added the log line).

### T7. Docs

- `strategies.md` (the BulkPcr section, lines ~214-227 describe `maxLoss`): rename it `maxLossPerDay`, document
  `maxLossPerTrade` (what a trade is, closes the broker's trade, re-arms next slot, does not latch the day), and add the
  margin-rejection behaviour (one reduced attempt, then abandon; capped retries; abandoned hedge not reopened).
- `maxloss.md`: add a dated note that BulkPcr's `maxLoss` is now `maxLossPerDay` and that `maxLossPerTrade` was added.
- This file: change the status line at the top to `Status: implemented <date>, commit <hash>`, and keep sections 1-2.
- Do NOT read `ToDo.md` (large). Do not edit it unless the user asks.

Commit `strategies.md`, `maxloss.md` and `rejected.md`, then `git push`.

## 4. Verification (no tests, per the freeze)

1. `npx tsc --noEmit -p .` must print nothing.
2. Re-read the whole diff once (`git diff HEAD~3 -- src/`) and answer in your final report: (a) can any path still
   re-send a margin-rejected order unchanged? (b) after `abandonBuy`, can `openOppositeSide` fire again? (c) with
   `maxLossPerTrade` unset, is behaviour unchanged, and does an old `maxLoss` key still arm the daily stop (with the WARN)? (d) is the daily stop still evaluated during a
   cycle-cap close? (e) on a restart mid-cycle, are `buyAttempts`, `marginResized`, `abandoned` and the cycle
   realized P&L restored?
3. Live check (only after the user starts `npm run processes` and POSTs `/reconcile`): arm a near-term slot per
   `.claude/skills/monitor-bulkpcr/SKILL.md` and watch `scripts/monitor-bulkpcr-events.sh`. Success looks like at
   most one `ALERT ... retrying ONCE` and one `ALERT ... abandoned` for a margin-rejected side, never repeated
   `buy NOT filled - retrying` lines.
4. Tell the user: what changed, that `maxLoss` is now `maxLossPerDay` (same value, same behaviour) and `maxLossPerTrade` is
   new and ships unset (they pick the value), the value caution from section 2 (the hedge needs room under the cap),
   and that the entry-sizing follow-up (put + hedge both fit) is not done.

## 5. Related

- Daily loss stop design: `maxloss.md`. Monitor skill: `.claude/skills/monitor-bulkpcr/SKILL.md`.
- After any restart: `curl -s -X POST localhost:3000/reconcile` before expecting slots to fire (ticks never reach
  strategies until reconcile has run), and `curl -s localhost:3000/ant/connect` if the ANT stream is not ticking.
