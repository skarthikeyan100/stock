// settings.eodReconcileTime (config.yml, 'HH:mm'): when the end-of-day broker -> Mongo sync runs (OrderBookkeeping.eodRepairBroker, scheduled from
// orderProcess). It must be at or after the 15:30 close, because it books what the brokers did during the day. Missing or invalid -> the default.
import configService from '../prism/ConfigService';

export const DEFAULT_EOD_RECONCILE_TIME = '15:45';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function effectiveEodReconcileTime(): string {
    try {
        const v = (configService.getConfig()?.settings as any)?.eodReconcileTime;
        return v != null && HHMM.test(String(v)) ? String(v) : DEFAULT_EOD_RECONCILE_TIME;
    } catch {
        return DEFAULT_EOD_RECONCILE_TIME;
    }
}
