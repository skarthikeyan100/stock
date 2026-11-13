/**
 * Demo tick file generator (src/tools/makeDemoTicks.ts): columns, per-series decimation, first-row retention, ordering, NIFTY-only.
 * Run: npx tsc && node ./dist/test/makeDemoTicks.test.js
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildDemoTicks, Decimator, DEMO_TICKS_HEADER, splitCsvLine } from '../tools/makeDemoTicks';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) console.log(`  ok  ${name}`);
    else { failed++; console.log(`  FAIL ${name}`, detail ?? ''); }
}

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demoTicks-'));
    const csv = path.join(root, 'Nov-13', 'csv');
    fs.mkdirSync(csv, { recursive: true });
    const q = ['"_id","ltp","ltt","token","time","index"', '"a",81000,1000,"1","t","SENSEX"'];
    for (let i = 0; i < 25; i++) q.push(`"n${i}",${25000 + i},${1000 + i},"26000","t","NIFTY"`);
    fs.writeFileSync(path.join(csv, 'Quote.csv'), q.join('\n') + '\n');
    const o = ['"_id","ltp","ltt","time","tsym","index","strike","optionType","vol","tbq","tsq","oi"'];
    for (let i = 0; i < 12; i++) o.push(`"c${i}",${100 + i},${1000 + i},"t","NIFTY17NOV26C25150","NIFTY",25150,"CE",1,1,1,`);
    o.push('"p0",90,1000,"t","NIFTY17NOV26P25150","NIFTY",25150,"PE",1,1,1,');
    o.push('"b0",50,1000,"t","BANKNIFTY17NOV26C55000","BANKNIFTY",55000,"CE",1,1,1,');
    o.push('"z0",0,1001,"t","NIFTY17NOV26C25200","NIFTY",25200,"CE",1,1,1,'); // ltp 0 is not a price
    fs.writeFileSync(path.join(csv, 'OptionQuote.csv'), o.join('\n') + '\n');

    const text = await buildDemoTicks(root, 'Nov-13', 10);
    const lines = text.trim().split('\n');
    check('header is exactly the three needed columns', lines[0] === DEMO_TICKS_HEADER && DEMO_TICKS_HEADER === 'ltt,sym,ltp');
    const rows = lines.slice(1).map(splitCsvLine);
    check('every row has 3 cells', rows.every((r) => r.length === 3));
    const bySym = (s: string) => rows.filter((r) => r[1] === s);
    check('NIFTY: first row + every 10th of 25 -> rows 0,10,20', bySym('NIFTY').map((r) => r[2]).join() === '25000,25010,25020', bySym('NIFTY'));
    check('call series thinned separately: rows 0,10 of 12', bySym('NIFTY17NOV26C25150').map((r) => r[2]).join() === '100,110');
    check('a series with one row keeps its first row', bySym('NIFTY17NOV26P25150').length === 1);
    check('SENSEX / BANKNIFTY / zero-price rows are dropped', !rows.some((r) => r[1] === 'SENSEX' || r[1].startsWith('BANKNIFTY') || r[1].endsWith('C25200')));
    check('sorted by ltt', rows.every((r, i) => i === 0 || Number(rows[i - 1][0]) <= Number(r[0])));
    check('no quoted cells or extra columns', !text.includes('"'));

    let threw = false;
    try { await buildDemoTicks(root, '2026-11-13', 10); } catch { threw = true; }
    check('bad date rejected', threw);
    threw = false;
    try { new Decimator(0); } catch { threw = true; }
    check('every=0 rejected', threw);

    fs.rmSync(root, { recursive: true, force: true });
    console.log(failed ? `\n${failed} FAILED` : '\nall passed');
    process.exit(failed ? 1 : 0);
}
main();
