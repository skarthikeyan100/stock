#!/usr/bin/env bash
# Realized / unrealized P&L for BulkPcr, ContinuousStrategy, SimpleContinuousStrategy, MomentumAtFixedTime, NiftyChange and Recommendation
# (from the running `order` process): one table per strategy, then one table per broker (kite / ant / breeze / prism).
# Usage: scripts/strategy-status.sh [port]
PORT="${1:-3000}"
MATCH='BulkPcr|Continuous|MomentumAtFixedTime|NiftyChange|Recommendation'
BY_STRATEGY="$(curl -s -m10 "localhost:$PORT/strategyPnl?match=$MATCH")"
BY_BROKER="$(curl -s -m10 "localhost:$PORT/strategyPnl?match=$MATCH&by=broker")"
BY_STRATEGY="$BY_STRATEGY" BY_BROKER="$BY_BROKER" node -e '
const f=n=>(n>=0?"+":"")+n.toFixed(2);
const parse=(s)=>{try{const r=JSON.parse(s);return Array.isArray(r)?r:null}catch{return null}};
const table=(title,rows)=>{
  console.log(title);
  let R=0,U=0;
  for(const r of rows){R+=r.realized;U+=r.unrealized;
    console.log(`  ${r.strategy.padEnd(30)} realized ${f(r.realized).padStart(11)}  unrealized ${f(r.unrealized).padStart(11)}  (open ${r.open}, closed ${r.closed})`)}
  console.log(`  ${"TOTAL".padEnd(30)} realized ${f(R).padStart(11)}  unrealized ${f(U).padStart(11)}`);
};
const byStrategy=parse(process.env.BY_STRATEGY);
if(!byStrategy){console.log("order process not reachable");process.exit(1)}
if(!byStrategy.length){console.log("no BulkPcr / Continuous / MomentumAtFixedTime / NiftyChange / Recommendation trades this session");process.exit(0)}
table("BY STRATEGY",byStrategy);
const byBroker=parse(process.env.BY_BROKER);
if(byBroker&&byBroker.length){console.log("");table("BY BROKER",byBroker)}
else console.log("\n(by-broker table unavailable: the API process predates the ?by=broker option - restart it)");
'
