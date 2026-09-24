#!/usr/bin/env bash
# Standalone BulkPcrStrategy activity monitor.
#
# Tails orchestrator.log and prints short, human-readable status lines for
# BulkPcrStrategy events (entry, fills, exits, errors, reconcile) - the same
# narration a person would give while watching the log by hand. Pure
# bash/awk, no Node/tsc build, no network calls, no LLM involved - runs
# forever in a terminal at zero ongoing cost. Reads orchestrator.log only,
# never touches source code.
#
# Written for the default `awk` on this box (mawk), not gawk-only features -
# same constraint as scripts/continuous-strategy-trades.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$REPO_ROOT/orchestrator.log"

if [ ! -f "$LOG_FILE" ]; then
    echo "orchestrator.log not found at $LOG_FILE - is 'npm run processes' running?" >&2
    exit 1
fi

# Default: only new activity from now on (like the Monitor-tool tailing used
# live this session). Pass --all/-a to first replay everything already in
# the log (through the same formatter) before following new lines.
TAIL_OPTS="-F -n0"
if [ "${1:-}" = "--all" ] || [ "${1:-}" = "-a" ] || [ "${1:-}" = "-all" ]; then
    TAIL_OPTS="-F -n +1"
    echo "Replaying all existing BulkPcrStrategy activity in $LOG_FILE, then following..."
else
    echo "Watching $LOG_FILE for BulkPcrStrategy activity... (Ctrl-C to stop)"
fi
echo "(orchestrator.log is truncated on every process restart - this keeps following it)"
echo

# -F: keep following across the truncate-in-place that 'tee orchestrator.log'
# (no -a) does on every orchestrator restart. -n0: only new lines from now on
# (-n +1 with --all: replay the whole file first).
# -W interactive (mawk-specific, matches the box's default /usr/bin/awk): without
# it, mawk block-buffers stdin reads from a pipe and can sit on a fully-flushed
# tail line indefinitely instead of processing it - confirmed live, this is not
# optional. fflush() calls below are kept as defense-in-depth on the output side.
tail $TAIL_OPTS "$LOG_FILE" | awk -W interactive '
    # Only lines logged from inside BulkPcrStrategy itself - matches on the
    # [Class.method] call-site tag Log.log adds, so it also catches the one
    # "reset" line that does not repeat "[BulkPcrStrategy]" in its own message text.
    index($0, "[BulkPcrStrategy.") == 0 { next }

    {
        line = $0

        # --- extract "[HH:MM:SS]" timestamp -----------------------------
        ts = "??:??:??"
        if (substr(line, 1, 1) == "[") {
            close_b = index(line, "] ")
            if (close_b > 0) {
                ts = substr(line, 2, close_b - 2)
                line = substr(line, close_b + 2)
            }
        }

        # --- drop the "[Class.method]" call-site tag --------------------
        if (substr(line, 1, 1) == "[") {
            close_b = index(line, "] ")
            if (close_b > 0) line = substr(line, close_b + 2)
        }

        # --- drop a redundant literal "[BulkPcrStrategy] " prefix -------
        prefix = "[BulkPcrStrategy] "
        if (substr(line, 1, length(prefix)) == prefix) {
            line = substr(line, length(prefix) + 1)
        }

        # --- pull out a leading "[broker] " tag, if present -------------
        broker = ""
        if (substr(line, 1, 1) == "[") {
            close_b = index(line, "] ")
            if (close_b > 0 && close_b <= 12) {
                broker = substr(line, 2, close_b - 2)
                line = substr(line, close_b + 2)
            }
        }
        btag = (broker != "") ? "[" broker "] " : ""

        # ---------------- gate messages: dedupe on state change ---------
        if (substr(line, 1, 6) == "gate: ") {
            reason = substr(line, 7)
            if (reason == last_gate) next
            last_gate = reason
            if (reason == "gates clear - attempting entry") {
                print ts "  BulkPcrStrategy: gates clear, evaluating entry"
            } else if (index(reason, "phase=") > 0) {
                print ts "  BulkPcrStrategy: " reason
            } else {
                print ts "  BulkPcrStrategy: waiting (" reason ")"
            }
            fflush()
            next
        }

        # ---------------- reconcile IPC-connect retries: dedupe ---------
        if (index(line, "reconcile: order query attempt ") == 1) {
            if (retry_seen) next
            retry_seen = 1
            print ts "  Reconcile: waiting for order process..."
            fflush()
            next
        }
        if (index(line, "reconcile: order query exhausted retries") == 1 || index(btag line, "reconcile: order query exhausted retries") > 0) {
            print ts "  *** RECONCILE FAILED - failing closed *** " btag
            fflush()
            next
        }

        # ---------------- the rest: light rewording, pass-through -------
        gsub(/-> resolved direction/, "-> direction:", line)

        if (index(line, "Chunked entry failed") == 1 || index(line, "Chunked limit-sell placement failed") == 1) {
            print ts "  *** " btag line " ***"
        } else if (index(line, "Entry complete:") == 1) {
            sub(/^Entry complete:/, "BUY filled:", line)
            print ts "  " btag line
        } else if (index(line, "Exit complete:") == 1) {
            print ts "  " btag "EXIT COMPLETE: " substr(line, length("Exit complete: ") + 1)
        } else if (index(line, "Exit fill:") == 1) {
            sub(/^Exit fill:/, "SELL fill:", line)
            print ts "  " btag line
        } else if (index(line, "Cycle complete on every configured broker") == 1) {
            print ts "  *** CYCLE COMPLETE on all brokers - strategy durably disabled ***"
        } else if (index(line, "reconcile: last run ended in") == 1) {
            print ts "  *** " btag line " ***"
        } else {
            print ts "  " btag line
        }
        fflush()
    }
'
