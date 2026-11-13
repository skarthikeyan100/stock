// "Opened today" test for the /strategyPnl ?opened=today filter (scripts/strategy-status.sh default view).
// The opening time of a trade is Trade.entryTime on BOTH an open trade and a closed-trade row (Mongo closedTrades.entryTime, copied from the
// first buy fill; repaired rows copy it from the matched buy fill, restored legs carry the original fill's time). It is an IST calendar day.
// A missing or unparseable entryTime is treated as OPENED TODAY (included): nothing shows it came from an earlier day, and dropping it would
// silently hide real P&L from the default report. `all` includes everything.
const istDay = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export function isOpenedToday(entryTime: unknown, now: number = Date.now()): boolean {
    if (entryTime == null || entryTime === '') return true;
    const ms = entryTime instanceof Date ? entryTime.getTime() : new Date(entryTime as any).getTime();
    if (!Number.isFinite(ms)) return true;
    return istDay(ms) === istDay(now);
}

export function openedFilterOf(query: unknown): 'today' | 'all' {
    return query === 'today' ? 'today' : 'all';
}
