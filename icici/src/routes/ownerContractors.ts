/** Owner (admin) side of the contractor portal: invites, statuses, KYC view, SEBI verification, KYC-change approvals, agreement versions. All requireAdmin; the existing Admin page is untouched. */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import Log from '../util/Log';
import { asyncRouter } from './asyncRouter';
import { invalidateUserCache, requireAdmin, resolveRealUser } from './session';
import { upload } from './users';
import { activeCount, contractorsCol, createInvite, getContractor, invitesCol, listAcceptances, listContractors, maxActiveContractors, revokeOpenInvitesFor, revokeUserSessions, setUserEnabled, STATUS_TRANSITIONS } from '../contractors/store';
import { Contractor, ContractorStatus, ContractorType, missingDetails } from '../contractors/types';
import { AGREEMENTS_DIR, agreementPath, currentVersion, istDate, listVersions, scheduleVersion, upcomingVersion, VERSION_RE, versionAvailable } from '../contractors/agreements';
import { decryptField, maskedField } from '../contractors/kycCrypto';
import { publicBaseUrl, sendInviteEmail } from '../contractors/email';
import { isPlaceholderEmail, validEmail, validIsoDate } from '../contractors/validate';
import { notifyUser } from '../contractors/notify';
import Mongo from '../tools/mongo';
import { ObjectId } from 'mongodb';

const router = asyncRouter();
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const TYPES: ContractorType[] = ['INDIVIDUAL', 'BUSINESS'];

export function adminView(c: Contractor) {
    const k: any = c.kyc ?? {};
    return {
        id: c.id, email: c.email, name: c.name, type: c.type, status: c.status, statusReason: c.statusReason, terminatedAt: c.terminatedAt, isTest: c.isTest === true,
        createdAt: c.createdAt, agreementVersion: c.agreementVersion, agreementAcceptedAt: c.agreementAcceptedAt, tradeUser: c.email,
        kycMasked: c.kyc ? { legalName: k.legalName ?? k.entityName, address: k.address, pan: maskedField(k.panEnc), gstin: maskedField(k.gstinEnc), bankAccount: maskedField(k.bankAccountEnc), bankIfsc: k.bankIfsc, bankHolder: k.bankHolder,
            analystName: k.analystName, analystEmail: k.analystEmail, notGstRegistered: k.notGstRegistered } : null,
        sebi: c.sebi ? { ...c.sebi, verified: !!c.sebi.verifiedAt } : null,
        missing: missingDetails(c.type, c.kyc, c.sebi),
    };
}

router.get('/owner/summary', requireAdmin, async function (_req, res) {
    res.json({ activeCount: await activeCount(), maxActive: maxActiveContractors(), contractors: (await listContractors()).length, currentAgreementVersion: await currentVersion(), upcomingAgreement: await upcomingVersion() });
});

// ---------- invites ----------
router.post('/owner/invites', requireAdmin, async function (req, res) {
    const type = str(req.body?.type) as ContractorType;
    if (!TYPES.includes(type)) { res.status(400).json({ error: 'type must be INDIVIDUAL or BUSINESS' }); return; }
    const email = str(req.body?.email, 254).toLowerCase();
    if (email && !validEmail(email)) { res.status(400).json({ error: 'email is not valid' }); return; }
    const { invite, token } = await createInvite({ type, emailLock: email || undefined, note: str(req.body?.note, 200) || undefined, createdBy: resolveRealUser(req) ?? 'admin' });
    const link = `${publicBaseUrl()}/join/${token}`; // the token is shown once, here; only its hash is stored
    let email_sent: { to: string; redirectedTo?: string } | { error: string } | null = null;
    if (req.body?.send === true) {
        if (!email) { res.status(400).json({ error: 'give an email to send the invitation to' }); return; }
        if (isPlaceholderEmail(email)) { email_sent = { error: 'a placeholder address (no real email) cannot be mailed; send the link yourself' }; res.json({ id: String(invite._id), link, type, emailLock: email, expiresAt: invite.expiresAt, email: email_sent }); return; }
        try { email_sent = await sendInviteEmail(email, type, link, invite.expiresAt); } catch (e: any) { email_sent = { error: String(e?.message ?? e) }; Log.log('[contractor] invite email failed:', e); }
    }
    res.json({ id: String(invite._id), link, type, emailLock: email || null, expiresAt: invite.expiresAt, email: email_sent });
});

router.get('/owner/invites', requireAdmin, async function (_req, res) {
    const rows = await invitesCol().find({}).sort({ createdAt: -1 }).toArray();
    res.json(rows.map((i: any) => ({ id: String(i._id), type: i.type, emailLock: i.emailLock ?? null, note: i.note ?? null, createdBy: i.createdBy, createdAt: i.createdAt, expiresAt: i.expiresAt,
        usedAt: i.usedAt ?? null, revokedAt: i.revokedAt ?? null, contractorId: i.contractorId ?? null, targetContractorId: i.targetContractorId ?? null })));
});

router.post('/owner/invites/:id/revoke', requireAdmin, async function (req, res) {
    if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'bad id' }); return; }
    const r = await invitesCol().updateOne({ _id: new ObjectId(req.params.id), usedAt: { $exists: false }, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    if (!r.matchedCount) { res.status(404).json({ error: 'No open invite with that id' }); return; }
    res.json({ ok: true });
});

// ---------- contractors ----------
router.get('/owner/contractors', requireAdmin, async function (_req, res) {
    res.json((await listContractors()).map(adminView));
});

router.get('/owner/contractors/:id', requireAdmin, async function (req, res) {
    const c = await getContractor(req.params.id);
    if (!c) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ...adminView(c), acceptances: await listAcceptances(c.id) });
});

/** Full (decrypted) PAN / GSTIN / bank account: admin only, logged. The UI shows the masked form by default. */
router.get('/owner/contractors/:id/kyc', requireAdmin, async function (req, res) {
    const c = await getContractor(req.params.id);
    if (!c || !c.kyc) { res.status(404).json({ error: 'Not found' }); return; }
    Log.log(`[contractor] ${resolveRealUser(req)} revealed KYC of ${c.id}`);
    const k: any = c.kyc;
    res.json({ ...k, panEnc: undefined, gstinEnc: undefined, bankAccountEnc: undefined, pan: decryptField(k.panEnc), gstin: k.gstinEnc ? decryptField(k.gstinEnc) : undefined, bankAccount: k.bankAccountEnc ? decryptField(k.bankAccountEnc) : undefined });
});

async function transition(req: express.Request, res: express.Response, to: ContractorStatus, extra: Record<string, unknown> = {}, guard?: (c: Contractor) => Promise<string | null>) {
    const c = await getContractor(req.params.id);
    if (!c) { res.status(404).json({ error: 'Not found' }); return; }
    if (!STATUS_TRANSITIONS[c.status].includes(to)) { res.status(409).json({ error: `Cannot go from ${c.status} to ${to}` }); return; }
    const bad = guard ? await guard(c) : null;
    if (bad) { res.status(409).json({ error: bad }); return; }
    // compare-and-set on the current status, so two admin clicks cannot both succeed
    const r = await contractorsCol().updateOne({ id: c.id, status: c.status }, { $set: { status: to, ...extra } });
    if (!r.matchedCount) { res.status(409).json({ error: 'Status changed meanwhile; reload' }); return; }
    if (to === 'TERMINATED') { await setUserEnabled(c.email, false); await revokeOpenInvitesFor(c.id); }
    if (to === 'ACTIVE') { await setUserEnabled(c.email, true); }
    invalidateUserCache(c.email);
    res.json(adminView((await getContractor(c.id)) as Contractor));
}

async function firstActivation(id: string): Promise<Record<string, unknown>> { const c = await getContractor(id); return c && !c.activatedAt ? { activatedAt: new Date() } : {}; }

router.post('/owner/contractors/:id/activate', requireAdmin, async function (req, res) {
    await transition(req, res, 'ACTIVE', { statusReason: null, ...(await firstActivation(req.params.id)) }, async (c) => {
        if (!c.kyc) return 'KYC is missing';
        if (c.agreementVersion !== await currentVersion()) return 'This participant has not accepted the current agreement version';
        if (!c.isTest && c.status !== 'PAUSED' && c.status !== 'PAUSED_INVOICE' && (await activeCount()) >= maxActiveContractors()) return `The cap of ${maxActiveContractors()} active contractors is reached`;
        return null;
    });
});
router.post('/owner/contractors/:id/pause', requireAdmin, async function (req, res) {
    const reason = str(req.body?.reason, 300);
    if (!reason) { res.status(400).json({ error: 'a reason is required' }); return; }
    await transition(req, res, 'PAUSED', { statusReason: reason });
});
router.post('/owner/contractors/:id/terminate', requireAdmin, async function (req, res) {
    const date = str(req.body?.date) || istDate();
    if (!validIsoDate(date)) { res.status(400).json({ error: 'date must be YYYY-MM-DD' }); return; }
    await transition(req, res, 'TERMINATED', { terminatedAt: date, statusReason: str(req.body?.reason, 300) || undefined });
});

/** A new single-use link for an existing contractor (lost cookie, logout): same record, older sessions and links revoked. */
router.post('/owner/contractors/:id/reinvite', requireAdmin, async function (req, res) {
    const c = await getContractor(req.params.id);
    if (!c || c.status === 'TERMINATED') { res.status(404).json({ error: 'Not found or terminated' }); return; }
    await revokeOpenInvitesFor(c.id);
    await revokeUserSessions(c.email);
    invalidateUserCache(c.email);
    const { invite, token } = await createInvite({ type: c.type, emailLock: c.email, createdBy: resolveRealUser(req) ?? 'admin', targetContractorId: c.id });
    const link = `${publicBaseUrl()}/join/${token}`;
    let email_sent: any = null;
    if (req.body?.send === true && isPlaceholderEmail(c.email)) email_sent = { error: 'a placeholder address (no real email) cannot be mailed; send the link yourself' };
    else if (req.body?.send === true) { try { email_sent = await sendInviteEmail(c.email, c.type, link, invite.expiresAt); } catch (e: any) { email_sent = { error: String(e?.message ?? e) }; } }
    res.json({ link, expiresAt: invite.expiresAt, email: email_sent });
});

router.post('/owner/contractors/:id/revoke-sessions', requireAdmin, async function (req, res) {
    const c = await getContractor(req.params.id);
    if (!c) { res.status(404).json({ error: 'Not found' }); return; }
    await revokeUserSessions(c.email);
    invalidateUserCache(c.email);
    res.json({ ok: true });
});

router.post('/owner/contractors/:id/sebi-verify', requireAdmin, async function (req, res) {
    const c = await getContractor(req.params.id);
    if (!c || c.type !== 'BUSINESS' || !c.sebi) { res.status(404).json({ error: 'No SEBI registration recorded' }); return; }
    const verified = req.body?.verified !== false;
    await contractorsCol().updateOne({ id: c.id }, verified ? { $set: { 'sebi.verifiedAt': new Date(), 'sebi.verifiedBy': resolveRealUser(req) } } : { $unset: { 'sebi.verifiedAt': '', 'sebi.verifiedBy': '' } });
    res.json(adminView((await getContractor(c.id)) as Contractor));
});

// ---------- KYC changes (bank / PAN / GSTIN) ----------
router.get('/owner/kyc-changes', requireAdmin, async function (req, res) {
    const status = str(req.query.status) || 'PENDING';
    const rows = await Mongo.getInstance().db.collection('kycChanges').find({ status }).sort({ createdAt: -1 }).toArray();
    res.json(rows.map((r: any) => ({ id: String(r._id), contractorId: r.contractorId, name: r.name, email: r.email, fields: r.fields, status: r.status, createdAt: r.createdAt })));
});
router.post('/owner/kyc-changes/:id/decision', requireAdmin, async function (req, res) {
    if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'bad id' }); return; }
    const decision = str(req.body?.decision);
    if (decision !== 'approve' && decision !== 'reject') { res.status(400).json({ error: 'decision must be approve or reject' }); return; }
    const col = Mongo.getInstance().db.collection('kycChanges');
    const r: any = await col.findOneAndUpdate({ _id: new ObjectId(req.params.id), status: 'PENDING' }, { $set: { status: decision === 'approve' ? 'APPROVED' : 'REJECTED', decidedAt: new Date(), decidedBy: resolveRealUser(req), note: str(req.body?.note, 300) || undefined } }, { returnOriginal: true });
    const ch = r?.value;
    if (!ch) { res.status(404).json({ error: 'No pending change with that id' }); return; }
    if (decision === 'approve') {
        const set: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(ch.change as Record<string, unknown>)) set[`kyc.${k}`] = v;
        await contractorsCol().updateOne({ id: ch.contractorId }, { $set: set });
    }
    await notifyUser(ch.email, 'kyc_change_decision', decision === 'approve' ? 'Your change of bank / tax details was approved.' : 'Your change of bank / tax details was not approved.');
    res.json({ ok: true });
});

// ---------- agreement versions ----------
router.get('/owner/agreements', requireAdmin, async function (_req, res) {
    res.json({ current: await currentVersion(), upcoming: await upcomingVersion(), versions: await listVersions(), onDisk: fs.existsSync(AGREEMENTS_DIR) ? fs.readdirSync(AGREEMENTS_DIR).filter((d) => /^v\d+\.\d+$/.test(d)) : [] });
});
/** Upload both PDFs of a new version (fields `individual`, `business`) and schedule it; contractors move to AGREEMENT_PENDING on the effective date (src/contractors/jobs.ts). */
router.post('/owner/agreements', requireAdmin, upload.fields([{ name: 'individual', maxCount: 1 }, { name: 'business', maxCount: 1 }]), async function (req, res) {
    const version = str(req.body?.version);
    const effectiveDate = str(req.body?.effectiveDate);
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    if (!VERSION_RE.test(version)) { res.status(400).json({ error: 'version must look like 1.2' }); return; }
    if (!validIsoDate(effectiveDate) || effectiveDate < istDate()) { res.status(400).json({ error: 'effectiveDate must be a future date (YYYY-MM-DD)' }); return; }
    const ind = files?.individual?.[0], biz = files?.business?.[0];
    const isPdf = (f?: Express.Multer.File) => !!f && f.buffer.slice(0, 5).toString() === '%PDF-';
    if (!isPdf(ind) || !isPdf(biz)) { res.status(400).json({ error: 'both individual and business must be PDF files' }); return; }
    if (versionAvailable(version)) { res.status(409).json({ error: `v${version} files already exist; use a new version number` }); return; }
    fs.mkdirSync(path.dirname(agreementPath('INDIVIDUAL', version)), { recursive: true });
    fs.writeFileSync(agreementPath('INDIVIDUAL', version), (ind as Express.Multer.File).buffer);
    fs.writeFileSync(agreementPath('BUSINESS', version), (biz as Express.Multer.File).buffer);
    try { res.json(await scheduleVersion(version, effectiveDate, resolveRealUser(req) ?? 'admin')); }
    catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

export default router;
