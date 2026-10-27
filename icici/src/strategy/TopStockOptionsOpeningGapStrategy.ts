import Log from '../util/Log';
import { MOCK_BROKER } from '../constants';
import { NiftyQuote, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import { toPercentNumber } from '../prism/percentConfig';
import AntContractMaster from '../ant/AntContractMaster';
import ANT from '../ant/ANT';
import KiteContractMaster from '../kite/KiteContractMaster';
import BreezeContractMaster from '../breeze/BreezeContractMaster';
import { roundToTick } from '../kite/Kite';
import OrderClient from '../processes/strategies/OrderClient';
import { Strategy } from './strategy';
import { localDayKey } from './dayKey';
import fs from 'fs';
import path from 'path';
import moment from 'moment';
import { normalizeBrokerList } from '../util/brokerName';

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

type OptionContract = { token: string; exch: string; tradingSymbol: string; lotSize: string; strike: number; expiry: string };

type BrokerName = 'kite' | 'breeze' | 'ant';

const ATTEMPT_THROTTLE_MS = 15_000;

// One resolved, broker-specific tradable contract for a ranked stock -
// `instrumentToken` is always the ANT-native common token (see
// AntContractMaster.ts's resolveCommonToken comment on why - live
// ticks/restart-reconciliation elsewhere in the app key off this, not a
// broker-native token), even for a kite/breeze leg; `tradingSymbol` is
// that broker's OWN trading symbol, used to actually place the order.
interface BrokerLeg {
    stock: RankedStock;
    optionType: 'CE' | 'PE';
    broker: BrokerName;
    tradingSymbol: string;
    instrumentToken: string;
    exchange: 'NFO' | 'BFO';
    lotSize: number;
}

export default class TopStockOptionsOpeningGapStrategy extends Strategy {
    private phase: 'idle' | 'running' | 'done' = 'idle';
    private tradingDay: string | null = null;
    private lastAttemptAt = 0;

    // phase alone has no day boundary - once it reaches 'done' on day N it
    // stays 'done' forever in a long-lived process (npm run processes has no
    // nightly restart), since processNiftyQuote's `phase !== 'idle'` guard
    // short-circuits before hasFiredToday() (which IS day-scoped) is ever
    // consulted again. Mirrors BulkPcrAutoStartStrategy's resetIfNewDay().
    private resetIfNewDay(now: moment.Moment) {
        const today = localDayKey();
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

    // config.yml's `brokers: [kite, breeze, ant]` (or the legacy single
    // `broker: ant` field, kept as a fallback for a not-yet-migrated config)
    // normalized to the canonical broker names (legacy 'zerodha' is accepted
    // as an alias for 'kite' via normalizeBrokerName), unknown names are dropped (logged, not thrown - one bad
    // entry must not block the other configured brokers), and an empty/
    // missing config falls back to ['ant'] (this strategy's original,
    // ANT-only behavior).
    private configuredBrokers(config: any): BrokerName[] {
        const raw: string[] = Array.isArray(config.brokers) && config.brokers.length > 0
            ? config.brokers
            : (config.broker ? [config.broker] : []);
        const normalized = normalizeBrokerList(raw);
        const deduped = Array.from(new Set(normalized));
        const valid: BrokerName[] = deduped.filter((b): b is BrokerName => b === 'kite' || b === 'breeze' || b === 'ant');
        const invalid = deduped.filter((b) => !valid.includes(b as BrokerName));
        if (invalid.length > 0) {
            Log.log(`[${this.userId}] ALERT: config lists unknown broker(s) [${invalid.join(',')}] - dropping. Running only: ${valid.join(',') || 'none'}`);
        }
        return valid.length > 0 ? valid : ['ant'];
    }

    private hasFiredToday(): boolean {
        try {
            const recorded = JSON.parse(fs.readFileSync(this.firedTodayFile, 'utf8')) as string;
            return recorded === localDayKey();
        } catch {
            return false;
        }
    }

    // Returns false if the record could not be written. The caller must then not execute -
    // executing without the record would let a restart re-execute this same day.
    private recordFiredToday(): boolean {
        try {
            fs.writeFileSync(this.firedTodayFile, JSON.stringify(localDayKey()));
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
        const start = moment().hour(TRADING_WINDOW_START.hour).minute(TRADING_WINDOW_START.minute).second(0).millisecond(0);
        const end = moment().hour(TRADING_WINDOW_END.hour).minute(TRADING_WINDOW_END.minute).second(0).millisecond(0);
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
        // A retryable skip (stale CSV, no OHLC yet, ...) returns without recording the day as fired, so the next tick would
        // re-run the whole 100-stock OHLC fetch. Space attempts out.
        const nowMs = Date.now();
        if (nowMs - this.lastAttemptAt < ATTEMPT_THROTTLE_MS) return;
        this.lastAttemptAt = nowMs;
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
        this.lastAttemptAt = 0;
        Log.log(`[${this.userId}] Reset via admin request`);
    }

    private async executeTrade() {
        // Stage timings (ms) go to the log unconditionally, not behind logEnabled -
        // Log.log's own HH:mm:ss prefix is second-resolution, so sub-second
        // latency is only visible through these explicit millisecond laps.
        const tStart = Date.now();
        let tLap = tStart;
        const lap = (stage: string) => {
            const now = Date.now();
            Log.log(`[${this.userId}] timing ${stage}: +${now - tLap}ms (total ${now - tStart}ms)`);
            tLap = now;
        };

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
        const marketProtectionPercent: number = toPercentNumber(config.marketProtectionPercent) ?? 5;

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
        lap(`universe+token resolve (${equityTokens.length}/${universe.length})`);
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
        lap('ohlc fetch (ANT batch)');

        const ranked: RankedStock[] = equityTokens
            .map(({ symbol, token }) => {
                const ohlc = ohlcMap.get(token);
                // A zero/missing open or prevClose (pre-open, illiquid) would give Infinity/NaN and sort to rank 1.
                if (!ohlc || !(ohlc.open > 0) || !(ohlc.prevClose > 0)) return null;
                const gapPct = ((ohlc.open - ohlc.prevClose) / ohlc.prevClose) * 100;
                if (!Number.isFinite(gapPct)) return null;
                return { symbol, gapPct, latestOpen: ohlc.open };
            })
            .filter((r): r is RankedStock => r !== null)
            .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
        lap(`rank (${ranked.length} usable)`);
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

        const brokers = this.configuredBrokers(config);
        if (logEnabled) {
            Log.log(`[${this.userId}] brokers: ${brokers.join(',')}`);
        }

        // Contract resolution (local lookup, no network) for every selected
        // stock x configured broker, isolated per-(stock,broker) so one
        // missing/malformed contract master entry doesn't drop the rest.
        // ANT's own contract is always resolved first, even when 'ant' isn't
        // in `brokers` - it is the ranking-independent reference strike/
        // expiry every other broker's lookup is pinned to (see plan: ANT
        // stays the sole market-data source, each broker then resolves its
        // OWN tradable contract for that SAME strike/expiry).
        const resolvedLegs: BrokerLeg[] = [];
        for (const stock of selected) {
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
            let antContract: OptionContract;
            try {
                antContract = AntContractMaster.getInstance().findNearestStrikeOption(stock.symbol, optionType, stock.latestOpen);
            } catch (e: any) {
                Log.log(`[${this.userId}] ${stock.symbol} ANT contract resolution failed (skipping all brokers for this stock): ${e?.message ?? e}`);
                continue;
            }
            const exchange = antContract.exch as 'NFO' | 'BFO';

            for (const broker of brokers) {
                if (broker === 'ant') {
                    resolvedLegs.push({
                        stock, optionType, broker,
                        tradingSymbol: antContract.tradingSymbol,
                        instrumentToken: antContract.token,
                        exchange,
                        lotSize: parseInt(antContract.lotSize, 10),
                    });
                    continue;
                }
                if (broker === 'kite') {
                    try {
                        const z = await KiteContractMaster.getInstance().findExactOptionBySymbol(stock.symbol, antContract.strike, antContract.expiry, optionType);
                        resolvedLegs.push({
                            stock, optionType, broker,
                            tradingSymbol: z.tradingSymbol,
                            instrumentToken: antContract.token, // ANT common token - see BrokerLeg's own comment
                            exchange: z.exchange,
                            lotSize: z.lotSize,
                        });
                    } catch (e: any) {
                        Log.log(`[${this.userId}] ${stock.symbol} kite contract resolution failed, skipping this broker's leg only: ${e?.message ?? e}`);
                    }
                    continue;
                }
                if (broker === 'breeze') {
                    try {
                        const shortName = (await BreezeContractMaster.getInstance().getEquityStockCode(stock.symbol)) ?? stock.symbol;
                        // Breeze's own order-placement path (breezeExecutor.ts's parseTsym)
                        // requires a tradingSymbol matching ^[A-Za-z]+?\d+(CE|PE)$ - a
                        // shortName with digits/symbols (e.g. 'M&M') would build an
                        // unparseable tsym downstream; skip this broker's leg rather than
                        // dispatch an order that's guaranteed to fail inside `order`.
                        if (!/^[A-Za-z]+$/.test(shortName)) {
                            Log.log(`[${this.userId}] ${stock.symbol} breeze shortName '${shortName}' is not a plain-letters tsym prefix - skipping breeze leg`);
                            continue;
                        }
                        const expiryDdMmmYyyy = moment(antContract.expiry).format('DD-MMM-YYYY');
                        const record = await BreezeContractMaster.getInstance().findOption(shortName, expiryDdMmmYyyy, antContract.strike, optionType);
                        if (!record) {
                            Log.log(`[${this.userId}] ${stock.symbol} no breeze contract for ${shortName} strike=${antContract.strike} expiry=${expiryDdMmmYyyy} ${optionType} - skipping breeze leg`);
                            continue;
                        }
                        resolvedLegs.push({
                            stock, optionType, broker,
                            tradingSymbol: `${shortName}${antContract.strike}${optionType}`,
                            instrumentToken: antContract.token, // ANT common token - see BrokerLeg's own comment
                            exchange,
                            lotSize: Number(record.lotSize),
                        });
                    } catch (e: any) {
                        Log.log(`[${this.userId}] ${stock.symbol} breeze contract resolution failed, skipping this broker's leg only: ${e?.message ?? e}`);
                    }
                    continue;
                }
            }
        }
        lap(`contract resolve (${resolvedLegs.length} leg(s) across ${selected.length} stock(s) x ${brokers.length} broker(s))`);
        if (resolvedLegs.length === 0) {
            Log.log(`[${this.userId}] no stock(s) resolved to a contract on any broker, skipping`);
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
        lap('record fired-today');

        // Fire-and-forget: dispatch every leg (buy -> own fill -> own target sell) and return immediately.
        // recordFiredToday() above is already persisted, so processNiftyQuote's finally sees 'done' and a
        // restart cannot re-enter these legs. Aggregation/durablyDisable happen in the background.
        const tDispatch = Date.now();
        const legPromises = resolvedLegs.map((leg) =>
            this.enterLeg(leg, lots, logEnabled, marketProtectionPercent));
        void Promise.allSettled(legPromises).then((results) => {
            Log.log(`[${this.userId}] timing all ${resolvedLegs.length} leg(s) settled: ${Date.now() - tDispatch}ms after dispatch (total ${Date.now() - tStart}ms since executeTrade start)`);
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
            const notEnteredCount = resolvedLegs.length - enteredCount;
            if (notEnteredCount > 0) {
                Log.log(`[${this.userId}] ${notEnteredCount}/${resolvedLegs.length} leg(s) failed to enter - see individual leg logs above`);
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
        leg: BrokerLeg,
        lots: number,
        logEnabled: boolean,
        marketProtectionPercent: number
    ): Promise<{ entered: boolean }> {
        const { stock, optionType, broker } = leg;
        try {
            if (!(stock.latestOpen > 0)) {
                throw new Error(`invalid latestOpen ${stock.latestOpen} for ${leg.tradingSymbol}`);
            }
            if (!leg.lotSize || leg.lotSize <= 0) {
                throw new Error(`invalid lotSize ${leg.lotSize} for ${leg.tradingSymbol}`);
            }
            const quantity = leg.lotSize * lots;
            const tLeg = Date.now();

            if (logEnabled) {
                Log.log(`[${this.userId}] ${stock.symbol} gap=${stock.gapPct}% dir=${optionType} broker=${broker} ` +
                    `contract=${leg.tradingSymbol} qty=${quantity} protection=${marketProtectionPercent}%`);
            }

            if (broker === 'ant') {
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
                    tradingSymbol: leg.tradingSymbol,
                    instrumentId: leg.instrumentToken,
                    quantity,
                    exchange: leg.exchange,
                    underlyingOpen: stock.latestOpen,
                    marketProtectionPercent,
                    product: 'LONGTERM', // overnight (NRML-equivalent), not the INTRADAY default the broker squares off at ~3:20pm
                });
                const buyMs = Date.now() - tLeg;

                // Sized from the ACTUAL fill price/quantity, not any pre-trade estimate.
                // trade.targetPrice can come back unset (antExecutor's entryPrice<=0 guard) if
                // the fill price itself was unusable - never place a resting sell at a
                // falsy/zero price in that case; antExecutor already logged the ALERT.
                if (!(trade.targetPrice > 0)) {
                    Log.log(`[${this.userId}] ALERT: ${stock.symbol} ${leg.tradingSymbol} broker=ant qty=${trade.quantity} entry=${trade.price} FILLED but has no usable target price - skipping sell placement, position is LIVE and UNPROTECTED (buy=${buyMs}ms)`);
                    return { entered: true };
                }
                const tSell = Date.now();
                try {
                    await OrderClient.getInstance().antPlaceLimitSellBare(this.userId, {
                        tradingSymbol: trade.tsym,
                        instrumentId: trade.token,
                        quantity: trade.quantity,
                        price: trade.targetPrice,
                        exchange: leg.exchange,
                        product: 'LONGTERM', // must match the entry's product
                    });
                } catch (sellErr: any) {
                    const sellMs = Date.now() - tSell;
                    Log.log(`[${this.userId}] ALERT: ${stock.symbol} ${leg.tradingSymbol} broker=ant qty=${trade.quantity} entry=${trade.price} FILLED but target sell placement failed - position is LIVE and UNPROTECTED (buy=${buyMs}ms sell=${sellMs}ms): ${sellErr?.message ?? sellErr}`);
                    return { entered: true };
                }

                Log.log(`[${this.userId}] TRADED ${stock.symbol} ${optionType} broker=ant ${leg.tradingSymbol} qty=${trade.quantity} entry=${trade.price} target=${trade.targetPrice} (buy=${buyMs}ms sell=${Date.now() - tSell}ms leg=${Date.now() - tLeg}ms)`);
                return { entered: true };
            }

            // kite/breeze: no broker-native target-only order type either (and
            // these "bare" buy primitives are themselves already a marketable
            // LIMIT at the live best bid/ask, not a true MARKET order - see
            // marketBuyBareOnKite/marketBuyBareOnBreeze's own header comments).
            // Mirrors the ant branch's own shape: buy -> real fill -> own resting
            // target-only limit sell, sized from the ACTUAL fill price exactly
            // like antExecutor's marketEntry formula - min(0.25 delta x 1% of the
            // underlying's open, the premium actually paid), tick-rounded.
            const trade = await OrderClient.getInstance().butterflyBuyLeg(this.userId, {
                broker,
                tradingSymbol: leg.tradingSymbol,
                instrumentToken: leg.instrumentToken,
                quantity,
                exchange: leg.exchange,
            });
            const buyMs = Date.now() - tLeg;

            if (!(trade.price > 0)) {
                Log.log(`[${this.userId}] ALERT: ${stock.symbol} ${leg.tradingSymbol} broker=${broker} qty=${trade.quantity} entry=${trade.price} FILLED but price is unusable - skipping sell placement, position is LIVE and UNPROTECTED (buy=${buyMs}ms)`);
                return { entered: true };
            }
            const targetPoints = Math.min(0.0025 * stock.latestOpen, trade.price);
            const targetPrice = roundToTick(trade.price + targetPoints);
            const tSell = Date.now();
            try {
                await OrderClient.getInstance().brokerPlaceLimitSellBare(this.userId, {
                    broker,
                    tradingSymbol: trade.tsym,
                    instrumentToken: trade.token,
                    quantity: trade.quantity,
                    price: targetPrice,
                    exchange: leg.exchange,
                });
            } catch (sellErr: any) {
                const sellMs = Date.now() - tSell;
                Log.log(`[${this.userId}] ALERT: ${stock.symbol} ${leg.tradingSymbol} broker=${broker} qty=${trade.quantity} entry=${trade.price} FILLED but target sell placement failed - position is LIVE and UNPROTECTED (buy=${buyMs}ms sell=${sellMs}ms): ${sellErr?.message ?? sellErr}`);
                return { entered: true };
            }

            Log.log(`[${this.userId}] TRADED ${stock.symbol} ${optionType} broker=${broker} ${leg.tradingSymbol} qty=${trade.quantity} entry=${trade.price} target=${targetPrice} (buy=${buyMs}ms sell=${Date.now() - tSell}ms leg=${Date.now() - tLeg}ms)`);
            return { entered: true };
        } catch (e: any) {
            Log.log(`[${this.userId}] ${stock.symbol} broker=${broker} leg failed: ${e?.message ?? e}`);
            throw e;
        }
    }

}
