/**
 * Invoice rule for users who became Advanced by giving a GSTIN: for every PAID payout they owe the platform an invoice by `paidAt + 2 days`
 * (23:59:59 Asia/Kolkata); not received by then, the account is closed (an admin reopens it once the invoice arrives and marks it received).
 * Payout fields (set when the payout is marked paid, only for such users): invoiceStatus 'pending'|'received', invoiceDueAt, invoiceReceivedAt,
 * invoiceReminderSentAt, invoiceClosedAt (stamped when the closure ran, so an admin's reopen is not undone by the next hourly run).
 * runInvoiceCheck runs hourly in the frontend process (server.ts) and on demand: `npm run check-invoices`.
 */
import Mongo from './tools/mongo';
import Log from './util/Log';
import { getUser, closeUserAccount } from './user';
import { normalizeLevel } from './levelRules';
import { escapeHtml, isMailConfigured, sendRenderedEmail } from './mailer';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Payment date + 2 calendar days, end of that day in IST (the IST day, not the UTC day, so a late-night payment is not a day short). */
export function invoiceDueAt(paidAt: Date): Date {
    const ist = new Date(paidAt.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 2, 23, 59, 59) - IST_OFFSET_MS);
}

export function invoiceRequired(u: { advancedVia?: string; gstin?: string; entityType?: string; proficiencyLevel?: unknown }): boolean {
    return u.advancedVia === 'gstin' && typeof u.gstin === 'string' && u.gstin.trim() !== '' && u.entityType === 'company' && normalizeLevel(u.proficiencyLevel) === 'advanced';
}

export function overduePayouts<T extends { invoiceStatus?: string; invoiceDueAt?: Date; invoiceClosedAt?: Date }>(payouts: T[], now: Date): T[] {
    return payouts.filter((p) => p.invoiceStatus === 'pending' && p.invoiceDueAt && new Date(p.invoiceDueAt).getTime() < now.getTime() && !p.invoiceClosedAt);
}

export interface InvoiceCheckDeps {
    remind: (payout: any, user: any) => Promise<void>;
    closeAccount: (user: any, payout: any) => Promise<void>;
}

const defaultDeps: InvoiceCheckDeps = {
    remind: async (payout, user) => {
        if (!isMailConfigured()) { Log.log('[invoice] mail is not configured: reminder for', payout.invoiceNumber, 'not sent'); return; }
        const { testRecipient } = await import('./eodEmail'); // lazy: eodEmail imports payout, which imports this file
        const test = testRecipient();
        const due = new Date(payout.invoiceDueAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        const subject = `${test ? `[TEST for ${user.email}] ` : ''}Invoice due for payout ${payout.invoiceNumber}`;
        const html = `<p>Hello ${escapeHtml(user.legalName || user.name || user.email)},</p><p>We have not yet received your invoice for payout <b>${escapeHtml(String(payout.invoiceNumber))}</b>. It is due by <b>${escapeHtml(due)}</b> (IST). If it does not reach us by then, your account will be closed.</p><p>Please send the invoice to admin@nivedhatech.com.</p>`;
        await sendRenderedEmail(test ?? user.email, subject, html);
    },
    closeAccount: async (user, payout) => {
        await closeUserAccount(user.email, `Invoice not received for payout ${payout.invoiceNumber}`);
        const closed = await getUser(user.email);
        if (closed) { const { pushUserToOrderProcess } = await import('./routes/session'); await pushUserToOrderProcess(closed, 'invoice-closure'); }
    },
};

export async function runInvoiceCheck(now: Date = new Date(), deps: InvoiceCheckDeps = defaultDeps): Promise<{ reminded: string[]; closed: string[] }> {
    const col = Mongo.getInstance().db.collection('payouts');
    const pending = await col.find({ invoiceStatus: 'pending' }).toArray();
    const reminded: string[] = []; const closed: string[] = [];
    for (const p of pending) {
        try {
            const user = await getUser(p.user);
            if (!user) continue;
            const due = new Date(p.invoiceDueAt).getTime();
            if (overduePayouts([p], now).length) {
                if (user.accountClosed !== true) { await deps.closeAccount(user, p); closed.push(user.email); }
                await col.updateOne({ _id: p._id }, { $set: { invoiceClosedAt: now } });
            } else if (due - now.getTime() <= DAY_MS && due > now.getTime() && !p.invoiceReminderSentAt) {
                await deps.remind(p, user);
                await col.updateOne({ _id: p._id }, { $set: { invoiceReminderSentAt: now } });
                reminded.push(String(p.invoiceNumber ?? p._id));
            }
        } catch (e) { Log.log('[invoice] check failed for payout', String(p._id), e); }
    }
    return { reminded, closed };
}
