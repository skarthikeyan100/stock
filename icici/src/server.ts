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
import './util/tz'; // pin TZ=Asia/Kolkata before any other module reads the clock
import 'dotenv/config';

// This host is dual-stack; Node's Happy-Eyeballs connection logic prefers
// IPv6 when both are available, which bypasses Kite's AND AliceBlue/ANT's
// IPv4-only order-placement allowlists (OAuth token exchange for both happens
// in this process, plus ANT's own REST quote/trade/position reads used by
// this process's /broker/ant/* and /ant/* routes).
// dns.setDefaultResultOrder('ipv4first') looks like the fix but does NOT
// actually change the connected family (confirmed live in orderProcess.ts -
// see kiteDns.ts's comment); forcing IPv4 process-wide also broke Breeze
// (session generation/trade list/positions also happen in this process -
// see Breeze.getInstance() calls below), whose registered "static IP" is
// apparently the IPv6 address. So this is scoped to just the specific
// hostnames that need it, same as orderProcess.ts.
import { installIpv4OnlyHostOverride } from './processes/order/kiteDns';
installIpv4OnlyHostOverride();

import Log from './util/Log';
import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import path from 'path';
import https from 'https';
import fs from 'fs';
import { Trade } from './model/model';
import configService from './prism/ConfigService';
import { validateFlatConfig, validateConfigFile } from './prism/configValidation';
import { getOrCreateUser, getUser, getAllUsers, updateUserSettings, createUser, deleteUser, updateUserRole, toClientUser, updateSensitiveField, updateBankDetails, updateEntityType, updateCompanyProfile, updateProfileFields, normalizeEmail } from './user';
import { computePayout, createPayoutRecord, markPayoutDecision, markPayoutPaidWithProof, setPayoutEmailStatus, getPayout, generateInvoiceHtml, getPayoutDecisionLog, computePnlSummary, periodFromInputs } from './payout';
import multer from 'multer';
import { GridFSBucket, ObjectId } from 'mongodb';
import { sendPayoutPaidEmail } from './mailer';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import Decision from './decision';
import Mongo from './tools/mongo';
import { dateRangeQuery } from './tools/quoteDateRange';
import myEmitter from './tools/emitter';
import Prism from './prism';
import ANT from './ant/ANT';
import AntContractMaster from './ant/AntContractMaster';
import Kite from './kite/Kite';
import Breeze from './breeze/Breeze';
import BreezeStream from './breeze/BreezeStream';
import OrderClient from './processes/strategies/OrderClient';
import StrategiesClient from './ipc/StrategiesClient';
import { readJsonLines, writeJsonLine } from './ipc/jsonLines';
import { cloudflareOnly, isLoopback } from './middleware/cloudflareOnly';
import { OAuth2Client } from 'google-auth-library';
import { normalizeBrokerName, normalizeBrokerList } from './util/brokerName';

// `frontend` process (server.ts, unchanged name/entry point - see the plan:
// "frontend should be server.ts itself, edited in place"). Every route below
// keeps its original path/response shape; only the internals changed - broker
// order-execution and strategy state now go over IPC to `order`/`strategies`
// (OrderClient/StrategiesClient) instead of in-process Monitor/strategies.getList()
// calls. Quote-only and OAuth methods on Prism/ANT/Kite stay direct library
// calls here (stateless w.r.t. order's bookkeeping) - after a fresh login,
// OrderClient.reloadSession() tells `order`'s already-running Prism/Kite
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
app.use(express.static(path.join(__dirname, '../public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser(SESSION_COOKIE_SECRET));
app.disable('etag');

// Express 4 does not catch a rejected promise from an async handler/middleware: left alone it becomes an unhandled
// rejection that can take the whole frontend down. Wrap every handler registered through app.get/post/... so a
// rejection is forwarded to the error middleware at the bottom of this file instead.
for (const verb of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const original = (app as any)[verb].bind(app);
    (app as any)[verb] = (...args: any[]) => {
        if (verb === 'get' && args.length === 1) return original(...args); // app.get(setting)
        const wrapped = args.map((a) => {
            if (typeof a !== 'function' || a.length === 4) return a;
            return (req: express.Request, res: express.Response, next: express.NextFunction) => {
                try {
                    const r = a(req, res, next);
                    if (r && typeof r.catch === 'function') r.catch(next);
                } catch (e) {
                    next(e);
                }
            };
        });
        return original(...wrapped);
    };
}

process.on('unhandledRejection', (reason) => {
    Log.log('[frontend] Unhandled promise rejection (process kept alive):', reason);
});
process.on('uncaughtException', (e) => {
    Log.log('[frontend] Uncaught exception (process kept alive):', e);
});

// State-changing routes used to be GET (a cross-site top-level navigation carries the SameSite=lax session cookie).
// They now also accept POST, and either way a non-loopback caller must send a custom header, which a cross-site page
// cannot add without a CORS preflight that this server never grants. Loopback callers (ops scripts) are exempt, as
// everywhere else in this file.
function requireCsrfHeader(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (requestIsLoopback(req) || req.get('x-requested-with')) { next(); return; }
    res.status(403).json({ error: 'X-Requested-With header required for this state-changing request' });
}
const MAX_INVESTMENT_AMOUNT = 100_000_000; // server-side ceiling for a user-set investmentAmount

// Registers a handler for both GET (legacy, header-guarded) and POST.
function getOrPost(route: string, ...handlers: any[]): void {
    app.get(route, requireCsrfHeader, ...handlers);
    app.post(route, requireCsrfHeader, ...handlers);
}

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

// A signed 30-day cookie must not outlive the account: the user is re-read (briefly cached) so a deleted or disabled
// user is rejected on their next request instead of keeping access until the cookie expires.
const USER_CACHE_TTL_MS = 15_000;
const userCache = new Map<string, { at: number; user: Awaited<ReturnType<typeof getUser>> }>();
async function getActiveUser(email: string) {
    const hit = userCache.get(email);
    if (hit && Date.now() - hit.at < USER_CACHE_TTL_MS) return hit.user;
    const user = await getUser(email);
    userCache.set(email, { at: Date.now(), user });
    return user;
}
function invalidateUserCache(email?: string): void {
    if (email) userCache.delete(email); else userCache.clear();
}

async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    if (requestIsLoopback(req)) { next(); return; }
    const email = resolveUser(req);
    if (!email) { res.status(401).json({ error: 'Not logged in' }); return; }
    const user = await getActiveUser(email);
    if (!user) { res.status(401).json({ error: 'Unknown user' }); return; }
    if (user.enabled === false) { res.status(403).json({ error: 'Account disabled' }); return; }
    next();
}

async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    if (requestIsLoopback(req)) { next(); return; }
    const email = resolveUser(req);
    if (!email) { res.status(401).json({ error: 'Not logged in' }); return; }
    const user = await getActiveUser(email);
    if (!user || user.role !== 'admin' || user.enabled === false) { res.status(403).json({ error: 'Forbidden' }); return; }
    next();
}

function requireSelfOrAdmin(paramName = 'email') {
    return async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
        if (requestIsLoopback(req)) { next(); return; }
        const email = resolveUser(req);
        if (!email) { res.status(401).json({ error: 'Not logged in' }); return; }
        const caller = await getActiveUser(email);
        if (!caller) { res.status(401).json({ error: 'Unknown user' }); return; }
        if (caller.enabled === false) { res.status(403).json({ error: 'Account disabled' }); return; }
        if (email === req.params[paramName]) { next(); return; }
        if (caller.role === 'admin') { next(); return; }
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
        let payload: { email?: string; email_verified?: boolean; name?: string; picture?: string };
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
        // An unverified Google address can be set to anything the account holder likes (including an ADMIN_EMAILS entry).
        if (payload.email_verified !== true) {
            res.status(401).json({ error: 'Google account email is not verified' });
            return;
        }
        const user = await getOrCreateUser(email, name as string, picture as string);
        if (user.enabled === false) {
            res.status(403).json({ error: 'Account disabled' });
            return;
        }
        invalidateUserCache(user.email);
        await orderClient.updateUserSettings(user.email, {
            lossLimit: user.lossLimit,
            lotLimit: user.lotCount,
            investmentMode: user.investmentMode,
            investmentAmount: user.investmentAmount,
            useGTT: user.useGTT,
        }).catch((e) => Log.log('[frontend] updateUserSettings on login failed:', e));
        res.cookie('session', user.email, { signed: true, httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
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
    if (user.enabled === false) {
        res.status(403).json({ error: 'Account disabled' });
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
        const ll = lossLimit ?? 15000;
        const lc = lotCount ?? 10;
        if (typeof email !== 'string' || typeof name !== 'string' || !Number.isFinite(Number(ll)) || Number(ll) < 0 || !Number.isInteger(Number(lc)) || Number(lc) <= 0) {
            res.status(400).json({ error: 'Invalid email, name, lossLimit (>= 0) or lotCount (positive integer)' });
            return;
        }
        const user = await createUser(email, name, Number(ll), Number(lc), role ?? 'user');
        await orderClient.updateUserSettings(user.email, {
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
        } else if (/^Invalid role|are required$/.test(e.message)) {
            res.status(400).json({ error: e.message });
        } else {
            res.sendStatus(500);
        }
    }
});

app.delete('/users/:email', requireAdmin, async function (req, res) {
    try {
        const { email } = req.params;
        const caller = resolveUser(req);
        if (caller && caller.toLowerCase() === email.toLowerCase()) {
            res.status(400).json({ error: 'You cannot delete your own account' });
            return;
        }
        const target = await getUser(email);
        if (target?.role === 'admin') {
            const admins = (await getAllUsers()).filter((u) => u.role === 'admin');
            if (admins.length <= 1) {
                res.status(400).json({ error: 'Cannot delete the last admin' });
                return;
            }
        }
        // A user with an open position must be squared off first - deleting them would orphan it.
        const stats = await orderClient.stats();
        if (stats.trades.some((t: any) => t.user === email)) {
            res.status(409).json({ error: 'User has open trades - square them off before deleting the account' });
            return;
        }
        // Uploaded KYC documents are deleted with the account (payout records stay: they are financial history).
        if (target) {
            const bucket = new GridFSBucket(Mongo.getInstance().db, { bucketName: 'documents' });
            for (const f of ['addressProofId', 'dobProofId', 'panCardId', 'aadharDocId', 'gstDocId']) {
                const id = (target as any)[f];
                if (id && ObjectId.isValid(id)) await bucket.delete(new ObjectId(id)).catch(() => undefined);
            }
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

app.patch('/users/:email/role', requireAdmin, async function (req, res) {
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

app.post('/users/:email/settings', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { email } = req.params;
        const { lossLimit, lotCount, investmentMode, investmentAmount, useGTT, broker, perOrderCap, allottedCapital, targetPoints, stopLossPoints, profitSplitPercent, enabled } = req.body;
        // Self-service is limited to investment preferences; limits, capital, broker, profit split and the enabled flag
        // are admin-controlled (a trader must not be able to raise their own loss limit or re-enable a disabled account).
        if (!requestIsLoopback(req)) {
            const caller = await getUser(resolveUser(req) ?? '');
            if (caller?.role !== 'admin') {
                const restricted = { lossLimit, lotCount, broker, perOrderCap, allottedCapital, targetPoints, stopLossPoints, profitSplitPercent, enabled };
                const attempted = Object.entries(restricted).filter(([, v]) => v !== undefined).map(([k]) => k);
                if (attempted.length > 0) {
                    res.status(403).json({ error: `Only an admin can change: ${attempted.join(', ')}` });
                    return;
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
        for (const [k, v] of Object.entries({ perOrderCap, allottedCapital, targetPoints, stopLossPoints })) {
            // null clears the override
            if (v !== undefined && v !== null && !(finite(v) && (v as number) >= 0)) return bad(`${k} must be a number >= 0 (or null to clear)`);
        }
        if (profitSplitPercent !== undefined && !(finite(profitSplitPercent) && profitSplitPercent >= 0)) return bad('profitSplitPercent must be a number >= 0');
        if (profitSplitPercent !== undefined && profitSplitPercent > 100) return bad('profitSplitPercent must be <= 100');
        if (Object.values({ lossLimit, lotCount, investmentMode, investmentAmount, useGTT, broker, perOrderCap, allottedCapital, targetPoints, stopLossPoints, profitSplitPercent, enabled }).every((v) => v === undefined)) return bad('No settings supplied');
        if (broker !== undefined && !['ant', 'kite', 'breeze'].includes(normalizeBrokerName(broker))) {
            res.status(400).json({ error: `Invalid broker '${broker}' (expected ant, kite or breeze)` });
            return;
        }
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
        if (phone === undefined && legalName === undefined) { res.status(400).json({ error: 'phone or legalName is required' }); return; }
        const user = await updateProfileFields(email, { phone, legalName });
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        res.json(toClientUser(user));
    } catch (e: any) {
        console.error('Profile update error:', e);
        res.status(/must be|invalid|too long/.test(e?.message ?? '') ? 400 : 500).json({ error: e?.message ?? 'Failed to update profile' });
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
    } catch (e: any) {
        console.error('Bank details update error:', e);
        res.status(/must be|invalid|too long/.test(e?.message ?? '') ? 400 : 500).json({ error: e?.message ?? 'Failed to update bank details' });
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

// Magic-byte sniffing for the KYC upload allow-list (JPEG / PNG / PDF).
function detectDocumentType(buf: Buffer): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    return null;
}

// OCR is CPU-heavy and runs in this single-threaded process: one at a time (the rest queue), each bounded by a timeout,
// so a burst of uploads cannot stall SSE/API/auth for everyone.
const OCR_TIMEOUT_MS = 60_000;
let ocrChain: Promise<unknown> = Promise.resolve();
function runOcrExclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = ocrChain.then(() => Promise.race([
        job(),
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('OCR timed out')), OCR_TIMEOUT_MS)),
    ]));
    ocrChain = run.catch(() => undefined);
    return run;
}

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
        const html = await generateInvoiceHtml(req.params.id, req.params.email);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (e: any) {
        console.error('Generate invoice error:', e);
        res.status(404).json({ error: e.message || 'Payout not found' });
    }
});

app.get('/users/:email/payouts/:id/decision-log', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const entries = await getPayoutDecisionLog(req.params.id, req.params.email);
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
        const period = periodFromInputs(periodStart, periodEnd);
        const computation = await computePayout(user, period.start, period.end);
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
        const period = periodFromInputs(periodStart, periodEnd);
        const payout = await createPayoutRecord(user, period.start, period.end);
        res.json(payout);
    } catch (e: any) {
        console.error('Create payout error:', e);
        res.status(400).json({ error: e.message || 'Failed to create payout' });
    }
});

app.patch('/admin/payouts/:id', requireAdmin, async function (req, res) {
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
app.get('/admin/payouts/:id', requireAdmin, async function (req, res) {
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

function payoutEmailVars(payout: any, user: any) {
    const method = payout.paidTo;
    const destination = method === 'upi' ? `UPI ${payout.bankSnapshot?.upiId ?? ''}` : `Bank account ${payout.bankSnapshot?.accountNumberMasked ?? ''}`;
    return {
        name: String(user?.legalName || user?.name || payout.user),
        invoiceNumber: String(payout.invoiceNumber),
        period: `${new Date(payout.periodStart).toDateString()} – ${new Date(payout.periodEnd).toDateString()}`,
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
        const contentType = files[0]?.contentType || 'image/png';
        const ext = contentType.split('/')[1] || 'png';
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
app.post('/admin/payouts/:id/pay', requireAdmin, upload.single('proof'), async function (req, res) {
    let proofId: ObjectId | null = null;
    try {
        if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'Invalid payout id' }); return; }
        if (!req.file) { res.status(400).json({ error: 'Payment screenshot is required' }); return; }
        if (!req.file.mimetype.startsWith('image/')) { res.status(400).json({ error: 'The proof must be an image' }); return; }
        const { paymentRef, note, paidTo } = req.body as { paymentRef?: string; note?: string; paidTo?: string };
        if (paidTo !== 'bank' && paidTo !== 'upi') { res.status(400).json({ error: 'paidTo must be bank or upi' }); return; }
        const adminEmail = resolveUser(req) ?? (requestIsLoopback(req) ? 'loopback' : null);

        const existing = await getPayout(req.params.id);
        if (!existing) { res.status(404).json({ error: 'Payout not found' }); return; }
        if (existing.status !== 'pending') { res.status(409).json({ error: `Payout is already ${existing.status}` }); return; }

        const bucket = new GridFSBucket(Mongo.getInstance().db, { bucketName: 'payout_proofs' });
        const safeName = String(req.file.originalname ?? 'proof').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
        const uploadStream = bucket.openUploadStream(`${req.params.id}_${Date.now()}_${safeName}`, { contentType: req.file.mimetype });
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
        const email = await sendPaidEmailAndRecord(payout);
        res.json({ ...payout, ...email });
    } catch (e: any) {
        console.error('Pay payout error:', e);
        const msg = e.message || 'Failed to mark payout paid';
        res.status(/not found/i.test(msg) ? 404 : /already/i.test(msg) ? 409 : 400).json({ error: msg });
    }
});

app.post('/admin/payouts/:id/resend-email', requireAdmin, async function (req, res) {
    try {
        if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'Invalid payout id' }); return; }
        const payout = await getPayout(req.params.id);
        if (!payout) { res.status(404).json({ error: 'Payout not found' }); return; }
        if (payout.status !== 'paid' || !payout.proofFileId) { res.status(409).json({ error: 'Only a paid payout with a payment screenshot can be emailed' }); return; }
        if (payout.emailStatus === 'sent') { res.status(409).json({ error: 'The email was already sent' }); return; }
        res.json(await sendPaidEmailAndRecord(payout));
    } catch (e) {
        console.error('Resend payout email error:', e);
        res.sendStatus(500);
    }
});

app.get('/users/:email/payouts/:id/proof', requireSelfOrAdmin('email'), async function (req, res) {
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
        res.status(500).json({ error: 'Authentication failed' });
    }
};

app.get('/prism/callback', shoonyaCallback);
// Shoonya's registered OAuth app redirect URI is /shoonya/callback (a broker-side
// dashboard setting, not something this code controls) - alias it to the same
// handler rather than requiring the app registration to change.
app.get('/shoonya/callback', shoonyaCallback);

app.get('/prism/authcode', requireAdmin, function (_req, res) {
    if (!authorizationCode) {
        res.status(404).json({ error: 'No authorization code stored' });
        return;
    }
    res.json({ code: authorizationCode });
});

app.get('/prism/token', requireAdmin, async function (req, res) {
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
        // (No ant_session cookie: the broker token lives server-side only; nothing reads a browser copy.)
        void result;
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
        res.status(500).json({ error: 'Authentication failed' });
    }
});

app.get('/kite/login', async function (req, res) {
    try {
        const kite = Kite.getInstance();
        const loginUrl = kite.getLoginURL();
        Log.log('Redirecting to Kite login:', loginUrl);
        res.redirect(302, loginUrl);
    } catch (e: any) {
        Log.log('Kite login error:', e);
        res.status(500).json({ error: 'Failed to initiate Kite login' });
    }
});

app.get('/kite/callback', async function (req, res) {
    try {
        const requestToken = req.query.request_token as string;
        if (!requestToken) {
            Log.log('Missing request_token in Kite callback');
            res.status(400).json({ error: 'Missing request_token from Kite' });
            return;
        }
        Log.log('Kite Callback received - exchanging request_token for access_token');
        const kite = Kite.getInstance();
        const result = await kite.exchangeRequestTokenForSession(requestToken);
        void result; // broker token stays server-side only - no cookie copy
        await orderClient.reloadSession().catch((e) => Log.log('[frontend] reloadSession failed:', e));
        Log.log('Kite Authentication successful. Token stored.');
        res.redirect(302, '/');
    } catch (e: any) {
        Log.log('Kite callback error:', e);
        res.status(500).json({ error: 'Authentication failed' });
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
        res.status(500).json({ error: 'Authentication failed' });
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
getOrPost('/breeze/order/buy', requireAdmin, async function (req, res) {
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
getOrPost('/breeze/order/squareoff', requireAdmin, async function (req, res) {
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
getOrPost('/breeze/connect', requireAdmin, async function (req, res) {
    try {
        BreezeStream.getInstance().connect();
        res.json({ status: 'connected' });
    } catch (e: any) {
        Log.log('Breeze connect error:', e);
        res.status(500).json({ error: 'Failed to connect to Breeze streaming' });
    }
});

const breezeStreamClients = new Set<express.Response>();
app.get('/breeze/stream', requireAdmin, function (req, res) {
    req.on('close', () => breezeStreamClients.delete(res));
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    breezeStreamClients.add(res);
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
// routes never had. Deliberately calls ANT/Kite/Prism's own
// getTrades()/getPositions() directly (same as the routes this replaces),
// NOT the order-process-only BrokerExecutor abstraction (brokerExecutors.ts)
// - that pulls in bookkeeping.ts/exitMonitor.ts, which are `order`-process
// state this `frontend` process has no business touching (see this file's
// own header comment on the IPC process split).
async function getBrokerTrades(broker: string): Promise<any[]> {
    if (normalizeBrokerName(broker) === 'kite') return Kite.getInstance().getTrades();
    broker = normalizeBrokerName(broker);
    if (broker === 'ant') return ANT.getInstance().getTrades();
    if (broker === 'prism') return Prism.getInstance().getTradeList();
    if (broker === 'breeze') {
        const toDate = new Date();
        const fromDate = new Date(toDate);
        fromDate.setDate(fromDate.getDate() - 7);
        const result = await Breeze.getInstance().getTradeList({ fromDate: fromDate.toISOString(), toDate: toDate.toISOString(), exchangeCode: 'NFO' });
        return Array.isArray(result?.Success) ? result.Success : [];
    }
    throw new Error(`Unknown broker '${broker}' - expected kite, ant, prism, or breeze`);
}
async function getBrokerPositions(broker: string): Promise<any[]> {
    if (normalizeBrokerName(broker) === 'kite') return Kite.getInstance().getPositions();
    broker = normalizeBrokerName(broker);
    if (broker === 'ant') return ANT.getInstance().getPositions();
    if (broker === 'prism') return Prism.getInstance().getPositions();
    if (broker === 'breeze') {
        const result = await Breeze.getInstance().getPortfolioPositions();
        return Array.isArray(result?.Success) ? result.Success : [];
    }
    throw new Error(`Unknown broker '${broker}' - expected kite, ant, prism, or breeze`);
}

app.get('/broker/:broker/trades', requireAdmin, async function (req, res) {
    try {
        const trades = await getBrokerTrades(req.params.broker);
        res.json({ success: true, broker: req.params.broker, trades });
    } catch (e: any) {
        Log.log(`${req.params.broker} trades error:`, e);
        res.status(e.message.startsWith('Unknown broker') ? 400 : 500).json({ error: 'Failed to fetch trades' });
    }
});

app.get('/broker/:broker/positions', requireAdmin, async function (req, res) {
    try {
        const positions = await getBrokerPositions(req.params.broker);
        res.json({ success: true, broker: req.params.broker, positions });
    } catch (e: any) {
        Log.log(`${req.params.broker} positions error:`, e);
        res.status(e.message.startsWith('Unknown broker') ? 400 : 500).json({ error: 'Failed to fetch positions' });
    }
});

// ============================== ANT connect / raw stream ==============================
// `data` auto-connects and auto-reconnects on its own now (see AntDataStream's
// backoff logic), so /ant/connect is a manual trigger for parity rather than
// the only way to get connected - it writes a control command on frontend's
// own stdout, which the orchestrator pipes into `data`'s stdin (mirroring how
// `strategies` talks to `data`).
getOrPost('/ant/connect', requireAdmin, async function (req, res) {
    try {
        writeJsonLine(process.stdout, { cmd: 'reconnect' });
        res.json({ status: 'connected' });
    } catch (e: any) {
        Log.log('ANT connect error:', e);
        res.status(500).json({ error: 'Failed to connect to ANT streaming' });
    }
});

const antStreamClients = new Set<express.Response>();
app.get('/ant/stream', requireAdmin, function (req, res) {
    req.on('close', () => antStreamClients.delete(res));
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    antStreamClients.add(res);
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

// Shared validator for /order/buy's query string: a non-finite or non-positive number must be refused here (400) rather
// than reach the order process as NaN/null.
function validateBuyQuery(q: Record<string, unknown>): string | null {
    const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));
    const strike = num(q.strikePrice);
    if (strike !== undefined && !(Number.isInteger(strike) && strike > 0)) return 'strikePrice must be a positive integer';
    const price = num(q.price);
    if (price !== undefined && !(Number.isFinite(price) && price > 0)) return 'price must be a positive number';
    for (const k of ['targetPoints', 'stopLossPoints']) {
        const v = num(q[k]);
        if (v !== undefined && !(Number.isFinite(v) && v >= 0)) return `${k} must be a number >= 0`;
    }
    for (const k of ['right', 'index', 'contract']) {
        if (q[k] !== undefined && typeof q[k] !== 'string') return `${k} must be a string`;
    }
    if (q.index !== undefined && !['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY'].includes(String(q.index).toUpperCase())) return 'index must be NIFTY, SENSEX, BANKNIFTY or FINNIFTY';
    return null;
}

// Generic order placement - dispatches Kite-or-ANT internally via
// bookkeeping.getUserBroker (manualBuy/squareOff/setTargetStopLoss). Renamed
// from /prism/order/buy, /prism/squareoff, /prism/settarget - despite the
// old name, none of these ever called prismExecutor.ts; the "prism" prefix
// was actively misleading now that Prism is a real third broker with its own
// distinct routes elsewhere.
getOrPost('/order/buy', requireAuth, async function (req: express.Request, res) {
    try {
        const { right, index, strikePrice, price, contract, targetPoints, stopLossPoints } = req.query;
        const user = resolveUser(req);
        const invalid = validateBuyQuery({ right, index, strikePrice, price, contract, targetPoints, stopLossPoints });
        if (invalid) { res.status(400).json({ error: invalid }); return; }
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

getOrPost('/order/squareoff', requireAuth, async function (req, res) {
    try {
        const { token, qty, tsym } = req.query;
        const user = resolveUser(req);
        if (qty !== undefined && !(Number.isInteger(Number(qty)) && Number(qty) > 0)) { res.status(400).json({ error: 'qty must be a positive integer' }); return; }
        if ((token !== undefined && typeof token !== 'string') || (tsym !== undefined && typeof tsym !== 'string') || (!token && !tsym)) { res.status(400).json({ error: 'token or tsym is required' }); return; }
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

app.post('/order/settarget', requireAuth, requireCsrfHeader, async function (req: express.Request, res) {
    try {
        const { token, targetPoints, stopLossPoints } = req.body;
        if (!token || targetPoints == null || stopLossPoints == null) {
            res.status(400).json({ error: 'Missing token, targetPoints, or stopLossPoints' });
            return;
        }
        if (typeof token !== 'string' || !(typeof targetPoints === 'number' && Number.isFinite(targetPoints) && targetPoints >= 0) || !(typeof stopLossPoints === 'number' && Number.isFinite(stopLossPoints) && stopLossPoints >= 0)) {
            res.status(400).json({ error: 'token must be a string; targetPoints and stopLossPoints must be numbers >= 0' });
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

getOrPost('/connect', requireAdmin, async function (req: express.Request, res) {
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

getOrPost('/refreshtrades', requireAdmin, async function (req, res) {
    try {
        const openTrades = await orderClient.refreshTradeList();
        res.send(openTrades);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

getOrPost('/subscribetrades', requireAdmin, async function (req, res) {
    try {
        // Re-subscription for live per-tick tracking is obsolete now that exits
        // are GTT-driven (see kiteExecutor.ts) - kept as a refresh alias for
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
// Anonymous callers may only manage the tokens THEY subscribed: a bounded, ref-counted set, so the demo can never
// unsubscribe a token live strategies/exit monitors depend on, nor exhaust the shared feed's subscription cap.
const demoSubscribed = new Map<string, number>(); // token -> demo subscriber count
const DEMO_MAX_TOKENS = 20;
const demoHits = new Map<string, { n: number; resetAt: number }>();
app.get('/demo/subscribe', async function (req, res) {
    try {
        const ip = req.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const hit = demoHits.get(ip);
        if (!hit || hit.resetAt < now) demoHits.set(ip, { n: 1, resetAt: now + 60_000 });
        else if (++hit.n > 30) { res.status(429).json({ error: 'Too many requests' }); return; }
        const { token, subscribe } = req.query;
        if (typeof token !== 'string' || !/^\d{1,12}$/.test(token)) {
            res.status(400).json({ error: 'Missing or invalid token' });
            return;
        }
        if (subscribe === 'false') {
            const count = demoSubscribed.get(token) ?? 0;
            if (count === 0) { res.status(403).json({ error: 'Token was not subscribed by the demo' }); return; }
            if (count === 1) {
                demoSubscribed.delete(token);
                await strategiesClient.unsubscribeToken(token);
            } else {
                demoSubscribed.set(token, count - 1);
            }
        } else {
            if (!demoSubscribed.has(token) && demoSubscribed.size >= DEMO_MAX_TOKENS) { res.status(429).json({ error: 'Demo subscription limit reached' }); return; }
            demoSubscribed.set(token, (demoSubscribed.get(token) ?? 0) + 1);
            await strategiesClient.subscribeToken(token);
        }
        res.sendStatus(200);
    } catch (e: any) {
        Log.log(e);
        res.status(500).json({ error: 'Subscription failed' });
    }
});

// Demo mode: resolves the ATM NIFTY CE/PE contract for the Up/Down flash-trade
// buttons using the ANT-native contract master + the ANT-sourced live NIFTY
// LTP already cached in `lastNiftyQuote` - deliberately NOT the Shoonya-based
// /search (that returns a Kite instrument token, which AntDataStream can't
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
// /demo/resolve above, a Kite symbols.txt entry can't be ANT-subscribed.
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

async function pushPositionSnapshot(res: express.Response, user: string, sharedStats?: any) {
    try {
        const stats = sharedStats ?? await orderClient.stats();
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
    // Registered before the first await: a client that disconnects during the snapshot fetch must still be removed.
    req.on('close', () => positionStreamClients.delete(res));
    positionStreamClients.set(res, user);
    await pushPositionSnapshot(res, user);
});

// One stats() round trip per change, fanned out to every connected client (was one per client).
orderClient.onPositionsChanged(async () => {
    if (positionStreamClients.size === 0) return;
    try {
        const stats = await orderClient.stats();
        for (const [res, user] of positionStreamClients) {
            pushPositionSnapshot(res, user, stats);
        }
    } catch (e) {
        Log.log('[frontend] positions fan-out failed:', e);
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
        if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'Invalid notification id' }); return; }
        const r = await Mongo.getInstance().db.collection('notifications').updateOne({ _id: new ObjectId(req.params.id), user: req.params.email }, { $set: { read: true } });
        if (r.matchedCount === 0) { res.status(404).json({ error: 'Notification not found' }); return; }
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
    for (const res of breezeStreamClients) res.write(heartbeat);
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

const strategiesRoute = async function (req: express.Request, res: express.Response) {
    try {
        const { strategy, userId, enable } = req.query;
        const identifier = (userId || strategy) as string;
        if (identifier && enable !== undefined) {
            if (!requestIsLoopback(req) && !req.get('x-requested-with')) {
                res.status(403).json({ error: 'X-Requested-With header required to change a strategy' });
                return;
            }
            const result = await strategiesClient.setEnabled(identifier, enable === 'true');
            res.json(result);
            return;
        }
        res.json(await strategiesClient.list());
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
};
app.get('/strategies', requireAdmin, strategiesRoute);
app.post('/strategies', requireAdmin, strategiesRoute);

getOrPost('/strategies/:type/reset', requireAdmin, async function (req: express.Request, res) {
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

getOrPost('/logout', requireAdmin, async function (req, res) {
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

// ============================== Reconcile ==============================

// Explicit, on-demand broker-position + strategy reconcile - called only when
// broker positions and Mongo documents disagree. Nothing waits for it (ticks,
// order events and entries work without it). Order matters: `order` restores bookkeeping.trades from the
// brokers first, and only then do strategies reconcile against them. If any
// broker could not be read, strategies are NOT reconciled (they would otherwise
// conclude "no open position" from incomplete data) - 409 with the per-broker
// status so the caller can fix that broker's session and call again.
app.post('/reconcile', requireAdmin, async (req, res) => {
    try {
        const brokers = await orderClient.reconcileBrokerPositions();
        const failed = Object.entries(brokers).filter(([, ok]) => !ok).map(([broker]) => broker);
        if (failed.length > 0) {
            res.status(409).json({
                error: `broker positions could not be read for: ${failed.join(', ')} - strategies not reconciled. Log in to that broker and call POST /reconcile again.`,
                brokers,
            });
            return;
        }
        const strategies = await strategiesClient.reconcile();
        res.json({ brokers, strategies });
    } catch (e: any) {
        Log.log('[frontend] /reconcile failed:', e);
        res.status(500).json({ error: e?.message ?? 'reconcile failed' });
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
    // Refuse a save that the reload would reject (ConfigService.loadConfig runs
    // the same file-level check), so the admin is told instead of the file
    // being written and the old config silently staying live.
    const nextConfig = configService.flatToConfig(flat);
    const fileErrors = validateConfigFile(nextConfig);
    if (fileErrors.length > 0) {
        return res.status(400).json({ error: fileErrors.join('; ') });
    }
    // A save must never silently drop a strategy instance (it would be removed from the running processes, possibly
    // with an open position). Removal is only allowed when explicitly requested with ?allowRemove=true.
    const kept = new Set((nextConfig.strategies || []).map((s: any) => configService.instanceKey(s)));
    const dropped = (configService.getConfig().strategies || []).filter((s: any) => !kept.has(configService.instanceKey(s)));
    if (dropped.length > 0 && req.query.allowRemove !== 'true') {
        return res.status(400).json({ error: `Save would remove strategy instance(s): ${dropped.map((s: any) => `${s.type}:${s.userId || s.type}`).join(', ')}. Re-send with ?allowRemove=true if intended.` });
    }
    configService.writeConfig(nextConfig);
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

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
    // Only browser navigations get the SPA shell; an API-style request to an unknown path is a 404, not a 200 page.
    if (!req.accepts('html') || /\.[a-z0-9]{1,5}$/i.test(req.path)) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Last resort for anything the handlers did not answer themselves (see the async-wrapper at the top of the file):
// a JSON 500 with no stack and no internal message.
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    Log.log(`[frontend] Unhandled error in ${req.method} ${req.path}:`, err);
    if (res.headersSent) { res.end(); return; }
    res.status(500).json({ error: 'Internal server error' });
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
    const mainServer = app.listen(port, () => Log.log(`[frontend] Listening on ${port}`));
    // A replacement process can race its predecessor for the port (hot restart): fail loudly so the orchestrator
    // restarts it, instead of an unhandled 'error' event.
    mainServer.on('error', (err) => {
        Log.log(`[frontend] Failed to listen on port ${port}: ${err.message}`);
        process.exit(1);
    });

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
