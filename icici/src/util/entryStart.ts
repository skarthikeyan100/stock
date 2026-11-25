// settings.entryStartTime (config.yml, 'HH:mm'): the one earliest time a strategy that honours it may open a NEW position (ScaledHedgedStrategy, ExperimentalScaledStrategy,
// HighLowStrategy). Global only: configValidation rejects it on a strategy block. Missing = the strategy's own default (no extra limit for
// HighLow, 10:00 for ScaledHedged). Exits, hedges already due and the EOD close never wait for it.
import configService from '../prism/ConfigService';
import { MOCK_BROKER } from '../constants';

const VALID_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function entryStartTime(): string | undefined {
    try {
        const v = (configService.getConfig()?.settings as any)?.entryStartTime;
        return v != null && VALID_HHMM.test(String(v)) ? String(v) : undefined;
    } catch {
        return undefined;
    }
}

// True before the configured start time. With no (valid) setting, `fallback` ('HH:mm' or undefined = no limit) applies. Mock/test mode bypasses
// it like Strategy.isTimeInRange does.
export function isBeforeEntryStart(fallback?: string, now: Date = new Date()): boolean {
    if (MOCK_BROKER) return false;
    const v = entryStartTime() ?? fallback;
    if (!v) return false;
    const [h, m] = v.split(':').map(Number);
    return now.getHours() * 60 + now.getMinutes() < h * 60 + m;
}
