#!/bin/bash
# Checks ANT (AliceBlue), Kite (Kite), Breeze (ICICI Direct) and Prism (Shoonya) session-token
# validity, plus each broker's market-data WebSocket connection state (ANT and
# Breeze only - Kite/Kite has no live tick stream in this codebase, ticks are
# always ANT/Breeze-sourced). Read-only: uses each broker's trades/positions
# endpoint as a live token-validity probe (no orders placed).

set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORCH_LOG="$REPO_ROOT/orchestrator.log"

fail=0

session_status() {
    # $1 = file path -> prints "OK (last written: ...)" or "FAIL (missing)"
    local path="$1"
    if [ -f "$path" ]; then
        local mtime
        mtime=$(date -d "@$(stat -c %Y "$path")" '+%Y-%m-%d %H:%M:%S')
        echo "OK ($mtime)"
    else
        echo "FAIL (missing)"
        fail=$((fail+1))
    fi
}

token_status() {
    # $1 = broker path segment, $2 = probe path ("trades" or "positions")
    local broker="$1" kind="$2"
    local resp
    resp=$(curl -s -m 10 "$BASE_URL/broker/$broker/$kind")
    if echo "$resp" | grep -q '"success":true'; then
        echo "OK"
    else
        local detail
        detail=$(echo "$resp" | grep -oE '"details":"[^"]*"' | sed -E 's/^"details":"//; s/"$//' | head -1)
        detail="${detail:-$resp}"
        if [ "${#detail}" -gt 40 ]; then detail="${detail:0:37}..."; fi
        echo "FAIL ($detail)"
        fail=$((fail+1))
    fi
}

ws_status() {
    # $1 = connected-log tag, $2 = disconnect-pattern (extended regex),
    # $3 = optional recovery-pattern: a line socket.io logs after an automatic reconnect (no new "Connected and streaming")
    local connect_tag="$1" disconnect_pattern="$2" recovery_pattern="${3:-}"
    if [ ! -f "$ORCH_LOG" ]; then
        echo "FAIL (orchestrator.log not found)"
        fail=$((fail+1))
        return
    fi
    local last_connect last_disconnect connect_line disconnect_line
    last_connect=$(grep -n "$connect_tag" "$ORCH_LOG" | tail -1)
    last_disconnect=$(grep -nE "$disconnect_pattern" "$ORCH_LOG" | tail -1)
    connect_line=$(echo "$last_connect" | cut -d: -f1)
    disconnect_line=$(echo "$last_disconnect" | cut -d: -f1)

    if [ -z "$connect_line" ]; then
        echo "FAIL (never connected this run)"
        fail=$((fail+1))
    elif [ -n "$disconnect_line" ] && [ "$disconnect_line" -gt "$connect_line" ]; then
        # A disconnect is only a failure if the socket did not come back: socket.io reconnects on its own and logs the reconnect, not a new "Connected and streaming".
        local recovered_line=""
        [ -n "$recovery_pattern" ] && recovered_line=$(grep -nE "$recovery_pattern" "$ORCH_LOG" | tail -1)
        local recovered_no="${recovered_line%%:*}"
        if [ -n "$recovered_no" ] && [ "$recovered_no" -gt "$disconnect_line" ]; then
            local ts
            ts=$(echo "$recovered_line" | grep -oE '\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' | head -1 | tr -d '[]')
            echo "OK (reconnected ${ts:-})"
        else
            echo "FAIL (disconnected after last connect)"
            fail=$((fail+1))
        fi
    else
        local ts
        ts=$(echo "$last_connect" | grep -oE '\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' | head -1 | tr -d '[]')
        echo "OK (${ts:-connected})"
    fi
}

feed_liveness() {
    local dow hm now_s line ts t_s age
    dow=$(date +%u); hm=$(date +%H%M)
    # weekday, 09:20-15:25 only (before that, or after, silence is normal)
    if [ "$dow" -gt 5 ] || [ "$hm" -lt 0925 ] || [ "$hm" -ge 1525 ]; then return; fi
    line=$(grep -E "\[VWAP-FEED\] .* ltp " "$ORCH_LOG" 2>/dev/null | tail -1)
    ts=$(echo "$line" | grep -oE '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' | tr -d '[]')
    if [ -z "$ts" ]; then echo "FAIL (no tick heartbeat logged today)"; return; fi
    now_s=$(( 10#$(date +%H) * 3600 + 10#$(date +%M) * 60 + 10#$(date +%S) ))
    t_s=$(( 10#${ts:0:2} * 3600 + 10#${ts:3:2} * 60 + 10#${ts:6:2} ))
    age=$(( now_s - t_s ))
    if [ "$age" -gt 180 ]; then echo "FAIL (no ticks for $((age / 60))m, last $ts)"; else echo "OK (ticks, last $ts)"; fi
}

ant_session=$(session_status "$REPO_ROOT/.ant_session.json")
kite_session=$(session_status "$REPO_ROOT/.kite_session.json")
breeze_session=$(session_status "$REPO_ROOT/.breeze_session.json")
prism_session=$(session_status "$REPO_ROOT/userToken.txt")

ant_token=$(token_status ant trades)
kite_token=$(token_status kite positions)
breeze_token=$(token_status breeze trades)
prism_token=$(token_status prism positions)

ant_ws=$(ws_status "\[AntDataStream\] Connected and streaming" '\[AntDataStream\].*(Disconnected|onerror|onclose|Connect failed|WebSocket closed)|\[AntWS\].*(Disconnected|closed)|\[data\] Initial ant connect failed')
# The connect line only says when the socket last CONNECTED: during market hours also require a recent NIFTY-future heartbeat
# ([VWAP-FEED], logged every 60 s while ticks flow) so a feed that is down or silent shows as FAIL (2026-11-13: a failed connect at
# restart left no ticks for 26 min while this still printed the old connect time).
ant_live=$(feed_liveness)
case "$ant_ws" in OK*) [ -n "$ant_live" ] && ant_ws="$ant_live";; esac
breeze_ws=$(ws_status "\[BreezeDataStream\] Connected and streaming" '\[BreezeDataStream\].*(disconnected|connect_error)' '\[BreezeDataStream\] socket connected')
kite_ws="N/A (no live tick stream for this broker)"
prism_ws="N/A (fills subscribe on the ANT feed)"

# The status helpers above run in $(...) subshells, so their `fail` increments
# never reach this shell. Count failures from the computed values instead.
fail=0
for status in "$ant_session" "$kite_session" "$breeze_session" "$prism_session" \
              "$ant_token" "$kite_token" "$breeze_token" "$prism_token" "$ant_ws" "$breeze_ws"; do
    case "$status" in FAIL*) fail=$((fail+1));; esac
done

print_row() {
    printf '%-10s | %-28s | %-40s | %-42s\n' "$1" "$2" "$3" "$4"
}

echo "== Broker session status =="
print_row "Broker" "Session File" "Token Valid" "WS Streaming"
print_row "----------" "----------------------------" "----------------------------------------" "------------------------------------------"
print_row "ANT" "$ant_session" "$ant_token" "$ant_ws"
print_row "Kite" "$kite_session" "$kite_token" "$kite_ws"
print_row "Breeze" "$breeze_session" "$breeze_token" "$breeze_ws"
print_row "Prism" "$prism_session" "$prism_token" "$prism_ws"

echo
if [ "$fail" -eq 0 ]; then
    echo "== Summary: all checks OK =="
else
    echo "== Summary: $fail check(s) FAILED =="
fi
[ "$fail" -eq 0 ]
