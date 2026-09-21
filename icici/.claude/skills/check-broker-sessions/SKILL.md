---
name: check-broker-sessions
description: Use when asked to check ANT/AliceBlue, Kite/Zerodha, or Breeze/ICICI Direct session/token/login status, whether re-login is needed, or whether the ANT/Breeze market-data WebSocket is connected/streaming.
---

# Check Broker Sessions

## Overview
Verifies, against the live running server, whether ANT (AliceBlue), Kite
(Zerodha), and Breeze (ICICI Direct) session tokens are valid, and whether
ANT's and Breeze's market-data WebSockets are currently connected (Kite has no
live tick stream in this codebase - all NIFTY/SENSEX/option ticks are
ANT- or Breeze-sourced, per `dataProcess.ts`). Session files existing on disk
is not sufficient proof — Zerodha tokens expire daily and any broker's token
can be revoked server-side, so this always makes a live read-only API call
rather than just inspecting `.ant_session.json` / `.zerodha_session.json` /
`.breeze_session.json`. Results are printed as a single table, one row per
broker.

## When to Use
- "Check if ANT/Kite/Breeze sessions are valid"
- "Is the ANT/Breeze websocket connected/streaming?"
- Before relying on live trading for the day, or after any server/orchestrator restart
- Debugging "no ticks arriving" or "order failed - no active session" type issues
- Before enabling a strategy whose entry point depends on live ticks it doesn't obviously touch (e.g. `BulkPcrStrategy` trades via Breeze but its NIFTY ticks and PCR check are ANT-sourced — both sessions must be live)

## Running the Check

Run from the repo root (`/home/karthikeyan/work/icici`) — the script lives in
the project's own `scripts/` directory, not under this skill's directory:

```bash
scripts/check-broker-sessions.sh
```

Requires the `server` process to be up (`npm run server` or the orchestrator)
on port 3000 — override with `BASE_URL=http://host:port` if different. Exits
non-zero if any check fails, so it composes in other scripts/CI.

Output looks like:

```
== Broker session status ==
Broker     | Session File             | Token Valid | WS Streaming
---------- | ------------------------ | ------------ | ------------
ANT        | OK (2026-09-21 12:32:20) | OK           | OK (12:32:21)
Zerodha    | OK (2026-09-03 07:46:44) | FAIL (...)   | N/A (no live tick stream for this broker)
Breeze     | OK (2026-09-21 12:34:23) | OK           | OK (12:21:24)
```

It checks, per broker, in order:
1. `.ant_session.json` / `.zerodha_session.json` / `.breeze_session.json` exist, reporting last-written time
2. `GET /broker/<ant|zerodha|breeze>/<trades|positions>` actually succeeds (live token probe, not just file presence)
3. `orchestrator.log` for the most recent `[AntDataStream] Connected and streaming` / `[BreezeDataStream] Connected and streaming` line with no disconnect/error after it (Zerodha has no such stream — always `N/A`)

## Interpreting Failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Session file missing/stale | Never logged in, or process restarted and lost in-memory token reference | Re-run `scripts/login.sh` (opens `/prism/login`, `/ant/login`, `/kite/login`, `/breeze/login`) |
| Token check fails despite a recent session file | Token expired (Zerodha tokens expire daily, ~6am) or revoked | Re-login via `scripts/login.sh` |
| WS shows no connect line, or a disconnect after the last connect | `AntDataStream`/`BreezeDataStream` never connected this run, or dropped and hasn't reconnected | Hit `GET /ant/connect` (ANT) or `GET /breeze/connect` (Breeze) to re-trigger, or check `orchestrator.log` around the disconnect for the reason |
| Script reports server unreachable | `server`/orchestrator process not running | Start it (`npm run server` / `npm run processes`) |

Note: the ANT and Breeze WS connections are in-memory in the `data` process
and do not survive a restart — always re-check after any orchestrator/process
restart.
