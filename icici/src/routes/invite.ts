/**
 * Invite acceptance (public: the single-use link is the credential) and the contractor's own endpoints under /contractor and /agreements.
 * No login exists for contractors: accepting an invite sets the long-lived session cookie (src/contractors/session.ts); a logout or cleared
 * cookie means a new invite. Spec: SPEC-forecast-contractor-portal-v2.1.md sections 3 to 6.
 */
import express from 'express';
import Log from '../util/Log';
import { asyncRouter } from './asyncRouter';
import { getActiveUser, invalidateUserCache, requireAuth, resolveUser } from './session';
import { levelDefaultsFor } from '../user';
import { AcceptanceDoc, consumeInvite, contractorsCol, ensureContractorUser, findInviteByToken, getContractor, getContractorByEmail, inviteState, invitesCol, newContractor, recordAcceptance, submissionBlock } from '../contractors/store';
import { BusinessKyc, Contractor, ContractorType, IndividualKyc } from '../contractors/types';
import { currentVersion, istDate, readAgreement, upcomingVersion } from '../contractors/agreements';
import { encryptField, isKycCryptoConfigured } from '../contractors/kycCrypto';
import { gstinMatchesPan, normAccount, normGstin, normIfsc, normPan, normSebi, validAccount, validEmail, validIfsc, validIsoDate, validPan, validSebi } from '../contractors/validate';
import { RateLimiter } from '../contractors/rateLimit';
import { setContractorCookie } from '../contractors/session';
import { toContractorClient } from '../contractors/clientUser';
import { notifyAdmins } from '../contractors/notify';
import Mongo from '../tools/mongo';
import { sendWelcomeIfDue } from '../contractors/emails';
import { canPersonalise, detailsFromContractor, detailsFromForm, readStored, renderPersonalised, sha256Of, storePersonalised } from '../contractors/personalise';

const router = asyncRouter();
const acceptLimiter = new RateLimiter(Number(process.env.INVITE_RATE_LIMIT) || 20, 60_000); // per IP per minute (the env override is for tests)
const clientIp = (req: express.Request) => String(req.get('cf-connecting-ip') || req.ip || req.socket.remoteAddress || '');
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function limited(req: express.Request, res: express.Response): boolean {
    if (acceptLimiter.allow(clientIp(req))) return false;
    res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    return true;
}

async function contractorClientView(c: Contractor) {
    const required = await currentVersion();
    return toContractorClient(c, { agreementVersionRequired: required, upcomingAgreement: await upcomingVersion(), blockedReason: submissionBlock(c, required) });
}

// ---------- public: the invite ----------

router.get('/invite/:token', async function (req, res) {
    if (limited(req, res)) return;
    const invite = await findInviteByToken(req.params.token);
    const state = inviteState(invite);
    if (state !== 'ok' || !invite) { res.json({ state }); return; }
    const version = await currentVersion();
    const ag = readAgreement(invite.type, version);
    let reinvite: { email: string; name: string; needsAgreement: boolean } | null = null;
    if (invite.targetContractorId) {
        const c = await getContractor(invite.targetContractorId);
        if (!c || c.status === 'TERMINATED') { res.json({ state: 'revoked' }); return; }
        reinvite = { email: c.email, name: c.name, needsAgreement: c.agreementVersion !== version };
    }
    res.json({ state: 'ok', type: invite.type, emailLock: invite.emailLock ?? null, reinvite, agreement: { version, sha256: ag.sha256, filename: ag.filename } });
});

router.get('/invite/:token/agreement', async function (req, res) {
    if (limited(req, res)) return;
    const invite = await findInviteByToken(req.params.token);
    if (inviteState(invite) !== 'ok' || !invite) { res.status(404).json({ error: 'Invite not valid' }); return; }
    const ag = readAgreement(invite.type, await currentVersion());
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${ag.filename}"`, 'X-Agreement-Sha256': ag.sha256, 'Cache-Control': 'no-store' }).send(ag.bytes);
});

type KycResult = { ok: true; kyc: IndividualKyc | BusinessKyc; sebi?: Contractor['sebi'] } | { ok: false; status: number; error: string };

export function buildKyc(type: ContractorType, body: any, email: string): KycResult {
    const k = body ?? {};
    const gstin = normGstin(k.gstin);
    // A Business contractor gives its GSTIN only: the entity PAN is characters 3 to 12 of it, so it is derived (and stored encrypted) rather than asked for twice.
    const pan = type === 'BUSINESS' ? gstin.slice(2, 12) : normPan(k.pan);
    // Only the tax identity is required here. Everything else is optional now and can be completed on the profile page; whatever IS given is checked.
    if (type === 'BUSINESS' ? !gstinMatchesPan(gstin, pan) : !validPan(pan)) return { ok: false, status: 400, error: type === 'BUSINESS' ? 'GSTIN is not valid' : 'PAN is not valid (format AAAAA9999A)' };
    if (type === 'INDIVIDUAL' && k.notGstRegistered !== true) return { ok: false, status: 422, error: 'Contact admin to switch to the Business agreement.' };
    const bank = bankFrom(k);
    if (bank.ok === false) return { ok: false, status: 400, error: (bank as { error: string }).error };
    const address = str(k.address, 500) || undefined;
    let sebi: Contractor['sebi'];
    if (type === 'BUSINESS' && (k.sebiNumber || k.sebiValidUntil)) {
        const num = normSebi(k.sebiNumber);
        if (!validSebi(num)) return { ok: false, status: 400, error: 'SEBI Registration No. must be a Research Analyst number: INH followed by 9 digits' };
        if (!validIsoDate(str(k.sebiValidUntil))) return { ok: false, status: 400, error: 'SEBI registration valid-until date is required (YYYY-MM-DD)' };
        sebi = { number: num, validUntil: str(k.sebiValidUntil) };
    }
    const b = (bank as { ok: true; value: { bankHolder?: string; bankAccountEnc?: string; bankIfsc?: string } }).value;
    if (type === 'INDIVIDUAL') return { ok: true, kyc: { legalName: str(k.legalName) || undefined, address, panEnc: encryptField(pan), ...b, notGstRegistered: true } };
    return { ok: true, sebi, kyc: { entityName: str(k.entityName) || undefined, address, panEnc: encryptField(pan), gstinEnc: encryptField(gstin), analystName: str(k.analystName) || undefined, analystEmail: email, ...b } };
}

/** Bank details are all-or-nothing: none given is fine; if any is given, all three must be valid. */
function bankFrom(k: any): { ok: true; value: { bankHolder?: string; bankAccountEnc?: string; bankIfsc?: string } } | { ok: false; error: string } {
    const holder = str(k.bankHolder), account = normAccount(k.bankAccount), ifsc = normIfsc(k.bankIfsc);
    if (!holder && !account && !ifsc) return { ok: true, value: {} };
    if (!holder) return { ok: false, error: 'Bank account holder name is required with the account number' };
    if (!validAccount(account)) return { ok: false, error: 'Bank account number must be 9 to 18 digits' };
    if (!validIfsc(ifsc)) return { ok: false, error: 'IFSC is not valid' };
    return { ok: true, value: { bankHolder: holder, bankAccountEnc: encryptField(account), bankIfsc: ifsc } };
}

router.post('/invite/:token/preview', async function (req, res) {
    if (limited(req, res)) return;
    const invite = await findInviteByToken(req.params.token);
    if (inviteState(invite) !== 'ok' || !invite) { res.status(404).json({ error: 'Invite not valid' }); return; }
    const version = await currentVersion();
    let pdf: Buffer, filename: string;
    if (!canPersonalise(version)) { const ag = readAgreement(invite.type, version); pdf = ag.bytes; filename = ag.filename; }
    else {
        const target = invite.targetContractorId ? await getContractor(invite.targetContractorId) : null;
        const d = target ? detailsFromContractor(target) : detailsFromForm(invite.type, str(req.body?.name), req.body?.kyc);
        ({ pdf, filename } = await renderPersonalised(invite.type, d));
    }
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'no-store' }).send(pdf);
});

router.post('/invite/:token/accept', async function (req, res) {
    if (limited(req, res)) return;
    if (!isKycCryptoConfigured()) { res.status(503).json({ error: 'The portal is not ready (encryption key missing). Tell the owner.' }); return; }
    const invite = await findInviteByToken(req.params.token);
    const state = inviteState(invite);
    if (state !== 'ok' || !invite) { res.status(410).json({ error: state === 'unknown' ? 'This invite link is not valid.' : `This invite link has been ${state}. Ask for a new one.` }); return; }
    const body = req.body ?? {};
    const version = await currentVersion();
    const ag = readAgreement(invite.type, version);
    const acceptance = (c: Contractor, email: string, personalisedSha?: string): AcceptanceDoc => {
        const now = new Date();
        return { contractorId: c.id, email, agreementType: c.type, agreementVersion: version, fileSha256: personalisedSha ?? ag.sha256, templateSha256: personalisedSha ? ag.sha256 : undefined, acceptedAtUtc: now.toISOString(),
            acceptedAtIst: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }), ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
            representation6A5: c.type === 'BUSINESS' ? true : undefined, dpdpConsent: true };
    };

    // ---- a re-invite of an existing contractor: same record, history kept ----
    if (invite.targetContractorId) {
        const c = await getContractor(invite.targetContractorId);
        if (!c || c.status === 'TERMINATED') { res.status(410).json({ error: 'This invite link is no longer valid.' }); return; }
        const needsAgreement = c.agreementVersion !== version;
        if (needsAgreement && (body.acceptTerms !== true || body.dpdpConsent !== true || (c.type === 'BUSINESS' && body.representation6A5 !== true))) {
            res.status(400).json({ error: 'Please read and accept the agreement (and the confirmations) to continue.' }); return;
        }
        if (!(await consumeInvite(invite._id, c.id))) { res.status(410).json({ error: 'This invite link has already been used.' }); return; }
        if (needsAgreement) {
            const pr = await storePersonalised(c, detailsFromContractor(c), version);
            await recordAcceptance(acceptance(c, c.email, pr?.sha256));
            const set: any = { agreementVersion: version, agreementAcceptedAt: new Date(), ...(pr ? { agreementFile: pr.file, agreementSha256: pr.sha256 } : {}) };
            if (c.status === 'AGREEMENT_PENDING') set.status = 'ACTIVE';
            await contractorsCol().updateOne({ id: c.id }, { $set: set });
        }
        invalidateUserCache(c.email);
        setContractorCookie(res, c.email, c.type);
        res.json(await contractorClientView((await getContractor(c.id)) as Contractor));
        return;
    }

    // ---- a new contractor ----
    const email = str(body.email, 254).toLowerCase();
    const name = str(body.name, 120) || str(body.kyc?.entityName, 120) || email.split('@')[0]; // a name can be added later on the profile page
    if (!validEmail(email)) { res.status(400).json({ error: 'A valid email is required' }); return; }
    if (invite.emailLock && invite.emailLock !== email) { res.status(400).json({ error: 'This invite was issued to a different email address.' }); return; }
    if (body.acceptTerms !== true) { res.status(400).json({ error: `Please accept the Forecasting Services Agreement v${version}` }); return; }
    if (body.dpdpConsent !== true) { res.status(400).json({ error: 'Please give the data-processing consent (agreement Section 12)' }); return; }
    if (invite.type === 'BUSINESS' && body.representation6A5 !== true) { res.status(400).json({ error: 'Please confirm the Registration representation (agreement clause 6A.5)' }); return; }
    const k = buildKyc(invite.type, body.kyc, email);
    if (!k.ok) { const f = k as Extract<KycResult, { ok: false }>; res.status(f.status).json({ error: f.error }); return; }
    if ((await getContractorByEmail(email)) || (await Mongo.getInstance().db.collection('users').findOne({ email }))) {
        res.status(409).json({ error: 'This email is already registered. Ask for a re-invite instead.' }); return;
    }
    const c = newContractor({ email, name, type: invite.type, invitedBy: invite.createdBy });
    if (!(await consumeInvite(invite._id, c.id))) { res.status(410).json({ error: 'This invite link has already been used.' }); return; }
    try {
        c.kyc = k.kyc; c.sebi = k.sebi; c.agreementVersion = version; c.agreementAcceptedAt = new Date(); c.dpdpConsentAt = new Date();
        if (c.type === 'BUSINESS') c.representation6A5At = new Date();
        const pr = await storePersonalised(c, detailsFromForm(c.type, name, body.kyc), version); // the agreement with their details filled in: this is what they accepted
        if (pr) { c.agreementFile = pr.file; c.agreementSha256 = pr.sha256; }
        await ensureContractorUser(c, levelDefaultsFor(c.type === 'INDIVIDUAL' ? 'beginner' : 'advanced').profitSplitPercent);
        await contractorsCol().insertOne(c);
        await recordAcceptance(acceptance(c, email, pr?.sha256));
    } catch (e) {
        Log.log('[contractor] accept failed after the invite was consumed; releasing the invite:', e);
        await invitesCol().updateOne({ _id: invite._id }, { $unset: { usedAt: '', contractorId: '' } }).catch(() => undefined);
        await contractorsCol().updateOne({ id: c.id }, { $set: { status: 'TERMINATED', statusReason: 'accept failed' } }).catch(() => undefined);
        res.status(500).json({ error: 'Could not complete the acceptance. Try the link again.' }); return;
    }
    invalidateUserCache(email);
    setContractorCookie(res, email, c.type);
    sendWelcomeIfDue(c).catch(() => undefined); // never blocks or fails the acceptance
    await notifyAdmins('contractor_accepted', `${name} (${c.type === 'INDIVIDUAL' ? 'Beginner' : 'Advanced'}) accepted the invite and is awaiting activation.`, { contractorId: c.id });
    res.json(await contractorClientView(c));
});

// ---------- the contractor's own ----------

async function me(req: express.Request): Promise<Contractor | null> {
    const email = resolveUser(req);
    return email ? getContractorByEmail(email) : null;
}

router.get('/contractor/me', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c) { res.status(404).json({ error: 'Not a contractor' }); return; }
    res.json(await contractorClientView(c));
});

async function sendOwnAgreement(req: express.Request, res: express.Response) {
    const c = await me(req);
    if (!c) { res.status(404).json({ error: 'Not a contractor' }); return; }
    const version = await currentVersion();
    const mine = c.agreementVersion === version ? readStored(c.agreementFile) : null; // the copy they accepted, with their details filled in
    if (mine) { res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="Forecasting-Agreement.pdf"', 'X-Agreement-Sha256': sha256Of(mine), 'Cache-Control': 'no-store' }).send(mine); return; }
    if (canPersonalise(version) && c.kyc) { const r = await renderPersonalised(c.type, detailsFromContractor(c)); res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${r.filename}"`, 'Cache-Control': 'no-store' }).send(r.pdf); return; }
    const ag = readAgreement(c.type, version);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${ag.filename}"`, 'X-Agreement-Sha256': ag.sha256, 'Cache-Control': 'no-store' }).send(ag.bytes);
}
router.get('/contractor/agreement', requireAuth, sendOwnAgreement);
router.get('/agreements/current', requireAuth, sendOwnAgreement);

router.post('/contractor/accept-agreement', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c || c.status === 'TERMINATED') { res.status(404).json({ error: 'Not a contractor' }); return; }
    const version = await currentVersion();
    const body = req.body ?? {};
    if (body.acceptTerms !== true || body.dpdpConsent !== true || (c.type === 'BUSINESS' && body.representation6A5 !== true)) { res.status(400).json({ error: 'Please accept the agreement and the confirmations' }); return; }
    if (c.agreementVersion === version) { res.json(await contractorClientView(c)); return; }
    const ag = readAgreement(c.type, version);
    const pr = await storePersonalised(c, detailsFromContractor(c), version);
    const now = new Date();
    await recordAcceptance({ contractorId: c.id, email: c.email, agreementType: c.type, agreementVersion: version, fileSha256: pr?.sha256 ?? ag.sha256, templateSha256: pr ? ag.sha256 : undefined, acceptedAtUtc: now.toISOString(),
        acceptedAtIst: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }), ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
        representation6A5: c.type === 'BUSINESS' ? true : undefined, dpdpConsent: true });
    const set: any = { agreementVersion: version, agreementAcceptedAt: now, ...(pr ? { agreementFile: pr.file, agreementSha256: pr.sha256 } : {}) };
    if (c.status === 'AGREEMENT_PENDING') set.status = 'ACTIVE';
    await contractorsCol().updateOne({ id: c.id }, { $set: set });
    res.json(await contractorClientView((await getContractor(c.id)) as Contractor));
});

// A Business contractor records / updates its SEBI registration; it stays unverified until the owner verifies it against SEBI's list.
router.post('/contractor/sebi', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c || c.type !== 'BUSINESS' || c.status === 'TERMINATED') { res.status(403).json({ error: 'Forbidden' }); return; }
    const number = normSebi(req.body?.number);
    const validUntil = str(req.body?.validUntil);
    if (!validSebi(number)) { res.status(400).json({ error: 'SEBI Registration No. must be a Research Analyst number: INH followed by 9 digits' }); return; }
    if (!validIsoDate(validUntil) || validUntil < istDate()) { res.status(400).json({ error: 'Valid-until must be a date (YYYY-MM-DD) that has not passed' }); return; }
    await contractorsCol().updateOne({ id: c.id }, { $set: { sebi: { number, validUntil } } }); // a fresh record: unverified again, alert stage reset
    await notifyAdmins('sebi_unverified', `${c.name} updated its SEBI registration (${number}, valid until ${validUntil}); please verify it.`, { contractorId: c.id });
    res.json(await contractorClientView((await getContractor(c.id)) as Contractor));
});

// Completes the optional details after acceptance. Descriptive fields can be set at any time; BANK details only while none is on file (a later change goes through
// /contractor/kyc-change and waits for the owner). The tax identity (PAN / GSTIN) is never edited here.
router.post('/contractor/profile', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c || c.status === 'TERMINATED' || !c.kyc) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (!isKycCryptoConfigured()) { res.status(503).json({ error: 'Not ready' }); return; }
    const b = req.body ?? {};
    const set: Record<string, unknown> = {};
    const text = (key: string, max = 300) => { if (b[key] !== undefined) { const v = str(b[key], max); if (v) set[`kyc.${key}`] = v; } };
    if (c.type === 'INDIVIDUAL') text('legalName'); else { text('entityName'); text('analystName'); }
    text('address', 500);
    const k: any = c.kyc;
    if (b.bankAccount !== undefined || b.bankIfsc !== undefined || b.bankHolder !== undefined) {
        if (k.bankAccountEnc) { res.status(409).json({ error: 'Bank details are already on file. Use "Request change": the owner approves a change.' }); return; }
        const bank = bankFrom(b);
        if (bank.ok === false) { res.status(400).json({ error: (bank as { error: string }).error }); return; }
        for (const [key, v] of Object.entries((bank as { ok: true; value: Record<string, string> }).value)) set[`kyc.${key}`] = v;
    }
    if (Object.keys(set).length === 0) { res.status(400).json({ error: 'Nothing to save' }); return; }
    if (set['kyc.legalName'] || set['kyc.entityName'] || set['kyc.analystName']) set.name = (set['kyc.analystName'] ?? set['kyc.legalName'] ?? set['kyc.entityName'] ?? c.name) as string;
    await contractorsCol().updateOne({ id: c.id }, { $set: set });
    if (set.name) await Mongo.getInstance().db.collection('users').updateOne({ email: c.email }, { $set: { name: set.name } });
    invalidateUserCache(c.email);
    res.json(await contractorClientView((await getContractor(c.id)) as Contractor));
});

// A change of bank account, PAN or GSTIN waits for the owner's approval (spec v2.1 section 3); the old values stay in force until then.
router.post('/contractor/kyc-change', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c || c.status === 'TERMINATED' || !c.kyc) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (!isKycCryptoConfigured()) { res.status(503).json({ error: 'Not ready' }); return; }
    const b = req.body ?? {};
    const change: Record<string, string> = {};
    if (b.pan !== undefined) {
        if (c.type === 'BUSINESS') { res.status(400).json({ error: 'A business does not give a PAN: it comes from the GSTIN. Change the GSTIN instead.' }); return; }
        const v = normPan(b.pan); if (!validPan(v)) { res.status(400).json({ error: 'PAN is not valid' }); return; } change.panEnc = encryptField(v);
    }
    if (b.gstin !== undefined) {
        if (c.type !== 'BUSINESS') { res.status(400).json({ error: 'GSTIN applies to Business contractors only' }); return; }
        const g = normGstin(b.gstin);
        if (!gstinMatchesPan(g, g.slice(2, 12))) { res.status(400).json({ error: 'GSTIN is not valid' }); return; }
        change.gstinEnc = encryptField(g);
        change.panEnc = encryptField(g.slice(2, 12)); // the PAN follows the GSTIN
    }
    if (b.bankAccount !== undefined) { const v = normAccount(b.bankAccount); if (!validAccount(v)) { res.status(400).json({ error: 'Bank account number must be 9 to 18 digits' }); return; } change.bankAccountEnc = encryptField(v); }
    if (b.bankIfsc !== undefined) { const v = normIfsc(b.bankIfsc); if (!validIfsc(v)) { res.status(400).json({ error: 'IFSC is not valid' }); return; } change.bankIfsc = v; }
    if (b.bankHolder !== undefined) { if (!str(b.bankHolder)) { res.status(400).json({ error: 'Bank account holder name is required' }); return; } change.bankHolder = str(b.bankHolder); }
    if (Object.keys(change).length === 0) { res.status(400).json({ error: 'Nothing to change' }); return; }
    const col = Mongo.getInstance().db.collection('kycChanges');
    await col.updateOne({ contractorId: c.id, status: 'PENDING' }, { $set: { status: 'SUPERSEDED' } });
    await col.insertOne({ contractorId: c.id, email: c.email, name: c.name, change, fields: Object.keys(change), status: 'PENDING', createdAt: new Date() });
    await notifyAdmins('kyc_change', `${c.name} asked to change: ${Object.keys(change).join(', ')}. Approve or reject it on the Owner page.`, { contractorId: c.id });
    res.json({ ok: true, pending: Object.keys(change) });
});

export default router;
