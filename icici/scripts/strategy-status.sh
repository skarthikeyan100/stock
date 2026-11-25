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
# `net` prints today's P&L from the brokers' OWN books (kite, ant, prism, breeze), so orders placed outside the platform (manual) count too. This is the one exception to the manual-orders-are-ignored rule.
# Table: broker, realized, unrealized, total (2 decimals, equal to the broker's own figures), a TOTAL row, one `users*` row, then the NET line. Every broker uses its DAY-AVERAGE convention (realized = sold qty x (avg sell - avg buy), unrealized = open qty x (ltp - avg of the open side)), not FIFO: kite derives the split from its buy/sell value fields (it reports every pnl as unrealised), ant and prism use their own realized/unrealized fields, breeze (no P&L reported) is derived from its trade book. A proof per broker (total = the broker's own pnl / MtoM / amounts, breeze net quantity and average = its positions) or a carried-over contract prints "ERROR: <why>" instead of a number and the NET line then says it excludes that broker. The `users*` row (real frontend users, from /strategyPnl) is NOT added to TOTAL / NET: their trades are already in the brokers' books.
# Paper is left out by the BROKER of each trade / position, never by a strategy's current config: a real trade of a strategy that is on paper now stays
# in BY STRATEGY and BY BROKER (their TOTALs agree), a paper trade never shows, and a paper-only strategy with no real trade has no row.
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
status net         brokers' own books, equal to each broker's figures (realized, unrealized, total per broker, proof-checked), a users* row (not in NET), then NET; manual orders included
status paper       paper-broker strategies (GammaBurst, HighLow on paper): config, paper positions and trades, log lines
status list        this list
LIST
  exit 0
fi; done
if [ "$NET" = 1 ]; then
  # `status net` (user's rule 2026-11-20: the brokers' OWN books, so manual / non-platform orders count too; 2026-11-25: realized, unrealized and total
  # must equal what each broker itself reports, rupee for rupee, 2 decimals). Per broker (all four use the broker's DAY-AVERAGE convention: realized =
  # sold qty * (average sell - average buy), unrealized = open qty * (ltp - average of the open side); NOT FIFO; checked against all three brokers' own fields):
  #   kite   = positions.day (today's trades only; `net` adds nothing for a contract traded today and would also carry earlier-day lots). Kite labels
  #            every pnl "unrealised" (realised is always 0), so the split is derived from its own buy/sell value and quantity fields with that convention.
  #   ant    = realizedPnl / unrealizedPnl of its positions (its own fields); proof MtoM = realized + unrealized.
  #   prism  = rpnl / urmtom of its positions (its own fields); proof (totsellamt - totbuyamt + netqty*lp) = rpnl + urmtom.
  #   breeze = reports no P&L (positions pnl is null), so derived from today's trade book with the same day-average convention; proof: net quantity
  #            and average price per open contract equal the broker's positions. No broker figure exists to compare the money with.
  # Any proof that fails, a carried-over contract (earlier-day quantity) or an unreadable book prints "ERROR: <why>" for that broker, never a different number.
  # The `users` row is the real frontend users (emails) from /strategyPnl; it is NOT part of TOTAL / NET (their trades are inside the brokers' books).
  K="$(curl -s -m20 "localhost:$PORT/broker/kite/positions")"; A="$(curl -s -m20 "localhost:$PORT/broker/ant/positions")"
  P="$(curl -s -m20 "localhost:$PORT/broker/prism/positions")"; B="$(curl -s -m20 "localhost:$PORT/broker/breeze/positions")"
  BT="$(curl -s -m20 "localhost:$PORT/broker/breeze/trades")"
  UQ="opened=$OPENED&match=%40"
  UU="$(curl -s -m10 "localhost:$PORT/strategyPnl?$UQ")"; UD="$(curl -s -m20 "localhost:$PORT/strategyPnl?detail=1&$UQ")"
  K="$K" A="$A" P="$P" B="$B" BT="$BT" UU="$UU" UD="$UD" node -e '
const parse=s=>{try{return JSON.parse(s)}catch{return null}};
const num=v=>{const n=parseFloat(v);return Number.isFinite(n)?n:0};
const has=v=>v!==null&&v!==undefined&&v!==""&&Number.isFinite(parseFloat(v));
const sum=(rows,f)=>rows.reduce((a,r)=>a+f(r),0);
const TOL=0.011; // broker figures carry paise; a proof may differ by float noise only
// Day-average split of one contract from its totals: bq/bv = bought qty/value, sq/sv = sold qty/value, q = net qty (signed), last = ltp (already x multiplier).
// long (q>=0): realized = sv - sq*avgBuy, unrealized = q*(last - avgBuy); short (q<0): realized = bq*avgSell - bv, unrealized = -q*(avgSell - last).
// realized + unrealized = sv - bv + q*last always (the broker total).
const split=(bq,bv,sq,sv,q,last)=>{
  if(q>=0){const ab=bq>0?bv/bq:0;return {r:sq>0?sv-sq*ab:0,u:q*(last-ab)}}
  const as=sq>0?sv/sq:0;return {r:bq>0?bq*as-bv:0,u:-q*(as-last)};
};
const kite=()=>{
  const k=parse(process.env.K);
  if(!(k&&k.success&&k.positions&&Array.isArray(k.positions.day)))return {name:"kite",err:"positions unavailable"};
  let r=0,u=0,tot=0;
  for(const p of k.positions.day){
    if(!has(p.pnl)||!has(p.buy_value)||!has(p.sell_value)||!has(p.quantity)||!has(p.last_price))return {name:"kite",err:"a position row is unreadable ("+p.tradingsymbol+")"};
    if(num(p.overnight_quantity)!==0)return {name:"kite",err:"carried-over contract "+p.tradingsymbol+" (earlier-day quantity): realized/unrealized split not derivable from the day row"};
    const m=num(p.multiplier)||1,s=split(num(p.buy_quantity),num(p.buy_value),num(p.sell_quantity),num(p.sell_value),num(p.quantity),num(p.last_price)*m);
    if(Math.abs(s.r+s.u-num(p.pnl))>TOL)return {name:"kite",err:"proof failed on "+p.tradingsymbol+": realized+unrealized "+(s.r+s.u).toFixed(2)+" != Kite pnl "+num(p.pnl).toFixed(2)};
    r+=s.r;u+=s.u;tot+=num(p.pnl);
  }
  if(Math.abs(r+u-tot)>TOL)return {name:"kite",err:"proof failed: total "+(r+u).toFixed(2)+" != sum of Kite pnl "+tot.toFixed(2)};
  return {name:"kite",r,u};
};
const ant=()=>{
  const a=parse(process.env.A);
  if(!(a&&a.success===true&&Array.isArray(a.positions)))return {name:"ant",err:"positions unavailable"};
  let r=0,u=0,tot=0;
  for(const p of a.positions){
    if(!has(p.realizedPnl)||!has(p.unrealizedPnl)||!has(p.MtoM))return {name:"ant",err:"a position row is unreadable ("+p.tradingSymbol+")"};
    if(num(p.overnightQuantity)!==0)return {name:"ant",err:"carried-over contract "+p.tradingSymbol+" (earlier-day quantity)"};
    if(Math.abs(num(p.realizedPnl)+num(p.unrealizedPnl)-num(p.MtoM))>TOL)return {name:"ant",err:"proof failed on "+p.tradingSymbol+": realized+unrealized != MtoM"};
    r+=num(p.realizedPnl);u+=num(p.unrealizedPnl);tot+=num(p.MtoM);
  }
  if(Math.abs(r+u-tot)>TOL)return {name:"ant",err:"proof failed: total != sum of MtoM"};
  return {name:"ant",r,u};
};
const prism=()=>{
  const p=parse(process.env.P);
  if(!(p&&p.success&&Array.isArray(p.positions)))return {name:"prism",err:"positions unavailable"};
  let r=0,u=0;
  for(const x of p.positions){
    if(!has(x.rpnl)||!has(x.urmtom)||!has(x.totbuyamt)||!has(x.totsellamt)||!has(x.netqty)||!has(x.lp))return {name:"prism",err:"a position row is unreadable ("+x.tsym+")"};
    if(num(x.cfbuyqty)!==0||num(x.cfsellqty)!==0)return {name:"prism",err:"carried-over contract "+x.tsym+" (earlier-day quantity)"};
    const t=(num(x.totsellamt)-num(x.totbuyamt)+num(x.netqty)*num(x.lp))*(num(x.mult)||1)*(num(x.prcftr)||1);
    // Prism rounds each row to paise but computes rpnl and urmtom from the unrounded averages: allow 1 rupee per row
    if(Math.abs(num(x.rpnl)+num(x.urmtom)-t)>1)return {name:"prism",err:"proof failed on "+x.tsym+": rpnl+urmtom "+(num(x.rpnl)+num(x.urmtom)).toFixed(2)+" != sell-buy+net*ltp "+t.toFixed(2)};
    r+=num(x.rpnl);u+=num(x.urmtom);
  }
  return {name:"prism",r,u};
};
const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const ist=new Date(Date.now()+330*60000);
const today=String(ist.getUTCDate()).padStart(2,"0")+"-"+MON[ist.getUTCMonth()]+"-"+ist.getUTCFullYear();
const breeze=()=>{
  const bt=parse(process.env.BT),b=parse(process.env.B);
  if(!(bt&&bt.success===true&&Array.isArray(bt.trades)))return {name:"breeze",err:"trade book unavailable"};
  if(!(b&&b.success===true&&Array.isArray(b.positions)))return {name:"breeze",err:"positions unavailable"};
  const key=t=>[t.expiry_date,num(t.strike_price),t.right].join("|");
  const rows=bt.trades;
  if(rows.length>=100&&rows[rows.length-1].trade_date===today)return {name:"breeze",err:"trade book is capped at 100 rows and today alone fills it"};
  const c=new Map();
  for(const t of rows.filter(t=>t.trade_date===today)){
    const q=num(t.quantity),px=num(t.average_cost);
    if(!(q>0)||!(px>0)||(t.action!=="Buy"&&t.action!=="Sell"))return {name:"breeze",err:"trade book has an unreadable row"};
    const k=key(t);if(!c.has(k))c.set(k,{bq:0,bv:0,sq:0,sv:0});const x=c.get(k);
    if(t.action==="Buy"){x.bq+=q;x.bv+=q*px}else{x.sq+=q;x.sv+=q*px}
  }
  const pos=new Map();
  for(const p of b.positions){const q=num(p.quantity);if(q>0)pos.set(key(p),{q:p.action==="Sell"?-q:q,avg:num(p.average_price),ltp:num(p.ltp)})}
  let r=0,u=0;
  for(const [k,x] of c){
    const q=x.bq-x.sq,p=pos.get(k);
    if(q!==0&&(!p||p.q!==q))return {name:"breeze",err:"proof failed: trade book net quantity "+q+" != positions for "+k};
    if(q===0&&p)return {name:"breeze",err:"proof failed: positions hold "+k+" the trade book has closed"};
    if(q!==0){
      if(!(p.ltp>0))return {name:"breeze",err:"no ltp for an open leg"};
      const avg=q>0?x.bv/x.bq:x.sv/x.sq;
      if(Math.abs(avg-p.avg)>0.051)return {name:"breeze",err:"proof failed: open average "+avg.toFixed(2)+" != positions average "+p.avg+" for "+k};
    }
    const s=split(x.bq,x.bv,x.sq,x.sv,q,q!==0?p.ltp:0);r+=s.r;u+=s.u;
  }
  for(const k of pos.keys())if(!c.has(k))return {name:"breeze",err:"carried-over contract "+k+" (no trade today)"};
  return {name:"breeze",r,u};
};
const brokers=[kite(),ant(),prism(),breeze()];
// users row: real frontend users (emails), same source as `status users`. Realized from the user rows, unrealized from the one ?detail=1 snapshot.
const users=()=>{
  const uu=parse(process.env.UU),ud=parse(process.env.UD);
  if(!Array.isArray(uu)||!Array.isArray(ud))return {name:"users",err:"cannot be computed: /strategyPnl unavailable"};
  const real=ud.filter(d=>d.broker!=="paper");
  return {name:"users",r:sum(uu,x=>num(x.realized)),u:sum(real,d=>num(d.unrealized))};
};
const f=n=>(n<0?"-":"")+Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const pad=(t,w)=>String(t).padStart(w);
let R=0,U=0;const bad=[];
console.log("BROKER   "+pad("REALIZED",14)+pad("UNREALIZED",14)+pad("TOTAL",14));
for(const x of brokers){
  if(x.r===undefined){console.log(x.name.padEnd(8)+"  ERROR: "+x.err);bad.push(x.name+" ("+x.err+")");continue}
  R+=x.r;U+=x.u;
  console.log(x.name.padEnd(8)+"  "+pad(f(x.r),14)+pad(f(x.u),14)+pad(f(x.r+x.u),14));
}
console.log("TOTAL   "+"  "+pad(f(R),14)+pad(f(U),14)+pad(f(R+U),14));
const us=users();
console.log(us.r===undefined?"users*    ERROR: "+us.err:"users*    "+pad(f(us.r),14)+pad(f(us.u),14)+pad(f(us.r+us.u),14));
console.log("* users = real frontend users (emails), trades opened "+(process.env.OPENED==="all"?"today or earlier":"today")+"; already inside the broker books above, NOT added to TOTAL / NET.");
console.log("");
console.log("NET "+f(R+U)+(bad.length?"  (EXCLUDES "+bad.join(", ")+")":""));'
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
const notPaper=rows=>rows.filter(r=>r.broker!=="paper"); // paper is reported only by "status paper" (a server that predates the real-only route still lists it)
const detail=notPaper(parse(process.env.DETAIL)||[]);
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
const byBroker=(parse(process.env.BY_BROKER)||[]).filter(r=>r.strategy!=="paper"&&r.broker!=="paper");
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
const closed=process.env.CLOSED_OK==="1"?(parse(process.env.CLOSED)||null)&&notPaper(parse(process.env.CLOSED)):null;
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
CLOSED_ALL="$(curl -s -m10 "localhost:$PORT/strategyPnl?closed=1&opened=$OPENED")"
ROOT="$(dirname "$(readlink -f "$0")")/.."
LOG="$(dirname "$(readlink -f "$0")")/../logs/orchestrator-$(TZ=Asia/Kolkata date +%F).log"
OPENED="$OPENED" PORT="$PORT" BY_STRATEGY="$BY_STRATEGY" DETAIL="$DETAIL" CLOSED_ALL="$CLOSED_ALL" LOG="$LOG" ROOT="$ROOT" node -e '
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
// Paper is excluded by the BROKER of each trade / position (never by the strategy'"'"'s current config: a strategy switched from kite to paper
// mid-day keeps its real trades). A server that predates the real-only /strategyPnl still mixes paper into its rows; the paper share is then
// taken out of the rows here from the per-trade (?closed=1) and per-position (?detail=1) lists, which carry the broker. A current server returns no paper.
const isPaperRow=r=>r&&r.broker==="paper";
const detailSnap=parse(process.env.DETAIL);
if(detailSnap)for(let i=detailSnap.length-1;i>=0;i--)if(isPaperRow(detailSnap[i]))detailSnap.splice(i,1);
{
  const paperShare=new Map();
  const share=s=>{if(!paperShare.has(s))paperShare.set(s,{realized:0,open:0,closed:0});return paperShare.get(s)};
  for(const t of (parse(process.env.CLOSED_ALL)||[]))if(isPaperRow(t)){const p=share(t.strategy);p.realized+=t.realizedPnL;p.closed++}
  for(const t of (parse(process.env.DETAIL)||[]))if(isPaperRow(t))share(t.strategy).open++;
  for(let i=byStrategy.length-1;i>=0;i--){
    const p=paperShare.get(byStrategy[i].strategy);if(!p)continue;
    const r=byStrategy[i];r.realized=+(r.realized-p.realized).toFixed(2);r.closed-=p.closed;r.open-=p.open;
    if(r.closed<=0&&r.open<=0)byStrategy.splice(i,1); // nothing real left: a paper-only strategy has no row
  }
}
// The source is the snapshot rows of the strategies the table covers (see keepDetail): a BY BROKER row summed over EVERY open position of that broker
// also counted real users and disabled strategies that the other tables leave out (2026-11-18: Breeze showed the user position on top).
const snapUnreal=(rows,key,src=detailSnap)=>{if(!src)return;for(const r of rows){const k=key(r);r.unrealized=src.filter(d=>key(d)===k).reduce((a,d)=>a+d.unrealized,0)}};
snapUnreal(byStrategy,r=>r.strategy);
// Strategies enabled in config.yml, named as the platform names its instances (src/util/strategyInstances.ts, compiled in dist/).
let enabledNames=null;
let zeroNames=new Set();
try{
  const {expandStrategyInstances}=require(process.env.ROOT+"/dist/util/strategyInstances.js");
  const cfg=require(process.env.ROOT+"/node_modules/js-yaml").load(require("fs").readFileSync(process.env.CONFIG_PATH||process.env.ROOT+"/config.yml","utf8"));
  // enabledNames: every enabled strategy (its REAL trades are listed even when its block is paper-only now). zeroNames: the ones shown with a
  // zero row before they trade; a paper-only block (brokers: [paper], in memory, nothing in Mongo) is not, since `paper` is reported only by "status paper".
  const isPaperOnly=c=>Array.isArray(c.brokers)&&c.brokers.length>0&&c.brokers.every(b=>b==="paper");
  enabledNames=new Set(expandStrategyInstances((cfg.strategies||[]).filter(c=>c&&c.enabled===true)).map(c=>c.userId||c.type));
  zeroNames=new Set(expandStrategyInstances((cfg.strategies||[]).filter(c=>c&&c.enabled===true&&!isPaperOnly(c))).map(c=>c.userId||c.type));
}catch(e){console.log("(could not read the enabled strategies from config.yml: "+e.message+")")}
// status (today): enabled strategies only (rule of 2026-11-13). status all: every strategy with trades, enabled or disabled/latched
// (rule of 2026-11-17), never the real users (their rows contain an @ sign).
const allMode=process.env.OPENED==="all";
const isUserName=n=>n.includes("@");
// The open positions every table must be built from: the same strategies as BY STRATEGY (enabled only; with `all` every non-user, non-paper one).
const keepDetail=s=>allMode?!isUserName(s):(!enabledNames||enabledNames.has(s));
const tableDetail=detailSnap?detailSnap.filter(d=>keepDetail(d.strategy)):null;
if(allMode){
  for(let i=byStrategy.length-1;i>=0;i--)if(isUserName(byStrategy[i].strategy))byStrategy.splice(i,1);
}else if(enabledNames){
  for(let i=byStrategy.length-1;i>=0;i--)if(!enabledNames.has(byStrategy[i].strategy))byStrategy.splice(i,1);
  const have=new Set(byStrategy.map(r=>r.strategy));
  for(const name of zeroNames)if(!have.has(name))byStrategy.push({strategy:name,realized:0,unrealized:0,open:0,closed:0});
}
byStrategy.sort((a,b)=>a.strategy.localeCompare(b.strategy));
if(!byStrategy.length){console.log("no strategy enabled and no trades this session");process.exit(0)}
console.log(process.env.OPENED==="all"?"(all trades: also those opened on an earlier day)":"(trades opened today only; `all` adds earlier-day trades closed or still open today)");
table("BY STRATEGY",byStrategy);
const esc=n=>n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const matchQ=allMode?"&match="+encodeURIComponent("^[^@]+$"):(enabledNames?"&match="+encodeURIComponent("^("+[...enabledNames].map(esc).join("|")+")$"):"");
const byBroker=parse(require("child_process").execFileSync("curl",["-s","-m10","localhost:"+process.env.PORT+"/strategyPnl?by=broker&opened="+process.env.OPENED+matchQ]).toString());
if(byBroker){for(let i=byBroker.length-1;i>=0;i--)if(byBroker[i].strategy==="paper"||byBroker[i].broker==="paper")byBroker.splice(i,1)} // paper is its own broker row on a server that predates the real-only route
if(byBroker)snapUnreal(byBroker,r=>r.broker??r.strategy,tableDetail);
// An empty array is a valid answer (no trades yet). A server that predates ?by=broker ignores it and returns BY STRATEGY rows (named by strategy,
// not by broker), so a row whose name is a strategy of the table above (and no broker name) means the option is missing; null = no/unparseable reply.
const brokerNames=new Set(["kite","ant","breeze","prism","shoonya","paper"]);
const oldServer=byBroker&&byBroker.some(r=>!brokerNames.has(r.strategy)&&byStrategy.some(s=>s.strategy===r.strategy));
if(!byBroker||oldServer)console.log("\n(by-broker table unavailable: "+(byBroker?"the API process predates the ?by=broker option - restart it":"no valid reply from the API")+")");
else if(byBroker.length){console.log("");table("BY BROKER",byBroker)}
else console.log("\nBY BROKER: no trades");

// ---- Unrealized by broker and strategy, per open position ----
const detail=parse(process.env.DETAIL);
if(detail){
  for(let i=detail.length-1;i>=0;i--){
    const s=detail[i].strategy;
    if(isPaperRow(detail[i])||!keepDetail(s))detail.splice(i,1);
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
