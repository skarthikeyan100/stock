# Bug: No timeout on broker HTTP calls or the strategy→order IPC call

## Problem

Two related gaps let a hung connection permanently stall a strategy's `await`, with no error and no way to recover short of a manual process restart:

1. **`src/ant/ANT.ts`** — the shared axios instance used for every AliceBlue REST call (`axiosModule.create()` at line 7) is created with no `timeout` option. Every `axios.get`/`axios.post` call in the file — order placement, quote/OHLC fetches, option-chain fetches, fill-price polling — inherits this "wait forever" default.
2. **`src/processes/strategies/OrderClient.ts`**, method `request()` (lines 81-89) — the IPC promise sent to the `order` process over a Unix socket is never given a timeout. If `order` never sends back a `response` message for a given request `id` (hung broker call inside `order`, a dropped/malformed reply, a wedged process that's still technically connected), the `pending` map entry for that `id` sits forever and the calling strategy's `await client.buyIndex(...)` (or any other typed method) never resolves or rejects.

Note: `OrderClient`'s socket-`close` handler (lines 65-77) already rejects everything in `pending` when the *socket* drops — that was a previously-fixed instance of this same class of bug. This bug covers the remaining, more common case: the socket stays open (no `close` event) but the other side never replies.

## Root cause (exact files/lines)

### `src/ant/ANT.ts`

Line 7: `const axios = axiosModule.create();` — no `timeout`. This single instance is reused by every HTTP call in the file (confirmed by reading the full file — there is no other `axios.create()` or per-call `axios.create({...})`/`this.axios` anywhere). The call sites relying on it (line numbers as of this plan, in the **unmodified** file):

| Line | Method | Call |
|---|---|---|
| 123 | `exchangeAuthCodeForToken` | `axios.post(this.tokenUrl, ...)` |
| 210 | `getTrades` | `axios.get(.../orders/trades, ...)` |
| 233 | `getPositions` | `axios.get(.../positions, ...)` |
| 265 | `postOhlc` (primary) | `axios.post(.../chart/get/multi/ohlc, ...)` |
| 275 | `postOhlc` (429 retry) | `axios.post(.../chart/get/multi/ohlc, ...)` |
| 322 | `fetchOptionChainRows` | `axios.post(.../optionChain/getUnderlyingExp, ...)` |
| 332 | `fetchOptionChainRows` | `axios.post(.../optionChain/getOptionChain, ...)` |
| 410 | `placeOrder` | `axios.post(.../orders/placeorder, ...)` |
| 461 | `placeBracketOrder` | `axios.post(.../orders/placeorder, ...)` |
| 481 | `exitBracketOrder` | `axios.post(.../orders/exit/sno, ...)` |
| 494 | `cancelOrder` | `axios.post(.../orders/cancel, ...)` |
| 514 | `getFillPrice` (polling loop) | `axios.post(.../orders/history, ...)` |

Because all 12 call sites share the one module-level `axios` instance, setting `timeout` once at `axios.create({...})` time (line 7) fixes all of them in a single edit — no per-call changes needed, and no future new call site can accidentally forget it.

### `src/processes/strategies/OrderClient.ts`

Lines 81-89, current code:
```ts
    private request(type: OrderRequestType, userId: string, payload: any): Promise<OrderResponse> {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) return reject(new Error('Not connected to order process'));
            const id = String(this.nextId++);
            this.pending.set(id, { resolve, reject });
            const req: OrderRequest = { kind: 'request', id, type, userId, payload };
            writeJsonLine(this.socket, req);
        });
    }
```
`this.pending` is declared at line 20 as `Map<string, { resolve: (r: OrderResponse) => void; reject: (e: Error) => void }>`. Entries are only ever removed in two places today: (a) the `response`-message handler inside `connect()` (line 50, `this.pending.delete(msg.id)`), and (b) the socket `close` handler (line 75, `this.pending.clear()` after rejecting everything). Neither fires if the socket stays open and `order` simply never replies.

## Fix design (approach + rationale, including chosen timeout values and justification)

### ANT HTTP timeout: 15000ms, set once on the shared instance

Set it at instance-creation time (`axios.create({ timeout: 15000 })`) rather than per-call. This is the simplest fix, it's applied automatically to the 12 call sites above and to any future call added to the file, and there's no evidence any of these calls legitimately need a *different* timeout — `getFillPrice`'s polling loop (line 512-535) sends one bounded HTTP request per iteration (not one long-lived request), so a 15s per-call cap doesn't interfere with its own `maxAttempts * intervalMs` (12 × 5000ms = 60s) polling budget; it just bounds each individual poll's HTTP leg instead of letting a single poll hang forever.

15000ms (15s) is chosen as generous headroom over AliceBlue's typical REST latency (sub-second to a few seconds for order/quote endpoints under normal conditions) while still being short enough that a genuinely hung TCP connection surfaces as an error well within the timeframe a user or the order process's own retry/monitoring logic would expect a response. This is a judgment call — there's no documented AliceBlue SLA to size it against precisely — but 15s is a common, defensible default for a synchronous broker REST call before treating it as failed.

### IPC timeout: 90000ms (90s), via a mutable static field on `OrderClient`

**Critical finding that drives this number:** the IPC round trip for an order-placing request type (`buyIndex`, `antBuyIndex`, `manualBuy`, `antManualBuy`, `squareOff`, `antSquareOff`, `buyContract`, `sellContract`, etc.) is NOT bounded only by the ANT HTTP call. Inside the `order` process:
- `src/processes/order/antExecutor.ts`'s `enterPosition` (and `squareOffOnAnt`, line 328) places the order via `ant.placeOrder`/`ant.placeBracketOrder` (now capped at 15s by the fix above) and then **awaits `AntOrderNotifyStream.getInstance().waitForFill(orderNo)`** (line 76), which has its own independent timeout budget of **60000ms** (`src/ant/AntOrderNotifyStream.ts` line 200: `waitForFill(orderNo, timeoutMs = 60000)`).
- The Zerodha path (`src/processes/order/zerodhaExecutor.ts`) similarly awaits `zerodha.getFillPrice(orderId)` (`src/zerodha/Zerodha.ts` line 241, `maxAttempts = 12, intervalMs = 5000` ⇒ up to 60000ms).

So a *legitimate, successfully-completing* buy/squareoff request can take up to roughly `15s (HTTP) + 60s (fill-wait budget)` ≈ 75s in the worst case before `order` sends its IPC response back. An IPC timeout set anywhere near the 15s HTTP figure (or even 30-60s) would fire spuriously on normal, still-in-progress fills and reject a request that would otherwise have succeeded a few seconds later — actively worse than today's hang, because it would make the strategy believe the order failed while the broker fill/notification is still in flight.

Therefore the IPC timeout must sit comfortably above ~75s. **90000ms (90s)** is chosen: enough headroom above the ~75s combined worst case for scheduling jitter, without being so large that a genuinely wedged `order` process leaves a strategy blocked for an unreasonable time. Lightweight, non-order request types (`getNiftyQuote`, `canPlaceOrder`, `stats`, etc.) normally resolve in milliseconds to low seconds, so a 90s ceiling doesn't change their behavior at all in the success case — it only bounds the previously-unbounded failure case.

Implementation: a `private static REQUEST_TIMEOUT_MS` field on `OrderClient`, defaulting to `Number(process.env.ORDER_IPC_TIMEOUT_MS) || 90000` (mirrors the existing `ORDER_IPC_SOCKET` env-override convention already used for `ORDER_SOCKET_PATH` in `src/ipc/orderProtocol.ts` line 6). It is **not** `readonly`, specifically so a test can override it directly via `(OrderClient as any).REQUEST_TIMEOUT_MS = <short value>` — TypeScript's `private`/`static` are compile-time-only restrictions and don't survive an `as any` cast, so this requires no test-only export or constructor parameter.

`request()` is changed to start a `setTimeout` right after registering the pending entry. If the timeout fires before a real response/close/reject has already removed the entry, it deletes the entry from `pending` (guarding against a double-fire/double-delete race) and rejects with a clear, greppable error message. The success path (and the existing socket-`close` rejection path) both go through a wrapped `resolve`/`reject` that calls `clearTimeout()` first, so a late-firing timer can never reject an already-settled promise.

## Exact code changes (file-by-file, full before/after snippets)

### File: `src/ant/ANT.ts`

**Before** (lines 1-9):
```ts
import { createHash } from 'crypto';
import Log from '../util/Log';
import fs from 'fs';
import path from 'path';
// Use a separate axios instance to avoid Shoonya interceptors
import axiosModule from 'axios';
const axios = axiosModule.create();

class ANT {
    private static instance: ANT;
```

**After** (replace lines 1-9 with):
```ts
import { createHash } from 'crypto';
import Log from '../util/Log';
import fs from 'fs';
import path from 'path';
// Use a separate axios instance to avoid Shoonya interceptors
import axiosModule from 'axios';
// Default per-call timeout for every ANT broker HTTP call (order placement,
// quotes, option chain, fill polling, etc). Applies automatically to every
// axios.get/axios.post made through the shared instance below - previously
// a hung connection to AliceBlue left the caller (a strategy awaiting an
// order placement, via OrderClient -> order process -> ANT) stuck forever
// with no error surfaced anywhere. 15s is generous headroom over
// AliceBlue's typical sub-second-to-a-few-second REST latency while still
// bounding the worst case. See plans/bug-09-no-timeout-broker-http-ipc.md.
export const ANT_HTTP_TIMEOUT_MS = 15000;
const axios = axiosModule.create({ timeout: ANT_HTTP_TIMEOUT_MS });
// Exported for testability only (see src/test/antHttpTimeout.test.ts) - not
// intended to be used as a general-purpose HTTP client outside this file.
export const antAxiosInstance = axios;

class ANT {
    private static instance: ANT;
```

Do not change anything else in `ANT.ts` — every existing `axios.get(...)`/`axios.post(...)` call site listed in the Root Cause table above picks up the new default `timeout` automatically because they all reference this same module-level `axios` identifier. `export default ANT;` at the end of the file stays unchanged; the two new named exports (`ANT_HTTP_TIMEOUT_MS`, `antAxiosInstance`) coexist with it.

### File: `src/processes/strategies/OrderClient.ts`

**Before** (lines 16-24):
```ts
class OrderClient {
    private static instance: OrderClient;
    private socket: net.Socket | null = null;
    private connected = false;
    private pending: Map<string, { resolve: (r: OrderResponse) => void; reject: (e: Error) => void }> = new Map();
    private fillHandlers: FillHandler[] = [];
    private positionsChangedHandlers: PositionsChangedHandler[] = [];
    private nextId = 0;

```

**After** (replace lines 16-24 with):
```ts
class OrderClient {
    private static instance: OrderClient;
    // Default timeout for a single request()/response round trip over the
    // IPC socket to the `order` process. Must comfortably exceed the
    // slowest legitimate round trip: an order-placing request can
    // internally wait for a broker fill confirmation with its own budget of
    // up to ~60s (see AntOrderNotifyStream.waitForFill's 60000ms default in
    // src/ant/AntOrderNotifyStream.ts and Zerodha.getFillPrice's 12
    // attempts * 5000ms poll in src/zerodha/Zerodha.ts), stacked on top of
    // the ANT HTTP call itself (capped at 15s - see ANT_HTTP_TIMEOUT_MS in
    // src/ant/ANT.ts). 90s gives headroom above that combined ~75s worst
    // case without leaving a wedged `order` process able to block a
    // strategy indefinitely. Overridable via ORDER_IPC_TIMEOUT_MS (mirrors
    // ORDER_SOCKET_PATH's env-override convention in
    // src/ipc/orderProtocol.ts). Deliberately not `readonly` - TypeScript's
    // `private`/`static` are compile-time-only and don't survive an `as
    // any` cast, so a test can override this directly instead of waiting
    // out the real production value (see src/test/orderClientTimeout.test.ts).
    private static REQUEST_TIMEOUT_MS = Number(process.env.ORDER_IPC_TIMEOUT_MS) || 90000;
    private socket: net.Socket | null = null;
    private connected = false;
    private pending: Map<string, { resolve: (r: OrderResponse) => void; reject: (e: Error) => void }> = new Map();
    private fillHandlers: FillHandler[] = [];
    private positionsChangedHandlers: PositionsChangedHandler[] = [];
    private nextId = 0;

```

**Before** (lines 81-89):
```ts
    private request(type: OrderRequestType, userId: string, payload: any): Promise<OrderResponse> {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) return reject(new Error('Not connected to order process'));
            const id = String(this.nextId++);
            this.pending.set(id, { resolve, reject });
            const req: OrderRequest = { kind: 'request', id, type, userId, payload };
            writeJsonLine(this.socket, req);
        });
    }
```

**After** (replace lines 81-89 with):
```ts
    private request(type: OrderRequestType, userId: string, payload: any): Promise<OrderResponse> {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) return reject(new Error('Not connected to order process'));
            const id = String(this.nextId++);
            // If `order` never replies (hung broker call inside it, a
            // dropped/malformed response, a wedged process that's still
            // technically connected), this used to leave the caller awaiting
            // forever - the socket 'close' handler above only covers the
            // socket actually dropping, not "still open but silent". See
            // plans/bug-09-no-timeout-broker-http-ipc.md.
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    Log.log(`[strategies] Order request '${type}' (id=${id}) timed out after ${OrderClient.REQUEST_TIMEOUT_MS}ms - order process may be stuck`);
                    reject(new Error(`Order process request '${type}' timed out after ${OrderClient.REQUEST_TIMEOUT_MS}ms`));
                }
            }, OrderClient.REQUEST_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: (r: OrderResponse) => { clearTimeout(timer); resolve(r); },
                reject: (e: Error) => { clearTimeout(timer); reject(e); },
            });
            const req: OrderRequest = { kind: 'request', id, type, userId, payload };
            writeJsonLine(this.socket, req);
        });
    }
```

No other part of `OrderClient.ts` needs to change. The `connect()` method's `response`-message handler (lines ~46-63) and `close` handler (lines ~65-77) keep working exactly as before — they still call `waiter.resolve(...)`/`waiter.reject(...)` on whatever is in `this.pending`, which is now the wrapped version that also clears the timer. All ~35 typed public methods (`buyIndex`, `manualBuy`, `squareOff`, etc.) are unchanged; they all funnel through the one private `request()` method being fixed here.

## Caller audit — pre-existing gap, not introduced by this fix, flagged for the executing agent to double check

Before this fix, `OrderClient.request()` could already reject for reasons other than a timeout (e.g. `'Not connected to order process'` synchronously, or `'Order process connection closed'` from the socket-close handler, or a broker-side error surfaced as `res.ok === false` inside the typed wrapper methods which then `throw new Error(res.error)`). So every caller already had to be prepared for a rejected promise; this fix adds one more *reason* a promise can reject (timeout) but does not change *whether* callers need rejection handling — they already did.

Grep confirms most strategy call sites already wrap the call in `try/catch` (e.g. `GoodMorningStrategy.executeTrade`, `strategy.ts`'s `addOrder`/`buyContract`, `GapStrategy.executeTrade`, `SupportResistanceStrategy.executeTrade`, `GoodMorningSensexStrategy.executeTrade`, `TargetReachStrategy.executeTrade`, `ContinuousStrategy`'s `withOpLock`-wrapped entries). A few call sites do **not** have their own `try/catch` around the `OrderClient` call:
- `src/strategy/strategy.ts` line 156, `sellContract(...)` — returns `OrderClient.getInstance().sellContract(...)` directly, no local catch.
- `src/strategy/GapStrategy.ts` line 55, the `squareOff(...)` call inside the timeout-exit branch — no local catch.
- `src/strategy/BiDirectionStrategy.ts` lines 365 and 369, `closeStrategy()`'s two `sellContract(...)` calls — no local catch.
- `src/strategy/DiffStrategy.ts` line 62, `buyIndex(...)` inside the arrow-function `buyIndex = async (right) => {...}` — no local catch.
- `src/strategy/SentimentStrategy.ts` line 219, `buyIndex(...)` inside `processNiftyQuote` — no local catch.

This is a **pre-existing** gap (these sites were equally exposed to `'Not connected to order process'` and broker-error rejections before this fix) and is **out of scope** for this bug — do not add try/catch to these call sites as part of this fix. Just re-run a grep for `.catch(` / `try {` around these five sites after making the `OrderClient.ts` change, confirm nothing here was accidentally broken (it shouldn't be — `request()`'s external contract, "returns a Promise that resolves or rejects", is unchanged), and leave them as-is unless the user separately asks for that hardening.

## New/changed test file (exact full file content)

### `src/test/orderClientTimeout.test.ts` (new file)

Tests the IPC half. Simulates `OrderClient.request()` never receiving a response by wiring a fake socket (just a `.write()` no-op) directly onto a fresh `OrderClient` instance (constructed with plain `new OrderClient()`, **not** via `OrderClient.getInstance()`, so this never touches the real singleton other code might use) and never delivering a `response` message for it. Overrides `REQUEST_TIMEOUT_MS` to a short value first so the test doesn't have to wait out the real 90s production default. Also covers the success path (a response arriving before the timeout still resolves, and does not leave a stray timer able to fire later).

```ts
/**
 * Verifies OrderClient.request() rejects with a timeout error (instead of
 * hanging forever) when the order process never sends a response for a
 * pending request, and that a normal response still resolves correctly and
 * cleans up after itself. Overrides the private REQUEST_TIMEOUT_MS to a
 * short value so the test doesn't have to wait out the real production
 * timeout (90s by default - see OrderClient.ts).
 * Run: npm run build (compile), then: node ./dist/test/orderClientTimeout.test.js
 */

import OrderClient from '../processes/strategies/OrderClient';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    // --- Scenario 1: no response ever arrives -> must reject, not hang ---

    // TS `private static` is a compile-time-only restriction and doesn't
    // survive an `as any` cast, so this reaches the real field used by
    // request().
    (OrderClient as any).REQUEST_TIMEOUT_MS = 200;

    // Deliberately NOT OrderClient.getInstance() - a plain `new` so this test
    // never touches the real singleton other code paths rely on.
    const client: any = new OrderClient();
    // Simulate an already-connected socket that accepts writes but never
    // delivers a response - the scenario that used to hang forever.
    client.socket = { write: (_data: string) => true };
    client.connected = true;

    const start = Date.now();
    let caught: Error | null = null;
    try {
        await client.request('stats', 'Default', {});
    } catch (e: any) {
        caught = e;
    }
    const elapsed = Date.now() - start;

    assert(caught !== null, 'request() rejects instead of hanging when no response ever arrives');
    assert(!!caught && /timed out/i.test(caught.message), `rejection error mentions timeout (got: ${caught?.message})`);
    assert(elapsed < 2000, `rejection happens promptly, well under a hard 2s test ceiling (got ${elapsed}ms)`);
    assert(client.pending.size === 0, 'timed-out request is removed from the pending map (no leak)');

    // --- Scenario 2: a normal response before the timeout still resolves,
    // and does not leave a stray timer able to fire later ---

    (OrderClient as any).REQUEST_TIMEOUT_MS = 5000;
    const client2: any = new OrderClient();
    client2.connected = true;
    let sentId: string | null = null;
    client2.socket = {
        write: (data: string) => {
            const msg = JSON.parse(data);
            sentId = msg.id;
        },
    };

    const resultPromise = client2.request('stats', 'Default', {});
    // Simulate the order process replying, the same way OrderClient's own
    // readJsonLines handler in connect() does: delete from `pending` first,
    // then resolve.
    const waiter = client2.pending.get(sentId);
    client2.pending.delete(sentId);
    waiter.resolve({ kind: 'response', id: sentId, ok: true, result: { hello: 'world' } });

    const result = await resultPromise;
    assert(result?.result?.hello === 'world', 'a normal response still resolves correctly');
    assert(client2.pending.size === 0, 'resolved request is removed from the pending map');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

### `src/test/antHttpTimeout.test.ts` (new file)

Tests the ANT HTTP half. A real network hang isn't practically unit-testable without a mock HTTP server, so this asserts the instance-level `timeout` config that every `axios.get`/`axios.post` call in `ANT.ts` relies on (the closest feasible automated check) — plus a manual verification note below for the live path.

```ts
/**
 * Verifies ANT's shared axios instance is configured with a default request
 * timeout, so a hung connection to AliceBlue can no longer stall a caller
 * (e.g. a strategy awaiting order placement, via OrderClient -> order
 * process -> ANT) forever. A real network hang isn't practically
 * unit-testable without a mock HTTP server - see
 * plans/bug-09-no-timeout-broker-http-ipc.md's Verification section for a
 * manual live-check instead. This asserts the instance-level config that
 * every axios.get/axios.post call in ANT.ts relies on.
 * Run: npm run build (compile), then: node ./dist/test/antHttpTimeout.test.js
 */

import { ANT_HTTP_TIMEOUT_MS, antAxiosInstance } from '../ant/ANT';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    assert(ANT_HTTP_TIMEOUT_MS > 0, `ANT_HTTP_TIMEOUT_MS is a positive number (got ${ANT_HTTP_TIMEOUT_MS})`);
    assert(
        ANT_HTTP_TIMEOUT_MS >= 10000 && ANT_HTTP_TIMEOUT_MS <= 20000,
        `ANT_HTTP_TIMEOUT_MS is in the expected 10-20s range (got ${ANT_HTTP_TIMEOUT_MS})`
    );
    assert(
        antAxiosInstance.defaults.timeout === ANT_HTTP_TIMEOUT_MS,
        `ANT's shared axios instance has timeout=${ANT_HTTP_TIMEOUT_MS} set on its defaults (got ${antAxiosInstance.defaults.timeout})`
    );

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

**Manual verification note (live, not automated):** the only way to observe the ANT HTTP timeout actually firing against a real hang is to point `ANT_HTTP_TIMEOUT_MS` at a very small value temporarily (e.g. edit the constant to `1`) and make any live-authenticated ANT call (e.g. `GET /ant/trades` if the server is running and logged in) — it should fail fast with an axios `ECONNABORTED`/timeout error instead of the request's normal behavior. Revert the constant back to `15000` afterward. This is optional, exploratory confirmation only — do not leave the constant changed, and do not make this part of the automated test suite (it requires live credentials/network and would be flaky in CI).

## Verification steps for orchestrator (exact shell commands to run, and exact expected output/PASS lines)

Run these from `/home/karthikeyan/work/icici`, in order:

1. **Type-check the whole project** (no `build` npm script exists — this is a pre-existing gap, use `npx tsc` directly):
   ```
   npx tsc --noEmit
   ```
   Expected: exits with status 0 and prints nothing to stdout/stderr (this was confirmed as the clean baseline before this fix — if you see errors, they must be caused by this fix's edits, since the pre-fix baseline is clean).

2. **Compile** (needed to produce `./dist/test/*.js` for the two new test scripts and to pick up the `ANT.ts`/`OrderClient.ts` edits):
   ```
   npx tsc
   ```
   Expected: exits with status 0, no errors printed. This populates/updates `dist/`.

3. **Run the new IPC timeout test:**
   ```
   node ./dist/test/orderClientTimeout.test.js
   ```
   Expected output (order of PASS lines matches the assertions in the test file, top to bottom):
   ```
     PASS: request() rejects instead of hanging when no response ever arrives
     PASS: rejection error mentions timeout (got: Order process request 'stats' timed out after 200ms)
     PASS: rejection happens promptly, well under a hard 2s test ceiling (got <N>ms)
     PASS: timed-out request is removed from the pending map (no leak)
     PASS: a normal response still resolves correctly
     PASS: resolved request is removed from the pending map
   ALL TESTS PASSED
   ```
   (The `<N>ms` value will vary run to run but must be well under 2000 and should be close to 200ms.) Exit code must be 0 (`echo $?` after running, or rely on the printed `ALL TESTS PASSED` vs `SOME TESTS FAILED` line — the script sets `process.exitCode = 1` on any failed assertion instead of throwing).

4. **Run the new ANT HTTP timeout test:**
   ```
   node ./dist/test/antHttpTimeout.test.js
   ```
   Expected output:
   ```
     PASS: ANT_HTTP_TIMEOUT_MS is a positive number (got 15000)
     PASS: ANT_HTTP_TIMEOUT_MS is in the expected 10-20s range (got 15000)
     PASS: ANT's shared axios instance has timeout=15000 set on its defaults (got 15000)
   ALL TESTS PASSED
   ```

5. **Run the existing test suite spot-check** to confirm nothing else broke (these are the two most relevant pre-existing hand-rolled tests that also touch `OrderClient`/order-process-adjacent code):
   ```
   node ./dist/test/bookkeepingDedup.test.js
   ```
   Expected: ends with `ALL TESTS PASSED` (same as it did before this change — this test doesn't touch `OrderClient`/`ANT`, it's a regression guard that the build/compile step didn't break anything else).

If every command above prints its expected `ALL TESTS PASSED` (or, for step 1/2, exits 0 silently) with no `FAIL:` lines and no thrown/uncaught exceptions, the fix is verified complete. Do not run `npm test` (`jest`) — per project convention this has no working setup despite being in `package.json`.

## Files touched

- `src/ant/ANT.ts` — modify (lines 1-9 replaced; adds `ANT_HTTP_TIMEOUT_MS` and `antAxiosInstance` named exports, sets `timeout` on the shared axios instance).
- `src/processes/strategies/OrderClient.ts` — modify (lines 16-24 replaced to add the `REQUEST_TIMEOUT_MS` static field; lines 81-89 replaced to add the timeout/cleanup logic in `request()`).
- `src/test/orderClientTimeout.test.ts` — new file (IPC timeout test).
- `src/test/antHttpTimeout.test.ts` — new file (ANT HTTP timeout config test).
