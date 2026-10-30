#!/usr/bin/env bash
# Attention-only feed for the Claude Code Monitor tool, covering BulkPcr and ContinuousStrategy together.
#
# Runs both compact event feeds and keeps only their "!!!" lines (errors, failures, fail-closed blocks,
# MAX PROFIT / MAX LOSS trips, ALERTs). Routine buy/sell/fill/spawn/target events and BulkPcr's normal
# "Cycle complete" are dropped. Use scripts/strategy-status.sh for the P&L picture.
#
# Also emits one "=== SLOT MISSED" line per slot that BulkPcrAutoStart / NiftyChange did not trade, with the reason.
# A filled buy+sell pair is routine and is NOT notified.
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
        | sed -nuE -e "s/^\[([0-9:]+)\].*(BulkPcrAutoStart|NiftyChange):([^]]*)\] (Missed ([0-9:]{5}) slot.*)/=== SLOT MISSED \1 \2 \3 \5: late - \4/p;t" \
                   -e "s/^\[([0-9:]+)\].*(BulkPcrAutoStart|NiftyChange):([^]]*)\] ([0-9:]{5}):? ?(slot[: ]*)?(.*(skipp|not arming|not trading|not starting|already attempted|already handled).*)/=== SLOT MISSED \1 \2 \3 \4: \6/p" &
    wait
}
