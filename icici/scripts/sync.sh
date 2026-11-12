#!/usr/bin/env bash
# Broker -> Mongo sync on demand: the same job the platform runs by itself after the close (settings.eodReconcileTime, default 15:45).
# It reads each broker's trade book, order book and open positions, books into Mongo what the brokers did that Mongo lacks (e.g. a close the broker
# made on its own, at its exact price) and reports what it cannot attribute with evidence. It places NO order and does not touch strategies.
# Use it after logging in to the brokers, after a mid-day restart, or whenever a broker and the status table disagree.
# Usage: npm run sync [-- --strategies]   (--strategies also runs POST /reconcile afterwards, so strategies re-read Mongo)
PORT="${PORT:-3000}"
OUT="$(curl -s -m 330 -X POST "localhost:$PORT/sync")"
OUT="$OUT" node -e '
let r; try { r = JSON.parse(process.env.OUT); } catch { console.log("no usable answer from the platform:", (process.env.OUT || "").slice(0, 200)); process.exit(1); }
if (r.error) { console.log("sync failed:", r.error); process.exit(1); }
let bad = 0;
for (const [b, x] of Object.entries(r)) {
  const state = x.ok ? (x.skipped ? "skipped" : "ok") : "FAILED"; if (!x.ok) bad++;
  console.log(`${b.padEnd(7)} ${state.padEnd(8)} booked ${x.bookedFills} fill(s) from the broker, ${x.bookedFlat} flat close(s) at an implied price, ${x.repairedClosed ?? 0} missing closed trade(s) written from Mongo fills` + (x.skipped ? `  (${x.skipped})` : "") + (x.error ? `  ERROR: ${x.error}` : ""));
  for (const m of x.mismatches || []) console.log(`        ${m.kind} ${m.tsym}` + (m.brokerQty != null ? ` broker=${m.brokerQty}` : "") + (m.mongoQty != null ? ` mongo=${m.mongoQty}` : "") + (m.note ? ` - ${m.note}` : ""));
}
process.exit(bad ? 2 : 0);
'
RC=$?
if [ "${1:-}" = "--strategies" ]; then
  echo "--- POST /reconcile (strategies re-read Mongo)"
  curl -s -m 330 -X POST "localhost:$PORT/reconcile"; echo
fi
exit $RC
