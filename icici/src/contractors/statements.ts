/**
 * Fee statements (spec v2.1 section 10; amounts are GROSS, tax is out of scope and arrives with the tax phase). Kept in their own collection
 * `contractorStatements`: the existing `payouts` collection and its Admin screens are not touched.
 *   Beginner: ACCURACY_WEEK (correct forecasts x the fee snapshotted on each forecast, capped by the month's remaining cap) and RETAINER_MONTH.
 *   Advanced: PROFIT_SHARE_WEEK (a percentage of the net profit of the closed trades of its approved recommendations; a losing week pays 0 and the loss is CARRIED FORWARD
 *             and set off against later weeks before any share is paid, clause 6A.2; nothing is ever charged to the contractor) or, from an effective date, FIXED_PERIOD
 *             (a fixed amount per fee period, of N months (default 1), x min(1, max(0, net realized profit of the period / reference investment)), clause 6A.6:
 *             the full amount only when the reference investment is realized, pro rata below it, nothing on a net loss, and no loss carried forward).
 * Invariants (tested): no amount is negative, only CORRECT forecasts earn an accuracy fee, no input is the Company's P&L for a Beginner statement,
 * and a fee-model change applies only from its effective date, never to an earlier period.
 */
import * as crypto from 'crypto';
import Mongo from '../tools/mongo';
import configService from '../prism/ConfigService';
import { Contractor, tradeUsers } from './types';
import { applyMonthlyCap, monthlyRetainer } from '../forecast/fees';

export type StatementKind = 'ACCURACY_WEEK' | 'RETAINER_MONTH' | 'PROFIT_SHARE_WEEK' | 'FIXED_PERIOD';
export type StatementStatus = 'DRAFT' | 'APPROVED' | 'PAID';
export interface StatementDoc {
    _id?: any; id: string; contractorId: string; kind: StatementKind; periodFrom: string; periodTo: string; // IST dates, inclusive
    lines: Record<string, number | string>; gross: number; status: StatementStatus; createdAt: Date;
    approvedAt?: Date; approvedBy?: string; paidAt?: Date; paidBy?: string; utr?: string;
    invoice?: { number: string; date: string; file: string; uploadedAt: Date }; invoiceDueAt?: Date; invoiceFlagged?: boolean;
}
export const statementsCol = () => Mongo.getInstance().db.collection('contractorStatements');

// ---------- dates (IST strings; no time-zone arithmetic on Date) ----------
const toDate = (d: string) => new Date(d + 'T00:00:00Z');
export const addDays = (d: string, n: number): string => new Date(toDate(d).getTime() + n * 86_400_000).toISOString().slice(0, 10);
export const weekdayOf = (d: string): number => toDate(d).getUTCDay(); // 0 Sun .. 6 Sat
export const daysInMonthOf = (ym: string): number => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
/** The Wednesday-to-Tuesday week that ended before `runDate` (the Wednesday the job runs, or any date: the latest complete week). */
export function previousWeek(runDate: string): { from: string; to: string } {
    const wd = weekdayOf(runDate);
    const sinceWed = (wd - 3 + 7) % 7;               // days since the most recent Wednesday (0 on a Wednesday)
    const thisWed = addDays(runDate, -sinceWed);
    return { from: addDays(thisWed, -7), to: addDays(thisWed, -1) };
}
export const previousMonth = (runDate: string): string => { const [y, m] = runDate.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
/** `date` moved by n whole months; the day is clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: string, n: number): string {
    const y = Number(d.slice(0, 4)), mIdx = Number(d.slice(5, 7)) - 1 + n, day = Number(d.slice(8, 10));
    const ty = y + Math.floor(mIdx / 12), tm = ((mIdx % 12) + 12) % 12;
    const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(day, dim)).padStart(2, '0')}`;
}
const daysBetween = (a: string, b: string): number => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000) + 1; // inclusive

// ---------- fee model of an Advanced contractor, with effective dates ----------
export interface FeeModelEntry { from: string; model: 'PROFIT_SHARE' | 'FIXED_PERIOD'; sharePercent?: number; fixedAmount?: number; durationMonths?: number; referenceInvestment?: number }
/** The entry in force on `date`: the latest whose `from` is on or before it. A change never reaches back before its own `from`. */
export function feeModelOn(entries: FeeModelEntry[] | undefined, date: string, defaultSharePercent: number): FeeModelEntry {
    const sorted = [...(entries ?? [])].sort((a, b) => (a.from < b.from ? -1 : 1)).filter((e) => e.from <= date);
    return sorted.length ? sorted[sorted.length - 1] : { from: '1970-01-01', model: 'PROFIT_SHARE', sharePercent: defaultSharePercent };
}

export const DEFAULT_FIXED_FEE_MONTHS = 1;
export const DEFAULT_REFERENCE_INVESTMENT = 100000;
/** The length of a fee period in months (config forecast.fixedFeeDurationMonths; default 1). */
export const fixedFeeMonths = (): number => { const n = Number((configService.getConfig() as any)?.forecast?.fixedFeeDurationMonths); return Number.isInteger(n) && n >= 1 && n <= 12 ? n : DEFAULT_FIXED_FEE_MONTHS; };
/** The investment the fixed fee is measured against (forecast.orders.maxInvestment; snapshotted on each fee-model entry when it is created). */
export const referenceInvestment = (): number => { const n = Number((configService.getConfig() as any)?.forecast?.orders?.maxInvestment); return n > 0 ? n : DEFAULT_REFERENCE_INVESTMENT; };

export const feeCfg = () => ({ monthlyCap: 0, retainerMonthly: 0, minParticipationDays: 15, feePerCorrect: 0, ...(((configService.getConfig() as any)?.forecast?.fees) ?? {}) });

async function exists(contractorId: string, kind: StatementKind, periodFrom: string): Promise<boolean> {
    return !!(await statementsCol().findOne({ contractorId, kind, periodFrom }));
}
async function create(c: Contractor, kind: StatementKind, from: string, to: string, lines: Record<string, number | string>, gross: number): Promise<StatementDoc | null> {
    if (!(gross >= 0) || !Number.isFinite(gross)) throw new Error('refusing a negative or non-finite statement amount');
    if (await exists(c.id, kind, from)) return null; // idempotent: one statement per contractor, kind and period
    const doc: StatementDoc = { id: crypto.randomBytes(8).toString('hex'), contractorId: c.id, kind, periodFrom: from, periodTo: to, lines, gross: Math.round(gross * 100) / 100, status: 'DRAFT', createdAt: new Date() };
    await statementsCol().insertOne(doc);
    return doc;
}

export const istStart = (d: string) => new Date(`${d}T00:00:00+05:30`);
const istEndExcl = (d: string) => new Date(`${addDays(d, 1)}T00:00:00+05:30`);

// ---------- Beginner ----------
export async function weeklyAccuracyStatement(c: Contractor, week: { from: string; to: string }): Promise<StatementDoc | null> {
    const db = Mongo.getInstance().db;
    const rows = await db.collection('forecasts').find({ contractorId: c.id, day: { $gte: week.from, $lte: week.to } }).toArray() as any[];
    const correct = rows.filter((r) => r.outcome === 'CORRECT');
    if (rows.length === 0) return null;
    const raw = correct.reduce((a, r) => a + (Number(r.feeAmount) > 0 ? Number(r.feeAmount) : 0), 0);
    // the month's cap counts what earlier statements of the same calendar month (by period end) already paid out
    const month = week.to.slice(0, 7);
    const earlier = (await statementsCol().find({ contractorId: c.id, kind: 'ACCURACY_WEEK' }).toArray() as StatementDoc[]).filter((s) => s.periodTo.slice(0, 7) === month && s.periodFrom < week.from);
    const already = earlier.reduce((a, s) => a + s.gross, 0);
    const cap = applyMonthlyCap(raw, Number(feeCfg().monthlyCap), already);
    const lines = { forecasts: rows.length, correct: correct.length, incorrect: rows.filter((r) => r.outcome === 'INCORRECT').length, neutral: rows.filter((r) => r.outcome === 'NEUTRAL').length, void: rows.filter((r) => r.outcome === 'VOID').length, feeBeforeCap: Math.round(raw * 100) / 100, cappedByMonthlyCap: cap.capped ? 1 : 0 };
    return create(c, 'ACCURACY_WEEK', week.from, week.to, lines, cap.gross);
}

export async function monthlyRetainerStatement(c: Contractor, ym: string): Promise<StatementDoc | null> {
    const fc = feeCfg();
    if (!(Number(fc.retainerMonthly) > 0)) return null;
    const dim = daysInMonthOf(ym), from = `${ym}-01`, to = `${ym}-${String(dim).padStart(2, '0')}`;
    const act: string | undefined = (c as any).activatedAt ? new Date((c as any).activatedAt).toISOString().slice(0, 10) : undefined;
    const firstDay = act && act > from ? act : from;
    const lastDay = c.terminatedAt && c.terminatedAt < to ? c.terminatedAt : to;
    if (firstDay > to || lastDay < from) return null;
    const activeDays = Math.max(0, Math.round((toDate(lastDay).getTime() - toDate(firstDay).getTime()) / 86_400_000) + 1);
    const rows = await Mongo.getInstance().db.collection('forecasts').find({ contractorId: c.id, day: { $gte: from, $lte: to } }).toArray() as any[];
    const participation = new Set(rows.map((r) => r.day)).size;
    const r = monthlyRetainer({ retainerMonthly: Number(fc.retainerMonthly), minParticipationDays: Number(fc.minParticipationDays) }, activeDays, dim, participation);
    return create(c, 'RETAINER_MONTH', from, to, { activeDays, daysInMonth: dim, participationDays: participation, note: r.reason }, r.gross);
}

// ---------- Advanced ----------
export async function weeklyAdvancedStatement(c: Contractor, week: { from: string; to: string }, defaultSharePercent: number): Promise<StatementDoc | null> {
    const db = Mongo.getInstance().db;
    const model = feeModelOn((c as any).feeModels, week.to, defaultSharePercent);
    // the model in force on the LAST day of the week applies to the whole week (a change takes effect from its date: a week that spans it uses the new one only if the date is on or before the week's end)
    if (model.model === 'FIXED_PERIOD') return null; // paid per fee period by fixedPeriodStatements, not per week
    const approved = await db.collection('recommendations').find({ contractorId: c.id, status: 'APPROVED', day: { $gte: week.from, $lte: week.to } }).toArray() as any[];
    const trades = await db.collection('closedTrades').find({ user: { $in: tradeUsers(c) }, exitTime: { $gte: istStart(week.from), $lt: istEndExcl(week.to) } }).toArray() as any[];
    if (trades.length === 0 && approved.length === 0) return null;
    const net = trades.reduce((a, t) => a + (Number.isFinite(Number(t.realizedPnL)) ? Number(t.realizedPnL) : 0), 0);
    const pct = Number(model.sharePercent) > 0 ? Number(model.sharePercent) : defaultSharePercent;
    // Clause 6A.2: a loss is carried forward and set off against later weeks' profit before any share is paid; it never reduces an amount already paid and never makes the contractor owe anything.
    const prev = (await statementsCol().find({ contractorId: c.id, kind: 'PROFIT_SHARE_WEEK' }).toArray() as StatementDoc[]).filter((x) => x.periodTo < week.from).sort((a, b) => (a.periodTo < b.periodTo ? -1 : 1)).pop();
    const lossIn = Math.max(0, Number(prev?.lines.lossCarriedForward) || 0);
    const effective = net - lossIn;
    const gross = effective > 0 ? effective * pct / 100 : 0;
    const lossOut = effective < 0 ? -effective : 0;
    return create(c, 'PROFIT_SHARE_WEEK', week.from, week.to, { closedTrades: trades.length, netTradeProfit: Math.round(net * 100) / 100, lossBroughtForward: Math.round(lossIn * 100) / 100, lossCarriedForward: Math.round(lossOut * 100) / 100, sharePercent: pct, effectiveFrom: model.from }, gross);
}

/**
 * Advanced, FIXED_PERIOD (clause 6A.6). For each fee period of a FIXED_PERIOD entry (anchored at the entry's `from`, N months each):
 *   gross = fixedAmount x periodFraction x earnedFraction, where
 *   periodFraction = days the contractor was on this model in the period / days in the full period (a period cut by a later entry or by termination is pro rata by days),
 *   earnedFraction = min(1, max(0, net realized profit of the period's closed trades / reference investment)).
 * A loss pays 0 and nothing carries forward. A period with no approved recommendation gets no statement. A period is settled only once it has ended (or was cut)
 * before `runDate`, so a missed run is caught up on the next one. Idempotent through create().
 */
export async function fixedPeriodStatements(c: Contractor, runDate: string): Promise<StatementDoc[]> {
    const db = Mongo.getInstance().db;
    const all = [...(c.feeModels ?? [])].sort((a, b) => (a.from < b.from ? -1 : 1));
    const out: StatementDoc[] = [];
    for (const e of all.filter((x) => x.model === 'FIXED_PERIOD')) {
        const amount = Number(e.fixedAmount);
        if (!(amount > 0)) continue; // amountless (6A.5 not confirmed): nothing until the owner sets the amount
        const months = Number(e.durationMonths) >= 1 ? Number(e.durationMonths) : fixedFeeMonths();
        const ref = Number(e.referenceInvestment) > 0 ? Number(e.referenceInvestment) : referenceInvestment();
        const nextFrom = all.find((x) => x.from > e.from)?.from;
        const windowEnd = nextFrom ? addDays(nextFrom, -1) : '9999-12-31'; // the entry is in force until the next entry starts
        for (let k = 0; ; k++) {
            const start = addMonths(e.from, k * months);
            if (start > windowEnd || start > runDate) break;
            const fullEnd = addDays(addMonths(e.from, (k + 1) * months), -1);
            let end = fullEnd < windowEnd ? fullEnd : windowEnd;
            if (c.terminatedAt && c.terminatedAt < end) end = c.terminatedAt;
            if (end < start) break; // ended before this period began: later periods are later still
            if (!(end < runDate)) break; // not settled yet
            const approved = await db.collection('recommendations').find({ contractorId: c.id, status: 'APPROVED', day: { $gte: start, $lte: end } }).toArray() as any[];
            if (approved.length === 0) continue;
            const trades = await db.collection('closedTrades').find({ user: { $in: tradeUsers(c) }, exitTime: { $gte: istStart(start), $lt: istEndExcl(end) } }).toArray() as any[];
            const net = trades.reduce((a, t) => a + (Number.isFinite(Number(t.realizedPnL)) ? Number(t.realizedPnL) : 0), 0);
            const frac = daysBetween(start, end) / daysBetween(start, fullEnd);
            const earned = Math.min(1, Math.max(0, net / ref));
            const s = await create(c, 'FIXED_PERIOD', start, end, {
                approvedRecommendations: approved.length, closedTrades: trades.length, netRealizedProfit: Math.round(net * 100) / 100,
                referenceInvestment: ref, fixedAmount: amount, periodMonths: months, periodFraction: Math.round(frac * 10000) / 10000,
                earnedFraction: Math.round(earned * 10000) / 10000, effectiveFrom: e.from,
            }, amount * frac * earned);
            if (s) out.push(s);
        }
    }
    return out;
}

/** The Wednesday job: previous Wednesday-to-Tuesday statements for every non-test contractor that is not terminated (or ended inside the week), and the fee-period settlement of Advanced contractors. Idempotent. */
export async function runWeeklyStatements(runDate: string): Promise<StatementDoc[]> {
    const week = previousWeek(runDate);
    const out: StatementDoc[] = [];
    const share = Number((configService.getConfig() as any)?.settings?.levelRules?.advanced?.profitSplitPercent) || 25;
    for (const c of (await Mongo.getInstance().db.collection('contractors').find({}).toArray()) as Contractor[]) {
        if (c.isTest) continue;
        if (c.type === 'BUSINESS') out.push(...await fixedPeriodStatements(c, runDate)); // before the terminated filter: a terminated contractor's last period is still owed
        if (c.status === 'TERMINATED' && !(c.terminatedAt && c.terminatedAt >= week.from)) continue;
        const s = c.type === 'INDIVIDUAL' ? await weeklyAccuracyStatement(c, week) : await weeklyAdvancedStatement(c, week, share);
        if (s) out.push(s);
    }
    return out;
}
/** The monthly job (the 1st): the previous month's retainer for every non-test Beginner contractor. */
export async function runMonthlyRetainers(runDate: string): Promise<StatementDoc[]> {
    const ym = previousMonth(runDate);
    const out: StatementDoc[] = [];
    for (const c of (await Mongo.getInstance().db.collection('contractors').find({ type: 'INDIVIDUAL' }).toArray()) as Contractor[]) {
        if (c.isTest) continue;
        const s = await monthlyRetainerStatement(c, ym);
        if (s) out.push(s);
    }
    return out;
}

// ---------- approval and payment (the tax-phase gate) ----------
export const taxPhaseComplete = (): boolean => (configService.getConfig() as any)?.forecast?.taxPhaseComplete === true;

export type Step = { ok: true; doc: StatementDoc } | { ok: false; status: number; error: string };
export async function approveStatement(id: string, by: string, contractor: Contractor | null): Promise<Step> {
    const cur = (await statementsCol().findOne({ id })) as StatementDoc | null;
    if (!cur) return { ok: false, status: 404, error: 'Not found' };
    if (contractor && !contractor.isTest && !taxPhaseComplete()) return { ok: false, status: 409, error: 'Payments are locked until the tax phase is complete (forecast.taxPhaseComplete). Statements and accruals keep working.' };
    const r = await statementsCol().updateOne({ id, status: 'DRAFT' }, { $set: { status: 'APPROVED', approvedAt: new Date(), approvedBy: by } });
    if (!r.matchedCount) return { ok: false, status: 409, error: `Statement is ${cur.status}, not DRAFT` };
    return { ok: true, doc: (await statementsCol().findOne({ id })) as StatementDoc };
}
export async function markPaid(id: string, by: string, utr: string, contractor: Contractor | null, now = new Date()): Promise<Step> {
    const cur = (await statementsCol().findOne({ id })) as StatementDoc | null;
    if (!cur) return { ok: false, status: 404, error: 'Not found' };
    if (contractor && !contractor.isTest && !taxPhaseComplete()) return { ok: false, status: 409, error: 'Mark PAID is locked until the tax phase is complete (forecast.taxPhaseComplete).' };
    if (!utr.trim()) return { ok: false, status: 400, error: 'A UTR reference is required' };
    const set: Record<string, unknown> = { status: 'PAID', paidAt: now, paidBy: by, utr: utr.trim() };
    // an Advanced contractor owes an invoice within 2 days of payment, by end of day IST (paid date + 2 days, 23:59)
    if (contractor?.type === 'BUSINESS' && !contractor.isTest) set.invoiceDueAt = new Date(`${addDays(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now), 2)}T23:59:59+05:30`);
    const r = await statementsCol().updateOne({ id, status: 'APPROVED' }, { $set: set });
    if (!r.matchedCount) return { ok: false, status: 409, error: `Statement is ${cur.status}, not APPROVED` };
    return { ok: true, doc: (await statementsCol().findOne({ id })) as StatementDoc };
}

export function statementCsv(s: StatementDoc, c: Contractor): string {
    const rows: [string, string | number][] = [['Contractor', c.name], ['Statement', s.id], ['Kind', s.kind], ['Period from', s.periodFrom], ['Period to', s.periodTo], ...Object.entries(s.lines).map(([k, v]): [string, string | number] => [k, v]), ['Gross amount (INR)', s.gross], ['Status', s.status], ['UTR', s.utr ?? '']];
    return rows.map(([k, v]) => `"${String(k).replace(/"/g, '""')}","${String(v).replace(/"/g, '""')}"`).join('\n') + '\n';
}
