#!/usr/bin/env bash
# Attention-only feed for the Claude Code Monitor tool, covering BulkPcr and ContinuousStrategy together.
#
# Runs both compact event feeds and keeps only their "!!!" lines (errors, failures, fail-closed blocks,
# MAX PROFIT / MAX LOSS trips, ALERTs). Routine buy/sell/fill/spawn/target events and BulkPcr's normal
# "Cycle complete" are dropped. Use scripts/strategy-status.sh for the P&L picture.
#
# Usage: scripts/monitor-strategies-alerts.sh [--all|--once]   (passed through to both feeds)

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trap 'kill $(jobs -p) 2>/dev/null' EXIT
{
    "$DIR/monitor-bulkpcr-events.sh" "$@" &
    "$DIR/monitor-continuous-events.sh" "$@" &
    wait
} | grep -E --line-buffered '!!!' | grep -E --line-buffered -v 'Cycle complete'
