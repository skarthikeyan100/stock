process.env.RULE_BLOCK_AS_LIB='1';
const {idys,days,lines,ruleIdx,base,run,cell,E}=require('./ruleBlockGrid.js');
const f=(l,r)=>`${l.padEnd(34)} n=${String(r.n).padStart(3)} win=${(r.w*100).toFixed(1).padStart(5)}% net=${String(r.net).padStart(7)} pf=${r.pf.toFixed(2).padStart(5)} dd=${String(r.dd).padStart(6)} d+=${r.pos}/4 [${r.dn.join(',')}]`;
const cells=[['T10',cell(10,null,60)],['T7',cell(7,null,60)],['T12',cell(12,null,60)]];
const hr=(ms)=>{const d=new Date(ms+5.5*3600e3);return d.getUTCHours()+d.getUTCMinutes()/60};
const mask=(fn)=>base.map((dd,d)=>dd.map((v,c)=>fn(v,idys[d].ltt[c],c,d)?v:0));
for(const [cn,c] of cells){
  console.log('\n=====',cn,'S=none M=60');
  console.log(f('baseline block',run(base,c)));
  console.log(f('CE only',run(mask(v=>v===1),c)));
  console.log(f('PE only',run(mask(v=>v===-1),c)));
  for(const [a,b] of [[10,11],[11,12],[12,13],[13,14],[14,15]])console.log(f(`only entries ${a}-${b}h`,run(mask((v,t)=>hr(t)>=a&&hr(t)<b),c)));
  console.log(f('skip 11-12h',run(mask((v,t)=>!(hr(t)>=11&&hr(t)<12)),c)));
  console.log(f('skip 10:00-10:30 & 11-12',run(mask((v,t)=>!(hr(t)>=11&&hr(t)<12)&&!(hr(t)<10.5)),c)));
  // min rules agree
  for(const k of [2,3]){
    const per=idys.map(idy=>ruleIdx.map(ix=>E.ruleDirections(idy,ix,true)));
    const dd=idys.map((idy,d)=>{const o=new Int8Array(idy.ltt.length);for(let i=0;i<o.length;i++){let up=0,dn=0;per[d].forEach(p=>{if(p[i]===1)up++;else if(p[i]===-1)dn++});if(up>=k&&dn===0)o[i]=1;else if(dn>=k&&up===0)o[i]=-1}return o});
    console.log(f(`>=${k} rules agree (no opposing)`,run(dd,c)));
  }
  // leave one rule out
  const res=[];
  lines.forEach((l,r)=>{const ix=ruleIdx.filter((_,i)=>i!==r);const dd=idys.map(idy=>E.blockDirections(idy,ix,true).dirs);res.push([l.join('+'),run(dd,c)])});
  res.sort((a,b)=>b[1].w-a[1].w);
  console.log('leave-one-rule-out (top3 by win, bottom2):');res.slice(0,3).concat(res.slice(-2)).forEach(([l,r])=>console.log(f('  -'+l,r)));
}
// single rule performance at T10
console.log('\n===== each rule alone, T10 S=none M60');
lines.forEach((l,r)=>{const dd=idys.map(idy=>E.ruleDirections(idy,ruleIdx[r],true));console.log(f(l.join('+'),run(dd,cell(10,null,60))))});

process.exit(0);
