/**
 * The Beginner forecast engine (spec v2.1 sections 7 and 8), in the `frontend` process: it already receives every NIFTY tick over the data link.
 *   - keeps the latest NIFTY value, 1-minute candles and a once-a-second tick store (Mongo niftyTicks) for scoring;
 *   - keeps the NIFTY future's depth (total buy/sell quantity) and subscribes the depth feed for it;
 *   - submit(): records the forecast (write-once), runs BOTH filters, logs the decision (append-only), and, only if every filter passed AND the master
 *     switch forecast.orders.enabled is on, buys an ATM option as the contractor's own user (a normal user order, src/contractors/order.ts) with a target and stop. No approval step exists for a Beginner forecast. Nothing is shown to the contractor
 *     about whether or how a forecast was used (agreement section 5);
 *   - scoreDue(): scores forecasts whose window has closed.
 * Not a strategy and not in the order process: nothing here touches an existing strategy class.
 */
import * as crypto from 'crypto';
import Log from '../util/Log';
import configService from '../prism/ConfigService';
import { DataLink } from '../ipc/DataLink';
import { isNiftyExpiryDay } from '../util/marketHours';
import { CandleBuilder } from './candles';
import { DEFAULT_ORDER_BOOK, DepthSnapshot, Filter, FilterContext, OrderBookImbalanceFilter, PassThroughAlarm, TrendFilter, assertEngineFilters, evaluateAll } from './filters';
import { ForecastConfig, checkSubmission, getForecastConfig, istParts } from './rules';
import { ForecastDoc, forecastsOfDay, insertForecast, niftyTicksCol, openForecasts, scoreOpenForecast } from './store';
import { Outcome, Tick, scoreFromTicks } from './scorer';
import { Contractor } from '../contractors/types';
import { currentVersion } from '../contractors/agreements';
import { contractorsCol, submissionBlock } from '../contractors/store';
import { placeContractorBuy, tradeInProgress } from '../contractors/order';
import { appendDecision } from '../contractors/recommendations';
import { roundToTick } from '../util/tick';
import { notifyAdmins } from '../contractors/notify';
import { istDate } from '../contractors/agreements';
import { RateLimiter } from '../contractors/rateLimit';

export type SubmitResult =
    | { ok: true; forecast: { id: string; submittedAt: Date; windowEndsAt: Date; direction: string } }
    | { ok: false; status: number; error: string };

const MAX_TICK_AGE_MS = 5000;     // the reference value must come from a tick this fresh (the +/- 5 s rule)
const TICK_STORE_EVERY_MS = 1000;
const ATM_STEP = 50;

export class ForecastEngine {
    private static instance: ForecastEngine | null = null;
    static getInstance(): ForecastEngine { return (ForecastEngine.instance ??= new ForecastEngine()); }

    private candles = new CandleBuilder();
    private last: { ltp: number; ts: number } | null = null;
    private depth: DepthSnapshot | null = null;
    private futToken: string | null = null;
    private futSymbol = 'NIFTY-FUT';
    private lastStoredAt = 0;
    private ready = false;
    private startError: string | null = null;
    readonly alarm = new PassThroughAlarm(30, 0.1);
    private alarmNotifiedAt = 0;
    private submitLimiter = new RateLimiter(10, 60_000);
    private scoring = false;
    private clock: () => number = () => Date.now();
    /** @internal tests: a fixed clock and a started flag, so the engine runs without the data link. */
    _testHooks(clock: () => number, ready = true): void { this.clock = clock; this.ready = ready; }

    // ---- start-up ----

    filters(): Filter[] {
        const f: any = (configService.getConfig() as any)?.forecast?.filters ?? {};
        const ob = { ...DEFAULT_ORDER_BOOK, ...(f.orderBook ?? {}) };
        return [new OrderBookImbalanceFilter(ob), new TrendFilter(f.trend ? { emaPeriod: 9, minCandles: 10, maxStaleMinutes: 2, ...f.trend } : undefined)];
    }

    /** Wires the engine to the data link and rebuilds the candles from the tick store. Refuses (and says so) if the filters are not both enabled. */
    async start(link: DataLink): Promise<void> {
        try { assertEngineFilters(this.filters()); } catch (e: any) {
            this.startError = e.message; Log.log(`[forecast] ALERT: ${e.message}`); await notifyAdmins('engine_refused', e.message).catch(() => undefined); return;
        }
        const minRate = Number((configService.getConfig() as any)?.forecast?.filters?.minRejectionRate);
        if (Number.isFinite(minRate) && minRate > 0 && minRate < 1) (this as any).alarm = new PassThroughAlarm(30, minRate);
        try { await niftyTicksCol().createIndex({ ts: 1 }, { expireAfterSeconds: 400 * 86400 }); } catch (e) { Log.log('[forecast] niftyTicks index:', (e as Error).message); }
        await this.rebuildCandles().catch((e) => Log.log('[forecast] candle rebuild failed (they refill from live ticks):', e));
        link.onTick((tick) => { try { this.onTick(tick); } catch (e) { Log.log('[forecast] tick handling failed:', e); } });
        this.ready = true;
        Log.log('[forecast] engine started (order placing is ' + (this.ordersEnabled() ? 'ON' : 'OFF: decisions are logged only') + ')');
    }

    private async rebuildCandles(): Promise<void> {
        const since = new Date(Date.now() - 40 * 60_000);
        const rows = await niftyTicksCol().find({ ts: { $gte: since } }).sort({ ts: 1 }).toArray();
        for (const r of rows) this.candles.add(new Date(r.ts).getTime(), Number(r.ltp));
        if (rows.length) { const l = rows[rows.length - 1]; this.last = { ltp: Number(l.ltp), ts: new Date(l.ts).getTime() }; }
    }

    // ---- ticks ----

    onTick(tick: any): void {
        if (tick?.type === 'nifty') {
            const ltp = Number(tick.quote?.ltp);
            if (!Number.isFinite(ltp) || ltp <= 0) return;
            const now = this.clock();
            this.last = { ltp, ts: now };
            this.candles.add(now, ltp);
            if (now - this.lastStoredAt >= TICK_STORE_EVERY_MS && this.inStoreHours(now)) { this.lastStoredAt = now; this.storeTick(now, ltp); }
        } else if (tick?.type === 'fut') {
            const q = tick.quote ?? {};
            if (q.token && this.futToken !== String(q.token)) {
                this.futToken = String(q.token);
                // The depth feed (total buy/sell quantity) is not in the touchline feed: ask for it once the future's token is known.
                DataLink.getInstance().subscribe('forecast', { cmd: 'subscribeDepth', token: this.futToken, exchange: 'NFO' });
                Log.log(`[forecast] subscribed depth for the NIFTY future (token ${this.futToken})`);
            }
            if (Number.isFinite(q.tbq) && Number.isFinite(q.tsq)) this.depth = { buyQty: Number(q.tbq), sellQty: Number(q.tsq), ts: this.clock(), instrument: this.futSymbol };
        }
    }

    private lastStoreFailLogAt = 0;
    // Fire-and-forget (the tick path must never wait for Mongo); a failure is logged at most once a minute.
    private storeTick(now: number, ltp: number): void {
        niftyTicksCol().insertOne({ ts: new Date(now), ltp }).catch((e) => {
            if (this.clock() - this.lastStoreFailLogAt > 60_000) { this.lastStoreFailLogAt = this.clock(); Log.log('[forecast] could not store a NIFTY tick:', e); }
        });
    }

    private inStoreHours(now: number): boolean {
        const t = istParts(new Date(now)).hhmm; const c = getForecastConfig();
        return t >= c.hours.start && t <= '15:45';
    }

    // ---- submit ----

    isReady(): boolean { return this.ready; }
    startFailure(): string | null { return this.startError; }
    ordersEnabled(): boolean { return (configService.getConfig() as any)?.forecast?.orders?.enabled === true; }
    latest(): { ltp: number; ts: number } | null { return this.last; }

    async submit(c: Contractor, body: any, now = new Date(this.clock())): Promise<SubmitResult> {
        if (c.type !== 'INDIVIDUAL') return { ok: false, status: 403, error: 'Forecasts are for Beginner (Individual) contractors' };
        if (!this.submitLimiter.allow(c.id)) return { ok: false, status: 429, error: 'Too many attempts. Try again in a minute.' };
        const blocked = submissionBlock(c, await currentVersion());
        if (blocked) return { ok: false, status: 403, error: blocked };
        const direction = String(body?.direction ?? '').toUpperCase();
        if (direction !== 'UP' && direction !== 'DOWN') return { ok: false, status: 400, error: 'direction must be Up or Down' };
        const conf = body?.confidence == null || body.confidence === '' ? undefined : String(body.confidence);
        if (conf !== undefined && !['Low', 'Medium', 'High'].includes(conf)) return { ok: false, status: 400, error: 'confidence must be Low, Medium or High' };
        if (!this.ready) return { ok: false, status: 503, error: this.startError ? 'Forecasting is unavailable right now.' : 'Forecasting is starting up. Try again in a moment.' };
        const cfg = getForecastConfig();
        const today = await forecastsOfDay(c.id, istDate(now));
        const hasOpen = today.some((f) => f.outcome === 'OPEN' && f.submittedAt.getTime() + f.windowMinutes * 60_000 > now.getTime());
        let expiry = false; try { expiry = isNiftyExpiryDay(); } catch { /* master unreadable: treated as a normal day */ }
        const v = checkSubmission({ now, cfg, isExpiryDay: expiry, todaysCount: today.length, hasOpenWindow: hasOpen });
        if (v.ok === false) return { ok: false, status: 422, error: (v as { error: string }).error };
        const tick = this.last;
        if (!tick || now.getTime() - tick.ts > MAX_TICK_AGE_MS) return { ok: false, status: 503, error: 'Live NIFTY data is not available right now. Try again in a moment.' };

        const feeCfg: any = (configService.getConfig() as any)?.forecast?.fees ?? {};
        const doc: ForecastDoc = {
            id: crypto.randomBytes(8).toString('hex'), contractorId: c.id, direction: direction as 'UP' | 'DOWN', confidence: conf as any, submittedAt: now, day: istDate(now),
            windowMinutes: cfg.windowMinutes, refValueStart: tick.ltp, refTickTs: tick.ts, neutralThresholdPoints: cfg.neutralThresholdPoints,
            feeAmount: Number(feeCfg.feePerCorrect) > 0 ? Number(feeCfg.feePerCorrect) : 0, agreementVersion: c.agreementVersion as string, outcome: 'OPEN',
        };
        await insertForecast(doc);
        // The forecast is recorded whatever the filters say. The decision is made after, and is never shown to the contractor.
        this.decide(c, doc).catch((e) => Log.log('[forecast] decision failed:', e));
        return { ok: true, forecast: { id: doc.id, submittedAt: doc.submittedAt, windowEndsAt: new Date(now.getTime() + cfg.windowMinutes * 60_000), direction: doc.direction } };
    }

    private depthForFilters(nowMs: number): DepthSnapshot | null { return this.depth ? { ...this.depth, ts: this.depth.ts } : null; }

    /** Runs both filters, appends the decision, feeds the pass-through alarm and, when allowed, places the order. */
    async decide(c: Contractor, f: ForecastDoc): Promise<void> {
        const nowMs = this.clock();
        const ctx: FilterContext = { direction: f.direction, nowMs, depth: this.depthForFilters(nowMs), candles: this.candles.all() };
        const decision = evaluateAll(this.filters(), ctx);
        this.alarm.record(!decision.accepted);
        let order: { placed: boolean; reason: string } = { placed: false, reason: decision.accepted ? 'not attempted' : 'rejected by a filter' };
        if (decision.accepted) order = await this.maybePlaceOrder(c, f).catch((e) => ({ placed: false, reason: `error: ${e?.message ?? e}` }));
        await appendDecision({ kind: 'forecast', forecastId: f.id, contractorId: c.id, direction: f.direction, refValueStart: f.refValueStart, accepted: decision.accepted, reason: decision.reason, filters: decision.results,
            orderPlaced: order.placed, orderNote: order.reason, ordersEnabled: this.ordersEnabled() });
        Log.log(`[forecast] ${c.email} ${f.direction} @ ${f.refValueStart}: ${decision.accepted ? 'ACCEPTED' : 'REJECTED'} (${decision.reason}); order: ${order.reason}`);
        if (this.alarm.firing() && this.clock() - this.alarmNotifiedAt > 3_600_000) {
            this.alarmNotifiedAt = this.clock();
            await notifyAdmins('passthrough_alarm', `Pass-through alarm: only ${Math.round((this.alarm.rate() ?? 0) * 100)}% of the last 30 forecasts were rejected by your filters. Check the thresholds (they are never lowered automatically).`);
        }
    }

    // ---- orders (master switch off by default) ----

    private async maybePlaceOrder(c: Contractor, f: ForecastDoc): Promise<{ placed: boolean; reason: string }> {
        if (!this.ordersEnabled()) return { placed: false, reason: 'order placing is off (forecast.orders.enabled)' };
        const o: any = (configService.getConfig() as any)?.forecast?.orders ?? {};
        if (istParts(new Date(this.clock())).hhmm > String(o.noNewAfter ?? '14:45')) return { placed: false, reason: 'past the no-new-positions cut-off' };
        const spot = this.last?.ltp; if (!spot) return { placed: false, reason: 'no spot' };
        const strike = Math.round(spot / ATM_STEP) * ATM_STEP;
        const right = f.direction === 'UP' ? 'CE' : 'PE';
        const contract = `${strike} ${right}`;
        const risk = await this.riskRefusal(o);
        if (risk) return { placed: false, reason: risk };
        if (await tradeInProgress(c)) return { placed: false, reason: 'a trade of this contractor is still in progress' };
        const ltp = await this.optionLtp(spot, right);
        if (!ltp) return { placed: false, reason: 'option price unavailable' };
        const target = Number(o.targetPoints) > 0 ? Number(o.targetPoints) : 10, stop = Number(o.stopLossPoints) > 0 ? Number(o.stopLossPoints) : 20;
        const price = roundToTick(ltp), targetPrice = roundToTick(ltp + target), stopPrice = roundToTick(ltp - stop);
        if (!(stopPrice > 0)) return { placed: false, reason: 'stop would be non-positive' };
        // A normal user order (the same path as Search & Buy) under the contractor's own id; the order process sizes it (forecast.orders.maxInvestment) and attaches target and stop.
        await placeContractorBuy(c, { underlying: 'NIFTY', strike, right, price, target: targetPrice, stop: stopPrice });
        return { placed: true, reason: `bought ${contract} at ${price}, target ${targetPrice}, stop ${stopPrice} as ${c.email}` };
    }

    private async riskRefusal(o: any): Promise<string | null> {
        try {
            const stats = await (await import('../processes/strategies/OrderClient')).default.getInstance().stats();
            const emails = new Set<string>(((await contractorsCol().find({}).toArray()) as any[]).map((x) => String(x.email)));
            const mine = (t: any) => emails.has(String(t.user ?? ''));
            const open = (stats.trades ?? []).filter((t: any) => mine(t) && t.open !== false).length;
            if (Number(o.maxOpenPositions) > 0 && open >= Number(o.maxOpenPositions)) return `max open positions reached (${open})`;
            const limit = Number(o.dailyLossLimit);
            if (limit > 0) {
                const today = istDate();
                const pnl = [...(stats.closedTrades ?? []).filter((t: any) => mine(t) && t.exitTime && istDate(new Date(t.exitTime)) === today).map((t: any) => Number(t.realizedPnL) || 0),
                    ...(stats.trades ?? []).filter((t: any) => mine(t)).map((t: any) => Number(t.unrealizedPnL) || 0)].reduce((a: number, b: number) => a + b, 0);
                if (pnl <= -limit) { await notifyAdmins('kill_switch', `Contractors' trades are down ₹${Math.round(-pnl)} today (limit ₹${limit}): no new forecast positions are being placed.`); return `daily loss limit reached (${Math.round(pnl)})`; }
            }
            return null;
        } catch (e: any) { return `risk check unavailable: ${e?.message ?? e}`; } // fail closed
    }

    private async optionLtp(spot: number, right: 'CE' | 'PE'): Promise<number | null> {
        const { default: AntContractMaster } = await import('../ant/AntContractMaster');
        const { default: ANT } = await import('../ant/ANT');
        const master = AntContractMaster.getInstance();
        const sel = master.findATMOption(spot, right, 'NIFTY');
        const ce = master.findATMOption(spot, 'CE', 'NIFTY'), pe = master.findATMOption(spot, 'PE', 'NIFTY');
        const snap = await ANT.getInstance().getContractSnapshot(sel.exch, String(sel.token), String(ce.token), String(pe.token));
        return snap.ltp && snap.ltp > 0 ? snap.ltp : null;
    }

    // ---- scoring ----

    /** Scores every OPEN forecast whose window has closed (a few seconds after, so the end tick is in the store). VOID + owner alert when a reference tick is missing. */
    async scoreDue(now = new Date(this.clock())): Promise<number> {
        if (this.scoring) return 0;
        this.scoring = true;
        let n = 0;
        try {
            for (const f of await openForecasts()) {
                const endMs = f.submittedAt.getTime() + f.windowMinutes * 60_000;
                if (now.getTime() < endMs + 6000) continue;
                const rows = await niftyTicksCol().find({ ts: { $gte: new Date(endMs - 5000), $lte: new Date(endMs + 5000) } }).toArray();
                const ticks: Tick[] = rows.map((r: any) => ({ ts: new Date(r.ts).getTime(), ltp: Number(r.ltp) }));
                // the start value is the one recorded at submission (feed value at submitted_at); it is checked to be within 5 s of it
                const startOk = Math.abs(f.refTickTs - f.submittedAt.getTime()) <= 5000;
                const r = scoreFromTicks({ direction: f.direction, submittedAtMs: endMs - f.windowMinutes * 60_000, windowMinutes: f.windowMinutes, neutralThresholdPoints: f.neutralThresholdPoints },
                    [{ ts: f.refTickTs, ltp: f.refValueStart }, ...ticks]);
                const outcome: Exclude<Outcome, 'OPEN'> = startOk && r.outcome !== 'OPEN' ? r.outcome : 'VOID';
                // A missing END tick may still be written: retry for 30 s. A start reference that was too old can never be fixed: VOID at once.
                if (outcome === 'VOID' && startOk && !r.end && now.getTime() < endMs + 30_000) continue;
                if (await scoreOpenForecast(f.id, outcome, { value: r.end?.ltp, tickTs: r.end?.ts }, now)) {
                    n++;
                    if (outcome === 'VOID') await notifyAdmins('feed_gap', `A forecast could not be scored (no NIFTY tick within 5 s of its reference time): marked VOID, no fee and no penalty.`, { forecastId: f.id });
                }
            }
        } finally { this.scoring = false; }
        return n;
    }
}
