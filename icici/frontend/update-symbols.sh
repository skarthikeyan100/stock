#!/bin/bash
MONTH=${1:-APR}
MONTH_UPPER=$(echo "$MONTH" | tr '[:lower:]' '[:upper:]')
awk -F',' -v month="$MONTH_UPPER" 'NR>1 && $5~month{print $5}' /home/karthikeyan/Downloads/NFO_symbols.txt/NFO_symbols.txt > public/symbols.txt
echo "Updated public/symbols.txt with $MONTH_UPPER symbols ($(wc -l < public/symbols.txt) entries)"
