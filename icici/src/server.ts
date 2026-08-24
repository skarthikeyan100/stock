// stdout is reserved for the control-command protocol back to `data` (e.g.
// 'reconnect' for /ant/connect) - redirect console.log to stderr before any
// other module (which may log at import time) loads, same as dataProcess.ts
// and strategiesProcess.ts. Forgetting this corrupts data's stdin JSON parser
// with ordinary log lines.
console.log = console.error;

import dns from 'dns';
// This host is dual-stack; Node prefers IPv6 by default for outbound requests,
// which bypasses Zerodha/Kite's IPv4-only IP allowlist. Force IPv4 first so
// calls to api.kite.trade (OAuth token exchange happens in this process) go
// out on the whitelisted IPv4 address.
dns.setDefaultResultOrder('ipv4first');

import Log from './util/Log';
import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import path from 'path';
import { Trade } from './model/model';
import configService from './prism/ConfigService';
import { getOrCreateUser, getUser, getAllUsers, updateUserSettings, createUser, deleteUser, updateUserRole, toClientUser, updateSensitiveField, updateBankDetails, updateEntityType, updateCompanyProfile } from './user';
import { computePayout, createPayoutRecord, markPayoutDecision, generateInvoiceHtml, getPayoutDecisionLog } from './payout';
import multer from 'multer';
import { GridFSBucket, ObjectId } from 'mongodb';
import Decision from './decision';
import Mongo from './tools/mongo';
import myEmitter from './tools/emitter';
import Prism from './prism';
import ANT from './ant/ANT';
import Zerodha from './zerodha/Zerodha';
import OrderClient from './processes/strategies/OrderClient';
import StrategiesClient from './ipc/StrategiesClient';
import { readJsonLines, writeJsonLine } from './ipc/jsonLines';

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

var app = express();

app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser());
app.use(cookieParser('propfirm-secret'));
app.disable('etag');

const orderClient = OrderClient.getInstance();
const strategiesClient = StrategiesClient.getInstance();

// Helper: resolve user from session cookie, fallback to X-User-Id header
function resolveUser(req: express.Request): string {
    const cookieEmail = (req as any).signedCookies?.session;
    if (cookieEmail) return cookieEmail;
    return (req.headers['x-user-id'] as string) || 'Default';
}

// ============================== Auth ==============================

app.post('/auth/login', async function (req, res) {
    try {
        const { email, name, picture } = req.body;
        if (!email) {
            res.status(400).json({ error: 'Email is required' });
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
        res.cookie('session', email, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
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
    res.json(toClientUser(user));
});

app.post('/auth/logout', function (req, res) {
    res.clearCookie('session');
    res.sendStatus(200);
});

// ============================== User Management ==============================

app.get('/users', async function (req, res) {
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

app.post('/users', async function (req, res) {
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

app.delete('/users/:email', async function (req, res) {
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

app.patch('/users/:email/role', async function (req, res) {
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

app.post('/users/:email/settings', async function (req, res) {
    try {
        const { email } = req.params;
        const { lossLimit, lotCount, investmentMode, investmentAmount, useGTT, perOrderCap, profitSplitPercent, enabled } = req.body;
        const user = await updateUserSettings(email, { lossLimit, lotCount, investmentMode, investmentAmount, useGTT, perOrderCap, profitSplitPercent, enabled });
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
            perOrderCap: user.perOrderCap,
        }).catch((e) => Log.log('[frontend] updateUserSettings push failed:', e));
        res.json(toClientUser(user));
    } catch (e) {
        console.error('Update settings error:', e);
        res.sendStatus(500);
    }
});

app.patch('/users/:email/profile', async function (req, res) {
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

app.patch('/users/:email/kyc-numbers', async function (req, res) {
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

app.patch('/users/:email/bank-details', async function (req, res) {
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

app.patch('/users/:email/entity-type', async function (req, res) {
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

app.patch('/users/:email/company-profile', async function (req, res) {
    try {
        const { email } = req.params;
        const { gstin, companyRegisteredName, companyRegisteredAddress } = req.body;
        const user = await updateCompanyProfile(email, { gstin, companyRegisteredName, companyRegisteredAddress });
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        res.json(toClientUser(user));
    } catch (e: any) {
        console.error('Company profile update error:', e);
        res.status(400).json({ error: e.message || 'Failed to update company profile' });
    }
});

app.patch('/users/:email/verify', async function (req, res) {
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

app.post('/users/:email/documents/:docType', upload.single('file'), async function (req, res) {
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
        res.json({ id: uploadStream.id.toString(), filename });
    } catch (e) {
        console.error('Document upload error:', e);
        res.sendStatus(500);
    }
});

app.get('/users/:email/documents/:docType', async function (req, res) {
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

app.get('/users/:email/payouts', async function (req, res) {
    try {
        const { email } = req.params;
        const payouts = await Mongo.getInstance().db.collection('payouts').find({ user: email }).sort({ createdAt: -1 }).toArray();
        res.json(payouts);
    } catch (e) {
        console.error('Get payouts error:', e);
        res.sendStatus(500);
    }
});

app.get('/users/:email/payouts/:id/invoice', async function (req, res) {
    try {
        const html = await generateInvoiceHtml(req.params.id);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (e: any) {
        console.error('Generate invoice error:', e);
        res.status(404).json({ error: e.message || 'Payout not found' });
    }
});

app.get('/users/:email/payouts/:id/decision-log', async function (req, res) {
    try {
        const entries = await getPayoutDecisionLog(req.params.id);
        res.json(entries);
    } catch (e) {
        console.error('Get payout decision log error:', e);
        res.sendStatus(500);
    }
});

app.get('/admin/payouts', async function (req, res) {
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

app.post('/admin/payouts/compute', async function (req, res) {
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

app.post('/admin/payouts', async function (req, res) {
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

app.patch('/admin/payouts/:id', async function (req, res) {
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
let antAccessToken: string | null = null;
let zerodhaAccessToken: string | null = null;

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
        res.redirect(302, '/app');
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

app.get('/prism/quick-login', async function (req, res) {
    Log.log('Logging in with QuickAuth');
    try {
        await Prism.getInstance().login(req.query.otp as string);
        await orderClient.reloadSession().catch((e) => Log.log('[frontend] reloadSession failed:', e));
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
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
        antAccessToken = result.userSession;
        res.cookie('ant_session', result.userSession, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
        Log.log('ANT Authentication successful. Token stored.');
        res.redirect(302, '/app');
    } catch (e: any) {
        Log.log('ANT callback error:', e);
        res.status(500).json({ error: 'Authentication failed', details: e.message });
    }
});

app.get('/ant/token', async function (req, res) {
    if (!antAccessToken) {
        res.status(401).json({ error: 'No ANT access token available. Please login first.' });
        return;
    }
    res.json({ access_token: antAccessToken });
});

app.get('/ant/positions', async function (req, res) {
    try {
        const ant = ANT.getInstance();
        const positions = await ant.getPositions();
        res.json({ success: true, positions, count: Array.isArray(positions) ? positions.length : 0 });
    } catch (e: any) {
        Log.log('Error fetching ANT positions:', e.message);
        res.status(500).json({ error: 'Failed to fetch positions', details: e.message });
    }
});

app.get('/ant/trades', async function (req, res) {
    try {
        const ant = ANT.getInstance();
        const trades = await ant.getTrades();
        res.json({ success: true, trades, count: Array.isArray(trades) ? trades.length : 0 });
    } catch (e: any) {
        Log.log('Error fetching ANT trades:', e.message);
        res.status(500).json({ error: 'Failed to fetch trades', details: e.message });
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
        zerodhaAccessToken = result.access_token;
        res.cookie('zerodha_session', result.access_token, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
        await orderClient.reloadSession().catch((e) => Log.log('[frontend] reloadSession failed:', e));
        Log.log('Zerodha Authentication successful. Token stored.');
        res.redirect(302, '/app');
    } catch (e: any) {
        Log.log('Zerodha callback error:', e);
        res.status(500).json({ error: 'Authentication failed', details: e.message });
    }
});

app.get('/kite/token', async function (req, res) {
    if (!zerodhaAccessToken) {
        res.status(401).json({ error: 'No Zerodha access token available. Please login first.' });
        return;
    }
    res.json({ access_token: zerodhaAccessToken });
});

app.get('/kite/trades', async function (req, res) {
    try {
        const trades = await Zerodha.getInstance().getTrades();
        res.json({ trades });
    } catch (e: any) {
        Log.log('Zerodha trades error:', e);
        res.status(500).json({ error: 'Failed to fetch trades', details: e.message });
    }
});

app.get('/kite/positions', async function (req, res) {
    try {
        const positions = await Zerodha.getInstance().getPositions();
        res.json({ positions });
    } catch (e: any) {
        Log.log('Zerodha positions error:', e);
        res.status(500).json({ error: 'Failed to fetch positions', details: e.message });
    }
});

// ============================== ANT connect / raw stream ==============================
// `data` auto-connects and auto-reconnects on its own now (see AntDataStream's
// backoff logic), so /ant/connect is a manual trigger for parity rather than
// the only way to get connected - it writes a control command on frontend's
// own stdout, which the orchestrator pipes into `data`'s stdin (mirroring how
// `strategies` talks to `data`).
app.get('/ant/connect', async function (req, res) {
    try {
        writeJsonLine(process.stdout, { cmd: 'reconnect' });
        res.json({ status: 'connected' });
    } catch (e: any) {
        Log.log('ANT connect error:', e);
        res.status(500).json({ error: 'Failed to connect to ANT streaming', details: e.message });
    }
});

const antStreamClients = new Set<express.Response>();
app.get('/ant/stream', function (req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    antStreamClients.add(res);
    req.on('close', () => antStreamClients.delete(res));
});

app.get('/prism/orderbook', async function (req: express.Request, res) {
    try {
        const orders = await orderClient.getOrders();
        res.send(orders);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

// ============================== Order Placement & Execution ==============================

app.get('/prism/order/buy', async function (req: express.Request, res) {
    try {
        const { right, index, strikePrice, price, contract } = req.query;
        const user = resolveUser(req);
        Log.log('Resolved order while placing an order ', user);
        const result = await orderClient.manualBuy(user, {
            index: index as any,
            right: right as string,
            contract: contract as string,
            strikePrice: strikePrice ? parseInt(strikePrice as string) : undefined,
            price: price ? parseFloat(price as string) : undefined,
        });
        res.json(result);
    } catch (e: any) {
        Log.log(e);
        res.status(e?.message?.includes('limit') ? 403 : 500).json({ error: e?.message ?? String(e) });
    }
});

app.get('/prism/squareoff', async function (req, res) {
    try {
        const { token, qty } = req.query;
        const user = resolveUser(req);
        await orderClient.squareOff(user, { token: token as string, quantity: qty ? Number(qty) : undefined });
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.post('/prism/settarget', express.json(), async function (req: express.Request, res) {
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

// ANT (AliceBlue) order placement - same shape as the /prism/order/* routes
// above, routed to antExecutor.ts instead of zerodhaExecutor.ts.
app.get('/ant/order/buy', async function (req: express.Request, res) {
    try {
        const { right, index, strikePrice, contract, quantity, targetPoints, stopLossPoints } = req.query;
        const user = resolveUser(req);
        Log.log('Resolved order while placing an ANT order ', user);
        const result = await orderClient.antManualBuy(user, {
            index: index as any,
            right: right as string,
            contract: contract as string,
            strikePrice: strikePrice ? parseInt(strikePrice as string) : undefined,
            quantity: quantity ? parseInt(quantity as string) : undefined,
            targetPoints: targetPoints ? parseFloat(targetPoints as string) : undefined,
            stopLossPoints: stopLossPoints ? parseFloat(stopLossPoints as string) : undefined,
        });
        res.json(result);
    } catch (e: any) {
        Log.log(e);
        res.status(e?.message?.includes('limit') ? 403 : 500).json({ error: e?.message ?? String(e) });
    }
});

app.get('/ant/order/squareoff', async function (req, res) {
    try {
        const { token, qty } = req.query;
        const user = resolveUser(req);
        await orderClient.antSquareOff(user, { token: token as string, quantity: qty ? Number(qty) : undefined });
        res.sendStatus(200);
    } catch (e: any) {
        Log.log(e);
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});

app.post('/ant/order/settarget', express.json(), async function (req: express.Request, res) {
    try {
        const { token, targetPoints, stopLossPoints } = req.body;
        if (!token || targetPoints == null || stopLossPoints == null) {
            res.status(400).json({ error: 'Missing token, targetPoints, or stopLossPoints' });
            return;
        }
        const user = resolveUser(req);
        await orderClient.antSetTargetStopLoss(user, token, targetPoints, stopLossPoints);
        res.sendStatus(200);
    } catch (e: any) {
        Log.log(e);
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});

app.get('/addTrade', async function (req: express.Request, res) {
    try {
        const trantype = 'B';
        const { tsym, flqty, flprc } = req.query;
        await orderClient.injectTrade({ tsym: tsym as string, flqty: flqty as string, flprc: flprc as string, trantype });
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/start', async function (req: express.Request, res) {
    try {
        // Original bought NIFTY then BANKNIFTY - ZerodhaContractMaster only
        // supports NIFTY/SENSEX today (see src/zerodha/ZerodhaContractMaster.ts's
        // INDEX_EXCHANGE map), so the BANKNIFTY leg is dropped rather than
        // silently mis-resolved.
        await orderClient.manualBuy('Default', { index: 'NIFTY' });
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/connect', async function (req: express.Request, res) {
    try {
        await orderClient.connectPrism();
        res.sendStatus(200);
    } catch (e) {
        Log.log('Error while connecting to prism ', e);
        res.sendStatus(500);
    }
});

app.get('/subscribe', async function (req: express.Request, res) {
    // Touchline quote subscription moved entirely to ANT/`data`; kept as a
    // no-op so stale frontend calls don't 404.
    res.sendStatus(200);
});

// ============================== Trade & Position Queries ==============================

app.get('/openTrades', async function (req: express.Request, res) {
    try {
        const stats = await orderClient.stats();
        res.send(stats.trades);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/trades', async function (req, res) {
    try {
        const user = resolveUser(req);
        const stats = await orderClient.stats();
        res.send(stats.trades.filter((t: Trade) => t.user === user));
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/closedtrades', async function (req, res) {
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
app.get('/users/:email/trades/closed', async function (req, res) {
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

app.get('/admin/trades/closed', async function (req, res) {
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

app.get('/refreshtrades', async function (req, res) {
    try {
        const openTrades = await orderClient.refreshTradeList();
        res.send(openTrades);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/subscribetrades', async function (req, res) {
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

app.get('/niftystream', async function (req, res) {
    res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 10000\n\n');
    niftyStreamClients.add(res);
    req.on('close', () => niftyStreamClients.delete(res));
});

app.get('/optionstream', async function (req, res) {
    res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 10000\n\n');
    optionStreamClients.add(res);
    req.on('close', () => optionStreamClients.delete(res));
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

app.get('/positionstream', async function (req, res) {
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

app.get('/users/:email/notifications', async function (req, res) {
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

app.patch('/users/:email/notifications/:id/read', async function (req, res) {
    try {
        const { ObjectId } = require('mongodb');
        await Mongo.getInstance().db.collection('notifications').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { read: true } });
        res.sendStatus(200);
    } catch (e) {
        console.error('Mark notification read error:', e);
        res.sendStatus(500);
    }
});

app.get('/notificationstream', async function (req, res) {
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

// ============================== Strategy Admin ==============================

app.get('/stats', async function (req: express.Request, res) {
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

app.get('/strategies', async function (req: express.Request, res) {
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

app.get('/strategies/:type/reset', async function (req: express.Request, res) {
    try {
        const { type } = req.params;
        res.json(await strategiesClient.reset(type));
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

// ============================== Market Data / Quotes ==============================

app.get('/quotes', async function (req, res) {
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

app.get('/niftyquote', async function (req, res) {
    try {
        const response = await orderClient.getNiftyQuote(resolveUser(req));
        res.send(response);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/quote', async function (req, res) {
    try {
        const { symbol } = req.query;
        const response = await orderClient.getStockQuote(resolveUser(req), symbol as string);
        res.send(response);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/requestOtp', async function (req, res) {
    try {
        Log.log('Requesting OTP');
        await Prism.getInstance().requestOtp();
        res.send('Requested OTP');
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/search', async function (req, res) {
    try {
        const { depth, right, index } = req.query;
        const token = await orderClient.findToken(resolveUser(req), index as string, parseInt(depth as string), right as string);
        res.json({ token });
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/logout', async function (req, res) {
    try {
        await Prism.getInstance().logout();
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/candles', async function (req, res) {
    try {
        const candles = await strategiesClient.getCandles();
        res.send(candles);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

app.get('/test', async function (req, res) {
    // Original discarded Prism.getOptionChain()'s result and just returned this
    // literal string - kept behavior-equivalent without the round trip.
    res.send('Done');
});

// ============================== Configuration ==============================

app.get('/config', (req, res) => {
    res.json(configService.configToFlat());
});

app.post('/config', (req, res) => {
    const flat = req.body;
    configService.writeConfig(configService.flatToConfig(flat));
    res.json(flat);
});

// ============================== Backtesting / Replay ==============================

app.get('/replay', async (req, res) => {
    const date = req.query.date as string;
    if (!date) return res.status(400).json({ error: 'date query param required' });

    const db = Mongo.getInstance().db;
    const quotes = await db.collection('Quote').find({ date }).sort({ ltt: 1 }).toArray();
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

app.get('/app*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/app/index.html'));
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
}

main().catch((e) => {
    Log.log('[frontend] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
