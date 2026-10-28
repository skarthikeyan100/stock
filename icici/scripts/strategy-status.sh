#!/usr/bin/env bash
# Realized / unrealized P&L per strategy for BulkPcr and ContinuousStrategy (from the running `order` process).
# Usage: scripts/strategy-status.sh [port]
PORT="${1:-3000}"
curl -s -m10 "localhost:$PORT/strategyPnl?match=BulkPcr|Continuous" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let rows;try{rows=JSON.parse(s)}catch{console.log("order process not reachable");process.exit(1)}
  if(!rows.length){console.log("no BulkPcr / Continuous trades this session");return}
  const f=n=>(n>=0?"+":"")+n.toFixed(2);
  let R=0,U=0;
  for(const r of rows){R+=r.realized;U+=r.unrealized;
    console.log(`${r.strategy.padEnd(28)} realized ${f(r.realized).padStart(11)}  unrealized ${f(r.unrealized).padStart(11)}  (open ${r.open}, closed ${r.closed})`)}
  console.log(`${"TOTAL".padEnd(28)} realized ${f(R).padStart(11)}  unrealized ${f(U).padStart(11)}`)})'
