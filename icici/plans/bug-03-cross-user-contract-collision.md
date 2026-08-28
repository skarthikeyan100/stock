# Bug: Cross-user protection loss on shared contracts

## Problem

`exitMonitor`'s `monitored` map (`src/processes/order/exitMonitor.ts:31`) is
keyed by `trade.token` alone, not `(user, token)`. If two different users
hold a position in the same option contract (same token) concurrently, the
second user's `registerTrade()` call silently overwrites the first user's
map entry — the first user's target/SL is no longer tracked at all. There is
no error, no log warning, and no self-healing: `reconcileFromTrades` (run
once at `order`-process startup) walks `bookkeeping.trades` and calls
`registerTrade` for each open trade with a target/SL, so on a restart it
re-clobbers the same token in exactly the same way, permanently losing one
user's protection until someone notices manually.

This is a live risk-management gap: whichever user registered second "wins"
the token, and the other user's option position has no automated exit for
the rest of the day (or until the process restarts, at which point the
`reconcileFromTrades` iteration order decides which user wins this time).

## Root cause (exact files/lines)

File: `src/processes/order/exitMonitor.ts` (130 lines total, as read for
this plan — quoted in full below).

```ts
const monitored = new Map<string, MonitoredTrade>(); // keyed by trade.token
```
— line 31.

```ts
export function registerTrade(trade: Trade, exchange: 'NFO' | 'BFO', broker: Broker, watchOnly = false): void {
    monitored.set(trade.token, { trade, exchange, broker, watchOnly });
    writeJsonLine(process.stdout, { cmd: 'subscribe', token: trade.token });
    Log.log(`[order] exitMonitor watching ${trade.tsym} (token ${trade.token}, ${broker}) for ${trade.user}: target=${trade.targetPrice} stopLoss=${trade.stopLossPrice}${watchOnly ? ' (watch-only, broker owns exit)' : ''}`);
}
```
— lines 54-58. `monitored.set(trade.token, ...)` is the exact overwrite
point: if a `MonitoredTrade` already exists for this token (a different
user's trade), it is unconditionally replaced.

```ts
export function unregisterTrade(token: string): void {
    if (!monitored.has(token)) return;
    monitored.delete(token);
    writeJsonLine(process.stdout, { cmd: 'unsubscribe', token });
}
```
— lines 60-64. Takes only `token` — cannot distinguish which user's entry to
remove (there can only ever be one entry per token today).

```ts
export function reconcileFromTrades(trades: Trade[]): void {
    let reconciled = 0;
    for (const trade of trades) {
        if (!trade.token) continue;
        if (monitored.has(trade.token)) continue;
        ...
        registerTrade(trade, exchange, broker, trade.gttTriggerId != null);
        reconciled++;
    }
    ...
}
```
— lines 71-93. `monitored.has(trade.token)` and the `registerTrade` call
both key off `trade.token` alone, so on restart, iterating two users' open
trades on the same token re-triggers the exact same overwrite bug that
happens live.

```ts
export async function handleOptionTick(quote: OptionQuote): Promise<void> {
    const entry = monitored.get(String(quote.token));
    if (!entry) return;
    const { trade, exchange, broker, watchOnly } = entry;
    ...
```
— lines 95-98. A single `.get(token)` lookup means only ONE user's trade
(whichever is currently in the map for that token) is ever evaluated against
an incoming tick, even if multiple users hold positions in that contract.

### Callers of `registerTrade` / `unregisterTrade` (confirmed via repo-wide grep)

- `src/processes/order/zerodhaExecutor.ts:59,68,74` — all three calls are
  `exitMonitor.registerTrade(trade, exchange, 'zerodha', ...)`, passing the
  full `Trade` object (which has `.user` and `.token` already populated by
  this point in `finalizeEntry`).
- `src/processes/order/antExecutor.ts:109,111` — same shape:
  `exitMonitor.registerTrade(trade, exchange, 'ant', ...)`, `trade.user` and
  `trade.token` already set in `enterPosition`.
- `src/processes/order/bookkeeping.ts:480` —
  `if (buyTrade.token) exitMonitor.unregisterTrade(buyTrade.token);` inside
  `_processTradeEvent`'s Sell-fill branch. A local `const user = buyTrade.user
  || 'Default';` already exists in scope at **line 437**, a few lines above
  the `if (index != -1) { const buyTrade = ...` block that contains line 480
  — so `user` is available to pass through without any new lookup.
- `src/processes/order/exitMonitor.ts:117` (internal) —
  `unregisterTrade(trade.token);` inside `handleOptionTick`, right before
  the exit handler is invoked. `trade.user` is already destructured and in
  scope at this point (line 98: `const { trade, exchange, broker, watchOnly
  } = entry;`).

No other files call `registerTrade`/`unregisterTrade`/`reconcileFromTrades`
(confirmed via `grep -rn "registerTrade\|unregisterTrade\|reconcileFromTrades" src`
— the only other hits are `src/processes/strategies/tokenRouter.ts`'s
*unrelated, same-named* `registerTrade`/`unregisterTrade` functions, which
belong to a completely different module (strategy token routing, not exit
monitoring) and must NOT be touched by this plan).

### Related but separate concern surfaced during investigation: token-level subscribe/unsubscribe

`registerTrade`/`unregisterTrade` also send `{cmd: 'subscribe'/'unsubscribe',
token}` IPC messages up to the `data` process (relayed by
`src/orchestrator.ts`), which are consumed by
`src/processes/data/AntDataStream.ts`:

```ts
async subscribeOption(token: string): Promise<void> {
    if (this.dynamicOptionTokens.has(token)) return;
    this.dynamicOptionTokens.add(token);
    this.ws?.subscribe([`NFO|${token}`]);
}

async unsubscribeOption(token: string): Promise<void> {
    if (!this.dynamicOptionTokens.has(token)) return;
    this.dynamicOptionTokens.delete(token);
    this.ws?.unsubscribe([`NFO|${token}`]);
}
```
(`src/processes/data/AntDataStream.ts:154-164` — a plain, non-ref-counted
`Set<string>`.)

If the key-structure fix below is applied in isolation (i.e. `monitored`
becomes composite-keyed but `unregisterTrade` still always fires an
`unsubscribe` IPC message whenever *any* entry is removed), a new variant of
the same bug appears: User A's trade closing normally would send
`unsubscribe` for the shared token, which would silently kill the live tick
feed for User B's still-open trade on that same token — User B's
`monitored` entry would still exist, but would never receive another tick,
so its target/SL would never fire either. This is the same class of bug
("shared contract, one user's action silently kills the other's
protection"), just relocated from the `monitored` map to the token
subscription. **The fix below therefore also makes `registerTrade`/
`unregisterTrade` reference-count the subscribe/unsubscribe IPC calls per
token** (by checking "does any other entry still watch this token" before
sending `subscribe`/`unsubscribe`), entirely within `exitMonitor.ts` — no
change to `AntDataStream.ts` or `dataProcess.ts` is needed or should be
made.

## Fix design (approach + rationale)

**Chosen approach: single `Map<string, MonitoredTrade>` keyed by a composite
string `` `${user}:${token}` `` (via a small `monitorKey(user, token)`
helper), instead of nesting (`Map<string, Map<string, MonitoredTrade>>`).**

Rationale:
- Every existing call site already has both `trade.user` and `trade.token`
  available (see callers list above) — `registerTrade` already takes the
  full `Trade` object, so no call site needs a new parameter to build the
  key.
- `unregisterTrade` currently takes only `token`; it must be changed to take
  `(user, token)` regardless of whether we choose composite-string-key or
  nested-map — so this isn't an argument in favor of nesting.
- A composite string key keeps every existing `.get(key)` / `.has(key)` /
  `.delete(key)` call pattern in `registerTrade`, `unregisterTrade`, and
  `reconcileFromTrades` a **single-line change** (swap the key expression),
  versus a nested map requiring `.get(token)?.get(user)`,
  `.get(token)?.set(user, ...)` with manual outer-map creation/cleanup
  (create the inner map on first insert, delete the outer entry when the
  inner map becomes empty) at every call site. The nested approach is more
  "structurally correct" in the abstract but strictly more code and more
  failure modes (forgetting to clean up an empty inner map leaks memory
  forever) for no behavioral benefit here.
- The one place that previously did a single `monitored.get(token)` —
  `handleOptionTick` — already has to change shape either way, because a tick
  arrives keyed by token only and must now potentially match *multiple*
  entries. Under the composite-string-key design this becomes "iterate all
  values, filter by `entry.trade.token === tokenStr`" (see below) — one
  `for` loop, no nested-map traversal.

**Every read/write path is updated:**

1. `monitored` — same `Map<string, MonitoredTrade>` type, just re-keyed.
2. `monitorKey(user, token)` — new helper, `` `${user || 'Default'}:${token}` ``
   (the `|| 'Default'` mirrors `Trade.user`'s own default value so a trade
   with an unset `.user` still gets a stable, non-`undefined` key segment).
3. `isTokenWatched(token)` — new helper, scans `monitored.values()` for any
   entry whose `trade.token` matches; used to decide whether a
   subscribe/unsubscribe IPC call is actually needed (see "Related but
   separate concern" above).
4. `registerTrade(trade, exchange, broker, watchOnly)` — **signature
   unchanged** (still takes the full `Trade`, from which `.user` and
   `.token` are read to build the key). Only sends `subscribe` if
   `isTokenWatched(trade.token)` was `false` *before* this entry was added.
5. `unregisterTrade(user, token)` — **signature changes** from
   `unregisterTrade(token)` to `unregisterTrade(user, token)`. Both call
   sites (`bookkeeping.ts:480`, `exitMonitor.ts`'s own `handleOptionTick`)
   already have `user` in scope (see callers list above), so this is a
   mechanical update, not a new lookup. Only sends `unsubscribe` if
   `isTokenWatched(token)` is `false` *after* this entry is removed.
6. `reconcileFromTrades(trades)` — the `monitored.has(trade.token)` guard
   becomes `monitored.has(monitorKey(trade.user, trade.token))`; the
   `registerTrade(...)` call itself is unchanged (still takes the full
   `Trade`).
7. `handleOptionTick(quote)` — replaces the single `monitored.get(...)`
   lookup with "collect every entry whose `trade.token` matches this tick's
   token into an array, then process each independently" (target/SL check,
   unregister-before-exit, exit-handler dispatch — all per matched entry,
   not once for the whole tick). The existing throttled
   `priceUpdateListeners` notification still fires **at most once per tick**
   (not once per matched entry) — a `notifiedListeners` local flag preserves
   that.

**Compatibility with `bug-04-exit-monitoring-disabled-on-failure.md`:**
That plan is written to call `registerTrade(trade, exchange, broker,
watchOnly)` in its `catch` block, using `trade`/`exchange`/`broker`/
`watchOnly` destructured from the matched entry — it explicitly does not
assume anything about the map's key shape and works unmodified against the
per-entry loop below (the destructure just moves from directly under
`const entry = monitored.get(...)` to inside the `for (const entry of
matches)` loop, which is exactly the "loop over multiple entries" case that
plan already anticipates). No coordination beyond ordering (this plan lands
first) is required.

## Exact code changes

### File: `src/processes/order/exitMonitor.ts` — full file replacement

Replace the **entire contents** of this file with:

```ts
import Log from '../../util/Log';
import { writeJsonLine } from '../../ipc/jsonLines';
import { OptionQuote, Trade } from '../../model/model';

// In-app target/SL exit monitoring, for trades placed with useGTT=false (see
// bookkeeping.getUserUseGTT / zerodhaExecutor.finalizeEntry, antExecutor.finalizeEntry).
// Mirrors strategies' tokenRouter.ts+DataClient.ts pattern one level up:
// subscribe/unsubscribe commands go out on `order`'s own stdout, which the
// orchestrator relays into `data`'s stdin, and ticks come back in on `order`'s
// stdin (see orderProcess.ts). The actual squareoff call is injected per-broker
// via onExit() rather than imported directly, to avoid a circular dependency
// with zerodhaExecutor.ts/antExecutor.ts.

export type Broker = 'zerodha' | 'ant';

interface MonitoredTrade {
    trade: Trade;
    exchange: 'NFO' | 'BFO';
    broker: Broker;
    // True for trades whose actual exit is owned by a broker-side bracket
    // (Zerodha GTT / ANT bracket order, useGTT=true) - handleOptionTick still
    // refreshes trade.lastTradePrice for these (so the frontend's live P&L
    // keeps moving) but must never itself trigger a square-off, since the
    // broker already will.
    watchOnly: boolean;
}

type ExitHandler = (trade: Trade, exchange: 'NFO' | 'BFO') => Promise<void>;
type PriceUpdateListener = () => void;

// Composite key so two users holding a position in the *same* option
// contract (same token) are tracked independently - see bugs.md
// "Cross-user protection loss on shared contracts". Previously this map was
// keyed by trade.token alone, so a second user's registerTrade() for a
// token already held by a different user silently overwrote the first
// user's entry, permanently dropping that first user's target/SL
// monitoring with no error and no self-healing (even reconcileFromTrades on
// restart re-clobbered the same token).
const monitored = new Map<string, MonitoredTrade>(); // keyed by monitorKey(user, token)

function monitorKey(user: string, token: string): string {
    return `${user || 'Default'}:${token}`;
}

// True if any entry in `monitored` (for any user) is currently watching this
// token. Used to decide whether a subscribe/unsubscribe IPC command actually
// needs to go out: with the composite key above, two users can both hold
// entries for the same token, and the token-level websocket subscription
// (owned by `data`'s AntDataStream, a plain non-ref-counted Set - see
// dataProcess.ts / AntDataStream.ts) must only be dropped once the *last*
// watcher for that token is gone. Otherwise unregistering one user's trade
// would silently kill live ticks (and therefore target/SL monitoring) for
// another user's still-open trade on the same token.
function isTokenWatched(token: string): boolean {
    for (const entry of monitored.values()) {
        if (entry.trade.token === token) return true;
    }
    return false;
}

const exitHandlers = new Map<Broker, ExitHandler>();
// Same "register a callback instead of importing directly" pattern as onExit
// above, for the same reason: bookkeeping.ts already imports this module, so
// this module can't import bookkeeping.ts back without a circular dependency.
// orderProcess.ts (which imports both) wires this to
// bookkeeping.triggerPositionsChanged() so /positionstream actually pushes a
// fresh snapshot when a monitored trade's live price moves - previously
// nothing did this between trade events (fill/close/target-SL edit), so a
// position's displayed LTP/P&L only ever changed when a *different* trade
// action happened to also refresh the stream, not on the price tick itself.
const priceUpdateListeners: PriceUpdateListener[] = [];
let lastPriceNotifyAt = 0;
const PRICE_NOTIFY_THROTTLE_MS = 500; // caps SSE broadcast rate regardless of tick frequency

export function onExit(broker: Broker, handler: ExitHandler): void {
    exitHandlers.set(broker, handler);
}

export function onPriceUpdate(listener: PriceUpdateListener): void {
    priceUpdateListeners.push(listener);
}

export function registerTrade(trade: Trade, exchange: 'NFO' | 'BFO', broker: Broker, watchOnly = false): void {
    const key = monitorKey(trade.user, trade.token);
    // Check BEFORE inserting this entry - if some other entry (e.g. another
    // user's trade) already watches this token, the underlying token
    // subscription is already live and must not be requested again.
    const alreadySubscribed = isTokenWatched(trade.token);
    monitored.set(key, { trade, exchange, broker, watchOnly });
    if (!alreadySubscribed) {
        writeJsonLine(process.stdout, { cmd: 'subscribe', token: trade.token });
    }
    Log.log(`[order] exitMonitor watching ${trade.tsym} (token ${trade.token}, ${broker}) for ${trade.user}: target=${trade.targetPrice} stopLoss=${trade.stopLossPrice}${watchOnly ? ' (watch-only, broker owns exit)' : ''}`);
}

export function unregisterTrade(user: string, token: string): void {
    const key = monitorKey(user, token);
    if (!monitored.has(key)) return;
    monitored.delete(key);
    // Only unsubscribe at the token level once nobody else is still
    // watching it (see isTokenWatched above) - otherwise this would
    // silently cut off live ticks for another user still holding a
    // position in the same contract.
    if (!isTokenWatched(token)) {
        writeJsonLine(process.stdout, { cmd: 'unsubscribe', token });
    }
}

// Called once at order-process startup: exitMonitor's in-memory `monitored`
// map doesn't survive a restart, but bookkeeping.trades is the live source
// of truth for open positions. Any open trade with a target/SL set that
// isn't already being watched gets re-registered here, closing the
// "restart silently drops SL/target monitoring for useGTT=false users" gap.
export function reconcileFromTrades(trades: Trade[]): void {
    let reconciled = 0;
    for (const trade of trades) {
        if (!trade.token) continue;
        if (monitored.has(monitorKey(trade.user, trade.token))) continue;
        if (trade.targetPrice == null && trade.stopLossPrice == null) continue;
        // Exchange/broker aren't stored on Trade - infer exchange the same
        // way setTargetStopLoss does (tsym prefix), and broker from
        // whichever executor's Trade shape this is (antOrderNo present -> ant,
        // otherwise zerodha - matches this file's existing Broker union).
        const exchange: 'NFO' | 'BFO' = trade.tsym?.startsWith('BSE') ? 'BFO' : 'NFO';
        const broker: Broker = trade.antOrderNo ? 'ant' : 'zerodha';
        // A GTT/bracket trade (gttTriggerId set) already has its exit owned by
        // the broker - reconcile it watch-only (mark-to-market only) so a
        // restart doesn't also arm an in-app square-off that would race the
        // broker's own bracket.
        registerTrade(trade, exchange, broker, trade.gttTriggerId != null);
        reconciled++;
    }
    if (reconciled > 0) {
        Log.log(`[order] exitMonitor: reconciled ${reconciled} open trade(s) with target/SL back onto the watch list after restart`);
    }
}

export async function handleOptionTick(quote: OptionQuote): Promise<void> {
    const tokenStr = String(quote.token);
    // A token can now have more than one monitored entry (one per user
    // holding a position in that contract - see monitorKey above), so
    // collect every matching entry first rather than a single
    // monitored.get(token) lookup. Snapshotting into an array up front also
    // means later mutations of `monitored` (e.g. the unregisterTrade call
    // below, for an earlier match in this same loop) can't disturb
    // iteration of the remaining matches.
    const matches: MonitoredTrade[] = [];
    for (const entry of monitored.values()) {
        if (entry.trade.token === tokenStr) matches.push(entry);
    }
    if (matches.length === 0) return;

    const now = Date.now();
    let notifiedListeners = false;

    for (const entry of matches) {
        const { trade, exchange, broker, watchOnly } = entry;
        trade.lastTradePrice = quote.ltp;

        if (!notifiedListeners && now - lastPriceNotifyAt >= PRICE_NOTIFY_THROTTLE_MS) {
            lastPriceNotifyAt = now;
            for (const listener of priceUpdateListeners) listener();
            notifiedListeners = true;
        }

        // Watch-only: keep lastTradePrice fresh for the frontend's live P&L, but
        // the broker's own GTT/bracket owns the actual exit - never square off here.
        if (watchOnly) continue;

        const hitTarget = trade.targetPrice != null && quote.ltp >= trade.targetPrice;
        const hitStopLoss = trade.stopLossPrice != null && quote.ltp <= trade.stopLossPrice;
        if (!hitTarget && !hitStopLoss) continue;

        // Unregister before awaiting the exit so a second tick arriving while the
        // squareoff is in flight can't trigger it twice.
        unregisterTrade(trade.user, trade.token);
        Log.log(`[order] exitMonitor triggering squareoff for ${trade.tsym} (${trade.user}, ${broker}): ltp=${quote.ltp} hit=${hitTarget ? 'target' : 'stopLoss'}`);

        const exitHandler = exitHandlers.get(broker);
        if (!exitHandler) {
            Log.log(`[order] exitMonitor has no exit handler registered for broker '${broker}' - cannot square off`, trade.tsym);
            continue;
        }
        try {
            await exitHandler(trade, exchange);
        } catch (e) {
            Log.log('[order] exitMonitor squareoff failed:', trade.tsym, e);
        }
    }
}
```

### File: `src/processes/order/bookkeeping.ts` — single-line change

Locate line 480 (confirmed via `grep -n "exitMonitor.unregisterTrade" src/processes/order/bookkeeping.ts`). It is inside `_processTradeEvent`'s Sell-fill branch, a few lines below the `const user = buyTrade.user || 'Default';` declaration at line 437 (same `if (index != -1) { ... }` block — `user` is already in scope at line 480).

**Before:**
```ts
                buyTrade.quantity -= sellQty;
                if (buyTrade.quantity <= 0) {
                    this.trades.splice(index, 1);
                    if (buyTrade.token) exitMonitor.unregisterTrade(buyTrade.token);
                }
```

**After:**
```ts
                buyTrade.quantity -= sellQty;
                if (buyTrade.quantity <= 0) {
                    this.trades.splice(index, 1);
                    if (buyTrade.token) exitMonitor.unregisterTrade(user, buyTrade.token);
                }
```

(Only the last line inside the `if (buyTrade.quantity <= 0) { ... }` block
changes — `exitMonitor.unregisterTrade(buyTrade.token)` becomes
`exitMonitor.unregisterTrade(user, buyTrade.token)`. Nothing else in this
file changes.)

## New test file: `src/test/exitMonitorCrossUser.test.ts`

This file does not exist yet — create it with exactly this content:

```ts
/**
 * Verifies exitMonitor tracks multiple users' trades on the SAME option
 * token independently - see bugs.md "Cross-user protection loss on shared
 * contracts". Before the fix, `monitored` was keyed by token alone, so a
 * second user's registerTrade() for a token already held by another user
 * silently overwrote the first user's entry (no error, no self-healing).
 * Run: npm run build (compile), then: node ./dist/test/exitMonitorCrossUser.test.js
 */

import { OptionQuote, Trade } from '../model/model';
import * as exitMonitor from '../processes/order/exitMonitor';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function makeTrade(user: string, token: string, targetPrice: number, stopLossPrice: number): Trade {
    const t = new Trade();
    t.tsym = `TEST${token}`;
    t.token = token;
    t.quantity = 65;
    t.price = 100;
    t.lastTradePrice = 100;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = user;
    t.targetPrice = targetPrice;
    t.stopLossPrice = stopLossPrice;
    return t;
}

function tick(token: string, ltp: number): OptionQuote {
    const q = new OptionQuote();
    q.token = token;
    q.ltp = ltp;
    return q;
}

async function main() {
    const zerodhaExits: Trade[] = [];
    const antExits: Trade[] = [];
    exitMonitor.onExit('zerodha', async (trade) => { zerodhaExits.push(trade); });
    exitMonitor.onExit('ant', async (trade) => { antExits.push(trade); });

    // --- Scenario 1: two users, same token, different brokers - both must
    // fire independently, and one firing must not affect the other. ---
    const TOKEN_1 = 'SHARED_TOK_1';
    const userA = makeTrade('UserA', TOKEN_1, /*target*/ 150, /*sl*/ 90);
    const userB = makeTrade('UserB', TOKEN_1, /*target*/ 200, /*sl*/ 80);
    exitMonitor.registerTrade(userA, 'NFO', 'zerodha');
    exitMonitor.registerTrade(userB, 'NFO', 'ant');

    // Tick hits UserA's target (150) but is nowhere near UserB's target/SL (200/80).
    await exitMonitor.handleOptionTick(tick(TOKEN_1, 155));
    assert(zerodhaExits.length === 1, 'UserA (zerodha) fires when its target is hit');
    assert(zerodhaExits[0]?.user === 'UserA', 'the fired zerodha trade belongs to UserA');
    assert(antExits.length === 0, 'UserB (ant) does not fire on a tick that only hits UserA target');

    // A further tick in the same range must not re-fire UserA (already
    // unregistered on exit) and must not have collaterally dropped UserB's
    // monitoring for the shared token.
    await exitMonitor.handleOptionTick(tick(TOKEN_1, 156));
    assert(zerodhaExits.length === 1, 'UserA does not fire a second time after its own exit');
    assert(antExits.length === 0, 'UserB is still unaffected by the repeat tick');

    // Now hit UserB's target (200) - UserB must still be monitored and fire,
    // proving UserA's earlier registration/unregistration on the same token
    // never touched UserB's entry.
    await exitMonitor.handleOptionTick(tick(TOKEN_1, 210));
    assert(antExits.length === 1, 'UserB (ant) fires when its own target is hit, after UserA already exited');
    assert(antExits[0]?.user === 'UserB', 'the fired ant trade belongs to UserB');
    assert(zerodhaExits.length === 1, 'UserA still shows exactly one exit (unaffected by UserB firing)');

    // --- Scenario 2: explicit unregisterTrade for one user must not affect
    // another user's still-open monitoring on the same token. ---
    const TOKEN_2 = 'SHARED_TOK_2';
    const userC = makeTrade('UserC', TOKEN_2, /*target*/ 150, /*sl*/ 90);
    const userD = makeTrade('UserD', TOKEN_2, /*target*/ 200, /*sl*/ 80);
    exitMonitor.registerTrade(userC, 'NFO', 'zerodha');
    exitMonitor.registerTrade(userD, 'NFO', 'zerodha');

    exitMonitor.unregisterTrade('UserC', TOKEN_2);

    // A tick that would have hit UserC's target must not fire (UserC was
    // explicitly unregistered).
    const zerodhaCountBeforeC = zerodhaExits.length;
    await exitMonitor.handleOptionTick(tick(TOKEN_2, 155));
    assert(zerodhaExits.length === zerodhaCountBeforeC, 'unregistered UserC does not fire even though the tick is within its old target range');

    // UserD must still be monitored and fire on its own target, proving
    // unregistering UserC did not collaterally drop UserD from the shared token.
    await exitMonitor.handleOptionTick(tick(TOKEN_2, 210));
    assert(zerodhaExits.length === zerodhaCountBeforeC + 1, 'UserD still fires on its own target after UserC was unregistered');
    assert(zerodhaExits[zerodhaExits.length - 1]?.user === 'UserD', 'the newly fired trade belongs to UserD, not UserC');

    // --- Scenario 3: reconcileFromTrades (restart path) must also register
    // both users independently instead of the second clobbering the first. ---
    const TOKEN_3 = 'SHARED_TOK_3';
    const userE = makeTrade('UserE', TOKEN_3, /*target*/ 150, /*sl*/ 90);
    const userF = makeTrade('UserF', TOKEN_3, /*target*/ 200, /*sl*/ 80);
    exitMonitor.reconcileFromTrades([userE, userF]);

    await exitMonitor.handleOptionTick(tick(TOKEN_3, 155));
    assert(zerodhaExits[zerodhaExits.length - 1]?.user === 'UserE', 'reconcileFromTrades: UserE fires on its own target');

    await exitMonitor.handleOptionTick(tick(TOKEN_3, 210));
    assert(zerodhaExits[zerodhaExits.length - 1]?.user === 'UserF', 'reconcileFromTrades: UserF still fires on its own target after UserE exited, not clobbered by UserE registration');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

## Verification steps for orchestrator (exact shell commands to run, and exact expected output/PASS lines)

Run these in order, from the repo root:

```bash
cd /home/karthikeyan/work/icici
npx tsc --noEmit
```
Expected: command exits with status 0 and prints **nothing** (no
`error TS...` lines). This repo's baseline (before this change) already
compiles clean with zero errors, so any error here is a regression
introduced by this change and must be fixed before proceeding.

```bash
cd /home/karthikeyan/work/icici
npx tsc
```
Expected: exits with status 0, no output (this both type-checks and emits
`dist/`, including the new `dist/test/exitMonitorCrossUser.test.js`).

```bash
cd /home/karthikeyan/work/icici
node ./dist/test/exitMonitorCrossUser.test.js
echo "EXIT CODE: $?"
```
Expected stdout, in exactly this order:
```
  PASS: UserA (zerodha) fires when its target is hit
  PASS: the fired zerodha trade belongs to UserA
  PASS: UserB (ant) does not fire on a tick that only hits UserA target
  PASS: UserA does not fire a second time after its own exit
  PASS: UserB is still unaffected by the repeat tick
  PASS: UserB (ant) fires when its own target is hit, after UserA already exited
  PASS: the fired ant trade belongs to UserB
  PASS: UserA still shows exactly one exit (unaffected by UserB firing)
  PASS: unregistered UserC does not fire even though the tick is within its old target range
  PASS: UserD still fires on its own target after UserC was unregistered
  PASS: the newly fired trade belongs to UserD, not UserC
  PASS: reconcileFromTrades: UserE fires on its own target
  PASS: reconcileFromTrades: UserF still fires on its own target after UserE exited, not clobbered by UserE registration
ALL TESTS PASSED
EXIT CODE: 0
```
(Interleaved `[order] exitMonitor watching ...` / `[order] exitMonitor
triggering squareoff ...` lines from `Log.log` calls inside
`exitMonitor.ts` will also print to stdout/stderr around these `PASS`
lines — that is expected and not a failure signal by itself. The only
required checks are: every line above appears with `PASS:` (never `FAIL:`),
`ALL TESTS PASSED` is the final summary line, and `EXIT CODE: 0`.)

If any line reads `FAIL:` instead of `PASS:`, or the summary line reads
`SOME TESTS FAILED`, or `EXIT CODE` is not `0`, the fix is incomplete — stop
and re-examine the corresponding code change above rather than editing the
test to make it pass.

## Files touched

- `src/processes/order/exitMonitor.ts` — full-file replacement (see above).
- `src/processes/order/bookkeeping.ts` — single-line change at line 480
  (`exitMonitor.unregisterTrade(buyTrade.token)` →
  `exitMonitor.unregisterTrade(user, buyTrade.token)`).
- `src/test/exitMonitorCrossUser.test.ts` — new file (full content above).

No other files are touched. `src/processes/order/zerodhaExecutor.ts` and
`src/processes/order/antExecutor.ts` call `registerTrade` with an unchanged
signature and need no edits. `src/processes/data/AntDataStream.ts` and
`src/processes/dataProcess.ts` need no edits (the subscribe/unsubscribe
reference-counting fix is entirely internal to `exitMonitor.ts`, via the new
`isTokenWatched` helper).
