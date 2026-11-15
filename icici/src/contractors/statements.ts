/**
 * Fee statements (spec v2.1 section 10; amounts are GROSS, tax is out of scope and arrives with the tax phase). Kept in their own collection
 * `contractorStatements`: the existing `payouts` collection and its Admin screens are not touched.
 *   Beginner: ACCURACY_WEEK (correct forecasts x the fee snapshotted on each forecast, capped by the month's remaining cap) and RETAINER_MONTH.
 *   Advanced: PROFIT_SHARE_WEEK (a percentage of the net profit of the closed trades of its approved recommendations; a losing week pays 0, nothing carries
 *             forward, nothing is ever charged to the contractor) or, from an effective date, FIXED_PER_APPROVED_WEEK (a fixed amount per approved recommendation).
 * Invariants (tested): no amount is negative, only CORRECT forecasts earn an accuracy fee, no input is the Company's P&L for a Beginner statement,
 * and a fee-model change applies only from its effective date, never to an earlier period.
 */
import * as crypto from 'crypto';
import Mongo from '../tools/mongo';
import configService from '../prism/ConfigService';
import { Contractor } from './types';
import { applyMonthlyCap, monthlyRetainer } from '../forecast/fees';

export type StatementKind = 'ACCURACY_WEEK' | 'RETAINER_MONTH' | 'PROFIT_SHARE_WEEK' | 'FIXED_PER_APPROVED_WEEK';
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

// ---------- fee model of an Advanced contractor, with effective dates ----------
export interface FeeModelEntry { from: string; model: 'PROFIT_SHARE' | 'FIXED_PER_APPROVED'; sharePercent?: number; fixedAmount?: number }
/** The entry in force on `date`: the latest whose `from` is on or before it. A change never reaches back before its own `from`. */
export function feeModelOn(entries: FeeModelEntry[] | undefined, date: string, defaultSharePercent: number): FeeModelEntry {
    const sorted = [...(entries ?? [])].sort((a, b) => (a.from < b.from ? -1 : 1)).filter((e) => e.from <= date);
    return sorted.length ? sorted[sorted.length - 1] : { from: '1970-01-01', model: 'PROFIT_SHARE', sharePercent: defaultSharePercent };
}

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

const istStart = (d: string) => new Date(`${d}T00:00:00+05:30`), istEndExcl = (d: string) => new Date(`${addDays(d, 1)}T00:00:00+05:30`);

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
    const approved = await db.collection('recommendations').find({ contractorId: c.id, status: 'APPROVED', day: { $gte: week.from, $lte: week.to } }).toArray() as any[];
    if (model.model === 'FIXED_PER_APPROVED') {
        if (approved.length === 0) return null;
        const per = Number(model.fixedAmount) > 0 ? Number(model.fixedAmount) : 0;
        return create(c, 'FIXED_PER_APPROVED_WEEK', week.from, week.to, { approvedRecommendations: approved.length, fixedPerApproved: per, effectiveFrom: model.from }, approved.length * per);
    }
    if (!c.pseudoUserId) return null;
    const trades = await db.collection('closedTrades').find({ user: c.pseudoUserId, exitTime: { $gte: istStart(week.from), $lt: istEndExcl(week.to) } }).toArray() as any[];
    if (trades.length === 0 && approved.length === 0) return null;
    const net = trades.reduce((a, t) => a + (Number.isFinite(Number(t.realizedPnL)) ? Number(t.realizedPnL) : 0), 0);
    const pct = Number(model.sharePercent) > 0 ? Number(model.sharePercent) : defaultSharePercent;
    const gross = net > 0 ? net * pct / 100 : 0; // a zero or losing week pays nothing, is never carried forward, and never costs the contractor anything
    return create(c, 'PROFIT_SHARE_WEEK', week.from, week.to, { closedTrades: trades.length, netTradeProfit: Math.round(net * 100) / 100, sharePercent: pct, effectiveFrom: model.from }, gross);
}

/** The Wednesday job: previous Wednesday-to-Tuesday statements for every non-test contractor that is not terminated (or ended inside the week). Idempotent. */
export async function runWeeklyStatements(runDate: string): Promise<StatementDoc[]> {
    const week = previousWeek(runDate);
    const out: StatementDoc[] = [];
    const share = Number((configService.getConfig() as any)?.settings?.levelRules?.advanced?.profitSplitPercent) || 25;
    for (const c of (await Mongo.getInstance().db.collection('contractors').find({}).toArray()) as Contractor[]) {
        if (c.isTest) continue;
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
