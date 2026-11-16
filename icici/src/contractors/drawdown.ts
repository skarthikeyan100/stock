/**
 * Drawdown limits on contractor orders (the Business agreement, Schedule 2). The realized loss of a contractor's own closed trades:
 *   - in the current IST day may not reach the daily limit (levelRules.advanced.maxDailyDrawdownPercent, default 15%), and
 *   - since the current Settlement Week began (Wednesday) may not reach the weekly limit (maxWeeklyDrawdownPercent, default 30%),
 * both as a percentage of the Advanced allocated capital (levelRules.advanced.capital, ₹2,00,000). Once a limit is reached,
 * no NEW order of that contractor is placed (a forecast, or the approval of a recommendation) until the day or the week resets. Exits of open trades are never blocked.
 * The check uses realized loss, the same definition the Advanced level rules use; the open trade is still limited by its own stop-loss.
 * Fails closed: if the check cannot be made, nothing is placed.
 */
import Mongo from '../tools/mongo';
import configService from '../prism/ConfigService';
import { levelRules } from '../levelRules';
import { Contractor, tradeUsers } from './types';
import { istDate } from './agreements';
import { addDays, istStart, weekdayOf } from './statements';

export interface DrawdownStatus { day: string; weekFrom: string; dailyPnl: number; weeklyPnl: number; dailyLimit: number; weeklyLimit: number; dailyPercent: number; weeklyPercent: number; capital: number }

/** The realized P&L and the limits of a contractor as of `now` (IST). */
export async function drawdownStatus(c: Contractor, now = new Date()): Promise<DrawdownStatus> {
    const day = istDate(now);
    const weekFrom = addDays(day, -((weekdayOf(day) - 3 + 7) % 7)); // the Wednesday on or before today
    const rules = levelRules((configService.getConfig() as any)?.settings, 'advanced');
    const capital = rules.capital; // the Advanced allocated capital (2L), not the 1L order size
    const closed = await Mongo.getInstance().db.collection('closedTrades').find({ user: { $in: tradeUsers(c) }, exitTime: { $gte: istStart(weekFrom) } }).toArray() as any[];
    const pnl = (rows: any[]) => rows.reduce((a, t) => a + (Number.isFinite(Number(t.realizedPnL)) ? Number(t.realizedPnL) : 0), 0);
    const todayFrom = istStart(day);
    return {
        day, weekFrom,
        dailyPnl: Math.round(pnl(closed.filter((t) => new Date(t.exitTime) >= todayFrom)) * 100) / 100,
        weeklyPnl: Math.round(pnl(closed) * 100) / 100,
        dailyLimit: Math.round(capital * rules.maxDailyDrawdownPercent) / 100, weeklyLimit: Math.round(capital * rules.maxWeeklyDrawdownPercent) / 100,
        dailyPercent: rules.maxDailyDrawdownPercent, weeklyPercent: rules.maxWeeklyDrawdownPercent, capital,
    };
}

/** The reason a NEW order of this contractor must not be placed now, or null when it may. */
export async function drawdownRefusal(c: Contractor, now = new Date()): Promise<string | null> {
    try {
        const s = await drawdownStatus(c, now);
        if (s.dailyPnl <= -s.dailyLimit) return `daily drawdown limit reached (realized ${s.dailyPnl} today, limit -${s.dailyLimit}: ${s.dailyPercent}% of the ₹${s.capital} allocated capital); no new order until the next trading day`;
        if (s.weeklyPnl <= -s.weeklyLimit) return `weekly drawdown limit reached (realized ${s.weeklyPnl} since ${s.weekFrom}, limit -${s.weeklyLimit}: ${s.weeklyPercent}% of the ₹${s.capital} allocated capital); no new order until the next settlement week`;
        return null;
    } catch (e: any) {
        return `drawdown check unavailable: ${e?.message ?? e}`; // fail closed
    }
}
