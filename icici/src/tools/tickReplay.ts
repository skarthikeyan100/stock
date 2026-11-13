/**
 * Loader + paced replayer for one recorded day of NIFTY ticks, used by the anonymous /demo page when the market is closed
 * (settings.demoReplay). Reads the daily backup layout `<dir>/<Mon-DD>/csv/{Quote,OptionQuote}.csv` (the same files the backtests use).
 * Pure/IO-light on purpose: no Express, no broker, so it can be unit-tested with a tiny fixture.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

export interface ReplayIndexTick { ltp: number; ltt: number } // ltt = epoch seconds, as in the CSV and in the live ANT feed
export interface ReplayOptionTick { tsym: string; strike: number; optionType: 'CE' | 'PE'; ltp: number; ltt: number }
export interface ReplayDay {
    date: string;
    nifty: ReplayIndexTick[];
    options: ReplayOptionTick[];
    prevClose?: number; // last NIFTY tick of the previous recorded day, when that folder exists
}

export const DEFAULT_REPLAY_DIR = '~/later/data/backups';

export function expandHome(p: string): string {
    return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

// CSV fields here are always quoted or plain, never contain embedded commas; the splitter still honours quotes to be safe.
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

async function forEachRow(file: string, onRow: (row: Record<string, string>) => void): Promise<void> {
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

async function loadIndexTicks(file: string): Promise<ReplayIndexTick[]> {
    const ticks: ReplayIndexTick[] = [];
    await forEachRow(file, (r) => {
        if (r.index !== 'NIFTY') return;
        const ltp = Number(r.ltp);
        const ltt = Number(r.ltt);
        if (Number.isFinite(ltp) && ltp > 0 && Number.isFinite(ltt)) ticks.push({ ltp, ltt });
    });
    ticks.sort((a, b) => a.ltt - b.ltt);
    return ticks;
}

async function loadOptionTicks(file: string): Promise<ReplayOptionTick[]> {
    const ticks: ReplayOptionTick[] = [];
    await forEachRow(file, (r) => {
        if (r.index !== 'NIFTY' || (r.optionType !== 'CE' && r.optionType !== 'PE')) return;
        const ltp = Number(r.ltp);
        const ltt = Number(r.ltt);
        if (!(ltp > 0) || !Number.isFinite(ltt) || !r.tsym) return;
        ticks.push({ tsym: r.tsym, strike: Number(r.strike), optionType: r.optionType, ltp, ltt });
    });
    ticks.sort((a, b) => a.ltt - b.ltt);
    return ticks;
}

// Previous trading day's close: the other folders' last NIFTY tick that is still earlier than this day's first tick (latest wins). Only the
// tail of each Quote.csv is read, so this costs milliseconds, not a parse of every day.
export function lastNiftyTickOfFile(file: string): ReplayIndexTick | undefined {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 256 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString('utf-8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes(',"NIFTY"')) continue;
            const c = splitCsvLine(lines[i]);
            const ltp = Number(c[1]);
            const ltt = Number(c[2]);
            if (ltp > 0 && Number.isFinite(ltt)) return { ltp, ltt };
        }
        return undefined;
    } finally {
        fs.closeSync(fd);
    }
}

function findPrevClose(root: string, date: string, firstLtt: number): number | undefined {
    let best: ReplayIndexTick | undefined;
    for (const d of fs.readdirSync(root)) {
        if (d === date) continue;
        const file = path.join(root, d, 'csv', 'Quote.csv');
        if (!fs.existsSync(file)) continue;
        let last: ReplayIndexTick | undefined;
        try { last = lastNiftyTickOfFile(file); } catch { continue; }
        if (last && last.ltt < firstLtt && (!best || last.ltt > best.ltt)) best = last;
    }
    return best?.ltp;
}

export async function loadReplayDay(dirSetting: string | undefined, date: string): Promise<ReplayDay> {
    if (!/^[A-Za-z]{3}-\d{2}$/.test(date)) throw new Error(`demoReplayDate must look like "Nov-13", got ${JSON.stringify(date)}`);
    const root = expandHome(dirSetting || DEFAULT_REPLAY_DIR);
    const csv = path.join(root, date, 'csv');
    const quoteFile = path.join(csv, 'Quote.csv');
    const optionFile = path.join(csv, 'OptionQuote.csv');
    for (const f of [quoteFile, optionFile]) if (!fs.existsSync(f)) throw new Error(`replay file missing: ${f}`);
    const nifty = await loadIndexTicks(quoteFile);
    const options = await loadOptionTicks(optionFile);
    if (nifty.length === 0) throw new Error(`no NIFTY ticks in ${quoteFile}`);
    const prevClose = findPrevClose(root, date, nifty[0].ltt);
    return { date, nifty, options, prevClose };
}

export interface ReplaySink {
    nifty(t: ReplayIndexTick): void;
    option(t: ReplayOptionTick): void;
}

/**
 * Emits a ReplayDay to a sink paced by the recorded timestamps divided by `speed` (live speed lookup, so changing it in config applies at
 * once), and restarts from the open when the day ends. `shouldRun` is asked on every step: returning false parks the replayer (it keeps its
 * position) so an unwatched demo costs nothing; call start() again to resume.
 */
export class TickReplayer {
    private ni = 0;
    private oi = 0;
    private timer: NodeJS.Timeout | null = null;
    private virtualBaseMs = 0;
    private realBaseMs = 0;
    private lastSpeed = 0;

    constructor(
        private readonly day: ReplayDay,
        private readonly getSpeed: () => number,
        private readonly sink: ReplaySink,
        private readonly shouldRun: () => boolean = () => true,
        private readonly restartDelayMs = 3000,
    ) {}

    get running(): boolean { return this.timer !== null; }

    start(): void {
        if (this.timer) return;
        this.reanchor(this.currentVirtualMs());
        this.schedule(0);
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private firstMs(): number {
        const n = this.day.nifty[0]?.ltt ?? Infinity;
        const o = this.day.options[0]?.ltt ?? Infinity;
        return Math.min(n, o) * 1000;
    }

    private currentVirtualMs(): number {
        // Position = the next unemitted tick (so a resume continues exactly where it parked).
        const n = this.day.nifty[this.ni]?.ltt ?? Infinity;
        const o = this.day.options[this.oi]?.ltt ?? Infinity;
        const next = Math.min(n, o);
        return Number.isFinite(next) ? next * 1000 : this.firstMs();
    }

    private reanchor(virtualMs: number): void {
        this.virtualBaseMs = virtualMs;
        this.realBaseMs = Date.now();
        this.lastSpeed = this.speed();
    }

    private speed(): number {
        const s = Number(this.getSpeed());
        return Number.isFinite(s) && s > 0 ? s : 1;
    }

    private schedule(delayMs: number): void {
        this.timer = setTimeout(() => this.step(), Math.max(0, delayMs));
        this.timer.unref?.();
    }

    private step(): void {
        this.timer = null;
        if (!this.shouldRun()) {
            // Parked: not rescheduled. The caller's start() re-anchors, so the virtual clock resumes from the parked tick.
            return;
        }
        const speed = this.speed();
        if (speed !== this.lastSpeed) {
            this.reanchor(this.virtualBaseMs + (Date.now() - this.realBaseMs) * this.lastSpeed);
        }
        const virtual = this.virtualBaseMs + (Date.now() - this.realBaseMs) * this.lastSpeed;
        const { nifty, options } = this.day;
        for (;;) {
            const n = this.ni < nifty.length ? nifty[this.ni] : undefined;
            const o = this.oi < options.length ? options[this.oi] : undefined;
            if (!n && !o) break;
            const takeNifty = !!n && (!o || n.ltt <= o.ltt);
            const t = takeNifty ? n!.ltt : o!.ltt;
            if (t * 1000 > virtual) break;
            if (takeNifty) { this.ni++; this.sink.nifty(n!); } else { this.oi++; this.sink.option(o!); }
        }
        if (this.ni >= nifty.length && this.oi >= options.length) {
            // End of day: pause, then loop from the open. The virtual clock is anchored to the open at (now + pause), so nothing is
            // emitted until the pause is over.
            this.ni = 0;
            this.oi = 0;
            this.virtualBaseMs = this.firstMs();
            this.realBaseMs = Date.now() + this.restartDelayMs;
            this.schedule(this.restartDelayMs);
            return;
        }
        const nextT = Math.min(nifty[this.ni]?.ltt ?? Infinity, options[this.oi]?.ltt ?? Infinity) * 1000;
        const wait = (nextT - virtual) / this.lastSpeed;
        this.schedule(Math.min(1000, Math.max(20, wait)));
    }
}
