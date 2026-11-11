#!/usr/bin/env bash
# Realized / unrealized P&L for BulkPcr, ContinuousStrategy, SimpleContinuousStrategy, MomentumAtFixedTime, NiftyChange, Recommendation and SentimentStrategy
# (from the running `order` process): one table per strategy, one per broker (kite / ant / breeze / prism), then UNREALIZED BY BROKER AND
# STRATEGY: one row per open position with the contract, bought price, live price, resting sell price and unrealized P&L.
# The resting sell price is not stored on the position: it is read from the strategy's own "resting sell @ <price>" log line for that
# contract (today's log, last match); "-" when none is found (no resting sell, e.g. tick-monitored RuleBased, GTT-protected Recommendation).
# Usage: scripts/strategy-status.sh [port]
PORT="${1:-3000}"
MATCH='BulkPcr|Continuous|MomentumAtFixedTime|NiftyChange|Recommendation|Sentiment|RuleBased'
BY_STRATEGY="$(curl -s -m10 "localhost:$PORT/strategyPnl?match=$MATCH")"
BY_BROKER="$(curl -s -m10 "localhost:$PORT/strategyPnl?match=$MATCH&by=broker")"
DETAIL="$(curl -s -m20 "localhost:$PORT/strategyPnl?match=$MATCH&detail=1")"
LOG="$(dirname "$(readlink -f "$0")")/../logs/orchestrator-$(date +%F).log"
BY_STRATEGY="$BY_STRATEGY" BY_BROKER="$BY_BROKER" DETAIL="$DETAIL" LOG="$LOG" node -e '
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
if(!byStrategy.length){console.log("no BulkPcr / Continuous / MomentumAtFixedTime / NiftyChange / Recommendation / Sentiment trades this session");process.exit(0)}
table("BY STRATEGY",byStrategy);
const byBroker=parse(process.env.BY_BROKER);
if(byBroker&&byBroker.length){console.log("");table("BY BROKER",byBroker)}
else console.log("\n(by-broker table unavailable: the API process predates the ?by=broker option - restart it)");

// ---- Unrealized by broker and strategy, per open position ----
const detail=parse(process.env.DETAIL);
if(!detail){console.log("\n(position table unavailable: the API process predates the ?detail=1 option - restart it)");process.exit(0)}
// Resting sell prices from today log: MomentumAtFixedTime "[MomentumAtFixedTime:<user>] <broker> <tsym>: bought .. - resting sell @ <p>" and
// SimpleContinuous-style "[<user>] resting sell <tsym> qty=<n> @<p>". Keyed user|tsym; the last line wins.
const sells=new Map();
try{
  for(const line of require("fs").readFileSync(process.env.LOG,"utf8").split("\n")){
    let m=line.match(/\[MomentumAtFixedTime:([^\]]+)\] \w+ (\S+): bought .* resting sell @ ([0-9.]+)/);
    if(m){sells.set(m[1]+"|"+m[2],+m[3]);sells.set("|"+m[2],+m[3]);continue}
    m=line.match(/\] \[([^\]]+)\] resting sell (\S+) qty=\d+ ?@ ?([0-9.]+)/);
    if(m){sells.set(m[1]+"|"+m[2],+m[3]);sells.set("|"+m[2],+m[3])} // the contract-only key covers an instance that logs under another id (Breeze)
  }
}catch{}
console.log("\nUNREALIZED BY BROKER AND STRATEGY (open positions)");
if(!detail.length){console.log("  none open");process.exit(0)}
detail.sort((a,b)=>a.broker.localeCompare(b.broker)||a.strategy.localeCompare(b.strategy)||a.tsym.localeCompare(b.tsym));
const hdr=["broker","strategy","contract","qty","bought","ltp","resting sell","unrealized"];
const rows=detail.map(r=>{
  const sell=sells.get(r.user+"|"+r.tsym)??sells.get("|"+r.tsym);
  const rest=sell!=null?sell.toFixed(2):(r.targetPrice!=null?r.targetPrice.toFixed(2)+" (tick)":"-");
  return [r.broker,r.strategy,r.tsym,String(r.quantity),r.price.toFixed(2),r.ltp==null?"?":r.ltp.toFixed(2)+(r.liveQuote?"":"*"),rest,f(r.unrealized)];
});
const w=hdr.map((h,i)=>Math.max(h.length,...rows.map(r=>r[i].length)));
const line=r=>"  "+r.map((c,i)=>i>=3?c.padStart(w[i]):c.padEnd(w[i])).join("  ");
console.log(line(hdr));
for(const r of rows)console.log(line(r));
console.log(line(["TOTAL","","","","","","",f(detail.reduce((a,r)=>a+r.unrealized,0))]));
if(detail.some(r=>!r.liveQuote))console.log("  * no live quote, last known price");
'
