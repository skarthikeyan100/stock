import Log from '../util/Log';
import { localDayKey } from './dayKey';
import { NiftyQuote, OptionQuote, SensexQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import Mongo from '../tools/mongo';
import { Strategy } from './strategy';
import SerialWriter from './SerialWriter';
import { watchTokenOnSource, unwatchTokenOnSource } from '../processes/strategies/tokenRouter';
import { sleep } from '../util/sleep';
import { normalizeBrokerName, normalizeBrokerList, normalizePersistedBrokers } from '../util/brokerName';

// Iron Butterfly (standard, net credit) / Reverse Iron Butterfly (net debit) 4-leg combo on
// NIFTY/SENSEX. Manual arm only (config.yml `enabled: true`, fires once on the next tick),
// multi-broker, tick-driven self-monitored exit on net combo premium vs targetPoints/
// stopLossPoints. See ToDo.md/the implementation plan this was built from for the full design
// rationale - most notably the never-short-guard exception (Kite.ts's placeShortEntryOption,
// the equivalent new per-broker functions, and bookkeeping.recordShortFill) that this strategy
// is the ONLY caller of: a butterfly intrinsically requires selling 2 of its 4 legs to open,
// which this codebase otherwise refuses everywhere else.

type BrokerName = 'kite' | 'breeze' | 'ant' | 'prism';
type Mode = 'standard' | 'reverse';
type LegRole = 'wingLower' | 'wingUpper' | 'centerCall' | 'centerPut';
const ALL_LEG_ROLES: LegRole[] = ['wingLower', 'wingUpper', 'centerCall', 'centerPut'];

interface Leg {
    role: LegRole;
    right: 'CE' | 'PE';          // wingLower/centerPut = PE, wingUpper/centerCall = CE
    side: 'BUY' | 'SELL';        // derived from mode, fixed once position opens
    strike: number;
    tsym: string | null;
    token: string | null;        // always the ANT-native token - see resolveOptionContract's
                                  // orderProcess.ts implementation for why, even for non-ant brokers
    exchange: 'NFO' | 'BFO' | null;
    quantity: number;            // target quantity for this leg (== cfg quantity)
    filledQty: number;           // confirmed filled quantity so far (entry side)
    entryAvg: number;            // average fill price, entry side
    closedQty: number;           // confirmed filled quantity on the closing side
    closeAvg: number;            // average fill price, closing side
    status: 'none' | 'entering' | 'open' | 'closing' | 'closed' | 'error';
}

interface BrokerButterflyPosition {
    broker: BrokerName;
    phase: 'buyingWings' | 'wingsOpen' | 'sellingCenter' | 'open' | 'closing' | 'error' | 'done';
    legs: Record<LegRole, Leg>;
    index: 'NIFTY' | 'SENSEX';
    mode: Mode;
    quantity: number;
    atmStrike: number;
    entryCycleStartedAt: number;   // epoch ms when buy legs were placed; reconcile uses this to judge
                                    // whether the confirmed-pair window is still open after a restart
    squaringOff?: boolean;         // in-memory only, not persisted (same convention as BulkPcrStrategy)
}

interface PersistedState {
    userId: string;
    positions: Partial<Record<BrokerName, BrokerButterflyPosition>>;
}

const STATE_COLLECTION = 'butterflyStrategyState';
// Max time allowed between buy-legs-confirmed and sell-legs-placed before a restart's reconcile()
// treats the window as "gone" and unwinds the buy legs instead of resuming the sell placement.
const ENTRY_WINDOW_MS = 2 * 60 * 1000;

export default class ButterflyStrategy extends Strategy {
    name = 'ButterflyStrategy';
    private phase: 'idle' | 'running' = 'idle';
    private positions = new Map<BrokerName, BrokerButterflyPosition>();
    private eodDone = false;
    private writer = new SerialWriter('ButterflyStrategy');
    // Day eodDone was set; a process left running overnight must clear it so the next day's legs are still force-closed.
    private eodDay = '';
    private latestLtp = new Map<string, number>(); // token -> last seen ltp, across all brokers/legs

    receive(_oldStats, _newStats) {}
    getMonitorConfig() { return null; } // self-monitored net-combo-points exit, not GTT/bracket

    // ---- config readers ----
    // Not configService.getStrategyConfig(type) - see BulkPcrStrategy.cfg()'s own comment:
    // config.yml can configure multiple ButterflyStrategy instances (Butterfly-NIFTY,
    // Butterfly-SENSEX) under distinct userId values, and each instance must read its OWN
    // block, not silently inherit whichever instance's block happens to be listed first.
    private cfg() {
        return configService.getConfig().strategies?.find(
            (s) => s.type === 'ButterflyStrategy' && (s.userId || s.type) === this.userId
        ) ?? { type: 'ButterflyStrategy', enabled: false };
    }
    private index(): 'NIFTY' | 'SENSEX' { return this.cfg().index === 'SENSEX' ? 'SENSEX' : 'NIFTY'; }
    private mode(): Mode { return this.cfg().mode === 'reverse' ? 'reverse' : 'standard'; }
    private wingStrikes(): number { return Math.max(1, Number(this.cfg().wingStrikes ?? 2)); }
    private quantity(): number { return Number(this.cfg().quantity ?? 65); }
    private targetPoints(): number { return Number(this.cfg().targetPoints ?? 10); }
    private stopLossPoints(): number { return Number(this.cfg().stopLossPoints ?? 15); }
    private strikeStep(): number { return this.index() === 'SENSEX' ? 100 : 50; }
    // Only kite/ant are verified for this strategy's broker path today. breeze/prism are
    // explicitly rejected here rather than silently run - found on review: this strategy
    // always resolves tick-subscription tokens as ANT-native (resolveOptionContractForBroker),
    // but strategiesProcess.onFill's automatic registerTrade/unregisterTrade on every Buy/Sell
    // fill derives its feed from BROKER_TO_FEED_SOURCE[trade.broker], which is 'breeze'/'prism'
    // for those brokers - treating this strategy's ANT-native token as a breeze/prism-native
    // one for that side-channel subscription. For kite/ant, BROKER_TO_FEED_SOURCE maps both
    // to 'ant' too, so there is no mismatch. Separately, prismExecutor.buyContract/sellContract
    // (used by the butterflyBuyLeg/butterflyCloseLeg prism branches) resolve their OWN
    // Prism-native token internally, discarding the ANT-native token this strategy tracks -
    // breaking the same invariant for prism specifically. Mirrors BulkPcrStrategy/
    // HourlyStrategy's own explicit broker/exchange rejections elsewhere in this codebase.
    private static readonly VERIFIED_BROKERS: BrokerName[] = ['kite', 'ant'];
    private configuredBrokers(): BrokerName[] {
        const cfg = this.cfg();
        const list: string[] = normalizeBrokerList(Array.isArray(cfg.brokers) && cfg.brokers.length > 0 ? cfg.brokers : [cfg.broker ?? 'kite']);
        const requested = Array.from(new Set(list.map((b: string) => String(b).toLowerCase()))) as BrokerName[];
        const unverified = requested.filter((b) => !ButterflyStrategy.VERIFIED_BROKERS.includes(b));
        if (unverified.length > 0) {
            Log.log(`[ButterflyStrategy:${this.userId}] ALERT: config lists unverified broker(s) [${unverified.join(',')}] - refusing to run them (only kite/ant are verified for this strategy's tick-subscription/token path; see configuredBrokers' own comment). Running only: ${requested.filter((b) => ButterflyStrategy.VERIFIED_BROKERS.includes(b)).join(',') || 'none'}`);
        }
        return requested.filter((b) => ButterflyStrategy.VERIFIED_BROKERS.includes(b));
    }

    // ---- entry ----
    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        await this.eodCheck();
        if (this.index() !== 'NIFTY') return;
        await this.processUnderlyingQuote(quote);
    }
    async processSensexQuote(quote: SensexQuote): Promise<void> {
        await this.eodCheck();
        if (this.index() !== 'SENSEX') return;
        await this.processUnderlyingQuote(quote as unknown as NiftyQuote);
    }

    private async processUnderlyingQuote(quote: NiftyQuote): Promise<void> {
        if (!this.enabled) return;
        if (this.phase !== 'idle') return;          // one-shot arm per cycle
        if (!this.isTimeInRange()) return;
        if (!(quote.ltp > 0)) return;

        // Synchronous flip BEFORE any await - blocks a concurrent tick from double-entering
        // (identical to BulkPcrStrategy's phase='running' pre-await pattern).
        this.phase = 'running';

        const atmStrike = Math.round(quote.ltp / this.strikeStep()) * this.strikeStep();
        const brokers = this.configuredBrokers();
        Log.log(`[ButterflyStrategy:${this.userId}] Arming ${this.mode()} butterfly on ${this.index()} ATM=${atmStrike} brokers=${brokers.join(',')}`);

        await Promise.allSettled(brokers.map((b) => this.enterOnBroker(b, atmStrike, this.index())));
        // this.phase is intentionally left 'running' here - it only goes back to 'idle' via
        // afterPositionDone() once every broker position for this cycle reaches done/removed.
    }

    private emptyLeg(role: LegRole, right: 'CE' | 'PE', side: 'BUY' | 'SELL', strike: number, quantity: number): Leg {
        return { role, right, side, strike, tsym: null, token: null, exchange: null, quantity, filledQty: 0, entryAvg: 0, closedQty: 0, closeAvg: 0, status: 'none' };
    }

    private async enterOnBroker(broker: BrokerName, atmStrike: number, index: 'NIFTY' | 'SENSEX'): Promise<void> {
        const mode = this.mode();
        const qty = this.quantity();
        const wingOffset = this.wingStrikes() * this.strikeStep();

        const pos: BrokerButterflyPosition = {
            broker, phase: 'buyingWings', index, mode, quantity: qty, atmStrike,
            entryCycleStartedAt: Date.now(),
            legs: {
                wingLower: this.emptyLeg('wingLower', 'PE', mode === 'standard' ? 'BUY' : 'SELL', atmStrike - wingOffset, qty),
                wingUpper: this.emptyLeg('wingUpper', 'CE', mode === 'standard' ? 'BUY' : 'SELL', atmStrike + wingOffset, qty),
                centerCall: this.emptyLeg('centerCall', 'CE', mode === 'standard' ? 'SELL' : 'BUY', atmStrike, qty),
                centerPut: this.emptyLeg('centerPut', 'PE', mode === 'standard' ? 'SELL' : 'BUY', atmStrike, qty),
            },
        };
        this.positions.set(broker, pos);
        this.persistState();

        try {
            await this.resolveLegContracts(pos);
        } catch (e) {
            Log.log(`[ButterflyStrategy:${this.userId}] [${broker}] contract resolution failed - not placing anything:`, e);
            pos.phase = 'error';
            this.persistState();
            return;
        }

        const buyOk = await this.placeBuyLegs(pos);
        if (!buyOk) return; // placeBuyLegs already unwound + marked error

        pos.phase = 'wingsOpen';
        this.persistState();
        for (const role of this.buyRoles(pos)) {
            const leg = pos.legs[role];
            watchTokenOnSource('ant', leg.token!, this, leg.exchange!);
        }

        pos.phase = 'sellingCenter';
        this.persistState();
        const sellOk = await this.placeSellLegs(pos);
        if (!sellOk) return; // placeSellLegs already unwound the sells that did fill + marked error

        pos.phase = 'open';
        this.persistState();
        for (const role of this.sellRoles(pos)) {
            const leg = pos.legs[role];
            watchTokenOnSource('ant', leg.token!, this, leg.exchange!);
        }
        Log.log(`[ButterflyStrategy:${this.userId}] [${broker}] all 4 legs open, net ${mode === 'standard' ? 'credit' : 'debit'} entry complete`);
        // The EOD pass only closes positions that are 'open' when it runs; one that finished opening after it did
        // would otherwise be carried past the close.
        if (this.eodDone && !pos.squaringOff) {
            pos.squaringOff = true;
            await this.squareOffAll(pos, 'entry completed after the EOD cutoff');
        }
    }

    // Resolves tsym/token/exchange for all 4 legs via the read-only resolveOptionContract IPC
    // call (see orderProcess.ts's resolveOptionContractForBroker), which dispatches per-broker
    // server-side to each broker's own contract master - leg.token always comes back ANT-native
    // regardless of broker (see that function's own comment on why).
    private async resolveLegContracts(pos: BrokerButterflyPosition): Promise<void> {
        for (const role of ALL_LEG_ROLES) {
            const leg = pos.legs[role];
            const { tsym, token, exchange } = await OrderClient.getInstance().resolveOptionContract(
                this.userId, { broker: pos.broker, index: pos.index, strike: leg.strike, right: leg.right }
            );
            leg.tsym = tsym;
            leg.token = token;
            leg.exchange = exchange;
        }
    }

    private buyRoles(pos: BrokerButterflyPosition): LegRole[] { return ALL_LEG_ROLES.filter((r) => pos.legs[r].side === 'BUY'); }
    private sellRoles(pos: BrokerButterflyPosition): LegRole[] { return ALL_LEG_ROLES.filter((r) => pos.legs[r].side === 'SELL'); }

    // Places the 2 BUY legs in parallel. Only proceeds past this point if BOTH confirm filled.
    private async placeBuyLegs(pos: BrokerButterflyPosition): Promise<boolean> {
        const roles = this.buyRoles(pos); // exactly 2 roles, regardless of mode
        const results = await Promise.allSettled(roles.map((role) => this.placeOneBuyLeg(pos, role)));

        const failedRoles = roles.filter((_role, i) => results[i].status === 'rejected');
        if (failedRoles.length === 0) return true;

        for (let i = 0; i < roles.length; i++) {
            if (results[i].status === 'rejected') Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] buy leg ${roles[i]} failed:`, (results[i] as PromiseRejectedResult).reason);
        }
        Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] buy leg(s) failed: ${failedRoles.join(',')} - unwinding any filled buy leg(s)`);
        await this.unwindPartialEntry(pos, `buy leg(s) failed: ${failedRoles.join(',')}`);
        return false;
    }

    private async placeOneBuyLeg(pos: BrokerButterflyPosition, role: LegRole): Promise<void> {
        const leg = pos.legs[role];
        leg.status = 'entering';
        let trade;
        try {
            trade = await OrderClient.getInstance().butterflyBuyLeg(this.userId, {
                broker: pos.broker, tradingSymbol: leg.tsym!, instrumentToken: leg.token!, quantity: leg.quantity, exchange: leg.exchange!,
            });
        } catch (e) {
            leg.status = 'error'; // outcome unknown: never left looking like a live 'entering' order
            throw e;
        }
        leg.filledQty = trade.quantity;
        leg.entryAvg = trade.price;
        leg.status = 'open';
    }

    // Only after BOTH buys confirmed filled: places the 2 SELL legs in parallel. If one fails,
    // buys back whatever sell DID fill (restoring zero net exposure), leaves the 2 buy-leg wings
    // open flagged for manual review - never auto-unwinds the wings here.
    private async placeSellLegs(pos: BrokerButterflyPosition): Promise<boolean> {
        const roles = this.sellRoles(pos); // exactly 2 roles
        const results = await Promise.allSettled(roles.map((role) => this.placeOneSellLeg(pos, role)));

        const filledRoles = roles.filter((_role, i) => results[i].status === 'fulfilled');
        const failedRoles = roles.filter((_role, i) => results[i].status === 'rejected');
        if (failedRoles.length === 0) return true;

        for (let i = 0; i < roles.length; i++) {
            if (results[i].status === 'rejected') Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] sell leg ${roles[i]} failed:`, (results[i] as PromiseRejectedResult).reason);
        }
        Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] sell leg(s) failed: ${failedRoles.join(',')} - buying back filled sell leg(s), flagging error`);
        await Promise.allSettled(filledRoles.map((role) => this.closeOneLeg(pos, role, 'buyToCloseShort')));
        pos.phase = 'error';
        this.persistState();
        return false;
    }

    private async placeOneSellLeg(pos: BrokerButterflyPosition, role: LegRole): Promise<void> {
        const leg = pos.legs[role];
        leg.status = 'entering';
        // The ONLY call site in the whole codebase allowed to open a short position - see
        // Kite.ts's NEVER-SHORT GUARD comment and bookkeeping.recordShortFill.
        let trade;
        try {
            trade = await OrderClient.getInstance().butterflySellToOpen(this.userId, {
                broker: pos.broker, tradingSymbol: leg.tsym!, instrumentToken: leg.token!, quantity: leg.quantity, exchange: leg.exchange!,
            });
        } catch (e) {
            leg.status = 'error';
            throw e;
        }
        leg.filledQty = trade.quantity;
        leg.entryAvg = trade.price;
        leg.status = 'open';
    }

    // reconcile()-only variant of placeSellLegs: cross-checks each sell-role leg's LIVE
    // quantity at the broker first (same discipline reconcileResubscribeOpenLegs/
    // reconcileCloseWhateverIsOpen already use), since a restart can land after a sell
    // order actually filled at the broker but before that fill was ever persisted. A leg
    // already live-short is adopted as-is (filledQty from the broker, entryAvg estimated
    // from the current LTP since the true fill price was never recorded - flagged loudly,
    // since netComboPoints' accuracy for that leg depends on it) rather than sold again;
    // only a leg genuinely not yet open gets a fresh sell-to-open placed.
    private async resumeOrPlaceSellLegs(pos: BrokerButterflyPosition): Promise<boolean> {
        const roles = this.sellRoles(pos);
        const toPlace: LegRole[] = [];
        let adoptedWithoutPrice = false;
        for (const role of roles) {
            const leg = pos.legs[role];
            const liveQty = await this.getLiveQuantity(pos, leg);
            if (liveQty === null) throw new Error(`live quantity of ${leg.tsym} unknown - cannot decide between adopting and re-selling`); // retried by reconcile(); never re-sell blind
            if (liveQty > 0) {
                const ltp = this.latestLtp.get(leg.token!);
                Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] reconcile: ${leg.tsym} (${role}) is already short ${liveQty} at the broker - adopting instead of re-selling. ALERT: true entry price was never persisted, estimating from current ltp=${ltp ?? 'unknown'} - netComboPoints for this leg may be inaccurate until it closes.`);
                leg.filledQty = liveQty;
                leg.entryAvg = ltp ?? 0;
                leg.status = 'open';
                // entryAvg 0 on a short leg reads as an enormous loss (entry - ltp) and would stop the whole combo
                // out on its first tick. Without a price to estimate from, do not self-monitor: flag for review.
                if (ltp == null) adoptedWithoutPrice = true;
            } else {
                toPlace.push(role);
            }
        }
        if (adoptedWithoutPrice) {
            Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] ALERT: adopted a short leg with no price to estimate its entry from - not self-monitoring this combo, manual review required`);
            return false;
        }
        if (toPlace.length === 0) return true;

        const results = await Promise.allSettled(toPlace.map((role) => this.placeOneSellLeg(pos, role)));
        const filledRoles = toPlace.filter((_role, i) => results[i].status === 'fulfilled');
        const failedRoles = toPlace.filter((_role, i) => results[i].status === 'rejected');
        if (failedRoles.length === 0) return true;

        for (let i = 0; i < toPlace.length; i++) {
            if (results[i].status === 'rejected') Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] reconcile: sell leg ${toPlace[i]} failed:`, (results[i] as PromiseRejectedResult).reason);
        }
        Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] reconcile: sell leg(s) failed: ${failedRoles.join(',')} - buying back filled sell leg(s), flagging error`);
        await Promise.allSettled([...filledRoles, ...roles.filter((r) => !toPlace.includes(r))].map((role) => this.closeOneLeg(pos, role, 'buyToCloseShort')));
        pos.phase = 'error';
        this.persistState();
        return false;
    }

    // A leg whose entry order threw (timeout / transport error) is parked as 'error' with filledQty 0, but the order
    // may well have filled. Ask the broker: if the leg is live, adopt it as 'open' (entry price estimated from the last
    // tick) so every close path below treats it as a real position instead of leaving it live and unmanaged.
    private async adoptUnknownOutcomeLegs(pos: BrokerButterflyPosition): Promise<void> {
        for (const role of ALL_LEG_ROLES) {
            const leg = pos.legs[role];
            if (leg.status !== 'error' || leg.filledQty > 0 || !leg.tsym) continue;
            const liveQty = await this.getLiveQuantity(pos, leg);
            if (liveQty === null) {
                Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] ALERT: live quantity of ${leg.tsym} (${role}) unknown after a failed entry - may be live, manual review required`);
                continue;
            }
            if (liveQty > 0) {
                Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] ALERT: ${leg.tsym} (${role}) entry errored but the broker shows ${liveQty} live - adopting it so it gets closed`);
                leg.filledQty = liveQty;
                leg.entryAvg = this.latestLtp.get(leg.token!) ?? 0;
                leg.status = 'open';
            } else {
                leg.status = 'closed'; // confirmed flat: the order never filled
            }
        }
    }

    private async unwindPartialEntry(pos: BrokerButterflyPosition, reason: string): Promise<void> {
        await this.adoptUnknownOutcomeLegs(pos);
        // Shorts first (buying them back only reduces risk), then the long legs.
        const openShorts = ALL_LEG_ROLES.filter((r) => pos.legs[r].side === 'SELL' && pos.legs[r].status === 'open' && pos.legs[r].filledQty > 0);
        await Promise.allSettled(openShorts.map((role) => this.closeOneLeg(pos, role, 'buyToCloseShort')));
        const filledBuyRoles = this.buyRoles(pos).filter((r) => pos.legs[r].status === 'open' && pos.legs[r].filledQty > 0);
        if (ALL_LEG_ROLES.some((r) => pos.legs[r].side === 'SELL' && pos.legs[r].status !== 'closed' && pos.legs[r].filledQty > 0)) {
            Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] ALERT: a short leg did not close - keeping the long legs as cover`);
        } else {
            await Promise.allSettled(filledBuyRoles.map((role) => this.closeOneLeg(pos, role, 'sellToCloseLong')));
        }
        pos.phase = 'error';
        this.persistState();
        Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] marked error (manual review): ${reason}`);
    }

    // closeKind distinguishes the two legitimate ways a leg closes - 'sellToCloseLong' reduces a
    // real long via butterflyCloseLeg (recordFill, normal), 'buyToCloseShort' reduces a real
    // short THIS strategy itself opened moments earlier via butterflyBuyToClose
    // (recordShortFill) - never used to increase exposure. Requests only the REMAINING unclosed
    // quantity each call, so a retried/resumed close (e.g. from reconcile()) never double-closes.
    private async closeOneLeg(pos: BrokerButterflyPosition, role: LegRole, closeKind: 'sellToCloseLong' | 'buyToCloseShort'): Promise<void> {
        const leg = pos.legs[role];
        const remaining = leg.filledQty - leg.closedQty;
        if (remaining <= 0) { leg.status = 'closed'; return; }
        leg.status = 'closing';
        const trade = closeKind === 'sellToCloseLong'
            ? await OrderClient.getInstance().butterflyCloseLeg(this.userId, { broker: pos.broker, tradingSymbol: leg.tsym!, instrumentToken: leg.token!, quantity: remaining, exchange: leg.exchange! })
            : await OrderClient.getInstance().butterflyBuyToClose(this.userId, { broker: pos.broker, tradingSymbol: leg.tsym!, instrumentToken: leg.token!, quantity: remaining, exchange: leg.exchange! });
        leg.closedQty += trade.quantity;
        leg.closeAvg = trade.price;
        if (leg.closedQty >= leg.filledQty) {
            leg.status = 'closed';
            unwatchTokenOnSource('ant', leg.token!, this, leg.exchange!);
        }
    }

    // ---- exit ----
    canHandleOptionQuote(quote: OptionQuote): boolean {
        for (const pos of this.positions.values()) {
            for (const role of ALL_LEG_ROLES) {
                const leg = pos.legs[role];
                if (leg?.token === quote.token && (leg.status === 'open' || leg.status === 'closing')) return true;
            }
        }
        return false;
    }

    async processOptionQuote(quote: OptionQuote): Promise<void> {
        if (Number.isFinite(quote.ltp) && quote.ltp > 0) this.latestLtp.set(quote.token, quote.ltp);
        for (const pos of this.positions.values()) {
            if (pos.phase !== 'open' || pos.squaringOff) continue;
            const usesThisToken = ALL_LEG_ROLES.some((r) => pos.legs[r].token === quote.token);
            if (!usesThisToken) continue;

            const netPoints = this.netComboPoints(pos);
            if (netPoints == null) continue; // not every leg has a fresh ltp yet - never decide on stale/missing data

            const target = this.targetPoints();
            const stop = this.stopLossPoints();
            if (netPoints >= target) {
                pos.squaringOff = true; // synchronous flip pre-await, same anti-double-fire pattern as entry
                await this.squareOffAll(pos, `target hit: net=${netPoints.toFixed(2)} >= ${target}`);
            } else if (netPoints <= -stop) {
                pos.squaringOff = true;
                await this.squareOffAll(pos, `stop hit: net=${netPoints.toFixed(2)} <= -${stop}`);
            }
        }
    }

    // Net combo points per spec: BUY leg contributes qty*(ltp-entry); SELL leg contributes
    // qty*(entry-ltp); sum over all 4 legs, divide by `quantity` (all 4 legs share the same
    // qty). Returns null if any currently-open leg is missing a live ltp (never compute against
    // stale/zero).
    private netComboPoints(pos: BrokerButterflyPosition): number | null {
        let total = 0;
        for (const role of ALL_LEG_ROLES) {
            const leg = pos.legs[role];
            if (leg.status !== 'open') continue;
            const ltp = this.latestLtp.get(leg.token!);
            if (ltp == null) return null;
            total += leg.side === 'BUY' ? leg.filledQty * (ltp - leg.entryAvg) : leg.filledQty * (leg.entryAvg - ltp);
        }
        return total / pos.quantity;
    }

    private async squareOffAll(pos: BrokerButterflyPosition, reason: string): Promise<void> {
        Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] squaring off all legs - ${reason}`);
        pos.phase = 'closing';
        this.persistState();
        await this.adoptUnknownOutcomeLegs(pos);
        const roles = ALL_LEG_ROLES.filter((r) => pos.legs[r].status === 'open');
        // Shorts first, then longs. Parallel closing would let a protective long leg (a wing in a standard
        // butterfly) be sold while the short it covers is still open, and the broker rejects that as a naked
        // short for margin. Buying the shorts back first only ever reduces risk; each group is parallel inside.
        const closeGroup = (group: LegRole[]) => Promise.allSettled(group.map((role) => {
            const closeKind = pos.legs[role].side === 'BUY' ? 'sellToCloseLong' : 'buyToCloseShort';
            return this.closeOneLeg(pos, role, closeKind).catch((e) => {
                Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] close failed for ${role}:`, e);
                pos.legs[role].status = 'error';
            });
        }));
        await closeGroup(roles.filter((r) => pos.legs[r].side === 'SELL'));
        // A short that failed to close keeps its long cover: only close the longs if every short is closed.
        const shortsStillOpen = ALL_LEG_ROLES.some((r) => pos.legs[r].side === 'SELL' && pos.legs[r].status !== 'closed' && pos.legs[r].filledQty > 0);
        if (shortsStillOpen) {
            Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] ALERT: a short leg did not close - keeping the long legs as cover, manual review required`);
        } else {
            await closeGroup(roles.filter((r) => pos.legs[r].side === 'BUY'));
        }
        const allClosed = ALL_LEG_ROLES.every((r) => pos.legs[r].status === 'closed');
        pos.phase = allClosed ? 'done' : 'error';
        pos.squaringOff = false;
        this.persistState();
        if (allClosed) this.afterPositionDone(pos.broker);
    }

    // ---- EOD force-close + recurring reset ----
    private async eodCheck(): Promise<void> {
        const dayKey = localDayKey();
        if (this.eodDone && this.eodDay !== dayKey) this.eodDone = false;
        if (this.eodDone) return;
        const now = new Date();
        const pastEodCutoff = now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 15);
        if (!pastEodCutoff) return;
        this.eodDone = true;
        this.eodDay = dayKey;
        for (const pos of this.positions.values()) {
            if (pos.phase === 'open' && !pos.squaringOff) {
                pos.squaringOff = true; // blocks a concurrent target/stop tick from also closing this combo
                await this.squareOffAll(pos, 'EOD cutoff 15:15 reached');
            } else if (pos.phase === 'wingsOpen' || pos.phase === 'sellingCenter' || pos.phase === 'buyingWings') {
                Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] EOD: entry still in flight (${pos.phase}) - it will be closed as soon as it finishes opening`);
            }
        }
    }

    private afterPositionDone(broker: BrokerName): void {
        this.positions.delete(broker);
        this.persistState();
        // Once EVERY configured broker for this cycle is done/removed, re-idle so the next arm
        // can fire - recurring, not durably disabled (see the design rationale comment at top).
        if (this.positions.size === 0) {
            this.phase = 'idle';
            this.eodDone = false; // only relevant if re-armed same day before 15:15
            Log.log(`[ButterflyStrategy:${this.userId}] cycle complete on every broker - re-armed, ready for next entry`);
        }
    }

    // ---- persistence / restart safety ----
    private persistState(): void {
        const positions: Partial<Record<BrokerName, BrokerButterflyPosition>> = {};
        for (const [broker, pos] of this.positions) {
            const { squaringOff: _inFlight, ...durable } = pos;
            positions[broker] = durable as BrokerButterflyPosition;
        }
        const doc = { userId: this.userId, positions };
        this.writer.enqueue(() => Mongo.getInstance()?.db.collection(STATE_COLLECTION)
            .replaceOne({ userId: this.userId }, doc, { upsert: true }));
    }

    private async loadState(): Promise<PersistedState | null> {
        try {
            const doc = await Mongo.getInstance()?.db.collection(STATE_COLLECTION).findOne({ userId: this.userId });
            return doc ? normalizePersistedBrokers(doc as any) : null;
        } catch (e) {
            Log.log(`[ButterflyStrategy:${this.userId}] loadState failed:`, e);
            return null;
        }
    }

    // Called automatically once at `strategies` process startup, generically, for every
    // strategy that defines this method (see strategiesProcess.ts's reconcile loop) - no
    // explicit per-strategy call-site wiring needed.
    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        const saved = await this.loadState();
        if (!saved?.positions) { this.phase = 'idle'; return; }

        for (const [broker, pos] of Object.entries(saved.positions) as [BrokerName, BrokerButterflyPosition][]) {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    await this.reconcileOneBroker(broker, pos);
                    break;
                } catch (e) {
                    Log.log(`[ButterflyStrategy:${this.userId}] [${broker}] reconcile attempt ${attempt}/${maxAttempts} failed:`, e);
                    if (attempt === maxAttempts) {
                        pos.phase = 'error';
                        this.positions.set(broker, pos);
                        this.persistState();
                    } else {
                        await sleep(retryDelayMs);
                    }
                }
            }
        }
        this.phase = this.positions.size === 0 ? 'idle' : 'running';
    }

    // Read-only live net quantity for one leg, dispatched per broker - never reuses
    // getSellableQuantity (guard-bearing logic for a different decision). Returns the
    // absolute magnitude: callers only ever need "is something live open here", never sign
    // (a leg's own `side` already tells us whether an open position there should be long or
    // short).
    private async getLiveQuantity(pos: BrokerButterflyPosition, leg: Leg): Promise<number | null> {
        if (!leg.tsym) return 0;
        try {
            if (pos.broker === 'kite') {
                const Kite = (await import('../kite/Kite')).default;
                return Math.abs(await Kite.getInstance().getLiveNetQuantity(leg.tsym));
            }
            if (pos.broker === 'ant') {
                const antExecutor = await import('../processes/order/antExecutor');
                return Math.abs(await antExecutor.getLiveNetQuantity(leg.tsym));
            }
            if (pos.broker === 'breeze') {
                const breezeExecutor = await import('../processes/order/breezeExecutor');
                return Math.abs(await breezeExecutor.getLiveNetQuantity(leg.tsym));
            }
            if (pos.broker === 'prism') {
                const prismExecutor = await import('../processes/order/prismExecutor');
                const positions = await prismExecutor.getPositionsOnPrism();
                const p = positions.find((x) => x.tradingSymbol === leg.tsym);
                return Math.abs(p?.quantity ?? 0);
            }
        } catch (e) {
            // null = unknown, NOT zero: callers must never read a failed query as "flat" (that would mark a live
            // leg closed, or re-sell a leg that is already short).
            Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] getLiveQuantity failed for ${leg.tsym} - unknown:`, e);
            return null;
        }
        return null; // broker not handled above
    }

    private async reconcileCloseWhateverIsOpen(pos: BrokerButterflyPosition): Promise<void> {
        await this.adoptUnknownOutcomeLegs(pos);
        for (const role of ALL_LEG_ROLES) {
            const leg = pos.legs[role];
            if (leg.status !== 'open' && leg.status !== 'entering') continue;
            const liveQty = await this.getLiveQuantity(pos, leg);
            if (liveQty === null) {
                Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] reconcile: live quantity of ${leg.tsym} (${role}) unknown - NOT assuming flat, flagging for manual review`);
                leg.status = 'error';
                continue;
            }
            if (liveQty <= 0) { leg.status = 'closed'; continue; }
            // Treat the live quantity as the confirmed filled amount (we never actually learned
            // this from a trade event before the restart) so closeOneLeg's remaining-qty math
            // works, then close it via the normal path for its side.
            leg.filledQty = liveQty;
            const closeKind = leg.side === 'BUY' ? 'sellToCloseLong' : 'buyToCloseShort';
            await this.closeOneLeg(pos, role, closeKind).catch((e) => {
                Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] reconcile: close failed for ${role} (manual review required):`, e);
                leg.status = 'error';
            });
        }
    }

    private async reconcileResubscribeOpenLegs(pos: BrokerButterflyPosition): Promise<void> {
        for (const role of ALL_LEG_ROLES) {
            const leg = pos.legs[role];
            if (leg.status !== 'open') continue;
            const liveQty = await this.getLiveQuantity(pos, leg);
            if (liveQty === null) {
                // Unknown: keep it open and ticking rather than dropping a possibly live leg out of monitoring.
                watchTokenOnSource('ant', leg.token!, this, leg.exchange!);
                continue;
            }
            if (liveQty <= 0) {
                Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] reconcile: ${leg.tsym} (${role}) no longer open at the broker - assuming already closed`);
                leg.status = 'closed';
                continue;
            }
            watchTokenOnSource('ant', leg.token!, this, leg.exchange!);
        }
    }

    private async reconcileOneBroker(broker: BrokerName, pos: BrokerButterflyPosition): Promise<void> {
        // Never trust persisted leg status blindly - cross-check each leg's live open status at
        // the broker before deciding (same discipline BulkPcrStrategy/HourlyStrategy's reconcile
        // already use).
        switch (pos.phase) {
            case 'buyingWings':
                // Restart before any buy confirmed - treat as a failed entry: close whatever is
                // live-open, mark error.
                await this.reconcileCloseWhateverIsOpen(pos);
                pos.phase = 'error';
                break;
            case 'wingsOpen':
            case 'sellingCenter': {
                // Restart mid-entry: buys confirmed, sells not yet CONFIRMED placed - but a sell
                // order can genuinely have filled at the broker before the crash, with
                // leg.filledQty/entryAvg/pos.phase='open' never having been persisted (that
                // update happens only after placeSellLegs resolves). Found on review: blindly
                // re-calling placeSellLegs here (the original approach) would place a SECOND
                // sell-to-open for a leg already short at the broker, doubling that leg's short
                // exposure. Cross-check each sell-role leg's live quantity first; only place a
                // fresh sell for a leg that's genuinely NOT yet open at the broker.
                const withinWindow = Date.now() - pos.entryCycleStartedAt < ENTRY_WINDOW_MS;
                if (withinWindow) {
                    const sellOk = await this.resumeOrPlaceSellLegs(pos);
                    pos.phase = sellOk ? 'open' : 'error';
                    if (sellOk) {
                        // All four legs: the net-combo exit needs a live price for the wings too (a restart in this
                        // phase never ran the wings' own watch).
                        for (const role of ALL_LEG_ROLES) watchTokenOnSource('ant', pos.legs[role].token!, this, pos.legs[role].exchange!);
                    }
                } else {
                    // Live-checked close of every leg (including ones persisted as 'entering', whose fill was never
                    // recorded) rather than unwinding only legs recorded as filled.
                    await this.reconcileCloseWhateverIsOpen(pos);
                    pos.phase = 'error';
                    this.persistState();
                    Log.log(`[ButterflyStrategy:${this.userId}] [${pos.broker}] marked error (manual review): restart recovered mid-entry past the confirmed-pair window - closed whatever was live`);
                }
                break;
            }
            case 'open':
                // Re-subscribe ticks for every leg still open at the broker, resume self-monitoring.
                await this.reconcileResubscribeOpenLegs(pos);
                pos.phase = 'open';
                this.positions.set(broker, pos);
                break;
            case 'closing':
                // Restart mid-exit: check each of the 4 legs independently, resume closing only
                // what's still open - closeOneLeg's remaining-qty guard makes an already-closed
                // leg a no-op.
                await this.squareOffAll(pos, 'resuming interrupted square-off after restart');
                return; // squareOffAll already updates phase/persists/removes-when-done
            case 'done':
                this.positions.delete(broker);
                this.persistState();
                return;
            case 'error':
                break; // stays 'error' until a human clears it - never auto-retried blind
        }
        // 'done'/'closing' cases above already returned, so every path reaching here still
        // needs tracking (even 'error' - stays visible for manual review).
        this.positions.set(broker, pos);
    }

    updateTrade = async (trade: Trade): Promise<void> => {
        Log.log(`[ButterflyStrategy:${this.userId}] unexpected updateTrade callback:`, trade);
    };
    onOrderCancelled = async (_notification: any): Promise<void> => {}; // no resting orders in this strategy

    reset(): void {
        super.reset();
        this.phase = 'idle';
        this.positions.clear();
        this.eodDone = false;
    }
    isRunning(): boolean { return this.phase === 'running' || [...this.positions.values()].some((p) => p.phase !== 'done'); }
}
