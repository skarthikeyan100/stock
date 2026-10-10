import Log from '../util/Log';
import moment from 'moment';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import strategies from './strategies';
import BulkPcrStrategy from './BulkPcrStrategy';

// Scheduled auto-arm wrapper: at each configured HH:mm time, arms
// BulkPcrStrategy (its own config.yml block - quantity/brokers below) iff
// it isn't already mid-cycle, instead of requiring a human to notice it
// finished and flip `enabled: true` back on by hand. Does not place any
// orders itself - it only flips BulkPcrStrategy's config and enabled flag.
//
// Config (config.yml):
//   times: ['10:35', '11:35', '12:35']  - HH:mm slots, each attempted at most
//                                          once per day
//   quantity: 1340                      - written onto BulkPcrStrategy's own
//                                          config block when armed
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

    private resetIfNewDay(now: moment.Moment) {
        const today = now.format('YYYY-MM-DD');
        if (this.tradingDay !== today) {
            this.tradingDay = today;
            this.firedToday.clear();
        }
    }

    private cfg() {
        return configService.getStrategyConfig('BulkPcrAutoStartStrategy');
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        if (!this.enabled) return;

        const now = moment();
        this.resetIfNewDay(now);

        const times: string[] = Array.isArray(this.cfg().times) ? this.cfg().times : [];
        for (const timeStr of times) {
            if (this.firedToday.has(timeStr)) continue;

            const [h, m] = String(timeStr).split(':').map(Number);
            const slotTime = moment().hour(h).minute(m).second(0);
            if (now.isBefore(slotTime)) continue;

            this.firedToday.add(timeStr); // each configured slot fires at most once per day, whether it starts, skips, or is too late

            if (now.diff(slotTime, 'minutes') > LATE_WINDOW_MINUTES) {
                Log.log(`[BulkPcrAutoStart] Missed ${timeStr} slot (now ${now.format('HH:mm:ss')}) - skipping`);
                continue;
            }

            await this.attemptStart(timeStr);
        }
    }

    private async attemptStart(timeStr: string): Promise<void> {
        const target = strategies.getByUserId('BulkPcrStrategy') as BulkPcrStrategy | undefined;
        if (!target) {
            Log.log('[BulkPcrAutoStart] BulkPcrStrategy instance not found - is it present (even if disabled) in config.yml?');
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
                Log.log(`[BulkPcrAutoStart] ${timeStr} slot: BulkPcrStrategy STUCK in a broker error state - manual review and reset() required before any further slot can arm. Skipping.`);
            } else {
                Log.log(`[BulkPcrAutoStart] ${timeStr} slot: BulkPcrStrategy already running - skipping`);
            }
            return;
        }

        target.reset(); // clear any stale phase='done'/positions left over from a previous cycle so it can re-enter cleanly

        const cfg = this.cfg();
        const bulkPcrCfg = configService.getStrategyConfig('BulkPcrStrategy');
        bulkPcrCfg.quantity = cfg.quantity;
        bulkPcrCfg.targetPoints = cfg.targetPoints;
        bulkPcrCfg.brokers = cfg.brokers;
        bulkPcrCfg.enabled = true;
        configService.writeConfig(configService.getConfig());
        strategies.syncFromConfig();

        Log.log(`[BulkPcrAutoStart] ${timeStr} slot: armed BulkPcrStrategy (quantity=${cfg.quantity}, targetPoints=${cfg.targetPoints}, brokers=${JSON.stringify(cfg.brokers)})`);
    }
}
