#!/bin/bash
# Checks ANT (AliceBlue) and Kite (Zerodha) session-token validity, plus the
# ANT market-data WebSocket connection state. Read-only: uses each broker's
# trades/positions endpoint as a live token-validity probe (no orders placed).

set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORCH_LOG="$REPO_ROOT/orchestrator.log"

pass=0
fail=0

ok()   { echo "  OK   $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL $1"; fail=$((fail+1)); }

echo "== Session files =="
for f in .ant_session.json .zerodha_session.json; do
    path="$REPO_ROOT/$f"
    if [ -f "$path" ]; then
        mtime=$(date -d "@$(stat -c %Y "$path")" '+%Y-%m-%d %H:%M:%S')
        ok "$f present (last written: $mtime)"
    else
        bad "$f missing"
    fi
done

echo
echo "== Live token validity (via broker API calls) =="

ant_resp=$(curl -s -m 10 "$BASE_URL/ant/trades")
if echo "$ant_resp" | grep -q '"success":true'; then
    ok "ANT session token valid (GET /ant/trades succeeded)"
else
    bad "ANT session token invalid or server unreachable: $ant_resp"
fi

kite_resp=$(curl -s -m 10 "$BASE_URL/kite/positions")
if echo "$kite_resp" | grep -q '"positions"'; then
    ok "Kite/Zerodha session token valid (GET /kite/positions succeeded)"
else
    bad "Kite/Zerodha session token invalid or server unreachable: $kite_resp"
fi

echo
echo "== ANT WebSocket (live market data) connection state =="
if [ -f "$ORCH_LOG" ]; then
    last_connect=$(grep -n "\[AntDataStream\] Connected and streaming" "$ORCH_LOG" | tail -1)
    last_disconnect=$(grep -nE "\[AntDataStream\].*(Disconnected|onerror|onclose)|\[AntWS\].*(Disconnected|closed)" "$ORCH_LOG" | tail -1)
    connect_line=$(echo "$last_connect" | cut -d: -f1)
    disconnect_line=$(echo "$last_disconnect" | cut -d: -f1)

    if [ -z "$connect_line" ]; then
        bad "No 'Connected and streaming' line found in orchestrator.log"
    elif [ -n "$disconnect_line" ] && [ "$disconnect_line" -gt "$connect_line" ]; then
        bad "ANT WS disconnected after its last connect: $last_disconnect"
    else
        ts=$(echo "$last_connect" | grep -oE '\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' | head -1 | tr -d '[]')
        ok "ANT WS connected (last connect: ${ts:-see log}, no disconnect since)"
    fi
else
    bad "orchestrator.log not found at $ORCH_LOG (is the orchestrator running?)"
fi

echo
echo "== Summary: $pass OK, $fail FAIL =="
[ "$fail" -eq 0 ]
