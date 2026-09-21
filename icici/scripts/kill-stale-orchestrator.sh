#!/bin/bash
# Kills any already-running orchestrator instance (and its data/order/strategies/frontend
# children, via process-group signal) before a new one starts. Prevents two live trading
# processes running concurrently. No-op if nothing is running.
#
# Pattern is anchored to "^node" (real node process only) rather than a plain substring
# match: when this script runs as the first step of "npm run processes", the *outer*
# shell executing that whole script string literally contains "node ./dist/orchestrator.js"
# later in its own command line (inside the not-yet-reached concurrently/sh -c argument) -
# an unanchored pgrep would match that ancestor shell and kill it, aborting the very
# startup this script is meant to protect. Anchoring to processes whose cmdline actually
# *starts* with "node" excludes shell wrappers that merely mention the text.

set -u

PIDS=$(pgrep -f "^node .*dist/orchestrator\.js" || true)

if [ -n "$PIDS" ]; then
    echo "[kill-stale-orchestrator] Found existing orchestrator process(es): $PIDS — stopping before starting a new one."
    for pid in $PIDS; do
        pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
        if [ -n "$pgid" ]; then
            kill -TERM -"$pgid" 2>/dev/null || true
        fi
    done

    sleep 2

    PIDS=$(pgrep -f "^node .*dist/orchestrator\.js" || true)
    if [ -n "$PIDS" ]; then
        echo "[kill-stale-orchestrator] Still alive after SIGTERM, force-killing: $PIDS"
        for pid in $PIDS; do
            pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
            [ -n "$pgid" ] && kill -KILL -"$pgid" 2>/dev/null || true
        done
    fi
fi

exit 0
