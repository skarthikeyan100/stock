import Mongo from './tools/mongo';
import { getUser } from './user';
import { computeTax } from './tax';
import configService from './prism/ConfigService';
import myEmitter from './tools/emitter';

export interface PayoutDecisionDetail {
    day?: string;
    dayPnL?: number;
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
function groupByDay(trades: any[]): Map<string, { pnl: number; tradeIds: any[] }> {
    const byDay = new Map<string, { pnl: number; tradeIds: any[] }>();
    for (const t of trades) {
        const day = new Date(t.exitTime).toISOString().slice(0, 10);
        const entry = byDay.get(day) ?? { pnl: 0, tradeIds: [] };
        entry.pnl += t.realizedPnL || 0;
        entry.tradeIds.push(t._id);
        byDay.set(day, entry);
    }
    return byDay;
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
        .find({ user, exitTime: { $gte: periodStart, $lte: periodEnd } })
        .toArray();
    const grossProfit = periodTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
    const profitSplitPercent = userDoc.profitSplitPercent;
    const splitAmount = Math.round(grossProfit * (profitSplitPercent / 100) * 100) / 100;

    const settings = configService.getConfig().settings as any;
    const safetyBufferAmount: number = settings.safetyBufferAmount;
    const consistencyLimitPercent: number = settings.consistencyLimitPercent;

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

    // Consistency rule: no single day may contribute more than
    // consistencyLimitPercent of the period's total profit.
    if (!blocked && grossProfit > 0) {
        const byDay = groupByDay(periodTrades);
        let worstDay: string | undefined;
        let worstPnL = -Infinity;
        for (const [day, entry] of byDay) {
            if (entry.pnl > worstPnL) { worstPnL = entry.pnl; worstDay = day; }
        }
        const worstPercent = worstDay ? (worstPnL / grossProfit) * 100 : 0;
        if (worstDay && worstPercent > consistencyLimitPercent) {
            blocked = true;
            blockReason = `${worstDay} contributed ${worstPercent.toFixed(0)}% of this period's profit (limit ${consistencyLimitPercent}%).`;
            blockDetail = {
                day: worstDay,
                dayPnL: worstPnL,
                consistencyPercent: worstPercent,
                consistencyLimit: consistencyLimitPercent,
                tradeIds: byDay.get(worstDay)!.tradeIds,
            };
        }
    }

    // Drawdown forfeiture: a single day (or the whole period) losing more
    // than the live daily/monthly drawdown limit forfeits the period's
    // payout entirely - the payout-time consequence of the same breach that
    // bookkeeping.ts's isDailyDrawdownBreached/isMonthlyDrawdownBreached
    // already block new orders and trigger auto-squareoff for live, using
    // the same config values.
    if (!blocked && userDoc.investmentAmount > 0) {
        const maxDailyDrawdownPercent: number = settings.maxDailyDrawdownPercent ?? 25;
        const maxMonthlyDrawdownPercent: number = settings.maxMonthlyDrawdownPercent ?? 50;
        const dailyLimit = (userDoc.investmentAmount * maxDailyDrawdownPercent) / 100;
        const monthlyLimit = (userDoc.investmentAmount * maxMonthlyDrawdownPercent) / 100;

        const byDayForDrawdown = groupByDay(periodTrades);
        for (const [day, entry] of byDayForDrawdown) {
            if (entry.pnl <= -dailyLimit) {
                blocked = true;
                blockReason = `${day} lost ₹${Math.abs(entry.pnl).toFixed(2)} - exceeds the daily drawdown limit of ${maxDailyDrawdownPercent}% (₹${dailyLimit.toFixed(2)}) of your investment amount. All profit since the last payout is forfeited.`;
                blockDetail = { day, dayPnL: entry.pnl, tradeIds: entry.tradeIds };
                break;
            }
        }

        if (!blocked && grossProfit <= -monthlyLimit) {
            blocked = true;
            blockReason = `This period lost ₹${Math.abs(grossProfit).toFixed(2)} - exceeds the monthly loss limit of ${maxMonthlyDrawdownPercent}% (₹${monthlyLimit.toFixed(2)}) of your investment amount. All profit since the last payout is forfeited.`;
            blockDetail = { cumulativePnL: grossProfit };
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

async function nextInvoiceNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await payoutsCollection().countDocuments({ invoiceNumber: { $regex: `^INV-${year}-` } });
    return `INV-${year}-${String(count + 1).padStart(6, '0')}`;
}

// Server always recomputes rather than trusting client-submitted math - the
// admin UI's "compute" preview and this persist step both call computePayout.
export async function createPayoutRecord(user: string, periodStart: Date, periodEnd: Date): Promise<any> {
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
        await Mongo.getInstance().db.collection('notifications').insertOne(notification);
        myEmitter.emit('notification', { user, notification });
    }

    return { ...payout, _id: payoutId };
}

export async function markPayoutDecision(payoutId: any, status: 'paid' | 'rejected', note: string | undefined, adminEmail: string): Promise<any> {
    const { ObjectId } = require('mongodb');
    const id = typeof payoutId === 'string' ? new ObjectId(payoutId) : payoutId;
    await payoutsCollection().updateOne(
        { _id: id },
        { $set: { status, adminNote: note, decidedAt: new Date(), decidedBy: adminEmail } }
    );
    return payoutsCollection().findOne({ _id: id });
}

export async function getPayoutDecisionLog(payoutId: any): Promise<any[]> {
    const { ObjectId } = require('mongodb');
    const id = typeof payoutId === 'string' ? new ObjectId(payoutId) : payoutId;
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
export async function generateInvoiceHtml(payoutId: any): Promise<string> {
    const { ObjectId } = require('mongodb');
    const id = typeof payoutId === 'string' ? new ObjectId(payoutId) : payoutId;
    const payout = await payoutsCollection().findOne({ _id: id });
    if (!payout) throw new Error('Payout not found');
    const userDoc = await getUser(payout.user);

    const taxLine = payout.entityType === 'company'
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
