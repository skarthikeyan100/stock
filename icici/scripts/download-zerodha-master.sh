#!/bin/bash
# Downloads Zerodha's NFO instrument master to a local file, mirroring the
# same convention data/ant/NFO_contract.json/BFO_contract.json already use
# (see CLAUDE.md) - re-run this to refresh when the file is stale, rather
# than any code calling Zerodha's API live. Public endpoint, no auth needed.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data/zerodha"
mkdir -p "$DATA_DIR"

for SEGMENT in NFO BFO; do
  DEST="$DATA_DIR/${SEGMENT}_instruments.csv"
  curl -sf "https://api.kite.trade/instruments/$SEGMENT" -o "$DEST"
  COUNT=$(wc -l < "$DEST")
  echo "Downloaded $COUNT lines to $DEST"
done
