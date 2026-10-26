#!/bin/bash
# Refreshes every broker's local contract/symbol master in one pass: ANT
# (AliceBlue), Kite (Kite), Breeze (ICICI Direct), and Prism (Shoonya).
# Each is the known-stale-prone file behind that broker's option/expiry
# resolution - see CLAUDE.md's "Data Files" section and AntContractMaster's
# own STALE_THRESHOLD_MS warning. Confirmed live 2026-10-13: a 57-day-old
# data/ant/NFO_contract.json was missing that week's NIFTY expiry entirely,
# which silently routed every BulkPcrStrategy order into a 2-week-out
# contract instead of the intended near-week one.
#
# Replaces each existing master file in place. A timestamped backup of the
# previous file is kept alongside (not deleted) so a bad download can be
# rolled back by hand; nothing here does that automatically.
#
# Public endpoints only - no broker session/auth token needed for any of
# the four downloads below.
set -u
set -o pipefail

MIN_LINES=1000 # a real master has far more rows; fewer means an empty/HTML/truncated download

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
fail=0

backup() {
    # $1 = file to back up, if it exists
    local f="$1"
    [ -f "$f" ] || return 0
    # keep only the most recent backup: drop older ones before writing the new one
    rm -f "$f".bak-*
    cp "$f" "$f.bak-$STAMP"
}

echo "=== ANT (AliceBlue) ==="
ANT_DIR="$REPO_ROOT/data/ant"
mkdir -p "$ANT_DIR"
TMP_ANT="$(mktemp -d)"
if curl -sf "https://v2api.aliceblueonline.com/restpy/static/contract_master/V2/NFO.csv" -o "$TMP_ANT/NFO.csv" \
    && curl -sf "https://v2api.aliceblueonline.com/restpy/static/contract_master/V2/BFO.csv" -o "$TMP_ANT/BFO.csv"; then
    # Convert into the temp dir first; only a validated pair replaces the live files.
    if node "$SCRIPT_DIR/ant-master-to-json.js" "$TMP_ANT/NFO.csv" "$TMP_ANT/NFO_contract.json" NFO \
        && node "$SCRIPT_DIR/ant-master-to-json.js" "$TMP_ANT/BFO.csv" "$TMP_ANT/BFO_contract.json" BFO \
        && node -e "for (const [f,k] of [['$TMP_ANT/NFO_contract.json','NFO'],['$TMP_ANT/BFO_contract.json','BFO']]) { const j = JSON.parse(require('fs').readFileSync(f,'utf8')); if (!Array.isArray(j[k]) || j[k].length < 100) process.exit(1); }"; then
        backup "$ANT_DIR/NFO_contract.json"
        backup "$ANT_DIR/BFO_contract.json"
        mv "$TMP_ANT/NFO_contract.json" "$ANT_DIR/NFO_contract.json"
        mv "$TMP_ANT/BFO_contract.json" "$ANT_DIR/BFO_contract.json"
    else
        echo "[download-all-masters] ANT conversion/validation failed - leaving existing files untouched" >&2
        fail=$((fail + 1))
    fi
else
    echo "[download-all-masters] ANT download failed - leaving existing files untouched" >&2
    fail=$((fail + 1))
fi
rm -rf "$TMP_ANT"

echo "=== Kite (Kite) ==="
KITE_DIR="$REPO_ROOT/data/kite"
mkdir -p "$KITE_DIR"
for SEGMENT in NFO BFO; do
    DEST="$KITE_DIR/${SEGMENT}_instruments.csv"
    TMP="$(mktemp)"
    if curl -sf "https://api.kite.trade/instruments/$SEGMENT" -o "$TMP" && [ "$(wc -l < "$TMP")" -ge "$MIN_LINES" ] && head -1 "$TMP" | grep -q '^instrument_token'; then
        backup "$DEST"
        mv "$TMP" "$DEST"
        echo "Downloaded $(wc -l < "$DEST") lines to $DEST"
    else
        echo "[download-all-masters] Kite $SEGMENT download failed or looked invalid - leaving existing file untouched" >&2
        rm -f "$TMP"
        fail=$((fail + 1))
    fi
done

echo "=== Breeze (ICICI Direct) ==="
BREEZE_DIR="$REPO_ROOT/data/breeze"
mkdir -p "$BREEZE_DIR"
TMP_ZIP="$(mktemp --suffix=.zip)"
if curl -sf "https://directlink.icicidirect.com/NewSecurityMaster/SecurityMaster.zip" -o "$TMP_ZIP"; then
    # Unzip into a temp dir and validate BEFORE touching the live files.
    TMP_BREEZE="$(mktemp -d)"
    if unzip -o "$TMP_ZIP" -d "$TMP_BREEZE" >/dev/null && ls "$TMP_BREEZE"/*.txt >/dev/null 2>&1 \
        && [ -z "$(find "$TMP_BREEZE" -name '*.txt' -size -1k)" ]; then
        for f in "$BREEZE_DIR"/*.txt; do
            [ -f "$f" ] && backup "$f"
        done
        backup "$BREEZE_DIR/SecurityMaster.zip"
        mv "$TMP_ZIP" "$BREEZE_DIR/SecurityMaster.zip"
        cp -f "$TMP_BREEZE"/*.txt "$BREEZE_DIR"/
        echo "Breeze SecurityMaster downloaded and extracted to $BREEZE_DIR"
    else
        echo "[download-all-masters] Breeze zip invalid (unzip failed, no .txt files, or an empty one) - leaving existing files untouched" >&2
        rm -f "$TMP_ZIP"
        fail=$((fail + 1))
    fi
    rm -rf "$TMP_BREEZE"
else
    echo "[download-all-masters] Breeze download failed - leaving existing files untouched" >&2
    rm -f "$TMP_ZIP"
    fail=$((fail + 1))
fi

echo "=== Prism (Shoonya) ==="
PRISM_DIR="$REPO_ROOT/data/prism"
mkdir -p "$PRISM_DIR"
for SEGMENT in NFO BFO; do
    DEST="$PRISM_DIR/${SEGMENT}_symbols.txt"
    TMP_ZIP="$(mktemp --suffix=.zip)"
    TMP_DIR="$(mktemp -d)"
    if curl -sf "https://api.shoonya.com/${SEGMENT}_symbols.txt.zip" -o "$TMP_ZIP"; then
        unzip -o "$TMP_ZIP" -d "$TMP_DIR" >/dev/null
        if [ -f "$TMP_DIR/${SEGMENT}_symbols.txt" ] && [ "$(wc -l < "$TMP_DIR/${SEGMENT}_symbols.txt")" -ge "$MIN_LINES" ]; then
            backup "$DEST"
            mv "$TMP_DIR/${SEGMENT}_symbols.txt" "$DEST"
            echo "Downloaded $(wc -l < "$DEST") lines to $DEST"
        else
            echo "[download-all-masters] Shoonya zip did not contain a valid ${SEGMENT}_symbols.txt - leaving existing file untouched" >&2
            fail=$((fail + 1))
        fi
    else
        echo "[download-all-masters] Prism/Shoonya $SEGMENT download failed - leaving existing file untouched" >&2
        fail=$((fail + 1))
    fi
    rm -rf "$TMP_ZIP" "$TMP_DIR"
done

echo "=== Done (failures: $fail) ==="

# Every contract-master cache above (AntContractMaster, KiteContractMaster,
# BreezeContractMaster, Prism.cacheFile) is loaded once and cached in-memory
# per process - a running order/strategies process will NOT pick up these new
# files until it restarts (e.g. `npm run processes` again, or let tsc-watch's
# hot-restart happen on the next code change). Restart manually if you need
# the refreshed data live immediately.
exit $fail
