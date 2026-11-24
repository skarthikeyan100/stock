import Log from '../util/Log';
import { gateSettings, gateLevelChange } from '../levelGate';
import { normalizeLevel } from '../levelRules';
import { gstinUpgradeDecision, applyAdvanced } from '../levelUpgrade';
import { sendUpgradeEmail } from '../upgradeEmail';
import { getUser, getAllUsers, updateUserSettings, createUser, deleteUser, updateUserRole, toClientUser, updateSensitiveField, updateBankDetails, updateEntityType, updateCompanyProfile, updateProfileFields } from '../user';
import { eraseUser } from '../accountDeletion';
import multer from 'multer';
import { GridFSBucket, ObjectId } from 'mongodb';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import Mongo from '../tools/mongo';
import OrderClient from '../processes/strategies/OrderClient';
import { USER_BROKERS_TEXT, isUserBroker, normalizeBrokerName } from '../util/brokerName';
import { asyncRouter } from './asyncRouter';
import { pushUserToOrderProcess, parseSession, sessionRevoked, resolveUser, requestIsLoopback, invalidateUserCache, requireAdmin, requireSelfOrAdmin } from './session';
const MAX_INVESTMENT_AMOUNT = 100_000_000; // server-side ceiling for a user-set investmentAmount

const router = asyncRouter();
const orderClient = OrderClient.getInstance();

// ============================== User Management ==============================

router.get('/users', requireAdmin, async function (req, res) {
    try {
        const users = await getAllUsers();
        // hasActiveTrade doesn't include the brief pendingUsers window the old
        // Monitor-based version did (order-in-flight, not yet a confirmed trade) -
        // that state isn't in `stats`'s payload; accepted as a minor fidelity gap
        // rather than adding a dedicated round trip for it.
        const stats = await orderClient.stats().catch(() => ({ trades: [], closedTrades: [], userPnL: {} }));
        const activeUsers = new Set(stats.trades.map((t: any) => t.user));
        const result = users.map((u) => ({
            ...toClientUser(u),
            sessionPnL: (stats.userPnL as any)[u.email] || 0,
            hasActiveTrade: activeUsers.has(u.email),
        }));
        res.json(result);
    } catch (e) {
        console.error('Get users error:', e);
        res.sendStatus(500);
    }
});

router.post('/users', requireAdmin, async function (req, res) {
    try {
        const { email, name, lossLimit, role } = req.body;
        const lotCount = req.body.lotLimit ?? req.body.lotCount;
        if (!email || !name) {
            res.status(400).json({ error: 'Email and name are required' });
            return;
        }
        const ll = lossLimit ?? 15000;
        const lc = lotCount ?? 10;
        if (typeof email !== 'string' || typeof name !== 'string' || !Number.isFinite(Number(ll)) || Number(ll) < 0 || !Number.isInteger(Number(lc)) || Number(lc) <= 0) {
            res.status(400).json({ error: 'Invalid email, name, lossLimit (>= 0) or lotCount (positive integer)' });
            return;
        }
        const user = await createUser(email, name, Number(ll), Number(lc), role ?? 'user');
        await pushUserToOrderProcess(user, 'create');
        res.json(toClientUser(user));
    } catch (e: any) {
        console.error('Create user error:', e);
        if (e.message === 'User already exists') {
            res.status(409).json({ error: 'User already exists' });
        } else if (/^Invalid role|are required$/.test(e.message)) {
            res.status(400).json({ error: e.message });
        } else {
            res.sendStatus(500);
        }
    }
});

router.delete('/users/:email', requireAdmin, async function (req, res) {
    try {
        const { email } = req.params;
        const caller = resolveUser(req);
        if (caller && caller.toLowerCase() === email.toLowerCase()) {
            res.status(400).json({ error: 'You cannot delete your own account' });
            return;
        }
        const target = await getUser(email);
        if (target?.role === 'admin') {
            res.status(400).json({ error: 'An admin account cannot be deleted' });
            return;
        }
        // A user with an open position must be squared off first - deleting them would orphan it.
        const stats = await orderClient.stats();
        if (stats.trades.some((t: any) => t.user === email)) {
            res.status(409).json({ error: 'User has open trades - square them off before deleting the account' });
            return;
        }
        // A trader is erased the same way as a self-delete (DPDP: no personal data kept, trade records pseudonymised).
        if (target) {
            const result = await eraseUser(target.email, new Set(stats.trades.map((t: any) => String(t.user))), { by: 'admin', admin: caller ?? 'unknown' });
            invalidateUserCache(email);
            if (result.ok === false) { res.status(result.status).json({ error: result.error }); return; }
            res.sendStatus(200);
            return;
        }
        const success = await deleteUser(email);
        invalidateUserCache(email);
        if (!success) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('Delete user error:', e);
        res.sendStatus(500);
    }
});

// A user deletes their own account (profile page). DPDP Act: the user row and all personal data are erased and the trade/payout records are kept
// under a random pseudonym (src/accountDeletion.ts); the same email can sign up again. Only the real session owner can do it (an admin
// acting as a trader cannot), and not an admin account.
router.post('/users/:email/delete-account', async function (req, res) {
    try {
        const email = String(req.params.email ?? '').trim().toLowerCase();
        const session = parseSession(req);
        if (!session || session.email.toLowerCase() !== email) { res.status(403).json({ error: 'You can only delete your own account' }); return; }
        if (req.body?.confirm !== 'DELETE') { res.status(400).json({ error: 'Type DELETE to confirm' }); return; }
        const target = await getUser(email);
        if (target && sessionRevoked(req, target)) { res.status(401).json({ error: 'Session expired - log in again' }); return; }
        const stats = await orderClient.stats();
        const result = await eraseUser(email, new Set(stats.trades.map((t: any) => String(t.user))));
        if (result.ok === false) { res.status(result.status).json({ error: result.error }); return; }
        invalidateUserCache(email);
        res.clearCookie('session');
        res.clearCookie('actas');
        res.json({ ok: true });
    } catch (e) {
        console.error('Delete account error:', e);
        res.status(500).json({ error: 'Could not delete the account - try again' });
    }
});

// Read-only list of account erasures (no personal data in it: see src/accountDeletion.ts).
router.get('/admin/erasure-log', requireAdmin, async function (_req, res) {
    const rows = await Mongo.getInstance().db.collection('erasureLog').find({}).sort({ startedAt: -1 }).limit(500).toArray();
    res.json(rows);
});

router.patch('/users/:email/role', requireAdmin, async function (req, res) {
    try {
        const { email } = req.params;
        const { role } = req.body;
        if (!role) {
            res.status(400).json({ error: 'Role is required' });
            return;
        }
        if (role !== 'admin') {
            const admins = (await getAllUsers()).filter((u) => u.role === 'admin');
            if (admins.length <= 1 && admins[0]?.email === email) {
                res.status(400).json({ error: 'Cannot demote the last admin' });
                return;
            }
        }
        const user = await updateUserRole(email, role);
        invalidateUserCache(email);
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
               res.json(toClientUser(user));
    } catch (e: any) {
        console.error('Update role error:', e);
        if (e.message.includes('Invalid role')) {
            res.status(400).json({ error: e.message });
        } else {
            res.sendStatus(500);
        }
    }
});

router.post('/users/:email/settings', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { lossLimit, investmentMode, useGTT, broker, brokers, perOrderCap, targetPoints, stopLossPoints, profitSplitPercent, enabled, investmentModeLocked, proficiencyLevel } = req.body;
        // Canonical names win; the old ones (lotCount / investmentAmount / allottedCapital) are still accepted (REFACTOR_PLAN.md section 3).
        const lotCount = req.body.lotLimit ?? req.body.lotCount;
        const investmentAmount = req.body.accountCapital ?? req.body.investmentAmount;
        const allottedCapital = req.body.strategyCapital !== undefined ? req.body.strategyCapital : req.body.allottedCapital;
        // Self-service is limited to the investment mode and the personal target / stop-loss points (the Flash Trade settings popup); limits, capital (investmentAmount is the base the daily/weekly loss limits are
        // measured against), exit mode (useGTT), broker, profit split and the enabled flag are admin-controlled (a trader must not be able to raise their own loss limit or re-enable a disabled account).
        if (!requestIsLoopback(req)) {
            const caller = await getUser(resolveUser(req) ?? '');
            if (caller?.role !== 'admin') {
                const restricted = { lossLimit, lotCount, investmentAmount, useGTT, broker, brokers, perOrderCap, allottedCapital, profitSplitPercent, enabled, investmentModeLocked, proficiencyLevel };
                const attempted = Object.entries(restricted).filter(([, v]) => v !== undefined).map(([k]) => k);
                if (attempted.length > 0) {
                    res.status(403).json({ error: `Only an admin can change: ${attempted.join(', ')}` });
                    return;
                }
                // Level gating (src/levelGate.ts): a Beginner cannot choose fixed lots or set their own target / stop-loss.
                const gate = gateSettings({ role: caller?.role, level: (await getUser(email))?.proficiencyLevel, investmentMode, targetPoints, stopLossPoints });
                if (!gate.allowed) { res.status(403).json({ error: gate.error }); return; }
                // An admin can lock a user's investment mode; a locked user cannot change it (sending the unchanged value is harmless).
                if (investmentMode !== undefined) {
                    const target = await getUser(email);
                    if (target?.investmentModeLocked === true && investmentMode !== target.investmentMode) {
                        res.status(403).json({ error: 'Your investment mode has been locked by an admin' });
                        return;
                    }
                }
            }
        }
        const bad = (msg: string) => { res.status(400).json({ error: msg }); };
        const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
        if (lossLimit !== undefined && !(finite(lossLimit) && lossLimit >= 0)) return bad('lossLimit must be a number >= 0');
        if (lotCount !== undefined && !(Number.isInteger(lotCount) && lotCount > 0)) return bad('lotCount must be a positive integer');
        if (investmentMode !== undefined && investmentMode !== 'lotCount' && investmentMode !== 'investmentAmount') return bad("investmentMode must be 'lotCount' or 'investmentAmount'");
        if (investmentAmount !== undefined && !(finite(investmentAmount) && investmentAmount > 0 && investmentAmount <= MAX_INVESTMENT_AMOUNT)) return bad(`investmentAmount must be a number in (0, ${MAX_INVESTMENT_AMOUNT}]`);
        if (useGTT !== undefined && typeof useGTT !== 'boolean') return bad('useGTT must be a boolean');
        if (enabled !== undefined && typeof enabled !== 'boolean') return bad('enabled must be a boolean');
        if (investmentModeLocked !== undefined && typeof investmentModeLocked !== 'boolean') return bad('investmentModeLocked must be a boolean');
        for (const [k, v] of Object.entries({ perOrderCap, allottedCapital, targetPoints, stopLossPoints })) {
            // null clears the override
            if (v !== undefined && v !== null && !(finite(v) && (v as number) >= 0)) return bad(`${k} must be a number >= 0 (or null to clear)`);
        }
        for (const [k, v] of Object.entries({ targetPoints, stopLossPoints })) {
            if (v !== undefined && v !== null && !((v as number) > 0)) return bad(`${k} must be greater than 0 (or null to clear)`);
        }
        if (profitSplitPercent !== undefined && !(finite(profitSplitPercent) && profitSplitPercent >= 0)) return bad('profitSplitPercent must be a number >= 0');
        if (proficiencyLevel !== undefined && proficiencyLevel !== 'beginner' && proficiencyLevel !== 'advanced') return bad("proficiencyLevel must be 'beginner' or 'advanced'");
        if (profitSplitPercent !== undefined && profitSplitPercent > 100) return bad('profitSplitPercent must be <= 100');
        if (Object.values({ lossLimit, lotCount, investmentMode, investmentAmount, useGTT, broker, brokers, perOrderCap, allottedCapital, targetPoints, stopLossPoints, profitSplitPercent, enabled, investmentModeLocked, proficiencyLevel }).every((v) => v === undefined)) return bad('No settings supplied');
        if (broker !== undefined && !isUserBroker(broker)) {
            res.status(400).json({ error: `Invalid broker '${broker}' (expected ${USER_BROKERS_TEXT})` });
            return;
        }
        // `brokers`: a list of 1+ user brokers; more than one (every frontend buy fans out to each, independently) is for an admin account only.
        if (brokers !== undefined) {
            if (!Array.isArray(brokers) || brokers.length === 0 || !brokers.every(isUserBroker)) return bad(`brokers must be a non-empty list of: ${USER_BROKERS_TEXT}`);
            if (new Set(brokers.map(normalizeBrokerName)).size > 1 && (await getUser(email))?.role !== 'admin') {
                res.status(403).json({ error: 'Trading on several brokers at once is available to the admin account only' });
                return;
            }
        }
        // Advanced is permanent (no downgrade, any caller) and is reached through applyAdvanced (advancedSince/Via, the Advanced share and capital), never by writing the level directly;
        // the other fields of this same request are applied after it, so an explicit capital / split still wins.
        let levelToWrite: 'beginner' | 'advanced' | undefined = undefined;
        if (proficiencyLevel !== undefined) {
            const target = await getUser(email);
            if (!target) { res.status(404).json({ error: 'User not found' }); return; }
            const change = gateLevelChange(target.proficiencyLevel, proficiencyLevel);
            if (!change.allowed) { res.status(403).json({ error: change.error }); return; }
            if (proficiencyLevel === 'advanced' && normalizeLevel(target.proficiencyLevel) !== 'advanced') await applyAdvanced(email, { via: 'admin' });
        }
        const user = await updateUserSettings(email, { lossLimit, lotLimit: lotCount, investmentMode, investmentModeLocked, accountCapital: investmentAmount, useGTT, broker, brokers, perOrderCap, strategyCapital: allottedCapital, targetPoints, stopLossPoints, profitSplitPercent, enabled, proficiencyLevel: levelToWrite });
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        invalidateUserCache(email); // a user an admin just disabled must stop working now, not after the 15s cache TTL
        await pushUserToOrderProcess(user, 'push');
        res.json(toClientUser(user));
    } catch (e) {
        console.error('Update settings error:', e);
        res.sendStatus(500);
    }
});

router.patch('/users/:email/profile', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { phone, legalName } = req.body;
        if (phone === undefined && legalName === undefined) { res.status(400).json({ error: 'phone or legalName is required' }); return; }
        const user = await updateProfileFields(email, { phone, legalName });
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        res.json(toClientUser(user));
    } catch (e: any) {
        console.error('Profile update error:', e);
        res.status(/must be|invalid|too long/.test(e?.message ?? '') ? 400 : 500).json({ error: e?.message ?? 'Failed to update profile' });
    }
});

router.patch('/users/:email/kyc-numbers', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { aadharNumber, panNumber } = req.body;
        if (aadharNumber === undefined && panNumber === undefined) {
            res.status(400).json({ error: 'aadharNumber or panNumber is required' }); return;
        }
        let user = await getUser(email);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        if (aadharNumber !== undefined) user = await updateSensitiveField(email, 'aadharNumber', aadharNumber);
        if (panNumber !== undefined) user = await updateSensitiveField(email, 'panNumber', panNumber);
        res.json(toClientUser(user!));
    } catch (e: any) {
        console.error('KYC numbers update error:', e);
        res.status(400).json({ error: e.message || 'Failed to update KYC numbers' });
    }
});

router.patch('/users/:email/bank-details', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { bankAccountHolderName, bankAccountNumber, bankIFSC, upiId } = req.body;
        const user = await updateBankDetails(email, { bankAccountHolderName, bankAccountNumber, bankIFSC, upiId });
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        res.json(toClientUser(user));
    } catch (e: any) {
        console.error('Bank details update error:', e);
        res.status(/must be|invalid|too long/.test(e?.message ?? '') ? 400 : 500).json({ error: e?.message ?? 'Failed to update bank details' });
    }
});

router.patch('/users/:email/entity-type', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { entityType } = req.body;
        if (entityType !== 'individual' && entityType !== 'company') {
            res.status(400).json({ error: 'entityType must be individual or company' }); return;
        }
        const user = await updateEntityType(email, entityType);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        res.json(toClientUser(user));
    } catch (e: any) {
        console.error('Entity type update error:', e);
        res.status(400).json({ error: e.message || 'Failed to update entity type' });
    }
});

router.patch('/users/:email/company-profile', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { gstin, companyRegisteredName, acceptAdvancedTerms } = req.body;
        // Giving a GSTIN makes a company Beginner Advanced at once (src/levelUpgrade.ts gstinUpgradeDecision); an invoice is then due for every payment.
        const before = await getUser(email);
        if (!before) { res.status(404).json({ error: 'User not found' }); return; }
        const decision = gstinUpgradeDecision({ callerEmail: resolveUser(req), email, user: before, gstin, accepted: acceptAdvancedTerms });
        if (decision.action === 'reject') { res.status(400).json({ error: decision.reason }); return; }
        let user = await updateCompanyProfile(email, { gstin, companyRegisteredName });
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        if (decision.action === 'upgrade') {
            user = await applyAdvanced(email, { via: 'gstin' });
            invalidateUserCache(email);
            await pushUserToOrderProcess(user, 'gstin-upgrade');
            sendUpgradeEmail(email).catch((e) => Log.log('[users] upgrade email failed', e?.message ?? e));
        }
        res.json(toClientUser(user));
    } catch (e: any) {
        console.error('Company profile update error:', e);
        res.status(400).json({ error: e.message || 'Failed to update company profile' });
    }
});

router.patch('/users/:email/verify', requireAdmin, async function (req, res) {
    try {
        const { email } = req.params;
        const { field, verified } = req.body;
        const validFields: Record<string, string> = {
            email: 'emailVerified', phone: 'phoneVerified',
            address: 'addressVerified', dob: 'dobVerified', pan: 'panVerified',
            aadhar: 'aadharVerified', gst: 'gstVerified',
        };
        if (typeof field !== 'string' || !Object.prototype.hasOwnProperty.call(validFields, field)) {
            res.status(400).json({ error: 'field must be email, phone, address, dob, pan, aadhar, or gst' }); return;
        }
        if (typeof verified !== 'boolean') { res.status(400).json({ error: 'verified must be a boolean' }); return; }
        const update = { [validFields[field]]: verified };
        const user = await getUser(email);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        await Mongo.getInstance().db.collection('users').updateOne({ email }, { $set: update });
        res.json(toClientUser({ ...user, ...update }));
    } catch (e) {
        console.error('Verify update error:', e);
        res.sendStatus(500);
    }
});

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Extracts the PAN/Aadhaar number directly from the uploaded document via
// OCR, rather than trusting a self-typed number that might not match the
// proof actually on file. PDFs are rasterized to a PNG (first page) before
// OCR - tesseract can't read a PDF's text layer/vector content directly, and
// scanned KYC documents usually have no text layer to read anyway.
//
// A raw full-page/full-photo render defeats Tesseract outright (confirmed
// live: a card occupying a fraction of an A4 page yields 0 confidence, even
// at high scale) - it needs to be trimmed down to just the card first. And a
// phone photo or scan is routinely landscape/upside-down relative to the
// page, which plain OCR also can't handle. So: auto-trim the whitespace
// border (sharp's default trim threshold is too strict for the light
// background texture typical of these cards - 50 was verified live against
// real PAN/Aadhaar documents), then try each rotation in turn, applying
// grayscale+normalize before each attempt (also verified necessary live -
// the guilloche watermark pattern on these cards otherwise confuses
// Tesseract's text detection), stopping at the first rotation that yields a
// valid-looking match.
const PAN_NUMBER_PATTERN = /[A-Z]{5}[0-9]{4}[A-Z]/;
const AADHAR_NUMBER_PATTERN = /\d{4}[\s-]?\d{4}[\s-]?\d{4}/;
const OCR_TRIM_THRESHOLD = 50;
const OCR_ROTATIONS = [0, 90, 180, 270] as const;

// Magic-byte sniffing for the KYC upload allow-list (JPEG / PNG / PDF).
export function detectDocumentType(buf: Buffer): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    return null;
}

// OCR is CPU-heavy and runs in this single-threaded process: one at a time (the rest queue), each bounded by a timeout,
// so a burst of uploads cannot stall SSE/API/auth for everyone.
const OCR_TIMEOUT_MS = 60_000;
let ocrChain: Promise<unknown> = Promise.resolve();
let ocrWaiting = 0;
const OCR_MAX_QUEUED = 3; // each queued upload holds a 5 MB buffer and its HTTP request: refuse beyond this instead of piling up
function runOcrExclusive<T>(job: () => Promise<T>): Promise<T> {
    if (ocrWaiting >= OCR_MAX_QUEUED) return Promise.reject(new Error('OCR is busy - try again in a minute'));
    ocrWaiting++;
    const run = ocrChain.then(() => Promise.race([
        job(),
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('OCR timed out')), OCR_TIMEOUT_MS)),
    ]));
    ocrChain = run.catch(() => undefined);
    run.then(() => undefined, () => undefined).finally(() => { ocrWaiting--; });
    return run;
}

async function extractIdNumber(docType: 'pan' | 'aadhar', buffer: Buffer, mimetype: string): Promise<string | null> {
    let imageBuffer: Buffer = buffer;
    if (mimetype === 'application/pdf') {
        // pdf-to-img is ESM-only; this project compiles to CommonJS, so it
        // must be dynamically imported rather than statically at the top of
        // the file.
        // A PDF with an enormous MediaBox would be rasterised at scale 5 into a gigantic bitmap: an ID card is A4-sized at most.
        const MAX_PDF_POINTS = 2000;
        for (const m of buffer.toString('latin1').matchAll(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g)) {
            const w = Math.abs(Number(m[3]) - Number(m[1])), h = Math.abs(Number(m[4]) - Number(m[2]));
            if (!(w > 0 && h > 0) || w > MAX_PDF_POINTS || h > MAX_PDF_POINTS) throw new Error('PDF page size is not supported');
        }
        const { pdf } = await import('pdf-to-img');
        const doc = await pdf(buffer, { scale: 5 });
        imageBuffer = await doc.getPage(1);
        await doc.destroy();
    }

    const trimmed = await sharp(imageBuffer).trim({ threshold: OCR_TRIM_THRESHOLD }).toBuffer().catch(() => imageBuffer);
    const pattern = docType === 'pan' ? PAN_NUMBER_PATTERN : AADHAR_NUMBER_PATTERN;

    for (const angle of OCR_ROTATIONS) {
        const attempt = await sharp(trimmed).rotate(angle).grayscale().normalize().png().toBuffer();
        // tesseract.js's type defs don't list Buffer under ImageLike, but its
        // Node runtime accepts one directly (documented usage) - safe cast.
        const { data: { text } } = await Tesseract.recognize(attempt as any, 'eng');
        const match = text.toUpperCase().match(pattern);
        if (match) return match[0].replace(/[\s-]/g, '');
    }
    return null;
}

router.post('/users/:email/documents/:docType', requireSelfOrAdmin('email'), upload.single('file'), async function (req, res) {
    try {
        const { email, docType } = req.params;
        if (docType !== 'address' && docType !== 'dob' && docType !== 'pan' && docType !== 'aadhar' && docType !== 'gst') {
            res.status(400).json({ error: 'docType must be address, dob, pan, aadhar, or gst' }); return;
        }
        if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
        const user = await getUser(email);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        // Only real JPEG/PNG/PDF bytes are accepted - the client-declared mimetype is not trusted, so an HTML/SVG
        // payload cannot be stored and later served from this origin.
        const detectedType = detectDocumentType(req.file.buffer);
        if (!detectedType) { res.status(400).json({ error: 'Only JPEG, PNG or PDF files are accepted' }); return; }
        req.file.mimetype = detectedType;

        const bucket = new GridFSBucket(Mongo.getInstance().db, { bucketName: 'documents' });
        const safeName = String(req.file.originalname ?? 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
        const filename = `${email}_${docType}_${Date.now()}_${safeName}`;
        const uploadStream = bucket.openUploadStream(filename, { contentType: detectedType });
        uploadStream.end(req.file.buffer);

        await new Promise<void>((resolve, reject) => {
            uploadStream.on('finish', resolve);
            uploadStream.on('error', reject);
        });

        const fieldMap: Record<string, string> = { address: 'addressProofId', dob: 'dobProofId', pan: 'panCardId', aadhar: 'aadharDocId', gst: 'gstDocId' };
        const field = fieldMap[docType];
        // A replaced document is no longer the one an admin verified, and the old file must not be orphaned.
        const verifiedField: Record<string, string> = { address: 'addressVerified', dob: 'dobVerified', pan: 'panVerified', aadhar: 'aadharVerified', gst: 'gstVerified' };
        const previousId = (user as any)[field];
        await Mongo.getInstance().db.collection('users').updateOne({ email }, { $set: { [field]: uploadStream.id.toString(), [verifiedField[docType]]: false } });
        if (previousId && ObjectId.isValid(previousId)) await bucket.delete(new ObjectId(previousId)).catch(() => undefined);

        let numberExtracted = false;
        if ((docType === 'pan' || docType === 'aadhar') && (req.file.mimetype.startsWith('image/') || req.file.mimetype === 'application/pdf')) {
            try {
                const extracted = await runOcrExclusive(() => extractIdNumber(docType, req.file!.buffer, req.file!.mimetype));
                if (extracted) {
                    await updateSensitiveField(email, docType === 'pan' ? 'panNumber' : 'aadharNumber', extracted);
                    numberExtracted = true;
                }
            } catch (e) {
                console.error(`OCR extraction failed for ${docType}:`, e);
            }
        }

        res.json({ id: uploadStream.id.toString(), filename, numberExtracted });
    } catch (e) {
        console.error('Document upload error:', e);
        res.sendStatus(500);
    }
});

router.get('/users/:email/documents/:docType', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email, docType } = req.params;
        if (docType !== 'address' && docType !== 'dob' && docType !== 'pan' && docType !== 'aadhar' && docType !== 'gst') {
            res.status(400).json({ error: 'docType must be address, dob, pan, aadhar, or gst' }); return;
        }
        const user = await getUser(email);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }

        const fieldMap2: Record<string, string> = { address: 'addressProofId', dob: 'dobProofId', pan: 'panCardId', aadhar: 'aadharDocId', gst: 'gstDocId' };
        const fileId = (user as any)[fieldMap2[docType]];
        if (!fileId) { res.status(404).json({ error: 'Document not found' }); return; }

        const bucket = new GridFSBucket(Mongo.getInstance().db, { bucketName: 'documents' });
        const files = await bucket.find({ _id: new ObjectId(fileId) }).toArray();
        if (!files.length) { res.status(404).json({ error: 'File not found' }); return; }

        // Stored bytes are user-supplied: never let the browser sniff or run them on this origin.
        const storedType = files[0].contentType;
        const type = storedType === 'image/jpeg' || storedType === 'image/png' || storedType === 'application/pdf' ? storedType : 'application/octet-stream';
        const downloadName = String(files[0].filename ?? 'document').replace(/[^A-Za-z0-9._-]/g, '_');
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Disposition', `${type.startsWith('image/') ? 'inline' : 'attachment'}; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        bucket.openDownloadStream(new ObjectId(fileId)).pipe(res);
    } catch (e) {
        console.error('Document download error:', e);
        res.sendStatus(500);
    }
});


export default router;
