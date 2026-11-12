import Log from '../util/Log';
import Mongo from '../tools/mongo';
import { FutQuote, NiftyQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import { roundToTick } from '../util/tick';
import { localDayKey } from './dayKey';
import { CandleEntryStrategy } from './CandleEntryStrategy';
import { createStatsBuilder } from '../processes/strategies/niftyStatsBuilder';
import { BreakoutData, sideVsVwap, Side } from '../lib/breakoutData';
import { isPastTime } from '../util/marketHours';

// First-candle VWAP breakout on the NIFTY future (the index has no volume, so no VWAP; the future's candle and its VWAP come from the same
// instrument, so the futures premium over the index does not bias the comparison).
//   Candle 1 (09:15-09:30, built from the future's ticks): when it closes, compare its close with the future's VWAP (`ap`, the exchange's
//   average traded price; our own volume-weighted figure when `ap` is absent). Close ABOVE the VWAP = call (buy the ATM CE), BELOW = put (buy
//   the ATM PE), equal = no trade. ATM comes from the NIFTY index price. Nearest expiry. One trade a day, entered at the end of candle 1.
//   Candle 2 (09:30-09:45) NEVER trades. It is analysis only, to find out whether waiting for it would have been better: at its close the
//   strategy logs `BREAKOUT-CONFIRM` and stores one document per day in Mongo `breakoutAnalysis` (both candles, VWAP at each close, the
//   side each gives, whether candle 2 confirms candle 1 by VWAP and by the breakout pattern (BreakoutData), the option's P&L at that moment and,
//   once the position is closed, its realised P&L).
//   Exit: target / stopLoss (block or settings), else the EOD close - see CandleEntryStrategy.
//
// A candle is incomplete when its first tick came more than 60 s after the 09:15 start (a restart mid-candle): it does not trade. A candle that
// closed more than 5 minutes ago is not traded late. The VWAP used must be no older than 2 minutes.
//
// Config (config.yml):
//   quantity: 65            - per broker, whole lots
//   target: 20 / stopLoss: 12 - exit rules (block or settings)
//   index: NIFTY, brokers: [kite]
const BUCKET_SECONDS = 900;
const CANDLE1_START = 9 * 3600 + 15 * 60;
const CANDLE2_START = CANDLE1_START + BUCKET_SECONDS;
const LATE_CANDLE_SECONDS = 300;
const PARTIAL_CANDLE_SECONDS = 60;
const MAX_VWAP_AGE_MS = 120_000;
const MAX_NIFTY_AGE_MS = 60_000;

interface CandleRecord { start: number; open: number; high: number; low: number; close: number }
interface VwapStamp { vwap: number; source: 'ap' | 'own'; at: number }

export default class BreakoutStrategy extends CandleEntryStrategy {
    protected readonly logTag = `Breakout:${this.userId}`;
    protected readonly strategyType = 'BreakoutStrategy';
    private builder = createStatsBuilder(BUCKET_SECONDS, { aligned: true });
    private tradingDay: string | null = null;
    private lastVwap: VwapStamp | undefined;
    private lastNifty: { ltp: number; at: number } | undefined;
    private firstTickChecked = false;
    private firstCandlePartial = false;
    private candle1: (CandleRecord & { vwap?: VwapStamp; side?: Side; partial: boolean; traded: boolean; note: string }) | undefined;
    private analysed = false;

    constructor(userId?: string) {
        super(userId);
        this.warnLegacyExitKeys();
    }

    reset(): void {
        super.reset();
        this.tradingDay = null;
    }

    wantsFutQuotes(): boolean {
        return true;
    }

    private newDay(today: string): void {
        this.tradingDay = today;
        this.builder.reset();
        this.lastVwap = undefined;
        this.firstTickChecked = false;
        this.firstCandlePartial = false;
        this.candle1 = undefined;
        this.analysed = false;
    }

    // Index ticks only supply the ATM strike (the future trades at a premium, so its price is not the index level).
    protected async onNiftyTick(quote: NiftyQuote): Promise<void> {
        const ltp = Number(quote.ltp);
        if (ltp > 0) this.lastNifty = { ltp, at: Date.now() };
    }

    async processFutQuote(quote: FutQuote): Promise<void> {
        if (!this.enabled) return; // the dispatcher already withholds ticks from a disabled strategy; this keeps a direct call from trading too
        const today = localDayKey();
        if (this.tradingDay !== today) this.newDay(today);
        if (this.analysed) return; // both candles are done for the day
        const ltt = Number(quote.ltt);
        const ltp = Number(quote.ltp);
        if (!Number.isFinite(ltt) || !(ltp > 0)) return;
        if (this.secondsOfDay(ltt) < CANDLE1_START) return; // pre-open ticks are not part of the 09:15 candle
        if (!this.firstTickChecked) {
            this.firstTickChecked = true;
            this.firstCandlePartial = ltt % BUCKET_SECONDS > PARTIAL_CANDLE_SECONDS;
            Log.log(`[${this.logTag}] first ${quote.token} tick of the day at ${new Date(ltt * 1000).toTimeString().slice(0, 8)}, ltp ${ltp}, vwap ${quote.vwap ?? 'MISSING'} (${quote.vwapSource ?? 'none'}), volume ${quote.volume ?? 'n/a'}${this.firstCandlePartial ? ' - candle 1 is incomplete and will not trade' : ''}`);
        }
        // The VWAP of the candle that is closing is the one known BEFORE this tick (this tick already belongs to the next candle).
        const vwapBefore = this.lastVwap;
        if (quote.vwap !== undefined && quote.vwap > 0) this.lastVwap = { vwap: quote.vwap, source: quote.vwapSource ?? 'ap', at: Date.now() };
        const update = this.builder.record(ltp, ltt);
        if (!update) return;
        await this.onCandleClosed(update.newStats, vwapBefore, ltt, quote);
    }

    private async onCandleClosed(c: any, vwap: VwapStamp | undefined, tickLtt: number, quote: FutQuote): Promise<void> {
        const start = Number(c.candleTime);
        const startSod = this.secondsOfDay(start);
        const rec: CandleRecord = { start, open: c.open, high: c.high, low: c.low, close: c.close };
        const text = `O ${c.open} H ${c.high} L ${c.low} C ${c.close}`;
        const vwapText = vwap ? `${vwap.vwap.toFixed(2)} (${vwap.source}, ${Math.round((Date.now() - vwap.at) / 1000)}s old)` : 'MISSING';
        if (startSod === CANDLE1_START) {
            await this.onCandle1(rec, text, vwap, vwapText, tickLtt, quote);
        } else if (startSod === CANDLE2_START) {
            await this.onCandle2(rec, text, vwap, vwapText);
        } else {
            Log.log(`[${this.logTag}] candle starting ${new Date(start * 1000).toTimeString().slice(0, 5)} closed (${text}) - not one of the two opening candles, ignored`);
            if (startSod > CANDLE2_START) this.analysed = true;
        }
    }

    private async onCandle1(rec: CandleRecord, text: string, vwap: VwapStamp | undefined, vwapText: string, tickLtt: number, quote: FutQuote): Promise<void> {
        const today = localDayKey();
        const partial = this.firstCandlePartial;
        const side = vwap ? sideVsVwap(rec.close, vwap.vwap) : undefined;
        this.candle1 = { ...rec, vwap, side, partial, traded: false, note: '' };
        const head = `candle 1 (09:15-09:30, ${quote.token}) closed: ${text} | future vwap ${vwapText} | close vs vwap ${vwap ? (rec.close - vwap.vwap >= 0 ? '+' : '') + (rec.close - vwap.vwap).toFixed(2) : 'n/a'} -> ${side ?? 'none'}`;
        const skip = (why: string) => { this.candle1!.note = why; Log.log(`[${this.logTag}] ${head} -> no trade: ${why}`); };

        if (partial) return skip('incomplete candle (started mid-candle after a restart)');
        if (!vwap) return skip('no VWAP from the future feed (see the VWAP-FEED lines of the data process)');
        if (Date.now() - vwap.at > MAX_VWAP_AGE_MS) return skip(`the VWAP is ${Math.round((Date.now() - vwap.at) / 1000)}s old (more than ${MAX_VWAP_AGE_MS / 1000}s)`);
        if (!side) return skip('close equals the VWAP');
        const late = tickLtt - (rec.start + BUCKET_SECONDS);
        if (late > LATE_CANDLE_SECONDS) return skip(`candle closed ${late}s ago (more than ${LATE_CANDLE_SECONDS}s) - not traded late`);
        if (isPastTime(String((this.cfg() as any).lastEntryTime ?? '15:00'), '15:00')) return skip('past lastEntryTime');
        if (this.isRunning()) return skip('a position is already open');
        const key = `${today} breakout`;
        if (this.cycleStarted(key)) return skip('already traded (or handled) today - a restart does not redo it');
        if (this.configuredQuantity() === null) { Log.log(`[${this.logTag}] ALERT: ${head} but quantity (${(this.cfg() as any).quantity}) is not a positive multiple of the lot size - not trading`); this.candle1.note = 'invalid quantity'; return; }
        try {
            this.exitRules();
        } catch (e: any) {
            Log.log(`[${this.logTag}] ALERT: ${head} but ${e?.message ?? e} - not trading`);
            this.candle1.note = 'invalid target/stopLoss';
            return;
        }
        if (!this.lastNifty || Date.now() - this.lastNifty.at > MAX_NIFTY_AGE_MS) return skip('no recent NIFTY index price for the ATM strike');

        const right = side === 'call' ? 'CE' : 'PE';
        const strike = this.atmStrike(this.lastNifty.ltp);
        Log.log(`[${this.logTag}] ${head} -> BUY ${right} ${strike} (NIFTY ${this.lastNifty.ltp}), nearest expiry, quantity ${this.configuredQuantity()} per broker`);
        this.candle1.traded = true;
        await this.startCycle(key, { index: 'NIFTY', strike, right }, () => 1, async (c) => {
            const optionLtp = await OrderClient.getInstance().getOptionLtp(this.userId, { tradingSymbol: c.tsym, token: c.token, exchange: c.exchange });
            return roundToTick(optionLtp);
        });
    }

    // Analysis only: never places an order.
    private async onCandle2(rec: CandleRecord, text: string, vwap: VwapStamp | undefined, vwapText: string): Promise<void> {
        this.analysed = true;
        const c1 = this.candle1;
        const side2 = vwap ? sideVsVwap(rec.close, vwap.vwap) : undefined;
        const patternSide = c1 ? BreakoutData.from(c1, rec) : undefined;
        const confirmedByVwap = c1?.side !== undefined && side2 !== undefined ? side2 === c1.side : null;
        const confirmedByPattern = c1?.side !== undefined ? patternSide === c1.side : null;
        const legs: any[] = [];
        for (const leg of this.legs()) {
            if (leg.filledQty <= 0) continue;
            const avg = this.avgPrice(leg);
            let ltp: number | null = null;
            try { ltp = await OrderClient.getInstance().getOptionLtp(this.userId, { tradingSymbol: leg.tsym, token: leg.token, exchange: leg.exchange }); } catch { /* analysis only */ }
            const open = leg.soldQty < leg.filledQty;
            legs.push({ broker: leg.broker, tsym: leg.tsym, qty: leg.filledQty, avg, ltpAtCandle2Close: ltp, pnlPerUnitAtCandle2Close: ltp === null ? null : ltp - avg, stillOpen: open });
        }
        Log.log(`[${this.logTag}] BREAKOUT-CONFIRM candle 2 (09:30-09:45) closed: ${text} | future vwap ${vwapText} | candle 1 side ${c1?.side ?? 'none'} (${c1?.traded ? 'traded' : `not traded${c1?.note ? ': ' + c1.note : ''}`}) | candle 2 vs vwap -> ${side2 ?? 'none'} | breakout pattern vs candle 1 -> ${patternSide ?? 'none'} | confirmed by vwap: ${confirmedByVwap ?? 'n/a'}, by pattern: ${confirmedByPattern ?? 'n/a'} | position at this moment: ${legs.length === 0 ? 'none' : legs.map((l) => `${l.tsym} ${l.stillOpen ? 'open' : 'closed'} avg ${l.avg.toFixed(2)} ltp ${l.ltpAtCandle2Close ?? 'n/a'} (${l.pnlPerUnitAtCandle2Close === null ? 'n/a' : (l.pnlPerUnitAtCandle2Close >= 0 ? '+' : '') + l.pnlPerUnitAtCandle2Close.toFixed(2)}/unit)`).join('; ')}`);
        try {
            await Mongo.getInstance()?.db?.collection('breakoutAnalysis').updateOne({ _id: localDayKey() as any }, {
                $set: {
                    updatedAt: new Date(),
                    candle1: c1 ? { start: c1.start, open: c1.open, high: c1.high, low: c1.low, close: c1.close, vwap: c1.vwap?.vwap ?? null, vwapSource: c1.vwap?.source ?? null, side: c1.side ?? null, partial: c1.partial, traded: c1.traded, note: c1.note } : null,
                    candle2: { start: rec.start, open: rec.open, high: rec.high, low: rec.low, close: rec.close, vwap: vwap?.vwap ?? null, vwapSource: vwap?.source ?? null, sideVsVwap: side2 ?? null, patternSide: patternSide ?? null },
                    confirmedByVwap, confirmedByPattern, legsAtCandle2Close: legs,
                },
            }, { upsert: true });
        } catch (e: any) {
            Log.log(`[${this.logTag}] could not store the analysis in Mongo breakoutAnalysis (${e?.message ?? e}) - the log line above is the record`);
        }
    }

    // The cycle is over: log and store what the position finally made, next to the candle-2 analysis of the same day.
    protected async onCycleEnded(): Promise<void> {
        const done = this.legs().filter((l) => l.filledQty > 0);
        if (done.length === 0) return;
        const exits = done.map((l) => ({ broker: l.broker, tsym: l.tsym, qty: l.filledQty, bought: l.boughtValue, sold: l.soldValue, pnl: l.soldValue - l.boughtValue }));
        Log.log(`[${this.logTag}] position ended: ${exits.map((e) => `${e.tsym} bought ${e.bought.toFixed(2)} sold ${e.sold.toFixed(2)} P&L ${(e.pnl >= 0 ? '+' : '') + e.pnl.toFixed(2)}`).join('; ')}`);
        try {
            await Mongo.getInstance()?.db?.collection('breakoutAnalysis').updateOne({ _id: localDayKey() as any }, { $set: { finalExit: exits, endedAt: new Date() } }, { upsert: true });
        } catch (e: any) {
            Log.log(`[${this.logTag}] could not store the final P&L in Mongo breakoutAnalysis (${e?.message ?? e})`);
        }
    }
}
