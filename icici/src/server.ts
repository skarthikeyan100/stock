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
import { backfillVocabularyFields } from './user';
import Mongo from './tools/mongo';
import OrderClient from './processes/strategies/OrderClient';
import StrategiesClient from './ipc/StrategiesClient';
import { DataLink } from './ipc/DataLink';
import { cloudflareOnly } from './middleware/cloudflareOnly';
import authRoutes from './routes/auth';
import usersRoutes from './routes/users';
import payoutsRoutes from './routes/payouts';
import brokersRoutes from './routes/brokers';
import tradingRoutes from './routes/trading';
import streamsRoutes, { antStreamClients, niftyStreamClients, optionStreamClients, setLastNiftyQuote } from './routes/streams';
import adminRoutes from './routes/admin';
import { requireCsrfHeader } from './routes/session';
import { wrapAsyncHandlers } from './routes/asyncRouter';

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

var app = express();

app.use(cloudflareOnly);
app.use(express.static(path.join(__dirname, '../public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser(SESSION_COOKIE_SECRET));
// Global CSRF guard: every state-changing request must carry X-Requested-With (a header a cross-site page or a plain HTML form cannot
// add without a CORS preflight this server never grants). Previously only some routes were guarded, so
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

// Express 4 does not catch a rejected promise from an async handler/middleware (it becomes an unhandled rejection that can take the
// whole frontend down): every handler registered on the app or on a route module's router is wrapped (routes/asyncRouter.ts).
wrapAsyncHandlers(app);

process.on('unhandledRejection', (reason) => {
    Log.log('[frontend] Unhandled promise rejection (process kept alive):', reason);
});
process.on('uncaughtException', (e) => {
    Log.log('[frontend] Uncaught exception (process kept alive):', e);
});

// ============================== Routes ==============================
// One module per area under src/routes/ (each exports an express Router); session.ts holds the shared auth helpers.
app.use(authRoutes);
app.use(usersRoutes);
app.use(payoutsRoutes);
app.use(brokersRoutes);
app.use(tradingRoutes);
app.use(streamsRoutes);
app.use(adminRoutes);

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

    OrderClient.getInstance().connect();
    StrategiesClient.getInstance().connect();

    // Ticks from `data` (over its socket) feed /niftystream, /optionstream, /ant/stream.
    DataLink.getInstance().onTick((tick) => {
        if (tick.type === 'nifty') {
            setLastNiftyQuote(tick.quote);
            const payload = `data: ${JSON.stringify({ nifty: tick.quote })}\n\n`;
            for (const res of niftyStreamClients) res.write(payload);
        } else if (tick.type === 'option') {
            const payload = `data: ${JSON.stringify(tick.quote)}\n\n`;
            for (const res of optionStreamClients) res.write(payload);
        }
        // Raw relay for /ant/stream, matching its old "verbatim ant-quote" shape.
        const rawPayload = `data: ${JSON.stringify(tick)}\n\n`;
        for (const res of antStreamClients) res.write(rawPayload);
    });
    DataLink.getInstance().connect();

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
