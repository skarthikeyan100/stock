/** Contractor emails (spec v2.1 section 11): the welcome email after acceptance and the daily transactions email. New files; eodEmail.ts and welcomeEmail.ts are untouched. */
import * as fs from 'fs';
import * as path from 'path';
import Log from '../util/Log';
import Mongo from '../tools/mongo';
import { escapeHtml, renderTemplate } from '../mailer';
import { istDayBounds, todayIst } from '../eodEmail';
import { Contractor, tradeUsers } from './types';
import { contractorsCol } from './store';
import { readAgreement } from './agreements';
import { sendContractorEmail } from './email';
import { readStored } from './personalise';

const TEMPLATE_DIR = path.resolve(__dirname, '..', '..', 'templates');
const kindOf = (c: Contractor) => (c.type === 'INDIVIDUAL' ? 'Individual (PAN)' : 'Business (GSTIN)');

const WHAT: Record<Contractor['type'], string> = {
    INDIVIDUAL: 'You submit Flash Forecasts: whether NIFTY 50 will move Up or Down over the forecast window, during the forecasting hours in your agreement, up to the daily limit. A forecast cannot be edited or withdrawn once recorded, and is scored from the index value at the time you submit it.',
    BUSINESS: 'You submit research recommendations for NIFTY option contracts (strike, CE or PE, entry, target and stop loss). We review each one and approve or reject it; we decide whether to trade and how.',
};
const PAY: Record<Contractor['type'], string> = {
    INDIVIDUAL: 'A monthly retainer and a fixed fee for each correct forecast, as set out in Schedule 1 of your agreement. Incorrect or neutral forecasts earn nothing and never cost you anything. Your fees do not depend on whether or how we traded.',
    BUSINESS: 'The profit share on trades that come from your approved recommendations, settled weekly (Wednesday to Tuesday) against your invoice, as set out in clause 6A and Schedule 1 of your agreement. You never bear a loss.',
};
const SEE: Record<Contractor['type'], string> = {
    INDIVIDUAL: 'Your own forecasts and outcomes, your accuracy, and the entry price and live profit or loss of trades that came from your own forecasts, read-only.',
    BUSINESS: 'Your own recommendations and their status, and the entry price and live profit or loss of trades that came from your approved recommendations, read-only.',
};

export function renderWelcome(c: Contractor, version: string, acceptedAt: Date): { subject: string; html: string } {
    const vars = { name: c.name, kind: kindOf(c), version, agreementName: c.type === 'BUSINESS' ? 'Research Analyst Services Agreement' : 'Forecasting Services Agreement', what: WHAT[c.type], pay: PAY[c.type], see: SEE[c.type],
        acceptedAt: acceptedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) };
    return {
        subject: fs.readFileSync(path.join(TEMPLATE_DIR, 'contractorWelcomeEmail.subject.txt'), 'utf8').replace(/\s+/g, ' ').trim(),
        html: renderTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, 'contractorWelcomeEmail.html'), 'utf8'), vars, true),
    };
}

/** Sent once per contractor, right after the first acceptance (a re-invite does not send it again). The test user gets none. Never throws: a failed send is logged. */
export async function sendWelcomeIfDue(c: Contractor): Promise<void> {
    try {
        if (c.isTest) return;
        const fresh = (await contractorsCol().findOne({ id: c.id })) as any;
        if (!fresh || fresh.welcomeEmailSentAt) return;
        const version = fresh.agreementVersion as string;
        const ag = readAgreement(c.type, version);
        const mine = readStored(fresh.agreementFile); // the copy with their details filled in, when there is one
        const { subject, html } = renderWelcome(c, version, fresh.agreementAcceptedAt ?? new Date());
        // claim first so two quick accepts cannot both send
        const claim = await contractorsCol().updateOne({ id: c.id, welcomeEmailSentAt: { $exists: false } }, { $set: { welcomeEmailSentAt: new Date() } });
        if (!claim.matchedCount) return;
        try {
            const sent = await sendContractorEmail(c.email, subject, html, [{ filename: ag.filename, content: mine ?? ag.bytes, contentType: 'application/pdf' }]);
            Log.log(`[contractor] welcome email sent to ${sent.redirectedTo ? `${sent.redirectedTo} (test redirect for ${c.email})` : c.email}`);
        } catch (e) {
            await contractorsCol().updateOne({ id: c.id }, { $unset: { welcomeEmailSentAt: '' } }); // release, so a retry is possible
            throw e;
        }
    } catch (e: any) { Log.log('[contractor] welcome email failed:', e?.message ?? e); }
}

// ---------- daily transactions email ----------
export interface DayItems {
    forecasts: { submittedAt: Date; direction: string; confidence?: string; outcome: string }[];
    recommendations: { createdAt: Date; contract: string; entry: number; target: number; stop: number; status: string }[];
    trades: { contract: string; entryPrice: number | null; pnl: number | null; exitTime: Date | null }[];
}
const money = (n: number | null) => (n == null ? '–' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const hm = (d: Date) => d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
const table = (head: string[], rows: string[][]) => `<table style="border-collapse:collapse;width:100%;font-size:13px;margin:0 0 16px"><tr>${head.map((h) => `<th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 6px">${escapeHtml(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((x) => `<td style="border-bottom:1px solid #eee;padding:4px 6px">${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</table>`;

export function hasActivity(d: DayItems): boolean { return d.forecasts.length + d.recommendations.length + d.trades.length > 0; }

export function renderDaily(c: Contractor, date: string, d: DayItems): { subject: string; html: string } {
    let body = `<p style="margin:0 0 14px">Hi ${escapeHtml(c.name)}, here is your own activity for ${escapeHtml(date)}.</p>`;
    if (c.type === 'INDIVIDUAL') {
        body += `<h3 style="margin:0 0 8px;font-size:15px;color:#1f3a5f">Your forecasts</h3>` + (d.forecasts.length ? table(['Time', 'Direction', 'Confidence', 'Outcome'], d.forecasts.map((f) => [hm(f.submittedAt), f.direction, f.confidence ?? '–', f.outcome])) : '<p>None today.</p>');
    } else {
        body += `<h3 style="margin:0 0 8px;font-size:15px;color:#1f3a5f">Your recommendations</h3>` + (d.recommendations.length ? table(['Time', 'Contract', 'Entry', 'Target', 'Stop', 'Status'], d.recommendations.map((r) => [hm(r.createdAt), r.contract, String(r.entry), String(r.target), String(r.stop), r.status.toLowerCase()])) : '<p>None today.</p>');
    }
    body += `<h3 style="margin:0 0 8px;font-size:15px;color:#1f3a5f">Trades that came from them (closed today)</h3>` + (d.trades.length ? table(['Contract', 'Entry price', 'Closed', 'Profit / loss'], d.trades.map((t) => [t.contract, money(t.entryPrice), t.exitTime ? hm(t.exitTime) : '–', money(t.pnl)])) : '<p>None closed today. A position still open is not listed here; see the portal for its live value.</p>');
    const html = `<div style="background:#f4f5f7;padding:24px 0;font-family:Arial,Helvetica,sans-serif;color:#222"><div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e3e5e8;border-radius:8px;overflow:hidden"><div style="background:#1f3a5f;color:#fff;padding:18px 24px"><div style="font-size:18px;font-weight:bold">Nivedha Tech</div><div style="font-size:13px;opacity:.85">Your day</div></div><div style="padding:24px;font-size:14px;line-height:1.5">${body}<p style="margin:0;font-size:12px;color:#888;border-top:1px solid #e3e5e8;padding-top:14px">Automated email from Nivedha Tech. Questions: admin@nivedhatech.com</p></div></div></div>`;
    return { subject: `Your Nivedha Tech activity for ${date}`, html };
}

export async function gatherDay(c: Contractor, date: string): Promise<DayItems> {
    const db = Mongo.getInstance().db;
    const { start, end } = istDayBounds(date);
    const forecasts = c.type === 'INDIVIDUAL' ? await db.collection('forecasts').find({ contractorId: c.id, submittedAt: { $gte: start, $lt: end } }).sort({ submittedAt: 1 }).toArray() : [];
    const recs = c.type === 'BUSINESS' ? await db.collection('recommendations').find({ contractorId: c.id, day: date }).sort({ createdAt: 1 }).toArray() : [];
    const trades = await db.collection('closedTrades').find({ user: { $in: tradeUsers(c) }, exitTime: { $gte: start, $lt: end } }).sort({ exitTime: 1 }).toArray();
    return {
        forecasts: forecasts.map((f: any) => ({ submittedAt: f.submittedAt, direction: f.direction, confidence: f.confidence ?? undefined, outcome: f.outcome })),
        recommendations: recs.map((r: any) => ({ createdAt: r.createdAt, contract: `${r.index} ${r.contract}`, entry: r.entry, target: r.target, stop: r.stop, status: r.status })),
        trades: trades.map((t: any) => ({ contract: t.tsym, entryPrice: typeof t.price === 'number' ? t.price : null, pnl: typeof t.realizedPnL === 'number' ? t.realizedPnL : null, exitTime: t.exitTime ?? null })),
    };
}

export interface DailyOptions { date?: string; dryRun?: boolean; force?: boolean; contractorId?: string }
export interface DailyResult { contractor: string; status: 'sent' | 'dry-run' | 'skipped' | 'failed'; reason?: string; to?: string }

/** One email per ACTIVE, non-test contractor with something to report (a contractor with no activity gets none: my call, to avoid daily noise). Marker per contractor per date. */
export async function runDailyEmails(o: DailyOptions = {}): Promise<{ date: string; results: DailyResult[] }> {
    const date = o.date ?? todayIst();
    const marks = Mongo.getInstance().db.collection('contractorDailyEmails');
    const out: DailyResult[] = [];
    for (const c of (await contractorsCol().find({ status: 'ACTIVE' }).toArray()) as Contractor[]) {
        if (c.isTest || (o.contractorId && c.id !== o.contractorId)) continue;
        try {
            if (!o.force && !o.dryRun && (await marks.findOne({ contractorId: c.id, date }))) { out.push({ contractor: c.email, status: 'skipped', reason: 'already sent' }); continue; }
            const items = await gatherDay(c, date);
            if (!hasActivity(items)) { out.push({ contractor: c.email, status: 'skipped', reason: 'no activity' }); continue; }
            const { subject, html } = renderDaily(c, date, items);
            if (o.dryRun) { out.push({ contractor: c.email, status: 'dry-run', reason: subject }); continue; }
            const sent = await sendContractorEmail(c.email, subject, html);
            await marks.insertOne({ contractorId: c.id, date, sentAt: new Date() });
            out.push({ contractor: c.email, status: 'sent', to: sent.redirectedTo ?? sent.to });
        } catch (e: any) { out.push({ contractor: c.email, status: 'failed', reason: String(e?.message ?? e) }); }
    }
    return { date, results: out };
}
