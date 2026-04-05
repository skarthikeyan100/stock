#!/bin/bash
# Filters March NFO symbols from NFO_symbols.txt and writes TradingSymbol column to frontend/public/symbols.txt

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../NFO_symbols.txt"
DEST="$SCRIPT_DIR/../frontend/public/symbols.txt"

if [ ! -f "$SRC" ]; then
  echo "Error: $SRC not found"
  exit 1
fi

# Column 5 (TradingSymbol), skip header, filter rows with MAR in expiry (column 6)
awk -F',' 'NR > 1 && $6 ~ /MAR/ { print $5 }' "$SRC" > "$DEST"

COUNT=$(wc -l < "$DEST")
echo "Written $COUNT March symbols to $DEST"
