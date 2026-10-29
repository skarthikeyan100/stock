import { getUser } from '../user';
import { computePayout, createPayoutRecord, markPayoutDecision, markPayoutPaidWithProof, setPayoutEmailStatus, claimPayoutEmailSend, getPayout, generateInvoiceHtml, getPayoutDecisionLog, periodFromInputs, displayPeriodEnd } from '../payout';
import { GridFSBucket, ObjectId } from 'mongodb';
import { sendPayoutPaidEmail } from '../mailer';
import Mongo from '../tools/mongo';
import { asyncRouter } from './asyncRouter';
import { resolveUser, requestIsLoopback, requireAdmin, requireSelfOrAdmin } from './session';
import { upload, detectDocumentType } from './users';

const router = asyncRouter();

// ============================== Payments & Payouts ==============================
// Manual admin record-keeping, no payment gateway integration - admin reviews
// a computed payout and marks it paid/rejected, mirroring the existing manual
// KYC-verification-toggle pattern above. Amounts are always server-recomputed
// from persisted closedTrades (never trusted from the client).

router.get('/users/:email/payouts', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const payouts = await Mongo.getInstance().db.collection('payouts').find({ user: email }).sort({ createdAt: -1 }).toArray();
        res.json(payouts);
    } catch (e) {
        console.error('Get payouts error:', e);
        res.sendStatus(500);
    }
});

router.get('/users/:email/payouts/:id/invoice', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const html = await generateInvoiceHtml(req.params.id, req.params.email);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (e: any) {
        console.error('Generate invoice error:', e);
        res.status(404).json({ error: e.message || 'Payout not found' });
    }
});

router.get('/users/:email/payouts/:id/decision-log', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const entries = await getPayoutDecisionLog(req.params.id, req.params.email);
        res.json(entries);
    } catch (e) {
        console.error('Get payout decision log error:', e);
        res.sendStatus(500);
    }
});

router.get('/admin/payouts', requireAdmin, async function (req, res) {
    try {
        const { status, user } = req.query as { status?: string; user?: string };
        const query: any = {};
        if (status) query.status = status;
        if (user) query.user = user;
        const payouts = await Mongo.getInstance().db.collection('payouts').find(query).sort({ createdAt: -1 }).toArray();
        res.json(payouts);
    } catch (e) {
        console.error('Admin get payouts error:', e);
        res.sendStatus(500);
    }
});

router.post('/admin/payouts/compute', requireAdmin, async function (req, res) {
    try {
        const { user, periodStart, periodEnd } = req.body;
        if (!user || !periodStart || !periodEnd) {
            res.status(400).json({ error: 'user, periodStart, and periodEnd are required' }); return;
        }
        const period = periodFromInputs(periodStart, periodEnd);
        const computation = await computePayout(user, period.start, period.end);
        res.json(computation);
    } catch (e: any) {
        console.error('Compute payout error:', e);
        res.status(400).json({ error: e.message || 'Failed to compute payout' });
    }
});

router.post('/admin/payouts', requireAdmin, async function (req, res) {
    try {
        const { user, periodStart, periodEnd } = req.body;
        if (!user || !periodStart || !periodEnd) {
            res.status(400).json({ error: 'user, periodStart, and periodEnd are required' }); return;
        }
        const period = periodFromInputs(periodStart, periodEnd);
        const payout = await createPayoutRecord(user, period.start, period.end);
        res.json(payout);
    } catch (e: any) {
        console.error('Create payout error:', e);
        res.status(400).json({ error: e.message || 'Failed to create payout' });
    }
});

router.patch('/admin/payouts/:id', requireAdmin, async function (req, res) {
    try {
        const { status, note } = req.body;
        if (status === 'paid') {
            res.status(400).json({ error: 'Use POST /admin/payouts/:id/pay (with the payment screenshot) to mark a payout paid' }); return;
        }
        if (status !== 'rejected') {
            res.status(400).json({ error: 'status must be rejected' }); return;
        }
        // Loopback callers have no session: attribute the decision to 'loopback' rather than to nobody.
        const adminEmail = resolveUser(req) ?? (requestIsLoopback(req) ? 'loopback' : null);
        const payout = await markPayoutDecision(req.params.id, status, note, adminEmail);
        res.json(payout);
    } catch (e: any) {
        console.error('Mark payout decision error:', e);
        const msg = e.message || 'Failed to update payout';
        res.status(/not found/i.test(msg) ? 404 : /already/i.test(msg) ? 409 : 400).json({ error: msg });
    }
});

// Payment page data: the payout plus the payee's full bank/UPI details (admin only - the persisted bankSnapshot is masked).
router.get('/admin/payouts/:id', requireAdmin, async function (req, res) {
    try {
        if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'Invalid payout id' }); return; }
        const payout = await getPayout(req.params.id);
        if (!payout) { res.status(404).json({ error: 'Payout not found' }); return; }
        const user = await getUser(payout.user);
        res.json({
            payout,
            payee: {
                name: user?.legalName || user?.name, email: payout.user,
                bankAccountHolderName: user?.bankAccountHolderName, bankAccountNumber: user?.bankAccountNumber,
                bankIFSC: user?.bankIFSC, upiId: user?.upiId,
            },
        });
    } catch (e) {
        console.error('Admin get payout error:', e);
        res.sendStatus(500);
    }
});

// Payment-proof images: png/jpeg/webp only (no SVG, which can carry script). Maps the content type to the attachment extension.
const PROOF_IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
function detectProofImageType(buf: Buffer): string | null {
    const t = detectDocumentType(buf);
    if (t === 'image/jpeg' || t === 'image/png') return t;
    if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

function payoutEmailVars(payout: any, user: any) {
    const method = payout.paidTo;
    const upiId = payout.bankSnapshot?.upiId;
    const accountMasked = payout.bankSnapshot?.accountNumberMasked;
    // The pay route refuses a paidTo with no matching saved details; the fallbacks only cover payouts paid before that check.
    const destination = method === 'upi'
        ? (upiId ? `UPI ${upiId}` : 'your registered UPI ID')
        : (accountMasked ? `Bank account ${accountMasked}` : 'your registered bank account');
    return {
        name: String(user?.legalName || user?.name || payout.user),
        invoiceNumber: String(payout.invoiceNumber),
        period: `${new Date(payout.periodStart).toDateString()} – ${displayPeriodEnd(payout.periodEnd).toDateString()}`,
        netAmount: Number(payout.netAmount).toFixed(2),
        paidDate: new Date(payout.paidAt ?? Date.now()).toDateString(),
        destination,
        paymentRef: String(payout.paymentRef || '—'),
        note: String(payout.adminNote ?? ''),
    };
}

async function sendPaidEmailAndRecord(payout: any): Promise<{ emailStatus: 'sent' | 'failed'; emailError?: string }> {
    try {
        const user = await getUser(payout.user);
        const bucket = new GridFSBucket(Mongo.getInstance().db, { bucketName: 'payout_proofs' });
        const files = await bucket.find({ _id: new ObjectId(payout.proofFileId) }).toArray();
        const chunks: Buffer[] = [];
        for await (const chunk of bucket.openDownloadStream(new ObjectId(payout.proofFileId))) chunks.push(chunk as Buffer);
        // Only the types the pay route accepts; anything else (e.g. an older SVG upload) is sent as a generic PNG-less binary name.
        const contentType = PROOF_IMAGE_TYPES[files[0]?.contentType as string] ? files[0].contentType as string : 'application/octet-stream';
        const ext = PROOF_IMAGE_TYPES[contentType] ?? 'bin';
        await sendPayoutPaidEmail(payout.user, payoutEmailVars(payout, user), {
            filename: `payment-proof-${payout.invoiceNumber}.${ext}`, content: Buffer.concat(chunks), contentType,
        });
        await setPayoutEmailStatus(payout._id, 'sent');
        return { emailStatus: 'sent' };
    } catch (e: any) {
        console.error('Payout paid email failed:', e);
        await setPayoutEmailStatus(payout._id, 'failed', e.message || String(e)).catch(() => undefined);
        return { emailStatus: 'failed', emailError: e.message || String(e) };
    }
}

// Mark a payout paid: the admin has made the bank/UPI transfer manually and attaches a screenshot. Stores the proof,
// flips pending -> paid exactly once, then emails the user. The payment stays recorded if the email fails (see resend).
router.post('/admin/payouts/:id/pay', requireAdmin, upload.single('proof'), async function (req, res) {
    let proofId: ObjectId | null = null;
    try {
        if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'Invalid payout id' }); return; }
        if (!req.file) { res.status(400).json({ error: 'Payment screenshot is required' }); return; }
        // Trust the bytes, not the client-declared mimetype.
        const proofType = detectProofImageType(req.file.buffer);
        if (!proofType) { res.status(400).json({ error: 'The proof must be a PNG, JPEG or WebP image' }); return; }
        const { paymentRef, note, paidTo } = req.body as { paymentRef?: string; note?: string; paidTo?: string };
        if (paidTo !== 'bank' && paidTo !== 'upi') { res.status(400).json({ error: 'paidTo must be bank or upi' }); return; }
        const adminEmail = resolveUser(req) ?? (requestIsLoopback(req) ? 'loopback' : null);

        const existing = await getPayout(req.params.id);
        if (!existing) { res.status(404).json({ error: 'Payout not found' }); return; }
        if (existing.status !== 'pending') { res.status(409).json({ error: `Payout is already ${existing.status}` }); return; }
        if (paidTo === 'upi' ? !existing.bankSnapshot?.upiId : !existing.bankSnapshot?.accountNumberMasked) {
            res.status(400).json({ error: `This payout has no saved ${paidTo === 'upi' ? 'UPI ID' : 'bank account'} - choose the other method or ask the user to add one` });
            return;
        }

        const bucket = new GridFSBucket(Mongo.getInstance().db, { bucketName: 'payout_proofs' });
        const safeName = String(req.file.originalname ?? 'proof').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
        const uploadStream = bucket.openUploadStream(`${req.params.id}_${Date.now()}_${safeName}`, { contentType: proofType });
        uploadStream.end(req.file.buffer);
        await new Promise<void>((resolve, reject) => { uploadStream.on('finish', resolve); uploadStream.on('error', reject); });
        proofId = uploadStream.id as ObjectId;

        let payout;
        try {
            payout = await markPayoutPaidWithProof(req.params.id, { fileId: proofId.toString(), paymentRef: paymentRef?.trim() || undefined, paidTo, note: note?.trim() || undefined }, adminEmail);
        } catch (e) {
            // Lost the pending->paid race (or the payout vanished): the stored screenshot must not be orphaned.
            await bucket.delete(proofId).catch(() => undefined);
            proofId = null;
            throw e;
        }
        const claimed = await claimPayoutEmailSend(payout._id);
        const email = claimed ? await sendPaidEmailAndRecord(claimed) : { emailStatus: 'sending' as const };
        res.json({ ...payout, ...email });
    } catch (e: any) {
        console.error('Pay payout error:', e);
        const msg = e.message || 'Failed to mark payout paid';
        res.status(/not found/i.test(msg) ? 404 : /already/i.test(msg) ? 409 : 400).json({ error: msg });
    }
});

router.post('/admin/payouts/:id/resend-email', requireAdmin, async function (req, res) {
    try {
        if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'Invalid payout id' }); return; }
        const payout = await getPayout(req.params.id);
        if (!payout) { res.status(404).json({ error: 'Payout not found' }); return; }
        if (payout.status !== 'paid' || !payout.proofFileId) { res.status(409).json({ error: 'Only a paid payout with a payment screenshot can be emailed' }); return; }
        if (payout.emailStatus === 'sent') { res.status(409).json({ error: 'The email was already sent' }); return; }
        // Atomic claim: a double-click or a retry racing a slow first send gets null here instead of a second email.
        const claimed = await claimPayoutEmailSend(payout._id);
        if (!claimed) { res.status(409).json({ error: 'An email send is already in progress or has completed' }); return; }
        res.json(await sendPaidEmailAndRecord(claimed));
    } catch (e) {
        console.error('Resend payout email error:', e);
        res.sendStatus(500);
    }
});

router.get('/users/:email/payouts/:id/proof', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'Invalid payout id' }); return; }
        const payout = await getPayout(req.params.id);
        if (!payout || String(payout.user).toLowerCase() !== req.params.email.toLowerCase() || !payout.proofFileId) { res.status(404).json({ error: 'Proof not found' }); return; }
        const bucket = new GridFSBucket(Mongo.getInstance().db, { bucketName: 'payout_proofs' });
        const files = await bucket.find({ _id: new ObjectId(payout.proofFileId) }).toArray();
        if (!files.length) { res.status(404).json({ error: 'File not found' }); return; }
        res.setHeader('Content-Type', files[0].contentType?.startsWith('image/') && files[0].contentType !== 'image/svg+xml' ? files[0].contentType : 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        bucket.openDownloadStream(new ObjectId(payout.proofFileId)).pipe(res);
    } catch (e) {
        console.error('Payout proof download error:', e);
        res.sendStatus(500);
    }
});


export default router;
