/**
 * Builds the trimmed tick file the anonymous /demo page replays IN THE BROWSER (frontend/public/demo-ticks.csv), so Try Demo works with no
 * server and no market. Reads one recorded day from the daily backup layout `<dir>/<Mon-DD>/csv/{Quote,OptionQuote}.csv`, keeps NIFTY only
 * and thins each series (the index and every option contract separately) to its first row plus every Nth row.
 *
 *   npx tsc && node dist/tools/makeDemoTicks.js Nov-13 [every=10] [outFile=frontend/public/demo-ticks.csv] [dir=~/later/data/backups]
 *
 * Output has only the columns the page needs: `ltt` (epoch seconds as recorded), `sym` ('NIFTY' or the option trading symbol, which carries
 * strike and CE/PE), `ltp`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

export const DEMO_TICKS_HEADER = 'ltt,sym,ltp';

export function splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
        } else if (ch === ',' && !quoted) {
            out.push(cur);
            cur = '';
        } else cur += ch;
    }
    out.push(cur);
    return out;
}

function expandHome(p: string): string {
    return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

interface Tick { ltt: number; sym: string; ltp: string }

async function readRows(file: string, onRow: (row: Record<string, string>) => void): Promise<void> {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity });
    let header: string[] | null = null;
    for await (const line of rl) {
        if (!line) continue;
        const cells = splitCsvLine(line);
        if (!header) { header = cells; continue; }
        const row: Record<string, string> = {};
        for (let i = 0; i < header.length; i++) row[header[i]] = cells[i];
        onRow(row);
    }
}

/** Keeps the first row of every series and then every `every`-th row of that series (counted per series). */
export class Decimator {
    private readonly seen = new Map<string, number>();
    constructor(private readonly every: number) {
        if (!Number.isInteger(every) || every < 1) throw new Error(`every must be a positive integer, got ${every}`);
    }
    keep(sym: string): boolean {
        const n = this.seen.get(sym) ?? 0;
        this.seen.set(sym, n + 1);
        return n === 0 || n % this.every === 0;
    }
}

export async function buildDemoTicks(dirSetting: string, date: string, every: number): Promise<string> {
    if (!/^[A-Za-z]{3}-\d{2}$/.test(date)) throw new Error(`date must look like "Nov-13", got ${JSON.stringify(date)}`);
    const csv = path.join(expandHome(dirSetting), date, 'csv');
    const quoteFile = path.join(csv, 'Quote.csv');
    const optionFile = path.join(csv, 'OptionQuote.csv');
    for (const f of [quoteFile, optionFile]) if (!fs.existsSync(f)) throw new Error(`file missing: ${f}`);
    const dec = new Decimator(every);
    const ticks: Tick[] = [];
    await readRows(quoteFile, (r) => {
        if (r.index !== 'NIFTY') return;
        const ltp = Number(r.ltp);
        const ltt = Number(r.ltt);
        if (!(ltp > 0) || !Number.isFinite(ltt)) return;
        if (dec.keep('NIFTY')) ticks.push({ ltt, sym: 'NIFTY', ltp: String(ltp) });
    });
    await readRows(optionFile, (r) => {
        if (r.index !== 'NIFTY' || (r.optionType !== 'CE' && r.optionType !== 'PE') || !r.tsym) return;
        const ltp = Number(r.ltp);
        const ltt = Number(r.ltt);
        if (!(ltp > 0) || !Number.isFinite(ltt)) return;
        if (dec.keep(r.tsym)) ticks.push({ ltt, sym: r.tsym, ltp: String(ltp) });
    });
    if (!ticks.some((t) => t.sym === 'NIFTY')) throw new Error(`no NIFTY ticks in ${quoteFile}`);
    ticks.sort((a, b) => a.ltt - b.ltt); // stable: ties keep NIFTY (pushed first) ahead of options
    return [DEMO_TICKS_HEADER, ...ticks.map((t) => `${t.ltt},${t.sym},${t.ltp}`)].join('\n') + '\n';
}

if (require.main === module) {
    const [date, everyArg, outArg, dirArg] = process.argv.slice(2);
    if (!date) { console.error('usage: makeDemoTicks <Mon-DD> [every=10] [outFile] [dir]'); process.exit(2); }
    const out = outArg || path.join(__dirname, '../../frontend/public/demo-ticks.csv');
    buildDemoTicks(dirArg || '~/later/data/backups', date, everyArg ? Number(everyArg) : 10)
        .then((text) => { fs.writeFileSync(out, text); console.log(`wrote ${out}: ${text.split('\n').length - 2} rows, ${(text.length / 1024).toFixed(0)} KB`); })
        .catch((e) => { console.error(e.message); process.exit(1); });
}
