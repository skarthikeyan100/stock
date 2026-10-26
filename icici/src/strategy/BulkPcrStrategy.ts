import Log from '../util/Log';
import { CALL, PUT } from '../constants';
import { NiftyQuote, OptionQuote, SensexQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import Mongo from '../tools/mongo';
import { Strategy } from './strategy';
import { roundToTick } from '../zerodha/Zerodha';
import MomentumSignal from './MomentumSignal';
import { isPastMarketClose } from '../util/marketHours';
import { watchTokenOnSource, unwatchTokenOnSource } from '../processes/strategies/tokenRouter';
import { PnlStop } from './PnlStop';
import { sleep } from '../util/sleep';

const PCR_WINDOW_POINTS = 300; // same window width ContinuousStrategy uses around spot

// Minimum gap between resolveEntryRight attempts (PCR option-chain fetch +
// momentum's ATM subscribe/unsubscribe round trip). NiftyQuote ticks arrive
// several times a second, and without this throttle a momentum/PCR
// disagreement (which retries "on the next tick" by design) hammers ANT's
// getOptionChainPCR/OHLC endpoints at that same multi-per-second rate -
// live incident 2026-10-12: ~2-3 attempts/sec for several minutes 429'd
// AliceBlue's OHLC endpoint, which then made the real chunkedBuyIndex entry
// (once PCR/momentum finally agreed) fail outright with the same 429,
// landing the broker position in phase='error' for no reason other than
// this strategy's own call volume.
const ENTRY_ATTEMPT_THROTTLE_MS = 10_000;
// Minimum gap between retries of a pending pair-side buy (see retryPendingRebuys).
const REBUY_RETRY_THROTTLE_MS = 10_000;
// A buy that was rejected or unfilled is retried at most this many times (transient failures only; a margin
// rejection is never retried as-is - see onBuyNotFilled). Live 2026-10-22: ANT's hedge buy was retried 18 times.
const MAX_BUY_RETRIES = 3;
// Headroom kept when shrinking a hedge to fit margin: the premium moves between attempts.
const MARGIN_RESIZE_BUFFER = 0.05;
// Lot sizes needed to round a reduced quantity down to a whole lot. Same values as
// bookkeeping.getInstrumentLotSize, which lives in the order process and is not importable here.
const LOT_SIZE: Record<'NIFTY' | 'SENSEX', number> = { NIFTY: 65, SENSEX: 20 };

// onOrderCancelled's re-placement cap/backoff (live incident 2026-10-15 - see BrokerPosition's
// exitRejectCount comment). A rejection whose broker-supplied reason looks like a margin/
// shortfall problem is never retried at all: it means there's nothing left to sell against
// (e.g. the position was already closed outside the app), and resubmitting the identical
// order will only be rejected identically forever.
// Counts RE-PLACEMENTS after the original (non-retry) placement, not total placements -
// exitRejectCount increments once per rejection and is checked with `>`, so rejections 1-5 each
// still get a retry (5 re-placements total) and rejection 6 is what stops it. "6 total
// placements of this exit" (the original plus 5 retries) is the same behavior described a
// different way, not a bug - flagged twice on review as apparently off-by-one, so spelling it
// out here to save a third look.
const MAX_EXIT_REJECT_RETRIES = 5;
const EXIT_REJECT_RETRY_DELAY_MS = 5000;
// Rejections more than this far apart don't count as the same streak - narrowed on review:
// a bare "insufficient" or "margin" match was broad enough to catch an unrelated transient
// rejection (e.g. a liquidity/order-book message) on its very first occurrence and stop retrying
// forever. Requiring "margin" together with a shortfall/insufficiency word is a closer match to
// the actual broker wording this guards against ("insufficient margin" / "margin shortfall").
// FIX (found on re-review): the first version used `[^a-z]{0,20}` for the gap between the two
// words, which excludes ANY letter - so ordinary English phrasing with connector words in
// between ("Margin is insufficient", "Not enough margin to cover order") never matched at all.
// `.{0,30}` (any character) fixes this; `enough`/`short` added to catch "not enough margin"
// phrasing specifically.
const MARGIN_SHORTFALL_REASON_PATTERN = /margin.{0,30}(shortfall|insufficient|exceed|short)|(?:shortfall|insufficient|exceed|short|enough).{0,30}margin/i;
const EXIT_REJECT_STREAK_RESET_MS = 120_000;

const STATE_COLLECTION = 'bulkPcrStrategyState';

// chunkedBuyIndex/chunkedSquareOffLimit (orderProcess.ts) support all four
// brokers - ant and prism were added alongside BulkPcrAutoStartStrategy
// (the scheduled auto-arm wrapper) to let that wrapper run this strategy
// against ant/prism instead of zerodha/breeze.
type BrokerName = 'zerodha' | 'breeze' | 'ant' | 'prism';

// Brokers that run the opposite-direction pair: one slot per option side per broker
// (zerodha_call / zerodha_put, breeze_call, ant_put, ...). Prism stays a single slot.
const PAIR_BROKERS: ReadonlySet<BrokerName> = new Set<BrokerName>(['ant', 'zerodha', 'breeze']);
function isPairBroker(broker: BrokerName): boolean {
    return PAIR_BROKERS.has(broker);
}

// Positions key: a non-pair broker keeps one position under its own name; a pair broker holds
// one slot per option side (<broker>_call / <broker>_put).
function slotKey(broker: BrokerName, right?: string): string {
    return isPairBroker(broker) && right ? `${broker}_${right}` : broker;
}

// Inverse of slotKey: the broker a positions key belongs to (`ant_call` -> `ant`, `prism` -> `prism`).
function brokerOfKey(key: string): BrokerName {
    for (const b of PAIR_BROKERS) {
        if (key === b || key.startsWith(`${b}_`)) return b;
    }
    return key as BrokerName;
}

// The id live option ticks and resting-sell tracking are keyed on: the ANT common token for this
// contract. Every pair broker's chunkedBuyIndex result carries it - zerodha/ant return it as
// `token`, breeze as `feedToken` (its own `token` is Breeze's instrument id, which only Breeze's
// bookkeeping/squareOff paths understand).
function feedTokenOf(result: { token: unknown; feedToken?: unknown }): string {
    return String(result.feedToken ?? result.token);
}

// Derives CALL/PUT from an ANT tradingSymbol - ANT uses TWO different conventions
// depending on index, confirmed live 2026-10-21: NIFTY embeds the option-type letter
// right before the strike with nothing after it (e.g. 'NIFTY27OCT26C23000',
// 'NIFTY27OCT26P22950' - ends in digits, not a letter), while SENSEX/BFO uses a
// genuine trailing 'CE'/'PE' suffix after the strike (e.g. 'SENSEX26O2274300PE' -
// ends in letters). A plain `endsWith('PE')` (this file's own pre-existing
// legacy-migration check, and this fix's first draft) only matches the SENSEX
// convention and silently never matches a NIFTY put, always falling through to
// CALL. Stripping any trailing digit run first normalizes both conventions to the
// same shape ('...C'/'...P' or unchanged '...CE'/'...PE'), so one regex covers both.
function tsymRight(tsym: string): string {
    return /PE?$/.test(String(tsym).replace(/\d+$/, '')) ? PUT : CALL;
}

// True only for a buy failure that provably filled nothing - safe to retry. Ambiguous outcomes
// ("fill status unresolved") and partial fills are never retried.
function isNothingBought(e: any): boolean {
    const message = typeof e?.message === 'string' ? e.message : '';
    if (message.includes('fill status unresolved')) return false;
    return message.includes('no available investment headroom to size an order from')
        || /failed after filling 0\//.test(message);
}

// Parses an ANT margin rejection out of buyChunked's error text. The text embeds the broker order JSON, e.g.
//   ... REJECTED: {..."quantity":780,..."price":169.4,..."rejectionReason":"RED:Margin Shortfall:INR 32491.91 Available:INR 233123.35 for ..."...}
// Returns null if any field is missing (a non-ANT broker's wording differs), so the caller abandons instead of guessing.
function parseAntMarginReject(message: string): { quantity: number; price: number; shortfall: number } | null {
    const qty = /"quantity":\s*(\d+)/.exec(message);
    const price = /"price":\s*([0-9.]+)/.exec(message);
    const short = /Margin Shortfall:INR\s*([0-9.]+)/i.exec(message);
    if (!qty || !price || !short) return null;
    const quantity = Number(qty[1]);
    const p = Number(price[1]);
    const shortfall = Number(short[1]);
    if (!(quantity > 0) || !(p > 0) || !(shortfall > 0)) return null;
    return { quantity, price: p, shortfall };
}

interface BrokerPosition {
    broker: BrokerName;
    // Pair brokers only: the option side this slot holds (CALL | PUT).
    right?: string;
    // 'pending' = a side whose buy did not fill, retried off the other side's ticks.
    phase: 'buying' | 'selling' | 'pending' | 'error' | 'done';
    // Set while eodSquareOff is cancelling this slot's resting sell. updateTrade ignores fills
    // meanwhile: the cancel's own filledQty already accounts for any chunk that filled during the
    // cancel, so counting those fills again would under-square-off.
    squaringOff?: boolean;
    heldTsym: string | null;
    heldToken: string | null;
    entryAvg: number;
    targetQuantity: number;
    soldQty: number;
    soldValue: number;
    // Pair brokers only: quantity each buy of this side uses. The root's entry quantity; the opposite side
    // inherits the root's still-open quantity when it is opened. Re-buys reuse it.
    entryQuantity?: number;
    // Epoch ms of the last buy attempt - throttles retries of a 'pending' buy.
    lastBuyAttemptAt?: number;
    // Epoch ms when phase last transitioned to 'selling' - lets reconcile()
    // tell a genuinely still-resting exit apart from one that's certainly
    // gone: every resting sell chunk placed by chunkedSquareOffLimit is a DAY
    // order, which the exchange cancels/expires unfilled at EOD regardless of
    // what this app believes - see reconcile()'s use of this field.
    sellPlacedAt?: number;
    // Consecutive REJECTED re-placements, reset on a non-rejected cancellation or once the gap
    // since the last rejection exceeds EXIT_REJECT_STREAK_RESET_MS. Live incident 2026-10-15: a
    // position that had already been closed manually, outside this app, had its stale resting
    // exit resumed by reconcile() and then re-placed identically on every REJECTED response with
    // no cap - see onOrderCancelled's use of this field.
    //
    // KNOWN LIMITATION (found on review): this counts rejections per POSITION, not per
    // resting-sell chunk (chunkedSquareOffLimit can split a large exit into several concurrently-
    // resting orders). A handful of independent, one-off transient rejections spread across
    // different chunks could still add up and trip the cap. The time-window reset below
    // (exitLastRejectAt) narrows this but doesn't fully solve it for rejections that land close
    // together across different chunks. A real fix needs a stable per-chunk identity threaded
    // through re-placement, which doesn't exist anywhere in this codebase yet.
    exitRejectCount?: number;
    exitLastRejectAt?: number;
    // Failed buy attempts since the last successful buy of this slot (transient-failure retry cap).
    buyAttempts?: number;
    // True once this slot's buy was shrunk after a margin rejection (only one resize per slot).
    marginResized?: boolean;
    // True when this slot's buy was given up for this cycle (margin, or retry cap). Blocks reopening the hedge.
    abandoned?: boolean;
}

interface PersistedState {
    positions: Partial<Record<BrokerName, BrokerPosition>>;
    // Day's realized P&L per pair broker, summed over every completed slot cycle today (maxProfit). Restored on
    // reconcile only when realizedDay is today.
    dayRealizedByBroker?: Partial<Record<BrokerName, number>>;
    // Brokers locked out by maxLossPerTrade on realizedDay. Second durable copy of the PnlStop latch: reconcile
    // re-trips these even if the strategyLatches read fails, so a restart can never re-enable a tripped broker.
    stoppedBrokers?: BrokerName[];
    // Same as stoppedBrokers, for the maxProfit latch.
    profitStoppedBrokers?: BrokerName[];
    realizedDay?: string;
}

function isSameCalendarDay(epochMs: number): boolean {
    const a = new Date(epochMs);
    const b = new Date();
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Local YYYY-MM-DD, same key as PnlStop's latch day.
function localDayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A resting DAY-validity sell placed today is only still trustworthy as
// "resting" if today's market hasn't closed since it was placed - same
// calendar day alone isn't enough (a restart at, say, 20:00 the same day it
// was placed would otherwise wrongly treat an already-EOD-expired order as
// still resting). See reconcile()'s use of this below.
function isStillWithinSameTradingSession(epochMs: number): boolean {
    return isSameCalendarDay(epochMs) && !isPastMarketClose();
}

// One-shot large block order: buys a total quantity (config `quantity`,
// default 13975 = 215 lots x 65 - or -1, meaning "size it from maxInvestment
// instead of a fixed number": resolveChunkedBuyQuantity/
// resolveMaxInvestmentQuantity in orderProcess.ts/bookkeeping.ts compute the
// largest lot-aligned quantity that fits under `maxInvestment` once that
// broker's option premium is known) of a NIFTY option independently and in
// FULL on every configured broker (config `brokers: [zerodha, breeze]`,
// falling back to a single legacy `broker:` field) - not a split of one
// pooled quantity. One PCR-driven direction decision drives every broker's
// entry; each broker then runs its own entirely independent chunked
// buy -> immediate resting-limit exit -> fill-tracking lifecycle, tracked in
// `positions` (keyed by broker). The whole cycle only durably self-disables
// once EVERY configured broker's position has been fully sold - see
// updateTrade.
//
// Direction: if config `right` is 'call'/'put', use that fixed direction
// directly (no PCR check). If 'none' (default), PCR (put/call OI ratio)
// decides - reuses ContinuousStrategy's exact PCR>1-favors-PUT logic, but
// WITHOUT its PCR_RECHECK_MS/lastPcrCheckTime recheck-throttle, which exists
// there only because it re-evaluates repeatedly all day - this strategy
// fires at most once ever per arming, so a single direct fetch when the
// entry gate first clears is all that's needed. MomentumSignal (ANT
// depth-mode tbq/tsq order-book imbalance on the ATM CALL/PUT) always acts
// as an additional veto ahead of this - no config toggle, unlike
// ContinuousStrategy's optional momentumEnabled, since this strategy places
// a single large one-shot block order and the extra confirmation is worth
// always paying for. PCR still decides direction, but an ACTIVE
// disagreement from momentum blocks the entry for this tick (retried on the
// next one). Momentum unavailable/inconclusive never blocks by itself.
//
// NIFTY's exchange freeze quantity (1755, see NIFTY_FREEZE_QUANTITY in
// constants.ts) caps any single order - each broker's entry buy is placed
// via the shared, broker-agnostic buyChunked helper
// (src/processes/order/chunkedOrder.ts) through the IPC-exposed
// chunkedBuyIndex order-process handler, which splits into
// exchange-compliant chunks automatically and only returns once every chunk
// has filled. Each broker's exit sell is placed the same way via
// squareOffLimitChunked/chunkedSquareOffLimit, as soon as that broker's own
// buy resolves (see placeExitSell below) - as a resting LIMIT sell at that
// broker's own (entryAvg + targetPoints) price, NOT a market order. A blind
// market square-off is what caused the 2026-09-22 loss above (a single
// bad/stale tick falsely read as "target hit" sold straight into a loss,
// since a market order has no price floor); a resting LIMIT order can only
// ever fill at the target price or better, so that failure mode doesn't
// apply here regardless of when it's placed - there is deliberately no
// tick-based "confirm the target first" gate before placing it.
export default class BulkPcrStrategy extends Strategy {
    name = 'BulkPcrStrategy';

    // Outer one-shot reentrancy gate only - every broker's actual progress
    // lives in `positions`, keyed by broker, since brokers advance through
    // buying/selling/error/done entirely independently of each other.
    private phase: 'idle' | 'running' | 'done' = 'idle';
    // Keyed by slotKey: a non-pair broker's name, or <broker>_call / <broker>_put for a pair broker.
    private positions = new Map<string, BrokerPosition>();
    private momentum = new MomentumSignal();
    private lastGateLog = new Map<string, number>();
    private lastEntryAttemptTime = 0;
    // Most recent NIFTY tick seen by processNiftyQuote. enterOnBroker's one-shot retry reads
    // this (not the stale quote captured at the first attempt) so the direction and LTP it
    // re-resolves against are current.
    private lastNiftyQuote: NiftyQuote | null = null;

    // Each pair broker holds its own pair: one slot per option side (see slotKey). Entry, the
    // opposite-side opening and re-buys live in the methods further down.
    // Set once the EOD force-close has started - nothing new opens or re-buys after it.
    private eodDone = false;

    // Per-broker loss stop (maxLossPerTrade, maxloss.md). One PnlStop latch per pair broker. A trade = one auto-start
    // slot = everything since the last reset(). When a broker's trade P&L breaches maxLossPerTrade, its open slots are
    // closed at limit and that broker is locked out for the rest of the day (BulkPcrAutoStartStrategy skips it even
    // while the strategy is enabled). Cleared only by admin reset or the day rollover.
    private stops = new Map<BrokerName, PnlStop>();
    // Per-broker profit stop (maxProfit). Unlike the loss stop it is cumulative per broker for the whole day: the day's
    // realized P&L of every slot cycle plus what open slots have already sold (see dayPnl: open slots marked below entry hold it back). Reaching +maxProfit closes that
    // broker's open slots and locks it out for the rest of the day, exactly like a loss trip. Its own latch (scope
    // `<broker>:maxProfit`), so a loss trip and a profit trip never share a field.
    private profitStops = new Map<BrokerName, PnlStop>();
    // Day's realized P&L per pair broker over every completed slot cycle today - what maxProfit is measured against.
    // Survives a re-arm (reset({keepStops})) and is cleared only by an admin reset or the day rollover.
    private dayRealizedByBroker = new Map<BrokerName, number>();
    // Last tick price per slot key, in memory only. Feeds the unrealized part of the stop check.
    private lastLtpByKey = new Map<string, number>();
    // Local day the stop accumulators belong to. A rollover clears them (see ensureToday).
    private statsDay = '';
    // Slots whose resting exit is being placed right now. closeBroker skips them; placeExitSellAtTargetPrice
    // closes the slot itself once placement returns, so a sell placed after the cancel cannot be left resting.
    private placingKeys = new Set<string>();
    // True while reconcile() runs. A restored stop only blocks new buys after a restart (maxloss.md B3.7),
    // so the in-flight stop handling in placeExitSellAtTargetPrice is skipped then.
    private reconciling = false;

    receive(oldStats, newStats) {}

    // A lone slot (per pair broker) that falls this far below its entry opens that broker's opposite side.
    // Optional config key; defaults to 10 points.
    // Underlying this instance trades: config `index: SENSEX` (BFO options) or NIFTY (default).
    private index(): 'NIFTY' | 'SENSEX' {
        return this.cfg().index === 'SENSEX' ? 'SENSEX' : 'NIFTY';
    }

    private slDistance(): number {
        return this.cfg().slDistance ?? 10;
    }

    // Not configService.getStrategyConfig(type) - that returns only the FIRST
    // config.yml entry of this type, regardless of userId. config.yml can
    // configure multiple instances of this strategy under distinct userId
    // values, and each instance must read its OWN block, not silently inherit
    // whichever instance's block happens to be listed first. Same (cfg.userId
    // || type) === userId convention exitMonitor.ts's isSelfManagedTradeUser
    // and durablyDisable below already use for the identical type-vs-instance
    // distinction.
    private cfg() {
        return configService.getConfig().strategies?.find(
            (s) => s.type === 'BulkPcrStrategy' && (s.userId || s.type) === this.userId
        ) ?? { type: 'BulkPcrStrategy', enabled: false };
    }

    // `brokers: [zerodha, breeze]` (new, multi-broker) takes priority when
    // present and non-empty; falls back to the legacy single `broker:`
    // field (defaulting to zerodha) for backward compatibility. Deduped and
    // lowercased so a config typo/duplicate can't silently double-run a
    // broker.
    private configuredBrokers(): BrokerName[] {
        const cfg = this.cfg();
        const list: string[] = Array.isArray(cfg.brokers) && cfg.brokers.length > 0 ? cfg.brokers : [cfg.broker ?? 'zerodha'];
        return Array.from(new Set(list.map((b: string) => String(b).toLowerCase()))) as BrokerName[];
    }

    // Throttled gate-visibility logging, same shape as ContinuousStrategy's
    // logGateOnce - low-value here since this strategy only ever transitions
    // through its phases once, but keeps the "why isn't it firing" question
    // answerable from orchestrator.log the same way as every other strategy.
    private logGateOnce(reason: string): void {
        const now = Date.now();
        const last = this.lastGateLog.get(reason) ?? 0;
        if (now - last < 5 * 60 * 1000) return;
        this.lastGateLog.set(reason, now);
        Log.log(`[BulkPcrStrategy] gate: ${reason}`);
    }

    // Persists one BrokerPosition per configured broker, keyed by broker -
    // lets reconcile() tell 'selling' (a limit-sell exit is already resting
    // at that broker - re-placing it on restart would risk a SECOND exit for
    // the same quantity) apart from 'error' (something failed and needs
    // manual review - re-placing an exit automatically on restart would be
    // just as wrong, whether the failure was a partial buy or a
    // partial/failed sell) on a PER-BROKER basis - one broker can be resting
    // fine while a different broker sits in 'error' needing manual review.
    // Fire-and-forget, same convention as bookkeeping's own Mongo writes
    // elsewhere.
    private persistState(): Promise<void> {
        const positions: Partial<Record<BrokerName, BrokerPosition>> = {};
        // squaringOff is in-memory only: persisted true would survive a crash mid-close and block updateTrade after restart.
        for (const [broker, pos] of this.positions) {
            const { squaringOff: _inFlight, ...durable } = pos;
            positions[broker] = durable as BrokerPosition;
        }
        const stoppedBrokers = this.configuredBrokers().filter((b) => isPairBroker(b) && this.stops.get(b)?.isLatched() === true);
        const profitStoppedBrokers = this.configuredBrokers().filter((b) => isPairBroker(b) && this.profitStops.get(b)?.isLatched() === true);
        return Promise.resolve(Mongo.getInstance()?.db.collection(STATE_COLLECTION)
            .replaceOne(
                { userId: this.userId },
                {
                    userId: this.userId,
                    positions,
                    dayRealizedByBroker: Object.fromEntries(this.dayRealizedByBroker),
                    stoppedBrokers,
                    profitStoppedBrokers,
                    realizedDay: this.statsDay,
                },
                { upsert: true }
            ))
            .then(() => undefined)
            .catch((e) => Log.log('[BulkPcrStrategy] persistState failed:', e));
    }

    private async loadState(): Promise<PersistedState | null> {
        try {
            const doc = await Mongo.getInstance()?.db.collection(STATE_COLLECTION).findOne({ userId: this.userId });
            return (doc as any) ?? null;
        } catch (e) {
            Log.log('[BulkPcrStrategy] loadState failed:', e);
            return null;
        }
    }

    // Rolls the stop accumulators over at the local day boundary. A long-running process would otherwise
    // carry yesterday's realized P&L and tripped latch into today (the latch itself is day-keyed in Mongo).
    private ensureToday(): void {
        const today = localDayKey();
        if (today === this.statsDay) return;
        this.statsDay = today;
        this.dayRealizedByBroker.clear();
        this.stops.clear();
        this.profitStops.clear();
    }

    // A broker-only lockout comes from maxLossPerTrade. maxLossPerDay was removed on 2026-10-22; a config still
    // carrying it (or the older maxLoss key) is ignored, with a once-only warning, so the operator notices.
    private legacyLossKeyWarned = false;
    private warnIfLegacyLossKey(): void {
        const cfg = this.cfg();
        const legacy = cfg.maxLossPerDay ?? cfg.maxLoss;
        if (legacy == null || this.legacyLossKeyWarned) return;
        this.legacyLossKeyWarned = true;
        Log.log(`[BulkPcrStrategy] WARN: config key ${cfg.maxLossPerDay != null ? 'maxLossPerDay' : 'maxLoss'}=${JSON.stringify(legacy)} is REMOVED and ignored - the loss stop is maxLossPerTrade (a trade breach locks the broker out for the day). Remove it from config.yml.`);
    }

    private stopFor(broker: BrokerName): PnlStop {
        this.ensureToday();
        let stop = this.stops.get(broker);
        if (!stop) {
            stop = new PnlStop({
                ownerType: 'BulkPcrStrategy',
                userId: this.userId,
                scope: broker,
                kind: 'loss',
                getCapPct: () => this.cfg().maxLossPerTrade,
                getMaxInvestment: () => this.cfg().maxInvestment ?? 0,
            });
            this.stops.set(broker, stop);
        }
        return stop;
    }

    // maxProfit latch for one broker. Same owner/userId as the loss latch, distinct scope so the two never collide.
    private profitStopFor(broker: BrokerName): PnlStop {
        this.ensureToday();
        let stop = this.profitStops.get(broker);
        if (!stop) {
            stop = new PnlStop({
                ownerType: 'BulkPcrStrategy',
                userId: this.userId,
                scope: `${broker}:maxProfit`,
                kind: 'profit',
                getCapPct: () => this.cfg().maxProfit,
                getMaxInvestment: () => this.cfg().maxInvestment ?? 0,
            });
            this.profitStops.set(broker, stop);
        }
        return stop;
    }

    // Public: BulkPcrAutoStartStrategy skips a locked-out broker before arming it, and entries/re-buys skip it too.
    // Either the loss stop or the profit stop locks the broker out.
    isBrokerStopped(broker: string): boolean {
        if (!isPairBroker(broker as BrokerName)) return false;
        return this.stopFor(broker as BrokerName).isTripped() || this.profitStopFor(broker as BrokerName).isTripped();
    }

    // Restores today's lockouts for every configured pair broker. Called from reconcile() and by the auto-start before
    // it arms, so a restart never re-enables a locked-out broker. Two durable copies are consulted: the strategyLatches
    // doc (PnlStop) and this strategy's own state doc (stoppedBrokers). If neither can be read the broker stays
    // closed (fail-closed) until a later load succeeds.
    async loadStopLatches(): Promise<void> {
        this.warnIfLegacyLossKey();
        const persisted = await this.loadState();
        const stateDayIsToday = persisted?.realizedDay === localDayKey();
        // The realized P&L the stops are measured against (trade for maxLossPerTrade, day for maxProfit). Restored here
        // rather than only in reconcile(), because the auto-start calls this before arming on a freshly started process.
        this.ensureToday();
        if (persisted?.realizedDay === this.statsDay) {
            // Only where memory has no entry yet: a live process's in-memory total is never older than a read made
            // while it was running, so it must not be overwritten by one.
            for (const [broker, pnl] of Object.entries(persisted.dayRealizedByBroker ?? {})) {
                if (Number.isFinite(Number(pnl)) && !this.dayRealizedByBroker.has(broker as BrokerName)) this.dayRealizedByBroker.set(broker as BrokerName, Number(pnl));
            }
        }
        for (const broker of this.configuredBrokers()) {
            if (!isPairBroker(broker)) continue;
            const stop = this.stopFor(broker);
            const latchReadOk = await stop.load();
            if (stateDayIsToday && persisted?.stoppedBrokers?.includes(broker)) {
                stop.markTripped();
                Log.log(`[BulkPcrStrategy] [${broker}] restored today's maxLossPerTrade lockout from the state doc - staying locked out`);
            }
            if (!latchReadOk && stop.isTripped() && !stop.isLatched()) {
                Log.log(`[BulkPcrStrategy] [${broker}] ALERT: lockout state unreadable - broker held closed until it can be read`);
            }
            const profitStop = this.profitStopFor(broker);
            const profitLatchReadOk = await profitStop.load();
            if (stateDayIsToday && persisted?.profitStoppedBrokers?.includes(broker)) {
                profitStop.markTripped();
                Log.log(`[BulkPcrStrategy] [${broker}] restored today's maxProfit lockout from the state doc - staying locked out`);
            }
            if (!profitLatchReadOk && profitStop.isTripped() && !profitStop.isLatched()) {
                Log.log(`[BulkPcrStrategy] [${broker}] ALERT: profit lockout state unreadable - broker held closed until it can be read`);
            }
        }
    }

    // Books one slot cycle's realized P&L against the broker's current trade (loss cap) and the day (profit cap).
    private bookRealized(broker: BrokerName, pnl: number): void {
        if (!isPairBroker(broker)) return;
        if (!Number.isFinite(pnl)) {
            Log.log(`[BulkPcrStrategy] [${broker}] ALERT: realized P&L is not a finite number (${pnl}) - NOT booked into the trade loss cap or the day's profit cap`);
            return;
        }
        this.ensureToday();
        this.dayRealizedByBroker.set(broker, (this.dayRealizedByBroker.get(broker) ?? 0) + pnl);
        this.persistState();
    }

    // Part of one broker's open selling slots that is already realized: what each slot has sold so far, against its
    // entry. Uses fill prices only, never a tick. Slots in 'error' are excluded: what they still hold is unknown (see
    // maxloss.md B3.2), so counting them could trip falsely.
    private soldPartPnl(broker: BrokerName): number {
        let total = 0;
        for (const pos of this.slotsOf(broker)) {
            if (pos.phase !== 'selling' || !pos.heldTsym) continue;
            total += pos.soldValue - pos.soldQty * pos.entryAvg;
        }
        return total;
    }

    // Unrealized part of one broker's open selling slots: the open quantity marked at its last tick. A slot with no tick
    // yet adds 0 - a price is never guessed. 'error' slots are excluded, as in soldPartPnl.
    private unrealizedPnl(broker: BrokerName): number {
        let total = 0;
        for (const pos of this.slotsOf(broker)) {
            if (pos.phase !== 'selling' || !pos.heldTsym) continue;
            const ltp = this.lastLtpByKey.get(this.keyOf(pos));
            const open = pos.targetQuantity - pos.soldQty;
            if (open > 0 && ltp !== undefined && Number.isFinite(ltp) && ltp > 0) total += (ltp - pos.entryAvg) * open;
        }
        return total;
    }

    // Loss-cap figure for one broker: only what is open right now, i.e. every selling slot's open quantity marked at its
    // last tick. Closed cycles (earlier re-buy +target exits) and partial fills do not offset it, so PE -10 and CE -15
    // is a 25 loss however much was booked before. A slot with no tick yet adds 0; 'error' slots are excluded.
    private tradePnl(broker: BrokerName): number {
        let total = 0;
        for (const pos of this.slotsOf(broker)) {
            if (pos.phase !== 'selling' || !pos.heldTsym) continue;
            const ltp = this.lastLtpByKey.get(this.keyOf(pos));
            const open = pos.targetQuantity - pos.soldQty;
            if (open > 0 && ltp !== undefined && Number.isFinite(ltp) && ltp > 0) total += (ltp - pos.entryAvg) * open;
        }
        return total;
    }

    // The figure the profit cap is measured against: the day's realized P&L (every completed slot cycle plus what open
    // slots have already sold), but only while the open slots, marked at their last tick, would not pull it back under.
    // Tripping closes the broker's other open slots at limit, so the cap must hold with those closes included: the
    // smaller of realized and realized-plus-unrealized is returned, and a slot marked above its resting sell never
    // counts as profit.
    private dayPnl(broker: BrokerName): number {
        const realized = (this.dayRealizedByBroker.get(broker) ?? 0) + this.soldPartPnl(broker);
        return Math.min(realized, realized + this.unrealizedPnl(broker));
    }

    // Synchronous latch check for one broker, both caps. True only on the call that trips one of them, so the caller
    // starts the lockout exactly once. Nothing trips after EOD (the EOD close already covers every slot).
    private tripIfBreached(broker: BrokerName): boolean {
        if (!isPairBroker(broker) || this.eodDone) return false;
        const lossTripped = this.stopFor(broker).evaluate(this.tradePnl(broker));
        const profitTripped = this.profitStopFor(broker).evaluate(this.dayPnl(broker));
        return lossTripped || profitTripped;
    }

    // See file header for the momentum-veto rationale.
    private static readonly MOMENTUM_TIMEOUT_MS = 3000;

    private async resolveEntryRight(quote: NiftyQuote, configuredRight?: string): Promise<string | null> {
        if (configuredRight && configuredRight !== 'none') return configuredRight; // explicit direction - skip PCR entirely
        try {
            const pcr = await OrderClient.getInstance().getPCR(this.userId, this.index(), quote.ltp, this.index() === 'SENSEX' ? PCR_WINDOW_POINTS * 3 : PCR_WINDOW_POINTS);
            const pcrFavors = pcr > 1 ? PUT : CALL;
            Log.log(`[BulkPcrStrategy] PCR=${pcr.toFixed(3)} -> resolved direction ${pcrFavors}`);

            const momentumFavors = await this.momentum.getDirection(this, quote.ltp, BulkPcrStrategy.MOMENTUM_TIMEOUT_MS, this.index());
            if (momentumFavors != null && momentumFavors !== pcrFavors) {
                Log.log(`[BulkPcrStrategy] Momentum (${momentumFavors}) disagrees with PCR (${pcrFavors}) - blocking entry this window`);
                return null;
            }
            Log.log(`[BulkPcrStrategy] Momentum ${momentumFavors == null ? 'unavailable/inconclusive - PCR alone decides' : `(${momentumFavors}) agrees with PCR`}`);
            return pcrFavors;
        } catch (e) {
            Log.log('[BulkPcrStrategy] PCR check failed, blocking entry (fail-closed):', e);
            return null;
        }
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        if (this.index() !== 'NIFTY') { await this.eodCheck(); return; } // SENSEX instance: entry runs off SENSEX ticks, but NIFTY ticks still drive the EOD check
        await this.processUnderlyingQuote(quote);
    }

    async processSensexQuote(quote: SensexQuote): Promise<void> {
        if (this.index() !== 'SENSEX') return;
        await this.processUnderlyingQuote(quote as unknown as NiftyQuote);
    }

    private async eodCheck(): Promise<void> {
        if (!this.eodDone && this.pairSlots().length > 0) {
            const now = new Date();
            const pastEodCutoff = now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 15);
            if (pastEodCutoff) {
                this.eodDone = true;
                Log.log('[BulkPcrStrategy] EOD cutoff reached - force-closing open pair slot(s)');
                await this.eodCloseSlots();
            }
        }
    }

    private async processUnderlyingQuote(quote: NiftyQuote): Promise<void> {
        this.lastNiftyQuote = quote;

        // EOD force-close of open pair slots - checked before the phase==='idle' gate below, since by
        // the time a slot exists the outer phase is already 'running' and would return first.
        // One-shot via eodDone; a NIFTY/SENSEX tick after 15:15 is frequent enough that no interval
        // poll is needed. Shared with the SENSEX-instance early-return path above (processNiftyQuote) -
        // found on review: this used to duplicate the cutoff check inline instead of calling eodCheck(),
        // which would have silently diverged the next time the cutoff changed in only one place.
        await this.eodCheck();

        if (!this.enabled) { this.logGateOnce('disabled'); return; }
        if (this.phase !== 'idle') { this.logGateOnce(`entry already in progress or done (phase=${this.phase})`); return; }
        if (!this.isTimeInRange()) { this.logGateOnce('outside time window'); return; }

        const now = Date.now();
        if (now - this.lastEntryAttemptTime < ENTRY_ATTEMPT_THROTTLE_MS) return; // see ENTRY_ATTEMPT_THROTTLE_MS comment
        this.lastEntryAttemptTime = now;

        this.logGateOnce('gates clear - attempting entry');

        // Reentrancy guard set synchronously here, BEFORE the PCR/momentum
        // resolution below awaits - resolveEntryRight makes async IPC calls,
        // and a second tick arriving during that gap would otherwise still
        // see phase='idle' (this used to be set only after the await, which
        // let concurrent ticks race past the idle-check together and each
        // launch their own chunkedBuyIndex call - observed live 2026-09-21,
        // caused multiple duplicate block buys before Breeze's own rate
        // limit accidentally capped the damage).
        this.phase = 'running';

        const cfg = this.cfg();
        const configuredRight = cfg.right && cfg.right !== 'none' ? cfg.right : undefined;
        const right = await this.resolveEntryRight(quote, configuredRight);
        if (right == null) { this.phase = 'idle'; return; } // retried on the next tick

        const quantity = cfg.quantity ?? 13975;
        // A loss-stopped broker takes no new entry (maxloss.md B3.6).
        const brokers = this.configuredBrokers().filter((b) => !this.isBrokerStopped(b));
        if (brokers.length === 0) {
            this.logGateOnce('every configured broker is loss-stopped - not entering');
            this.phase = 'done';
            return;
        }
        Log.log(`[BulkPcrStrategy] Entering ${right} qty=${quantity} independently on: ${brokers.join(', ')}`);

        // allSettled, not all - one broker's entry failing must not abort a
        // different broker's already-in-flight buy. Each broker's own
        // success/failure is handled entirely inside enterOnBroker.
        await Promise.allSettled(brokers.map((broker) => this.enterOnBroker(broker, right, quantity, quote.ltp)));
    }

    // One broker's entire entry: buy the full configured quantity on this
    // broker only, then immediately place this broker's own resting exit
    // sell. Independent of every other broker's own enterOnBroker call -
    // failure here only marks THIS broker's position 'error', never touches
    // another broker's state.
    //
    // Note: bookkeeping's investment/lot caps (canPlaceOrder) are per-USER,
    // not per-broker, and this.userId is the same across every concurrent
    // call here - so with 2+ brokers configured, `maxInvestment` is a
    // COMBINED cap across all of them, not a per-broker one. Size it for the
    // full combined exposure, or a later broker's chunkedBuyIndex call can
    // legitimately get rejected on "max investment" purely because an
    // earlier one already reserved its own share of the same cap - this is
    // the capital gate working as designed, not a bug, but easy to be
    // surprised by if `maxInvestment` was only ever sized for one broker.
    // With `quantity: -1` this gets sharper: each broker's chunkedBuyIndex
    // independently computes "max quantity for the FULL maxInvestment" (see
    // bookkeeping.resolveMaxInvestmentQuantity), so 2+ concurrently-entering
    // brokers can together request well over maxInvestment before either's
    // fill lands and reduces the other's headroom - see that method's
    // comment. Only safe today because config.yml's `brokers` list is a
    // single entry.
    private async enterOnBroker(broker: BrokerName, right: string, quantity: number, niftyLtp: number, isRetry: boolean = false): Promise<void> {
        const key = slotKey(broker, right);
        this.positions.set(key, {
            broker,
            right: isPairBroker(broker) ? right : undefined,
            phase: 'buying',
            heldTsym: null,
            heldToken: null,
            entryAvg: 0,
            targetQuantity: 0,
            soldQty: 0,
            soldValue: 0,
        });

        try {
            const chunkDriftCancelPoints = this.cfg().chunkDriftCancelPoints ?? 10;
            const result = await OrderClient.getInstance().chunkedBuyIndex(this.userId, { right, quantity, niftyLtp, broker, driftCancelPoints: chunkDriftCancelPoints, index: this.index() });
            const pos = this.positions.get(key)!;
            pos.heldTsym = result.tsym;
            pos.heldToken = feedTokenOf(result);
            pos.entryAvg = result.avgPrice;
            Log.log(`[BulkPcrStrategy] [${broker}] Entry complete: ${pos.heldTsym} qty=${result.quantity} avg=${pos.entryAvg}`);
            pos.entryQuantity = result.quantity;
            await this.placeExitSell(key, result.quantity);
        } catch (e: any) {
            // Distinguish "nothing was bought" from a real broker-order-level problem, and
            // auto-retry only the former - a persistent/ambiguous failure still needs the same
            // manual review as before. Two safe-to-retry shapes seen live, both meaning no
            // broker order resulted in any fill at all:
            //  - sizing/pricing failed before any order was placed at all
            //    (resolveChunkedBuyQuantity, orderProcess.ts - this exact message, thrown
            //    BEFORE placeOrderWithPendingGuard ever runs) - live incident 2026-10-15, an
            //    ANT OHLC 429 outlasted the sizing quote's retry budget.
            //  - an order WAS placed but resolveUnconfirmedAntBuy (antExecutor.ts) cancelled it
            //    and confirmed via the trade book that it filled 0 - buyChunked (chunkedOrder.ts)
            //    wraps this as "failed after filling 0/<requested>" - live incident 2026-10-15,
            //    the 12:35 slot's order never got a fill before the order-notify AND REST-fallback
            //    polls both timed out, and was genuinely unfilled when cancelled.
            // Explicitly EXCLUDED: resolveUnconfirmedAntBuy's own ambiguous-outcome throws all
            // contain "fill status unresolved" (cancel failed, bracket/cover parent left
            // untouched, trade-book read failed, etc.) - those must stay a hard stop, and so must
            // any partial fill ("failed after filling N/<requested>" with N>0 - there's a real,
            // unmonitored position at stake then, not nothing). One retry only (isRetry).
            const message = typeof e?.message === 'string' ? e.message : '';
            const ambiguousOutcome = message.includes('fill status unresolved');
            const nothingWasBought = !ambiguousOutcome && (
                message.includes('no available investment headroom to size an order from')
                || /failed after filling 0\//.test(message)
            );
            if (nothingWasBought && MARGIN_SHORTFALL_REASON_PATTERN.test(message)) {
                // Deterministic: waiting 10s and re-sending the same order cannot succeed.
                Log.log(`[BulkPcrStrategy] [${broker}] ALERT: ${right} entry rejected for margin - not retrying: ${message.slice(0, 200)}`);
                const slot = this.positions.get(key);
                if (slot) { slot.phase = 'done'; slot.abandoned = true; }
                this.persistState();
                this.finishIfFlat();
                return;
            }
            if (nothingWasBought && !isRetry) {
                Log.log(`[BulkPcrStrategy] [${broker}] Chunked entry failed with nothing bought - retrying once in 10s: ${message || e}`);
                await sleep(10000);
                // The first attempt's PCR read and LTP are stale by now (the order-notify wait,
                // cancel and 10s sleep can be ~2 min). Re-resolve direction and use the latest
                // tick's LTP. Proceed with whatever direction is confirmed now, even if it
                // differs from the original - the first order was confirmed cancelled-unfilled,
                // so there is no position in the old direction to unwind.
                const latest = this.lastNiftyQuote;
                const retryRight = latest ? await this.resolveEntryRight(latest, this.cfg().right !== 'none' ? this.cfg().right : undefined) : null;
                if (latest == null || retryRight == null) {
                    Log.log(`[BulkPcrStrategy] [${broker}] Retry aborted: no confirmed direction on re-resolution - manual review required`);
                    const pos = this.positions.get(key);
                    if (pos) pos.phase = 'error';
                    this.persistState();
                    return;
                }
                if (retryRight !== right) {
                    Log.log(`[BulkPcrStrategy] [${broker}] Direction changed on retry: ${right} -> ${retryRight}`);
                }
                this.positions.delete(key);
                await this.enterOnBroker(broker, retryRight, quantity, latest.ltp, true);
                return;
            }
            if (nothingWasBought && isRetry) {
                // Both attempts were confirmed cancelled-unfilled: no position exists, so there is nothing to
                // review - mark this slot 'done' (a legitimate "finished, nothing held" terminal state, same
                // as the 'pending'->'done' EOD case below) instead of latching 'error' (which blocked every
                // later autostart slot until a manual reset, live 2026-10-19 SENSEX). Deliberately NOT deleted
                // from `this.positions` - allBrokersFinished() requires at least one slot per configured
                // broker to consider that broker finished; deleting it left that broker permanently
                // unaccounted for, so a different broker's later, perfectly normal completion could never
                // flip this.phase to 'done' either (found on review). finishIfFlat() reuses the exact same
                // "every configured broker finished" check the normal full-sell completion path uses -
                // BulkPcrAutoStartStrategy's target.reset() (called before every scheduled re-arm, and which
                // force-sets config `enabled: true` regardless) already makes durablyDisable()'s config
                // write here a non-issue for the next scheduled slot.
                Log.log(`[BulkPcrStrategy] [${broker}] Entry retry also filled nothing - no position, marking slot done: ${message}`);
                const slot = this.positions.get(key);
                if (slot) slot.phase = 'done';
                this.persistState();
                this.finishIfFlat();
                return;
            }
            Log.log(`[BulkPcrStrategy] [${broker}] Chunked entry failed - manual review required:`, e);
            const pos = this.positions.get(key);
            if (pos) pos.phase = 'error';
            this.persistState(); // so reconcile() on restart knows this broker needs manual review, not an auto-placed exit
        }
    }

    // Shared logic for placing a resting limit exit sell at a slot's target price. Factored out so
    // the first placement, a cancellation re-placement and a restart re-placement all use the same
    // price-rounding/chunking code. `key` is the slot's positions key (see slotKey).
    private async placeExitSellAtTargetPrice(key: string, quantity: number, resetProgress: boolean = true): Promise<void> {
        const pos = this.positions.get(key);
        if (!pos) return; // defensive - should always exist by the time this is called
        const broker = pos.broker;

        const cfg = this.cfg();
        const targetPoints = cfg.targetPoints ?? 2;
        // entryAvg is a multi-chunk weighted average (buyChunked's
        // filledValue/filledQty) and essentially never lands on an exact
        // multiple of NFO's 0.05 tick size, so entryAvg + targetPoints must
        // be rounded before it's used as an order price - confirmed live
        // 2026-09-23: an unrounded price was REJECTED by Zerodha on all 8
        // resting sell chunks, leaving the full position with no exit order
        // at all. Same helper zerodhaExecutor.ts/antExecutor.ts already use
        // for this.
        const targetPrice = roundToTick(pos.entryAvg + targetPoints);

        if (resetProgress) {
            // First-time placement: reset progress counters
            pos.soldQty = 0;
            pos.soldValue = 0;
            pos.targetQuantity = quantity;
        }
        // Cancellation re-placement: keep soldQty/soldValue/targetQuantity untouched,
        // just re-place the chunk that was orphaned by cancellation

        if (!this.reconciling && isPairBroker(broker) && this.isBrokerStopped(broker)) {
            // Stopped while this buy was in flight: square the fill off instead of resting a new sell.
            pos.phase = 'selling';
            await this.eodSquareOff(pos);
            return;
        }

        pos.phase = 'selling'; // synchronous, before any await
        pos.sellPlacedAt = Date.now();
        Log.log(`[BulkPcrStrategy] [${broker}] Placing resting limit sell for ${pos.heldTsym} qty=${quantity} @ ${targetPrice}`);
        this.persistState();

        this.placingKeys.add(key);
        try {
            // Resting LIMIT sell at the target price, not a market order -
            // either fills at (at least) the intended profit, or doesn't
            // fill at all if the market never actually gets there. See the
            // file header comment for why this replaced a blind market
            // square-off. Returns once the chunks are placed, not once
            // filled; completion is handled in updateTrade below as fills
            // arrive asynchronously.
            await OrderClient.getInstance().chunkedSquareOffLimit(this.userId, {
                tsym: pos.heldTsym!,
                instrumentId: pos.heldToken!,
                quantity,
                price: targetPrice,
                broker,
            });
            Log.log(`[BulkPcrStrategy] [${broker}] Limit sell chunks resting for ${pos.heldTsym} @ ${targetPrice} - waiting for fills`);
            // Watch the held token so its option ticks reach processOptionQuote - a pair slot needs
            // them for the slDistance check that opens the opposite side (tokenRouter only routes
            // ticks for watched/registered tokens).
            this.watchSlot(pos);
        } catch (e) {
            Log.log(`[BulkPcrStrategy] [${broker}] Chunked limit-sell placement failed - manual review required:`, e);
            pos.phase = 'error';
            this.persistState();
        } finally {
            this.placingKeys.delete(key);
        }
        // The stop may have tripped while this sell was being placed; closeBroker skipped this slot then,
        // so close it now that the resting sell is known. Never during a restart's reconcile (B3.7).
        if (!this.reconciling && isPairBroker(broker) && this.isBrokerStopped(broker)) {
            await this.closeBroker(broker);
        }
    }

    // Places a slot's resting LIMIT exit sell once its full bought quantity is confirmed. Called from
    // enterOnBroker, buyAndExit, and reconcile() when a restart lands between "buy filled" and "sell placed".
    private async placeExitSell(key: string, quantity: number): Promise<void> {
        await this.placeExitSellAtTargetPrice(key, quantity, true);
    }

    // Momentum-only tick consumer PLUS every pair slot's own token - a pair slot is ticked
    // so processOptionQuote can observe the slDistance adverse move that opens its opposite side.
    canHandleOptionQuote(quote: OptionQuote): boolean {
        const token = String(quote.token);
        if (this.momentum.isTracking(token)) return true;
        return this.pairSlots().some((p) => p.heldToken === token && p.phase !== 'done');
    }

    // The opposite-direction pair (see the file header), run independently by each pair broker:
    // at most one slot per side per broker. A lone slot that falls slDistance below its entry opens
    // that broker's opposite side, once. From then on each side re-buys its own side the moment its
    // +2 sell fills, while the other side is still active - so each broker never has more than two
    // open trades, one per direction. All brokers hold the same ATM token, so one tick is offered
    // to every matching slot.
    async processOptionQuote(quote: OptionQuote): Promise<void> {
        const token = String(quote.token);
        if (this.momentum.isTracking(token)) {
            this.momentum.onTick(quote);
            return;
        }
        if (this.eodDone) return;
        const matches = this.pairSlots().filter((p) => p.heldToken === token && p.phase === 'selling');
        if (matches.length === 0) return;

        if (quote.ltp > 0 && Number.isFinite(quote.ltp)) {
            for (const slot of matches) this.lastLtpByKey.set(this.keyOf(slot), quote.ltp);
        }
        // Stop check before any hedge logic, so a broker tripped by this tick never opens its opposite side.
        const tripped = Array.from(new Set(matches.map((m) => m.broker))).filter((b) => this.tripIfBreached(b));
        await Promise.all(tripped.map((b) => this.lockOutBroker(b, 'maxLossPerTrade or maxProfit breached on a tick')));

        this.retryPendingRebuys();

        for (const slot of matches) {
            if (this.isBrokerStopped(slot.broker)) continue;
            if (this.slotsOf(slot.broker).some((p) => p.abandoned)) continue; // hedge given up this cycle
            // Once both sides of this broker exist its pair is complete - this tick does nothing more
            // for it. A 'done' side (already fully sold out, e.g. from an earlier cycle) doesn't count
            // as "existing" here - same convention onSlotSoldOut's sibling check and canHandleOptionQuote
            // already use (phase !== 'done') - found live 2026-10-21: a stale 'done' PE record from a prior
            // cycle was otherwise permanently counted as a second active side, blocking this lone CE
            // slot from ever opening its hedge no matter how far price moved.
            if (this.slotsOf(slot.broker).filter((p) => p.phase !== 'done').length !== 1) continue;
            if (quote.ltp > slot.entryAvg - this.slDistance()) continue;
            await this.openOppositeSide(slot);
        }
    }

    private pairSlots(): BrokerPosition[] {
        return Array.from(this.positions.values()).filter((p) => isPairBroker(p.broker));
    }

    private slotsOf(broker: BrokerName): BrokerPosition[] {
        return this.pairSlots().filter((p) => p.broker === broker);
    }

    // Fills arrive by tsym for a pair broker (two sides can both be open), and by broker name for
    // every other broker - whose single position is keyed by that name.
    private slotFor(broker: BrokerName, tsym: string): BrokerPosition | undefined {
        if (!isPairBroker(broker)) return this.positions.get(broker);
        return this.slotsOf(broker).find((p) => p.heldTsym === tsym);
    }

    private keyOf(pos: BrokerPosition): string {
        return slotKey(pos.broker, pos.right);
    }

    // Starts tick routing for a slot's held token. Idempotent (tokenRouter refcounts per strategy).
    // Pair brokers only: a non-pair slot is never ticked by its held token.
    private watchSlot(pos: BrokerPosition): void {
        if (!isPairBroker(pos.broker) || !pos.heldToken) return;
        watchTokenOnSource('ant', pos.heldToken, this, pos.heldTsym?.startsWith('SENSEX') ? 'BFO' : 'NFO');
    }

    // Stops tick routing for a slot's held token - but only if no other pair slot still holds the
    // same token (brokers share one ATM contract, so unwatching it for one slot would silently
    // starve the others of their adverse-move ticks).
    private unwatchSlot(pos: BrokerPosition, exceptKey?: string): void {
        if (!isPairBroker(pos.broker) || !pos.heldToken) return;
        const stillHeld = Array.from(this.positions.entries()).some(([k, p]) =>
            k !== exceptKey && p !== pos && isPairBroker(p.broker) && p.phase !== 'done' && p.heldToken === pos.heldToken
        );
        if (stillHeld) return;
        unwatchTokenOnSource('ant', pos.heldToken, this, pos.heldTsym?.startsWith('SENSEX') ? 'BFO' : 'NFO');
    }

    // Opens the opposite side against a lone slot that moved slDistance against its entry. Sized to
    // the lone slot's still-open quantity. The lone slot's own +2 sell is never cancelled.
    private async openOppositeSide(slot: BrokerPosition): Promise<void> {
        if (this.isBrokerStopped(slot.broker)) return;
        const right = slot.right === CALL ? PUT : CALL;
        const remaining = slot.targetQuantity - slot.soldQty;
        if (remaining <= 0) return;
        const key = slotKey(slot.broker, right);
        // Registered as 'buying' synchronously, before any await - a second tick for the same
        // adverse move then sees two slots and does nothing.
        this.positions.set(key, {
            broker: slot.broker, right, phase: 'buying', heldTsym: null, heldToken: null,
            entryAvg: 0, targetQuantity: 0, soldQty: 0, soldValue: 0, entryQuantity: remaining,
        });
        Log.log(`[BulkPcrStrategy] [${slot.broker}] ${slot.heldTsym} is ${this.slDistance()} points below its entry ${slot.entryAvg} - opening ${right} qty=${remaining} against it`);
        await this.buyAndExit(key);
    }

    // Buys one pair-broker side and rests its +2 exit. Used for the opposite-side opening, for a
    // re-buy after a +2 fill, and for retries of either. 'buying' is set synchronously before any
    // await (the callers rely on it to block a duplicate buy for the same side).
    private async buyAndExit(key: string): Promise<void> {
        const pos = this.positions.get(key);
        if (!pos || !pos.right || !(pos.entryQuantity && pos.entryQuantity > 0)) return;

        if (this.isBrokerStopped(pos.broker)) {
            // Stopped before this buy started: nothing is bought, so the side simply ends.
            pos.phase = 'done';
            this.persistState();
            this.finishIfFlat();
            return;
        }

        const niftyLtp = this.lastNiftyQuote?.ltp ?? 0;
        if (!(niftyLtp > 0)) {
            pos.phase = 'pending';
            this.persistState();
            this.logGateOnce(`[${pos.broker}] ${pos.right} buy: no NIFTY price yet - waiting for the next tick`);
            return;
        }

        pos.phase = 'buying';
        pos.lastBuyAttemptAt = Date.now();
        this.persistState();
        try {
            // Same chunked buy the root entry uses: splits above the exchange freeze quantity and
            // returns only once every chunk has filled.
            const result = await OrderClient.getInstance().chunkedBuyIndex(this.userId, {
                right: pos.right, quantity: pos.entryQuantity, niftyLtp, broker: pos.broker, index: this.index(),
                driftCancelPoints: this.cfg().chunkDriftCancelPoints ?? 10,
            });
            // Re-buy rolled to a new contract: stop watching the old token (if no other slot still
            // holds it). Exchange is the OLD heldTsym's, which the unwatch needs.
            const oldToken = pos.heldToken;
            if (oldToken && oldToken !== feedTokenOf(result)) this.unwatchSlot({ ...pos, heldToken: oldToken }, key);
            pos.heldTsym = result.tsym;
            pos.heldToken = feedTokenOf(result);
            pos.entryAvg = result.avgPrice;
            pos.buyAttempts = 0;
            Log.log(`[BulkPcrStrategy] [${pos.broker}] ${pos.right} entry complete: ${pos.heldTsym} qty=${result.quantity} avg=${pos.entryAvg}`);
            if (this.eodDone || this.isBrokerStopped(pos.broker)) {
                // EOD or the loss stop started while this buy was in flight - square it off now, don't rest a sell.
                pos.targetQuantity = result.quantity;
                pos.soldQty = 0;
                pos.soldValue = 0;
                pos.phase = 'selling';
                await this.eodSquareOff(pos);
            } else {
                await this.placeExitSell(key, result.quantity);
            }
        } catch (e: any) {
            const message = typeof e?.message === 'string' ? e.message : String(e);
            if (isNothingBought(e)) {
                this.onBuyNotFilled(pos, message);
            } else {
                pos.phase = 'error';
                Log.log(`[BulkPcrStrategy] [${pos.broker}] ALERT: ${pos.right} buy outcome unconfirmed or partially filled - position may be LIVE and UNPROTECTED, manual review required: ${message}`);
            }
        }
        this.persistState();
        this.finishIfFlat();
    }

    // A buy provably filled nothing. A margin rejection is deterministic: the identical order can never succeed, so
    // it is never retried as-is (live 2026-10-22: 18 identical rejected ANT hedge buys). It gets ONE smaller attempt
    // when the rejection can be parsed; anything else retries a capped number of times with doubling backoff.
    private onBuyNotFilled(pos: BrokerPosition, message: string): void {
        pos.buyAttempts = (pos.buyAttempts ?? 0) + 1;
        if (MARGIN_SHORTFALL_REASON_PATTERN.test(message)) {
            const reduced = pos.marginResized ? null : this.marginReducedQuantity(pos, message);
            if (reduced !== null) {
                Log.log(`[BulkPcrStrategy] [${pos.broker}] ALERT: ${pos.right} buy rejected for margin - retrying ONCE with reduced qty ${pos.entryQuantity} -> ${reduced}`);
                pos.entryQuantity = reduced;
                pos.marginResized = true;
                pos.phase = 'pending';
                pos.lastBuyAttemptAt = 0; // retry on the next tick instead of waiting out the throttle
                return;
            }
            this.abandonBuy(pos, pos.marginResized ? 'margin rejection again after the reduced-size attempt' : 'margin rejection and no affordable reduced size');
            return;
        }
        // MAX_BUY_RETRIES retries after the first failure: failures 1..3 retry (waits 10s, 20s, 40s), failure 4 gives up.
        if (pos.buyAttempts > MAX_BUY_RETRIES) {
            this.abandonBuy(pos, `${pos.buyAttempts} failed attempts: ${message.slice(0, 200)}`);
            return;
        }
        pos.phase = 'pending';
        Log.log(`[BulkPcrStrategy] [${pos.broker}] ${pos.right} buy did not fill - will retry on the next tick (attempt ${pos.buyAttempts}/${MAX_BUY_RETRIES + 1}): ${message}`);
    }

    // Quantity that fits the margin the broker implied, rounded down to a whole lot, or null if none fits.
    // usable = price x qty - shortfall (what the rejection says WAS affordable); keep a 5% buffer.
    private marginReducedQuantity(pos: BrokerPosition, message: string): number | null {
        const parsed = parseAntMarginReject(message);
        if (!parsed) return null;
        const lot = LOT_SIZE[this.index()];
        if (!(pos.entryQuantity && pos.entryQuantity % lot === 0)) return null; // unexpected size: do not guess
        const usable = parsed.price * parsed.quantity - parsed.shortfall;
        const units = Math.floor((usable * (1 - MARGIN_RESIZE_BUFFER)) / parsed.price);
        const reduced = Math.floor(units / lot) * lot;
        return reduced >= lot && reduced < pos.entryQuantity ? reduced : null;
    }

    // Gives up this side's buy for the rest of the cycle. 'done' + abandoned: nothing is held, the other side's
    // resting +2 sell is left alone, and openOppositeSide will not reopen this hedge (see its guard).
    private abandonBuy(pos: BrokerPosition, why: string): void {
        pos.phase = 'done';
        pos.abandoned = true;
        Log.log(`[BulkPcrStrategy] [${pos.broker}] ALERT: ${pos.right} buy abandoned for this cycle - ${why}`);
    }

    // A side whose buy did not fill is 'pending'. It is retried off the still-active side's ticks,
    // throttled so a failing buy doesn't fire on every tick.
    private retryPendingRebuys(): void {
        if (this.eodDone) return;
        for (const pos of this.pairSlots()) {
            if (pos.phase !== 'pending') continue;
            if (this.isBrokerStopped(pos.broker)) {
                pos.phase = 'done'; // stopped: this side never buys again today
                this.persistState();
                this.finishIfFlat();
                continue;
            }
            // Doubling backoff per failed attempt (10s, 20s, 40s), so a failing buy never fires every tick.
            const wait = REBUY_RETRY_THROTTLE_MS * 2 ** Math.max(0, (pos.buyAttempts ?? 1) - 1);
            if (Date.now() - (pos.lastBuyAttemptAt ?? 0) < wait) continue;
            this.buyAndExit(this.keyOf(pos)).catch((e) => Log.log(`[BulkPcrStrategy] [${pos.broker}] pending buy retry failed:`, e));
        }
    }

    // A slot's +2 exit has fully filled. If the opposite side (same broker) is still active, this
    // side re-buys immediately and rests its own +2 again. Otherwise there is nothing left to re-buy.
    private onSlotSoldOut(pos: BrokerPosition): void {
        // This cycle is over: its realized P&L goes into the current trade's total, then the slot's live price is dropped.
        this.bookRealized(pos.broker, pos.soldValue - pos.soldQty * pos.entryAvg);
        this.lastLtpByKey.delete(this.keyOf(pos));
        pos.phase = 'done';
        this.persistState();
        // A realized loss can cross the line with no tick, so check before deciding on the re-buy below.
        const tripped = this.tripIfBreached(pos.broker);
        if (isPairBroker(pos.broker) && !this.eodDone) {
            const sibling = this.slotsOf(pos.broker).find((p) => p.right !== pos.right);
            if (sibling && (sibling.phase === 'selling' || sibling.phase === 'buying') && !this.isBrokerStopped(pos.broker)) {
                Log.log(`[BulkPcrStrategy] [${pos.broker}] ${pos.right} +2 filled while ${sibling.right} is still open - re-buying ${pos.right}`);
                this.buyAndExit(this.keyOf(pos)).catch((e) => Log.log(`[BulkPcrStrategy] [${pos.broker}] re-buy failed:`, e));
            }
        }
        if (tripped) {
            this.lockOutBroker(pos.broker, 'maxLossPerTrade or maxProfit breached on a realized fill').catch((e) => Log.log(`[BulkPcrStrategy] [${pos.broker}] lockout close failed:`, e));
        }
        this.finishIfFlat();
    }

    // A broker whose trade breached maxLossPerTrade or whose day breached maxProfit: its lockout is made durable (both copies) before its open slots are
    // closed, so a restart in between cannot re-enable it. The in-memory latch already blocks every new buy and re-buy.
    private async lockOutBroker(broker: BrokerName, reason: string): Promise<void> {
        Log.log(`[BulkPcrStrategy] [${broker}] LOCKED OUT for the rest of the day (${reason}) - closing this broker's open slots at limit`);
        // Only a real breach is written durably (a latch that merely failed to load is not a breach).
        if (this.stopFor(broker).isLatched()) await this.stopFor(broker).persist();
        if (this.profitStopFor(broker).isLatched()) await this.profitStopFor(broker).persist();
        await this.persistState();
        await this.closeBroker(broker);
    }

    // Closes every open slot of a loss-stopped broker: cancels its resting +N sell, then squares off the rest at
    // limit (eodSquareOff). Only acts on 'selling' slots that are not already being closed or placed; a 'buying'
    // slot is squared off by buyAndExit when its buy returns, and a slot still being placed is closed by
    // placeExitSellAtTargetPrice once placement returns. Safe to call repeatedly.
    private async closeBroker(broker: BrokerName): Promise<void> {
        for (const pos of this.slotsOf(broker)) {
            const key = this.keyOf(pos);
            if (pos.phase === 'selling') {
                if (pos.squaringOff || this.placingKeys.has(key)) continue;
                await this.eodSquareOff(pos);
            } else if (pos.phase === 'pending') {
                pos.phase = 'done'; // nothing held - the buy never filled
            } else if (pos.phase === 'error') {
                Log.log(`[BulkPcrStrategy] [${broker}] stop: ${pos.right} slot is in error - skipped, manual review required`);
            }
        }
        this.persistState();
        this.finishIfFlat();
    }

    // EOD force-close of one pair slot: pull its resting +2 sells, then square off what's still
    // open. The resting-order cancellations and fills that follow are ignored (see onOrderCancelled).
    // The cancel and square-off go through that slot's own broker.
    private async eodSquareOff(pos: BrokerPosition): Promise<void> {
        if (pos.squaringOff) return; // already being closed by another path
        const tsym = pos.heldTsym!;
        const broker = pos.broker;
        // Held across the whole close, not just the cancel: updateTrade ignores fills while squaringOff, so
        // this cycle is counted exactly once - the cancel's filledQty below plus the square-off's own average.
        // Counting the square-off's fills via updateTrade as well would double-book the cycle's realized P&L.
        pos.squaringOff = true;
        try {
            let cancelResult: { filledQty: number; cancelFailed: boolean };
            try {
                cancelResult = await OrderClient.getInstance().cancelRestingLimitSells(this.userId, { tsym, broker });
            } catch (e) {
                cancelResult = { filledQty: 0, cancelFailed: true };
                Log.log(`[BulkPcrStrategy] [${broker}] EOD cancel request failed for ${tsym}:`, e);
            }
            // Book the cancel-window fills first (even if another chunk's cancel failed): they are sold.
            // They filled at the resting limit price, so that prices them for the logged average.
            const exitPrice = pos.entryAvg + (this.cfg().targetPoints ?? 2);
            pos.soldQty += cancelResult.filledQty;
            pos.soldValue += cancelResult.filledQty * exitPrice;
            this.persistState();
            if (pos.soldQty >= pos.targetQuantity) {
                // Everything already sold (resting fills, incl. the cancel window): nothing to square off,
                // whatever happened to a cancel. This is the cycle's only booking.
                pos.phase = 'done';
                Log.log(`[BulkPcrStrategy] [${broker}] EOD: ${tsym} already fully sold (${pos.soldQty}/${pos.targetQuantity}) - nothing to square off`);
                this.bookRealized(broker, pos.soldValue - pos.soldQty * pos.entryAvg);
                this.lastLtpByKey.delete(this.keyOf(pos));
                this.persistState();
                return;
            }
            if (cancelResult.cancelFailed) {
                pos.phase = 'error';
                Log.log(`[BulkPcrStrategy] [${broker}] ALERT: EOD force-close of ${tsym} aborted, resting sell cancel failed - manual review required`);
                this.persistState();
                return;
            }
            const remaining = pos.targetQuantity - pos.soldQty;
            try {
                let squareOffAvg: number | undefined;
                if (remaining > 0) {
                    if (broker === 'ant') {
                        const trade = await OrderClient.getInstance().antSquareOffBare(this.userId, { tradingSymbol: tsym, quantity: remaining, exchange: tsym.startsWith('SENSEX') ? 'BFO' : 'NFO' });
                        squareOffAvg = trade?.price;
                    } else if (broker === 'zerodha' || broker === 'breeze') {
                        const res = await OrderClient.getInstance().chunkedSquareOff(this.userId, { tsym, quantity: remaining, broker });
                        squareOffAvg = res?.avgPrice;
                    } else {
                        throw new Error(`EOD square-off: broker '${broker}' does not run a pair`);
                    }
                }
                // Realized for the cycle: the cancel-window part (above) plus the square-off part at its own average.
                // If the average is missing, estimate from the last tick and say so in the log.
                let sellPrice = squareOffAvg;
                if (remaining > 0 && !(Number.isFinite(sellPrice) && sellPrice! > 0)) {
                    sellPrice = this.lastLtpByKey.get(this.keyOf(pos)) ?? pos.entryAvg;
                    Log.log(`[BulkPcrStrategy] [${broker}] ${tsym} square-off gave no average price - booking exit at ${sellPrice} (estimated)`);
                }
                const squaredOffPnl = remaining > 0 ? remaining * (sellPrice! - pos.entryAvg) : 0;
                this.bookRealized(broker, pos.soldValue - pos.soldQty * pos.entryAvg + squaredOffPnl);
                this.lastLtpByKey.delete(this.keyOf(pos));
                // A fill notification may already have completed the slot via updateTrade/onSlotSoldOut.
                if (pos.phase === 'selling') pos.phase = 'done';
                if (remaining > 0) Log.log(`[BulkPcrStrategy] [${broker}] Close fill: ${tsym} qty=${remaining} @${sellPrice}`);
                Log.log(`[BulkPcrStrategy] [${broker}] EOD force-close: ${tsym} squared off qty=${Math.max(remaining, 0)}`);
            } catch (e) {
                // Nothing is booked: the square-off's fills are unknown, and a retry would double count.
                if (pos.phase === 'selling') pos.phase = 'error'; // a fill may already have completed the slot
                Log.log(`[BulkPcrStrategy] [${broker}] ALERT: EOD square-off failed for ${tsym} - manual review required:`, e);
            }
            this.persistState();
        } finally {
            pos.squaringOff = false;
        }
    }

    private async eodCloseSlots(): Promise<void> {
        for (const pos of this.pairSlots()) {
            if (pos.phase === 'selling') await this.eodSquareOff(pos);
            else if (pos.phase === 'pending') pos.phase = 'done'; // nothing held - the buy never filled
            else if (pos.phase === 'error') Log.log(`[BulkPcrStrategy] [${pos.broker}] EOD: ${pos.right} slot is in error - skipped, manual review required`);
        }
        this.persistState();
        this.finishIfFlat();
    }

    // True once every configured broker has at least one slot and none is still buying, selling,
    // or in error. A 'pending' side only counts as finished when no other side is still active.
    private allBrokersFinished(): boolean {
        return this.configuredBrokers().every((b) => {
            const slots = Array.from(this.positions.values()).filter((p) => p.broker === b);
            if (slots.length === 0) return false;
            const anyActive = slots.some((p) => p.phase === 'selling' || p.phase === 'buying' || p.phase === 'error');
            return !anyActive && slots.every((p) => p.phase === 'done' || p.phase === 'pending');
        });
    }

    private finishIfFlat(): void {
        if (this.allBrokersFinished()) this.durablyDisable('Cycle complete on every configured broker');
    }


    // Fills for an exit come back here asynchronously, one chunk at a time, potentially far apart -
    // a resting limit sell only fills once the market actually reaches the target price. A slot is
    // complete once its full sold quantity is confirmed; onSlotSoldOut decides what follows.
    updateTrade = async (trade: Trade): Promise<void> => {
        const broker = trade.broker as BrokerName | undefined;
        if (!broker) return; // untagged fill - can't attribute to a position, ignore defensively
        const pos = this.slotFor(broker, trade.tsym);
        if (!pos || pos.phase !== 'selling' || pos.squaringOff) return;
        if (trade.action !== 'Sell' || trade.tsym !== pos.heldTsym) return;

        pos.soldQty += trade.quantity;
        pos.soldValue += trade.quantity * trade.price;
        Log.log(`[BulkPcrStrategy] [${broker}] Exit fill: ${trade.tsym} qty=${trade.quantity} @ ${trade.price} (sold ${pos.soldQty}/${pos.targetQuantity})`);
        this.persistState();
        if (pos.soldQty < pos.targetQuantity) return; // more chunks still resting for this slot

        const avgExit = pos.soldValue / pos.soldQty;
        Log.log(`[BulkPcrStrategy] [${broker}] Exit complete: ${pos.heldTsym} qty=${pos.soldQty} avgExit=${avgExit}`);
        this.onSlotSoldOut(pos);
    };

    // Durable self-disable - mirrors GoodMorningStrategy.ts's exact pattern
    // (configService.writeConfig), since an in-memory-only this.enabled = false
    // would be silently overwritten back to config.yml's static enabled: true
    // on the next restart (StrategyFactory.createStrategy always does
    // strategy.enabled = config.enabled after construction). Shared by
    // updateTrade (every broker's exit filled normally) and reconcile (a
    // restart discovers every broker was already fully closed at the broker -
    // see reconcile's 2026-10-15 bug-fix comment: without this, a position
    // closed outside the app left this.phase stuck at 'running' forever,
    // since nothing else would ever flip it to 'done').
    private durablyDisable(reason: string): void {
        // Found on review: reconcile()'s own allBrokersFinished check and finishIfFlat
        // can both observe "every broker done" and both call this - reconcile() awaits network
        // calls per broker with nothing excluding a fill notification from landing mid-loop. Both
        // calls were already idempotent (same end state either way), but this guard skips the
        // redundant config write and avoids a second, confusing "already fully closed at the
        // broker on restart" log line for what was actually just a normal fill.
        if (this.phase === 'done') return;
        // Unwatch every pair slot's held token - a no-op for any that was never watched.
        for (const slot of this.pairSlots()) {
            if (slot.heldToken) unwatchTokenOnSource('ant', slot.heldToken, this, slot.heldTsym?.startsWith('SENSEX') ? 'BFO' : 'NFO');
        }
        // Not configService.getStrategyConfig(type) - see cfg()'s comment above for why;
        // this call site was missed when that fix landed. A second instance under a
        // different userId must disable ITS OWN entry, not whichever is listed first.
        const liveCfg = configService.getConfig().strategies?.find(
            (s) => s.type === 'BulkPcrStrategy' && (s.userId || s.type) === this.userId
        );
        if (!liveCfg) {
            Log.log(`[BulkPcrStrategy] ALERT: durablyDisable could not find this instance's own config.yml entry - NOT persisted, flip enabled: false manually.`);
            this.enabled = false;
            this.phase = 'done';
            return;
        }
        liveCfg.enabled = false;
        configService.writeConfig(configService.getConfig());
        this.enabled = false; // stop in-memory immediately too - config.yml only gets re-read on next restart
        this.phase = 'done';
        Log.log(`[BulkPcrStrategy] ${reason} - durably disabled. Flip enabled: true in config.yml manually to arm another run.`);
    }

    // Called when a resting limit order (e.g. an exit sell) is cancelled/rejected,
    // typically because a DAY-validity order expires unfilled at end of session.
    // Re-places a resting sell for the cancelled quantity at the same target price,
    // without disturbing already-filled or still-resting chunks.
    onOrderCancelled = async (notification: any): Promise<void> => {
        const broker = notification.broker as BrokerName | undefined;
        if (!broker) return;
        // Pair-broker slots are found by their held tsym (both sides can be open); every other broker
        // has a single position keyed by its name.
        const pos = this.slotFor(broker, notification.tradingSymbol);

        // Ignore if this notification doesn't match an open/selling position we care about. Also
        // ignored once the EOD force-close has started - its own cancellations must not be re-placed.
        if (!pos || pos.phase !== 'selling' || pos.heldTsym !== notification.tradingSymbol || this.eodDone) {
            return;
        }
        // Cancellations from the loss stop's own close (squaringOff) must not be re-placed. For a stopped
        // broker a cancellation we did not make leaves the position unprotected, so flag it for manual review.
        if (pos.squaringOff) return;
        if (this.isBrokerStopped(pos.broker)) {
            Log.log(`[BulkPcrStrategy] [${pos.broker}] ALERT: resting sell for ${notification.tradingSymbol} cancelled while the loss stop is active - NOT re-placing, manual review required`);
            return;
        }

        const rejectReason: string | undefined = notification.rejectReason;
        if (notification.reason === 'REJECTED') {
            const now = Date.now();
            // Found on review: a streak of well-separated, one-off rejections (e.g. from
            // different resting chunks, each failing for its own unrelated transient reason)
            // must not accumulate toward the cap the same way a tight, genuinely-stuck loop
            // would (the actual 2026-10-15 incident: 4 rejections in under 30s). Reset the
            // streak if the gap since the last rejection is too large to plausibly be the same
            // problem - see BrokerPosition.exitRejectCount's comment for the remaining gap this
            // doesn't fully close (no per-chunk identity exists to solve it precisely).
            const withinStreak = pos.exitLastRejectAt != null && now - pos.exitLastRejectAt <= EXIT_REJECT_STREAK_RESET_MS;
            pos.exitRejectCount = (withinStreak ? pos.exitRejectCount ?? 0 : 0) + 1;
            pos.exitLastRejectAt = now;

            if (rejectReason && MARGIN_SHORTFALL_REASON_PATTERN.test(rejectReason)) {
                // A margin/shortfall rejection means there's nothing left to sell against -
                // most likely the position was already closed outside the app (see the
                // 2026-10-15 incident this guards against). Retrying would just repeat the
                // same rejection forever.
                Log.log(`[BulkPcrStrategy] [${broker}] Exit sell for ${notification.tradingSymbol} REJECTED (${rejectReason}) - looks like a margin/shortfall rejection, likely because the position is already closed at the broker. NOT re-placing - manual review required.`);
                pos.phase = 'error';
                this.persistState();
                return;
            }

            if (pos.exitRejectCount > MAX_EXIT_REJECT_RETRIES) {
                Log.log(`[BulkPcrStrategy] [${broker}] Exit sell for ${notification.tradingSymbol} REJECTED ${pos.exitRejectCount} times in a row (${rejectReason ?? 'no reason given'}) - giving up on auto re-placement. Manual review required.`);
                pos.phase = 'error';
                this.persistState();
                return;
            }
        } else {
            pos.exitRejectCount = 0; // a plain (non-rejected) cancellation, e.g. EOD expiry - not a rejection streak
            pos.exitLastRejectAt = undefined;
        }

        Log.log(`[BulkPcrStrategy] [${broker}] Order cancelled: ${notification.tradingSymbol} qty=${notification.quantity} (${notification.reason}${rejectReason ? `: ${rejectReason}` : ''}) - re-placing resting sell`);
        if ((pos.exitRejectCount ?? 0) > 1) {
            // Back off before resubmitting a repeat rejection, instead of tight-looping
            // identical orders (2026-10-15: 4 resubmissions in under 30s with no delay).
            await sleep(EXIT_REJECT_RETRY_DELAY_MS);
        }
        await this.placeExitSellAtTargetPrice(this.keyOf(pos), notification.quantity, false);
    };

    getMonitorConfig() {
        return null; // self-monitored, no GTT/bracket - Breeze doesn't support them anyway
    }

    // Restart-safety: without this, a restart mid-cycle would reset phase to
    // 'idle' in memory and could fire a SECOND live block buy on the next
    // PCR-aligned tick. Runs independently per configured broker - one
    // broker can be resting fine while a different broker sits in 'error'
    // needing manual review, or a third was never even attempted yet.
    // Mirrors ContinuousStrategy.reconcile()'s retry shape.
    //
    // KNOWN RACE (live 2026-10-21, ToDo.md): this is only as good as getOpenTradesOnce's
    // first successful response. If the `order` process's own IPC socket is already
    // accepting connections but its startup broker-position restore
    // (loadOpenTradesFromBroker/restoreOpenTradesForTsym) hasn't finished populating
    // bookkeeping.trades yet, getOpenTrades() succeeds (no retry triggered - the call
    // itself doesn't error) and simply returns an empty/incomplete list. A real open
    // position with no persisted state can then be missed entirely, anyRestored stays
    // false, this.phase stays 'idle', and the ordinary fresh-entry gate opens instead -
    // exactly what happened live when both `order` and `strategies` were restarted
    // together. Restarting only `strategies` while `order` is already warm (its own
    // restore long finished) avoids this; restarting both at once does not. Not fixed
    // here - needs either a readiness handshake from `order` or retrying
    // getOpenTradesOnce() when it returns suspiciously empty, not just when it throws.
    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        this.reconciling = true;
        try {
            await this.reconcileBody(maxAttempts, retryDelayMs);
        } finally {
            this.reconciling = false;
        }
    }

    private async reconcileBody(maxAttempts: number, retryDelayMs: number): Promise<void> {
        const persisted = await this.loadState();
        // Loss-stop state first, before any slot is rebuilt: the current trade's realized P&L (only if it was saved today)
        // and each pair broker's lockout. A restored lockout blocks new buys; open slots of a locked-out broker are closed
        // once the slots are rebuilt (see the end of this method).
        this.ensureToday();
        await this.loadStopLatches();
        const brokers = this.configuredBrokers();
        let anyRestored = false;

        // getOpenTrades(userId) returns the SAME full list regardless of
        // which broker is asking (bookkeeping.trades filtered by user only,
        // each entry separately tagged with its own broker) - fetched at
        // most once, lazily, the first time any broker actually needs it
        // below, and reused for every other broker that also needs it.
        // Avoids both a redundant IPC round-trip per broker and (more
        // importantly) doubling the worst-case retry-exhaustion latency if
        // the order-process IPC channel is down at startup - a query that's
        // already proven to fail 15 times for broker A tells us nothing new
        // by failing 15 more times for broker B.
        let openTradesFetch: Promise<any[] | undefined> | null = null;
        const getOpenTradesOnce = (): Promise<any[] | undefined> => {
            if (!openTradesFetch) {
                openTradesFetch = (async () => {
                    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                        try {
                            return await OrderClient.getInstance().getOpenTrades(this.userId);
                        } catch (e) {
                            Log.log(`[BulkPcrStrategy] reconcile: order query attempt ${attempt}/${maxAttempts} failed:`, e);
                            if (attempt === maxAttempts) {
                                Log.log('[BulkPcrStrategy] reconcile: order query exhausted retries - failing closed for every broker still pending reconciliation');
                                return undefined;
                            }
                            await sleep(retryDelayMs);
                        }
                    }
                    return undefined;
                })();
            }
            return openTradesFetch;
        };

        // Pair brokers are restored per side (<broker>_call / <broker>_put). A pre-pair bare-name
        // record (e.g. 'ant', 'zerodha') is migrated to its side (inferred from the tsym's CE/PE
        // suffix); anything else non-done is kept as a manual-review slot.
        const persistedPositions: Record<string, any> = { ...(persisted?.positions ?? {}) };
        for (const b of PAIR_BROKERS) {
            const legacy = persistedPositions[b];
            if (!legacy) continue;
            delete persistedPositions[b];
            if (legacy.phase === 'done') continue;
            if (legacy.phase === 'selling' && legacy.heldTsym) {
                const right = tsymRight(legacy.heldTsym);
                persistedPositions[slotKey(b, right)] = { ...legacy, broker: b, right, entryQuantity: legacy.targetQuantity };
            } else {
                persistedPositions[`${b}_legacy`] = { ...legacy, broker: b, phase: 'error' };
            }
        }
        const keys = new Set<string>();
        for (const b of brokers) {
            if (isPairBroker(b)) { keys.add(slotKey(b, CALL)); keys.add(slotKey(b, PUT)); }
            else keys.add(b);
        }
        for (const k of Object.keys(persistedPositions)) keys.add(k);

        for (const key of keys) {
            const broker = brokerOfKey(key);
            const persistedPos = persistedPositions[key];

            // Which side (CALL/PUT) this key represents, if any - derived from the key's own
            // structure (see slotKey() above), not from the broker's name. Every branch below is
            // driven by this value instead of a broker-name check.
            const keyRight = key !== broker ? (key === slotKey(broker, PUT) ? PUT : CALL) : undefined;

            if (persistedPos && (persistedPos.phase === 'done' || persistedPos.phase === 'pending')) {
                this.positions.set(key, { ...persistedPos });
                anyRestored = true;
                continue;
            }

            if (persistedPos?.phase === 'selling') {
                // A limit-sell exit was already resting for this broker when
                // this process last shut down. The broker-side pending-order
                // trackers (pendingLimitOrders.ts / breezePendingLimitOrders.ts)
                // are independently restart-safe and will keep polling that
                // same resting order to completion, feeding fills back
                // through updateTrade as usual. Falling through to the
                // 'error'/open-trades branches below instead would risk
                // calling placeExitSell again and placing a SECOND limit sell
                // for the same already-resting quantity - an oversell if both
                // eventually filled.
                //
                // BUT every resting sell chunk is a DAY order - the exchange
                // cancels/expires it unfilled at EOD regardless of what this
                // app believes. If sellPlacedAt is missing (persisted before
                // this field existed), falls on an earlier calendar day than
                // now, OR falls on today but today's market has already
                // closed since (a same-day restart after 15:25 - calendar
                // date alone isn't enough), the resting order is certainly
                // gone already, not "still resting" - live incident
                // 2026-09-24: both the Zerodha and Breeze legs' chunks from
                // 23-Sep expired unfilled at that day's EOD (Breeze's own
                // order book showed status "Expired" on all of them), leaving
                // the position with zero exit protection into the next day.
                // Detected here rather than trusted, and re-placed for the
                // remaining unsold quantity (soldQty/soldValue preserved, not
                // reset).
                //
                // Before any of that: confirm the position is still genuinely open at the
                // broker at all. Live incident 2026-10-15 - a position that had already been
                // squared off manually, outside this app, had its stale 'selling' state
                // resumed here purely from this persisted Mongo doc with no broker
                // confirmation, then (once the resting sell was rejected as a naked short with
                // no position to cover it) looped re-placing the identical doomed sell forever.
                // getOpenTrades is the same broker-truth signal the 'buying'/never-attempted
                // branch below already trusts - reused here rather than adding a second
                // broker-facing path. A failed query can't confirm either way, so it does NOT
                // treat the position as closed - that would be worse than the bug it's fixing.
                const openTrades = await getOpenTradesOnce();
                const matchingOpenTrade = openTrades?.find((t: any) => t.broker === broker && t.tsym === persistedPos.heldTsym);
                const stillOpenAtBroker = openTrades === undefined || matchingOpenTrade != null;
                if (!stillOpenAtBroker) {
                    Log.log(`[BulkPcrStrategy] [${broker}] reconcile: persisted exit state for ${persistedPos.heldTsym} says 'selling', but no matching open position was found at the broker - treating it as already closed and clearing the stale exit state (NOT resuming fill-watch or re-placing)`);
                    this.positions.set(key, { ...persistedPos, phase: 'done' });
                    anyRestored = true;
                    this.persistState();
                    continue;
                }

                // Considered on review: unlike the previous-trading-day branch below, this one
                // places no new order - it only resumes the poller's watch on a sell that's
                // ALREADY resting at the broker at whatever quantity it was given when placed.
                // The quantity-clamp fix below (liveOpenQty) exists because THAT branch chooses a
                // fresh quantity to place; there's nothing to clamp here since no placement
                // decision is made in this branch at all. A stale soldQty/targetQuantity here
                // only affects bookkeeping of a fill already in flight, not a new order size.
                const placedSameDay = persistedPos.sellPlacedAt != null && isStillWithinSameTradingSession(persistedPos.sellPlacedAt);
                if (placedSameDay) {
                    const pos = { ...persistedPos };
                    this.positions.set(key, pos);
                    anyRestored = true;
                    // The comment above this branch assumes the tick subscription survived the
                    // restart - true for THIS process (strategies), but not for the separate
                    // `data` process, which loses its own in-memory subscription map on its own
                    // restart. Found live 2026-10-21: after a restart cycle that touched both
                    // processes, this branch kept resuming 'selling' correctly but never
                    // re-subscribed, so no option tick ever reached processOptionQuote again -
                    // the opposite-side hedge trigger silently went dead despite the position
                    // otherwise looking perfectly healthy. watchTokenOnSource is idempotent
                    // (tokenRouter dedupes by refcount), so calling it here even when the
                    // subscription did survive is harmless.
                    this.watchSlot(pos);
                    Log.log(`[BulkPcrStrategy] [${broker}] reconcile: restored in-flight limit-sell exit for ${persistedPos.heldTsym} (${persistedPos.soldQty}/${persistedPos.targetQuantity} filled so far) - resuming fill watch`);
                    continue;
                }

                if (isPastMarketClose()) {
                    // reconcile() itself is running after hours (e.g. an
                    // evening restart) - re-placing now would hit a closed
                    // exchange and fail immediately, same reason
                    // pendingLimitOrders.ts/breezePendingLimitOrders.ts defer
                    // an EOD-detected cancellation instead of re-placing
                    // on the spot. Restore the position as-is (still
                    // 'selling', no live resting order at the broker) without
                    // attempting a doomed placement - the next restart's
                    // reconcile() re-evaluates this exact branch and will
                    // succeed once it runs during market hours.
                    this.positions.set(key, { ...persistedPos });
                    anyRestored = true;
                    Log.log(`[BulkPcrStrategy] [${broker}] reconcile: persisted limit-sell exit for ${persistedPos.heldTsym} expired unfilled at EOD, but market is currently closed - deferring re-placement to the next restart during market hours (NOT auto-placing now)`);
                    continue;
                }

                let remaining = persistedPos.targetQuantity - persistedPos.soldQty;
                // BUG FIX 2026-10-15 (found on review): stillOpenAtBroker above only checks
                // WHETHER a position exists, not whether its quantity still covers the persisted
                // "remaining" amount. A partial manual sell outside the app between restarts
                // (e.g. targetQuantity=100, soldQty=40 persisted, but the user manually sold 30
                // of the remaining 60 at the broker) would otherwise re-place a sell for the
                // stale 60 - a naked short for the 30 that's no longer held. Clamp to whatever
                // the broker actually still shows open for this exact (broker, tsym).
                const liveOpenQty = matchingOpenTrade?.quantity;
                if (liveOpenQty != null && liveOpenQty < remaining) {
                    Log.log(`[BulkPcrStrategy] [${broker}] reconcile: persisted remaining qty=${remaining} for ${persistedPos.heldTsym} exceeds what the broker actually shows open (${liveOpenQty}) - some may have been sold outside the app; clamping to ${liveOpenQty}`);
                    remaining = liveOpenQty;
                }
                Log.log(`[BulkPcrStrategy] [${broker}] reconcile: persisted limit-sell exit for ${persistedPos.heldTsym} was placed on a previous trading day (sellPlacedAt=${persistedPos.sellPlacedAt ?? 'unset'}) - DAY-order validity means it has certainly expired unfilled at the broker; re-placing exit for remaining qty=${remaining}`);
                this.positions.set(key, { ...persistedPos });
                anyRestored = true;
                await this.placeExitSellAtTargetPrice(key, remaining, false);
                continue;
            }

            if (persistedPos) {
                // Any persisted phase reaching here is neither 'done'/'pending' nor
                // 'selling' (both handled above, and 'selling' always continues) - so
                // it's 'buying' (caught mid-buy, fill unknown - no tsym to reconcile
                // against), an already-'error' slot from a prior run, or a legacy shape.
                // getOpenTrades below can't tell "clean buy done, exit never attempted"
                // apart from "exit partially placed then failed" - blindly calling
                // placeExitSell here could place a SECOND resting sell on top of chunks
                // already resting from a failed attempt, an oversell if both fill. Fail
                // closed for every broker: stay in/move to 'error' and require the
                // manual review the original failure already called for. Skips the
                // redundant persistState() write if it was already 'error' - no actual
                // state change to record.
                //
                // EXCEPTION (live 2026-10-21): an 'error' slot that still has its tsym
                // recorded is worth one broker-truth check before giving up on it - the
                // exact incident that landed here was a duplicate-sell rejection on top
                // of a sell that was ALREADY resting and fine; the position itself was
                // never actually broken. Reusing the same getPendingSells check the
                // fresh-no-persisted-state fallback below already uses for this reason.
                if (persistedPos.phase === 'error' && persistedPos.heldTsym) {
                    const pendingSells = await OrderClient.getInstance()
                        .getPendingSells(this.userId, broker, persistedPos.heldTsym)
                        .catch(() => [] as { quantity: number }[]);
                    const alreadyResting = pendingSells.reduce((sum, o) => sum + o.quantity, 0);
                    if (alreadyResting > 0) {
                        const pos: BrokerPosition = {
                            ...persistedPos,
                            phase: 'selling',
                            targetQuantity: alreadyResting,
                            soldQty: 0,
                            soldValue: 0,
                            sellPlacedAt: Date.now(),
                            // Reset the rejection streak - onOrderCancelled only guards on
                            // phase !== 'selling' (line ~887), so leaving the old count/
                            // timestamp in place would let the very next rejection
                            // immediately re-trip MAX_EXIT_REJECT_RETRIES and bounce
                            // straight back to 'error'.
                            exitRejectCount: 0,
                            exitLastRejectAt: undefined,
                        };
                        this.positions.set(key, pos);
                        anyRestored = true;
                        this.persistState();
                        // Same reason placeExitSellAtTargetPrice/the alreadyResting fallback
                        // below call this - ticks must reach processOptionQuote or the
                        // opposite-side hedge trigger can never evaluate.
                        this.watchSlot(pos);
                        Log.log(`[BulkPcrStrategy] [${broker}] reconcile: ${key} was 'error' but a resting exit sell for ${persistedPos.heldTsym} (qty=${alreadyResting}) is still confirmed at the broker - resuming fill watch instead of manual review`);
                        continue;
                    }
                }
                const alreadyError = persistedPos.phase === 'error';
                this.positions.set(key, { ...persistedPos, phase: 'error' });
                anyRestored = true;
                if (!alreadyError) this.persistState();
                Log.log(`[BulkPcrStrategy] [${broker}] reconcile: ${key} was '${persistedPos.phase}' at shutdown - manual review required, NOT auto-placing anything`);
                continue;
            }

            // Reached only when there's no persisted record at all for this key (every
            // persisted phase - done/pending/selling/anything else - was handled and
            // `continue`d above) - check the live broker/Mongo truth for a position a
            // crash left with a genuinely never-attempted exit.
            const openTrades = await getOpenTradesOnce();
            if (!openTrades) {
                Log.log(`[BulkPcrStrategy] [${broker}] reconcile: order query exhausted retries - failing closed`);
                this.positions.set(key, { broker, phase: 'error', heldTsym: null, heldToken: null, entryAvg: 0, targetQuantity: 0, soldQty: 0, soldValue: 0 });
                anyRestored = true;
                continue;
            }

            // getOpenTrades(userId) returns one entry per broker this user holds a
            // position on - except when this key represents one side of a two-sided
            // broker, where the other side can independently also be open under the
            // SAME broker name at once (ant's actual incident 2026-10-21: both legs
            // naked simultaneously). tsymRight() - the only reliable per-side signal,
            // since a buy Trade never sets `right` (see antExecutor.ts) - disambiguates
            // which of the two this key should claim. For a single-sided broker,
            // keyRight is undefined and this reduces to the original broker-only match.
            const brokerTrade = openTrades.find((t: any) =>
                t.broker === broker && (keyRight == null || tsymRight(t.tsym) === keyRight)
            );
            if (!brokerTrade) continue; // nothing open for this broker/side - stays untracked

            anyRestored = true;
            this.positions.set(key, {
                broker,
                phase: 'buying',
                heldTsym: brokerTrade.tsym,
                heldToken: String(brokerTrade.token),
                entryAvg: brokerTrade.price,
                targetQuantity: 0,
                soldQty: 0,
                soldValue: 0,
                // Only meaningful for a key that represents a side - right/entryQuantity
                // are never read for a single-sided broker slot (every reference to
                // pos.right/pos.entryQuantity in this file is inside ant-only rebuy/
                // opposite-side logic). entryQuantity must be the real open quantity so
                // a later +2 fill correctly triggers a rebuy (buyAndExit's guard
                // requires entryQuantity > 0).
                ...(keyRight != null ? { right: keyRight, entryQuantity: brokerTrade.quantity } : {}),
            });

            // Before placing a brand-new exit sell, check whether one already survived
            // from before whatever crash left this key with no persisted state (live
            // 2026-10-21: placeExitSellAtTargetPrice had run successfully once, earlier,
            // before the restart that triggered this whole reconcile path - the resting
            // sell it placed was still live at the broker). Placing a second sell on top
            // of it would oversell (offer more than brokerTrade.quantity against what's
            // actually held), which the broker reads as a naked short needing full margin
            // for the excess - this is what actually caused that incident's "Margin
            // Shortfall" rejection, not a broker netting bug. Broker-uniform (same check,
            // same shape, for every broker - degrades to "nothing pending" and the normal
            // placeExitSell path for a broker with no survivor).
            const pendingSells = await OrderClient.getInstance().getPendingSells(this.userId, broker, brokerTrade.tsym).catch(() => [] as { quantity: number }[]);
            const alreadyResting = pendingSells.reduce((sum, o) => sum + o.quantity, 0);
            if (alreadyResting > 0) {
                const pos = this.positions.get(key)!;
                pos.phase = 'selling';
                pos.targetQuantity = alreadyResting;
                pos.soldQty = 0;
                pos.soldValue = 0;
                pos.sellPlacedAt = Date.now();
                this.persistState();
                // Same reason placeExitSellAtTargetPrice does this on its own success
                // path - ticks must reach processOptionQuote regardless of which path
                // confirmed the exit is in place, or the opposite-side hedge trigger can
                // never evaluate even once price has already moved past slDistance.
                this.watchSlot(pos);
                Log.log(`[BulkPcrStrategy] [${broker}] reconcile: found an already-resting exit sell for ${brokerTrade.tsym} (qty=${alreadyResting}) - resuming fill watch instead of placing a duplicate`);
                continue;
            }

            if (isPastMarketClose()) {
                // Same reasoning as the persisted 'selling' branch above: a
                // crash between the buy fill and the first placeExitSell call
                // (never persisted mid-flight, since 'buying' isn't a phase
                // this.persistState() is called for) can leave a live open
                // position with zero exit protection. If reconcile() itself
                // is running after hours, placing now would hit a closed
                // exchange and fail into phase='error' - defer instead; the
                // next restart's reconcile() re-runs this exact branch during
                // market hours and will place it then.
                Log.log(`[BulkPcrStrategy] [${broker}] reconcile: found open position ${brokerTrade.tsym} avg=${brokerTrade.price} qty=${brokerTrade.quantity} with no exit ever attempted, but market is currently closed - deferring exit placement to the next restart during market hours (NOT auto-placing now)`);
                continue;
            }

            Log.log(`[BulkPcrStrategy] [${broker}] reconcile: restored open position ${brokerTrade.tsym} avg=${brokerTrade.price} qty=${brokerTrade.quantity} - placing exit sell`);
            await this.placeExitSell(key, brokerTrade.quantity);
        }

        // BUG FIX 2026-10-15 (found on review): blindly setting 'running' whenever anyRestored
        // overrode the stillOpenAtBroker branch's per-broker phase='done' - nothing else would
        // ever flip the outer phase back to 'done' (that normally only happens via updateTrade's
        // allDone check, which this restart path never reaches), so isRunning() would report
        // true FOREVER and hasBrokerError() would report false (the broker position is 'done',
        // not 'error') - a silent, permanent hang invisible to BulkPcrAutoStartStrategy, which
        // has no way to tell it apart from a healthy in-progress cycle.
        if (anyRestored && this.allBrokersFinished()) {
            this.durablyDisable('reconcile: every configured broker was already fully closed at the broker on restart');
        } else if (anyRestored) {
            this.phase = 'running';
        }
        // A broker locked out for today never resumes on restart: a restored open exit or pending slot is closed now,
        // so a crash between the trip and its close cannot leave a locked-out broker holding a position.
        for (const b of this.configuredBrokers()) {
            if (!isPairBroker(b) || !this.isBrokerStopped(b)) continue;
            if (!this.slotsOf(b).some((p) => p.phase === 'selling' || p.phase === 'pending')) continue;
            await this.lockOutBroker(b, 'restart found this broker locked out for today').catch((e) => Log.log(`[BulkPcrStrategy] [${b}] reconcile: lockout close failed:`, e));
        }
    }

    // Exposes the outer one-shot reentrancy gate to callers outside this
    // class (BulkPcrAutoStartStrategy, the scheduled auto-arm wrapper) that
    // need to know "is a cycle actively in flight right now" before
    // deciding to re-arm. phase='done' (finished, waiting to be reset) and
    // phase='idle' (never run / already reset) both correctly report false -
    // both are safe states to re-arm from.
    isRunning(): boolean {
        return this.phase === 'running';
    }

    // isRunning() alone can't tell a healthy in-flight cycle apart from a
    // permanently stuck one: once any configured broker's position enters
    // phase='error' (a failed chunked buy or failed limit-sell placement),
    // the outer phase can never reach 'done' (requires EVERY broker 'done')
    // and reconcile() re-forces it back to 'running' on every restart too -
    // so isRunning() stays true indefinitely until a human calls reset()
    // after the manual review the 'error' phase already demands (see
    // enterOnBroker/placeExitSellAtTargetPrice's "manual review required"
    // logging). Exposed so BulkPcrAutoStartStrategy can log this case
    // distinctly from an ordinary "already running - skipping" line, which
    // otherwise looks identical for both.
    hasBrokerError(): boolean {
        return Array.from(this.positions.values()).some((p) => p.phase === 'error');
    }

    // keepStops: the auto-start re-arm path. It keeps today's loss-stop latches and realized P&L (the stop
    // must survive a re-arm). Without it (admin reset) the stops and the day's realized P&L are cleared too.
    reset(opts?: { keepStops?: boolean }): void {
        // The day's realized P&L (maxProfit) is not touched by a re-arm - it is cleared only by the admin reset below.
        this.phase = 'idle';
        this.positions.clear();
        this.lastLtpByKey.clear();
        if (opts?.keepStops) {
            // Re-saves the state with no positions. Lockouts stay: a broker locked out today is not re-armed today.
            this.persistState();
            Log.log(`[${this.userId}] Reset for re-arm (day's lockouts and day P&L kept)`);
            return;
        }
        // A latch object exists only once its broker was evaluated since the process started, so after a restart the
        // maps can be missing a broker whose lockout is still persisted. Create all of them so clear() reaches every one.
        for (const broker of PAIR_BROKERS) {
            this.stopFor(broker);
            this.profitStopFor(broker);
        }
        for (const stop of this.stops.values()) void stop.clear();
        for (const stop of this.profitStops.values()) void stop.clear();
        this.stops.clear();
        this.profitStops.clear();
        this.dayRealizedByBroker.clear();
        Mongo.getInstance()?.db.collection(STATE_COLLECTION).deleteOne({ userId: this.userId })
            .catch((e) => Log.log('[BulkPcrStrategy] reset: persisted-state clear failed:', e));
        Log.log(`[${this.userId}] Reset via admin request`);
    }
}
