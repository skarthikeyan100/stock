#!/usr/bin/env bash
# Compact BulkPcr event feed for the Claude Code Monitor tool.
#
# One short line (<= ~110 chars) per order event, so a burst of three brokers fits in a single
# notification instead of being truncated: buy placed, buy filled, sell placed, sell filled, hedge /
# re-buy, slot armed/skipped, PCR direction, loss stop, cycle complete, and failures.
# (scripts/monitor-bulkpcr.sh is the verbose human-terminal narrator; this one is for the Monitor tool.)
#
# Usage: scripts/monitor-bulkpcr-events.sh [--all|--once]   (--all replays the log then follows; --once dumps it and exits)
# GNU sed (\U) and tail -F: follows across the truncate-in-place orchestrator.log gets on restart.

LOG_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/orchestrator.log"
TAIL_OPTS="-F -n0"
[ "${1:-}" = "--all" ] && TAIL_OPTS="-F -n +1"
READER=(tail $TAIL_OPTS "$LOG_FILE")
[ "${1:-}" = "--once" ] && READER=(cat "$LOG_FILE")   # dump existing log through the formatter and exit (for testing)

"${READER[@]}" 2>&1 | sed -u -E -n '
# --- buy placed (one shape per broker) ---
s/^\[([0-9:]{8})\] .*Buying (\S+) qty=([0-9]+) for \S+ via ANT regular order \(ltp=([0-9.]+) limit=([0-9.]+)\).*/\1 ANT     BUY  placed \2 qty=\3 limit=\5/p;t
s/^\[([0-9:]{8})\] .*Buying (\S+) qty=([0-9]+) @ ([0-9.]+) \(limit.*via Breeze.*/\1 BREEZE  BUY  placed \2 qty=\3 limit=\4/p;t
s/^\[([0-9:]{8})\] .*Buying (\S+) qty=([0-9]+) for \S+ \(BrokerExecutor\.buy\).*/\1 ZERODHA BUY  placed \2 qty=\3/p;t
# --- buy filled ---
s/^\[([0-9:]{8})\] .*\[(ant|zerodha|breeze)\] Entry complete: (\S+) qty=([0-9]+) avg=([0-9.]+).*/\1 \U\2\E BUY  FILLED \3 qty=\4 @\5/p;t
# --- sell placed ---
s/^\[([0-9:]{8})\] .*\[(ant|zerodha|breeze)\] Placing resting limit sell for (\S+) qty=([0-9]+) @ ([0-9.]+).*/\1 \U\2\E SELL placed \3 qty=\4 @\5/p;t
# --- sell filled ---
s/^\[([0-9:]{8})\] .*\[(ant|zerodha|breeze)\] Exit fill: (\S+) qty=([0-9]+) @ ([0-9.]+).*/\1 \U\2\E SELL FILLED \3 qty=\4 @\5/p;t
# --- hedge / re-buy of the opposite side ---
s/^\[([0-9:]{8})\] .*\[(ant|zerodha|breeze)\] (\w+) \+2 filled while (\w+) is still open - re-buying.*/\1 \U\2\E HEDGE re-buy \3 (\4 still open)/p;t
# --- direction + slots ---
s/^\[([0-9:]{8})\] .*PCR=([0-9.]+) .*resolved direction (\w+).*/\1 PCR=\2 -> \3/p;t
s/^\[([0-9:]{8})\] .*AutoStart:[^]]*\] ([0-9:]{5}) slot: armed .*brokers=(\[[^]]*\]).*/\1 SLOT \2 armed \3/p;t
s/^\[([0-9:]{8})\] .*AutoStart:[^]]*\] Missed ([0-9:]{5}) slot.*/\1 SLOT \2 MISSED (late)/p;t
s/^\[([0-9:]{8})\] .*AutoStart:[^]]*\] ([0-9:]{5}) slot: .*(already running|loss-stopped|STUCK).*/\1 SLOT \2 skipped: \3/p;t
# --- terminal / failure states (message trimmed) ---
s/^\[([0-9:]{8})\] (\[[^]]*\] )*(.*(Cycle complete|MAX LOSS TRIPPED|loss stop tripped|Chunked entry failed|Entry retry also filled nothing|Chunked limit-sell placement failed|ALERT|manual review|Unhandled|TypeError|ReferenceError|WebSocket closed).*)/\1 !!! \3/p;t
'  | sed -u -E 's/([0-9]+\.[0-9]{2})[0-9]+/\1/g' | cut -c1-150
