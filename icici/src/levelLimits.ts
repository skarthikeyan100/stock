/**
 * Per-trade loss cap (settings.levelRules.<level>.maxLossPerTradePercent): the most lots whose stop-out stays within a % of the account capital.
 * Loss of one stop-out = lots x lotSize x stopPoints. Returns undefined when an input is not a positive finite number (no cap applies; the caller
 * keeps its own sizing), and may return 0 (the cap is below one lot: the caller floors to one lot, the platform's documented minimum).
 */
export function maxLotsForLossCap(a: { capital: number; maxLossPercent: number; stopPoints: number; lotSize: number }): number | undefined {
    const ok = (n: number) => typeof n === 'number' && Number.isFinite(n) && n > 0;
    if (!ok(a.capital) || !ok(a.maxLossPercent) || !ok(a.stopPoints) || !ok(a.lotSize)) return undefined;
    return Math.floor((a.capital * a.maxLossPercent / 100) / (a.stopPoints * a.lotSize));
}
