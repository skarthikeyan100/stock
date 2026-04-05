#!/bin/bash
# Runs mock server for each available date, collects RateOfChangeStrategy results.

DATES=("2026-02-24" "2026-02-25" "2026-02-26" "2026-02-27" "2026-03-02")
RESULTS_FILE="./roc_results.txt"
PORT=3001
PKG="./package.json"
CONFIG="./config.mock.yml"

# Save originals to restore on exit
ORIGINAL_MOCK=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$PKG','utf8')).scripts['server:mock'])")

restore() {
  # Restore server:mock script
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$PKG', 'utf8'));
    pkg.scripts['server:mock'] = $(node -e "process.stdout.write(JSON.stringify('$ORIGINAL_MOCK'))");
    fs.writeFileSync('$PKG', JSON.stringify(pkg, null, 2));
  " 2>/dev/null
  # Restore logEnabled: true in config
  sed -i 's/logEnabled: false/logEnabled: true/' "$CONFIG" 2>/dev/null
  fuser -k $PORT/tcp 2>/dev/null
}
trap restore EXIT

# Step: disable verbose logging so batch runs fast
sed -i '/type: RateOfChangeStrategy/,/logEnabled:/{s/logEnabled: true/logEnabled: false/}' "$CONFIG"

echo "Date,Trades,Wins,Losses,Timeouts,Win%,P&L" > "$RESULTS_FILE"

for date in "${DATES[@]}"; do
  echo ""
  echo "=== [$date] Starting ==="

  # Step a: update server:mock in package.json with hardcoded date (direct node run, no tsc-watch)
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$PKG', 'utf8'));
    pkg.scripts['server:mock'] = 'PORT=$PORT MOCK_DATE=$date MOCK_BROKER=true MOCK_QUOTES=true CONFIG_PATH=./config.mock.yml node ./dist/server.js';
    fs.writeFileSync('$PKG', JSON.stringify(pkg, null, 2));
  "

  logfile="/tmp/roc_${date}.log"
  > "$logfile"

  # Step b: run npm server:mock, suppress verbose output, only log to file
  npm run server:mock > "$logfile" 2>&1 &
  npm_pid=$!

  # Wait for server ready (up to 15s)
  ready=0
  for i in $(seq 1 30); do
    sleep 0.5
    grep -q "Icici server started" "$logfile" 2>/dev/null && ready=1 && break
  done

  if [ $ready -eq 0 ]; then
    echo "  ✗ Server did not start for $date"
    kill $npm_pid 2>/dev/null; wait $npm_pid 2>/dev/null
    echo "$date,ERROR,-,-,-,-,-" >> "$RESULTS_FILE"
    continue
  fi

  # Call /connect API to start streaming quotes
  curl -s "http://localhost:$PORT/connect" > /dev/null 2>&1
  echo "  /connect called, waiting for exhaustion..."

  # Wait for BACKTEST STATS (quotes exhausted, up to 120s)
  for i in $(seq 1 120); do
    sleep 1
    grep -q "BACKTEST STATS" "$logfile" 2>/dev/null && break
  done

  # Step c: extract and store RateOfChangeStrategy result
  row=$(grep "| RateOfChangeStrategy " "$logfile" 2>/dev/null | head -1 | sed 's/^\[.*\] \[.*\] //')
  if [ -n "$row" ]; then
    trades=$(echo "$row" | awk -F'|' '{gsub(/ /,"",$3); print $3}')
    wins=$(echo "$row"   | awk -F'|' '{gsub(/ /,"",$4); print $4}')
    losses=$(echo "$row" | awk -F'|' '{gsub(/ /,"",$5); print $5}')
    timeouts=$(echo "$row" | awk -F'|' '{gsub(/ /,"",$6); print $6}')
    winpct=$(echo "$row" | awk -F'|' '{gsub(/ /,"",$7); print $7}')
    pnl=$(echo "$row"    | awk -F'|' '{gsub(/ /,"",$8); print $8}')
    echo "$date,$trades,$wins,$losses,$timeouts,$winpct,$pnl" >> "$RESULTS_FILE"
    echo "  RoC: trades=$trades wins=$wins losses=$losses win%=$winpct pnl=$pnl"
  else
    echo "$date,0,0,0,0,N/A,0" >> "$RESULTS_FILE"
    echo "  RoC: no trades"
  fi

  # Step d: kill the server (force-kill anything holding the port)
  kill $npm_pid 2>/dev/null
  sleep 1
  fuser -k $PORT/tcp 2>/dev/null
  wait $npm_pid 2>/dev/null
  sleep 2

done

echo ""
echo "============================================================"
echo "  RateOfChangeStrategy — Summary by Date"
echo "============================================================"
printf "%-12s %8s %5s %7s %9s %6s %8s\n" "Date" "Trades" "Wins" "Losses" "Timeouts" "Win%" "P&L"
echo "------------------------------------------------------------"
tail -n +2 "$RESULTS_FILE" | while IFS=',' read date trades wins losses timeouts winpct pnl; do
  printf "%-12s %8s %5s %7s %9s %6s %8s\n" "$date" "$trades" "$wins" "$losses" "$timeouts" "$winpct" "$pnl"
done
echo "============================================================"
echo "Full results saved to: $RESULTS_FILE"
