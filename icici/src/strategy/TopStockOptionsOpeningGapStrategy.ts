import Log from '../util/Log';
import { MOCK_BROKER } from '../constants';
import { NiftyQuote, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import AntContractMaster from '../ant/AntContractMaster';
import ANT from '../ant/ANT';
import OrderClient from '../processes/strategies/OrderClient';
import { Strategy } from './strategy';
import fs from 'fs';
import path from 'path';
import moment from 'moment';

// NIFTY 50 + NIFTY Next 50 constituents (100 symbols), snapshotted from
// NSE's own unauthenticated index-constituent CSVs (the same source
// /home/karthikeyan/tools/ohlc's screener.ts fetches live on every run -
// see that project's getNseIndexSymbols). A static snapshot, not fetched
// live here, since index membership changes only a couple of times a year
// and this strategy's 9:10-9:20 window has no time margin for an extra
// network round-trip to NSE on top of the ANT quote calls below. Re-run the
// same NSE CSV fetch (ind_nifty50list.csv/ind_niftynext50list.csv) by hand
// every few months to refresh this file if desired - not wired to any cron.
// Anchored to __dirname (not process.cwd()), matching AntContractMaster.ts's
// own NFO_PATH/BFO_PATH convention - data/ isn't copied into dist/, but
// __dirname's '../../data/...' lands at the repo root the same way whether
// this runs from src/strategy/ or its compiled dist/strategy/ twin.
const STOCK_LIST_PATH = path.join(__dirname, '../../data/nifty100_symbols.txt');
let stockSymbolsCache: string[] | null = null;
function loadStockSymbols(): string[] {
    if (!stockSymbolsCache) {
        stockSymbolsCache = fs.readFileSync(STOCK_LIST_PATH, 'utf8')
            .split('\n').map(s => s.trim()).filter(Boolean);
    }
    return stockSymbolsCache;
}

// Replaces the external Chartink/Yahoo-Finance screener's 10:05 cron-fed CSV
// (gap-screener.csv) entirely - that pipeline's own "run after 9:30" note
// was only ever needed for its first-15-min-candle breakout feature, not
// the raw open-vs-prevClose gap number this strategy actually uses (see
// executeTrade below, which computes that directly from ANT's own OHLC
// endpoint - confirmed live 2026-10-16 to carry `open`/`close` fields
// already). Normal window starts right at the point gap data becomes
// meaningful (NSE's pre-open equilibrium price settles ~9:08-9:12) and
// closes 10 minutes later, well clear of BulkPcrAutoStartStrategy's own
// slots (10:35 earliest).
const TRADING_WINDOW_START = { hour: 9, minute: 10 };
const TRADING_WINDOW_END = { hour: 9, minute: 20 };

interface RankedStock {
    symbol: string;
    gapPct: number;
    latestOpen: number;
}

type OptionContract = { token: string; exch: string; tradingSymbol: string; lotSize: string };

export default class TopStockOptionsOpeningGapStrategy extends Strategy {
    private phase: 'idle' | 'running' | 'done' = 'idle';
    private tradingDay: string | null = null;

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
            //
            // NOTE: 'done' means "legs dispatched", not "legs settled" - executeTrade
            // is fire-and-forget (see its own comment), so this.phase reaches 'done'
            // here while the dispatched buys/fills/sells may still be in flight in the
            // background. This is safe for phase's ONLY actual job (blocking a second
            // processNiftyQuote tick from re-firing - line below), since that's already
            // independently guarded by the persisted recordFiredToday() marker, not by
            // this flag. But do NOT read this.phase elsewhere as "trading finished for
            // today" - no such external read exists today; if one is ever added (e.g.
            // an admin reset/status endpoint), it must wait on the leg-aggregation
            // Promise.allSettled in executeTrade instead, not this.phase.
            this.phase = this.hasFiredToday() ? 'done' : 'idle';
        }
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false; // exit is a plain resting target-only limit sell, placed once right after entry - no quote-driven monitoring needed
    }

    processOptionQuote(quote: OptionQuote) {
        // no-op (see canHandleOptionQuote)
    }

    getMonitorConfig() {
        return null; // exit is a separately-placed resting limit sell per leg, not a GTT/bracket order
    }

    reset(): void {
        this.phase = 'idle';
        Log.log(`[${this.userId}] Reset via admin request`);
    }

    private async executeTrade() {
        // Not configService.getStrategyConfig(type) - that returns only the FIRST
        // config.yml entry of this type, regardless of userId. Same (cfg.userId ||
        // type) === userId convention durablyDisable below (and
        // exitMonitor.ts's isSelfManagedTradeUser) already uses for the identical
        // type-vs-instance distinction - a second instance under a different
        // userId must trade off its OWN config.yml block, not silently inherit
        // whichever instance's block happens to be listed first.
        const config = configService.getConfig().strategies?.find(
            (s) => s.type === 'TopStockOptionsOpeningGapStrategy' && (s.userId || s.type) === this.userId
        ) ?? { type: 'TopStockOptionsOpeningGapStrategy', enabled: false };
        const rankStart: number = config.rankStart ?? 3;
        const rankCount: number = config.rankCount ?? 3;
        const lots: number = config.lots ?? 1;
        const logEnabled: boolean = config.logEnabled ?? true;
        const marketProtectionPercent: number = config.marketProtectionPercent ?? 5;

        const universe = loadStockSymbols();

        // Resolve each stock's NSE cash-segment token, isolated per-symbol so
        // one missing/delisted/renamed symbol in the static universe list
        // doesn't drop the rest. findEquityToken is a local-only lookup (no
        // network), so this whole loop is cheap.
        const equityTokens: { symbol: string; token: string }[] = [];
        for (const symbol of universe) {
            const resolved = AntContractMaster.getInstance().findEquityToken(symbol);
            if (resolved) equityTokens.push({ symbol, token: resolved.token });
            else Log.log(`[${this.userId}] ${symbol} has no NSE equity token in the contract master, skipping`);
        }
        if (equityTokens.length === 0) {
            Log.log(`[${this.userId}] no stock(s) resolved to an NSE equity token, skipping`);
            return;
        }

        // One batched call for the entire universe's open+prevClose, same
        // 429-avoidance reasoning as the option-premium batching further
        // down - up to 100 stocks is well beyond the "1-2 rapid sequential
        // calls" that trips AliceBlue's OHLC rate limit if done one at a time.
        const ohlcMap = await ANT.getInstance().getOpenAndPrevClose(
            equityTokens.map((e) => ({ exchange: 'NSE', token: e.token }))
        );

        const ranked: RankedStock[] = equityTokens
            .map(({ symbol, token }) => {
                const ohlc = ohlcMap.get(token);
                if (!ohlc) return null;
                const gapPct = ((ohlc.open - ohlc.prevClose) / ohlc.prevClose) * 100;
                return { symbol, gapPct, latestOpen: ohlc.open };
            })
            .filter((r): r is RankedStock => r !== null)
            .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
        if (ranked.length === 0) {
            Log.log(`[${this.userId}] no stock(s) had usable open/prevClose data yet (${equityTokens.length} token(s) queried) - skipping, will retry next tick within the window`);
            return;
        }

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

        // Contract resolution (local lookup, no network) for every selected
        // stock, isolated per-stock so one missing/malformed contract master
        // entry doesn't drop the rest.
        const resolvedLegs: { stock: RankedStock; optionType: 'CE' | 'PE'; contract: OptionContract }[] = [];
        for (const stock of selected) {
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
                resolvedLegs.push({ stock, optionType, contract });
            } catch (e: any) {
                Log.log(`[${this.userId}] ${stock.symbol} contract resolution failed: ${e?.message ?? e}`);
            }
        }
        if (resolvedLegs.length === 0) {
            Log.log(`[${this.userId}] no stock(s) resolved to a contract, skipping`);
            return;
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

        // Fire-and-forget: dispatch every leg (buy -> own fill -> own target sell) and return immediately.
        // recordFiredToday() above is already persisted, so processNiftyQuote's finally sees 'done' and a
        // restart cannot re-enter these legs. Aggregation/durablyDisable happen in the background.
        const legPromises = resolvedLegs.map(({ stock, optionType, contract }) =>
            this.enterLeg(stock, optionType, contract, lots, logEnabled, marketProtectionPercent));
        void Promise.allSettled(legPromises).then((results) => {
            // Counts by whether the buy actually filled (enterLeg's `entered`
            // flag), not by Promise.allSettled's fulfilled/rejected alone - a leg
            // whose buy filled but whose resting-sell placement then failed
            // resolves with entered:true (its own ALERT already logged inside
            // enterLeg), and must count as entered here too, not as a failure to
            // enter. Otherwise, if every leg's sell placement failed while every
            // buy succeeded, this would read as "0 entered" and leave the
            // strategy armed to open more unprotected positions on a future day
            // while live, unprotected positions are already open right now.
            const enteredCount = results.filter((r) => r.status === 'fulfilled' && r.value.entered).length;
            const notEnteredCount = selected.length - enteredCount;
            if (notEnteredCount > 0) {
                Log.log(`[${this.userId}] ${notEnteredCount}/${selected.length} leg(s) failed to enter - see individual leg logs above`);
            }

            // Keep the existing rule: durably disable only if at least one leg actually traded;
            // if every leg failed, stay enabled so a future day still gets an attempt.
            if (enteredCount > 0) this.durablyDisable(`${enteredCount}/${selected.length} leg(s) entered`);
        }).catch((e: any) => {
            Log.log(`[${this.userId}] ALERT: leg aggregation failed: ${e?.message ?? e}`);
        });
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
        // Not configService.getStrategyConfig(type) - that returns only the
        // FIRST config.yml entry of this type, regardless of userId. config.yml
        // can configure multiple instances of this strategy under distinct
        // userId values (see firedTodayFile's own comment above), and a second
        // instance's durablyDisable must mutate ITS OWN entry, not silently
        // disable whichever entry happens to be listed first. Same (cfg.userId
        // || type) === userId convention exitMonitor.ts's isSelfManagedTradeUser
        // already uses for the identical type-vs-instance distinction.
        const liveCfg = configService.getConfig().strategies?.find(
            (s) => s.type === 'TopStockOptionsOpeningGapStrategy' && (s.userId || s.type) === this.userId
        );
        if (!liveCfg) {
            Log.log(`[${this.userId}] ALERT: durablyDisable could not find this instance's own config.yml entry - NOT persisted, flip enabled: false manually.`);
            this.enabled = false;
            return;
        }
        liveCfg.enabled = false;
        configService.writeConfig(configService.getConfig());
        this.enabled = false;
        Log.log(`[${this.userId}] ${reason} - durably disabled. Flip enabled: true in config.yml manually to arm another run.`);
    }

    // Returns { entered: true } whenever the buy actually filled, even if the
    // subsequent resting-sell placement failed (logged as its own ALERT,
    // below) - the caller (executeTrade) uses this, not whether the whole
    // leg fully succeeded end to end, to decide both the failure count log
    // and whether durablyDisable should treat today as "something was
    // actually traded." Throws (never resolves) only for a failure BEFORE
    // any order was placed - those are genuine non-entries.
    private async enterLeg(
        stock: RankedStock,
        optionType: 'CE' | 'PE',
        contract: OptionContract,
        lots: number,
        logEnabled: boolean,
        marketProtectionPercent: number
    ): Promise<{ entered: boolean }> {
        try {
            if (!(stock.latestOpen > 0)) {
                throw new Error(`invalid latestOpen ${stock.latestOpen} for ${contract.tradingSymbol}`);
            }
            const lotSize = parseInt(contract.lotSize, 10);
            if (!lotSize || lotSize <= 0) {
                throw new Error(`invalid lotSize ${contract.lotSize} for ${contract.tradingSymbol}`);
            }
            const quantity = lotSize * lots;

            if (logEnabled) {
                Log.log(`[${this.userId}] ${stock.symbol} gap=${stock.gapPct}% dir=${optionType} ` +
                    `contract=${contract.tradingSymbol} qty=${quantity} protection=${marketProtectionPercent}%`);
            }

            // ANT/AliceBlue has no broker-native target-only order type
            // (placeBracketOrder requires both legs, placeCoverOrder is
            // SL-only), so this is just buy, wait for the real fill, then
            // place a separate resting target-only limit sell - nothing more
            // (no re-place-on-cancel, no reconcile: kept deliberately simple
            // per this strategy's single-shot, single-order-per-leg shape).
            //
            // Routed through OrderClient/IPC into the `order` process rather
            // than calling antExecutor.ts directly - this strategy runs in
            // the separate `strategies` process, where antExecutor.ts's
            // bookkeeping.ts/exitMonitor.ts/pendingAntLimitOrders.ts
            // singletons are disconnected shadow copies that nothing else in
            // the app ever reads from.
            //
            // No pre-trade option LTP any more: buys MARKET (with market
            // protection), and the target is sized server-side (antExecutor)
            // from the real fill price and stock.latestOpen.
            const trade = await OrderClient.getInstance().antBuyTargetOnly(this.userId, {
                tradingSymbol: contract.tradingSymbol,
                instrumentId: contract.token,
                quantity,
                exchange: contract.exch as 'NFO' | 'BFO',
                underlyingOpen: stock.latestOpen,
                marketProtectionPercent,
            });

            // Sized from the ACTUAL fill price/quantity, not any pre-trade estimate.
            // trade.targetPrice can come back unset (antExecutor's entryPrice<=0 guard) if
            // the fill price itself was unusable - never place a resting sell at a
            // falsy/zero price in that case; antExecutor already logged the ALERT.
            if (!(trade.targetPrice > 0)) {
                Log.log(`[${this.userId}] ALERT: ${stock.symbol} ${contract.tradingSymbol} qty=${trade.quantity} entry=${trade.price} FILLED but has no usable target price - skipping sell placement, position is LIVE and UNPROTECTED`);
                return { entered: true };
            }
            try {
                await OrderClient.getInstance().antPlaceLimitSellBare(this.userId, {
                    tradingSymbol: trade.tsym,
                    instrumentId: trade.token,
                    quantity: trade.quantity,
                    price: trade.targetPrice,
                    exchange: contract.exch as 'NFO' | 'BFO',
                });
            } catch (sellErr: any) {
                // The buy already filled and is live (recorded in bookkeeping)
                // with no resting exit order and no stop-loss of any kind -
                // distinct from "never entered" so an operator scanning logs
                // doesn't mistake this for a no-op skip. Resolved (entered:
                // true), not thrown - a live, already-executed trade must
                // never be miscounted as "failed to enter" by the caller,
                // which would leave durablyDisable thinking nothing traded.
                Log.log(`[${this.userId}] ALERT: ${stock.symbol} ${contract.tradingSymbol} qty=${trade.quantity} entry=${trade.price} FILLED but target sell placement failed - position is LIVE and UNPROTECTED: ${sellErr?.message ?? sellErr}`);
                return { entered: true };
            }

            Log.log(`[${this.userId}] TRADED ${stock.symbol} ${optionType} ${contract.tradingSymbol} qty=${trade.quantity} entry=${trade.price} target=${trade.targetPrice}`);
            return { entered: true };
        } catch (e) {
            Log.log(`[${this.userId}] ${stock.symbol} leg failed: ${e?.message ?? e}`);
            throw e;
        }
    }

}
