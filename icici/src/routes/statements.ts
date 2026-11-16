/** Fee statements: the contractor's own list, CSV and (Advanced) invoice upload; the owner's approval, Mark PAID (locked until the tax phase), manual runs and fee-model changes. Spec v2.1 sections 8 and 10. */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import Log from '../util/Log';
import { asyncRouter } from './asyncRouter';
import { requireAdmin, requireAuth, resolveRealUser, resolveUser, invalidateUserCache } from './session';
import { upload, detectDocumentType } from './users';
import { contractorsCol, getContractor, getContractorByEmail } from '../contractors/store';
import { Contractor } from '../contractors/types';
import { StatementDoc, addDays, approveStatement, fixedFeeMonths, markPaid, referenceInvestment, runMonthlyRetainers, runWeeklyStatements, statementCsv, statementsCol, taxPhaseComplete } from '../contractors/statements';
import { istDate } from '../contractors/agreements';
import { validIsoDate } from '../contractors/validate';
import { notifyAdmins, notifyUser } from '../contractors/notify';
import { storageRoot } from '../mailStorage';

const router = asyncRouter();
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ownView = (s: StatementDoc) => ({ id: s.id, kind: s.kind, periodFrom: s.periodFrom, periodTo: s.periodTo, lines: s.lines, gross: s.gross, status: s.status, paidAt: s.paidAt ?? null, utr: s.utr ?? null,
    invoiceDueAt: s.invoiceDueAt ?? null, invoice: s.invoice ? { number: s.invoice.number, date: s.invoice.date, uploadedAt: s.invoice.uploadedAt } : null });
async function me(req: express.Request): Promise<Contractor | null> { const e = resolveUser(req); return e ? getContractorByEmail(e) : null; }

// ---------- contractor ----------
router.get('/contractor/statements', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c || c.isTest) { res.json([]); return; }
    const rows = (await statementsCol().find({ contractorId: c.id, status: { $ne: 'DRAFT' } }).sort({ periodFrom: -1 }).toArray()) as StatementDoc[]; // a draft is not shown until the owner approves it
    res.json(rows.map(ownView));
});
router.get('/contractor/statements/:id/csv', requireAuth, async function (req, res) {
    const c = await me(req);
    const s = c ? ((await statementsCol().findOne({ id: req.params.id, contractorId: c.id })) as StatementDoc | null) : null;
    if (!c || !s || s.status === 'DRAFT') { res.status(404).json({ error: 'Not found' }); return; }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="statement-${s.periodFrom}-${s.kind}.csv"` }).send(statementCsv(s, c));
});

const invoiceDir = (contractorId: string) => path.join(storageRoot(false), '_invoices', contractorId.replace(/[^a-z0-9]/gi, '_'));
/** Advanced: the invoice for a PAID statement (PDF, number, date). Uploading restores access if the contractor was paused for it. */
router.post('/contractor/statements/:id/invoice', requireAuth, upload.single('invoice'), async function (req, res) {
    const c = await me(req);
    if (!c || c.type !== 'BUSINESS') { res.status(403).json({ error: 'Invoices are for Research Analysts (Business, GSTIN)' }); return; }
    const s = (await statementsCol().findOne({ id: req.params.id, contractorId: c.id })) as StatementDoc | null;
    if (!s || s.status !== 'PAID' || !s.invoiceDueAt) { res.status(404).json({ error: 'No invoice is due for that statement' }); return; }
    if (s.invoice) { res.status(409).json({ error: 'An invoice was already uploaded for this statement' }); return; }
    const number = str(req.body?.number, 60), date = str(req.body?.date);
    if (!number) { res.status(400).json({ error: 'The invoice number is required' }); return; }
    if (!validIsoDate(date)) { res.status(400).json({ error: 'The invoice date is required (YYYY-MM-DD)' }); return; }
    if (!req.file || detectDocumentType(req.file.buffer) !== 'application/pdf') { res.status(400).json({ error: 'Upload the invoice as a PDF' }); return; }
    fs.mkdirSync(invoiceDir(c.id), { recursive: true });
    const file = path.join(invoiceDir(c.id), `${s.id}.pdf`);
    fs.writeFileSync(file, req.file.buffer);
    await statementsCol().updateOne({ id: s.id, invoice: { $exists: false } }, { $set: { invoice: { number, date, file, uploadedAt: new Date() } } });
    await restoreIfNoOverdue(c);
    await notifyAdmins('invoice_received', `${c.name} uploaded invoice ${number} for statement ${s.periodFrom} to ${s.periodTo}.`, { contractorId: c.id });
    res.json({ ok: true });
});

/** A contractor paused for a late invoice goes back to ACTIVE once no statement of theirs is still overdue. */
export async function restoreIfNoOverdue(c: Contractor, now = new Date()): Promise<void> {
    const open = (await statementsCol().find({ contractorId: c.id, status: 'PAID' }).toArray() as StatementDoc[]).filter((s) => s.invoiceDueAt && !s.invoice && s.invoiceDueAt.getTime() < now.getTime());
    if (open.length === 0) {
        const r = await contractorsCol().updateOne({ id: c.id, status: 'PAUSED_INVOICE' }, { $set: { status: 'ACTIVE', statusReason: null } });
        if (r.matchedCount) { invalidateUserCache(c.email); await notifyUser(c.email, 'status', 'Thank you: your account is active again.'); }
    }
}

// ---------- owner ----------
router.get('/owner/statements', requireAdmin, async function (req, res) {
    const status = str(req.query.status);
    const cs = new Map(((await contractorsCol().find({}).toArray()) as Contractor[]).map((c) => [c.id, c]));
    const rows = (await statementsCol().find(status ? { status } : {}).sort({ createdAt: -1 }).toArray()) as StatementDoc[];
    res.json({ taxPhaseComplete: taxPhaseComplete(), statements: rows.map((s) => ({ ...ownView(s), contractorId: s.contractorId, contractor: cs.get(s.contractorId)?.name ?? s.contractorId, isTest: cs.get(s.contractorId)?.isTest === true, createdAt: s.createdAt, approvedAt: s.approvedAt ?? null })) });
});
router.post('/owner/statements/run', requireAdmin, async function (req, res) {
    const date = str(req.body?.date) || istDate();
    if (!validIsoDate(date)) { res.status(400).json({ error: 'date must be YYYY-MM-DD' }); return; }
    const made = req.body?.kind === 'monthly' ? await runMonthlyRetainers(date) : await runWeeklyStatements(date);
    res.json({ created: made.length });
});
router.post('/owner/statements/:id/approve', requireAdmin, async function (req, res) {
    const s = (await statementsCol().findOne({ id: req.params.id })) as StatementDoc | null;
    const c = s ? await getContractor(s.contractorId) : null;
    const r = await approveStatement(req.params.id, resolveRealUser(req) ?? 'admin', c);
    if (r.ok === false) { const f = r as { status: number; error: string }; res.status(f.status).json({ error: f.error }); return; }
    res.json(ownView((r as { ok: true; doc: StatementDoc }).doc));
});
router.post('/owner/statements/:id/paid', requireAdmin, async function (req, res) {
    const s = (await statementsCol().findOne({ id: req.params.id })) as StatementDoc | null;
    const c = s ? await getContractor(s.contractorId) : null;
    const r = await markPaid(req.params.id, resolveRealUser(req) ?? 'admin', str(req.body?.utr), c);
    if (r.ok === false) { const f = r as { status: number; error: string }; res.status(f.status).json({ error: f.error }); return; }
    const doc = (r as { ok: true; doc: StatementDoc }).doc;
    if (c) await notifyUser(c.email, 'statement_paid', c.type === 'BUSINESS' ? `A payment of ₹${doc.gross} was made (UTR ${doc.utr}). Please upload your invoice by ${doc.invoiceDueAt?.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}.` : `A payment of ₹${doc.gross} was made (UTR ${doc.utr}).`);
    res.json(ownView(doc));
});

/** Advanced: change the fee model from a FUTURE (or today's) effective date; earlier periods are never touched. */
router.post('/owner/contractors/:id/fee-model', requireAdmin, async function (req, res) {
    const c = await getContractor(req.params.id);
    if (!c || c.type !== 'BUSINESS') { res.status(404).json({ error: 'Not a Research Analyst' }); return; }
    const from = str(req.body?.from), model = str(req.body?.model);
    // The one exception to "never retroactive": giving the AMOUNT to a fixed-fee entry that was created without one (a contractor who did not confirm clause 6A.5) on its own date.
    const amountless = (c.feeModels ?? []).some((e) => e.from === from && e.model === 'FIXED_PERIOD' && !(Number(e.fixedAmount) > 0));
    if (!validIsoDate(from) || (from < istDate() && !(amountless && model === 'FIXED_PERIOD'))) { res.status(400).json({ error: 'The effective date must be today or later (a change never applies to an earlier period)' }); return; }
    if (model !== 'PROFIT_SHARE' && model !== 'FIXED_PERIOD') { res.status(400).json({ error: 'model must be PROFIT_SHARE or FIXED_PERIOD' }); return; }
    const entry: any = { from, model };
    if (model === 'PROFIT_SHARE') { const p = Number(req.body?.sharePercent); if (!(p > 0 && p <= 100)) { res.status(400).json({ error: 'sharePercent must be between 0 and 100' }); return; } entry.sharePercent = p; }
    else {
        const a = Number(req.body?.fixedAmount); if (!(a > 0)) { res.status(400).json({ error: 'fixedAmount (rupees per fee period) must be positive' }); return; } entry.fixedAmount = a;
        // the duration in months (default 1) and the reference investment the fee is measured against (default forecast.orders.maxInvestment), both fixed on the entry
        const months = req.body?.durationMonths === undefined || req.body?.durationMonths === '' ? fixedFeeMonths() : Number(req.body?.durationMonths);
        if (!(Number.isInteger(months) && months >= 1 && months <= 12)) { res.status(400).json({ error: 'durationMonths must be a whole number from 1 to 12' }); return; }
        const ref = req.body?.referenceInvestment === undefined || req.body?.referenceInvestment === '' ? referenceInvestment() : Number(req.body?.referenceInvestment);
        if (!(ref > 0)) { res.status(400).json({ error: 'referenceInvestment must be positive' }); return; }
        entry.durationMonths = months; entry.referenceInvestment = ref;
    }
    await contractorsCol().updateOne({ id: c.id }, { $set: { feeModels: [...(c.feeModels ?? []).filter((e) => e.from !== from), entry] } });
    Log.log(`[contractor] fee model of ${c.id} set from ${from}: ${model}`);
    res.json({ ok: true, feeModels: [...(c.feeModels ?? []).filter((e) => e.from !== from), entry] });
});

export default router;
