#!/usr/bin/env bash
# Attention-only feed for the Claude Code Monitor tool, covering BulkPcr and ContinuousStrategy together.
#
# Runs both compact event feeds and keeps only their "!!!" lines (errors, failures, fail-closed blocks,
# MAX PROFIT / MAX LOSS trips, ALERTs). Routine buy/sell/fill/spawn/target events and BulkPcr's normal
# "Cycle complete" are dropped. Use scripts/strategy-status.sh for the P&L picture.
#
# Also emits one "=== PAIR FILLED" line per completed buy+sell pair (the order process's
# "User '<x>' closed. P&L" line) for BulkPcr / Continuous users - a one-sided order never produces it.
#
# Usage: scripts/monitor-strategies-alerts.sh [--all|--once]   (passed through to both feeds)

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trap 'kill $(jobs -p) 2>/dev/null' EXIT
LOG_FILE="$DIR/../orchestrator.log"
READER=(tail -n0 -F "$LOG_FILE")
[ "${1:-}" = "--once" ] && READER=(cat "$LOG_FILE")
{
    {
        "$DIR/monitor-bulkpcr-events.sh" "$@" &
        "$DIR/monitor-continuous-events.sh" "$@" &
        wait
    } | grep -E --line-buffered '!!!' | grep -E --line-buffered -v 'Cycle complete' &
    "${READER[@]}" 2>/dev/null \
        | sed -nuE "s/^\[([0-9:]+)\].*User '((BulkPcr|Continuous)[^']*)' closed\. P&L: ([-0-9.]+), Cumulative: ([-0-9.]+).*/=== PAIR FILLED \1 \2: buy+sell closed, P\&L \4 (cumulative \5)/p" &
    wait
}
