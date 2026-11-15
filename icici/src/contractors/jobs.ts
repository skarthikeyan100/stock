/** Hourly jobs of the contractor portal (started from server.ts). */
import Log from '../util/Log';
import { contractorsCol } from './store';
import { currentVersion, istDate } from './agreements';
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

export async function runContractorHourlyJobs(now = new Date()): Promise<void> {
    await runAgreementVersionSwitch();
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
