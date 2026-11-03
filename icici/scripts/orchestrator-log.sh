#!/bin/bash
# Tee stage for `npm run processes`: copies the orchestrator's output into a per-day log file
# under logs/ (append-only - a same-day restart adds to the file, it never truncates it), and
# keeps orchestrator.log as a symlink to today's file so every monitor script that tails
# orchestrator.log keeps working. tail -F follows the symlink when it is retargeted at midnight
# or on the next restart.
#
# Day boundary is Asia/Kolkata (the app's TZ). A process that runs across midnight keeps writing
# the previous day's file; the roll happens on the next restart, as intended.
#
# Migration: a pre-existing regular orchestrator.log (written by the old `tee orchestrator.log`)
# is appended into logs/orchestrator-<its mtime date>.log and removed, so nothing is lost.

set -u
export TZ=Asia/Kolkata

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

LOG_LINK="orchestrator.log"
LOG_DIR="logs"
mkdir -p "$LOG_DIR"

TODAY="$(date +%F)"
TODAY_FILE="$LOG_DIR/orchestrator-$TODAY.log"

# One-time migration of the old truncating file.
if [ -f "$LOG_LINK" ] && [ ! -L "$LOG_LINK" ]; then
    OLD_DAY="$(date -r "$LOG_LINK" +%F)"
    cat "$LOG_LINK" >> "$LOG_DIR/orchestrator-$OLD_DAY.log"
    rm -f "$LOG_LINK"
fi

touch "$TODAY_FILE"
ln -sfn "$LOG_DIR/orchestrator-$TODAY.log" "$LOG_LINK"

exec tee -a "$TODAY_FILE"
