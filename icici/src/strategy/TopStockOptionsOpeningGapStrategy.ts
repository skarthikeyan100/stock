import Log from '../util/Log';
import { MOCK_BROKER } from '../constants';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import AntContractMaster from '../ant/AntContractMaster';
import ANT from '../ant/ANT';
import { enterPosition, placeLimitSellBareOnAnt } from '../processes/order/antExecutor';
import { Strategy } from './strategy';
import { OrderCancelledNotification } from '../ipc/orderProtocol';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import moment from 'moment';

// Same pattern BulkPcrStrategy.ts uses for its own identically-named local
// constant - not exported from there, so duplicated here rather than adding
// a cross-strategy coupling for one regex.
const MARGIN_SHORTFALL_REASON_PATTERN = /margin.{0,30}(shortfall|insufficient|exceed|short)|(?:shortfall|insufficient|exceed|short|enough).{0,30}margin/i;

// Anchored to process.cwd() (always the repo root for every entry point
// that runs this strategy), NOT __dirname - same reasoning as
// GapScreenerGenerate.ts/GapScreenerOptionQuote.ts: __dirname in compiled
// code is dist/strategy/, which would miss the real CSV written alongside
// the gapscreener TS sources.
const GAP_SCREENER_CSV = path.join(process.cwd(), 'src', 'tools', 'gapscreener', 'gap-screener.csv');

// gapscreener-morning.sh (crontab) runs at 10:05 IST on trading days and
// overwrites gap-screener.csv around then - this strategy must not read it
// before that, and should give the cron job a few minutes' margin against a
// slow screener run before firing. Closes at 10:35, well before
// BulkPcrAutoStartStrategy's own 10:35 slot, to avoid colliding with it.
const TRADING_WINDOW_START = { hour: 10, minute: 10 };
const TRADING_WINDOW_END = { hour: 10, minute: 35 };

interface RankedStock {
    symbol: string;
    gapPct: number;
    latestOpen: number;
}

export default class TopStockOptionsOpeningGapStrategy extends Strategy {
    private static readonly MAX_EXIT_RETRIES = 3;
    private static readonly EXIT_RETRY_DELAY_MS = 3000;

    private phase: 'idle' | 'running' | 'done' = 'idle';
    private tradingDay: string | null = null;

    // Tracks each leg's resting target sell by token, so onOrderCancelled
    // (re-place on a cancelled/rejected exit) and updateTrade (clear on an
    // actual fill) can find the right leg - see both below.
    private activeLegs = new Map<string, { tradingSymbol: string; exchange: 'NFO' | 'BFO'; targetPrice: number; retryCount: number }>();

    // phase alone has no day boundary - once it reaches 'done' on day N it
    // stays 'done' forever in a long-lived process (npm run processes has no
    // nightly restart), since processNiftyQuote's `phase !== 'idle'` guard
    // short-circuits before hasFiredToday() (which IS day-scoped) is ever
    // consulted again. Mirrors BulkPcrAutoStartStrategy's resetIfNewDay().
    private resetIfNewDay(now: moment.Moment) {
        const today = now.format('YYYY-MM-DD');
        if (this.tradingDay !== today) {
            this.tradingDay = today;
            this.phase = 'idle';
        }
    }

    // In-memory `phase` alone only prevents re-firing within one process
    // lifetime - a dev-mode hot restart (tsc-watch) or any crash/restart
    // landing inside the trading window would reset phase to 'idle' and
    // re-enter all legs a second time for the same day (the exact failure
    // class BulkPcrAutoStartStrategy hit live on 2026-10-14 for its own
    // once-per-slot-per-day firing). Persist "already ran today" to disk so
    // a restart can't re-trigger it. Namespaced by userId - config.yml can
    // configure multiple instances of this strategy (distinct userId, e.g.
    // separate broker accounts), and they must not share one fired-today
    // flag or the second instance would silently never trade.
    private firedTodayFile = path.join(__dirname, `../../.topStockOptionsOpeningGap_firedToday.${this.safeFileToken(this.userId)}.json`);

    private safeFileToken(s: string): string {
        return s.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    private hasFiredToday(): boolean {
        try {
            const recorded = JSON.parse(fs.readFileSync(this.firedTodayFile, 'utf8')) as string;
            return recorded === moment().format('YYYY-MM-DD');
        } catch {
            return false;
        }
    }

    // Returns false if the record could not be written. The caller must then not execute -
    // executing without the record would let a restart re-execute this same day.
    private recordFiredToday(): boolean {
        try {
            fs.writeFileSync(this.firedTodayFile, JSON.stringify(moment().format('YYYY-MM-DD')));
            return true;
        } catch (e: any) {
            Log.log(`[${this.userId}] ALERT: could not persist firedToday record - NOT executing: ${e?.message ?? e}`);
            return false;
        }
    }

    receive(oldStats, newStats) {
        // no-op, same as BulkPcrStrategy
    }

    isTimeInRange(): boolean {
        if (MOCK_BROKER) return true;
        const now = moment();
        const start = moment().hour(TRADING_WINDOW_START.hour).minute(TRADING_WINDOW_START.minute).second(0);
        const end = moment().hour(TRADING_WINDOW_END.hour).minute(TRADING_WINDOW_END.minute).second(0);
        return now.isAfter(start) && now.isBefore(end);
    }

    async processNiftyQuote(quote: NiftyQuote) {
        if (!this.enabled) return;
        this.resetIfNewDay(moment());
        if (this.phase !== 'idle') return;
        if (!this.isTimeInRange()) return;
        if (this.hasFiredToday()) {
            // Already ran earlier today in a prior process lifetime - mark done
            // in-memory too so this check isn't repeated on every tick.
            this.phase = 'done';
            return;
        }
        this.phase = 'running'; // set synchronously before any async work, so concurrent ticks can't double-fire
        try {
            await this.executeTrade();
        } catch (e: any) {
            // Never let a failure here (e.g. csv-parse throwing on a gap-screener.csv
            // mid-write by the 10:05 cron job) escape processNiftyQuote - the caller
            // (strategiesProcess.ts) has no per-strategy try/catch around this call,
            // so an uncaught throw here would skip every strategy later in its list
            // for this one tick.
            Log.log(`[${this.userId}] executeTrade failed: ${e?.message ?? e}`);
        } finally {
            // Re-derive from the persisted marker, not a blind 'done': executeTrade
            // returns early (no throw) for a retryable skip too (missing/stale CSV,
            // invalid config, empty rank window) without ever calling
            // recordFiredToday(). Forcing 'done' here regardless would drop every
            // later tick for the rest of the window even once e.g. a late cron run's
            // CSV becomes fresh - defeating the window's entire reason to exist.
            // Only a successful recordFiredToday() (i.e. legs were actually
            // attempted) should stop further retries this window.
            this.phase = this.hasFiredToday() ? 'done' : 'idle';
        }
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false; // exit delegated to ANT's broker-side bracket order
    }

    processOptionQuote(quote: OptionQuote) {
        // no-op (see canHandleOptionQuote)
    }

    getMonitorConfig() {
        return null; // exit handled per-leg inside enterPosition's bracket order
    }

    reset(): void {
        this.phase = 'idle';
        Log.log(`[${this.userId}] Reset via admin request`);
    }

    private async executeTrade() {
        const config = configService.getStrategyConfig('TopStockOptionsOpeningGapStrategy');
        const rankStart: number = config.rankStart ?? 3;
        const rankCount: number = config.rankCount ?? 5;
        const lots: number = config.lots ?? 1;
        const logEnabled: boolean = config.logEnabled ?? true;

        if (!fs.existsSync(GAP_SCREENER_CSV)) {
            Log.log(`[${this.userId}] gap-screener.csv not found at ${GAP_SCREENER_CSV}, skipping`);
            return;
        }
        const mtime = fs.statSync(GAP_SCREENER_CSV).mtime;
        const today = new Date().toISOString().slice(0, 10);
        if (mtime.toISOString().slice(0, 10) !== today) {
            Log.log(`[${this.userId}] gap-screener.csv is stale (mtime ${mtime.toISOString()}), skipping`);
            return;
        }

        const content = fs.readFileSync(GAP_SCREENER_CSV, 'utf8');
        const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];

        const ranked: RankedStock[] = rows
            .map(r => ({ symbol: (r['Symbol'] || '').trim().toUpperCase(), gapPct: parseFloat(r['Gap %']), latestOpen: parseFloat(r['Latest Open']) }))
            .filter(r => r.symbol && !isNaN(r.gapPct) && !isNaN(r.latestOpen))
            .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));

        if (rankStart < 1 || rankCount < 1) {
            Log.log(`[${this.userId}] invalid rankStart=${rankStart}/rankCount=${rankCount}, skipping`);
            return;
        }
        const selected = ranked.slice(rankStart - 1, rankStart - 1 + rankCount);
        if (selected.length === 0) {
            Log.log(`[${this.userId}] no stocks in rank window ${rankStart}-${rankStart + rankCount - 1} (${ranked.length} ranked rows), skipping`);
            return;
        }

        if (logEnabled) {
            Log.log(`[${this.userId}] selected ${selected.length} stock(s) for ranks ${rankStart}-${rankStart + rankCount - 1}: ` +
                selected.map(s => `${s.symbol}(${s.gapPct}%)`).join(', '));
        }

        // Recorded only now - after every skip-worthy condition above (missing/
        // stale CSV, empty rank window) has already passed - not at the top of
        // processNiftyQuote. The 10:10-10:35 window exists specifically to
        // tolerate a late cron run; recording "fired" before a stale-CSV skip
        // would burn that retry margin on a day the screener just ran a few
        // minutes late, permanently blocking every later tick even once the
        // CSV becomes fresh. There is no async gap between here and the actual
        // order attempts below, so this still fully guards against a restart
        // re-entering the same legs.
        if (!this.recordFiredToday()) return; // ALERT already logged inside recordFiredToday

        // Each leg isolated via allSettled, same as BulkPcrStrategy's multi-leg
        // entry - one stock's contract-resolution/order failure must not abort
        // the others.
        const results = await Promise.allSettled(
            selected.map(stock => this.enterLeg(stock, lots, logEnabled))
        );
        const failures = results.filter(r => r.status === 'rejected').length;
        if (failures > 0) {
            Log.log(`[${this.userId}] ${failures}/${selected.length} leg(s) failed to enter - see individual leg logs above`);
        }

        // One-shot, but only once a trade was actually taken: durably disable
        // so this strategy doesn't re-arm on a later trading day without a
        // manual config.yml edit. If EVERY leg failed (e.g. a transient ANT
        // outage) nothing was actually traded today, so leave enabled=true -
        // recordFiredToday() above already blocks a same-day retry either
        // way, but a future day should still get a fresh attempt instead of
        // being permanently locked out by a day where zero positions opened.
        if (failures < selected.length) {
            this.durablyDisable(`${selected.length - failures}/${selected.length} leg(s) entered`);
        }
    }

    // Mirrors BulkPcrStrategy.durablyDisable's exact pattern (mutate the live
    // config.strategies entry, writeConfig to persist it, then also flip
    // this.enabled in-memory since config.yml is only re-read on
    // restart/resync) - including its idempotency guard, even though
    // executeTrade's own phase/recordFiredToday state machine already makes
    // this a once-per-day call in practice; that guard was added to
    // BulkPcrStrategy only after a review round found a double-call path, so
    // it's included here up front rather than waiting for the same finding.
    private durablyDisable(reason: string): void {
        if (!this.enabled) return;
        const liveCfg = configService.getStrategyConfig('TopStockOptionsOpeningGapStrategy');
        liveCfg.enabled = false;
        configService.writeConfig(configService.getConfig());
        this.enabled = false;
        Log.log(`[${this.userId}] ${reason} - durably disabled. Flip enabled: true in config.yml manually to arm another run.`);
    }

    private async enterLeg(
        stock: RankedStock,
        lots: number,
        logEnabled: boolean
    ) {
        try {
            // optionType must be the raw 'CE'/'PE' strings used by the contract
            // master's own 'Option Type' field - NOT the CALL/PUT ('call'/'put')
            // constants from constants.ts, which are a different, sentiment-
            // check-only vocabulary.
            //
            // Deliberately using findNearestStrikeOption, not findATMOption:
            // the latter's strike-rounding step (STRIKE_STEP) only has entries
            // for NIFTY/SENSEX and falls back to a flat 50 for every other
            // symbol, which practically never matches a real listed strike
            // for an individual stock (strike increments vary wildly by price
            // band - e.g. 2.5/5/10/20/50/100).
            const optionType: 'CE' | 'PE' = stock.gapPct > 0 ? 'CE' : 'PE';
            const contract = AntContractMaster.getInstance().findNearestStrikeOption(stock.symbol, optionType, stock.latestOpen);
            const ltp = await ANT.getInstance().getQuote(contract.exch, contract.token);
            if (!ltp || ltp <= 0) {
                throw new Error(`invalid LTP ${ltp} for ${contract.tradingSymbol}`);
            }
            // leverageFactor = stock price / option price - how many option
            // points one stock-price point is worth. targetPercent assumes a
            // fixed ASSUMED_DELTA (not a broker-derived option Greek - just a
            // flat heuristic multiplier) so the target is sized in option
            // premium terms for roughly the same underlying move regardless
            // of how deep/far OTM the selected strike is. No stop-loss points
            // are computed - see enterPosition call below.
            //
            // Clamped to MAX_TARGET_PERCENT: for a cheap option relative to
            // its stock (high leverageFactor - e.g. stock=2000, ltp=2 gives
            // leverageFactor=1000, targetPercent=500%), an uncapped target
            // sits so many multiples above entry it may never realistically
            // be hit, leaving the resting sell (the only exit this leg has -
            // see enterPosition call below) resting unfilled indefinitely.
            const ASSUMED_DELTA = 0.5;
            const MAX_TARGET_PERCENT = 100;
            const leverageFactor = stock.latestOpen / ltp;
            const rawTargetPercent = leverageFactor * ASSUMED_DELTA;
            const targetPercent = Math.min(rawTargetPercent, MAX_TARGET_PERCENT);
            if (targetPercent < rawTargetPercent && logEnabled) {
                Log.log(`[${this.userId}] ${stock.symbol} targetPct clamped ${rawTargetPercent.toFixed(2)} -> ${targetPercent} (leverage=${leverageFactor.toFixed(2)})`);
            }
            const targetPoints = ltp * (targetPercent / 100);
            const lotSize = parseInt(contract.lotSize, 10);
            if (!lotSize || lotSize <= 0) {
                throw new Error(`invalid lotSize ${contract.lotSize} for ${contract.tradingSymbol}`);
            }
            const quantity = lotSize * lots;

            if (logEnabled) {
                Log.log(`[${this.userId}] ${stock.symbol} gap=${stock.gapPct}% dir=${optionType} ` +
                    `contract=${contract.tradingSymbol} ltp=${ltp} qty=${quantity} leverage=${leverageFactor.toFixed(2)} ` +
                    `targetPct=${targetPercent.toFixed(2)} target=${targetPoints.toFixed(2)}`);
            }

            // ANT/AliceBlue has no broker-native target-only order type
            // (placeBracketOrder requires both legs, placeCoverOrder is
            // SL-only) - 'target-only' tells enterPosition to place a plain
            // buy (still the full waitForFill/REST-fallback/
            // resolveUnconfirmedAntBuy fill-confirmation chain, just with no
            // broker-side bracket/cover legs) and set trade.targetPrice
            // itself BEFORE its own bookkeeping.recordFill, so the persisted
            // raw Mongo Buy doc correctly carries targetPrice for
            // restart-restore. This strategy is listed in exitMonitor.ts's
            // SELF_MANAGED_STRATEGY_TYPES, so exitMonitor never auto-triggers
            // on it (at entry OR after a restart's reconcileFromTrades) - the
            // resting target-only sell placed below is the sole actual exit,
            // and onOrderCancelled below re-places it if the broker cancels
            // it before it fills.
            const trade = await enterPosition(
                this.userId,
                contract.tradingSymbol,
                contract.token,
                quantity,
                contract.exch as 'NFO' | 'BFO',
                targetPoints,
                0,
                'target-only',
                { ltp, atMs: Date.now() }
            );

            // Sized from the ACTUAL fill price/quantity, not the pre-trade
            // ltp used above for leverage/targetPercent sizing - a plain
            // resting LIMIT sell the broker fills whenever the target is hit,
            // no quote subscription/monitoring needed on our side. Tracked in
            // activeLegs so onOrderCancelled/updateTrade below can find it
            // again by token.
            this.activeLegs.set(trade.token, {
                tradingSymbol: trade.tsym,
                exchange: contract.exch as 'NFO' | 'BFO',
                targetPrice: trade.targetPrice,
                retryCount: 0,
            });
            try {
                await placeLimitSellBareOnAnt(this.userId, trade.tsym, trade.token, trade.quantity, trade.targetPrice, contract.exch as 'NFO' | 'BFO');
            } catch (sellErr: any) {
                // The buy already filled and is live (recorded in bookkeeping)
                // with no resting exit order and no stop-loss of any kind -
                // distinct from "never entered" so an operator scanning logs
                // doesn't mistake this for a no-op skip.
                this.activeLegs.delete(trade.token);
                Log.log(`[${this.userId}] ALERT: ${stock.symbol} ${contract.tradingSymbol} qty=${trade.quantity} entry=${trade.price} FILLED but target sell placement failed - position is LIVE and UNPROTECTED: ${sellErr?.message ?? sellErr}`);
                throw sellErr;
            }

            Log.log(`[${this.userId}] TRADED ${stock.symbol} ${optionType} ${contract.tradingSymbol} qty=${trade.quantity} entry=${trade.price} target=${trade.targetPrice} (leverage=${leverageFactor.toFixed(2)} targetPct=${targetPercent.toFixed(2)})`);
        } catch (e) {
            Log.log(`[${this.userId}] ${stock.symbol} leg failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    // Fills for this strategy's exit sells arrive here asynchronously (see
    // strategiesProcess.ts's onFill -> strategy.updateTrade dispatch) -
    // clears the leg out of activeLegs once its target sell actually fills,
    // so a later, unrelated cancellation notification for the same token
    // (there shouldn't be one, but see onOrderCancelled's own guard) can't
    // find a stale entry and try to re-place an already-closed leg.
    updateTrade = async (trade: Trade): Promise<void> => {
        if (trade.action === 'Sell' && trade.token && this.activeLegs.has(trade.token)) {
            this.activeLegs.delete(trade.token);
            Log.log(`[${this.userId}] ${trade.tsym} target sell filled qty=${trade.quantity} @ ${trade.price} - leg closed`);
        }
    };

    // Called when the resting target sell placed above (placeLimitSellBareOnAnt)
    // is cancelled/rejected before it fills - e.g. a DAY-validity order
    // expiring unfilled at end of session, or a transient broker-side reject.
    // Without this, that leg's position (bought with no stop-loss by design)
    // would be left live and completely unprotected for the rest of the day
    // with no automatic recovery. Mirrors BulkPcrStrategy.onOrderCancelled's
    // margin-shortfall/retry-cap shape, simplified for a single ungrouped
    // order per leg (this strategy never chunks).
    onOrderCancelled = async (notification: OrderCancelledNotification): Promise<void> => {
        if (notification.action !== 'Sell') return;
        const leg = this.activeLegs.get(notification.instrumentToken);
        if (!leg || leg.tradingSymbol !== notification.tradingSymbol) return;

        if (notification.reason === 'REJECTED' && notification.rejectReason && MARGIN_SHORTFALL_REASON_PATTERN.test(notification.rejectReason)) {
            // Nothing left to sell against - most likely the position was
            // already closed outside the app. Retrying would just repeat the
            // same rejection forever.
            this.activeLegs.delete(notification.instrumentToken);
            Log.log(`[${this.userId}] ALERT: ${notification.tradingSymbol} exit sell REJECTED (${notification.rejectReason}) - looks like a margin/shortfall rejection, likely because the position is already closed at the broker. NOT re-placing - manual review required.`);
            return;
        }

        leg.retryCount++;
        if (leg.retryCount > TopStockOptionsOpeningGapStrategy.MAX_EXIT_RETRIES) {
            this.activeLegs.delete(notification.instrumentToken);
            Log.log(`[${this.userId}] ALERT: ${notification.tradingSymbol} exit sell cancelled/rejected ${leg.retryCount} times in a row - giving up on auto re-placement. Position is LIVE and UNPROTECTED - manual review required.`);
            return;
        }

        Log.log(`[${this.userId}] ${notification.tradingSymbol} exit sell ${notification.reason}${notification.rejectReason ? `: ${notification.rejectReason}` : ''} (qty=${notification.quantity}) - re-placing at target=${leg.targetPrice} (attempt ${leg.retryCount})`);
        if (leg.retryCount > 1) {
            // Back off before resubmitting a repeat rejection instead of
            // tight-looping identical orders - same lesson BulkPcrStrategy's
            // own retry cap was added for (2026-10-15 incident).
            await new Promise((resolve) => setTimeout(resolve, TopStockOptionsOpeningGapStrategy.EXIT_RETRY_DELAY_MS));
        }
        try {
            await placeLimitSellBareOnAnt(this.userId, notification.tradingSymbol, notification.instrumentToken, notification.quantity, leg.targetPrice, notification.exchange);
        } catch (e: any) {
            Log.log(`[${this.userId}] ALERT: ${notification.tradingSymbol} re-place of cancelled exit sell FAILED - position is LIVE and UNPROTECTED: ${e?.message ?? e}`);
        }
    };

}
