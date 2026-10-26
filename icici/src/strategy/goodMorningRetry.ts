import configService from '../prism/ConfigService';
import Log from '../util/Log';
import { localDayKey } from './dayKey';

// GoodMorning(+Sensex) persist their same-day retry into config.yml (snapshotTime/confirmTime pushed out, previousClose
// replaced by the failed confirm price). Left alone, the NEXT trading day starts from those intraday values: a
// 12:05 snapshot window and an intraday "previous close" that is not the previous close at all. These helpers keep the
// original times beside the retry and undo it on the first tick of a new day.

// Call BEFORE the first retry write of a day mutates snapshotTime/confirmTime.
export function stashRetryBase(config: any): void {
    if (config.retryDay === localDayKey()) return; // already stashed today
    config.baseSnapshotTime = config.snapshotTime;
    config.baseConfirmTime = config.confirmTime;
}

// Call AFTER the retry write set the new times/previousClose.
export function stampRetry(config: any): void {
    config.retryDay = localDayKey();
    config.retryPreviousClose = config.previousClose;
}

// First tick of a new day: restore yesterday's pushed-out times. Returns 'stale' when previousClose is still the
// intraday value the retry wrote (nobody updated it), in which case today must be skipped; 'fresh' otherwise.
export function recoverFromStaleRetry(config: any, tag: string): 'fresh' | 'stale' {
    if (!config.retryDay || config.retryDay === localDayKey()) return 'fresh';
    const stale = config.previousClose === config.retryPreviousClose;
    if (config.baseSnapshotTime != null) config.snapshotTime = config.baseSnapshotTime;
    if (config.baseConfirmTime != null) config.confirmTime = config.baseConfirmTime;
    delete config.baseSnapshotTime;
    delete config.baseConfirmTime;
    delete config.retryDay;
    delete config.retryPreviousClose;
    try {
        configService.writeConfig(configService.getConfig());
    } catch (e) {
        Log.log(`[${tag}] could not persist the restored snapshot/confirm times:`, e);
    }
    if (stale) Log.log(`[${tag}] previousClose is still the intraday value written by yesterday's retry - skipping today until it is updated`);
    return stale ? 'stale' : 'fresh';
}
