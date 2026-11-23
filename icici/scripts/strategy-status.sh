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
# `users` switches to the REAL USERS who trade from the frontend (Trade.user is an email; strategy pseudo-users are not): BY USER, BY BROKER,
# OPEN POSITIONS by user (target/stop as stored on the position, "-" if none) and the day's closed TRADES one row each (?match=@ on /strategyPnl,
# ?closed=1 for the closed rows). The admin email also carries the mirrored shares of other users buys (settings.mirrorPercentage); a trade row
# does not record that, so admin rows are not marked. The strategy tables are not printed in this mode; `all` works the same way.
# `net` prints ONE number and nothing else: today's net P&L (realized + unrealized) from the brokers' OWN position books (kite, ant, prism,
# breeze), so orders placed outside the platform (manual) count too. This is the one exception to the manual-orders-are-ignored rule.
# It prints a table (broker, realized, unrealized, total; a broker that cannot be read shows "unreadable" and is not counted) and then the NET line.
# Usage: scripts/strategy-status.sh [net|users] [all] [port]
#   e.g.  scripts/strategy-status.sh   |  scripts/strategy-status.sh all 3000  |  scripts/strategy-status.sh 3000  |  scripts/strategy-status.sh users  |  scripts/strategy-status.sh users all
OPENED=today
USERS=0
NET=0
ARGS=()
for a in "$@"; do if [ "$a" = "all" ]; then OPENED=all; elif [ "$a" = "users" ]; then USERS=1; elif [ "$a" = "net" ]; then NET=1; else ARGS+=("$a"); fi; done
PORT="${ARGS[0]:-3000}"
for a in "$@"; do if [ "$a" = "list" ]; then
  cat <<'LIST'
status             3 tables (BY STRATEGY, BY BROKER, UNREALIZED BY BROKER AND STRATEGY): trades opened today, enabled strategies only
status all         the same 3 tables, also trades opened on an earlier day and closed today or still open; includes disabled strategies
status users       the real users (emails) who trade from the frontend: BY USER, BY BROKER, OPEN POSITIONS, closed TRADES (opened today)
status users all   the same, also earlier-day trades
status net         table of the brokers' own books (realized, unrealized, total per broker) then NET; manual non-platform orders included
status paper       paper-broker strategies (GammaBurst, HighLow on paper): config, paper positions and trades, log lines
status list        this list
LIST
  exit 0
fi; done
if [ "$NET" = 1 ]; then
  # User's rule (2026-11-20, `status net` only): the broker's OWN books, so non-platform (manual) orders count too. Per broker, today's net P&L
  # as the broker reports it: kite = sum of day-position pnl, ant = realizedPnl + unrealizedPnl, prism = rpnl + urmtom, breeze = pnl rows.
  K="$(curl -s -m20 "localhost:$PORT/broker/kite/positions")"; A="$(curl -s -m20 "localhost:$PORT/broker/ant/positions")"
  P="$(curl -s -m20 "localhost:$PORT/broker/prism/positions")"; B="$(curl -s -m20 "localhost:$PORT/broker/breeze/positions")"
  K="$K" A="$A" P="$P" B="$B" node -e '
const parse=s=>{try{return JSON.parse(s)}catch{return null}};
const num=v=>{const n=parseFloat(v);return Number.isFinite(n)?n:0};
const sum=(rows,f)=>rows.reduce((a,r)=>a+f(r),0);
// Per broker: realized / unrealized as the broker reports them. Kite labels every day-position P&L "unrealised" (realised is always 0), so
// a contract with net quantity 0 counts as realized and a contract still open counts as unrealized (its figure then also holds that
// contract earlier closed trades; Kite does not split them).
const brokers=[];
const k=parse(process.env.K);
brokers.push(k&&k.success&&k.positions&&Array.isArray(k.positions.day)?{name:"kite",r:sum(k.positions.day.filter(p=>num(p.quantity)===0),p=>num(p.pnl)),u:sum(k.positions.day.filter(p=>num(p.quantity)!==0),p=>num(p.pnl))}:{name:"kite"});
const a=parse(process.env.A);
brokers.push(a&&a.success&&Array.isArray(a.positions)?{name:"ant",r:sum(a.positions,p=>num(p.realizedPnl)),u:sum(a.positions,p=>num(p.unrealizedPnl))}:{name:"ant"});
const p=parse(process.env.P);
brokers.push(p&&p.success&&Array.isArray(p.positions)?{name:"prism",r:sum(p.positions,x=>num(x.rpnl)),u:sum(p.positions,x=>num(x.urmtom))}:{name:"prism"});
const b=parse(process.env.B);
brokers.push(b&&b.success&&Array.isArray(b.positions)?{name:"breeze",r:sum(b.positions,x=>num(x.realizedPnl)),u:sum(b.positions,x=>num(x.unrealizedPnl)+num(x.pnl))}:{name:"breeze"});
const f=n=>(n<0?"-":"")+Math.abs(Math.round(n)).toLocaleString("en-US");
const pad=(t,w)=>String(t).padStart(w);
let R=0,U=0;
console.log("BROKER   "+pad("REALIZED",12)+pad("UNREALIZED",12)+pad("TOTAL",12));
for(const x of brokers){
  if(x.r===undefined){console.log(x.name.padEnd(8)+"  "+pad("unreadable",36));continue}
  R+=x.r;U+=x.u;
  console.log(x.name.padEnd(8)+"  "+pad(f(x.r),12)+pad(f(x.u),12)+pad(f(x.r+x.u),12));
}
console.log("TOTAL   "+"  "+pad(f(R),12)+pad(f(U),12)+pad(f(R+U),12));
console.log("");
console.log("NET "+f(R+U));'
  exit 0
fi
HDR="$(mktemp)"; trap 'rm -f "$HDR"' EXIT
if [ "$USERS" = 1 ]; then
Q="opened=$OPENED&match=%40"
BY_USER="$(curl -s -m10 -D "$HDR" "localhost:$PORT/strategyPnl?$Q")"
FILTER_OK=0; grep -qi '^x-opened-filter: today' "$HDR" && FILTER_OK=1
BY_BROKER="$(curl -s -m10 "localhost:$PORT/strategyPnl?by=broker&$Q")"
DETAIL="$(curl -s -m20 "localhost:$PORT/strategyPnl?detail=1&$Q")"
CLOSED="$(curl -s -m10 -D "$HDR" "localhost:$PORT/strategyPnl?closed=1&$Q")"
CLOSED_OK=0; grep -qi '^x-closed-rows: 1' "$HDR" && CLOSED_OK=1
OPENED="$OPENED" FILTER_OK="$FILTER_OK" CLOSED_OK="$CLOSED_OK" BY_USER="$BY_USER" BY_BROKER="$BY_BROKER" DETAIL="$DETAIL" CLOSED="$CLOSED" node -e '
const f=n=>(n>=0?"+":"")+n.toFixed(2);
const parse=s=>{try{const r=JSON.parse(s);return Array.isArray(r)?r:null}catch{return null}};
const byUser=parse(process.env.BY_USER);
if(!byUser){console.log("order process not reachable");process.exit(1)}
if(process.env.OPENED==="today"&&process.env.FILTER_OK!=="1")console.log("WARNING: the web server predates the ?opened filter (needs a restart): the tables below count ALL trades, not only those opened today");
console.log(process.env.OPENED==="all"?"(all trades: also those opened on an earlier day)":"(trades opened today only; "+String.fromCharCode(96)+"all"+String.fromCharCode(96)+" adds earlier-day trades closed or still open today)");
const detail=parse(process.env.DETAIL)||[];
// one ?detail=1 snapshot prices every table, so unrealized agrees across them (each endpoint call re-prices at its own moment)
const snap=(rows,key)=>{for(const r of rows)r.unrealized=detail.filter(d=>key(d)===key(r)).reduce((a,d)=>a+d.unrealized,0)};
snap(byUser,r=>r.strategy);
const table=(title,rows,label)=>{
  console.log(title);
  let R=0,U=0;
  for(const r of rows){R+=r.realized;U+=r.unrealized;
    console.log(`  ${r.strategy.padEnd(label)} realized ${f(r.realized).padStart(11)}  unrealized ${f(r.unrealized).padStart(11)}  (open ${r.open}, closed ${r.closed})`)}
  console.log(`  ${"TOTAL".padEnd(label)} realized ${f(R).padStart(11)}  unrealized ${f(U).padStart(11)}`);
};
byUser.sort((a,b)=>a.strategy.localeCompare(b.strategy));
if(!byUser.length){console.log("no real-user trades");process.exit(0)}
const lab=Math.max(10,...byUser.map(r=>r.strategy.length));
table("BY USER",byUser,lab);
const byBroker=parse(process.env.BY_BROKER)||[];
snap(byBroker,r=>r.broker??r.strategy);
byBroker.sort((a,b)=>a.strategy.localeCompare(b.strategy));
if(byBroker.length){console.log("");table("BY BROKER",byBroker,lab)}
const grid=(hdr,rows,left)=>{
  const w=hdr.map((h,i)=>Math.max(h.length,...rows.map(r=>r[i].length)));
  const line=r=>"  "+r.map((c,i)=>left.includes(i)?c.padEnd(w[i]):c.padStart(w[i])).join("  ");
  console.log(line(hdr));for(const r of rows)console.log(line(r));
};
console.log("\nOPEN POSITIONS by user");
if(!detail.length)console.log("  none open");
else{
  detail.sort((a,b)=>a.user.localeCompare(b.user)||a.broker.localeCompare(b.broker)||a.tsym.localeCompare(b.tsym));
  grid(["user","broker","contract","qty","bought","ltp","target","stop","unrealized"],
    detail.map(r=>[r.user,r.broker,r.tsym,String(r.quantity),r.price.toFixed(2),r.ltp==null?"?":r.ltp.toFixed(2)+(r.liveQuote?"":"*"),r.targetPrice!=null?r.targetPrice.toFixed(2):"-",r.stopLossPrice!=null?r.stopLossPrice.toFixed(2):"-",f(r.unrealized)]),[0,1,2]);
  if(detail.some(r=>!r.liveQuote))console.log("  * no live quote, last known price");
}
console.log("\nTRADES (closed)");
const closed=process.env.CLOSED_OK==="1"?parse(process.env.CLOSED):null;
if(!closed)console.log("  (closed-trade list unavailable: the web server predates the ?closed=1 option - restart it)");
else if(!closed.length)console.log("  none closed");
else{
  const hhmm=t=>t?new Date(t).toLocaleTimeString("en-GB",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"}):"-";
  const px=v=>v==null?"-":v.toFixed(2);
  grid(["user","broker","contract","qty","entry","exit","in","out","realized"],
    closed.map(r=>[r.user,r.broker,r.tsym,String(r.quantity),px(r.entryPrice),px(r.exitPrice),hhmm(r.entryTime),hhmm(r.exitTime),f(r.realizedPnL)]),[0,1,2]);
  console.log(`  ${"TOTAL".padEnd(8)} ${closed.length} trades, realized ${f(closed.reduce((a,r)=>a+r.realizedPnL,0))}`);
}
console.log("\nNote: the admin email also holds mirrored shares of other users buys (settings.mirrorPercentage); the trade rows do not say which, so they are not marked.");
'
exit 0
fi
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
// The source is the snapshot rows of the strategies the table covers (see keepDetail): a BY BROKER row summed over EVERY open position of that broker
// also counted real users and disabled strategies that the other tables leave out (2026-11-18: Breeze showed the user position on top).
const snapUnreal=(rows,key,src=detailSnap)=>{if(!src)return;for(const r of rows){const k=key(r);r.unrealized=src.filter(d=>key(d)===k).reduce((a,d)=>a+d.unrealized,0)}};
snapUnreal(byStrategy,r=>r.strategy);
// Strategies enabled in config.yml, named as the platform names its instances (src/util/strategyInstances.ts, compiled in dist/).
let enabledNames=null;
let paperNames=new Set();
try{
  const {expandStrategyInstances}=require(process.env.ROOT+"/dist/util/strategyInstances.js");
  const cfg=require(process.env.ROOT+"/node_modules/js-yaml").load(require("fs").readFileSync(process.env.CONFIG_PATH||process.env.ROOT+"/config.yml","utf8"));
  // Paper-only blocks (brokers: [paper], in-memory, nothing in Mongo) are left out: `paper` is reported only by the "status paper" check.
  const isPaperOnly=c=>Array.isArray(c.brokers)&&c.brokers.length>0&&c.brokers.every(b=>b==="paper");
  enabledNames=new Set(expandStrategyInstances((cfg.strategies||[]).filter(c=>c&&c.enabled===true&&!isPaperOnly(c))).map(c=>c.userId||c.type));
  paperNames=new Set(expandStrategyInstances((cfg.strategies||[]).filter(c=>c&&isPaperOnly(c))).map(c=>c.userId||c.type));
}catch(e){console.log("(could not read the enabled strategies from config.yml: "+e.message+")")}
// status (today): enabled strategies only (rule of 2026-11-13). status all: every strategy with trades, enabled or disabled/latched
// (rule of 2026-11-17), never the real users (their rows contain an @ sign).
const allMode=process.env.OPENED==="all";
const isUserName=n=>n.includes("@");
// The open positions every table must be built from: the same strategies as BY STRATEGY (enabled only; with `all` every non-user, non-paper one).
const keepDetail=s=>allMode?!(isUserName(s)||paperNames.has(s)):(!enabledNames||enabledNames.has(s));
const tableDetail=detailSnap?detailSnap.filter(d=>keepDetail(d.strategy)):null;
if(allMode){
  for(let i=byStrategy.length-1;i>=0;i--)if(isUserName(byStrategy[i].strategy)||paperNames.has(byStrategy[i].strategy))byStrategy.splice(i,1);
}else if(enabledNames){
  for(let i=byStrategy.length-1;i>=0;i--)if(!enabledNames.has(byStrategy[i].strategy))byStrategy.splice(i,1);
  const have=new Set(byStrategy.map(r=>r.strategy));
  for(const name of enabledNames)if(!have.has(name))byStrategy.push({strategy:name,realized:0,unrealized:0,open:0,closed:0});
}
byStrategy.sort((a,b)=>a.strategy.localeCompare(b.strategy));
if(!byStrategy.length){console.log("no strategy enabled and no trades this session");process.exit(0)}
console.log(process.env.OPENED==="all"?"(all trades: also those opened on an earlier day)":"(trades opened today only; `all` adds earlier-day trades closed or still open today)");
table("BY STRATEGY",byStrategy);
const esc=n=>n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const matchQ=allMode?"&match="+encodeURIComponent("^[^@]+$"):(enabledNames?"&match="+encodeURIComponent("^("+[...enabledNames].map(esc).join("|")+")$"):"");
const byBroker=parse(require("child_process").execFileSync("curl",["-s","-m10","localhost:"+process.env.PORT+"/strategyPnl?by=broker&opened="+process.env.OPENED+matchQ]).toString());
if(byBroker&&allMode){for(let i=byBroker.length-1;i>=0;i--)if(byBroker[i].strategy==="paper"||byBroker[i].broker==="paper")byBroker.splice(i,1)}
if(byBroker)snapUnreal(byBroker,r=>r.broker??r.strategy,tableDetail);
if(byBroker&&byBroker.length){console.log("");table("BY BROKER",byBroker)}
else console.log("\n(by-broker table unavailable: the API process predates the ?by=broker option - restart it)");

// ---- Unrealized by broker and strategy, per open position ----
const detail=parse(process.env.DETAIL);
if(detail){
  for(let i=detail.length-1;i>=0;i--){
    const s=detail[i].strategy;
    if(!keepDetail(s))detail.splice(i,1);
  }
}
if(!detail){console.log("\n(position table unavailable: the API process predates the ?detail=1 option - restart it)");process.exit(0)}
// Resting sell prices from today log: MomentumAtFixedTime "[MomentumAtFixedTime:<user>] <broker> <tsym>: bought .. - resting sell @ <p>" and
// SimpleContinuous-style "[<user>] resting sell <tsym> qty=<n> @<p>", HighLow "[HighLow:<user>] .. resting sell <h> @ <p>, the other <h> then trails". Keyed user|tsym only (never tsym alone); the last line wins.
const sells=new Map();
try{
  for(const line of require("fs").readFileSync(process.env.LOG,"utf8").split("\n")){
    let m=line.match(/\[MomentumAtFixedTime:([^\]]+)\] \w+ (\S+): bought .* resting sell @ ([0-9.]+)/);
    if(m){sells.set(m[1]+"|"+m[2],+m[3]);continue}
    m=line.match(/\] \[([^\]]+)\] resting sell (\S+) qty=\d+ ?@ ?([0-9.]+)/);
    if(m){sells.set(m[1]+"|"+m[2],+m[3]);continue} // keyed by the logging user: a line never shows on another strategy row (an ANT/Breeze/Prism instance falls back to its base id below)
    // HighLow half-trail: "[HighLow:<user>] <broker> <tsym> qty=<n> avg=<a>: resting sell <h> @ <p>, the other <h> then trails ..." shows the half resting price <p>
    m=line.match(/\[HighLow:([^\]]+)\] \w+ (\S+) qty=\d+ avg=\S+: resting sell \d+ @ ([0-9.]+),/);
    if(m){sells.set(m[1]+"|"+m[2],+m[3]);continue}
    // CandleEntry family (NextWeek, Breakout): "[Type:<user>] <broker> <tsym> qty=<n> avg=<a>: target <t> / stop <s> protected via gtt"
    m=line.match(/\[[^\]:]+:([^\]]+)\] \w+ (\S+) qty=\d+ avg=\S+: target ([0-9.]+) \/ stop [0-9.]+ protected via (\w+)/);
    if(m)sells.set(m[1]+"|"+m[2],{p:+m[3],via:m[4]})
  }
}catch{}
console.log("\nUNREALIZED BY BROKER AND STRATEGY (open positions)");
if(!detail.length){console.log("  none open");process.exit(0)}
detail.sort((a,b)=>a.broker.localeCompare(b.broker)||a.strategy.localeCompare(b.strategy)||a.tsym.localeCompare(b.tsym));
const hdr=["broker","strategy","contract","qty","bought","ltp","resting sell","unrealized"];
const rows=detail.map(r=>{
  const sell=sells.get(r.user+"|"+r.tsym)??sells.get(r.user.replace(/-(ANT|Breeze|Prism)$/,"")+"|"+r.tsym);
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
