/**
 * Demo replay (src/tools/tickReplay.ts): CSV loading from the daily backup layout, previous-close lookup, tsym handling and paced,
 * ordered emission with the day loop. Uses a tiny fixture in a temp dir (no Mongo, no broker, no network).
 * Run: npx tsc && node ./dist/test/demoReplay.test.js
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadReplayDay, splitCsvLine, TickReplayer, lastNiftyTickOfFile } from '../tools/tickReplay';

let failed = false;
function assert(cond: boolean, msg: string) {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
    if (!cond) { failed = true; process.exitCode = 1; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QUOTE_HEADER = '"_id","ltp","ltt","token","time","index"';
const OPTION_HEADER = '"_id","ltp","ltt","time","tsym","index","strike","optionType","vol","tbq","tsq","oi"';

function writeDay(root: string, day: string, base: number, nifty: number[], opts: [string, number, number][]) {
    const dir = path.join(root, day, 'csv');
    fs.mkdirSync(dir, { recursive: true });
    const q = [QUOTE_HEADER, `"a",81000,${base},"1","t","SENSEX"`];
    nifty.forEach((p, i) => q.push(`"n${i}",${p},${base + i},"26000","t","NIFTY"`));
    fs.writeFileSync(path.join(dir, 'Quote.csv'), q.join('\n') + '\n');
    const o = [OPTION_HEADER, `"s",5,${base},"t","SENSEX26N1981800PE","SENSEX",81800,"PE",1,1,1,`];
    for (const [tsym, ltp, off] of opts) {
        const m = /([CP])(\d+)$/.exec(tsym)!;
        o.push(`"o",${ltp},${base + off},"t","${tsym}","NIFTY",${m[2]},"${m[1] === 'C' ? 'CE' : 'PE'}",1,1,1,`);
    }
    fs.writeFileSync(path.join(dir, 'OptionQuote.csv'), o.join('\n') + '\n');
}

async function main() {
    console.log('splitCsvLine');
    assert(JSON.stringify(splitCsvLine('"a","b,c",3,"d""e"')) === JSON.stringify(['a', 'b,c', '3', 'd"e']), 'quotes, embedded comma and doubled quote');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demoReplay-'));
    try {
        writeDay(root, 'Nov-12', 1000, [100, 101, 102], []);
        writeDay(root, 'Nov-13', 2000, [200, 201, 202, 203], [['NIFTY17NOV26C25150', 10, 1], ['NIFTY17NOV26P25150', 11, 2]]);

        console.log('loadReplayDay');
        const day = await loadReplayDay(root, 'Nov-13');
        assert(day.nifty.length === 4, 'only NIFTY index rows are kept (SENSEX dropped)');
        assert(day.options.length === 2 && day.options.every((o) => o.tsym.startsWith('NIFTY')), 'only NIFTY option rows are kept');
        assert(day.options[0].strike === 25150 && day.options[0].optionType === 'CE' && day.options[1].optionType === 'PE', 'strike and side parsed');
        assert(day.prevClose === 102, 'prevClose = last NIFTY tick of the earlier recorded day');
        assert(lastNiftyTickOfFile(path.join(root, 'Nov-12', 'csv', 'Quote.csv'))?.ltp === 102, 'tail read finds the last NIFTY tick');
        let threw = false;
        try { await loadReplayDay(root, 'Nov-99'); } catch { threw = true; }
        assert(threw, 'missing day throws');
        threw = false;
        try { await loadReplayDay(root, '../etc'); } catch { threw = true; }
        assert(threw, 'a date that is not <Mon-DD> is refused (no path traversal)');

        console.log('TickReplayer');
        const seen: string[] = [];
        let run = true;
        const r = new TickReplayer(day, () => 1000, { nifty: (t) => seen.push(`n${t.ltp}`), option: (t) => seen.push(`o${t.tsym.slice(-6)}`) }, () => run, 40);
        r.start();
        await sleep(300);
        assert(seen.slice(0, 6).join(',') === 'n200,n201,oC25150,n202,oP25150,n203', `ticks come out in recorded-time order (got ${seen.slice(0, 6).join(',')})`);
        assert(seen.length > 6, 'the day loops after the end');
        run = false;
        await sleep(100);
        const parkedAt = seen.length;
        await sleep(150);
        assert(seen.length === parkedAt && !r.running, 'parks when shouldRun is false (nothing emitted, timer cleared)');
        run = true;
        r.start();
        await sleep(100);
        assert(seen.length > parkedAt, 'resumes on start()');
        r.stop();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(failed ? 'FAILED' : 'ALL PASSED');
}
main().catch((e) => { console.error(e); process.exit(1); });
