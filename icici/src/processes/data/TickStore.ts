// Tick history of every OPTION contract the platform receives ticks for (any broker's feed), in Mongo collection `tickHistory`, so a day can
// be replayed afterwards (prices of any strike at any second, stops, latches, unrealized P&L). Only option ticks are stored: index, future,
// VIX and every other instrument are never recorded (a token is an option only when the contract master says CE/PE).
//
// The tick path only calls record(): a push on an in-memory array (bounded, drops counted), never a Mongo call and never a throw. A 1 s timer
// (or 2000 queued ticks) flushes with insertMany(ordered:false) in the data process. The data is disposable: a TTL index on `at` (36 h) and a
// startup purge of earlier IST days remove it by the next morning; today's documents are never purged.
import Log from '../../util/Log';
import { istDay, optionKey, expiryYmdOfMs } from '../../util/tickKey';

export const TICK_COLLECTION = 'tickHistory';
export const TTL_SECONDS = 36 * 3600;
export const MAX_BUFFER = 100_000; // ticks; ~50 MB at worst, 100x the normal per-second rate
export const FLUSH_MS = 1000;
export const FLUSH_AT = 2000;
const MAX_BATCH = 5000;
const PREPARE_RETRY_MS = 30_000;
const LOG_EVERY_MS = 60_000;
const NEGATIVE_CACHE_MS = 60_000;

export type TickSource = 'ant' | 'breeze';
export interface RawOptionTick {
    src: TickSource;
    exch: string;
    tk: string;
    t: number; // receive time, ms epoch
    ltp?: number; v?: number; ap?: number; bp?: number; sp?: number; bq?: number; sq?: number; tbq?: number; tsq?: number; oi?: number;
    ft?: string | number; // the exchange's own time field, as received
}
export interface ContractMeta { tsym: string; u: string; exp: string; k: number; ot: 'CE' | 'PE'; key: string }
// option: a CE/PE contract; skip: a known instrument that is not an option (never stored, not an error); unknown: not in the master (counted, logged).
export type Resolution = { kind: 'option'; meta: ContractMeta } | { kind: 'skip' } | { kind: 'unknown' };

export interface CollectionLike {
    insertMany(docs: any[], opts?: any): Promise<any>;
    createIndex(spec: any, opts?: any): Promise<any>;
    deleteMany(filter: any): Promise<{ deletedCount?: number }>;
}
export interface TickStoreDeps {
    getCollection(): Promise<CollectionLike | null>; // null / rejects while Mongo is not connected
    resolve(src: TickSource, exch: string, token: string): Promise<Resolution>;
    enabled(): boolean;
    now(): number;
    log(msg: string): void;
}

const num = (x: unknown): number | undefined => {
    if (x === undefined || x === null || x === '') return undefined;
    const n = typeof x === 'number' ? x : parseFloat(String(x));
    return Number.isFinite(n) ? n : undefined;
};

// ANT (Noren) touchline / depth update: fields are strings, partial (only what changed).
export function fromAntTick(d: any, exch: string, t: number): RawOptionTick | null {
    const ltp = num(d.lp), bp = num(d.bp1), sp = num(d.sp1);
    if (ltp === undefined && bp === undefined && sp === undefined) return null; // a depth update with neither a price nor a bid/ask for the contract
    return { src: 'ant', exch, tk: String(d.tk), t, ltp, v: num(d.v), ap: num(d.ap), bp, sp, bq: num(d.bq1 ?? d.bs1), sq: num(d.sq1 ?? d.ss1), tbq: num(d.tbq), tsq: num(d.tsq), oi: num(d.oi), ft: d.ft };
}

// Breeze exchange-quotes tick (symbol "4.1!<token>").
export function fromBreezeTick(d: any, token: string, exch: string, t: number): RawOptionTick | null {
    const ltp = num(d.last);
    if (ltp === undefined) return null;
    return { src: 'breeze', exch, tk: token, t, ltp, v: num(d.ttq), ap: num(d.avgPrice), bp: num(d.bPrice), sp: num(d.sPrice), bq: num(d.bQty), sq: num(d.sQty), tbq: num(d.totalBuyQt), tsq: num(d.totalSellQ), oi: num(d.OI), ft: d.ltt };
}

export class TickStore {
    private buffer: RawOptionTick[] = [];
    private flushing = false;
    private timer: NodeJS.Timeout | null = null;
    private prepared = false;
    private lastPrepareAt = 0;
    private preparing = false;
    private dropped = 0; private droppedLoggedAt = 0;
    private failureLoggedAt = 0;
    private unresolved = new Map<string, number>(); private unresolvedLoggedAt = 0;
    private cache = new Map<string, { res: Resolution; at: number }>();
    stats = { stored: 0, dropped: 0, unresolved: 0, flushFailures: 0 };

    constructor(private readonly deps: TickStoreDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, FLUSH_MS);
        this.timer.unref?.();
    }

    // Final flush (bounded by the caller's own timeout).
    async stop(): Promise<void> {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        await this.flush().catch(() => { /* logged inside */ });
    }

    // The tick path. Never throws, never awaits.
    record(tick: RawOptionTick | null): void {
        try {
            if (!tick) return;
            if (!this.deps.enabled()) { if (this.buffer.length) this.buffer = []; return; }
            if (this.buffer.length >= MAX_BUFFER) {
                this.dropped++; this.stats.dropped++;
                const now = this.deps.now();
                if (now - this.droppedLoggedAt >= LOG_EVERY_MS) {
                    this.droppedLoggedAt = now;
                    this.deps.log(`[tickStore] buffer full (${MAX_BUFFER}) - dropped ${this.dropped} tick(s) in the last minute (Mongo slow or down)`);
                    this.dropped = 0;
                }
                return;
            }
            this.buffer.push(tick);
            if (this.buffer.length >= FLUSH_AT && !this.flushing) setImmediate(() => { void this.flush().catch(() => { /* logged */ }); });
        } catch (e) { /* the tick path must not be affected */ }
    }

    pending(): number { return this.buffer.length; }

    private async tick(): Promise<void> {
        try {
            if (!this.prepared) await this.prepare();
            if (this.deps.enabled()) await this.flush();
            else if (this.buffer.length) this.buffer = [];
        } catch (e) { this.logFailure(e); }
    }

    // Idempotent: TTL index (36 h on `at`), lookup index, purge of documents of earlier IST days. Retried every 30 s until Mongo is there.
    async prepare(): Promise<boolean> {
        if (this.prepared) return true;
        const now = this.deps.now();
        if (this.preparing || now - this.lastPrepareAt < PREPARE_RETRY_MS) return false;
        this.preparing = true; this.lastPrepareAt = now;
        try {
            const col = await this.deps.getCollection();
            if (!col) return false;
            await col.createIndex({ at: 1 }, { expireAfterSeconds: TTL_SECONDS, name: 'at_ttl_36h' });
            await col.createIndex({ key: 1, t: 1 }, { name: 'key_t' });
            const res = await col.deleteMany({ day: { $lt: istDay(now) } });
            this.deps.log(`[tickStore] ready: TTL ${TTL_SECONDS / 3600} h on at; purged ${res?.deletedCount ?? 0} document(s) of earlier days`);
            this.prepared = true;
            return true;
        } catch (e) { this.logFailure(e); return false; } finally { this.preparing = false; }
    }

    private async resolve(t: RawOptionTick): Promise<Resolution> {
        const ck = `${t.src}|${t.exch}|${t.tk}`;
        const hit = this.cache.get(ck);
        const now = this.deps.now();
        if (hit && (hit.res.kind !== 'unknown' || now - hit.at < NEGATIVE_CACHE_MS)) return hit.res;
        let res: Resolution;
        try { res = await this.deps.resolve(t.src, t.exch, t.tk); } catch (e) { res = { kind: 'unknown' }; }
        this.cache.set(ck, { res, at: now });
        return res;
    }

    async flush(): Promise<void> {
        if (this.flushing || this.buffer.length === 0) return;
        this.flushing = true;
        let batch: RawOptionTick[] = [];
        try {
            batch = this.buffer.splice(0, MAX_BATCH);
            const docs: any[] = [];
            for (const t of batch) {
                const res = await this.resolve(t);
                if (res.kind === 'skip') continue;
                if (res.kind === 'unknown') {
                    const k = `${t.src}:${t.exch}|${t.tk}`;
                    this.unresolved.set(k, (this.unresolved.get(k) ?? 0) + 1); this.stats.unresolved++;
                    continue;
                }
                const m = res.meta;
                docs.push({
                    day: istDay(t.t), t: t.t, at: new Date(t.t), src: t.src, exch: t.exch, tk: t.tk, tsym: m.tsym,
                    key: m.key, u: m.u, exp: m.exp, k: m.k, ot: m.ot,
                    ltp: t.ltp, v: t.v, ap: t.ap, bp: t.bp, sp: t.sp, bq: t.bq, sq: t.sq, tbq: t.tbq, tsq: t.tsq, oi: t.oi, ft: t.ft,
                });
            }
            this.logUnresolved();
            if (docs.length === 0) return;
            const col = await this.deps.getCollection();
            if (!col) throw new Error('Mongo not connected');
            await col.insertMany(docs, { ordered: false, ignoreUndefined: true });
            this.stats.stored += docs.length;
        } catch (e: any) {
            this.stats.flushFailures++;
            this.logFailure(e);
            // A connection problem keeps the batch for the next flush (as far as the bound allows); a document-level error (writeErrors) would only fail again.
            if (!e?.writeErrors) this.requeue(batch);
        } finally { this.flushing = false; }
    }

    private requeue(batch: RawOptionTick[]): void {
        const room = MAX_BUFFER - this.buffer.length;
        if (room <= 0) { this.dropped += batch.length; this.stats.dropped += batch.length; return; }
        if (batch.length > room) { const lost = batch.length - room; this.dropped += lost; this.stats.dropped += lost; batch = batch.slice(batch.length - room); }
        this.buffer = batch.concat(this.buffer);
    }

    private logUnresolved(): void {
        if (this.unresolved.size === 0) return;
        const now = this.deps.now();
        if (now - this.unresolvedLoggedAt < LOG_EVERY_MS) return;
        this.unresolvedLoggedAt = now;
        let total = 0; for (const n of this.unresolved.values()) total += n;
        const list = Array.from(this.unresolved.entries()).slice(0, 10).map(([k, n]) => `${k} x${n}`).join(', ');
        this.deps.log(`[tickStore] ALERT: ${total} tick(s) of ${this.unresolved.size} subscribed option token(s) not in the contract master - not stored: ${list}`);
        this.unresolved.clear();
    }

    private logFailure(e: any): void {
        const now = this.deps.now();
        if (now - this.failureLoggedAt < LOG_EVERY_MS) return;
        this.failureLoggedAt = now;
        this.deps.log(`[tickStore] write failed (suppressed for 60 s): ${e?.message ?? e}`);
    }
}

// ---- production wiring ----
let instance: TickStore | null = null;
export function getTickStore(): TickStore {
    if (!instance) {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const Mongo = require('../../tools/mongo').default;
        const configService = require('../../prism/ConfigService').default;
        let initAt = 0;
        instance = new TickStore({
            getCollection: async () => {
                let m = Mongo.getInstance();
                if (!m?.db) {
                    if (Date.now() - initAt < PREPARE_RETRY_MS) return null;
                    initAt = Date.now();
                    await Mongo.init(); // throws while Mongo is down: caught by the caller, retried later
                    m = Mongo.getInstance();
                }
                return m?.db ? m.db.collection(TICK_COLLECTION) : null;
            },
            resolve: productionResolve,
            enabled: () => configService.getConfig().settings?.storeTicks !== false, // absent = on
            now: () => Date.now(),
            log: (msg) => Log.log(msg),
        });
    }
    return instance;
}

// A token is an option when the contract master lists it as CE/PE. ANT: AntContractMaster (NFO/BFO json); Breeze: its Security Master.
async function productionResolve(src: TickSource, _exch: string, token: string): Promise<Resolution> {
    if (src === 'ant') {
        const AntContractMaster = require('../../ant/AntContractMaster').default;
        const r = AntContractMaster.getInstance().findByToken(token);
        if (!r) return { kind: 'unknown' };
        if (r.optionType !== 'CE' && r.optionType !== 'PE') return { kind: 'skip' };
        const exp = expiryYmdOfMs(r.expiryMs);
        return { kind: 'option', meta: { tsym: r.tradingSymbol, u: r.symbol, exp, k: r.strike, ot: r.optionType, key: optionKey(r.symbol, exp, r.strike, r.optionType) } };
    }
    const bm = require('../../breeze/BreezeContractMaster');
    const r = await bm.default.getInstance().findByToken(token);
    if (!r) return { kind: 'unknown' };
    if (r.optionType !== 'CE' && r.optionType !== 'PE') return { kind: 'skip' };
    const dm = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(r.expiryDate).trim());
    const mi = dm ? ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(dm[2].toUpperCase()) : -1;
    if (!dm || mi < 0) return { kind: 'unknown' };
    const exp = `${dm[3]}-${String(mi + 1).padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    const u = bm.indexNameFor(r.shortName);
    const k = Number(r.strikePrice);
    return { kind: 'option', meta: { tsym: bm.breezeTsym(r.shortName, r.expiryDate, k, r.optionType), u, exp, k, ot: r.optionType, key: optionKey(u, exp, k, r.optionType) } };
}
