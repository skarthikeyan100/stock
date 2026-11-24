# Bug: Zombie WebSocket connections are undetectable

## Problem

`src/ant/AntWebSocket.ts` maintains a heartbeat that sends a `{t:'h'}` ping
every 3s (`heartbeatMs = 3000`) but never checks whether the server actually
replies, and there is no "time since last message" watchdog anywhere in the
class. The `ws` library's `readyState` only reflects whether the TCP/TLS
socket is technically open — it does **not** know whether the remote side is
still alive. A half-open ("zombie") connection (e.g. the server silently
stopped responding, a NAT/proxy dropped the session without sending a TCP
FIN/RST) can sit at `readyState === OPEN` forever. Because `AntStream.ts`'s
only reconnect trigger is the `close`/`error` events wired up in
`AntWebSocket.ts`'s `onclose`/`onerror` handlers, and neither of those fires
for a zombie connection, the platform can silently stop receiving ticks with
no way to tell — from logs or from `AntStream.isConnected()` — whether that
is a quiet auction or a dead socket.

This matches a real observed incident: a WS reported connected for 12+
minutes with zero ticks reaching the frontend, and there was no signal
anywhere (log line, health check, or reconnect) to distinguish "quiet
market" from "dead socket."

## Root cause (exact files/lines)

`src/ant/AntWebSocket.ts`, lines 29-35 (inside the `onopen` handler passed to
`this.ws`):

```typescript
          // Start heartbeat
          if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ t: 'h' }));
            }
          }, this.heartbeatMs);
```

This interval calls `this.ws.send(...)` (an **application-level** heartbeat
message, `{t:'h'}`, per the Noren/Omnesys protocol) but:
1. Never listens for any reply to that heartbeat (the server may or may not
   ack `{t:'h'}` at the application level — this code doesn't check either
   way).
2. Never listens for the underlying `ws` library's transport-level `pong`
   event (confirmed available: `node_modules/ws` v8.21.3's
   `lib/websocket.js` emits a `'pong'` event via
   `receiverOnPong`/`this[kWebSocket].emit('pong', data)` whenever a ping
   frame's reply is received — see `ping()` at line 367 and the `'pong'`
   emit at line 1262 of `node_modules/ws/lib/websocket.js`). The current
   code calls `this.ws.send(JSON.stringify({ t: 'h' }))` — a normal data
   frame — not `this.ws.ping()`, and it registers no `.on('pong', ...)`
   listener anywhere in the file.
3. Never records a "last message received" timestamp anywhere, so there is
   no way to compute how long the connection has been silent.
4. Has no second interval (a "watchdog") that checks elapsed silence and
   forcibly kills the socket if it exceeds a threshold.

Confirmed by reading the full file (`src/ant/AntWebSocket.ts`, all 117
lines): `onmessage` (lines 40-53), `onerror` (lines 55-59), `onclose`
(lines 61-65), and `close()` (lines 108-113) contain no timestamp tracking
and no watchdog logic.

`src/ant/AntStream.ts` (full file read, 227 lines) confirms the bug report's
claim that reconnection is *only* triggered by the `close` event:
- Lines 95-104: the only reconnect trigger is
  `this.ws.on('close', () => { ...; this.scheduleReconnect(); })`.
- There is no periodic staleness check anywhere in `AntStream.ts`, and
  `isConnected()` (lines 221-223) just returns the `connected` boolean set
  on `open`/`close` — it has no idea whether ticks are actually flowing.
- **No changes to `AntStream.ts` are required for this fix** — its existing
  `ws.on('close', ...)` handler (line 95) already contains the correct
  reconnect logic (`scheduleReconnect()`, respecting `manualDisconnect` and
  `isPastMarketClose()`). The fix only needs to make sure a zombie
  connection actually *fires* that `close` event, which is what
  `ws.terminate()` does (see below).

## Fix design (approach + rationale)

### 1. Track liveness with a timestamp, updated on any real signal

Add a `private lastMessageTime: number = 0;` field to `AntWebSocket`. Update
it in two places:
- Unconditionally at the top of the `onmessage` handler (any inbound frame,
  parseable or not, proves the connection is alive).
- In a new `this.ws.on('pong', ...)` listener (transport-level proof the
  peer responded to our ping), registered once per `connect()` call.

Note: the existing heartbeat sends `{t:'h'}` via `.send()`, which is an
**application-level** message the server may or may not ack — we do not
rely on an app-level ack. Instead we additionally send a real WebSocket
**ping** frame (`this.ws.ping()`) on the same interval, which is answered by
the `ws` library's `pong` event automatically per the WebSocket protocol
(RFC 6455) without any cooperation needed from the Noren/Omnesys application
protocol. This gives us a protocol-level liveness signal independent of
whatever the server does with `{t:'h'}`.

### 2. Extract a pure, unit-testable staleness check

A real `ws` connection can't be exercised in this repo's hand-rolled test
harness (no live server, no test infra for one). So the "is this connection
stale" decision is extracted into a standalone pure function:

```typescript
export function isStale(lastMessageTime: number, now: number, thresholdMs: number): boolean {
  return now - lastMessageTime > thresholdMs;
}
```

exported (named export, alongside the existing `export default AntWebSocket`)
from `src/ant/AntWebSocket.ts`. This function has no side effects and no
dependency on any live socket, so it can be imported and tested directly
(see test file below). The watchdog interval calls this pure function and,
if it returns `true`, performs the actual side effect
(`this.ws?.terminate()`) — the impure part is now a single trivial line that
doesn't need its own test.

### 3. Watchdog interval

Add a second `setInterval`, started/cleared alongside the existing
heartbeat interval (same `onopen`/`onclose`/`close()` lifecycle), that
runs every `heartbeatMs` (3000ms — same cadence as the heartbeat, cheap to
check) and calls `isStale(this.lastMessageTime, Date.now(), this.staleThresholdMs)`.
On `true`, it logs a diagnostic line and calls `this.ws?.terminate()`.

### 4. Threshold choice: 12000ms (4x heartbeat interval)

`staleThresholdMs = this.heartbeatMs * 4` = 12000ms (12s). Rationale:
- The heartbeat/ping fires every 3s, so under a healthy connection a `pong`
  (or any inbound message) should land well within 12s — normally within
  milliseconds of each 3s ping.
- 12s tolerates a couple of missed pings or a transient network hiccup
  (e.g. one dropped ping + one dropped pong = up to ~6-9s of apparent
  silence) without false-positiving during normal jitter.
- Because liveness is tracked at the transport level (`pong` events, not
  application ticks), a genuinely quiet market (no option/index ticks for
  minutes) does **not** by itself trip this threshold — pongs keep arriving
  every ~3s regardless of tick volume, so `lastMessageTime` keeps advancing.
  This is the key property that avoids the "quiet auction vs dead socket"
  ambiguity called out in the bug report: only a connection that has
  stopped responding at the WebSocket protocol level (not just stopped
  sending ticks) will trip the watchdog.
- 12s is short enough to catch a real zombie promptly — a world away from
  the observed 12-*minute* incident — so any reconnect this enables will
  fire roughly 60x sooner than the current undetectable failure mode.

### 5. `ws.terminate()`, not `ws.close()`

The `ws` package's `.terminate()` (confirmed present at
`node_modules/ws/lib/websocket.js:492`) immediately destroys the underlying
TCP socket without waiting for a close handshake, and synchronously/promptly
causes the library to emit its own `'close'` event. `.close()`, by
contrast, sends a close frame and waits for the peer to complete the
closing handshake — exactly the kind of handshake a suspected-dead peer will
never complete, which would leave the socket hanging indefinitely instead of
triggering the existing reconnect logic. Since the whole point of the
watchdog is "this peer is not responding," `.terminate()` is the only choice
that reliably gets us to the `onclose` handler (and therefore to
`AntStream`'s `scheduleReconnect()`) in bounded time.

### Summary of restructuring

- `AntWebSocket.ts` gains: a `lastMessageTime` field, a `staleThresholdMs`
  field, a `watchdogInterval` field, a `pong` listener, an update to
  `onmessage` to stamp `lastMessageTime`, a second `setInterval` (the
  watchdog) started/stopped alongside the heartbeat, a change to the
  heartbeat's `.send()` call to also call `.ping()`, and a new exported pure
  function `isStale`.
- `AntStream.ts` is **not modified** — its existing `close` handler already
  does the right thing once `close` actually fires.

## Exact code changes

### File: `src/ant/AntWebSocket.ts`

This is a full-file replacement. The current file (117 lines, read in full)
is reproduced below as "BEFORE" (verbatim, already shown above in Root
Cause) — replace the **entire file contents** with the "AFTER" version.

**AFTER (full replacement contents of `src/ant/AntWebSocket.ts`):**

```typescript
import WebSocket from 'ws';
import Log from '../util/Log';

type TriggerCallback = (event: string, data?: any) => void;

// Pure staleness check, extracted so it can be unit-tested without a real
// socket - see src/test/antWebSocketWatchdog.test.ts. A connection is
// "stale" once more than thresholdMs has elapsed since the last message or
// pong was received.
export function isStale(lastMessageTime: number, now: number, thresholdMs: number): boolean {
  return now - lastMessageTime > thresholdMs;
}

class AntWebSocket {
  private ws: WebSocket | null = null;
  private url = 'wss://ws1.aliceblueonline.com/NorenWS/';
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private watchdogInterval: NodeJS.Timeout | null = null;
  private heartbeatMs = 3000; // 3s, matches pya3 ping_interval=3 and this repo's Shoonya Config.heartbeat
  // 4x the heartbeat interval: tolerates a couple of missed pings/transient
  // network jitter without false-positiving, while still catching a real
  // zombie connection ~60x faster than the 12-minute incident that motivated
  // this fix. See plans/bug-07-zombie-websocket-undetectable.md for the
  // full rationale.
  private staleThresholdMs = this.heartbeatMs * 4; // 12000ms
  private lastMessageTime = 0;
  private triggers: Record<string, TriggerCallback[]> = {};

  connect(params: { susertoken: string; actid: string; uid: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url, undefined, { rejectUnauthorized: false });

        // Transport-level liveness signal: fires whenever a ping we sent
        // (via ws.ping() in the heartbeat below) is answered by the peer,
        // independent of whether the Noren/Omnesys app protocol acks our
        // {t:'h'} message. Keeps lastMessageTime advancing during quiet
        // markets (no ticks) as long as the socket is genuinely alive.
        this.ws.on('pong', () => {
          this.lastMessageTime = Date.now();
        });

        this.ws.onopen = () => {
          Log.log('[AntWS] Connected, sending auth payload...');
          const initCon = {
            susertoken: params.susertoken,
            t: 'c',
            actid: params.actid,
            uid: params.uid,
            source: 'API',
          };
          this.ws!.send(JSON.stringify(initCon));

          this.lastMessageTime = Date.now();

          // Start heartbeat
          if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ t: 'h' }));
              this.ws.ping();
            }
          }, this.heartbeatMs);

          // Start watchdog: detects a half-open ("zombie") connection where
          // readyState stays OPEN but the server has stopped responding (no
          // messages, no pongs). terminate() (not close()) is used because
          // a dead peer will never complete a graceful close handshake -
          // terminate() destroys the socket immediately and reliably fires
          // the 'close' event below, which is what triggers AntStream's
          // reconnect logic.
          if (this.watchdogInterval) clearInterval(this.watchdogInterval);
          this.watchdogInterval = setInterval(() => {
            if (isStale(this.lastMessageTime, Date.now(), this.staleThresholdMs)) {
              Log.log(`[AntWS] No message/pong received in over ${this.staleThresholdMs}ms - connection appears dead, terminating`);
              this.ws?.terminate();
            }
          }, this.heartbeatMs);

          resolve();
        };

        this.ws.onmessage = (event) => {
          this.lastMessageTime = Date.now();
          try {
            const text = typeof event.data === 'string' ? event.data : event.data.toString('utf-8');
            const data = JSON.parse(text);
            if (data.t === 'ck' || data.t === 'cf') {
              Log.log('[AntWS] Connect ack:', data);
              this.trigger('open', data);
            } else if (data.t === 'tk' || data.t === 'tf') {
              this.trigger('quote', data);
            }
          } catch (e) {
            Log.log('[AntWS] Message parse error:', e);
          }
        };

        this.ws.onerror = (event) => {
          Log.log('[AntWS] WebSocket error:', event);
          this.trigger('error', event);
          reject(event);
        };

        this.ws.onclose = () => {
          Log.log('[AntWS] WebSocket closed');
          if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
          if (this.watchdogInterval) clearInterval(this.watchdogInterval);
          this.trigger('close');
        };
      } catch (e) {
        Log.log('[AntWS] Connect error:', e);
        reject(e);
      }
    });
  }

  subscribe(keys: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      Log.log('[AntWS] Cannot subscribe: connection not open');
      return;
    }
    const k = keys.join('#');
    const msg = { k, t: 't' };
    Log.log('[AntWS] Subscribing:', k);
    this.ws.send(JSON.stringify(msg));
  }

  unsubscribe(keys: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      Log.log('[AntWS] Cannot unsubscribe: connection not open');
      return;
    }
    const k = keys.join('#');
    const msg = { k, t: 'u' };
    Log.log('[AntWS] Unsubscribing:', k);
    this.ws.send(JSON.stringify(msg));
  }

  on(event: string, callback: TriggerCallback): void {
    if (!this.triggers[event]) {
      this.triggers[event] = [];
    }
    this.triggers[event].push(callback);
  }

  private trigger(event: string, data?: any): void {
    if (this.triggers[event]) {
      this.triggers[event].forEach((cb) => cb(event, data));
    }
  }

  close(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.ws) {
      this.ws.close();
    }
  }
}

export default AntWebSocket;
```

**Exact diffs, for reference (what changed vs the BEFORE file):**
1. Added `export function isStale(...)` above the class (new, ~7 lines).
2. Added `private watchdogInterval: NodeJS.Timeout | null = null;` field.
3. Added `private staleThresholdMs = this.heartbeatMs * 4;` field (with
   comment).
4. Added `private lastMessageTime = 0;` field.
5. Right after `this.ws = new WebSocket(...)`, added the
   `this.ws.on('pong', ...)` block.
6. Inside `onopen`, after `this.ws!.send(JSON.stringify(initCon));`, added
   `this.lastMessageTime = Date.now();`.
7. Inside the existing heartbeat `setInterval` callback, added
   `this.ws.ping();` after the existing `this.ws.send(...)` call.
8. After the heartbeat `setInterval` block (still inside `onopen`, before
   `resolve();`), added the new watchdog `setInterval` block.
9. Inside `onmessage`, added `this.lastMessageTime = Date.now();` as the
   very first line of the handler (before the `try`).
10. Inside `onclose`, added `if (this.watchdogInterval) clearInterval(this.watchdogInterval);`
    next to the existing heartbeat-clearing line.
11. Inside `close()`, added the same `watchdogInterval` clear line.

No other lines change. `src/ant/AntStream.ts` is **not modified**.

## New test file

Create `src/test/antWebSocketWatchdog.test.ts` with exactly this content:

```typescript
/**
 * Verifies AntWebSocket's zombie-connection watchdog logic: isStale() must
 * flag a connection as dead once its last message/pong is older than the
 * configured threshold, and must NOT flag a connection that is still being
 * heard from (ticks or pongs arriving within the threshold) - including
 * during a quiet market period with no ticks, as long as pongs keep
 * arriving. A real WebSocket connection can't be exercised in this repo's
 * hand-rolled test harness (no live server, no mocking infra for `ws`), so
 * this tests the extracted pure function directly instead - see
 * plans/bug-07-zombie-websocket-undetectable.md for why this is the
 * feasible test given the constraints.
 * Run: npm run build (compile), then: node ./dist/test/antWebSocketWatchdog.test.js
 */

import { isStale } from '../ant/AntWebSocket';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    const THRESHOLD_MS = 12000;

    // Fresh message just arrived - not stale.
    const now1 = 1_000_000;
    assert(isStale(now1 - 1000, now1, THRESHOLD_MS) === false, 'a message 1s ago is not stale (threshold 12s)');

    // Right at the boundary (exactly threshold ms old) - not stale (strictly greater-than semantics).
    const now2 = 2_000_000;
    assert(isStale(now2 - THRESHOLD_MS, now2, THRESHOLD_MS) === false, 'a message exactly at the threshold age is not stale');

    // Just past the boundary - stale.
    const now3 = 3_000_000;
    assert(isStale(now3 - THRESHOLD_MS - 1, now3, THRESHOLD_MS) === true, 'a message 1ms past the threshold age is stale');

    // Long-idle zombie (the 12-minute observed incident) - stale.
    const now4 = 4_000_000;
    assert(isStale(now4 - 12 * 60 * 1000, now4, THRESHOLD_MS) === true, 'a 12-minute-old connection is flagged stale');

    // A quiet market with no ticks, but pongs still arriving every ~3s
    // (heartbeat cadence), never exceeds the threshold - not a false positive.
    const lastPong = 5_000_000;
    assert(isStale(lastPong, lastPong + 3000, THRESHOLD_MS) === false, 'a quiet market with regular pongs is not flagged stale');

    // Zero elapsed time - never stale.
    const now5 = 6_000_000;
    assert(isStale(now5, now5, THRESHOLD_MS) === false, 'zero elapsed time is not stale');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

This exercises the exact pure function the watchdog interval calls, with
the exact threshold value shipped in `AntWebSocket.ts` (12000ms), including
the boundary condition (`>` not `>=`) and the two scenarios called out in
the bug report and fix design: a genuine long-idle zombie (must be flagged)
and a quiet-but-alive connection (must not be flagged).

### Why full watchdog behavior (the `terminate()` side effect) is not unit tested

The actual `setInterval`/`ws.terminate()` wiring requires a live (or
realistically mocked) `ws.WebSocket` instance receiving real `pong` events
over a real or fake network — this repo has no WebSocket test server, no
`ws` mocking library, and no jest infra actually wired up (per repo
conventions, `"test": "jest"` in `package.json` does not work — see Repo
conventions). Building that harness from scratch is out of scope for this
bug fix. The pure-function test above covers 100% of the *decision logic*
(the only part with branching/edge cases worth testing); the `terminate()`
call itself is a single unconditional line with no logic to get wrong once
`isStale` returns `true`.

**Manual verification step (for a human or a future live-market session):**
After deploying this fix and calling `GET /ant/connect` during market hours,
tail `server.log` (or `server_logs.txt`) and confirm:
1. Normal operation never logs the new `[AntWS] No message/pong received in
   over 12000ms...` line during a healthy connection (grep for it after
   letting the connection run for at least 10-15 minutes: expect zero
   matches).
2. If a zombie is ever suspected again (e.g. `AntStream.isConnected()`
   returns `true` but no ticks are reaching `/ant/stream` for several
   minutes), the fix cannot be exercised by literally unplugging the network
   in this sandboxed environment — but the code path is: no pong/message for
   >12s → watchdog logs the warning line above → `ws.terminate()` → the
   existing `onclose` → `trigger('close')` → `AntStream`'s
   `ws.on('close', ...)` handler (src/ant/AntStream.ts:95-104) →
   `scheduleReconnect()`. Confirming this end-to-end in production is the
   real test; it cannot be simulated offline without a fake WS server, which
   is out of scope here.

## Verification steps for orchestrator

Run these exact commands from `/home/karthikeyan/work/icici`, in order:

```bash
cd /home/karthikeyan/work/icici
npx tsc --noEmit
```
Expected: no output, exit code 0 (confirms the whole project, including the
edited `AntWebSocket.ts` and the new test file, still type-checks with no
errors).

```bash
cd /home/karthikeyan/work/icici
npx tsc
```
Expected: no output, exit code 0 (this is the real compile step this repo's
test convention relies on — populates/updates `./dist`).

```bash
cd /home/karthikeyan/work/icici
node ./dist/test/antWebSocketWatchdog.test.js
```
Expected output (exact PASS lines, order matters, no FAIL lines):
```
  PASS: a message 1s ago is not stale (threshold 12s)
  PASS: a message exactly at the threshold age is not stale
  PASS: a message 1ms past the threshold age is stale
  PASS: a 12-minute-old connection is flagged stale
  PASS: a quiet market with regular pongs is not flagged stale
  PASS: zero elapsed time is not stale
ALL TESTS PASSED
```
Exit code must be 0 (i.e. `echo $?` after the command prints `0`). If any
line reads `FAIL: ...` instead of `PASS: ...`, or the final line reads `SOME
TESTS FAILED`, the fix is not correctly implemented — re-check the
`isStale` function and the threshold value (`this.heartbeatMs * 4` =
`12000`) against the code changes above before re-running.

Optional sanity grep (confirms the new code actually landed, not just the
test):
```bash
grep -n "isStale\|watchdogInterval\|lastMessageTime\|staleThresholdMs\|\.terminate()\|\.on('pong'" /home/karthikeyan/work/icici/src/ant/AntWebSocket.ts
```
Expected: multiple matching lines (one for each of `isStale`,
`watchdogInterval` field + both clears + the interval, `lastMessageTime`
field + 3 assignment sites, `staleThresholdMs`, `this.ws?.terminate()`, and
the `pong` listener registration).

## Files touched

- `src/ant/AntWebSocket.ts` — modified (full-file replacement per "Exact
  code changes" above).
- `src/test/antWebSocketWatchdog.test.ts` — new file (full content per "New
  test file" above).
- `src/ant/AntStream.ts` — **not modified** (its existing `close` handler
  already does the right thing; explicitly confirmed during investigation).
