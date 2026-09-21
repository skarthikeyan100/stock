#!/bin/bash
# Parses orchestrator.log for ContinuousStrategy trade lifecycle events and
# prints:
#   1. Capital currently deployed (open legs + resting pending refills)
#   2. Currently open contracts (tabular), with each leg's own price triggers -
#      target (profit exit), next hedge/averaging level, and 5x square-off -
#      exactly as ContinuousStrategy itself computes them (self-monitored,
#      price-based - it has no time-based exit, so "when" here means "at what
#      price", not a clock time). Includes legs restored by reconcile() after
#      a restart (e.g. an overnight NRML position carried into a fresh log
#      with no ENTRY/SPAWN line of its own) - these are picked up from their
#      recurring per-tick "status:" line and labeled "orphan/partial-log"
#      since this log alone can't show their original parent/root lineage.
#   3. A summary of capital/contract-gate blocked attempts (these retry every
#      tick while blocked, so they're counted/collapsed rather than printed
#      one line per tick) - omitted entirely when there are none.
#   4. A parent/child tree (root leg -> its spawned nested legs), which also
#      carries the full chronological trade-lifecycle log per leg (evLine) -
#      no separate flat list.
# No parameters - always reads orchestrator.log from the repo root.
#
# The awk program below is written in plain POSIX awk (no gawk-only 3-arg
# match()/gensub()) because the default `awk` on this box is mawk, not gawk.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORCH_LOG="$REPO_ROOT/orchestrator.log"
CONFIG_YML="$REPO_ROOT/config.yml"

if [ ! -f "$ORCH_LOG" ]; then
    echo "orchestrator.log not found at $ORCH_LOG" >&2
    exit 1
fi

# Best-effort: pull ContinuousStrategy's configured allottedCapital for
# context in the Capital Used section. Not fatal if config.yml is missing or
# shaped differently - the section still prints without it.
ALLOTTED_CAPITAL=""
if [ -f "$CONFIG_YML" ]; then
    ALLOTTED_CAPITAL="$(awk '
        /- type: ContinuousStrategy/ { f = 1; next }
        f && /- type:/ { exit }
        f && /allottedCapital:/ { print $2; exit }
    ' "$CONFIG_YML")"
fi

awk -v allottedCapital="$ALLOTTED_CAPITAL" '
# Only lines carrying the strategys own literal message tag - skips JSON
# state dumps and other log lines that merely mention "ContinuousStrategy"
# without the bracketed tag.
index($0, "[ContinuousStrategy] ") == 0 { next }

{
    ts = "--:--:--"
    if (match($0, /^\[[0-9][0-9]:[0-9][0-9]:[0-9][0-9]\]/)) ts = substr($0, 2, 8)

    tagPos = index($0, "[ContinuousStrategy] ")
    msg = substr($0, tagPos + length("[ContinuousStrategy] "))
    lastTs = ts

    nw = split(msg, w, " ")

    # ---- Per-leg status line: qty=.. avg=.. target=.. nextLevel(N)@P squareOff@P
    # Carries everything needed for "open contracts + when squared off/hedged" -
    # kept out of the flat list (too high-frequency to read one-by-one) but used
    # to populate the Open Contracts section below.
    if (w[2] == "status:" && index(msg, " status: qty=") > 0) {
        tsym = w[1]
        # status: lines fire every tick for whatever is currently in
        # legsByToken, independent of whether this log has an ENTRY/SPAWN/
        # REFILL-FILLED line for it - a leg restored by reconcile() after a
        # restart (see reconcile()s single summary log line, no per-tsym
        # detail) never gets one of those in a fresh log, so without this it
        # would silently vanish from Open Contracts even though it is
        # genuinely still open. Register/open it here too.
        if (!(tsym in seen)) { seen[tsym] = 1; order[++norder] = tsym }
        legOpen[tsym] = 1
        legQty[tsym] = val(w[3])
        legAvg[tsym] = val(w[4])
        legTarget[tsym] = val(w[5])
        nlt = w[6] # e.g. "nextLevel(2)@88.80"
        p1 = index(nlt, "(")
        p2 = index(nlt, ")")
        legNextNum[tsym] = substr(nlt, p1 + 1, p2 - p1 - 1) + 0
        legNextPrice[tsym] = atval(substr(nlt, p2 + 1)) + 0
        legSquareOff[tsym] = atval(w[7]) + 0
        legLastTs[tsym] = ts
        next
    }

    # ---- T1 gate / reconcile chatter - not trade events, drop entirely.
    if (index(msg, "T1 gate:") == 1) next
    if (index(msg, "reconcile:") == 1) next

    # ---- High-frequency capital/contract-gate retries. These fire on every
    # qualifying tick while blocked (see ContinuousStrategy.trySpawnLevel /
    # tryAverageLevel / processNiftyQuote) - collapse into counted buckets
    # instead of one line per tick, or a busy session drowns everything else.
    if (msg ~ /^Level [0-9]+ (spawn|average) (failed|skipped)/) {
        lvl = w[2]; kind = w[3]; outcome = (w[4] == "skipped") ? "skipped" : "failed"
        reason = classifyReason(msg)
        key = kind " L" lvl " " outcome ": " reason
        if (!(key in blockCount)) { blockOrder[++blockN] = key; blockFirst[key] = ts }
        blockCount[key]++
        blockLast[key] = ts
        next
    }
    if (index(msg, "T1 entry skipped - would exceed allotted capital") == 1) {
        key = "T1 entry skipped: capital (allotted capital)"
        if (!(key in blockCount)) { blockOrder[++blockN] = key; blockFirst[key] = ts }
        blockCount[key]++
        blockLast[key] = ts
        next
    }

    type = ""; tsym = ""; detail = ""

    if (index(msg, "T1 entry: ") == 1) {
        type = "ENTRY"; tsym = w[3]
        detail = "qty=" val(w[4]) " price=" val(w[5])
        isRoot[tsym] = 1
        legOpen[tsym] = 1
    } else if (index(msg, "Level ") == 1 && index(msg, " spawn: ") > 0) {
        parent = substr(w[8], 1, length(w[8]) - 1) # strip trailing ")"
        type = "SPAWN L" w[2]; tsym = w[4]
        detail = "qty=" val(w[5]) " price=" val(w[6]) " parent=" parent
        if (!(tsym in parentOf)) parentOf[tsym] = parent
        legOpen[tsym] = 1
    } else if (index(msg, "Level ") == 1 && index(msg, " average: ") > 0) {
        type = "AVERAGE L" w[2]; tsym = w[4]
        detail = "+qty=" val(w[5]) " @ " w[7] " totalQty=" val(w[9]) " avg=" val(w[10])
    } else if (index(msg, "Target hit (") == 1) {
        type = "TARGET HIT"; tsym = w[4]
        detail = "pnl=" val(w[5]) " (" kindOf(w[3]) ")"
        legOpen[tsym] = 0
    } else if (index(msg, "5x square-off (") == 1) {
        type = "5x SQUARE-OFF"; tsym = w[4]
        detail = "pnl=" val(w[5]) " (" kindOf(w[3]) ")"
        legOpen[tsym] = 0
    } else if (index(msg, "Refill placed (") == 1) {
        type = "REFILL PLACED"; tsym = w[4]
        detail = "qty=" val(w[5]) " price=" val(w[6]) " (" kindOf(w[3]) ")"
        pendOpen[tsym] = 1
        pendQty[tsym] = val(w[5])
        pendPrice[tsym] = val(w[6])
        pendKind[tsym] = kindOf(w[3])
    } else if (index(msg, "Refill filled (") == 1) {
        kind = kindOf(w[3])
        type = "REFILL FILLED"; tsym = w[4]
        detail = "qty=" val(w[5]) " entry=" val(w[6]) " (" kind ")"
        if (kind == "root") isRoot[tsym] = 1
        pendOpen[tsym] = 0
        legOpen[tsym] = 1
    } else if (index(msg, "Pending refill at level ") == 1) {
        type = "OTHER"; detail = msg
        pendOpen[w[nw]] = 0
    } else if (index(msg, "Root refill cancelled - LTP drifted") == 1) {
        type = "OTHER"; detail = msg
        pendOpen[w[nw]] = 0
    } else {
        type = "OTHER"; detail = msg
        if (length(detail) > 200) detail = substr(detail, 1, 200) "..."
    }

    if (tsym != "" && !(tsym in seen)) {
        seen[tsym] = 1
        order[++norder] = tsym
    }
    if (tsym != "") {
        k = ++evCount[tsym]
        evLine[tsym, k] = "[" ts "] " type " " detail
    }
}

# Strips a leading "key=" prefix off a token, e.g. "qty=75" -> "75".
function val(tok,    p) {
    p = index(tok, "=")
    return p > 0 ? substr(tok, p + 1) : tok
}

# Strips a leading "key@" prefix off a token, e.g. "squareOff@48.80" -> "48.80".
function atval(tok,    p) {
    p = index(tok, "@")
    return p > 0 ? substr(tok, p + 1) : tok
}

# Strips "(" ... "):" wrapping off a token, e.g. "(root):" -> "root".
function kindOf(tok) {
    return substr(tok, 2, length(tok) - 3)
}

# Buckets a "Level N spawn/average failed: Error: ..." message down to a
# short, stable reason string so thousands of identical retries collapse into
# one counted line instead of flooding the flat list.
function classifyReason(msg,    e) {
    if (index(msg, "reached max investment") > 0) return "capital (max investment)"
    if (index(msg, "allotted capital") > 0) return "capital (allotted capital)"
    if (index(msg, "No NIFTY") > 0 && index(msg, "contract found") > 0) return "no contract at required premium"
    e = index(msg, "Error: ")
    return e > 0 ? substr(msg, e + 7) : msg
}

function label(node,    tag) {
    if (node in isRoot) tag = "root"
    else if (parentOf[node] != "") tag = "nested, parent=" parentOf[node]
    else tag = "orphan/partial-log"
    return node " (" tag ")"
}

function printChildren(node, prefix,    nChild, childOf, total, idx, i, connector, childPrefix, c) {
    nChild = 0
    for (i = 1; i <= norder; i++) {
        c = order[i]
        if (parentOf[c] == node) childOf[++nChild] = c
    }

    total = evCount[node] + nChild
    idx = 0

    for (i = 1; i <= evCount[node]; i++) {
        idx++
        connector = (idx == total) ? "`-- " : "|-- "
        print prefix connector evLine[node, i]
    }
    for (i = 1; i <= nChild; i++) {
        idx++
        connector = (idx == total) ? "`-- " : "|-- "
        childPrefix = prefix ((idx == total) ? "    " : "|   ")
        print prefix connector label(childOf[i])
        printChildren(childOf[i], childPrefix)
    }
}

END {
    # ---- Capital Used ----
    openValue = 0; openCount = 0
    pendValue = 0; pendCount = 0
    for (i = 1; i <= norder; i++) {
        t = order[i]
        if (legOpen[t] == 1) { openValue += legQty[t] * legAvg[t]; openCount++ }
        if (pendOpen[t] == 1) { pendValue += pendQty[t] * pendPrice[t]; pendCount++ }
    }

    print "=== Capital Used ==="
    printf "Open legs:        Rs %-14s (%d leg%s)\n", sprintf("%.2f", openValue), openCount, (openCount == 1 ? "" : "s")
    printf "Pending refills:  Rs %-14s (%d order%s)\n", sprintf("%.2f", pendValue), pendCount, (pendCount == 1 ? "" : "s")
    printf "Total deployed:   Rs %.2f\n", openValue + pendValue
    if (allottedCapital != "") printf "Allotted capital: Rs %s (config.yml ContinuousStrategy.allottedCapital)\n", allottedCapital
    print ""

    # ---- Open Contracts ----
    print "=== Open Contracts (price triggers - this strategy has no time-based exit) ==="
    if (openCount == 0) {
        print "(no open legs)"
    } else {
        printf "%-20s  %-6s  %-16s  %5s  %8s  %8s  %8s  %-12s  %9s\n", "CONTRACT", "KIND", "PARENT", "QTY", "AVG", "AS OF", "TARGET", "NEXT HEDGE", "5X SQ-OFF"
        for (i = 1; i <= norder; i++) {
            t = order[i]
            if (legOpen[t] != 1) continue
            kind = (t in isRoot) ? "root" : (parentOf[t] != "" ? "nested" : "orphan")
            parent = (parentOf[t] != "") ? parentOf[t] : "-"
            nextHedge = (legNextNum[t] <= 4) ? sprintf("L%d@%.2f", legNextNum[t], legNextPrice[t]) : "none"
            printf "%-20s  %-6s  %-16s  %5s  %8.2f  %8s  %8.2f  %-12s  %9.2f\n", t, kind, parent, legQty[t], legAvg[t]+0, legLastTs[t], legTarget[t]+0, nextHedge, legSquareOff[t]+0
        }
    }
    if (pendCount > 0) {
        print ""
        print "Pending refills (resting limit orders, not yet filled):"
        for (i = 1; i <= norder; i++) {
            t = order[i]
            if (pendOpen[t] != 1) continue
            printf "    %s  qty=%s  limit=%s  (%s)\n", t, pendQty[t], pendPrice[t], pendKind[t]
        }
    }
    print ""

    # ---- Blocked/retried attempts summary (omitted entirely when empty) ----
    if (blockN > 0) {
        print "=== Blocked / Retried Attempts (capital or contract gate, counted not listed) ==="
        for (i = 1; i <= blockN; i++) {
            key = blockOrder[i]
            printf "%-55s  %5dx  %s - %s\n", key, blockCount[key], blockFirst[key], blockLast[key]
        }
        print ""
    }
    print "=== ContinuousStrategy Trade Tree ==="
    if (norder == 0) {
        print "(no trades to display)"
        exit
    }
    for (r = 1; r <= norder; r++) {
        node = order[r]
        if (parentOf[node] == "") {
            print label(node)
            printChildren(node, "")
            print ""
        }
    }
}
' "$ORCH_LOG"
