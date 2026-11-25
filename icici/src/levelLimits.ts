/**
 * Per-trade loss budget (settings.levelRules.<level>.maxLossPerTradePercent x the user's accountCapital).
 * It does NOT size an order (an investmentAmount order is sized from the capital: all the lots it buys). It is enforced as an EXIT: the
 * position's stop is never looser than budget / quantity per share, so the position is sold when its loss reaches the budget.
 * Callers: bookkeeping.lossBudgetStopPoints (stop attached to a frontend manual buy, every broker) and bookkeeping.tightenStopToLossBudget
 * (the merged position after chunks / an add-more; restart restore).
 */
export const LOSS_BUDGET_TICK = 0.05;

const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Rupees one trade may lose, or undefined when capital / percent is not a positive finite number (no budget applies). */
export function lossBudgetRupees(capital: number, maxLossPercent: number): number | undefined {
    return ok(capital) && ok(maxLossPercent) ? capital * maxLossPercent / 100 : undefined;
}

const floorToTick = (x: number): number => Math.floor(x / LOSS_BUDGET_TICK + 1e-9) * LOSS_BUDGET_TICK;
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Stop distance (points below the NEW fill's price) for a buy of `newQty` at `price`, so that the whole position (this buy plus an existing
 * position of `existingQty` at `existingAvg` on the same contract) loses at most `budget` when the stop is hit: the stop sits at
 * combinedAvg - budget / totalQty. The result is the nearer of that and the configured `stopPoints` (an explicit tighter stop is kept; an
 * unset / non-positive stop leaves the budget distance alone). Floored to the 0.05 tick (never loosens past the budget) and never below one
 * tick: `belowTick` says the budget per share is under one tick (a cheap option with a huge quantity), so the budget cannot be honoured exactly.
 */
export function lossBudgetStop(a: { budget: number; newQty: number; price: number; stopPoints?: number; existingQty?: number; existingAvg?: number }): { points: number; tightened: boolean; belowTick: boolean } | undefined {
    if (!ok(a.budget) || !ok(a.newQty) || !ok(a.price)) return undefined;
    const eq = ok(a.existingQty) && ok(a.existingAvg) ? a.existingQty : 0;
    const total = a.newQty + eq;
    const avg = eq > 0 ? (eq * (a.existingAvg as number) + a.newQty * a.price) / total : a.price;
    const raw = (a.price - avg) + a.budget / total;
    const belowTick = raw < LOSS_BUDGET_TICK;
    const budgetPoints = round2(Math.max(LOSS_BUDGET_TICK, floorToTick(raw)));
    const configured = ok(a.stopPoints) ? a.stopPoints : undefined;
    if (configured !== undefined && configured <= budgetPoints) return { points: configured, tightened: false, belowTick };
    return { points: budgetPoints, tightened: true, belowTick };
}

/** Lowest stop price (tick-aligned, rounded UP so the loss stays within the budget) for a position of `quantity` at average `avg`; at most one tick under `avg`. */
export function lossBudgetStopPrice(budget: number, quantity: number, avg: number): number | undefined {
    if (!ok(budget) || !ok(quantity) || !ok(avg)) return undefined;
    const p = Math.ceil((avg - budget / quantity) / LOSS_BUDGET_TICK - 1e-9) * LOSS_BUDGET_TICK;
    return round2(Math.min(p, avg - LOSS_BUDGET_TICK));
}
