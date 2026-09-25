// stdout is reserved for the control-command protocol back to `data` (e.g.
// 'reconnect' for /ant/connect) - redirect console.log to stderr before any
// other module (which may log at import time) loads, same as dataProcess.ts
// and strategiesProcess.ts. Forgetting this corrupts data's stdin JSON parser
// with ordinary log lines.
console.log = console.error;

// Load .env into process.env before any other module - several modules read
// process.env at import time (e.g. src/constants.ts's MOCK_BROKER/MOCK_QUOTES/
// MOCK_DATE), so this must be the very first import. See .env.example for the
// full list of variables this project reads and CLAUDE.md's Environment
// section for which are required. Harmless if this process was itself
// spawned by orchestrator.ts (which already loaded .env into its own
// process.env, inherited by every child it spawns) - dotenv never overwrites
// a variable that's already set.
import 'dotenv/config';

// This host is dual-stack; Node's Happy-Eyeballs connection logic prefers
// IPv6 when both are available, which bypasses Kite's IPv4-only order-
// placement allowlist (OAuth token exchange happens in this process).
// dns.setDefaultResultOrder('ipv4first') looks like the fix but does NOT
// actually change the connected family (confirmed live in orderProcess.ts -
// see kiteDns.ts's comment); forcing IPv4 process-wide also broke Breeze
// (session generation/trade list/positions also happen in this process -
// see Breeze.getInstance() calls below), whose registered "static IP" is
// apparently the IPv6 address. So this is scoped to just Kite's hostname,
// same as orderProcess.ts.
import { installKiteIpv4Override } from './processes/order/kiteDns';
installKiteIpv4Override();

import Log from './util/Log';
import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import path from 'path';
import https from 'https';
import fs from 'fs';
import { Trade } from './model/model';
import configService from './prism/ConfigService';
import { validateFlatConfig } from './prism/configValidation';
import { getOrCreateUser, getUser, getAllUsers, updateUserSettings, createUser, deleteUser, updateUserRole, toClientUser, updateSensitiveField, updateBankDetails, updateEntityType, updateCompanyProfile } from './user';
import { computePayout, createPayoutRecord, markPayoutDecision, generateInvoiceHtml, getPayoutDecisionLog, computePnlSummary } from './payout';
import multer from 'multer';
import { GridFSBucket, ObjectId } from 'mongodb';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import Decision from './decision';
import Mongo from './tools/mongo';
import { dateRangeQuery } from './tools/quoteDateRange';
import myEmitter from './tools/emitter';
import Prism from './prism';
import ANT from './ant/ANT';
import AntContractMaster from './ant/AntContractMaster';
import Zerodha from './zerodha/Zerodha';
import Breeze from './breeze/Breeze';
import BreezeStream from './breeze/BreezeStream';
import OrderClient from './processes/strategies/OrderClient';
import StrategiesClient from './ipc/StrategiesClient';
import { readJsonLines, writeJsonLine } from './ipc/jsonLines';
import { cloudflareOnly, isLoopback } from './middleware/cloudflareOnly';
import { OAuth2Client } from 'google-auth-library';

// `frontend` process (server.ts, unchanged name/entry point - see the plan:
// "frontend should be server.ts itself, edited in place"). Every route below
// keeps its original path/response shape; only the internals changed - broker
// order-execution and strategy state now go over IPC to `order`/`strategies`
// (OrderClient/StrategiesClient) instead of in-process Monitor/strategies.getList()
// calls. Quote-only and OAuth methods on Prism/ANT/Zerodha stay direct library
// calls here (stateless w.r.t. order's bookkeeping) - after a fresh login,
// OrderClient.reloadSession() tells `order`'s already-running Prism/Zerodha
// singletons to re-read the session file so they don't need a restart to see it.
//
// Dropped during this port (see features.md section 13 for the full list):
// the original raw http.createServer block, unused mock constants, commented
// Breeze/localtunnel code, and the second (unreachable) /ant/positions and
// /ant/trades route registrations. Fixed in passing: /search's malformed JSON
// response, /logout's missing response.

// Fail closed: the whole auth model (session-cookie signing, Google ID-token
// verification) is worthless if either secret is missing/guessable - refuse
// to start rather than silently fall back to something insecure.
const SESSION_COOKIE_SECRET = process.env.SESSION_COOKIE_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!SESSION_COOKIE_SECRET) {
    throw new Error('SESSION_COOKIE_SECRET env var is required (session cookie signing secret) - refusing to start.');
}
if (!GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID env var is required (must match frontend VITE_GOOGLE_CLIENT_ID) - refusing to start.');
}
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

var app = express();

app.use(cloudflareOnly);
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser());
app.use(cookieParser(SESSION_COOKIE_SECRET));
app.disable('etag');

const orderClient = OrderClient.getInstance();
const strategiesClient = StrategiesClient.getInstance();

// Resolves the user ONLY from the server-signed session cookie - proves
// nothing was forged, unlike the X-User-Id header this used to also trust
// (any caller could set that header to act as anyone) or the 'Default'
// fallback (a real, tradeable pseudo-user reachable by anyone with no
// identity at all). Returns null when there's no valid session; callers that
// need a guaranteed identity go through requireAuth/requireSelfOrAdmin below
// first, which reject the request before the handler body ever runs.
function resolveUser(req: express.Request): string | null {
    return (req as any).signedCookies?.session || null;
}

// Loopback requests (a process on this same machine - see isLoopback's own
// comment for why that's a safe thing to trust here) skip all three checks
// below entirely, per the user's direct instruction. Used by local ops
// scripts (e.g. scripts/check-broker-sessions.sh) that have no browser
// session to present.
function requestIsLoopback(req: express.Request): boolean {
    return isLoopback(req.socket.remoteAddress);
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (requestIsLoopback(req)) { next(); return; }
    if (!resolveUser(req)) { res.status(401).json({ error: 'Not logged in' }); return; }
    next();
}

async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    if (requestIsLoopback(req)) { next(); return; }
    const email = resolveUser(req);
    if (!email) { res.status(401).json({ error: 'Not logged in' }); return; }
    const user = await getUser(email);
    if (!user || user.role !== 'admin') { res.status(403).json({ error: 'Forbidden' }); return; }
    next();
}

function requireSelfOrAdmin(paramName = 'email') {
    return async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
        if (requestIsLoopback(req)) { next(); return; }
        const email = resolveUser(req);
        if (!email) { res.status(401).json({ error: 'Not logged in' }); return; }
        if (email === req.params[paramName]) { next(); return; }
        const user = await getUser(email);
        if (user?.role === 'admin') { next(); return; }
        res.status(403).json({ error: 'Forbidden' });
    };
}

// ============================== Auth ==============================

app.post('/auth/login', async function (req, res) {
    try {
        const { credential } = req.body;
        if (!credential) {
            res.status(400).json({ error: 'credential (Google ID token) is required' });
            return;
        }
        let payload: { email?: string; name?: string; picture?: string };
        try {
            const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
            payload = ticket.getPayload() ?? {};
        } catch (e) {
            Log.log('Google ID token verification failed:', e);
            res.status(401).json({ error: 'Invalid credential' });
            return;
        }
        const { email, name, picture } = payload;
        if (!email) {
            res.status(400).json({ error: 'Verified token had no email' });
            return;
        }
        const user = await getOrCreateUser(email, name, picture);
        await orderClient.updateUserSettings(email, {
            lossLimit: user.lossLimit,
            lotLimit: user.lotCount,
            investmentMode: user.investmentMode,
            investmentAmount: user.investmentAmount,
            useGTT: user.useGTT,
        }).catch((e) => Log.log('[frontend] updateUserSettings on login failed:', e));
        res.cookie('session', email, { signed: true, httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.json(toClientUser(user));
    } catch (e) {
        Log.log('Login error:', e);
        res.sendStatus(500);
    }
});

app.get('/auth/me', async function (req, res) {
    const email = (req as any).signedCookies?.session;
    if (!email) {
        res.status(401).json({ error: 'Not logged in' });
        return;
    }
    const user = await getUser(email);
    if (!user) {
        res.status(401).json({ error: 'Unknown user' });
        return;
    }
    // A resumed session (cookie only, no fresh POST /auth/login) would
    // otherwise never re-sync this user's settings into the order process's
    // in-memory cache after a restart - refresh it here too, on every session
    // check, so a stale/empty cache entry doesn't silently fall back to
    // hardcoded defaults (e.g. investmentAmount=0) for manual order sizing.
    await orderClient.updateUserSettings(email, {
        lossLimit: user.lossLimit,
        lotLimit: user.lotCount,
        investmentMode: user.investmentMode,
        investmentAmount: user.investmentAmount,
        useGTT: user.useGTT,
        broker: user.broker,
        perOrderCap: user.perOrderCap,
        allottedCapital: user.allottedCapital,
        targetPoints: user.targetPoints,
        stopLossPoints: user.stopLossPoints,
    }).catch((e) => Log.log('[frontend] updateUserSettings on session check failed:', e));
    res.json(toClientUser(user));
});

app.post('/auth/logout', function (req, res) {
    res.clearCookie('session');
    res.sendStatus(200);
});

// ============================== User Management ==============================

app.get('/users', requireAdmin, async function (req, res) {
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

app.post('/users', requireAdmin, async function (req, res) {
    try {
        const { email, name, lossLimit, lotCount, role } = req.body;
        if (!email || !name) {
            res.status(400).json({ error: 'Email and name are required' });
            return;
        }
        const user = await createUser(email, name, lossLimit || 15000, lotCount || 10, role || 'user');
        await orderClient.updateUserSettings(email, {
            lossLimit: user.lossLimit,
            lotLimit: user.lotCount,
            investmentMode: user.investmentMode,
            investmentAmount: user.investmentAmount,
            useGTT: user.useGTT,
        }).catch((e) => Log.log('[frontend] updateUserSettings on create failed:', e));
        res.json(toClientUser(user));
    } catch (e: any) {
        console.error('Create user error:', e);
        if (e.message === 'User already exists') {
            res.status(409).json({ error: 'User already exists' });
        } else {
            res.sendStatus(500);
        }
    }
});

app.delete('/users/:email', requireAdmin, async function (req, res) {
    try {
        const { email } = req.params;
        const success = await deleteUser(email);
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

app.patch('/users/:email/role', requireAdmin, async function (req, res) {
    try {
        const { email } = req.params;
        const { role } = req.body;
        if (!role) {
            res.status(400).json({ error: 'Role is required' });
            return;
        }
        const user = await updateUserRole(email, role);
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

app.post('/users/:email/settings', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { lossLimit, lotCount, investmentMode, investmentAmount, useGTT, broker, perOrderCap, allottedCapital, targetPoints, stopLossPoints, profitSplitPercent, enabled } = req.body;
        const user = await updateUserSettings(email, { lossLimit, lotCount, investmentMode, investmentAmount, useGTT, broker, perOrderCap, allottedCapital, targetPoints, stopLossPoints, profitSplitPercent, enabled });
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        await orderClient.updateUserSettings(email, {
            lossLimit: user.lossLimit,
            lotLimit: user.lotCount,
            investmentMode: user.investmentMode,
            investmentAmount: user.investmentAmount,
            useGTT: user.useGTT,
            broker: user.broker,
            perOrderCap: user.perOrderCap,
            allottedCapital: user.allottedCapital,
            targetPoints: user.targetPoints,
            stopLossPoints: user.stopLossPoints,
        }).catch((e) => Log.log('[frontend] updateUserSettings push failed:', e));
        res.json(toClientUser(user));
    } catch (e) {
        console.error('Update settings error:', e);
        res.sendStatus(500);
    }
});

app.patch('/users/:email/profile', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { phone, legalName } = req.body;
        const user = await getUser(email);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        const update: any = {};
        if (phone !== undefined) update.phone = phone;
        if (legalName !== undefined) update.legalName = legalName;
        await Mongo.getInstance().db.collection('users').updateOne({ email }, { $set: update });
        res.json(toClientUser({ ...user, ...update }));
    } catch (e) {
        console.error('Profile update error:', e);
        res.sendStatus(500);
    }
});

app.patch('/users/:email/kyc-numbers', requireSelfOrAdmin('email'), async function (req, res) {
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

app.patch('/users/:email/bank-details', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { bankAccountHolderName, bankAccountNumber, bankIFSC, upiId } = req.body;
        const user = await updateBankDetails(email, { bankAccountHolderName, bankAccountNumber, bankIFSC, upiId });
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        res.json(toClientUser(user));
    } catch (e) {
        console.error('Bank details update error:', e);
        res.sendStatus(500);
    }
});

app.patch('/users/:email/entity-type', requireSelfOrAdmin('email'), async function (req, res) {
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

app.patch('/users/:email/company-profile', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { gstin, companyRegisteredName } = req.body;
        const user = await updateCompanyProfile(email, { gstin, companyRegisteredName });
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        res.json(toClientUser(user));
    } catch (e: any) {
        console.error('Company profile update error:', e);
        res.status(400).json({ error: e.message || 'Failed to update company profile' });
    }
});

app.patch('/users/:email/verify', requireAdmin, async function (req, res) {
    try {
        const { email } = req.params;
        const { field, verified } = req.body;
        const validFields: Record<string, string> = {
            email: 'emailVerified', phone: 'phoneVerified',
            address: 'addressVerified', dob: 'dobVerified', pan: 'panVerified',
            aadhar: 'aadharVerified', gst: 'gstVerified',
        };
        if (!validFields[field]) {
            res.status(400).json({ error: 'field must be email, phone, address, dob, pan, aadhar, or gst' }); return;
        }
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

async function extractIdNumber(docType: 'pan' | 'aadhar', buffer: Buffer, mimetype: string): Promise<string | null> {
    let imageBuffer: Buffer = buffer;
    if (mimetype === 'application/pdf') {
        // pdf-to-img is ESM-only; this project compiles to CommonJS, so it
        // must be dynamically imported rather than statically at the top of
        // the file.
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

app.post('/users/:email/documents/:docType', requireSelfOrAdmin('email'), upload.single('file'), async function (req, res) {
    try {
        const { email, docType } = req.params;
        if (docType !== 'address' && docType !== 'dob' && docType !== 'pan' && docType !== 'aadhar' && docType !== 'gst') {
            res.status(400).json({ error: 'docType must be address, dob, pan, aadhar, or gst' }); return;
        }
        if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
        const user = await getUser(email);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }

        const bucket = new GridFSBucket(Mongo.getInstance().db, { bucketName: 'documents' });
        const filename = `${email}_${docType}_${Date.now()}_${req.file.originalname}`;
        const uploadStream = bucket.openUploadStream(filename, { contentType: req.file.mimetype });
        uploadStream.end(req.file.buffer);

        await new Promise<void>((resolve, reject) => {
            uploadStream.on('finish', resolve);
            uploadStream.on('error', reject);
        });

        const fieldMap: Record<string, string> = { address: 'addressProofId', dob: 'dobProofId', pan: 'panCardId', aadhar: 'aadharDocId', gst: 'gstDocId' };
        const field = fieldMap[docType];
        await Mongo.getInstance().db.collection('users').updateOne({ email }, { $set: { [field]: uploadStream.id.toString() } });

        let numberExtracted = false;
        if ((docType === 'pan' || docType === 'aadhar') && (req.file.mimetype.startsWith('image/') || req.file.mimetype === 'application/pdf')) {
            try {
                const extracted = await extractIdNumber(docType, req.file.buffer, req.file.mimetype);
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

app.get('/users/:email/documents/:docType', requireSelfOrAdmin('email'), async function (req, res) {
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

        res.setHeader('Content-Type', files[0].contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${files[0].filename}"`);
        bucket.openDownloadStream(new ObjectId(fileId)).pipe(res);
    } catch (e) {
        console.error('Document download error:', e);
        res.sendStatus(500);
    }
});

// ============================== Payments & Payouts ==============================
// Manual admin record-keeping, no payment gateway integration - admin reviews
// a computed payout and marks it paid/rejected, mirroring the existing manual
// KYC-verification-toggle pattern above. Amounts are always server-recomputed
// from persisted closedTrades (never trusted from the client).

app.get('/users/:email/payouts', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const payouts = await Mongo.getInstance().db.collection('payouts').find({ user: email }).sort({ createdAt: -1 }).toArray();
        res.json(payouts);
    } catch (e) {
        console.error('Get payouts error:', e);
        res.sendStatus(500);
    }
});

app.get('/users/:email/payouts/:id/invoice', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const html = await generateInvoiceHtml(req.params.id);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (e: any) {
        console.error('Generate invoice error:', e);
        res.status(404).json({ error: e.message || 'Payout not found' });
    }
});

app.get('/users/:email/payouts/:id/decision-log', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const entries = await getPayoutDecisionLog(req.params.id);
        res.json(entries);
    } catch (e) {
        console.error('Get payout decision log error:', e);
        res.sendStatus(500);
    }
});

app.get('/admin/payouts', requireAdmin, async function (req, res) {
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

app.post('/admin/payouts/compute', requireAdmin, async function (req, res) {
    try {
        const { user, periodStart, periodEnd } = req.body;
        if (!user || !periodStart || !periodEnd) {
            res.status(400).json({ error: 'user, periodStart, and periodEnd are required' }); return;
        }
        const computation = await computePayout(user, new Date(periodStart), new Date(periodEnd));
        res.json(computation);
    } catch (e: any) {
        console.error('Compute payout error:', e);
        res.status(400).json({ error: e.message || 'Failed to compute payout' });
    }
});

app.post('/admin/payouts', requireAdmin, async function (req, res) {
    try {
        const { user, periodStart, periodEnd } = req.body;
        if (!user || !periodStart || !periodEnd) {
            res.status(400).json({ error: 'user, periodStart, and periodEnd are required' }); return;
        }
        const payout = await createPayoutRecord(user, new Date(periodStart), new Date(periodEnd));
        res.json(payout);
    } catch (e: any) {
        console.error('Create payout error:', e);
        res.status(400).json({ error: e.message || 'Failed to create payout' });
    }
});

app.patch('/admin/payouts/:id', requireAdmin, async function (req, res) {
    try {
        const { status, note } = req.body;
        if (status !== 'paid' && status !== 'rejected') {
            res.status(400).json({ error: 'status must be paid or rejected' }); return;
        }
        const adminEmail = resolveUser(req);
        const payout = await markPayoutDecision(req.params.id, status, note, adminEmail);
        res.json(payout);
    } catch (e: any) {
        console.error('Mark payout decision error:', e);
        res.status(400).json({ error: e.message || 'Failed to update payout' });
    }
});

// ============================== Broker OAuth ==============================
// Three independent flows, none sharing a session file/cookie with each other
// or with the app-level `session` cookie above. Each singleton's session file
// is __dirname-relative (repo root), so writing it here and reading it in
// `order`/`data` works across processes without any extra plumbing - only the
// already-running singletons need telling to re-read it (reloadSession, below).

let authorizationCode = '';

app.get('/prism/oauthurl', function (_req, res) {
    const url = Prism.getInstance().getOAuthURL();
    res.json({ url });
});

app.get('/prism/login', async function (req, res) {
    try {
        const url = Prism.getInstance().getOAuthURL();
        Log.log('Redirecting to Shoonya authorization:', url);
        res.redirect(302, url);
    } catch (e: any) {
        Log.log('Shoonya login error:', e);
        res.status(500).json({ error: 'Failed to initiate Shoonya login' });
    }
});

const shoonyaCallback = async function (req: express.Request, res: express.Response) {
    const code = req.query.code as string;
    if (!code) {
        res.status(400).json({ error: 'No authorization code received' });
        return;
    }
    try {
        authorizationCode = code;
        Log.log('Authorization code received, exchanging for token');
        await Prism.getInstance().loginWithGenAcsTok(code);
        await orderClient.reloadSession().catch((e) => Log.log('[frontend] reloadSession failed:', e));
        Log.log('Shoonya authentication successful.');
        res.redirect(302, '/');
    } catch (e: any) {
        Log.log('Shoonya callback error:', e);
        res.status(500).json({ error: 'Authentication failed', details: e.message });
    }
};

app.get('/prism/callback', shoonyaCallback);
// Shoonya's registered OAuth app redirect URI is /shoonya/callback (a broker-side
// dashboard setting, not something this code controls) - alias it to the same
// handler rather than requiring the app registration to change.
app.get('/shoonya/callback', shoonyaCallback);

app.get('/prism/authcode', function (_req, res) {
    if (!authorizationCode) {
        res.status(404).json({ error: 'No authorization code stored' });
        return;
    }
    res.json({ code: authorizationCode });
});

app.get('/prism/token', async function (req, res) {
    Log.log('Logging in with GenAcsTok');
    try {
        const { code } = req.query;
        if (!code) {
            res.status(400).json({ error: 'code parameter required' });
            return;
        }
        await Prism.getInstance().loginWithGenAcsTok(code as string);
        await orderClient.reloadSession().catch((e) => Log.log('[frontend] reloadSession failed:', e));
        res.sendStatus(200);
    } catch (e) {
        Log.log('GenAcsTok login error:', e);
        res.sendStatus(500);
    }
});

app.get('/ant/login', async function (req, res) {
    try {
        const ant = ANT.getInstance();
        const authUrl = ant.getAuthorizationUrl();
        Log.log('Redirecting to ANT authorization:', authUrl);
        res.redirect(302, authUrl);
    } catch (e: any) {
        Log.log('ANT login error:', e);
        res.status(500).json({ error: 'Failed to initiate ANT login' });
    }
});

app.get('/ant/callback', async function (req, res) {
    try {
        const authCode = req.query.authCode as string;
        const userId = req.query.userId as string;
        if (!authCode || !userId) {
            Log.log('Missing authCode or userId in callback');
            res.status(400).json({ error: 'Missing authCode or userId from Alice Blue' });
            return;
        }
        Log.log('ANT Callback received - exchanging authCode for token');
        const ant = ANT.getInstance();
        const result = await ant.exchangeAuthCodeForToken(userId, authCode);
        res.cookie('ant_session', result.userSession, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
        // Tell `data` to (re)connect now that a session exists - same mechanism
        // /ant/connect uses (see below), needed here since `data` typically
        // started before this login flow completed and may not be connected yet.
        writeJsonLine(process.stdout, { cmd: 'reconnect' });
        // Same problem exists in `order`: its own ANT singleton loaded whatever
        // (possibly stale/absent) session was on disk when it started, and
        // AntOrderNotifyStream.connect() only ever ran once at that startup -
        // so it never picks up today's login without this. reloadSession()
        // re-reads .ant_session.json and (re)connects the order-notify stream.
        await orderClient.reloadSession().catch((e) => Log.log('[frontend] reloadSession failed:', e));
        Log.log('ANT Authentication successful. Token stored.');
        res.redirect(302, '/');
    } catch (e: any) {
        Log.log('ANT callback error:', e);
        res.status(500).json({ error: 'Authentication failed', details: e.message });
    }
});

app.get('/kite/login', async function (req, res) {
    try {
        const zerodha = Zerodha.getInstance();
        const loginUrl = zerodha.getLoginURL();
        Log.log('Redirecting to Zerodha login:', loginUrl);
        res.redirect(302, loginUrl);
    } catch (e: any) {
        Log.log('Zerodha login error:', e);
        res.status(500).json({ error: 'Failed to initiate Zerodha login' });
    }
});

app.get('/kite/callback', async function (req, res) {
    try {
        const requestToken = req.query.request_token as string;
        if (!requestToken) {
            Log.log('Missing request_token in Zerodha callback');
            res.status(400).json({ error: 'Missing request_token from Zerodha' });
            return;
        }
        Log.log('Zerodha Callback received - exchanging request_token for access_token');
        const zerodha = Zerodha.getInstance();
        const result = await zerodha.exchangeRequestTokenForSession(requestToken);
        res.cookie('zerodha_session', result.access_token, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
        await orderClient.reloadSession().catch((e) => Log.log('[frontend] reloadSession failed:', e));
        Log.log('Zerodha Authentication successful. Token stored.');
        res.redirect(302, '/');
    } catch (e: any) {
        Log.log('Zerodha callback error:', e);
        res.status(500).json({ error: 'Authentication failed', details: e.message });
    }
});

app.get('/breeze/login', async function (req, res) {
    try {
        const breeze = Breeze.getInstance();
        const loginUrl = breeze.getLoginURL();
        Log.log('Redirecting to Breeze login:', loginUrl);
        res.redirect(302, loginUrl);
    } catch (e: any) {
        Log.log('Breeze login error:', e);
        res.status(500).json({ error: 'Failed to initiate Breeze login' });
    }
});

// ICICI's redirect back to this route can hand the session value back either
// as a GET query param or as POST form data (unconfirmed which until a live
// login - see ToDo.md), so this accepts both methods and checks query/body
// under either of the two param names ICICI's own docs/SDK use.
async function handleBreezeCallback(req: express.Request, res: express.Response) {
    try {
        const apiSession = (req.query.apisession ?? req.query.API_Session ?? req.body?.apisession ?? req.body?.API_Session) as string;
        if (!apiSession) {
            Log.log('Missing API_Session in Breeze callback', { query: req.query, body: req.body });
            res.status(400).json({ error: 'Missing API_Session from ICICI Breeze' });
            return;
        }
        Log.log('Breeze Callback received - generating session');
        const breeze = Breeze.getInstance();
        await breeze.generateSession(apiSession);
        // Tell `data` to (re)connect its BreezeDataStream now that a session
        // exists - mirrors /ant/callback's same-purpose signal below. Without
        // this, a Breeze login completing after `data` already started (the
        // common case, since `data`'s own initial connect attempt fails with
        // no session yet) leaves BreezeDataStream stuck until a full restart.
        writeJsonLine(process.stdout, { cmd: 'reconnect', source: 'breeze' });
        await orderClient.reloadSession().catch((e) => Log.log('[frontend] reloadSession failed:', e));
        Log.log('Breeze Authentication successful. Session stored.');
        res.redirect(302, '/');
    } catch (e: any) {
        Log.log('Breeze callback error:', e);
        res.status(500).json({ error: 'Authentication failed', details: e.message });
    }
}
app.get('/breeze/callback', handleBreezeCallback);
app.post('/breeze/callback', handleBreezeCallback);

// Manual test-order route for the Breeze integration (admin-only, mirrors the
// admin/debug nature of the other manual broker routes above) - resolves the
// live NIFTY ATM contract and places a bare (unprotected) limit buy via
// breezeExecutor.buyIndexOnBreeze. Square-off reuses the existing generic
// /order/squareoff route unchanged (see brokerExecutors.getBrokerExecutor -
// Breeze-aware once the placing user's `broker` setting is 'breeze').
// `user` query override: this route is requireAdmin-gated and single-purpose
// (manual test-order tooling) - loopback callers (e.g. curl from this same
// machine) have no session cookie, so resolveUser(req) is always null for
// them. Falls back to the session user when present, matching the same
// "loopback == trusted, but needs an explicit identity" gap requireAuth's own
// header comment already describes for local ops scripts. Deliberately not
// applied to resolveUser() itself or to /order/squareoff - narrowly scoped to
// these two debug routes only, so it can't reintroduce the X-User-Id-header
// trust that was deliberately removed elsewhere (see ToDo.md, 2026-09-10).
app.get('/breeze/order/buy', requireAdmin, async function (req, res) {
    try {
        const { right, user: userOverride } = req.query;
        const user = (userOverride as string) || resolveUser(req);
        const result = await orderClient.breezeBuyIndex(user, { right: right as string });
        res.json(result);
    } catch (e: any) {
        Log.log(e);
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});

// Dedicated Breeze square-off (see orderProcess.ts's 'breezeSquareOff' case
// for why this bypasses the generic /order/squareoff route).
app.get('/breeze/order/squareoff', requireAdmin, async function (req, res) {
    try {
        const { tsym, qty, user: userOverride } = req.query;
        const user = (userOverride as string) || resolveUser(req);
        const result = await orderClient.breezeSquareOff(user, { tsym: tsym as string, quantity: Number(qty) });
        res.json(result);
    } catch (e: any) {
        Log.log(e);
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});

// Starts BreezeStream (live price ticks, this `frontend` process only - NOT
// wired into Monitor/Decision, matching AntStream's own "isolated" scope for
// a first pass) - mirrors /ant/connect's role. NOT yet live-verified - see
// ToDo.md. The `order`-process order-notify stream (needed for
// waitForBreezeFill's push path) connects separately, automatically, at
// `order` process startup/reloadSession (see orderProcess.ts's
// connectBreezeOrderNotifyIfSessionValid) - nothing to trigger here for that.
app.get('/breeze/connect', requireAdmin, async function (req, res) {
    try {
        BreezeStream.getInstance().connect();
        res.json({ status: 'connected' });
    } catch (e: any) {
        Log.log('Breeze connect error:', e);
        res.status(500).json({ error: 'Failed to connect to Breeze streaming', details: e.message });
    }
});

const breezeStreamClients = new Set<express.Response>();
app.get('/breeze/stream', requireAdmin, function (req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    breezeStreamClients.add(res);
    req.on('close', () => breezeStreamClients.delete(res));
});
myEmitter.on('breeze-quote', (tick: any) => {
    const payload = `data: ${JSON.stringify(tick)}\n\n`;
    for (const res of breezeStreamClients) res.write(payload);
});

// ============================== Broker debug/ops queries (admin-only) ==============================
// Consolidates the old broker-specific /kite/trades+/ant/trades and
// /kite/positions+/ant/positions (plus /kite/token+/ant/token, deleted
// outright - raw session-token exposure over HTTP with zero callers) into
// one parameterized pair - a bonus: this also adds Prism support these debug
// routes never had. Deliberately calls ANT/Zerodha/Prism's own
// getTrades()/getPositions() directly (same as the routes this replaces),
// NOT the order-process-only BrokerExecutor abstraction (brokerExecutors.ts)
// - that pulls in bookkeeping.ts/exitMonitor.ts, which are `order`-process
// state this `frontend` process has no business touching (see this file's
// own header comment on the IPC process split).
async function getBrokerTrades(broker: string): Promise<any[]> {
    if (broker === 'zerodha') return Zerodha.getInstance().getTrades();
    if (broker === 'ant') return ANT.getInstance().getTrades();
    if (broker === 'prism') return Prism.getInstance().getTradeList();
    if (broker === 'breeze') {
        const toDate = new Date();
        const fromDate = new Date(toDate);
        fromDate.setDate(fromDate.getDate() - 7);
        const result = await Breeze.getInstance().getTradeList({ fromDate: fromDate.toISOString(), toDate: toDate.toISOString(), exchangeCode: 'NFO' });
        return Array.isArray(result?.Success) ? result.Success : [];
    }
    throw new Error(`Unknown broker '${broker}' - expected zerodha, ant, prism, or breeze`);
}
async function getBrokerPositions(broker: string): Promise<any[]> {
    if (broker === 'zerodha') return Zerodha.getInstance().getPositions();
    if (broker === 'ant') return ANT.getInstance().getPositions();
    if (broker === 'prism') return Prism.getInstance().getPositions();
    if (broker === 'breeze') {
        const result = await Breeze.getInstance().getPortfolioPositions();
        return Array.isArray(result?.Success) ? result.Success : [];
    }
    throw new Error(`Unknown broker '${broker}' - expected zerodha, ant, prism, or breeze`);
}

app.get('/broker/:broker/trades', requireAdmin, async function (req, res) {
    try {
        const trades = await getBrokerTrades(req.params.broker);
        res.json({ success: true, broker: req.params.broker, trades });
    } catch (e: any) {
        Log.log(`${req.params.broker} trades error:`, e);
        res.status(e.message.startsWith('Unknown broker') ? 400 : 500).json({ error: 'Failed to fetch trades', details: e.message });
    }
});

app.get('/broker/:broker/positions', requireAdmin, async function (req, res) {
    try {
        const positions = await getBrokerPositions(req.params.broker);
        res.json({ success: true, broker: req.params.broker, positions });
    } catch (e: any) {
        Log.log(`${req.params.broker} positions error:`, e);
        res.status(e.message.startsWith('Unknown broker') ? 400 : 500).json({ error: 'Failed to fetch positions', details: e.message });
    }
});

// ============================== ANT connect / raw stream ==============================
// `data` auto-connects and auto-reconnects on its own now (see AntDataStream's
// backoff logic), so /ant/connect is a manual trigger for parity rather than
// the only way to get connected - it writes a control command on frontend's
// own stdout, which the orchestrator pipes into `data`'s stdin (mirroring how
// `strategies` talks to `data`).
app.get('/ant/connect', requireAdmin, async function (req, res) {
    try {
        writeJsonLine(process.stdout, { cmd: 'reconnect' });
        res.json({ status: 'connected' });
    } catch (e: any) {
        Log.log('ANT connect error:', e);
        res.status(500).json({ error: 'Failed to connect to ANT streaming', details: e.message });
    }
});

const antStreamClients = new Set<express.Response>();
app.get('/ant/stream', requireAdmin, function (req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    antStreamClients.add(res);
    req.on('close', () => antStreamClients.delete(res));
});

app.get('/prism/canPlaceOrder', requireAuth, async function (req: express.Request, res) {
    try {
        const result = await orderClient.canPlaceOrder(resolveUser(req));
        res.send(result);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/prism/orderbook', requireAdmin, async function (req: express.Request, res) {
    try {
        const orders = await orderClient.getOrders();
        res.send(orders);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

// ============================== Order Placement & Execution ==============================

// Generic order placement - dispatches Zerodha-or-ANT internally via
// bookkeeping.getUserBroker (manualBuy/squareOff/setTargetStopLoss). Renamed
// from /prism/order/buy, /prism/squareoff, /prism/settarget - despite the
// old name, none of these ever called prismExecutor.ts; the "prism" prefix
// was actively misleading now that Prism is a real third broker with its own
// distinct routes elsewhere.
app.get('/order/buy', requireAuth, async function (req: express.Request, res) {
    try {
        const { right, index, strikePrice, price, contract, targetPoints, stopLossPoints } = req.query;
        const user = resolveUser(req);
        Log.log('Resolved order while placing an order ', user);
        const result = await orderClient.manualBuy(user, {
            index: index as any,
            right: right as string,
            contract: contract as string,
            strikePrice: strikePrice ? parseInt(strikePrice as string) : undefined,
            price: price ? parseFloat(price as string) : undefined,
            targetPoints: targetPoints ? parseFloat(targetPoints as string) : undefined,
            stopLossPoints: stopLossPoints ? parseFloat(stopLossPoints as string) : undefined,
        });
        res.json(result);
    } catch (e: any) {
        Log.log(e);
        res.status(e?.message?.includes('limit') ? 403 : 500).json({ error: e?.message ?? String(e) });
    }
});

app.get('/order/squareoff', requireAuth, async function (req, res) {
    try {
        const { token, qty, tsym } = req.query;
        const user = resolveUser(req);
        await orderClient.squareOff(user, {
            token: token as string,
            tsym: tsym as string,
            quantity: qty ? Number(qty) : undefined,
        });
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.post('/order/settarget', requireAuth, express.json(), async function (req: express.Request, res) {
    try {
        const { token, targetPoints, stopLossPoints } = req.body;
        if (!token || targetPoints == null || stopLossPoints == null) {
            res.status(400).json({ error: 'Missing token, targetPoints, or stopLossPoints' });
            return;
        }
        const user = resolveUser(req);
        await orderClient.setTargetStopLoss(user, token, targetPoints, stopLossPoints);
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/connect', requireAdmin, async function (req: express.Request, res) {
    try {
        await orderClient.connectPrism();
        res.sendStatus(200);
    } catch (e) {
        Log.log('Error while connecting to prism ', e);
        res.sendStatus(500);
    }
});

app.get('/subscribe', requireAdmin, async function (req: express.Request, res) {
    // Touchline quote subscription moved entirely to ANT/`data`; kept as a
    // no-op so stale frontend calls don't 404.
    res.sendStatus(200);
});

// ============================== Trade & Position Queries ==============================

app.get('/openTrades', requireAdmin, async function (req: express.Request, res) {
    try {
        const stats = await orderClient.stats();
        res.send(stats.trades);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/trades', requireAuth, async function (req, res) {
    try {
        const user = resolveUser(req);
        const stats = await orderClient.stats();
        res.send(stats.trades.filter((t: Trade) => t.user === user));
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/closedtrades', requireAuth, async function (req, res) {
    try {
        const user = resolveUser(req);
        const stats = await orderClient.stats();
        res.send(stats.closedTrades.filter((t: Trade) => t.user === user));
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

// Persisted, timestamped realized-trade history (src/processes/order/bookkeeping.ts's
// 'closedTrades' Mongo collection) - distinct from /closedtrades above, which reads
// `order`'s in-memory session state and is lost on restart. This is the source for
// payout computation (src/payout.ts) and payout-rejection trade breakdowns.
app.get('/users/:email/trades/closed', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { from, to } = req.query as { from?: string; to?: string };
        const query: any = { user: email };
        if (from || to) {
            query.exitTime = {};
            if (from) query.exitTime.$gte = new Date(from);
            if (to) query.exitTime.$lte = new Date(to);
        }
        const trades = await Mongo.getInstance().db.collection('closedTrades').find(query).sort({ exitTime: -1 }).toArray();
        res.json(trades);
    } catch (e) {
        Log.log('Get closed trade history error:', e);
        res.sendStatus(500);
    }
});

app.get('/admin/trades/closed', requireAdmin, async function (req, res) {
    try {
        const { user, from, to } = req.query as { user?: string; from?: string; to?: string };
        const query: any = {};
        if (user) query.user = user;
        if (from || to) {
            query.exitTime = {};
            if (from) query.exitTime.$gte = new Date(from);
            if (to) query.exitTime.$lte = new Date(to);
        }
        const trades = await Mongo.getInstance().db.collection('closedTrades').find(query).sort({ exitTime: -1 }).toArray();
        res.json(trades);
    } catch (e) {
        Log.log('Admin get closed trade history error:', e);
        res.sendStatus(500);
    }
});

// "Eligible" P&L (excludes forfeited profit) for the Trades tab's date-range
// summary - single user only (forfeiture is computed against that user's
// investmentAmount). breakdown=week (Month view) additionally buckets by
// trading week; otherwise the whole [from,to] range is one figure (Day/Week
// views).
app.get('/admin/trades/pnl-summary', requireAdmin, async function (req, res) {
    try {
        const { user, from, to, breakdown } = req.query as { user?: string; from?: string; to?: string; breakdown?: string };
        if (!user || !from || !to) {
            res.status(400).json({ error: 'user, from and to are required' });
            return;
        }
        const summary = await computePnlSummary(user, new Date(from), new Date(to), breakdown === 'week');
        res.json(summary);
    } catch (e) {
        Log.log('Admin get P&L summary error:', e);
        res.sendStatus(500);
    }
});

// Admin, all-users (or one user via ?user=) view of currently open trades -
// mirrors /admin/trades/closed's optional-user-filter shape, but reads the
// same in-memory order-process bookkeeping /openTrades does (open trades
// aren't in Mongo until they close).
app.get('/admin/trades/open', requireAdmin, async function (req, res) {
    try {
        const { user } = req.query as { user?: string };
        const stats = await orderClient.stats();
        const trades = user ? stats.trades.filter((t: Trade) => t.user === user) : stats.trades;
        res.json(trades);
    } catch (e) {
        Log.log('Admin get open trades error:', e);
        res.sendStatus(500);
    }
});

app.get('/refreshtrades', requireAdmin, async function (req, res) {
    try {
        const openTrades = await orderClient.refreshTradeList();
        res.send(openTrades);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/subscribetrades', requireAdmin, async function (req, res) {
    try {
        // Re-subscription for live per-tick tracking is obsolete now that exits
        // are GTT-driven (see zerodhaExecutor.ts) - kept as a refresh alias for
        // API parity.
        await orderClient.refreshTradeList();
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

// ============================== Real-time Streaming (SSE) ==============================

const niftyStreamClients = new Set<express.Response>();
const optionStreamClients = new Set<express.Response>();
const positionStreamClients = new Map<express.Response, string>(); // res -> user

// Last tick seen, replayed to a client connecting between ticks (e.g. after
// market close, or a page refresh) so the ticker isn't blank until the next
// live update - which may not arrive until the next session.
let lastNiftyQuote: any = null;

app.get('/niftystream', requireAuth, async function (req, res) {
    res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 10000\n\n');
    if (lastNiftyQuote) res.write(`data: ${JSON.stringify({ nifty: lastNiftyQuote })}\n\n`);
    niftyStreamClients.add(res);
    req.on('close', () => niftyStreamClients.delete(res));
});

app.get('/optionstream', requireAuth, async function (req, res) {
    res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 10000\n\n');
    optionStreamClients.add(res);
    req.on('close', () => optionStreamClients.delete(res));
});

// Demo mode: lets an anonymous client trigger a real subscribe/unsubscribe for
// an arbitrary option token, so /optionstream carries live ticks for whatever
// contract the demo user picked. No auth/order side effect - same anonymous-
// safe posture as /search, /quote, /optionstream itself.
app.get('/demo/subscribe', async function (req, res) {
    try {
        const { token, subscribe } = req.query;
        if (!token) {
            res.status(400).json({ error: 'Missing token' });
            return;
        }
        if (subscribe === 'false') {
            await strategiesClient.unsubscribeToken(token as string);
        } else {
            await strategiesClient.subscribeToken(token as string);
        }
        res.sendStatus(200);
    } catch (e: any) {
        Log.log(e);
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});

// Demo mode: resolves the ATM NIFTY CE/PE contract for the Up/Down flash-trade
// buttons using the ANT-native contract master + the ANT-sourced live NIFTY
// LTP already cached in `lastNiftyQuote` - deliberately NOT the Shoonya-based
// /search (that returns a Zerodha instrument token, which AntDataStream can't
// subscribe: see the "must never be stored as trade.token" warning in
// AntContractMaster.ts).
app.get('/demo/resolve', async function (req, res) {
    try {
        const { right } = req.query;
        if (!lastNiftyQuote?.ltp) {
            res.status(503).json({ error: 'NIFTY quote not available yet' });
            return;
        }
        const optionType = right === 'put' ? 'PE' : 'CE';
        const resolved = AntContractMaster.getInstance().findATMOption(lastNiftyQuote.ltp, optionType, 'NIFTY');
        res.json({ token: resolved.token, tradingSymbol: resolved.tradingSymbol });
    } catch (e: any) {
        Log.log(e);
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});

// Demo mode: ANT-native contract list (nearest expiry, both CE/PE, all
// strikes) for the manual contract-search Buy flow - same reasoning as
// /demo/resolve above, a Zerodha symbols.txt entry can't be ANT-subscribed.
app.get('/demo/symbols', async function (req, res) {
    try {
        const { symbol } = req.query;
        const options = AntContractMaster.getInstance().listNearestExpiryOptions((symbol as string) || 'NIFTY', 'NFO');
        res.json(options);
    } catch (e: any) {
        Log.log(e);
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});

async function pushPositionSnapshot(res: express.Response, user: string) {
    try {
        const stats = await orderClient.stats();
        const userActiveTrades = stats.trades.filter((t: Trade) => t.user === user);
        const userClosedTrades = stats.closedTrades.filter((t: Trade) => t.user === user);
        const allUserTrades = [
            ...userActiveTrades.map((t: Trade) => ({ ...t, open: t.open !== false })),
            ...userClosedTrades.map((t: Trade) => ({ ...t, open: false })),
        ];
        res.write(`data: ${JSON.stringify(allUserTrades)}\n\n`);
    } catch (e) {
        Log.log('[frontend] positionstream push failed:', e);
    }
}

app.get('/positionstream', requireAuth, async function (req, res) {
    const user = resolveUser(req);
    res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 10000\n\n');
    positionStreamClients.set(res, user);
    await pushPositionSnapshot(res, user);
    req.on('close', () => positionStreamClients.delete(res));
});

orderClient.onPositionsChanged(() => {
    for (const [res, user] of positionStreamClients) {
        pushPositionSnapshot(res, user);
    }
});

// ============================== Notifications ==============================
// `order` process writes drawdown notifications directly to Mongo (own
// connection, see bookkeeping.ts) but can't push SSE itself - only `frontend`
// terminates SSE connections. So this process polls for newly-created
// notification docs and merges them into the same stream that same-process
// writers (src/payout.ts, on payout block) push into immediately via
// myEmitter - one delivery path for the client regardless of origin process.

const notificationStreamClients = new Map<express.Response, string>(); // res -> user
let lastNotificationPollAt = new Date();

app.get('/users/:email/notifications', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { unreadOnly } = req.query as { unreadOnly?: string };
        const query: any = { user: email };
        if (unreadOnly === 'true') query.read = false;
        const notifications = await Mongo.getInstance().db.collection('notifications').find(query).sort({ createdAt: -1 }).toArray();
        res.json(notifications);
    } catch (e) {
        console.error('Get notifications error:', e);
        res.sendStatus(500);
    }
});

app.patch('/users/:email/notifications/:id/read', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { ObjectId } = require('mongodb');
        await Mongo.getInstance().db.collection('notifications').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { read: true } });
        res.sendStatus(200);
    } catch (e) {
        console.error('Mark notification read error:', e);
        res.sendStatus(500);
    }
});

app.get('/notificationstream', requireAuth, async function (req, res) {
    const user = resolveUser(req);
    res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 10000\n\n');
    notificationStreamClients.set(res, user);
    req.on('close', () => notificationStreamClients.delete(res));
});

myEmitter.on('notification', ({ user, notification }: { user: string; notification: any }) => {
    for (const [res, streamUser] of notificationStreamClients) {
        if (streamUser === user) res.write(`data: ${JSON.stringify(notification)}\n\n`);
    }
});

setInterval(async () => {
    try {
        const cutoff = lastNotificationPollAt;
        lastNotificationPollAt = new Date();
        if (notificationStreamClients.size === 0) return;
        const fresh = await Mongo.getInstance().db.collection('notifications').find({ createdAt: { $gt: cutoff } }).toArray();
        for (const n of fresh) {
            for (const [res, streamUser] of notificationStreamClients) {
                if (streamUser === n.user) res.write(`data: ${JSON.stringify(n)}\n\n`);
            }
        }
    } catch (e) {
        Log.log('[frontend] notification poll failed:', e);
    }
}, 12_000);

// Cloudflare (see `cloudflareOnly` middleware) silently drops a proxied
// connection that goes ~100s with no bytes written, without necessarily
// surfacing a client-side `onerror` - so an SSE stream can go zombie (looks
// open, never receives anything again) instead of triggering the frontend's
// reconnect-on-error logic. /notificationstream hits this in practice since
// notifications are rare and it can otherwise go idle far longer than that;
// the other streams mostly avoid it only because market-hours data keeps
// them busy. A periodic SSE comment (ignored by EventSource's onmessage,
// per spec) on every stream keeps bytes flowing so Cloudflare never sees
// them as idle.
setInterval(() => {
    const heartbeat = ': heartbeat\n\n';
    for (const res of antStreamClients) res.write(heartbeat);
    for (const res of niftyStreamClients) res.write(heartbeat);
    for (const res of optionStreamClients) res.write(heartbeat);
    for (const res of positionStreamClients.keys()) res.write(heartbeat);
    for (const res of notificationStreamClients.keys()) res.write(heartbeat);
}, 20_000);

// ============================== Strategy Admin ==============================

app.get('/stats', requireAdmin, async function (req: express.Request, res) {
    try {
        const allStats = await strategiesClient.stats();
        const cols = ['Strategy', 'Trades', 'Wins', 'Losses', 'Timeouts', 'Win%', 'P&L'];
        const rows = allStats.map((s: any) => [
            s.userId,
            String(s.totalTrades),
            String(s.wins),
            String(s.losses),
            String(s.timeouts),
            s.winRate !== null ? `${s.winRate}%` : 'N/A',
            String(s.totalPnL),
        ]);
        const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
        const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
        const fmt = (r: string[]) => '|' + r.map((v, i) => ` ${v.padEnd(widths[i])} `).join('|') + '|';
        const lines = [sep, fmt(cols), sep, ...rows.map(fmt), sep];
        res.type('text/plain').send(lines.join('\n'));
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/strategies', requireAdmin, async function (req: express.Request, res) {
    try {
        const { strategy, userId, enable } = req.query;
        const identifier = (userId || strategy) as string;
        if (identifier && enable !== undefined) {
            const result = await strategiesClient.setEnabled(identifier, enable === 'true');
            res.json(result);
            return;
        }
        res.json(await strategiesClient.list());
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/strategies/:type/reset', requireAdmin, async function (req: express.Request, res) {
    try {
        const { type } = req.params;
        res.json(await strategiesClient.reset(type));
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

// ============================== Market Data / Quotes ==============================

app.get('/quotes', requireAuth, async function (req, res) {
    try {
        const [nifty, bankNifty, finNifty] = await Promise.all([
            orderClient.getIndexQuote(resolveUser(req), 'NIFTY'),
            orderClient.getIndexQuote(resolveUser(req), 'BANKNIFTY'),
            orderClient.getIndexQuote(resolveUser(req), 'FINNIFTY'),
        ]);
        res.send({ nifty, bankNifty, finNifty });
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/niftyquote', requireAuth, async function (req, res) {
    try {
        const response = await orderClient.getNiftyQuote(resolveUser(req));
        res.send(response);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/quote', requireAuth, async function (req, res) {
    try {
        const { symbol } = req.query;
        const response = await orderClient.getStockQuote(resolveUser(req), symbol as string);
        res.send(response);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});


app.get('/search', requireAuth, async function (req, res) {
    try {
        const { depth, right, index } = req.query;
        const token = await orderClient.findToken(resolveUser(req), index as string, parseInt(depth as string), right as string);
        res.json({ token });
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/logout', requireAdmin, async function (req, res) {
    try {
        await Prism.getInstance().logout();
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/candles', requireAdmin, async function (req, res) {
    try {
        const candles = await strategiesClient.getCandles();
        res.send(candles);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

// ============================== Configuration ==============================

app.get('/config', requireAdmin, (req, res) => {
    res.json(configService.configToFlat());
});

app.post('/config', requireAdmin, async (req, res) => {
    const flat = req.body;
    const current = configService.configToFlat();
    const errors = validateFlatConfig(flat, current);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join('; ') });
    }
    configService.writeConfig(configService.flatToConfig(flat));
    configService.reloadNow(); // this process's own in-memory copy shouldn't lag its own write either

    // config.yml is hot-*read* (ConfigService.watchConfig), but several
    // fields are only ever consumed once at process boot and cached from
    // there (a strategy's `enabled`/`broker` in `strategies`'s Strategies
    // list and expandedConfigs; `broker`/`maxInvestment`/`useGTT` in
    // `order`'s bookkeeping settings cache - see Strategies.syncFromConfig's
    // and loadUserLimits's own comments). Refresh both unconditionally on
    // every save rather than diffing which specific field changed - both are
    // cheap, idempotent, and never touch live position/trade state, so this
    // is simpler and can't miss a field the way a per-field diff can.
    try {
        await strategiesClient.syncFromConfig();
    } catch (e) {
        Log.log('[config] Failed to live-sync strategies process:', e);
    }
    try {
        await orderClient.reloadUserLimits();
    } catch (e) {
        Log.log('[config] Failed to live-sync order-process user limits:', e);
    }

    res.json(flat);
});

// ============================== Backtesting / Replay ==============================

app.get('/replay', requireAdmin, async (req, res) => {
    const date = req.query.date as string;
    if (!date) return res.status(400).json({ error: 'date query param required' });

    const db = Mongo.getInstance().db;
    // Live ticks are persisted to the 'NiftyQuote' collection (NiftyQuote.fromAnt(),
    // see src/model/model.ts + src/ant/AntStream.ts / src/processes/data/AntDataStream.ts)
    // - 'Quote' is not written by any active path. NiftyQuote documents have no `date`
    // field, only `ltt` (epoch seconds), so filter by a day-bounds range instead of an
    // equality match - see src/tools/quoteDateRange.ts.
    const quotes = await db.collection('NiftyQuote').find(dateRangeQuery(date)).sort({ ltt: 1 }).toArray();
    if (quotes.length === 0) return res.status(404).json({ error: `no quotes for date ${date}` });

    const replayDecision = new Decision();
    replayDecision.replayMode = true;
    for (const q of quotes) {
        replayDecision._addPrice(Number(q.ltt), Number(q.ltp));
    }
    replayDecision.flushCandles();

    res.json({ date, processed: quotes.length });
});

// ============================== Static UI ==============================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ============================== Boot ==============================

async function main() {
    await Mongo.init().catch((e) => Log.log('[frontend] Mongo.init failed (continuing without persistence):', e));

    orderClient.connect();
    strategiesClient.connect();

    // stdin: ticks piped in from `data` (relayed by the orchestrator) - feeds
    // /niftystream, /optionstream, /ant/stream.
    readJsonLines(
        process.stdin,
        (tick) => {
            if (tick.type === 'nifty') {
                lastNiftyQuote = tick.quote;
                const payload = `data: ${JSON.stringify({ nifty: tick.quote })}\n\n`;
                for (const res of niftyStreamClients) res.write(payload);
            } else if (tick.type === 'option') {
                const payload = `data: ${JSON.stringify(tick.quote)}\n\n`;
                for (const res of optionStreamClients) res.write(payload);
            }
            // Raw relay for /ant/stream, matching its old "verbatim ant-quote" shape.
            const rawPayload = `data: ${JSON.stringify(tick)}\n\n`;
            for (const res of antStreamClients) res.write(rawPayload);
        },
        (line, err) => Log.log('[frontend] Failed to parse stdin tick:', line, err)
    );

    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => Log.log(`[frontend] Listening on ${port}`));

    const port80Server = app.listen(80, () => Log.log(`[frontend] Listening on 80`));
    port80Server.on('error', (err) => Log.log(`[frontend] Failed to listen on port 80: ${err.message}`));

    // Self-signed cert (repo root) - lets the origin terminate TLS directly,
    // e.g. for Cloudflare Full/Strict mode. See cloudflareOnly middleware.
    try {
        const httpsOptions = {
            key: fs.readFileSync(path.join(__dirname, '../key.pem')),
            cert: fs.readFileSync(path.join(__dirname, '../cert.pem')),
        };
        const httpsServer = https.createServer(httpsOptions, app).listen(443, () => Log.log(`[frontend] Listening on 443 (https)`));
        httpsServer.on('error', (err) => Log.log(`[frontend] Failed to listen on port 443: ${err.message}`));
    } catch (err) {
        Log.log(`[frontend] Skipping HTTPS: failed to load key.pem/cert.pem:`, err);
    }
}

main().catch((e) => {
    Log.log('[frontend] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
