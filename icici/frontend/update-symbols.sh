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
DATA_DIR="$SCRIPT_DIR/../data/kite"
TODAY=$(date +%Y-%m-%d)

: > public/symbols.txt
for SEGMENT in NFO BFO; do
  SRC="$DATA_DIR/${SEGMENT}_instruments.csv"
  if [ ! -f "$SRC" ]; then
    echo "Error: $SRC not found - run scripts/download-all-masters.sh first"
    exit 1
  fi
  awk -F',' -v today="$TODAY" \
    'NR>1 && $6>=today && ($10=="CE" || $10=="PE") { gsub(/"/,"",$4); print $4"_"$7"_"$10 }' \
    "$SRC" >> public/symbols.txt
done

sort -u public/symbols.txt -o public/symbols.txt
echo "Updated public/symbols.txt ($(wc -l < public/symbols.txt) entries)"
