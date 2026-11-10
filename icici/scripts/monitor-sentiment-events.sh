#!/usr/bin/env bash
# Compact SentimentStrategy event feed for the Claude Code Monitor tool.
#
# One line per lifecycle event: entry trigger (buy index), contract price after each buy, sell at target, and failures.
# Lines that signal a problem are prefixed "!!!" (buy failed, outcome unknown, ALERT).
#
# Usage: scripts/monitor-sentiment-events.sh [--all|--once]   (--all replays the log then follows; --once dumps it and exits)
# tail -F follows the symlink retarget that scripts/orchestrator-log.sh makes on restart/new day.

LOG_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/orchestrator.log"
TAIL_OPTS="-F -n0"
[ "${1:-}" = "--all" ] && TAIL_OPTS="-F -n +1"
READER=(tail $TAIL_OPTS "$LOG_FILE")
[ "${1:-}" = "--once" ] && READER=(cat "$LOG_FILE")

"${READER[@]}" 2>&1 \
  | grep -E --line-buffered 'SentimentStrategy' \
  | grep -E --line-buffered 'Initiate buy index|Response|sell contract|After Sell Trade|buy_?[Ii]ndex failed|entry outcome unknown|ALERT|price: |Error|failed' \
  | sed -u -E -n '
s/^\[([0-9:]{8})\] .*(\[SentimentStrategy\] (buyIndex failed.*|ALERT.*entry outcome unknown.*))/\1 !!! \2/p;t
s/^\[([0-9:]{8})\] .*(ALERT.*)/\1 !!! \2/p;t
s/^\[([0-9:]{8})\] .*(SentimentStrategy: sell contract.*)/\1 \2/p;t
s/^\[([0-9:]{8})\] .*(Initiate buy index.*)/\1 \2/p;t
s/^\[([0-9:]{8})\] .*(After Sell Trade.*)/\1 \2/p;t
s/^\[([0-9:]{8})\] .*( price: .*buyAt.*)/\1 \2/p;t
' \
  | sed -u -E -e 's/([0-9]+\.[0-9]{2})[0-9]+/\1/g' -e 's/^(.{150}).*/\1/'
