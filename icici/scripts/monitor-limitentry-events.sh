#!/usr/bin/env bash
# Compact event feed of the limit-entry strategies (NiftyChange, Recommendation) for the Claude Code Monitor tool.
#
# One short line per lifecycle event: slot direction/strike, limit buy placed, fills, protection (target/stop) attached, STOP/target hits,
# unfilled entry cancelled, EOD close, finished. Problems (ALERT, failed, UNKNOWN, STOP hit, cancelled unfilled) are prefixed "!!!".
# Per-tick noise does not exist for these two, so the feed is small (a handful of lines per slot).
#
# Usage: scripts/monitor-limitentry-events.sh [--all|--once]   (--all replays the log then follows; --once dumps it and exits)

LOG_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/orchestrator.log"
TAIL_OPTS="-F -n0"
[ "${1:-}" = "--all" ] && TAIL_OPTS="-F -n +1"
READER=(tail $TAIL_OPTS "$LOG_FILE")
[ "${1:-}" = "--once" ] && READER=(cat "$LOG_FILE")

"${READER[@]}" 2>&1 \
  | grep -E --line-buffered '\[(NiftyChange|Recommendation|MomentumAtFixedTime):|exitMonitor triggering squareoff for .* \((NiftyChange|Recommendation|MomentumAtFixedTime)-|\[(NiftyChange|Recommendation|MomentumAtFixedTime)-[^]]*\] Outcome=' \
  | sed -u -E -e 's/^\[([0-9:]{8})\] .*exitMonitor triggering squareoff for ([^ ]+) \((NiftyChange|Recommendation|MomentumAtFixedTime)-[^,]*, ([a-z]+)\): (.*)/[\1] [\3:exit] \4 \2 exit monitor fired: \5/' \
              -e 's/^\[([0-9:]{8})\] .*\[(NiftyChange|Recommendation|MomentumAtFixedTime)-[^]]*\] (Outcome=.*)/[\1] [\2:exit] \3/' \
  | grep -E --line-buffered -v 'SLOT MISSED|process started after it|already (attempted|handled)' \
  | sed -u -E -n 's/^\[([0-9:]{8})\] .*\[(NiftyChange|Recommendation|MomentumAtFixedTime):([^]]*)\] (.*)/\1 \2 \4/p' \
  | sed -u -E -e 's/([0-9]+\.[0-9]{2})[0-9]+/\1/g' \
              -e 's/^([0-9:]{8} [A-Za-z]+ )(.*(ALERT|failed|UNKNOWN|STOP hit|cancelled|cancelling|manual|hit=stopLoss|Outcome=loss).*)/\1!!! \2/' \
              -e 's/^(.{170}).*/\1/'
# No `cut` at the end: it block-buffers when writing to a pipe, so lines never reach the Monitor.
