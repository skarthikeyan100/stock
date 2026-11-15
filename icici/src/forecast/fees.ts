/**
 * Beginner fees (spec v2.1 section 10; amounts are gross, tax is out of scope). Pure. The invariants, enforced here and tested: nothing is ever negative,
 * only CORRECT forecasts earn a fee, and no function here takes trading P&L as an input (fees never depend on how the Company traded).
 */
export interface FeeRates { feePerCorrect: number; monthlyCap: number; retainerMonthly: number; minParticipationDays: number }

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** Weekly accuracy fee: correct x fee, capped by what is left of the month's cap. */
export function weeklyAccuracyFee(correctCount: number, rates: Pick<FeeRates, 'feePerCorrect' | 'monthlyCap'>, alreadyEarnedThisMonth: number): { gross: number; cappedBy: 'none' | 'monthlyCap' } {
    const raw = Math.floor(nonNeg(correctCount)) * nonNeg(rates.feePerCorrect);
    const remaining = rates.monthlyCap > 0 ? Math.max(0, rates.monthlyCap - nonNeg(alreadyEarnedThisMonth)) : Infinity;
    const gross = Math.min(raw, remaining);
    return { gross: Math.round(gross * 100) / 100, cappedBy: gross < raw ? 'monthlyCap' : 'none' };
}

/** Monthly retainer: pro-rated by active days, zero when the contractor did not meet the minimum participation days (a day with at least one forecast). */
export function monthlyRetainer(rates: Pick<FeeRates, 'retainerMonthly' | 'minParticipationDays'>, activeDays: number, daysInMonth: number, participationDays: number): { gross: number; reason: string } {
    if (!(daysInMonth > 0)) return { gross: 0, reason: 'no days' };
    if (participationDays < rates.minParticipationDays) return { gross: 0, reason: `participated on ${participationDays} days (minimum ${rates.minParticipationDays})` };
    const share = Math.min(1, Math.max(0, activeDays) / daysInMonth);
    return { gross: Math.round(nonNeg(rates.retainerMonthly) * share * 100) / 100, reason: share < 1 ? `pro-rated ${activeDays}/${daysInMonth} days` : 'full month' };
}
