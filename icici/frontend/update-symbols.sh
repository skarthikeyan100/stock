#!/bin/bash
# Regenerates the frontend's canonical-symbol dropdown list from the locally
# downloaded Kite instrument master (run scripts/download-all-masters.sh
# first, and periodically to refresh - this script never calls the network).
# Emits one canonical SYMBOL_STRIKE_CE|PE line per contract that still has at
# least one non-expired listing - the specific (nearest) expiry is resolved
# later, at order time, by KiteContractMaster.findNearestExpiryOption; the
# frontend never sees or chooses a date (see src/model/CanonicalSymbol.ts).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" # output path (public/symbols.txt) is relative to this script, like the inputs
DATA_DIR="$SCRIPT_DIR/../data/kite"
TODAY=$(date +%Y-%m-%d)

# Check every input BEFORE touching the output, and build into a temp file that only replaces symbols.txt on success.
for SEGMENT in NFO BFO; do
  if [ ! -f "$DATA_DIR/${SEGMENT}_instruments.csv" ]; then
    echo "Error: $DATA_DIR/${SEGMENT}_instruments.csv not found - run scripts/download-all-masters.sh first"
    exit 1
  fi
done

TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_OUT"' EXIT
for SEGMENT in NFO BFO; do
  SRC="$DATA_DIR/${SEGMENT}_instruments.csv"
  awk -F',' -v today="$TODAY" \
    'NR>1 && $6>=today && ($10=="CE" || $10=="PE") { gsub(/"/,"",$4); print $4"_"$7"_"$10 }' \
    "$SRC" >> "$TMP_OUT"
done

if [ ! -s "$TMP_OUT" ]; then
  echo "Error: no symbols produced - leaving public/symbols.txt untouched"
  exit 1
fi
sort -u "$TMP_OUT" -o "$TMP_OUT"
chmod 644 "$TMP_OUT"
mv "$TMP_OUT" public/symbols.txt
echo "Updated public/symbols.txt ($(wc -l < public/symbols.txt) entries)"
