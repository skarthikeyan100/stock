import Log from '../util/Log';
import moment from 'moment';
import * as fs from 'fs';
import * as path from 'path';
import { Strategy } from './strategy';
import { localDayKey } from './dayKey';
import { NiftyQuote, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import strategies from './strategies';
import BulkPcrStrategy from './BulkPcrStrategy';
import { normalizeBrokerList } from '../util/brokerName';

// Scheduled auto-arm wrapper: at each configured HH:mm time, arms a
// BulkPcrStrategy instance (its own config.yml block - quantity/brokers
// below) iff it isn't already mid-cycle, instead of requiring a human to
// notice it finished and flip `enabled: true` back on by hand. Does not
// place any orders itself - it only flips the target BulkPcrStrategy's
// config and enabled flag.
//
// Multi-instance (same shape as ButterflyStrategy's Butterfly-NIFTY/
// Butterfly-SENSEX config.yml entries): config.yml can list several
// `type: BulkPcrAutoStartStrategy` blocks under distinct `userId` values,
// each targeting its OWN BulkPcrStrategy instance via `targetUserId` - e.g.
// a `userId: BulkPcrAutoStart-NIFTY` instance with `targetUserId:
// BulkPcr-NIFTY` running alongside a `userId: BulkPcrAutoStart-SENSEX`
// instance with `targetUserId: BulkPcr-SENSEX`. `targetUserId` defaults to
// the plain 'BulkPcrStrategy' type name for a single, unnamed instance
// (today's existing single-instance setups keep working unchanged).
//
// Config (config.yml):
//   userId: BulkPcrAutoStart-SENSEX     - optional; defaults to this type's
//                                          own name for a single instance
//   targetUserId: BulkPcr-SENSEX        - optional; which BulkPcrStrategy
//                                          instance (its own `userId`) this
//                                          one arms. Defaults to
//                                          'BulkPcrStrategy'.
//   times: ['10:35', '11:35', '12:35']  - HH:mm slots, each attempted at most
//                                          once per day
//   quantity: 1340                      - written onto the target
//                                          BulkPcrStrategy's own config
//                                          block when armed; -1 means "size
//                                          from maxInvestment" (see
//                                          BulkPcrStrategy.ts's header comment)
//   targetPoints: 2                     - same
//   brokers: ['ant', 'prism']            - same
//
// Same "fire at most once per configured HH:mm slot per day" shape as
// GoodMorningStrategy's snapshot/confirm times, but with N slots instead of
// one snapshot+confirm pair, and "start another strategy" instead of
// "place a trade" as the action.
const LATE_WINDOW_MINUTES = 5;

export default class BulkPcrAutoStartStrategy extends Strategy {
    private tradingDay: string | null = null;
    private firedToday = new Set<string>();

    receive(oldStats: any, newStats: any) {}
    async processOptionQuote(quote: OptionQuote) {}
    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false;
    }

    reset(): void {
        super.reset();
        this.firedToday.clear();
    }

    private resetIfNewDay() {
        const today = localDayKey();
        if (this.tradingDay !== today) {
            this.tradingDay = today;
            this.firedToday.clear();
        }
    }

    // Not configService.getStrategyConfig(type) - that returns only the FIRST
    // config.yml entry of this type, regardless of userId. config.yml can
    // configure multiple instances of this strategy (one per index) under
    // distinct userId values (see this file's own header comment), and a
    // second instance's cfg() must read ITS OWN block, not silently inherit
    // whichever instance is listed first. Same (cfg.userId || type) ===
    // userId convention BulkPcrStrategy.cfg()/ButterflyStrategy.cfg() already
    // use for the identical type-vs-instance distinction.
    private cfg() {
        return configService.getConfig().strategies?.find(
            (s) => s.type === 'BulkPcrAutoStartStrategy' && (s.userId || s.type) === this.userId
        ) ?? { type: 'BulkPcrAutoStartStrategy', enabled: false };
    }

    // Which BulkPcrStrategy instance (its own config.yml `userId`) this
    // instance arms - defaults to the plain type name so a single, unnamed
    // BulkPcrAutoStartStrategy/BulkPcrStrategy pair (today's existing setup)
    // keeps working with no config change.
    private targetUserId(): string {
        return this.cfg().targetUserId ?? 'BulkPcrStrategy';
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        if (!this.enabled) return;

        const now = moment();
        this.resetIfNewDay();

        const times: string[] = Array.isArray(this.cfg().times) ? this.cfg().times : [];
        for (const timeStr of times) {
            if (this.firedToday.has(timeStr)) continue;

            const [h, m] = String(timeStr).split(':').map(Number);
            const slotTime = moment().hour(h).minute(m).second(0);
            if (now.isBefore(slotTime)) continue;

            this.firedToday.add(timeStr); // each configured slot fires at most once per day, whether it starts, skips, or is too late

            if (now.diff(slotTime, 'minutes') > LATE_WINDOW_MINUTES) {
                Log.log(`[BulkPcrAutoStart:${this.userId}] Missed ${timeStr} slot (now ${now.format('HH:mm:ss')}) - skipping`);
                continue;
            }

            await this.attemptStart(timeStr);
        }
    }

    // Slots already armed today, persisted so a process restart can't re-arm a slot that already ran
    // (live 2026-10-14: a restart at 11:39 re-armed the 11:35 slot and bought again).
    // Namespaced by this.userId - config.yml can configure multiple instances of this
    // strategy (one per index, see this file's own header comment), and they must not
    // share one armed-slots file: two instances using the same HH:mm slot (e.g. a NIFTY
    // and a SENSEX instance both on '10:35') would otherwise collide in a shared file and
    // each wrongly see the other's slot as "already attempted".
    private armedSlotsFile = path.join(__dirname, `../../.bulkpcr_armed_slots.${this.safeFileToken(this.userId)}.json`);

    private safeFileToken(s: string): string {
        return s.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    private loadArmedSlots(): Set<string> {
        try {
            return new Set(JSON.parse(fs.readFileSync(this.armedSlotsFile, 'utf8')) as string[]);
        } catch {
            return new Set<string>();
        }
    }

    // Returns false if the record could not be written. The caller must then not arm: arming without the
    // record would let a restart re-arm this slot.
    private recordArmedSlot(key: string): boolean {
        const today = localDayKey();
        const keep = [...this.loadArmedSlots()].filter((k) => k.startsWith(today));
        keep.push(key);
        try {
            fs.writeFileSync(this.armedSlotsFile, JSON.stringify(keep));
            return true;
        } catch (e: any) {
            Log.log(`[BulkPcrAutoStart:${this.userId}] ALERT: could not persist armed slot ${key} - NOT arming: ${e?.message ?? e}`);
            return false;
        }
    }

    private async attemptStart(timeStr: string): Promise<void> {
        const slotKey = `${localDayKey()} ${timeStr}`;
        if (this.loadArmedSlots().has(slotKey)) {
            Log.log(`[BulkPcrAutoStart:${this.userId}] ${timeStr} slot already attempted earlier today - skipping (process restart does not re-attempt it)`);
            return;
        }
        // Recorded on every attempt, including ones skipped below (still running, no target): a restart
        // inside the late window must not turn a skipped slot into a fresh arm.
        if (!this.recordArmedSlot(slotKey)) return;
        const targetUserId = this.targetUserId();
        const target = strategies.getByUserId(targetUserId) as BulkPcrStrategy | undefined;
        if (!target) {
            Log.log(`[BulkPcrAutoStart:${this.userId}] BulkPcrStrategy instance '${targetUserId}' not found - is it present (even if disabled) in config.yml?`);
            return;
        }

        if (target.isRunning()) {
            if (target.hasBrokerError()) {
                // isRunning() stays true indefinitely once any broker's
                // position lands in phase='error' (see hasBrokerError's
                // comment) - a one-time broker hiccup would otherwise
                // silently disable every future slot with no visible
                // signal, reading identically to normal "still in
                // progress" skips in orchestrator.log. Logged loudly here
                // on every slot until a human resolves it (same manual-
                // review bar BulkPcrStrategy's own error-phase logging
                // already requires) - this strategy does not auto-clear it.
                Log.log(`[BulkPcrAutoStart:${this.userId}] ${timeStr} slot: '${targetUserId}' STUCK in a broker error state - manual review and reset() required before any further slot can arm. Skipping.`);
            } else {
                Log.log(`[BulkPcrAutoStart:${this.userId}] ${timeStr} slot: '${targetUserId}' already running - skipping`);
            }
            return;
        }

        // Today's loss-stop latches must be loaded before the broker filter below: after a restart, reconcile() may not have run yet.
        await target.loadStopLatches();
        // keepStops: the re-arm must not clear today's loss stop or realized P&L (maxloss.md B3.7).
        target.reset({ keepStops: true }); // clear any stale phase='done'/positions left over from a previous cycle so it can re-enter cleanly

        const cfg = this.cfg();
        // Not configService.getStrategyConfig(type) - see this.cfg()'s own comment above for
        // why: config.yml can configure multiple BulkPcrStrategy instances under distinct
        // userId values, and this must mutate ONLY the one this instance targets.
        const bulkPcrCfg = configService.getConfig().strategies?.find(
            (s) => s.type === 'BulkPcrStrategy' && (s.userId || s.type) === targetUserId
        );
        if (!bulkPcrCfg) {
            Log.log(`[BulkPcrAutoStart:${this.userId}] ALERT: '${targetUserId}' config.yml entry not found even though strategies.getByUserId resolved an instance - not arming.`);
            return;
        }
        // A loss-stopped broker is not armed for today (maxloss.md B3.8). cfg itself is not mutated.
        const wanted: string[] = normalizeBrokerList(Array.isArray(cfg.brokers) ? cfg.brokers : [cfg.broker ?? 'kite']);
        const armable = wanted.filter((b) => !target.isBrokerStopped(String(b).toLowerCase()));
        if (armable.length === 0) {
            Log.log(`[BulkPcrAutoStart:${this.userId}] ${timeStr} slot: every configured broker is loss-stopped for today - skipping`);
            return;
        }
        // Refuse to arm on a missing/invalid size or target: copying undefined used to make BulkPcrStrategy silently default to its
        // built-in 13975 (about 215 lots). -1 is the deliberate "size from maxInvestment" value.
        const qty = Number(cfg.quantity);
        const tgt = Number(cfg.targetPoints);
        if (cfg.quantity == null || !Number.isFinite(qty) || !(qty > 0 || qty === -1) || cfg.targetPoints == null || !Number.isFinite(tgt) || !(tgt > 0)) {
            Log.log(`[BulkPcrAutoStart:${this.userId}] ALERT: ${timeStr} slot has invalid quantity (${cfg.quantity}) or targetPoints (${cfg.targetPoints}) - not arming '${targetUserId}'`);
            return;
        }
        bulkPcrCfg.quantity = cfg.quantity;
        bulkPcrCfg.targetPoints = cfg.targetPoints;
        bulkPcrCfg.brokers = [...armable]; // always the resolved list: a block using the legacy single `broker:` key has no `brokers` array
        // Unconditional, like every other field above - found on review: `if (cfg.index)` left a
        // previous slot's persisted `index: SENSEX` write in place for a later slot that omits
        // `index` (reverting to NIFTY), silently continuing to trade SENSEX under a NIFTY-intended
        // quantity/brokers config. Always write this slot's own value, defaulting to 'NIFTY'.
        bulkPcrCfg.index = cfg.index ?? 'NIFTY';
        bulkPcrCfg.enabled = true;
        configService.writeConfig(configService.getConfig());
        strategies.syncFromConfig();

        Log.log(`[BulkPcrAutoStart:${this.userId}] ${timeStr} slot: armed '${targetUserId}' (quantity=${cfg.quantity}, targetPoints=${cfg.targetPoints}, brokers=${JSON.stringify(cfg.brokers)}, index=${bulkPcrCfg.index})`);
    }
}
