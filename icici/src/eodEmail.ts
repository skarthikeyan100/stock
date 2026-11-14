/**
 * End-of-day trading summary email (one per real user who traded that IST day), run ONLY from this machine: `npm run eod-email -- [--date= --user= --dry-run --force]` (src/tools/sendEodEmails.ts; deliberately NO HTTP endpoint)
 * Nothing in this repo schedules it. Template: templates/eodEmail.{html,subject.txt}.
 *
 * Who: users in the `users` collection (role != admin, enabled) with a closed trade exiting, or a fill, on that day. Strategy pseudo-users
 * and the admin's mirrored shares have no such user document / are the admin, so they never get one.
 * Test mode: while settings.eodEmailTestRecipient is set, every email goes to that single address with a `[TEST for <user>]` subject prefix, and is
 * recorded separately from live sends so testing never blocks the real send later.
 * Idempotency: Mongo `eodEmails` holds one record per (date, user, mode); a repeat call skips a sent one unless force=true.
 */
import * as fs from 'fs';
import * as path from 'path';
import Mongo from './tools/mongo';
import Log from './util/Log';
import configService from './prism/ConfigService';
import { getAllUsers, normalizeEmail, User } from './user';
import { computePayout } from './payout';
import { levelLabel, normalizeLevel } from './levelRules';
import { startOfWeek, endOfWeek } from './util/weekWindow';
import { escapeHtml, isMailConfigured, renderTemplate, sendRenderedEmail } from './mailer';
import { buildSignedEodPdf } from './eodPdf';
import { storeUserFile } from './mailStorage';

const TEMPLATE_DIR = path.resolve(__dirname, '..', 'templates');
const IST_OFFSET_MS = 5.5 * 3600_000;

export interface EodTradeRow {
    contract: string;
    quantity: number;
    entryPrice: number | null;
    exitPrice: number | null;
    pnl: number | null; // null = still open
    entryTime: Date | null;
    exitTime: Date | null;
}

export interface EodPayoutLine { invoiceNumber: string; periodStart: Date; periodEnd: Date; netAmount: number; status: string }

export interface EodPayment {
    weekStart: Date;
    weekEnd: Date;
    available: boolean; // false: the estimate could not be computed
    grossProfit: number;
    profitSplitPercent: number;
    splitAmount: number;
    level: string; // 'Beginner' | 'Advanced' at the time of the estimate
    tdsAmount: number;
    gstAmount: number;
    netAmount: number;
    blocked: boolean;
    blockReason?: string;
    destination: string; // masked, or '' when none on file
    recent: EodPayoutLine[];
}

export interface EodReport {
    user: string;
    name: string;
    date: string; // YYYY-MM-DD (IST)
    rows: EodTradeRow[];
    closedCount: number;
    wins: number;
    losses: number;
    openCount: number;
    dayPnl: number;
    payment: EodPayment;
}

// ---------- dates ----------

export function todayIst(now: Date = new Date()): string {
    return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function istDayBounds(date: string): { start: Date; end: Date } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
    const start = new Date(Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS);
    return { start, end: new Date(start.getTime() + 24 * 3600_000) };
}

// ---------- formatting ----------

export function inr(n: number): string {
    return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function signedInr(n: number): string {
    return `${n < 0 ? '-' : n > 0 ? '+' : ''}₹${inr(Math.abs(n))}`;
}
export function hhmm(d: Date | null): string {
    return d ? d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) : '-';
}
export function dayLabel(d: Date): string {
    return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}
const GREEN = '#1a7f37';
const RED = '#c62828';
export const pnlColor = (n: number | null) => (n === null ? '#555555' : n < 0 ? RED : n > 0 ? GREEN : '#555555');

function maskTail(v: string): string {
    return '*'.repeat(Math.max(0, v.length - 4)) + v.slice(-4);
}

function destinationOf(u: User): string {
    const parts: string[] = [];
    if (u.bankAccountNumber) {
        const acct = maskTail(String(u.bankAccountNumber));
        parts.push(`Bank account ${acct}${u.bankIFSC ? ` (${u.bankIFSC})` : ''}${u.bankAccountHolderName ? `, ${u.bankAccountHolderName}` : ''}`);
    }
    if (u.upiId) parts.push(`UPI ${u.upiId}`);
    return parts.join(' / ');
}

// ---------- data ----------

export async function buildEodReports(date: string, onlyUser?: string): Promise<EodReport[]> {
    const { start, end } = istDayBounds(date);
    const db = Mongo.getInstance().db;
    const [closedUsers, openedUsers] = await Promise.all([
        db.collection('closedTrades').distinct('user', { exitTime: { $gte: start, $lt: end } }),
        db.collection('Trade').distinct('user', { entryTime: { $gte: start, $lt: end } }),
    ]);
    const traded = new Set<string>([...closedUsers, ...openedUsers].map((u) => normalizeEmail(String(u))));
    // Everyone is limited to users who traded that day, except a user named explicitly (npm run eod-email -- --user=...): that one is
    // included even with no trades, so the operator can send/preview a single person's (empty-day) email on request.
    // A named user may also be the admin (their own trades are recorded under the admin account); the unnamed run never emails the admin.
    const everyone = (await getAllUsers()).filter((u) => u.enabled !== false);
    const wanted = onlyUser
        ? everyone.filter((u) => normalizeEmail(u.email) === normalizeEmail(onlyUser))
        : everyone.filter((u) => u.role !== 'admin' && traded.has(normalizeEmail(u.email)));

    const reports: EodReport[] = [];
    for (const u of wanted) {
        const email = normalizeEmail(u.email);
        // Trades are stored under the user's email; match case-insensitively on what was stored.
        const userKeys = [...new Set([u.email, email])];
        const closed = await db.collection('closedTrades').find({ user: { $in: userKeys }, exitTime: { $gte: start, $lt: end } }).sort({ exitTime: 1 }).toArray();
        const open = await openPositions(u, userKeys, start, end);

        const rows: EodTradeRow[] = [
            ...closed.map((t: any) => ({
                contract: String(t.tsym ?? t.token ?? ''), quantity: Number(t.quantity) || 0, entryPrice: num(t.entryPrice), exitPrice: num(t.exitPrice),
                pnl: Number(t.realizedPnL) || 0, entryTime: toDate(t.entryTime), exitTime: toDate(t.exitTime),
            })),
            ...open,
        ];
        const closedRows = rows.filter((r) => r.pnl !== null);
        reports.push({
            user: u.email,
            name: u.legalName || u.name || u.email,
            date,
            rows,
            closedCount: closedRows.length,
            wins: closedRows.filter((r) => (r.pnl as number) > 0).length,
            losses: closedRows.filter((r) => (r.pnl as number) < 0).length,
            openCount: open.length,
            dayPnl: closedRows.reduce((s, r) => s + (r.pnl as number), 0),
            payment: await buildPayment(u, start),
        });
    }
    return reports;
}

// `Trade` is a fill ledger (a Buy row and a Sell row per leg, `open: true` on all of them), not a position table: a contract is open when its
// Buys exceed its Sells. Looks back 7 days (an overnight carry is still shown; an old never-sold, long-expired contract is not).
async function openPositions(_u: User, userKeys: string[], start: Date, end: Date): Promise<EodTradeRow[]> {
    const since = new Date(start.getTime() - 7 * 24 * 3600_000);
    const fills = await Mongo.getInstance().db.collection('Trade')
        .find({ user: { $in: userKeys }, action: { $in: ['Buy', 'Sell'] }, entryTime: { $gte: since, $lt: end } }).sort({ entryTime: 1 }).toArray();
    const byContract = new Map<string, { contract: string; net: number; buyQty: number; buyValue: number; first: Date | null }>();
    for (const f of fills as any[]) {
        const key = String(f.token ?? f.tsym ?? '');
        if (!key) continue;
        const g = byContract.get(key) ?? { contract: String(f.tsym ?? f.token), net: 0, buyQty: 0, buyValue: 0, first: null };
        const qty = Number(f.quantity) || 0;
        if (f.action === 'Buy') {
            g.net += qty; g.buyQty += qty; g.buyValue += qty * (Number(f.price) || 0);
            g.first = g.first ?? toDate(f.entryTime);
        } else g.net -= qty;
        byContract.set(key, g);
    }
    return [...byContract.values()].filter((g) => g.net > 0).map((g) => ({
        contract: g.contract, quantity: g.net, entryPrice: g.buyQty > 0 ? g.buyValue / g.buyQty : null, exitPrice: null, pnl: null, entryTime: g.first, exitTime: null,
    }));
}

function num(v: unknown): number | null {
    const n = Number(v);
    return v == null || !Number.isFinite(n) ? null : n;
}
function toDate(v: unknown): Date | null {
    if (!v) return null;
    const d = new Date(v as any);
    return Number.isNaN(d.getTime()) ? null : d;
}

async function buildPayment(u: User, dayStart: Date): Promise<EodPayment> {
    const weekStart = startOfWeek(dayStart);
    const weekEnd = new Date(endOfWeek(dayStart).getTime() + 1); // exclusive, like every payout period
    const base: EodPayment = {
        weekStart, weekEnd, available: false, grossProfit: 0, profitSplitPercent: u.profitSplitPercent ?? 0, splitAmount: 0, level: levelLabel(normalizeLevel(u.proficiencyLevel)), tdsAmount: 0, gstAmount: 0, netAmount: 0,
        blocked: false, destination: destinationOf(u), recent: [],
    };
    try {
        const c = await computePayout(u.email, weekStart, weekEnd);
        Object.assign(base, {
            available: true, grossProfit: c.grossProfit, profitSplitPercent: c.profitSplitPercent, splitAmount: c.splitAmount,
            level: levelLabel(c.proficiencyLevel),
            tdsAmount: c.tdsAmount, gstAmount: c.gstAmount, netAmount: c.netAmount, blocked: c.blocked, blockReason: c.blockReason,
        });
    } catch (e: any) {
        Log.log(`[eod-email] payout estimate failed for ${u.email}: ${e?.message ?? e}`);
    }
    try {
        const docs = await Mongo.getInstance().db.collection('payouts').find({ user: u.email }).sort({ createdAt: -1 }).limit(3).toArray();
        base.recent = docs.map((p: any) => ({
            invoiceNumber: String(p.invoiceNumber ?? ''), periodStart: new Date(p.periodStart), periodEnd: new Date(p.periodEnd),
            netAmount: Number(p.netAmount) || 0, status: String(p.status ?? ''),
        }));
    } catch (e: any) {
        Log.log(`[eod-email] payout history failed for ${u.email}: ${e?.message ?? e}`);
    }
    return base;
}

// ---------- rendering ----------

export function renderEodEmail(r: EodReport): { subject: string; html: string } {
    const { start } = istDayBounds(r.date);
    const label = dayLabel(start);
    const escaped: Record<string, string> = {
        name: r.name, dateLabel: label, dayPnlSigned: signedInr(r.dayPnl), pnlColor: pnlColor(r.dayPnl), closedCount: String(r.closedCount),
        winLoss: `${r.wins} won / ${r.losses} lost`, openCount: String(r.openCount),
    };
    // Plain values are escaped here; the HTML fragments are built from escaped parts above.
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(escaped)) vars[k] = escapeHtml(v);
    const html = renderTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, 'eodEmail.html'), 'utf8'), vars, false);
    const subject = renderTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, 'eodEmail.subject.txt'), 'utf8'), { dateLabel: label, dayPnlSigned: signedInr(r.dayPnl) }, false)
        .replace(/\s+/g, ' ').trim();
    return { subject, html };
}

// ---------- sending ----------

export interface EodSendResult {
    user: string;
    to: string;
    status: 'sent' | 'skipped' | 'failed' | 'dryRun';
    reason?: string;
    subject?: string;
    html?: string; // dry run only
    pdfSha256?: string; // SHA-256 of the signed PDF that was (or, on a dry run, would be) attached
    pdfBytes?: number;
}

export function testRecipient(): string | null {
    try {
        const v = (configService.getConfig()?.settings as any)?.eodEmailTestRecipient;
        return v ? String(v).trim() : null;
    } catch {
        return null;
    }
}

const inFlight = new Set<string>();

export async function sendEodEmails(opts: { date: string; dryRun?: boolean; force?: boolean; user?: string }): Promise<{ date: string; mode: 'test' | 'live'; testRecipient: string | null; results: EodSendResult[] }> {
    const { date, dryRun = false, force = false } = opts;
    istDayBounds(date); // validates
    const test = testRecipient();
    const mode = test ? 'test' : 'live';
    if (!dryRun && !isMailConfigured()) throw new Error('Gmail is not configured (set GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in .env)');
    const records = Mongo.getInstance().db.collection('eodEmails');
    await records.createIndex({ date: 1, user: 1, mode: 1 }, { unique: true }).catch(() => undefined);

    const reports = await buildEodReports(date, opts.user);
    const results: EodSendResult[] = [];
    for (const r of reports) {
        const rendered = renderEodEmail(r);
        const to = test ?? r.user;
        const subject = test ? `[TEST for ${r.user}] ${rendered.subject}` : rendered.subject;
        if (dryRun) {
            try { const p = await buildSignedEodPdf(r); results.push({ user: r.user, to, status: 'dryRun', subject, html: rendered.html, pdfSha256: p.sha256, pdfBytes: p.pdf.length }); }
            catch (e: any) { results.push({ user: r.user, to, status: 'failed', reason: `PDF: ${e?.message ?? e}` }); }
            continue;
        }
        const key = `${date}|${r.user}|${mode}`;
        if (inFlight.has(key)) { results.push({ user: r.user, to, status: 'skipped', reason: 'a send for this user is already in progress' }); continue; }
        inFlight.add(key);
        try {
            if (!force && await records.findOne({ date, user: r.user, mode, status: 'sent' })) {
                results.push({ user: r.user, to, status: 'skipped', reason: 'already sent (use force=true to resend)' });
                continue;
            }
            // The PDF is part of the email: if it cannot be built and signed, nothing is sent (never a body-only email).
            const att = await buildSignedEodPdf(r);
            await sendRenderedEmail(to, subject, rendered.html, [
                { filename: 'logo.png', path: path.join(TEMPLATE_DIR, 'logo.png'), cid: 'nivedha-logo', contentDisposition: 'inline' },
                { filename: att.filename, content: att.pdf, contentType: 'application/pdf' },
            ]);
            // Keep a copy of what was sent (./storage/<user>/). The email is already out, so a storage problem is recorded, never turned into a failed send.
            let storedAt: string | undefined; let storageError: string | undefined;
            try { storedAt = storeUserFile(r.user, !!test, { filename: att.filename, content: att.pdf }); } catch (e: any) { storageError = e?.message ?? String(e); Log.log(`[eod-email] could not store the PDF copy for ${r.user}: ${storageError}`); }
            await records.updateOne({ date, user: r.user, mode }, { $set: { to, subject, status: 'sent', sentAt: new Date(), pdfSha256: att.sha256, pdfFilename: att.filename, ...(storedAt ? { storedAt } : {}), ...(storageError ? { storageError } : {}) }, $unset: { error: '' } }, { upsert: true });
            results.push({ user: r.user, to, status: 'sent', subject, pdfSha256: att.sha256, pdfBytes: att.pdf.length });
        } catch (e: any) {
            const error = e?.message ?? String(e);
            Log.log(`[eod-email] send to ${to} (for ${r.user}) failed: ${error}`);
            await records.updateOne({ date, user: r.user, mode }, { $set: { to, subject, status: 'failed', error, failedAt: new Date() } }, { upsert: true }).catch(() => undefined);
            results.push({ user: r.user, to, status: 'failed', reason: error });
        } finally {
            inFlight.delete(key);
        }
    }
    return { date, mode, testRecipient: test, results };
}
