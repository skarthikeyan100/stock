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
import { revokeSessions, getOrCreateUser, getUser, getAllUsers, updateUserSettings, createUser, deleteUser, updateUserRole, toClientUser, updateSensitiveField, updateBankDetails, updateEntityType, updateCompanyProfile, updateProfileFields, backfillVocabularyFields } from './user';
import { computePayout, createPayoutRecord, markPayoutDecision, markPayoutPaidWithProof, setPayoutEmailStatus, claimPayoutEmailSend, getPayout, generateInvoiceHtml, getPayoutDecisionLog, computePnlSummary, periodFromInputs, displayPeriodEnd } from './payout';
import multer from 'multer';
import { GridFSBucket, ObjectId } from 'mongodb';
import { sendPayoutPaidEmail } from './mailer';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import Mongo from './tools/mongo';
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
import { BROKER_CLIENTS, brokerClientFor } from './broker/brokerClients';
import { BrokerClient, CallbackParams, MissingCredentialsError } from './broker/BrokerClient';
import { ALL_BROKERS, BrokerName, USER_BROKERS_TEXT, isUserBroker, normalizeBrokerName } from './util/brokerName';

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
// Global CSRF guard: every state-changing request must carry X-Requested-With (a header a cross-site page or a plain HTML form cannot
// add without a CORS preflight this server never grants). Previously only getOrPost routes and /order/settarget were guarded, so
// /config, /reconcile, /strategies, /users*, /admin/payouts* relied on SameSite=Lax alone. Loopback (ops scripts) is exempt.
app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') { next(); return; }
    // Breeze's login redirect can arrive as a form POST from the broker's own page, which cannot carry a custom header. It changes
    // nothing without a valid one-time API_Session issued by the broker.
    if (req.path === '/breeze/callback') { next(); return; }
    requireCsrfHeader(req, res, next);
});
// Identity/filter fields must be plain strings. Express parses `?user[$ne]=` and `{"user": {"$ne": null}}` into objects, which would
// reach a Mongo filter as an operator instead of a value.
const MUST_BE_STRING = ['user', 'email', 'status', 'userId'];
app.use((req, res, next) => {
    for (const source of [req.query, req.body]) {
        if (!source || typeof source !== 'object') continue;
        for (const key of MUST_BE_STRING) {
            const v = (source as any)[key];
            if (v !== undefined && typeof v !== 'string') { res.status(400).json({ error: `${key} must be a string` }); return; }
        }
    }
    next();
});
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


// The one place a user's settings are pushed to the order process. It sends EVERY field: the order process replaces its cached entry, so
// a partial payload (as login and user-create used to send) silently dropped broker, caps, target/stop and accountClosed, re-opening an
// account closed by the weekly-drawdown breach on the next page open.
function pushUserToOrderProcess(user: any, context: string): Promise<void> {
    return orderClient.updateUserSettings(user.email, {
        lossLimit: user.lossLimit,
        lotLimit: user.lotLimit ?? user.lotCount,
        investmentMode: user.investmentMode,
        accountCapital: user.accountCapital ?? user.investmentAmount,
        useGTT: user.useGTT,
        broker: user.broker,
        perOrderCap: user.perOrderCap,
        strategyCapital: user.strategyCapital ?? user.allottedCapital,
        targetPoints: user.targetPoints,
        stopLossPoints: user.stopLossPoints,
        accountClosed: user.accountClosed === true,
    }).catch((e) => Log.log(`[frontend] updateUserSettings on ${context} failed:`, e));
}const strategiesClient = StrategiesClient.getInstance();

// Resolves the user ONLY from the server-signed session cookie - proves
// nothing was forged, unlike the X-User-Id header this used to also trust
// (any caller could set that header to act as anyone) or the 'Default'
// fallback (a real, tradeable pseudo-user reachable by anyone with no
// identity at all). Returns null when there's no valid session; callers that
// need a guaranteed identity go through requireAuth/requireSelfOrAdmin below
// first, which reject the request before the handler body ever runs.
// The session cookie value is `email|issuedAtMs` (signed). The issue time lets the SERVER enforce an expiry and revoke sessions;
// the cookie's maxAge is only a hint to the browser. A legacy cookie holding just the email has no issue time (treated as
// issued at 0: valid until a revocation, and re-issued with a timestamp on the next /auth/me).
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
function sessionCookieValue(email: string): string { return `${email}|${Date.now()}`; }
function parseSession(req: express.Request): { email: string; issuedAt: number; legacy: boolean } | null {
    const raw = (req as any).signedCookies?.session;
    if (typeof raw !== 'string' || !raw) return null;
    const i = raw.lastIndexOf('|');
    if (i < 0) return { email: raw, issuedAt: 0, legacy: true };
    const issuedAt = Number(raw.slice(i + 1));
    if (!Number.isFinite(issuedAt)) return null;
    if (Date.now() - issuedAt > SESSION_MAX_AGE_MS) return null; // expired server-side, whatever the browser still holds
    return { email: raw.slice(0, i), issuedAt, legacy: false };
}
function resolveUser(req: express.Request): string | null {
    return parseSession(req)?.email ?? null;
}
// True when the user's sessions were revoked (logout) after this cookie was issued.
function sessionRevoked(req: express.Request, user: { sessionsValidAfter?: number } | null | undefined): boolean {
    const s = parseSession(req);
    return !!s && !!user?.sessionsValidAfter && s.issuedAt <= user.sessionsValidAfter;
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
// Bumped on every invalidation: a read that was in flight across an invalidation holds a document from before it and must not be cached.
// Per email, so one user's invalidation does not stop another's read from caching; the map is cleared (with a global bump) past a cap.
const userCacheEpoch = new Map<string, number>();
let userCacheGlobalEpoch = 0;
const epochOf = (email: string) => `${userCacheGlobalEpoch}:${userCacheEpoch.get(email) ?? 0}`;
async function getActiveUser(email: string) {
    const hit = userCache.get(email);
    if (hit && Date.now() - hit.at < USER_CACHE_TTL_MS) return hit.user;
    const epoch = epochOf(email);
    const user = await getUser(email);
    if (epoch === epochOf(email)) userCache.set(email, { at: Date.now(), user });
    return user;
}
function invalidateUserCache(email?: string): void {
    if (email && userCacheEpoch.size < 1000) { userCacheEpoch.set(email, (userCacheEpoch.get(email) ?? 0) + 1); userCache.delete(email); }
    else { userCacheGlobalEpoch++; userCacheEpoch.clear(); userCache.clear(); }
}

// The one session check behind requireAuth / requireAdmin / requireSelfOrAdmin: a valid session cookie (not expired or revoked) for a
// user that still exists and is enabled. Returns the user, or the status and message to answer with.
async function authenticate(req: express.Request): Promise<{ ok: true; email: string; user: NonNullable<Awaited<ReturnType<typeof getUser>>> } | { ok: false; status: number; error: string; noSession?: boolean }> {
    const email = resolveUser(req);
    if (!email) return { ok: false, status: 401, error: 'Not logged in', noSession: true };
    const user = await getActiveUser(email);
    if (!user || sessionRevoked(req, user)) return { ok: false, status: 401, error: 'Unknown user' };
    if (user.enabled === false) return { ok: false, status: 403, error: 'Account disabled' };
    return { ok: true, email, user };
}

async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    if (requestIsLoopback(req)) { next(); return; }
    const auth = await authenticate(req);
    if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }
    next();
}

async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    if (requestIsLoopback(req)) { next(); return; }
    const auth = await authenticate(req);
    if ('error' in auth) {
        if (auth.noSession) res.status(401).json({ error: auth.error }); else res.status(403).json({ error: 'Forbidden' });
        return;
    }
    if (auth.user.role !== 'admin') { res.status(403).json({ error: 'Forbidden' }); return; }
    next();
}

function requireSelfOrAdmin(paramName = 'email') {
    return async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
        if (requestIsLoopback(req)) { next(); return; }
        const auth = await authenticate(req);
        if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }
        if (auth.email === req.params[paramName]) { next(); return; }
        if (auth.user.role === 'admin') { next(); return; }
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
        await pushUserToOrderProcess(user, 'login');
        res.cookie('session', sessionCookieValue(user.email), { signed: true, httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.json(toClientUser(user));
    } catch (e) {
        Log.log('Login error:', e);
        res.sendStatus(500);
    }
});

app.get('/auth/me', async function (req, res) {
    const session = parseSession(req);
    const email = session?.email;
    if (!session || !email) {
        res.status(401).json({ error: 'Not logged in' });
        return;
    }
    const user = await getUser(email);
    if (!user || sessionRevoked(req, user)) {
        res.status(401).json({ error: 'Unknown user' });
        return;
    }
    // Re-issue a legacy (timestamp-less) cookie so it picks up server-side expiry and revocation.
    if (session.legacy) res.cookie('session', sessionCookieValue(user.email), { signed: true, httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_MAX_AGE_MS });
    if (user.enabled === false) {
        res.status(403).json({ error: 'Account disabled' });
        return;
    }
    // A resumed session (cookie only, no fresh POST /auth/login) would
    // otherwise never re-sync this user's settings into the order process's
    // in-memory cache after a restart - refresh it here too, on every session
    // check, so a stale/empty cache entry doesn't silently fall back to
    // hardcoded defaults (e.g. investmentAmount=0) for manual order sizing.
    await pushUserToOrderProcess(user, 'session check');
    res.json(toClientUser(user));
});

app.post('/auth/logout', async function (req, res) {
    // Revokes the user's sessions server-side too (not just this browser's copy), so a leaked or copied cookie stops working.
    const email = resolveUser(req);
    if (email) {
        try {
            await revokeSessions(email);
            invalidateUserCache(email);
        } catch (e) {
            // Surfaced, and the cookie is NOT cleared: reporting success would leave a copied cookie valid for up to 30 days.
            Log.log('[frontend] session revoke on logout failed:', e);
            res.status(500).json({ error: 'Logout could not be completed - try again' });
            return;
        }
    }
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
        const { lossLimit, investmentMode, useGTT, broker, perOrderCap, targetPoints, stopLossPoints, profitSplitPercent, enabled } = req.body;
        // Canonical names win; the old ones (lotCount / investmentAmount / allottedCapital) are still accepted (REFACTOR_PLAN.md section 3).
        const lotCount = req.body.lotLimit ?? req.body.lotCount;
        const investmentAmount = req.body.accountCapital ?? req.body.investmentAmount;
        const allottedCapital = req.body.strategyCapital !== undefined ? req.body.strategyCapital : req.body.allottedCapital;
        // Self-service is limited to the investment mode; limits, capital (investmentAmount is the base the daily/weekly loss limits are
        // measured against), exit mode (useGTT), broker, profit split and the enabled flag are admin-controlled (a trader must not be able to raise their own loss limit or re-enable a disabled account).
        if (!requestIsLoopback(req)) {
            const caller = await getUser(resolveUser(req) ?? '');
            if (caller?.role !== 'admin') {
                const restricted = { lossLimit, lotCount, investmentAmount, useGTT, broker, perOrderCap, allottedCapital, targetPoints, stopLossPoints, profitSplitPercent, enabled };
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
        if (broker !== undefined && !isUserBroker(broker)) {
            res.status(400).json({ error: `Invalid broker '${broker}' (expected ${USER_BROKERS_TEXT})` });
            return;
        }
        const user = await updateUserSettings(email, { lossLimit, lotLimit: lotCount, investmentMode, accountCapital: investmentAmount, useGTT, broker, perOrderCap, strategyCapital: allottedCapital, targetPoints, stopLossPoints, profitSplitPercent, enabled });
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
app.post('/admin/payouts/:id/pay', requireAdmin, upload.single('proof'), async function (req, res) {
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

app.post('/admin/payouts/:id/resend-email', requireAdmin, async function (req, res) {
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

// --- Broker registry: login redirect, OAuth/session callback, and the debug trades/positions reads, per broker. ---
// One generic handler pair serves every broker's /<broker>/login and /<broker>/callback route over the BrokerClient registry
// (src/broker/brokerClients.ts); a broker-specific detail is data in BROKER_ROUTES, not another handler.
// Per broker, only what is not on the BrokerClient: how its redirect's query/body maps to credentials, and whether `data` must
// reconnect its stream once a session exists.
interface BrokerRoute {
    callbackParams(req: express.Request): CallbackParams;
    // Side effect on the credentials as received, before the exchange (kept out of callbackParams so that stays a pure mapper).
    remember?(params: CallbackParams): void;
    // Sent to `data` once a session exists so it (re)connects its stream; absent when `data` has no stream for this broker.
    reconnectCmd?: { cmd: 'reconnect'; source?: string };
}

const BROKER_ROUTES: Record<BrokerName, BrokerRoute> = {
    prism: {
        callbackParams: (req) => ({ code: req.query.code as string | undefined }),
        // Served back by /prism/authcode.
        remember: (params) => { if (params.code) authorizationCode = params.code; },
    },
    ant: {
        callbackParams: (req) => ({ authCode: req.query.authCode as string, userId: req.query.userId as string }),
        // `data` typically started before this login completed and may not be connected yet.
        reconnectCmd: { cmd: 'reconnect' },
    },
    kite: {
        callbackParams: (req) => ({ requestToken: req.query.request_token as string }),
    },
    breeze: {
        // ICICI's redirect back can hand the session value back either as a GET query param or as POST form data (unconfirmed
        // which until a live login), so both are accepted, under either of the two param names ICICI's docs/SDK use.
        callbackParams: (req) => {
            const apiSession = (req.query.apisession ?? req.query.API_Session ?? req.body?.apisession ?? req.body?.API_Session) as string;
            // Key names only: the query/body of a login callback can carry secrets and must never reach the log.
            if (!apiSession) Log.log('Missing API_Session in Breeze callback', { queryKeys: Object.keys(req.query ?? {}), bodyKeys: Object.keys(req.body ?? {}) });
            return { apiSession };
        },
        // Without this a Breeze login completing after `data` already started leaves BreezeDataStream stuck until a restart.
        reconnectCmd: { cmd: 'reconnect', source: 'breeze' },
    },
};

const brokerLogin = (name: BrokerName) => async function (_req: express.Request, res: express.Response) {
    const entry = BROKER_CLIENTS[name];
    try {
        const url = entry.getLoginUrl();
        Log.log(`Redirecting to ${entry.label} authorization:`, url);
        res.redirect(302, url);
    } catch (e: any) {
        Log.log(`${entry.label} login error:`, e);
        res.status(500).json({ error: `Failed to initiate ${entry.label} login` });
    }
};

const brokerCallback = (name: BrokerName) => async function (req: express.Request, res: express.Response) {
    const entry = BROKER_CLIENTS[name];
    const route = BROKER_ROUTES[name];
    try {
        const params = route.callbackParams(req);
        await entry.exchangeToken(params);
        // Only a code that was actually exchanged is kept (served by /prism/authcode): a failed or replayed callback leaves none.
        route.remember?.(params);
        if (route.reconnectCmd) writeJsonLine(process.stdout, route.reconnectCmd);
        // `order` loaded whatever (possibly stale/absent) session was on disk when it started; reloadSession re-reads it (and
        // reconnects the order-notify stream where there is one).
        let reloaded = false;
        for (let attempt = 1; attempt <= 3 && !reloaded; attempt++) {
            try {
                await orderClient.reloadSession();
                reloaded = true;
            } catch (e) {
                Log.log(`[frontend] reloadSession failed (attempt ${attempt}/3):`, e);
                if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
            }
        }
        if (!reloaded) {
            // The login itself succeeded and is saved, but `order` still holds the old session: say so rather than redirecting as if all is well.
            res.status(502).json({ error: `${entry.label} login succeeded but the order process could not load the new session - retry the login or restart the order process` });
            return;
        }
        Log.log(`${entry.label} Authentication successful.`);
        res.redirect(302, '/');
    } catch (e: any) {
        if (e instanceof MissingCredentialsError) {
            res.status(400).json({ error: e.message });
            return;
        }
        Log.log(`${entry.label} callback error:`, e);
        res.status(500).json({ error: 'Authentication failed' });
    }
};

for (const name of ALL_BROKERS) {
    app.get(`/${name}/login`, brokerLogin(name));
    app.get(`/${name}/callback`, brokerCallback(name));
}
app.post('/breeze/callback', brokerCallback('breeze'));
// Shoonya's registered OAuth app redirect URI is /shoonya/callback (a broker-side dashboard setting, not something this code
// controls) - alias it to the same handler rather than requiring the app registration to change.
app.get('/shoonya/callback', brokerCallback('prism'));

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
        const result = await orderClient.breezeSquareOff(user, { tradingSymbol: tsym as string, quantity: Number(qty) });
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
    openSse(res);
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
function brokerEntry(broker: string): BrokerClient {
    const client = brokerClientFor(broker);
    if (!client) throw new Error(`Unknown broker '${broker}' - expected ${ALL_BROKERS.join(', ')}`);
    return client;
}
const getBrokerTrades = (broker: string): Promise<any[]> => brokerEntry(broker).getTrades();
const getBrokerPositions = (broker: string): Promise<any[]> => brokerEntry(broker).getPositions();

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
    openSse(res);
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

// Lock profits: (1) turns every enabled strategy off - in config.yml (so a later reload cannot re-arm it) and live in the
// strategies process - so nothing re-enters or refills behind the sells, then (2) has the order process cancel resting
// buys and limit-sell every open long at its current price (orderProcess.ts's lockProfits), so realized P&L ends >= the
// open P&L at the call. Query: ?broker=kite|breeze|ant (omitted = every broker with an open position), ?reprice=true to
// re-price a lock that is still resting. Strategies stay off until enabled: true is set again in config.yml.
getOrPost('/order/lock-profits', requireAdmin, async function (req, res) {
    try {
        const broker = typeof req.query.broker === 'string' && req.query.broker.trim() ? req.query.broker.trim() : undefined;
        const reprice = req.query.reprice === 'true';
        // Freeze buys in the order process before anything else, so no strategy can buy between the steps below. If the order
        // process cannot be reached nothing has changed yet and the call fails here.
        await orderClient.setBuysFrozen(true);
        // Then disable, and refuse to sell if that cannot be persisted: a strategy left armed would re-enter the moment the
        // lock closes its position.
        const cfg = configService.getConfig();
        const toDisable = (cfg.strategies || []).filter((s: any) => s.enabled);
        const disabledStrategies = toDisable.map((s: any) => s.userId || s.type);
        if (toDisable.length > 0) {
            toDisable.forEach((s: any) => { s.enabled = false; });
            configService.writeConfig(cfg);
            configService.reloadNow();
        }
        // Immediate, in memory: the config file watcher reaches the strategies process a moment later.
        const live = await Promise.allSettled(disabledStrategies.map((id) => strategiesClient.setEnabled(id, false)));
        const liveFailed = disabledStrategies.filter((_, i) => live[i].status === 'rejected');
        const lock = await orderClient.lockProfits({ broker, reprice });
        res.json({ disabledStrategies, liveDisableFailed: liveFailed, lock });
    } catch (e: any) {
        Log.log('lock-profits failed:', e);
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});

// Lifts the buy freeze lock-profits turns on in the order process. Does not re-enable any strategy (set enabled: true in config.yml).
getOrPost('/order/unfreeze-buys', requireAdmin, async function (_req, res) {
    try {
        res.json(await orderClient.setBuysFrozen(false));
    } catch (e: any) {
        Log.log('unfreeze-buys failed:', e);
        res.status(500).json({ error: e?.message ?? String(e) });
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

// Per-strategy realized (closed trades) and unrealized (open positions) P&L for the current `order` session,
// used by the monitor-strategies skill's "status" report. Optional ?match=<regex> filters on Trade.strategy, falling back to Trade.user (bare broker orders carry no strategy).
app.get('/strategyPnl', requireAdmin, async function (req: express.Request, res) {
    try {
        const stats = await orderClient.stats();
        const re = req.query.match ? new RegExp(String(req.query.match), 'i') : null;
        const rows = new Map<string, { strategy: string; realized: number; unrealized: number; open: number; closed: number }>();
        const row = (t: Trade) => {
            const key = t.strategy || t.user || '(none)';
            if (!rows.has(key)) rows.set(key, { strategy: key, realized: 0, unrealized: 0, open: 0, closed: 0 });
            return rows.get(key)!;
        };
        for (const t of stats.closedTrades as Trade[]) {
            if (re && !re.test(t.strategy || t.user || '')) continue;
            const r = row(t); r.closed++; r.realized += Number(t.realizedPnL) || 0;
        }
        const openTrades = (stats.trades as Trade[]).filter((t) => !re || re.test(t.strategy || t.user || ''));
        // The order process never fills Trade.unrealizedPnL (only the legacy in-process Monitor does) and keeps lastTradePrice
        // fresh only for trades whose exits it monitors itself (resting-sell and reconcile-restored legs stay at their entry price),
        // so price each open trade from a live quote, falling back to lastTradePrice when the quote call fails.
        const liveLtp = new Map<Trade, number>();
        await Promise.all(openTrades.map(async (t) => {
            try {
                if (!t.token) return;
                const exchange = /^(SENSEX|BANKEX)/i.test(t.tsym || '') ? 'BFO' : 'NFO';
                const q = await ANT.getInstance().getLiveQuote(exchange, String(t.token));
                if (q.ltp > 0) liveLtp.set(t, q.ltp);
            } catch (e) { /* fall back to lastTradePrice below */ }
        }));
        for (const t of openTrades) {
            const mark = ((liveLtp.get(t) ?? Number(t.lastTradePrice)) - Number(t.price)) * Number(t.quantity);
            const r = row(t); r.open++; r.unrealized += Number.isFinite(mark) ? mark : 0;
            r.realized += Number(t.realizedPnL) || 0; // partial exits on a still-open trade
        }
        res.json([...rows.values()].map((r) => ({ ...r, realized: +r.realized.toFixed(2), unrealized: +r.unrealized.toFixed(2) })));
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

// SSE preamble shared by every stream route: headers, flush, reconnect hint.
function openSse(res: express.Response): void {
    res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 10000\n\n');
}

function openMarketStream(req: express.Request, res: express.Response, clients: Set<express.Response>, replay?: () => string | null): void {
    openSse(res);
    const first = replay?.();
    if (first) res.write(first);
    clients.add(res);
    req.on('close', () => clients.delete(res));
}
const replayNifty = () => (lastNiftyQuote ? `data: ${JSON.stringify({ nifty: lastNiftyQuote })}\n\n` : null);

app.get('/niftystream', requireAuth, async function (req, res) {
    openMarketStream(req, res, niftyStreamClients, replayNifty);
});

app.get('/optionstream', requireAuth, async function (req, res) {
    openMarketStream(req, res, optionStreamClients);
});

// Anonymous copies of the two market streams, for the logged-out /demo page (the authenticated ones above answered it with 401 forever).
// They carry the same public market ticks and nothing user-specific; connections are capped per client IP and globally.
const DEMO_STREAM_PER_IP = 3;
const DEMO_STREAM_TOTAL = 200;
const demoStreamOpen = new Map<string, number>();
let demoStreamTotal = 0;
function demoStream(clients: Set<express.Response>, replay?: () => string | null) {
    return (req: express.Request, res: express.Response) => {
        const ip = clientIp(req);
        if (demoStreamTotal >= DEMO_STREAM_TOTAL || (demoStreamOpen.get(ip) ?? 0) >= DEMO_STREAM_PER_IP) {
            res.status(429).json({ error: 'Too many demo streams' });
            return;
        }
        demoStreamTotal++;
        demoStreamOpen.set(ip, (demoStreamOpen.get(ip) ?? 0) + 1);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            demoStreamTotal--;
            const n = (demoStreamOpen.get(ip) ?? 1) - 1;
            if (n <= 0) demoStreamOpen.delete(ip); else demoStreamOpen.set(ip, n);
        };
        req.on('close', release);
        openMarketStream(req, res, clients, replay);
    };
}
app.get('/demo/niftystream', demoStream(niftyStreamClients, replayNifty));
app.get('/demo/optionstream', demoStream(optionStreamClients));

// Demo mode: lets an anonymous client trigger a real subscribe/unsubscribe for
// an arbitrary option token, so /optionstream carries live ticks for whatever
// contract the demo user picked. No auth/order side effect - same anonymous-
// safe posture as /search, /quote, /optionstream itself.
// Anonymous callers may only manage the tokens THEY subscribed: a bounded, ref-counted set, so the demo can never
// unsubscribe a token live strategies/exit monitors depend on, nor exhaust the shared feed's subscription cap.
const demoSubscribed = new Map<string, number>(); // token -> demo subscriber count
const DEMO_MAX_TOKENS = 20;
const demoHits = new Map<string, { n: number; resetAt: number }>();
// Only tokens this server itself handed out (via /demo/resolve or /demo/symbols) may be subscribed: an anonymous caller can no longer
// pick an arbitrary numeric token. Bounded so a long-running server cannot grow it without limit.
const demoAllowedTokens = new Set<string>();
function allowDemoTokens(tokens: string[]): void {
    for (const t of tokens) {
        if (demoAllowedTokens.size >= 20000) break;
        demoAllowedTokens.add(String(t));
    }
}
// Behind Cloudflare every request's socket address is an edge IP (one shared bucket for everyone). The edge sets CF-Connecting-IP to
// the real client, so trust it - but only on a non-loopback connection, which cloudflareOnly has already restricted to Cloudflare.
function clientIp(req: express.Request): string {
    const socketIp = req.socket.remoteAddress ?? 'unknown';
    if (isLoopback(socketIp)) return socketIp;
    const cf = req.get('cf-connecting-ip');
    return cf && cf.length <= 64 ? cf : socketIp;
}
app.get('/demo/subscribe', async function (req, res) {
    let counted: string | null = null;
    try {
        const ip = clientIp(req);
        const now = Date.now();
        if (demoHits.size > 2000) for (const [k, v] of demoHits) if (v.resetAt < now) demoHits.delete(k);
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
                try {
                    await strategiesClient.unsubscribeToken(token);
                } catch (e) {
                    demoSubscribed.set(token, 1); // the hold is still in place: keep counting it so a retry can release it
                    throw e;
                }
            } else {
                demoSubscribed.set(token, count - 1);
            }
        } else {
            if (!demoAllowedTokens.has(token)) { res.status(403).json({ error: 'Unknown demo token' }); return; }
            if (!demoSubscribed.has(token) && demoSubscribed.size >= DEMO_MAX_TOKENS) { res.status(429).json({ error: 'Demo subscription limit reached' }); return; }
            demoSubscribed.set(token, (demoSubscribed.get(token) ?? 0) + 1);
            counted = token;
            await strategiesClient.subscribeToken(token);
            counted = null;
        }
        res.sendStatus(200);
    } catch (e: any) {
        // The subscribe did not happen: undo the count taken before the await, or a failure leaks the 20-token cap.
        if (counted) {
            const c = (demoSubscribed.get(counted) ?? 1) - 1;
            if (c <= 0) demoSubscribed.delete(counted); else demoSubscribed.set(counted, c);
        }
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
        const resolved = AntContractMaster.getInstance().findATMOption(AntContractMaster.getInstance().entryStrike(lastNiftyQuote.ltp, optionType, 'NIFTY'), optionType, 'NIFTY');
        allowDemoTokens([resolved.token]);
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
        allowDemoTokens(options.map((o) => o.token));
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
    openSse(res);
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
    openSse(res);
    notificationStreamClients.set(res, user);
    req.on('close', () => notificationStreamClients.delete(res));
});

// Notification ids already pushed to clients. Payout notifications are inserted AND emitted immediately, and the 12s poller below then
// finds the same document: without this the client saw each one twice.
const sentNotificationIds = new Set<string>();
function markNotificationSent(n: any): boolean {
    const id = n?._id ? String(n._id) : null;
    if (!id) return true; // no id to dedupe on: deliver
    if (sentNotificationIds.has(id)) return false;
    sentNotificationIds.add(id);
    if (sentNotificationIds.size > 5000) sentNotificationIds.delete(sentNotificationIds.values().next().value as string);
    return true;
}

myEmitter.on('notification', ({ user, notification }: { user: string; notification: any }) => {
    if (!markNotificationSent(notification)) return;
    for (const [res, streamUser] of notificationStreamClients) {
        if (streamUser === user) res.write(`data: ${JSON.stringify(notification)}\n\n`);
    }
});

setInterval(async () => {
    try {
        // Overlap the window: a document stamped just before the cutoff can be committed after the previous query ran, and would be
        // missed for good otherwise. The sent-id set absorbs the overlap.
        const cutoff = new Date(lastNotificationPollAt.getTime() - 5_000);
        lastNotificationPollAt = new Date();
        if (notificationStreamClients.size === 0) return;
        const fresh = await Mongo.getInstance().db.collection('notifications').find({ createdAt: { $gt: cutoff } }).toArray();
        for (const n of fresh) {
            if (!markNotificationSent(n)) continue;
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
    await backfillVocabularyFields();

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
