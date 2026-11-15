/** Hourly jobs of the contractor portal (started from server.ts). */
import Log from '../util/Log';
import { contractorsCol } from './store';
import { currentVersion, istDate } from './agreements';
import { daysUntil } from './validate';
import { recommendationsCol, istHHMM } from './recommendations';
import { notifyAdmins } from './notify';
import { StatementDoc, runMonthlyRetainers, runWeeklyStatements, statementsCol } from './statements';
import { notifyUser } from './notify';

/** When a new agreement version takes effect every contractor on an older one goes to AGREEMENT_PENDING and must accept it (spec section 4). */
export async function runAgreementVersionSwitch(): Promise<number> {
    const version = await currentVersion();
    const stale = (await contractorsCol().find({ status: 'ACTIVE' }).toArray()).filter((c: any) => c.agreementVersion !== version);
    for (const c of stale) {
        const r = await contractorsCol().updateOne({ id: c.id, status: 'ACTIVE' }, { $set: { status: 'AGREEMENT_PENDING', statusReason: `Please accept agreement v${version}` } });
        if (r.matchedCount) await notifyUser(c.email, 'agreement_pending', `A new agreement (v${version}) is in force. Please read and accept it to continue.`);
    }
    if (stale.length) Log.log(`[contractor] ${stale.length} contractor(s) moved to AGREEMENT_PENDING for v${version}`);
    return stale.length;
}

/** A recommendation not decided by the end of its day lapses (spec section 9): it is never auto-approved, only expired. */
export async function expireStaleRecommendations(now = new Date()): Promise<number> {
    const day = istDate(now);
    const pastClose = istHHMM(now) >= '15:30';
    const open = (await recommendationsCol().find({ status: 'PENDING' }).toArray()) as any[];
    let n = 0;
    for (const r of open) {
        if (!(r.day < day || pastClose)) continue;
        const u = await recommendationsCol().updateOne({ _id: r._id, status: 'PENDING' }, { $set: { status: 'EXPIRED', decidedAt: now } });
        if (u.matchedCount) { n++; await notifyUser(r.contractorEmail, 'recommendation_decision', `${r.contract} was not approved in time and has lapsed.`); await notifyAdmins('approval_resolved', `${r.contractorName} ${r.contract}: lapsed.`, { recommendationId: String(r._id) }); }
    }
    return n;
}

/** PAID Advanced statements whose invoice is overdue (paid date + 2 days, 23:59 IST) pause the contractor: new recommendations are blocked, fees are never clawed back (spec section 8). */
export async function runInvoiceChecks(now = new Date()): Promise<number> {
    let n = 0;
    for (const s of (await statementsCol().find({ status: 'PAID' }).toArray()) as StatementDoc[]) {
        if (!s.invoiceDueAt || s.invoice || s.invoiceFlagged || s.invoiceDueAt.getTime() >= now.getTime()) continue;
        await statementsCol().updateOne({ id: s.id }, { $set: { invoiceFlagged: true } });
        const r = await contractorsCol().updateOne({ id: s.contractorId, status: 'ACTIVE' }, { $set: { status: 'PAUSED_INVOICE', statusReason: 'Invoice overdue' } });
        const c: any = await contractorsCol().findOne({ id: s.contractorId });
        if (r.matchedCount && c) { n++; await notifyUser(c.email, 'status', 'An invoice is overdue, so new recommendations are paused. Upload it to continue.'); await notifyAdmins('invoice_overdue', `${c.name}: invoice overdue for statement ${s.periodFrom} to ${s.periodTo}.`, { contractorId: c.id }); }
    }
    return n;
}

/** Alerts the owner 30 days before an Advanced contractor's SEBI registration expires (once), and again once it has expired (spec section 5). Submission is blocked on the valid-until date by sebiUsable(). */
export async function runSebiExpiryAlerts(now = new Date()): Promise<number> {
    const today = istDate(now);
    let n = 0;
    for (const c of (await contractorsCol().find({ type: 'BUSINESS' }).toArray()) as any[]) {
        if (c.status === 'TERMINATED' || !c.sebi?.validUntil) continue;
        const days = daysUntil(c.sebi.validUntil, today);
        const stage = days < 0 ? 'expired' : days <= 30 ? 'soon' : null;
        if (!stage || c.sebi.alertStage === stage) continue;
        const r = await contractorsCol().updateOne({ id: c.id }, { $set: { 'sebi.alertStage': stage, 'sebi.expiryAlertSentAt': now } });
        if (!r.matchedCount) continue;
        n++;
        await notifyAdmins('sebi_expiry', stage === 'soon' ? `${c.name}: the SEBI registration ${c.sebi.number} expires on ${c.sebi.validUntil} (${days} days). Ask for the renewed date.` : `${c.name}: the SEBI registration ${c.sebi.number} EXPIRED on ${c.sebi.validUntil}. Recommendations are blocked until a renewed date is recorded and verified.`, { contractorId: c.id });
        if (stage === 'expired') await notifyUser(c.email, 'status', 'Your SEBI registration has expired, so new recommendations are blocked. Record the renewed date on your profile.');
    }
    return n;
}

export async function runContractorHourlyJobs(now = new Date()): Promise<void> {
    await runAgreementVersionSwitch();
    await runSebiExpiryAlerts(now);
    await expireStaleRecommendations();
    await runInvoiceChecks(now);
    // Statements are created idempotently, so running these every hour from 06:00 on the right day is safe (a missed hour is caught by the next).
    const day = istDate(now);
    if (istHHMM(now) >= '06:00') {
        const wd = new Date(day + 'T00:00:00Z').getUTCDay();
        if (wd === 3) await runWeeklyStatements(day);
        if (day.endsWith('-01')) await runMonthlyRetainers(day);
    }
}
