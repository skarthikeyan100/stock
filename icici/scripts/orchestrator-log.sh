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

set -u
export TZ=Asia/Kolkata

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

LOG_LINK="orchestrator.log"
LOG_DIR="logs"
mkdir -p "$LOG_DIR"

TODAY="$(date +%F)"
TODAY_FILE="$LOG_DIR/orchestrator-$TODAY.log"

touch "$TODAY_FILE"
ln -sfn "$LOG_DIR/orchestrator-$TODAY.log" "$LOG_LINK"

exec tee -a "$TODAY_FILE"
