// A payout's periodEnd is stored exclusive (next day 00:00 for a date-only period): the last instant INSIDE the period is 1ms
// before it. Use this wherever a period end is shown, so the printed range matches the days actually counted.
export const periodEndShown = (periodEnd: string | number | Date): Date => new Date(new Date(periodEnd).getTime() - 1);
