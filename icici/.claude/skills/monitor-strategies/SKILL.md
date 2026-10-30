---
name: monitor-strategies
description: Use when asked to monitor, watch, or babysit BulkPcrStrategy / BulkPcrAutoStartStrategy (ANT opposite-side pair) or ContinuousStrategy while the processes are already running, to give their status / P&L / open contracts, or to fix, restart and verify if an error appears.
---

# Monitor BulkPcr + ContinuousStrategy (and fix on error)

The user has already started the processes (`npm run processes`). Do NOT start them unless an
error forces a restart (see "On error"). Keep token use low: no polling, no re-reading files already
in context, never read `orchestrator.log` yourself - the monitor and the scripts are the only sources.

## 1. Watch (alerts only)

Load `Monitor` via ToolSearch (`select:Monitor`) if deferred, then arm ONE monitor (TaskStop the old
one first on re-arm, never two), `timeout_ms: 1800000`, re-arm on each expiry while the user wants the watch:

```
/home/karthikeyan/work/icici/scripts/monitor-strategies-alerts.sh
```

It covers both strategies and emits only `!!!` lines: errors, failures, fail-closed blocks, ALERTs,
and MAX PROFIT / MAX LOSS trips. It also emits `=== SLOT MISSED <time> <strategy> <slot>: <reason>` for
every BulkPcrAutoStart / NiftyChange slot that did not trade (late, process started after it, previous
position still running, flat Nifty, loss-stopped broker, invalid config). A filled buy+sell pair is NOT
notified. Routine buy / sell / fill / spawn / target / refill events and
BulkPcr's normal "Cycle complete" are filtered out at the source.

**Reporting rules**
- Stay silent on normal events (including a filled buy+sell pair). Reply only to a `!!!` line or a `=== SLOT MISSED` line.
- For a missed slot, say in one sentence which slot of which strategy was missed and the reason given in the line.
- Report the line in one or two plain sentences: what failed or which limit tripped, and the strategy.
  Name the contract only when the contract itself is the problem (e.g. a rejected or stuck order).
- A notification can be cut off; if so, say that plainly and wait for the next event.
- Once, at the start, tell the user the clock (`date +%H:%M`) and, for BulkPcr, the next slot in
  `BulkPcrAutoStartStrategy.times` (config.yml). For ContinuousStrategy confirm `enabled` (entry window
  09:30-15:00); if `false`, ask before enabling. Its `broker:` key is informational (real broker is
  `bookkeeping.getUserBroker`, default kite).

## 2. Status on demand

When asked "status", "what is the status now" or similar, run `scripts/strategy-status.sh` and show
its output as-is: realized and unrealized P&L per strategy for BulkPcr and ContinuousStrategy, plus a
total. Add nothing else (no event history, no contract list) unless the user asks.

Only when asked for the position picture / open contracts / capital, run
`scripts/continuous-strategy-trades.sh` (Capital Used, open contracts, parent/child tree; legs
labeled "orphan/partial-log" were restored by `reconcile()`).

## 3. On error

You may fix, restart and verify. Own the fix:

1. Root-cause in `src/strategy/BulkPcrStrategy.ts` or `src/strategy/ContinuousStrategy.ts` /
   `LegManager.ts` (shared with SupportResistanceStrategy; do not break it). Think through the
   variations first: both sides / several legs and levels, partial fills and chunks, restart
   mid-state (`reconcile()`), latched max-profit/max-loss, refills pending.
2. Fix it, run `npx tsc --noEmit -p .`.
3. Do not run `code-review` here unless the user asks. Commit and push (never token files:
   `.kite_session.json`, `.breeze_session.json`, `.ant_session.json`).
4. Restart the processes (`npm run processes`, in the background).
5. Verify:
   - BulkPcr: add a time ~3-5 min ahead to `BulkPcrAutoStartStrategy.times` in config.yml, watch that
     slot until the fixed path is exercised, then REMOVE the temporary time and make sure
     `BulkPcrAutoStartStrategy.enabled` is `true` and `TopStockOptionsOpeningGapStrategy` /
     `BulkPcrStrategy` are `false` unless the user said otherwise.
   - Continuous: watch until the fixed path runs; confirm with `scripts/continuous-strategy-trades.sh`.
     Restore `enabled` if you toggled it.
6. Tell the user what broke, what you changed, and whether verification confirmed it.

## Notes

- Reconcile is not needed after a restart for ticks/slots. Call `curl -s -X POST localhost:3000/reconcile`
  (loopback needs no auth; 409 if a broker's positions can't be read) only when broker positions and
  Mongo disagree, e.g. a restart with a position open. Until then strategy state is not restored: say
  so rather than assuming the position is protected. If it logs "blocking new T1 entries until next
  restart", the order query failed.
- `curl -s -X POST localhost:3000/ant/connect` if the ANT stream is not ticking.
- MAX PROFIT / MAX LOSS latch for the session (persisted); new entries stay blocked until reset.
- Continuous exits are price-based and self-monitored (no GTT, no time exit).
