#!/usr/bin/env bash
# Standalone GapStrategy activity monitor.
#
# Tails orchestrator.log and prints short, human-readable status lines for
# GapStrategy's one-trade-per-day flow (gap check, PCR alignment, entry,
# live tick P&L, exit) - the same narration a person would give while
# watching the log by hand. Pure bash/awk, no Node/tsc build, no network
# calls, no LLM involved - runs forever in a terminal at zero ongoing cost.
# Reads orchestrator.log only, never touches source code.
#
# Unlike BulkPcrStrategy (which logs everything from inside its own class -
# see monitor-bulkpcr.sh), GapStrategy's flow is spread across several
# actors (Zerodha's GTT placement, OrderBookkeeping's fill events,
# pollGttFills' poll-detected close) that don't all mention "GapStrategy" by
# name. This script tracks the currently-held contract symbol (captured from
# the "Buying <tsym> qty=... for GapStrategy" line every broker executor
# logs identically, cleared once GapStrategy's own "Sell confirmed" line
# fires) and also shows any other actor's line that mentions that same
# contract symbol, so the GTT placement/fill lines show up too.
#
# Written for the default `awk` on this box (mawk), not gawk-only features -
# same constraint as scripts/monitor-bulkpcr.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$REPO_ROOT/orchestrator.log"

if [ ! -f "$LOG_FILE" ]; then
    echo "orchestrator.log not found at $LOG_FILE - is 'npm run processes' running?" >&2
    exit 1
fi

# Default: only new activity from now on. Pass --all/-a to first replay
# everything already in the log (through the same formatter) before
# following new lines.
TAIL_OPTS="-F -n0"
if [ "${1:-}" = "--all" ] || [ "${1:-}" = "-a" ] || [ "${1:-}" = "-all" ]; then
    TAIL_OPTS="-F -n +1"
    echo "Replaying all existing GapStrategy activity in $LOG_FILE, then following..."
else
    echo "Watching $LOG_FILE for GapStrategy activity... (Ctrl-C to stop)"
fi
echo "(orchestrator.log is truncated on every process restart - this keeps following it)"
echo

# -F: keep following across the truncate-in-place that 'tee orchestrator.log'
# (no -a) does on every orchestrator restart. -n0: only new lines from now on
# (-n +1 with --all: replay the whole file first).
# -W interactive (mawk-specific, matches the box's default /usr/bin/awk): without
# it, mawk block-buffers stdin reads from a pipe and can sit on a fully-flushed
# tail line indefinitely instead of processing it - confirmed live for
# monitor-bulkpcr.sh, not optional here either. fflush() calls kept as
# defense-in-depth on the output side.
tail $TAIL_OPTS "$LOG_FILE" | awk -W interactive '
    {
        raw = $0
        line = raw

        # --- extract "[HH:MM:SS]" timestamp -----------------------------
        ts = "??:??:??"
        if (substr(line, 1, 1) == "[") {
            close_b = index(line, "] ")
            if (close_b > 0) {
                ts = substr(line, 2, close_b - 2)
                line = substr(line, close_b + 2)
            }
        }

        # --- extract "[Class.method]" call-site tag ----------------------
        callsite = ""
        if (substr(line, 1, 1) == "[") {
            close_b = index(line, "] ")
            if (close_b > 0) {
                callsite = substr(line, 2, close_b - 2)
                line = substr(line, close_b + 2)
            }
        }

        # Bare continuation lines from a multi-line JSON.stringify dump
        # (Log.log only prefixes "[HH:MM:SS] [Class.method]" on the first
        # line of a pretty-printed object - e.g. a full config.yml dump on
        # startup) have neither a real timestamp nor a callsite, but can
        # still contain the literal text "GapStrategy" (e.g. a config entry
        # `"type": "GapStrategy",`) - skip these, they are not real events.
        if (ts == "??:??:??" && callsite == "") next

        # ---------------- decide relevance -------------------------------
        is_gap_own = (index(callsite, "GapStrategy.") == 1 || index(callsite, "GapContract.") == 1)
        mentions_gap = (index(raw, "GapStrategy") > 0)

        relevant = 0
        if (is_gap_own) relevant = 1
        if (mentions_gap) relevant = 1
        if (contract != "" && index(raw, contract) > 0) relevant = 1
        if (expect_gtt_id && callsite == "Zerodha.placeTargetStopLossGTT") relevant = 1

        if (!relevant) next

        # --- drop a leading "[Gap] " / "[GapStrategy] " message tag ------
        if (substr(line, 1, 6) == "[Gap] ") line = substr(line, 7)
        else if (substr(line, 1, 14) == "[GapStrategy] ") line = substr(line, 15)

        # --- pull out any remaining short leading "[tag] " (broker/order) -
        btag = ""
        if (substr(line, 1, 1) == "[") {
            close_b = index(line, "] ")
            if (close_b > 0 && close_b <= 12) {
                btag = "[" substr(line, 2, close_b - 2) "] "
                line = substr(line, close_b + 2)
            }
        }

        # --- capture the held contract once GapStrategy announces a buy --
        # ("Buying <tsym> qty=<n> for GapStrategy [via <broker>...]" - this
        # exact prefix is logged identically by every broker executor.)
        if (index(line, "Buying ") == 1 && index(line, " for GapStrategy") > 0) {
            rest = substr(line, length("Buying ") + 1)
            sp = index(rest, " ")
            if (sp > 0) contract = substr(rest, 1, sp - 1)
        }

        # --- GTT trigger_id bookkeeping (that line never mentions tsym) --
        if (index(line, "Placing GTT OCO for") == 1) expect_gtt_id = 1
        else if (callsite == "Zerodha.placeTargetStopLossGTT" && index(line, "GTT placed:") == 1) expect_gtt_id = 0

        # --- skip noisy/redundant lines -----------------------------------
        if (callsite == "OrderBookkeeping._processTradeEvent") {
            if (index(line, "Buy ") == 1) next                        # already announced via Filled/Bought above
            if (index(line, "Sell ") == 1 && index(line, "qty=0 ") > 0) next   # zero-qty settlement echo
        }

        # --- clear the held contract once GapStrategy confirms the close -
        clear_after = 0
        if (callsite == "GapContract.updateTrade" && index(line, "Sell confirmed") == 1) clear_after = 1

        # ---------------- formatting ---------------------------------------
        if (index(line, "TRIGGERED:") == 1 || index(line, "executeTrade failed") == 1 ||
            index(line, "Sell confirmed") == 1 || index(line, "Outcome=") == 1 ||
            index(line, "GTT poll:") == 1 || index(line, "Decision:") == 1 ||
            (index(line, "Selling ") == 1 && index(line, "TIMEOUT") > 0)) {
            print ts "  *** " btag line " ***"
        } else {
            print ts "  " btag line
        }
        fflush()

        if (clear_after) contract = ""
    }
'
