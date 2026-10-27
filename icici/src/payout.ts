import Mongo from './tools/mongo';
import { getUser } from './user';
import { computeTax } from './tax';
import configService from './prism/ConfigService';
import { drawdownLimit, drawdownDecision } from './prism/percentConfig';
import myEmitter from './tools/emitter';
import { weekKey, startOfWeek, endOfWeek } from './util/weekWindow';

export interface PayoutDecisionDetail {
    day?: string;
    dayPnL?: number;
    week?: string;
    weekPnL?: number;
    cumulativePnL?: number;
    lossLimitThreshold?: number;
    tradeIds?: any[];
    consistencyPercent?: number;
    consistencyLimit?: number;
}

export interface PayoutComputation {
    user: string;
    periodStart: Date;
    periodEnd: Date;
    grossProfit: number;
    profitSplitPercent: number;
    splitAmount: number;
    entityType: 'individual' | 'company';
    gstVerified: boolean;
    tdsAmount: number;
    gstAmount: number;
    netAmount: number;
    blocked: boolean;
    blockReason?: string;
    blockDetail?: PayoutDecisionDetail;
}

// A period with zero or negative net profit has nothing to pay out - block
// unconditionally, independent of the drawdown-forfeiture check below (which
// only fires once investmentAmount > 0 and the loss breaches 25%/50%).
export function isNonPositiveProfitBlocked(grossProfit: number): boolean {
    return grossProfit <= 0;
}

// Measures a period's worst-day concentration against gross winnings (sum of
// positive days only), not net profit - net profit can be deflated below any
// single winning day's own total by an unrelated loss elsewhere in the
// period, which previously let worstPercent exceed 100% and over-block
// legitimate payouts. Gross-winnings-based percent is mathematically capped
// at 100% (a day can be at most the sum of all winning days).
export function computeConsistencyBreach(
    periodTrades: Array<{ exitTime: any; realizedPnL?: number }>,
    grossProfit: number,
    consistencyLimitPercent: number
): { worstDay?: string; worstPnL: number; worstPercent: number; tradeIds: any[]; breached: boolean } {
    const byDay = groupByDay(periodTrades);
    let worstDay: string | undefined;
    let worstPnL = -Infinity;
    let grossWinnings = 0;
    for (const [day, entry] of byDay) {
        if (entry.pnl > worstPnL) { worstPnL = entry.pnl; worstDay = day; }
        if (entry.pnl > 0) grossWinnings += entry.pnl;
    }
    const worstPercent = worstDay && grossWinnings > 0 ? (worstPnL / grossWinnings) * 100 : 0;
    const breached = !!worstDay && worstPercent > consistencyLimitPercent;
    return { worstDay, worstPnL, worstPercent, tradeIds: worstDay ? byDay.get(worstDay)!.tradeIds : [], breached };
}

function payoutsCollection() {
    return Mongo.getInstance().db.collection('payouts');
}

function decisionLogCollection() {
    return Mongo.getInstance().db.collection('payoutDecisionLog');
}

function closedTradesCollection() {
    return Mongo.getInstance().db.collection('closedTrades');
}

// Groups a period's closed trades by exitTime's calendar date (UTC) and sums
// realizedPnL per day - used by both the consistency-rule check and the
// trader-facing "why was my payout blocked" breakdown.
function istDayKey(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function groupByDay(trades: any[]): Map<string, { pnl: number; tradeIds: any[] }> {
    const byDay = new Map<string, { pnl: number; tradeIds: any[] }>();
    for (const t of trades) {
        const day = istDayKey(new Date(t.exitTime));
        const entry = byDay.get(day) ?? { pnl: 0, tradeIds: [] };
        entry.pnl += t.realizedPnL || 0;
        entry.tradeIds.push(t._id);
        byDay.set(day, entry);
    }
    return byDay;
}

// Groups a period's closed trades by their trading week (Wed-Tue, local
// time - see util/weekWindow.ts), keyed by that week's Wednesday. Deliberately
// local time, unlike groupByDay's UTC calendar-date slicing above - that's a
// pre-existing inconsistency this change doesn't attempt to fix, since
// groupByDay's UTC semantics are unrelated to the weekly-drawdown rule.
function groupByWeek(trades: any[]): Map<string, { pnl: number; tradeIds: any[]; weekStart: Date; weekEnd: Date }> {
    const byWeek = new Map<string, { pnl: number; tradeIds: any[]; weekStart: Date; weekEnd: Date }>();
    for (const t of trades) {
        const exitTime = new Date(t.exitTime);
        const key = weekKey(exitTime);
        const entry = byWeek.get(key) ?? { pnl: 0, tradeIds: [], weekStart: startOfWeek(exitTime), weekEnd: endOfWeek(exitTime) };
        entry.pnl += t.realizedPnL || 0;
        entry.tradeIds.push(t._id);
        byWeek.set(key, entry);
    }
    return byWeek;
}

// Pure drawdown-forfeiture check, shared by computePayout (below) and
// computePnlSummary (the Trades-tab "eligible P/L" endpoint): a single day
// (or a single week) losing more than the live daily/weekly drawdown limit
// forfeits the checked period's profit entirely - the at-rest consequence of
// the same breach that bookkeeping.ts's drawdownState block new orders and
// trigger auto-squareoff for,
// live, using the same config values.
export function computeDrawdownForfeiture(
    periodTrades: Array<{ exitTime: any; realizedPnL?: number; _id?: any }>,
    investmentAmount: number,
    maxDailyDrawdownPercent: number,
    maxWeeklyDrawdownPercent: number
): { forfeited: boolean; reason?: string; detail?: PayoutDecisionDetail } {
    if (!(investmentAmount > 0)) return { forfeited: false };

    const dailyLimit = (investmentAmount * maxDailyDrawdownPercent) / 100;
    const weeklyLimit = (investmentAmount * maxWeeklyDrawdownPercent) / 100;

    const byDay = groupByDay(periodTrades);
    for (const [day, entry] of byDay) {
        if (drawdownDecision(entry.pnl, investmentAmount, maxDailyDrawdownPercent) === 'breached') {
            return {
                forfeited: true,
                reason: `${day} lost ₹${Math.abs(entry.pnl).toFixed(2)} - exceeds the daily drawdown limit of ${maxDailyDrawdownPercent}% (₹${dailyLimit.toFixed(2)}) of your investment amount. All profit since the last payout is forfeited.`,
                detail: { day, dayPnL: entry.pnl, tradeIds: entry.tradeIds },
            };
        }
    }

    const byWeek = groupByWeek(periodTrades);
    for (const [week, entry] of byWeek) {
        if (drawdownDecision(entry.pnl, investmentAmount, maxWeeklyDrawdownPercent) === 'breached') {
            const weekLabel = `Week of ${entry.weekStart.toDateString()}–${entry.weekEnd.toDateString()}`;
            return {
                forfeited: true,
                reason: `${weekLabel} lost ₹${Math.abs(entry.pnl).toFixed(2)} - exceeds the weekly loss limit of ${maxWeeklyDrawdownPercent}% (₹${weeklyLimit.toFixed(2)}) of your investment amount. All profit since the last payout is forfeited and the account is closed.`,
                detail: { week, weekPnL: entry.pnl, tradeIds: entry.tradeIds },
            };
        }
    }

    return { forfeited: false };
}

// Computes (without persisting) what a payout for this user/period would be:
// gross profit from persisted closedTrades, the profit-split amount, TDS/GST
// via src/tax.ts, and whether the safety-buffer or consistency rules block it
// outright. Recommendation from the plan: block entirely on a breach rather
// than partially reduce - simpler to explain, no redistribution formula to invent.
export async function computePayout(user: string, periodStart: Date, periodEnd: Date): Promise<PayoutComputation> {
    const userDoc = await getUser(user);
    if (!userDoc) throw new Error(`User not found: ${user}`);

    const periodTrades = await closedTradesCollection()
        .find({ user, exitTime: { $gte: periodStart, $lt: periodEnd } }) // end is EXCLUSIVE (see periodFromDates)
        .toArray();
    const grossProfit = periodTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
    const profitSplitPercent = userDoc.profitSplitPercent;
    const splitAmount = Math.round(grossProfit * (profitSplitPercent / 100) * 100) / 100;

    const settings = configService.getConfig().settings as any;
    // Missing/garbled settings must not disable the rules (comparisons against undefined are always false): fall back
    // to the AppConfig defaults.
    const safetyBufferAmount: number = Number.isFinite(Number(settings.safetyBufferAmount)) ? Number(settings.safetyBufferAmount) : 5000;
    const consistencyLimitPercent: number = Number.isFinite(Number(settings.consistencyLimitPercent)) ? Number(settings.consistencyLimitPercent) : 40;

    let blocked = false;
    let blockReason: string | undefined;
    let blockDetail: PayoutDecisionDetail | undefined;

    // Safety buffer applies only to the user's first-ever payout (no prior
    // 'paid' record) - matches the "cushion before first withdrawal" framing.
    const priorPaidPayout = await payoutsCollection().findOne({ user, status: 'paid' });
    if (!priorPaidPayout) {
        const allTimeTrades = await closedTradesCollection().find({ user }).toArray();
        const allTimeProfit = allTimeTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
        if (allTimeProfit < safetyBufferAmount) {
            blocked = true;
            blockReason = `First payout requires an all-time profit cushion of ₹${safetyBufferAmount} (currently ₹${allTimeProfit.toFixed(2)}).`;
            blockDetail = { cumulativePnL: allTimeProfit };
        }
    }

    if (!blocked && isNonPositiveProfitBlocked(grossProfit)) {
        blocked = true;
        blockReason = `This period has no profit to pay out (gross ₹${grossProfit.toFixed(2)}).`;
        blockDetail = { cumulativePnL: grossProfit };
    }

    // Consistency rule: no single day may contribute more than
    // consistencyLimitPercent of the period's gross winnings.
    if (!blocked) {
        const consistency = computeConsistencyBreach(periodTrades, grossProfit, consistencyLimitPercent);
        if (consistency.breached) {
            blocked = true;
            blockReason = `${consistency.worstDay} contributed ${consistency.worstPercent.toFixed(0)}% of this period's winning days (limit ${consistencyLimitPercent}%).`;
            blockDetail = {
                day: consistency.worstDay,
                dayPnL: consistency.worstPnL,
                consistencyPercent: consistency.worstPercent,
                consistencyLimit: consistencyLimitPercent,
                tradeIds: consistency.tradeIds,
            };
        }
    }

    // Drawdown forfeiture: a single day (or a single week) losing more than
    // the live daily/weekly drawdown limit forfeits the period's payout
    // entirely - the payout-time consequence of the same breach that
    // bookkeeping.ts's drawdownState blocks new orders and triggers
    // auto-squareoff for live, using the same config values.
    if (!blocked) {
        const maxDailyDrawdownPercent: number = drawdownLimit(settings, 'maxDailyDrawdownPercent');
        const maxWeeklyDrawdownPercent: number = drawdownLimit(settings, 'maxWeeklyDrawdownPercent');
        const drawdown = computeDrawdownForfeiture(periodTrades, userDoc.investmentAmount, maxDailyDrawdownPercent, maxWeeklyDrawdownPercent);
        if (drawdown.forfeited) {
            blocked = true;
            blockReason = drawdown.reason;
            blockDetail = drawdown.detail;
        }
    }

    const tax = blocked
        ? { tdsAmount: 0, gstAmount: 0, netAmount: 0 }
        : computeTax(splitAmount, userDoc.entityType, userDoc.gstVerified);

    return {
        user,
        periodStart,
        periodEnd,
        grossProfit,
        profitSplitPercent,
        splitAmount,
        entityType: userDoc.entityType,
        gstVerified: userDoc.gstVerified,
        tdsAmount: tax.tdsAmount,
        gstAmount: tax.gstAmount,
        netAmount: tax.netAmount,
        blocked,
        blockReason,
        blockDetail,
    };
}

export interface WeekPnlBreakdown {
    weekStart: string;
    weekEnd: string;
    rawPnL: number;
    eligiblePnL: number;
    forfeited: boolean;
    forfeitReason?: string;
}

export interface PnlSummary {
    rawTotal: number;
    eligibleTotal: number;
    forfeited: boolean;
    forfeitReason?: string;
    weeks?: WeekPnlBreakdown[];
}

// Trades-tab "eligible P/L" view: like computePayout's drawdown-forfeiture
// check, but for an arbitrary display range rather than a payout period, and
// without the safety-buffer/consistency/non-positive-profit payout rules
// (those are payout-specific, not relevant to a plain P/L summary). A
// forfeited period/week contributes only its loss, never its gross profit -
// "do not include forfeited profit" in the eligible total.
//
// breakdownByWeek=true (Month view) buckets by week but CLIPS each week to
// trades within [from,to] rather than pulling in a full Wed-Tue week that
// straddles the range boundary - keeps "month total = sum of displayed
// weeks" exact and avoids a day double-counting into an adjacent month's
// view. This is a display slice, not a re-derivation of the authoritative
// enforcement decision (that always operates on true full weeks, in
// bookkeeping.ts/payout.ts's computePayout).
export async function computePnlSummary(user: string, from: Date, to: Date, breakdownByWeek: boolean): Promise<PnlSummary> {
    const userDoc = await getUser(user);
    if (!userDoc) throw new Error(`User not found: ${user}`);

    const settings = configService.getConfig().settings as any;
    const maxDailyDrawdownPercent: number = drawdownLimit(settings, 'maxDailyDrawdownPercent');
    const maxWeeklyDrawdownPercent: number = drawdownLimit(settings, 'maxWeeklyDrawdownPercent');
    const investmentAmount = userDoc.investmentAmount || 0;

    const periodTrades = await closedTradesCollection()
        .find({ user, exitTime: { $gte: from, $lte: to } })
        .toArray();

    const eligiblePnL = (rawPnL: number, forfeited: boolean) => (forfeited ? Math.min(rawPnL, 0) : rawPnL);

    if (!breakdownByWeek) {
        const rawTotal = periodTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
        const drawdown = computeDrawdownForfeiture(periodTrades, investmentAmount, maxDailyDrawdownPercent, maxWeeklyDrawdownPercent);
        return {
            rawTotal,
            eligibleTotal: eligiblePnL(rawTotal, drawdown.forfeited),
            forfeited: drawdown.forfeited,
            forfeitReason: drawdown.reason,
        };
    }

    const tradesByWeek = new Map<string, { trades: any[]; weekStart: Date; weekEnd: Date }>();
    for (const t of periodTrades) {
        const exitTime = new Date(t.exitTime);
        const key = weekKey(exitTime);
        const entry = tradesByWeek.get(key) ?? { trades: [], weekStart: startOfWeek(exitTime), weekEnd: endOfWeek(exitTime) };
        entry.trades.push(t);
        tradesByWeek.set(key, entry);
    }

    const weeks: WeekPnlBreakdown[] = [];
    let rawTotal = 0;
    let eligibleTotal = 0;
    for (const { trades: weekTrades, weekStart, weekEnd } of Array.from(tradesByWeek.values()).sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())) {
        const weekRawPnL = weekTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
        const drawdown = computeDrawdownForfeiture(weekTrades, investmentAmount, maxDailyDrawdownPercent, maxWeeklyDrawdownPercent);
        const weekEligible = eligiblePnL(weekRawPnL, drawdown.forfeited);
        weeks.push({
            weekStart: weekStart.toISOString().slice(0, 10),
            weekEnd: weekEnd.toISOString().slice(0, 10),
            rawPnL: weekRawPnL,
            eligiblePnL: weekEligible,
            forfeited: drawdown.forfeited,
            forfeitReason: drawdown.reason,
        });
        rawTotal += weekRawPnL;
        eligibleTotal += weekEligible;
    }

    return { rawTotal, eligibleTotal, forfeited: weeks.some((w) => w.forfeited), weeks };
}

let payoutIndexesEnsured = false;
async function ensurePayoutIndexes(): Promise<void> {
    if (payoutIndexesEnsured) return;
    try {
        await payoutsCollection().createIndex({ invoiceNumber: 1 }, { unique: true, sparse: true });
        payoutIndexesEnsured = true;
    } catch (e) {
        console.error('payouts: could not create unique invoiceNumber index (continuing):', e);
    }
}

// Calendar year in IST, regardless of the server's zone.
function istYear(d: Date = new Date()): number {
    return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(d));
}

// Atomic per-year counter (findOneAndUpdate $inc) - concurrent creates can never be handed the same number.
async function nextInvoiceNumber(): Promise<string> {
    const year = istYear();
    const res: any = await Mongo.getInstance().db.collection('counters').findOneAndUpdate(
        { _id: `invoice-${year}` as any },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    const doc = res?.value ?? res; // driver versions differ on whether the doc is wrapped
    const seq = Number(doc?.seq);
    if (!Number.isFinite(seq)) throw new Error('could not allocate an invoice number');
    return `INV-${year}-${String(seq).padStart(6, '0')}`;
}

// Date-only inputs (YYYY-MM-DD) are IST calendar days: [start 00:00 IST, end+1 day 00:00 IST). A full timestamp is used
// as given (end exclusive). Back-to-back periods that share a boundary therefore never double-count a trade.
export function periodFromInputs(periodStart: unknown, periodEnd: unknown): { start: Date; end: Date } {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    const startStr = String(periodStart ?? '');
    const endStr = String(periodEnd ?? '');
    const start = dateOnly.test(startStr) ? new Date(`${startStr}T00:00:00+05:30`) : new Date(startStr);
    let end = dateOnly.test(endStr) ? new Date(`${endStr}T00:00:00+05:30`) : new Date(endStr);
    if (dateOnly.test(endStr)) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('periodStart/periodEnd must be valid dates');
    if (!(start.getTime() < end.getTime())) throw new Error('periodStart must be before periodEnd');
    return { start, end };
}

// Server always recomputes rather than trusting client-submitted math - the
// admin UI's "compute" preview and this persist step both call computePayout.
export async function createPayoutRecord(user: string, periodStart: Date, periodEnd: Date): Promise<any> {
    if (typeof user !== 'string' || !user) throw new Error('user is required');
    if (!(periodStart instanceof Date) || !(periodEnd instanceof Date) || Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime()) || !(periodStart < periodEnd)) {
        throw new Error('periodStart must be a valid date before periodEnd');
    }
    await ensurePayoutIndexes();
    // The same closedTrades must never be paid twice: refuse a period that overlaps any payout that is not rejected.
    const overlapping = await payoutsCollection().findOne({
        user,
        status: { $ne: 'rejected' },
        periodStart: { $lt: periodEnd },
        periodEnd: { $gt: periodStart },
    });
    if (overlapping) throw new Error(`This period overlaps an existing ${overlapping.status} payout (${overlapping.invoiceNumber}) for ${user}`);
    const computation = await computePayout(user, periodStart, periodEnd);
    const userDoc = await getUser(user);
    const invoiceNumber = await nextInvoiceNumber();

    const payout = {
        user,
        periodStart,
        periodEnd,
        grossProfit: computation.grossProfit,
        profitSplitPercent: computation.profitSplitPercent,
        splitAmount: computation.splitAmount,
        entityType: computation.entityType,
        gstVerified: computation.gstVerified,
        tdsAmount: computation.tdsAmount,
        gstAmount: computation.gstAmount,
        netAmount: computation.netAmount,
        status: computation.blocked ? 'rejected' : 'pending',
        adminNote: computation.blocked ? computation.blockReason : undefined,
        bankSnapshot: {
            holderName: userDoc?.bankAccountHolderName,
            accountNumberMasked: userDoc?.bankAccountNumber ? '*'.repeat(Math.max(0, userDoc.bankAccountNumber.length - 4)) + userDoc.bankAccountNumber.slice(-4) : undefined,
            ifsc: userDoc?.bankIFSC,
            upiId: userDoc?.upiId,
        },
        createdAt: new Date(),
        invoiceNumber,
    };
    const result = await payoutsCollection().insertOne(payout);
    const payoutId = result.insertedId;

    if (computation.blocked) {
        await decisionLogCollection().insertOne({
            user,
            payoutId,
            type: 'payout_blocked',
            reason: computation.blockReason,
            detail: computation.blockDetail,
            createdAt: new Date(),
        });
        // This runs in the `frontend` process (same process as the SSE
        // emitter, unlike bookkeeping.ts's drawdown notifications which live
        // in `order` and must poll instead) - push immediately.
        const notification = {
            user,
            type: 'payout_status' as const,
            message: `Payout for ${new Date(periodStart).toDateString()} – ${new Date(periodEnd).toDateString()} was blocked: ${computation.blockReason}`,
            read: false,
            createdAt: new Date(),
        };
        // The same blocked period can be submitted repeatedly: notify once per distinct message.
        const already = await Mongo.getInstance().db.collection('notifications').findOne({ user, type: 'payout_status', message: notification.message });
        if (!already) {
            await Mongo.getInstance().db.collection('notifications').insertOne(notification);
            myEmitter.emit('notification', { user, notification });
        }
    }

    return { ...payout, _id: payoutId };
}

function toObjectId(payoutId: any): any {
    const { ObjectId } = require('mongodb');
    if (typeof payoutId === 'string') {
        if (!ObjectId.isValid(payoutId)) throw new Error('Invalid payout id');
        return new ObjectId(payoutId);
    }
    return payoutId;
}

// Compare-and-set: only a PENDING payout can be decided, exactly once. A payout the rules rejected at creation, an
// already-paid one, or an unknown id cannot be (re)decided - so a rule block can't be bypassed by marking it paid.
export async function markPayoutDecision(payoutId: any, status: 'paid' | 'rejected', note: string | undefined, adminEmail: string | null | undefined): Promise<any> {
    if (!adminEmail) throw new Error('A decision must be attributed to an admin');
    const id = toObjectId(payoutId);
    const existing = await payoutsCollection().findOne({ _id: id });
    if (!existing) throw new Error('Payout not found');
    const res: any = await payoutsCollection().findOneAndUpdate(
        { _id: id, status: 'pending' },
        { $set: { status, adminNote: note, decidedAt: new Date(), decidedBy: adminEmail } },
        { returnDocument: 'after' }
    );
    const updated = res?.value ?? (res && res._id ? res : null);
    if (!updated) throw new Error(`Payout is already ${existing.status} - only a pending payout can be decided`);
    await decisionLogCollection().insertOne({
        user: updated.user,
        payoutId: id,
        type: status === 'paid' ? 'payout_paid' : 'payout_rejected',
        reason: note,
        detail: { decidedBy: adminEmail },
        createdAt: new Date(),
    });
    return updated;
}

// Pending -> paid with the bank-payment proof attached, exactly once (compare-and-set on status). The proof file is
// already stored by the caller; if this loses the race the caller deletes it.
export async function markPayoutPaidWithProof(
    payoutId: any,
    proof: { fileId: string; paymentRef?: string; paidTo: string; note?: string },
    adminEmail: string | null | undefined
): Promise<any> {
    if (!adminEmail) throw new Error('A decision must be attributed to an admin');
    const id = toObjectId(payoutId);
    const existing = await payoutsCollection().findOne({ _id: id });
    if (!existing) throw new Error('Payout not found');
    const now = new Date();
    const res: any = await payoutsCollection().findOneAndUpdate(
        { _id: id, status: 'pending' },
        { $set: { status: 'paid', adminNote: proof.note, decidedAt: now, decidedBy: adminEmail, paidAt: now, proofFileId: proof.fileId, paymentRef: proof.paymentRef, paidTo: proof.paidTo, emailStatus: 'pending' } },
        { returnDocument: 'after' }
    );
    const updated = res?.value ?? (res && res._id ? res : null);
    if (!updated) throw new Error(`Payout is already ${existing.status} - only a pending payout can be decided`);
    await decisionLogCollection().insertOne({
        user: updated.user,
        payoutId: id,
        type: 'payout_paid',
        reason: proof.note,
        detail: { decidedBy: adminEmail, paymentRef: proof.paymentRef, proofFileId: proof.fileId },
        createdAt: now,
    });
    const notification = {
        user: updated.user,
        type: 'payout_status' as const,
        message: `Payout ${updated.invoiceNumber} of ₹${updated.netAmount.toFixed(2)} has been paid`,
        read: false,
        createdAt: now,
    };
    await Mongo.getInstance().db.collection('notifications').insertOne(notification);
    myEmitter.emit('notification', { user: updated.user, notification });
    return updated;
}

export async function setPayoutEmailStatus(payoutId: any, status: 'sent' | 'failed', error?: string): Promise<void> {
    await payoutsCollection().updateOne(
        { _id: toObjectId(payoutId), status: 'paid' },
        { $set: { emailStatus: status, emailError: status === 'failed' ? error : undefined, emailAttemptAt: new Date() } }
    );
}

export async function getPayout(payoutId: any): Promise<any | null> {
    return payoutsCollection().findOne({ _id: toObjectId(payoutId) });
}

// `email` (when given) must own the payout, otherwise it is treated as not found - the route only authorises the :email
// segment, so without this any user could read another user's payout by id.
export async function getPayoutDecisionLog(payoutId: any, email?: string): Promise<any[]> {
    const id = toObjectId(payoutId);
    if (email !== undefined) {
        const payout = await payoutsCollection().findOne({ _id: id });
        if (!payout || String(payout.user).toLowerCase() !== email.toLowerCase()) return [];
    }
    const entries = await decisionLogCollection().find({ payoutId: id }).sort({ createdAt: -1 }).toArray();
    for (const entry of entries) {
        if (entry.detail?.tradeIds?.length) {
            entry.detail.trades = await closedTradesCollection().find({ _id: { $in: entry.detail.tradeIds } }).toArray();
        }
    }
    return entries;
}

function escapeHtml(value: any): string {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Self-contained printable HTML (inline CSS, no external assets) - browser
// print-to-PDF covers "downloadable" without adding a PDF dependency.
export async function generateInvoiceHtml(payoutId: any, email?: string): Promise<string> {
    const id = toObjectId(payoutId);
    const payout = await payoutsCollection().findOne({ _id: id });
    if (!payout || (email !== undefined && String(payout.user).toLowerCase() !== email.toLowerCase())) throw new Error('Payout not found');
    const userDoc = await getUser(payout.user);

    // Rendered from what was persisted at creation (gstVerified), not today's user doc: it must match the tax actually applied.
    const taxLine = payout.entityType === 'company' && payout.gstVerified !== false
        ? `<tr><td>GST Registered — No TDS Applicable${userDoc?.gstin ? `, GSTIN: ${escapeHtml(userDoc.gstin)}` : ''}</td><td style="text-align:right">₹0.00</td></tr>`
        : `<tr><td>TDS Deducted (10%)</td><td style="text-align:right">₹${payout.tdsAmount.toFixed(2)}</td></tr>`;

    return `
<div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #111;">
  <h2 style="margin-bottom:0">Payout Invoice</h2>
  <div style="color:#666; margin-bottom:24px;">${escapeHtml(payout.invoiceNumber)}</div>
  <table style="width:100%; border-collapse:collapse; margin-bottom:16px;">
    <tr><td style="color:#666">Trader</td><td style="text-align:right">${escapeHtml(userDoc?.legalName || userDoc?.name)} (${escapeHtml(payout.user)})</td></tr>
    <tr><td style="color:#666">Period</td><td style="text-align:right">${new Date(payout.periodStart).toDateString()} – ${new Date(payout.periodEnd).toDateString()}</td></tr>
    <tr><td style="color:#666">Status</td><td style="text-align:right">${escapeHtml(payout.status)}</td></tr>
  </table>
  <table style="width:100%; border-collapse:collapse; border-top:1px solid #ddd; padding-top:8px;">
    <tr><td>Gross Profit</td><td style="text-align:right">₹${payout.grossProfit.toFixed(2)}</td></tr>
    <tr><td>Profit Split (${payout.profitSplitPercent}%)</td><td style="text-align:right">₹${payout.splitAmount.toFixed(2)}</td></tr>
    ${taxLine}
    <tr style="font-weight:bold; border-top:1px solid #ddd;"><td>Net Payable</td><td style="text-align:right">₹${payout.netAmount.toFixed(2)}</td></tr>
  </table>
  ${payout.adminNote ? `<div style="margin-top:16px; color:#a00;">${escapeHtml(payout.adminNote)}</div>` : ''}
</div>`;
}
