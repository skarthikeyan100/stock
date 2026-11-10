/**
 * Exit-grid and win-rate lever analysis for the RuleBasedStrategy block in config.yml, replayed through the compiled backtest engine
 * (dist/, so run `npx tsc` first if src/ changed; this script does not compile anything).
 *
 *   npm run analyze:ruleBlockGrid   -- every exit cell (target x stop x timeout) for the block: win %, net, profit factor, drawdown
 *   npm run analyze:ruleBlockLevers -- direction / time-of-day / consensus / leave-one-rule-out / each-rule-alone at three exits
 *
 * Options: --allDays <dir> (default ~/later/data/backups), --userId <id> (pick one RuleBased block).
 */
const path=require('path');
const os=require('os');
process.env.MOCK_BROKER=process.env.MOCK_BROKER||'true';
const R=path.join(__dirname,'..','dist')+path.sep;
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>=0?process.argv[i+1]:d;};
const {loadDays}=require(R+'tools/ruleBacktest/data.js');
const G=require(R+'tools/ruleBacktest/grid.js');
const E=require(R+'tools/ruleBacktest/engine.js');
const {parseRuleLines,parseRuleIndicator}=require(R+'strategy/ruleIndicators.js');
const configService=require(R+'prism/ConfigService.js').default;
const userId=arg('userId','');
const block=(configService.getConfig().strategies||[]).filter(s=>s.type==='RuleBasedStrategy'&&(!userId||s.userId===userId))[0];
if(!block)throw new Error('no RuleBasedStrategy block in config.yml');
const lines=parseRuleLines(block.indicators);
lines.forEach(l=>l.forEach(n=>parseRuleIndicator(n)));
const names=G.allIndicatorNames();const ni=new Map(names.map((n,i)=>[n,i]));
const parsed=E.parseAll(names);
const days=loadDays(arg('allDays',path.join(os.homedir(),'later','data','backups')));
const idys=days.map(d=>E.buildIntervalDay(d,300,parsed,100));
const ruleIdx=lines.map(l=>l.map(n=>ni.get(n)));
const costs={costPerTrade:0,slippagePoints:0};
let CI=1000;function cell(t,s,m){return {index:CI++,label:`T=${t??'none'} S=${s??'none'} M=${m}`,target:t==null?{kind:'none'}:{kind:'points',value:t},stop:s==null?{kind:'none'}:{kind:'points',value:s},timeoutMinutes:m,ti:-1,si:-1,mi:-1};}
function run(dirsByDay,c,filter){
  let n=0,w=0,net=0,gp=0,gl=0,seq=[],dn=[];
  idys.forEach((idy,d)=>{const ts=E.rulesTrades(idy,dirsByDay[d],c,costs).filter(filter||(()=>true));let s=0;for(const t of ts){n++;if(t.pnl>0){w++;gp+=t.pnl}else gl-=t.pnl;net+=t.pnl;s+=t.pnl;seq.push(t.pnl)}dn.push(s)});
  let cum=0,pk=0,dd=0;for(const p of seq){cum+=p;pk=Math.max(pk,cum);dd=Math.max(dd,pk-cum)}
  return {n,w:n?w/n:0,net:Math.round(net),pf:gl>0?gp/gl:Infinity,dd:Math.round(dd),pos:dn.filter(x=>x>0).length,dn:dn.map(Math.round)};
}
const base=idys.map(idy=>E.blockDirections(idy,ruleIdx,true).dirs);
module.exports={idys,days,lines,ruleIdx,base,run,cell,E};
if(require.main===module&&!process.env.RULE_BLOCK_AS_LIB){
  const rows=[];
  for(const t of [5,7,10,12,15,20,null])for(const s of [null,10,15,20,30,40])for(const m of [15,30,60,90]){
    const r=run(base,cell(t,s,m));rows.push({l:cell(t,s,m).label,...r});}
  rows.sort((a,b)=>b.w-a.w||b.net-a.net);
  const f=r=>`${r.l.padEnd(22)} n=${String(r.n).padStart(3)} win=${(r.w*100).toFixed(1).padStart(5)}% net=${String(r.net).padStart(7)} pf=${r.pf.toFixed(2).padStart(5)} dd=${String(r.dd).padStart(6)} days+=${r.pos}/4 [${r.dn.join(',')}]`;
  console.log(`Block: ${lines.length} rules, ${days.length} days (${days.map(d=>d.day).join(', ')})\n`);
  console.log('TOP BY WIN RATE (net>0):');rows.filter(r=>r.net>0).slice(0,15).forEach(r=>console.log(f(r)));
  console.log('\nTOP BY NET:');[...rows].sort((a,b)=>b.net-a.net).slice(0,10).forEach(r=>console.log(f(r)));
  console.log('\nT10 with stops, M60:');rows.filter(r=>r.l.startsWith('T=10 ')&&r.l.endsWith('M=60')).forEach(r=>console.log(f(r)));
  console.log('\nT10 with stops, M30:');rows.filter(r=>r.l.startsWith('T=10 ')&&r.l.endsWith('M=30')).forEach(r=>console.log(f(r)));
}

if(require.main===module)process.exit(0);
