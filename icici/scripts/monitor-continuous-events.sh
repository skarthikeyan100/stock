#!/usr/bin/env bash
# Compact ContinuousStrategy event feed for the Claude Code Monitor tool.
#
# One short line (<= ~150 chars) per lifecycle event: PCR/momentum direction, T1 entry, hedge spawn,
# average-in, target hit, 5x square-off, refill placed/filled, max-profit/max-loss trips, and failures.
# Per-tick noise is dropped: "status:" lines, "T1 gate:" lines, reconcile chatter, and the
# "Level N spawn/average failed|skipped" capital/contract-gate retries (those repeat on every tick while blocked).
# For the full tree / open contracts / capital view use scripts/continuous-strategy-trades.sh.
#
# Usage: scripts/monitor-continuous-events.sh [--all|--once]   (--all replays the log then follows; --once dumps it and exits)
# tail -F follows across the truncate-in-place orchestrator.log gets on restart.

LOG_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/orchestrator.log"
TAIL_OPTS="-F -n0"
[ "${1:-}" = "--all" ] && TAIL_OPTS="-F -n +1"
READER=(tail $TAIL_OPTS "$LOG_FILE")
[ "${1:-}" = "--once" ] && READER=(cat "$LOG_FILE")

# Order matters: drop the noisy lines first, then keep the events and failure signatures.
"${READER[@]}" 2>&1 \
  | grep -E --line-buffered 'ContinuousStrategy\]|MAX (PROFIT|LOSS) TRIPPED|LegManager' \
  | grep -E --line-buffered -v ' status: qty=|T1 gate:|reconcile: order query attempt|Level [0-9]+ (spawn|average) (failed|skipped)|T1 entry skipped - would exceed allotted capital' \
  | sed -u -E -n '
s/^\[([0-9:]{8})\] .*ContinuousStrategy\] (.*)/\1 \2/p;t
s/^\[([0-9:]{8})\] .*(MAX (PROFIT|LOSS) TRIPPED.*)/\1 !!! \2/p;t
' \
  | sed -u -E -e 's/([0-9]+\.[0-9]{2})[0-9]+/\1/g' \
            -e 's/^([0-9:]{8}) (.*(failed|Error|blocking|TRIPPED|fail-closed|exhausted).*)/\1 !!! \2/' \
            -e 's/^(.{150}).*/\1/'
# No `cut` at the end: it block-buffers when writing to a pipe, so lines never reach the Monitor.
