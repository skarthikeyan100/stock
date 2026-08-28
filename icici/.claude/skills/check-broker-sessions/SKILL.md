---
name: check-broker-sessions
description: Use when asked to check ANT/AliceBlue or Kite/Zerodha session/token/login status, whether re-login is needed, or whether the ANT market-data WebSocket is connected/streaming.
---

# Check Broker Sessions

## Overview
Verifies, against the live running server, whether ANT (AliceBlue) and Kite
(Zerodha) session tokens are valid and whether ANT's market-data WebSocket is
currently connected. Session files existing on disk is not sufficient proof —
Zerodha tokens expire daily and either broker's token can be revoked
server-side, so this always makes a live read-only API call rather than just
inspecting `.ant_session.json` / `.zerodha_session.json`.

## When to Use
- "Check if ANT/Kite sessions are valid"
- "Is the ANT websocket connected/streaming?"
- Before relying on live trading for the day, or after any server/orchestrator restart
- Debugging "no ticks arriving" or "order failed - no active session" type issues

## Running the Check

```bash
scripts/check-broker-sessions.sh
```

Requires the `server` process to be up (`npm run server` or the orchestrator)
on port 3000 — override with `BASE_URL=http://host:port` if different. Exits
non-zero if any check fails, so it composes in other scripts/CI.

It checks, in order:
1. `.ant_session.json` / `.zerodha_session.json` exist, reporting last-written time
2. `GET /ant/trades` and `GET /kite/positions` actually succeed (live token probe, not just file presence)
3. `orchestrator.log` for the most recent `[AntDataStream] Connected and streaming` line with no disconnect/error after it

## Interpreting Failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Session file missing/stale | Never logged in, or process restarted and lost in-memory token reference | Re-run `scripts/login.sh` (opens `/ant/login` and `/kite/login`) |
| `/ant/trades` or `/kite/positions` fails despite a recent session file | Token expired (Zerodha tokens expire daily, ~6am) or revoked | Re-login via `scripts/login.sh` |
| WS shows no connect line, or a disconnect after the last connect | `AntDataStream` never connected this run, or dropped and hasn't reconnected | Hit `GET /ant/connect` to re-trigger, or check `orchestrator.log` around the disconnect for the reason |
| Script reports server unreachable | `server`/orchestrator process not running | Start it (`npm run server` / `npm run processes`) |

Note: the ANT WS connection is in-memory in the `data` process and does not
survive a restart — always re-check after any orchestrator/process restart.
