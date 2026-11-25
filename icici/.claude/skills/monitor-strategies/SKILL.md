---
name: monitor-strategies
description: Use when asked to monitor, watch, or babysit BulkPcrStrategy / BulkPcrAutoStartStrategy (ANT opposite-side pair), ContinuousStrategy, SimpleContinuousStrategy or MomentumAtFixedTimeStrategy while the processes are already running, to give their status / P&L / open contracts, or to fix, restart and verify if an error appears.
---

# Monitor BulkPcr + ContinuousStrategy + SimpleContinuousStrategy + MomentumAtFixedTime (and fix on error)

The user has already started the processes (`npm run processes`). Do NOT start them unless an
error forces a restart (see "On error"). Keep token use low: no polling, no re-reading files already
in context, never read `orchestrator.log` yourself - the monitor and the scripts are the only sources.

## 1. Watch (alerts only)

Load `Monitor` via ToolSearch (`select:Monitor`) if deferred, then arm ONE monitor (TaskStop the old
one first on re-arm, never two), `timeout_ms: 1800000`, re-arm on each expiry while the user wants the watch:

```
/home/karthikeyan/work/icici/scripts/monitor-strategies-alerts.sh
```

It covers all of them (SimpleContinuousStrategy rides the Continuous feed; MomentumAtFixedTime, NiftyChange and Recommendation the limit-entry feed) and emits only `!!!` lines: errors, failures, fail-closed blocks, ALERTs,
and MAX PROFIT / MAX LOSS trips. It also emits `=== SLOT MISSED <time> <strategy> <slot>: <reason>` for
every BulkPcrAutoStart / NiftyChange / MomentumAtFixedTime slot that did not trade (late, process started after it, previous
position still running, flat Nifty, loss-stopped broker, invalid config). A filled buy+sell pair is NOT
notified. Routine buy / sell / fill / spawn / target / refill events and
BulkPcr's normal "Cycle complete" are filtered out at the source.

**Reporting rules**
- Stay silent on normal events (including a filled buy+sell pair). Reply only to a `!!!` line or a `=== SLOT MISSED` line.
- For a missed slot, say in one sentence which slot of which strategy was missed and the reason given in the line.
- **MomentumAtFixedTime slots: always report a missed one, including a silent one.** The feed only speaks when the strategy logs a reason, so
  a slot that is not evaluated at all (strategy `enabled: false`, processes down, broker logins missing so no ticks, state not loaded) produces
  no line. Each time a slot in `MomentumAtFixedTimeStrategy.times` passes (every 10 min, 10:00-14:50), look in the day's
  `logs/orchestrator-YYYY-MM-DD.log` for a `MomentumAtFixedTime ... <HH:MM> slot` line within about a minute of it. Three outcomes:
  - the slot traded: stay silent (a filled pair is routine);
  - the slot was evaluated and chose not to trade ("no positive surplus winner", flat/no momentum): report it as "slot HH:MM did not trade: <reason>";
  - no line, or "skipped - process started at ..., after it": report it as "slot HH:MM was missed: not evaluated" and, in the same message, say why
    from `enabled`, the process start time and `scripts/check-broker-sessions.sh`. Do not enable, restart or sync to fix it without the user's instruction.
- Report the line in one or two plain sentences: what failed or which limit tripped, and the strategy.
  Name the contract only when the contract itself is the problem (e.g. a rejected or stuck order).
- A notification can be cut off; if so, say that plainly and wait for the next event.
- Once, at the start, tell the user the clock (`date +%H:%M`) and, for BulkPcr, the next slot in
  `BulkPcrAutoStartStrategy.times` (config.yml); for MomentumAtFixedTime the next entry in its `times` (every 10 min, 10:00-14:50). For ContinuousStrategy and SimpleContinuousStrategy confirm `enabled` (entry window
  09:30-15:00); if `false`, ask before enabling. Its `broker:` key is informational (real broker is
  `bookkeeping.getUserBroker`, default kite).

## 2. Status on demand

When asked "status", "what is the status now" or similar, run `scripts/strategy-status.sh` (by default ONLY trades opened today, IST day of the trade's entry time, count, realized and unrealized; a trade bought earlier and sold today, or still open from an earlier day, is left out; a trade with no entry time counts as today) and show
its output as-is. If the user asks "status all" run `scripts/strategy-status.sh all`, which also counts trades opened on an earlier day but closed today and positions still open from earlier days. If the user asks "status users" (the real users who trade from the frontend, identified by email, as opposed to strategies) run `scripts/strategy-status.sh users` (`users all` for earlier-day trades too) and show its output as-is: BY USER (realized, unrealized, open, closed per email), BY BROKER, OPEN POSITIONS by user (target/stop as stored on the position, "-" if none) and TRADES (one row per closed trade: entry, exit, times, realized). Admin rows can include mirrored shares of other users' buys (settings.mirrorPercentage); a trade row does not record that, so the footer says it instead of marking rows. If TRADES says "unavailable ... restart", the web server predates `?closed=1`: say so. If the script prints a WARNING that the web server predates the ?opened filter, the numbers are the all-trades picture: say so. The output is: realized and unrealized P&L for ONLY the strategies enabled in `config.yml` (expanded per broker; zeros until it trades; trades of a disabled strategy are left out of all three tables, user's rule 2026-11-13; no fixed list), plus a
total, a table by broker, and a third table, **UNREALIZED BY BROKER AND STRATEGY**: one row per open position with broker, strategy, contract, qty,
bought price, live price, resting sell price and unrealized P&L (unrealized only). The resting sell price is read from the strategy's own
"resting sell @ <price>" log line for that contract (the position does not store it), or from its "target <price> / stop <price> protected via gtt" line, shown as `<price> (gtt)`; `-` means none was logged (RuleBased exits on ticks), and `(tick)` marks a tick-monitored target. A `*` after a live price means no live quote, last known price.
Add nothing else (no event history) unless the user asks.

**"status net" (user's command).** Run `scripts/strategy-status.sh net` and paste its output as-is, in a code block: a table with one row per broker (kite, ant, prism, breeze) with REALIZED, UNREALIZED and TOTAL, a TOTAL row, a `users*` row, and then the line `NET <number>`. It is today's P&L taken from the brokers' own books, equal to what each broker itself reports (2 decimals), so orders placed outside the platform (manual orders) count too. This is the one place where manual orders are counted; everywhere else they are ignored. All four brokers use the broker's day-average convention (realized = sold quantity x (average sell - average buy), unrealized = open quantity x (ltp - average of the open side)), not FIFO. Kite reports every position P&L as unrealised, so the script derives the split from Kite's own buy/sell values; ant and prism use their own realized/unrealized fields; breeze reports no P&L and is derived from its trade book. Each broker is proof-checked (total equals the broker's own P&L figures; for breeze the net quantity and average equal its positions). A failed proof, a carried-over contract or an unreadable broker shows `ERROR: <why>` (never a different number) and the NET line then ends with `(EXCLUDES <broker> ...)`. The `users*` row is the real frontend users (emails) with their realized, unrealized and total; their trades are already inside the broker books, so the row is NOT added to the TOTAL row or to NET (the footnote line says so), and it shows `ERROR: cannot be computed` when it cannot be read. No explanation. `status net all` is accepted.

**"status list".** Run `scripts/strategy-status.sh list` and paste its output as-is: the options that can be used with `status` (`status`, `status all`, `status users`, `status users all`, `status net`, `status paper`, `status list`) with one line each. `status all` includes disabled strategies; plain `status` lists enabled ones only. Paper is excluded by the broker of each trade, not by the strategy's current config, so a strategy now on paper keeps its real trades in BY STRATEGY and BY BROKER (the two TOTALs agree) and a paper-only strategy with no real trade has no row. Add nothing else.

**"status paper" (only when the user says `paper`; never part of `status`, `status all` or `status users`, and those never show paper rows).** The paper broker
(`brokers: [paper]`: GammaBurst-NIFTY, HighLow-NIFTY) keeps everything in the trading process's memory and writes nothing to Mongo, so
`scripts/strategy-status.sh` and `/strategyPnl` cannot show it. Report it from these sources, naming each in the reply:
1. `config.yml`: which of the three blocks are `enabled: true`, with `quantity`/`maxInvestment`, `target`, `stopLoss`; confirm each lists only `paper`.
2. `curl -s localhost:3000/broker/paper/positions` and `/broker/paper/trades` (open paper positions and the day's paper fills, as the endpoint returns them; say "empty" if it is).
3. Today's orchestrator log (`logs/orchestrator-<today>.log`): every line with `[paper]` or a paper strategy tag (`HighLow:`, `GammaBurst:`), i.e. each paper entry,
   resting sell, stop, exit and `[skip]` reason. Pair each buy with its sell by contract and quantity to give one row per paper trade (entry, exit, times, reason).
Output: a table of paper trades per strategy (contract, qty, entry, exit or "open", realized), the open paper legs with their resting sell and stop, and per-strategy
realized and open counts. Realized is computed from the logged fill prices; an open leg's unrealized is marked at the live price only if a source gave one, else say
"unrealized not available". Say that the figures are from the log and the paper endpoints, not Mongo, are lost on a processes restart (a restart closes paper legs
with neutral P&L; the log keeps the history), and are gross (no brokerage or taxes). If a restart happened today, list the restart time: trades before it are in the log only.

Only when asked for the position picture / open contracts / capital, run
`scripts/continuous-strategy-trades.sh` (Capital Used, open contracts, parent/child tree; legs
labeled "orphan/partial-log" were restored by `reconcile()`).

## 3. On error

You may fix, restart and verify. Own the fix:

1. Root-cause in `src/strategy/BulkPcrStrategy.ts`, `ContinuousStrategy.ts`, `SimpleContinuousStrategy.ts`, `MomentumAtFixedTimeStrategy.ts` /
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

- A restart restores open positions from Mongo alone (no broker read, no login) and a reconcile never places an order. Run `npm run sync` (broker -> Mongo; add
  `-- --strategies` to also re-read Mongo into the strategies) after logging in, after a mid-day restart, or when a broker and Mongo disagree: a position a broker
  closed earlier that day stays open in the platform until a sync books it. The platform also runs it by itself at 15:45.
- `curl -s -X POST localhost:3000/ant/connect` if the ANT stream is not ticking.
- MAX PROFIT / MAX LOSS latch for the session (persisted); new entries stay blocked until reset.
- Continuous exits are price-based and self-monitored (no GTT, no time exit).
