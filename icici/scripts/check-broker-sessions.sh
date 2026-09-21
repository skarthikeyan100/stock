#!/bin/bash
# Checks ANT (AliceBlue), Kite (Zerodha), and Breeze (ICICI Direct) session-token
# validity, plus each broker's market-data WebSocket connection state (ANT and
# Breeze only - Kite/Zerodha has no live tick stream in this codebase, ticks are
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
    # $1 = connected-log tag, $2 = disconnect-pattern (extended regex)
    local connect_tag="$1" disconnect_pattern="$2"
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
        echo "FAIL (disconnected after last connect)"
        fail=$((fail+1))
    else
        local ts
        ts=$(echo "$last_connect" | grep -oE '\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' | head -1 | tr -d '[]')
        echo "OK (${ts:-connected})"
    fi
}

ant_session=$(session_status "$REPO_ROOT/.ant_session.json")
zerodha_session=$(session_status "$REPO_ROOT/.zerodha_session.json")
breeze_session=$(session_status "$REPO_ROOT/.breeze_session.json")

ant_token=$(token_status ant trades)
zerodha_token=$(token_status zerodha positions)
breeze_token=$(token_status breeze trades)

ant_ws=$(ws_status "\[AntDataStream\] Connected and streaming" '\[AntDataStream\].*(Disconnected|onerror|onclose)|\[AntWS\].*(Disconnected|closed)')
breeze_ws=$(ws_status "\[BreezeDataStream\] Connected and streaming" '\[BreezeDataStream\].*(disconnected|connect_error)')
zerodha_ws="N/A (no live tick stream for this broker)"

print_row() {
    printf '%-10s | %-28s | %-40s | %-42s\n' "$1" "$2" "$3" "$4"
}

echo "== Broker session status =="
print_row "Broker" "Session File" "Token Valid" "WS Streaming"
print_row "----------" "----------------------------" "----------------------------------------" "------------------------------------------"
print_row "ANT" "$ant_session" "$ant_token" "$ant_ws"
print_row "Zerodha" "$zerodha_session" "$zerodha_token" "$zerodha_ws"
print_row "Breeze" "$breeze_session" "$breeze_token" "$breeze_ws"

echo
if [ "$fail" -eq 0 ]; then
    echo "== Summary: all checks OK =="
else
    echo "== Summary: $fail check(s) FAILED =="
fi
[ "$fail" -eq 0 ]
