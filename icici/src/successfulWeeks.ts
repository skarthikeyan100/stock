/**
 * "Successful weeks": a completed payment week (Wednesday to Tuesday) whose net realized P&L is above zero and that had no daily / weekly
 * drawdown forfeit. A user needs REQUIRED_SUCCESSFUL_WEEKS of them (any, not necessarily consecutive; weeks traded as Beginner count) before an
 * Advanced user may ask for more capital. Shown to the user, so the rule is transparent.
 */
import { startOfWeek, endOfWeek } from './util/weekWindow';
import { computeDrawdownForfeiture, closedTradesCollection } from './payout';
import { getUser } from './user';
import configService from './prism/ConfigService';
import { levelRules } from './levelRules';

export const REQUIRED_SUCCESSFUL_WEEKS = 2;

type ClosedRow = { exitTime: any; realizedPnL?: number; _id?: any };

export function countSuccessfulWeeks(trades: ClosedRow[], capital: number, maxDailyPercent: number, maxWeeklyPercent: number, now: Date = new Date()): number {
    const byWeek = new Map<number, ClosedRow[]>();
    for (const t of trades) {
        const exit = new Date(t.exitTime);
        if (Number.isNaN(exit.getTime())) continue;
        const start = startOfWeek(exit);
        if (endOfWeek(exit).getTime() >= now.getTime()) continue; // the week is not over yet
        const key = start.getTime();
        byWeek.set(key, [...(byWeek.get(key) ?? []), t]);
    }
    let count = 0;
    for (const weekTrades of byWeek.values()) {
        const net = weekTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
        if (!(net > 0)) continue;
        if (computeDrawdownForfeiture(weekTrades, capital, maxDailyPercent, maxWeeklyPercent).forfeited) continue;
        count++;
    }
    return count;
}

export async function successfulWeeksFor(email: string): Promise<{ count: number; required: number }> {
    const user = await getUser(email);
    if (!user) throw new Error(`User not found: ${email}`);
    const rows = await closedTradesCollection().find({ user: email }).toArray();
    const rules = levelRules(configService.getConfig()?.settings as any, user.proficiencyLevel);
    const capital = user.investmentAmount || user.accountCapital || rules.capital;
    return { count: countSuccessfulWeeks(rows as ClosedRow[], capital, rules.maxDailyDrawdownPercent, rules.maxWeeklyDrawdownPercent), required: REQUIRED_SUCCESSFUL_WEEKS };
}
