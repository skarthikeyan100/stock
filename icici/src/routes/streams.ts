import Log from '../util/Log';
import express from 'express';
import { Trade } from '../model/model';
import { ObjectId } from 'mongodb';
import Mongo from '../tools/mongo';
import myEmitter from '../tools/emitter';
import AntContractMaster from '../ant/AntContractMaster';
import OrderClient from '../processes/strategies/OrderClient';
import StrategiesClient from '../ipc/StrategiesClient';
import { DataLink } from '../ipc/DataLink';
import { isLoopback } from '../middleware/cloudflareOnly';
import { asyncRouter } from './asyncRouter';
import { resolveUser, requireAuth, requireAdmin, requireSelfOrAdmin } from './session';

const router = asyncRouter();
const orderClient = OrderClient.getInstance();
const strategiesClient = StrategiesClient.getInstance();

// ============================== ANT connect / raw stream ==============================
// `data` auto-connects and auto-reconnects on its own now (see AntDataStream's
// backoff logic), so /ant/connect is a manual trigger for parity rather than
// the only way to get connected - it sends a reconnect command to `data` over its socket.
router.post('/ant/connect', requireAdmin, async function (req, res) {
    try {
        DataLink.getInstance().send({ cmd: 'reconnect' });
        res.json({ status: 'connected' });
    } catch (e: any) {
        Log.log('ANT connect error:', e);
        res.status(500).json({ error: 'Failed to connect to ANT streaming' });
    }
});

export const antStreamClients = new Set<express.Response>();
router.get('/ant/stream', requireAdmin, function (req, res) {
    req.on('close', () => antStreamClients.delete(res));
    openSse(res);
    antStreamClients.add(res);
});

router.get('/order/can-place', requireAuth, async function (req: express.Request, res) {
    try {
        const result = await orderClient.canPlaceOrder(resolveUser(req));
        res.send(result);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});


// ============================== Real-time Streaming (SSE) ==============================

export const niftyStreamClients = new Set<express.Response>();
export const optionStreamClients = new Set<express.Response>();
export const positionStreamClients = new Map<express.Response, string>(); // res -> user

// Last tick seen, replayed to a client connecting between ticks (e.g. after
// market close, or a page refresh) so the ticker isn't blank until the next
// live update - which may not arrive until the next session.
let lastNiftyQuote: any = null;
export function setLastNiftyQuote(q: any): void { lastNiftyQuote = q; }

// SSE preamble shared by every stream route: headers, flush, reconnect hint.
export function openSse(res: express.Response): void {
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

router.get('/niftystream', requireAuth, async function (req, res) {
    openMarketStream(req, res, niftyStreamClients, replayNifty);
});

router.get('/optionstream', requireAuth, async function (req, res) {
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
router.get('/demo/niftystream', demoStream(niftyStreamClients, replayNifty));
router.get('/demo/optionstream', demoStream(optionStreamClients));

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
router.get('/demo/subscribe', async function (req, res) {
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
router.get('/demo/resolve', async function (req, res) {
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
router.get('/demo/symbols', async function (req, res) {
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

router.get('/positionstream', requireAuth, async function (req, res) {
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

router.get('/users/:email/notifications', requireSelfOrAdmin('email'), async function (req, res) {
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

router.patch('/users/:email/notifications/:id/read', requireSelfOrAdmin('email'), async function (req, res) {
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

router.get('/notificationstream', requireAuth, async function (req, res) {
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
    for (const res of niftyStreamClients) res.write(heartbeat);
    for (const res of optionStreamClients) res.write(heartbeat);
    for (const res of positionStreamClients.keys()) res.write(heartbeat);
    for (const res of notificationStreamClients.keys()) res.write(heartbeat);
}, 20_000);


export default router;
