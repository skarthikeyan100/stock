#!/usr/bin/env bash
# Realized / unrealized P&L for EVERY strategy, not a fixed list (from the running `order` process): one table per strategy, one per broker
# (kite / ant / breeze / prism), then UNREALIZED BY BROKER AND STRATEGY: one row per open position with the contract, bought price,
# live price, resting sell price and unrealized P&L.
# Which strategies: ONLY those enabled in config.yml (expanded per broker the way the platform names instances: <userId>, <userId>-ANT,
# <userId>-Breeze), shown with zeros until they trade, so a newly enabled strategy appears with no change here. Trades of a disabled
# strategy are left out of every table (user's rule, 2026-11-13); the by-broker table is filtered the same way (?match=).
# The resting sell price is not stored on the position: it is read from the strategy's own log line for that contract (today's log, last
# match): "resting sell @ <price>", or "target <price> / stop <price> protected via <gtt|..>" which shows "<price> (<gtt|..>)". "-" when
# none is found (no resting sell, e.g. tick-monitored RuleBased).
# By default ONLY trades OPENED today (IST day of the trade's entry time) count, realized and unrealized: a trade bought on an earlier day and
# sold today, or still open from an earlier day, is left out (?opened=today on /strategyPnl; a trade with no entry time counts as today).
# With `all` it also counts trades opened on an earlier day but closed today and positions still open from earlier days (?opened=all).
# Usage: scripts/strategy-status.sh [all] [port]      e.g.  scripts/strategy-status.sh   |  scripts/strategy-status.sh all 3000  |  scripts/strategy-status.sh 3000
OPENED=today
ARGS=()
for a in "$@"; do if [ "$a" = "all" ]; then OPENED=all; else ARGS+=("$a"); fi; done
PORT="${ARGS[0]:-3000}"
HDR="$(mktemp)"; trap 'rm -f "$HDR"' EXIT
BY_STRATEGY="$(curl -s -m10 -D "$HDR" "localhost:$PORT/strategyPnl?opened=$OPENED")"
if [ "$OPENED" = today ] && ! grep -qi '^x-opened-filter: today' "$HDR"; then echo "WARNING: the web server predates the ?opened filter (needs a restart): the tables below count ALL trades, not only today's"; fi
DETAIL="$(curl -s -m20 "localhost:$PORT/strategyPnl?detail=1&opened=$OPENED")"
ROOT="$(dirname "$(readlink -f "$0")")/.."
LOG="$(dirname "$(readlink -f "$0")")/../logs/orchestrator-$(date +%F).log"
OPENED="$OPENED" PORT="$PORT" BY_STRATEGY="$BY_STRATEGY" DETAIL="$DETAIL" LOG="$LOG" ROOT="$ROOT" node -e '
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
// The three endpoint calls each re-price open legs at the tick of their own moment, so their unrealized totals drift apart by a few hundred.
// Realized and counts do not move with ticks; unrealized is overwritten below from the single ?detail=1 snapshot so every table agrees.
const detailSnap=parse(process.env.DETAIL);
const snapUnreal=(rows,key)=>{if(!detailSnap)return;for(const r of rows){const k=key(r);r.unrealized=detailSnap.filter(d=>key(d)===k).reduce((a,d)=>a+d.unrealized,0)}};
snapUnreal(byStrategy,r=>r.strategy);
// Strategies enabled in config.yml, named as the platform names its instances (src/util/strategyInstances.ts, compiled in dist/).
let enabledNames=null;
try{
  const {expandStrategyInstances}=require(process.env.ROOT+"/dist/util/strategyInstances.js");
  const cfg=require(process.env.ROOT+"/node_modules/js-yaml").load(require("fs").readFileSync(process.env.CONFIG_PATH||process.env.ROOT+"/config.yml","utf8"));
  enabledNames=new Set(expandStrategyInstances((cfg.strategies||[]).filter(c=>c&&c.enabled===true)).map(c=>c.userId||c.type));
}catch(e){console.log("(could not read the enabled strategies from config.yml: "+e.message+")")}
if(enabledNames){
  for(let i=byStrategy.length-1;i>=0;i--)if(!enabledNames.has(byStrategy[i].strategy))byStrategy.splice(i,1);
  const have=new Set(byStrategy.map(r=>r.strategy));
  for(const name of enabledNames)if(!have.has(name))byStrategy.push({strategy:name,realized:0,unrealized:0,open:0,closed:0});
}
byStrategy.sort((a,b)=>a.strategy.localeCompare(b.strategy));
if(!byStrategy.length){console.log("no strategy enabled and no trades this session");process.exit(0)}
console.log(process.env.OPENED==="all"?"(all trades: also those opened on an earlier day)":"(trades opened today only; `all` adds earlier-day trades closed or still open today)");
table("BY STRATEGY",byStrategy);
const esc=n=>n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const matchQ=enabledNames?"&match="+encodeURIComponent("^("+[...enabledNames].map(esc).join("|")+")$"):"";
const byBroker=parse(require("child_process").execFileSync("curl",["-s","-m10","localhost:"+process.env.PORT+"/strategyPnl?by=broker&opened="+process.env.OPENED+matchQ]).toString());
if(byBroker)snapUnreal(byBroker,r=>r.broker??r.strategy);
if(byBroker&&byBroker.length){console.log("");table("BY BROKER",byBroker)}
else console.log("\n(by-broker table unavailable: the API process predates the ?by=broker option - restart it)");

// ---- Unrealized by broker and strategy, per open position ----
const detail=parse(process.env.DETAIL);
if(detail&&enabledNames)for(let i=detail.length-1;i>=0;i--)if(!enabledNames.has(detail[i].strategy))detail.splice(i,1);
if(!detail){console.log("\n(position table unavailable: the API process predates the ?detail=1 option - restart it)");process.exit(0)}
// Resting sell prices from today log: MomentumAtFixedTime "[MomentumAtFixedTime:<user>] <broker> <tsym>: bought .. - resting sell @ <p>" and
// SimpleContinuous-style "[<user>] resting sell <tsym> qty=<n> @<p>". Keyed user|tsym; the last line wins.
const sells=new Map();
try{
  for(const line of require("fs").readFileSync(process.env.LOG,"utf8").split("\n")){
    let m=line.match(/\[MomentumAtFixedTime:([^\]]+)\] \w+ (\S+): bought .* resting sell @ ([0-9.]+)/);
    if(m){sells.set(m[1]+"|"+m[2],+m[3]);sells.set("|"+m[2],+m[3]);continue}
    m=line.match(/\] \[([^\]]+)\] resting sell (\S+) qty=\d+ ?@ ?([0-9.]+)/);
    if(m){sells.set(m[1]+"|"+m[2],+m[3]);sells.set("|"+m[2],+m[3]);continue} // the contract-only key covers an instance that logs under another id (Breeze)
    // CandleEntry family (NextWeek, Breakout): "[Type:<user>] <broker> <tsym> qty=<n> avg=<a>: target <t> / stop <s> protected via gtt"
    m=line.match(/\[[^\]:]+:([^\]]+)\] \w+ (\S+) qty=\d+ avg=\S+: target ([0-9.]+) \/ stop [0-9.]+ protected via (\w+)/);
    if(m){const v={p:+m[3],via:m[4]};sells.set(m[1]+"|"+m[2],v);sells.set("|"+m[2],v)}
  }
}catch{}
console.log("\nUNREALIZED BY BROKER AND STRATEGY (open positions)");
if(!detail.length){console.log("  none open");process.exit(0)}
detail.sort((a,b)=>a.broker.localeCompare(b.broker)||a.strategy.localeCompare(b.strategy)||a.tsym.localeCompare(b.tsym));
const hdr=["broker","strategy","contract","qty","bought","ltp","resting sell","unrealized"];
const rows=detail.map(r=>{
  const sell=sells.get(r.user+"|"+r.tsym)??sells.get("|"+r.tsym);
  const rest=sell!=null?(typeof sell==="object"?sell.p.toFixed(2)+" ("+sell.via+")":sell.toFixed(2)):(r.targetPrice!=null?r.targetPrice.toFixed(2)+" (tick)":"-");
  return [r.broker,r.strategy,r.tsym,String(r.quantity),r.price.toFixed(2),r.ltp==null?"?":r.ltp.toFixed(2)+(r.liveQuote?"":"*"),rest,f(r.unrealized)];
});
const w=hdr.map((h,i)=>Math.max(h.length,...rows.map(r=>r[i].length)));
const line=r=>"  "+r.map((c,i)=>i>=3?c.padStart(w[i]):c.padEnd(w[i])).join("  ");
console.log(line(hdr));
for(const r of rows)console.log(line(r));
console.log(line(["TOTAL","","","","","","",f(detail.reduce((a,r)=>a+r.unrealized,0))]));
if(detail.some(r=>!r.liveQuote))console.log("  * no live quote, last known price");
'
