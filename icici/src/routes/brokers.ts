import Log from '../util/Log';
import express from 'express';
import OrderClient from '../processes/strategies/OrderClient';
import { DataLink } from '../ipc/DataLink';
import { BROKER_CLIENTS, brokerClientFor } from '../broker/brokerClients';
import { BrokerClient, CallbackParams, MissingCredentialsError } from '../broker/BrokerClient';
import { ALL_BROKERS, BrokerName } from '../util/brokerName';
import { asyncRouter } from './asyncRouter';
import { requireAdmin } from './session';

const router = asyncRouter();
const orderClient = OrderClient.getInstance();

// ============================== Broker OAuth ==============================
// Three independent flows, none sharing a session file/cookie with each other
// or with the app-level `session` cookie above. Each singleton's session file
// is __dirname-relative (repo root), so writing it here and reading it in
// `order`/`data` works across processes without any extra plumbing - only the
// already-running singletons need telling to re-read it (reloadSession, below).




// --- Broker registry: login redirect, OAuth/session callback, and the debug trades/positions reads, per broker. ---
// One generic handler pair serves every broker's /<broker>/login and /<broker>/callback route over the BrokerClient registry
// (src/broker/brokerClients.ts); a broker-specific detail is data in BROKER_ROUTES, not another handler.
// Per broker, only what is not on the BrokerClient: how its redirect's query/body maps to credentials, and whether `data` must
// reconnect its stream once a session exists.
interface BrokerRoute {
    callbackParams(req: express.Request): CallbackParams;
    // Sent to `data` once a session exists so it (re)connects its stream; absent when `data` has no stream for this broker.
    reconnectCmd?: { cmd: 'reconnect'; source?: string };
}

const BROKER_ROUTES: Record<BrokerName, BrokerRoute> = {
    prism: {
        callbackParams: (req) => ({ code: req.query.code as string | undefined }),
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
        if (route.reconnectCmd) DataLink.getInstance().send(route.reconnectCmd);
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
    router.get(`/${name}/login`, brokerLogin(name));
    router.get(`/${name}/callback`, brokerCallback(name));
}
router.post('/breeze/callback', brokerCallback('breeze'));
// Shoonya's registered OAuth app redirect URI is /shoonya/callback (a broker-side dashboard setting, not something this code
// controls) - alias it to the same handler rather than requiring the app registration to change.
router.get('/shoonya/callback', brokerCallback('prism'));



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

router.get('/broker/:broker/trades', requireAdmin, async function (req, res) {
    try {
        const trades = await getBrokerTrades(req.params.broker);
        res.json({ success: true, broker: req.params.broker, trades });
    } catch (e: any) {
        Log.log(`${req.params.broker} trades error:`, e);
        res.status(e.message.startsWith('Unknown broker') ? 400 : 500).json({ error: 'Failed to fetch trades' });
    }
});

router.get('/broker/:broker/positions', requireAdmin, async function (req, res) {
    try {
        const positions = await getBrokerPositions(req.params.broker);
        res.json({ success: true, broker: req.params.broker, positions });
    } catch (e: any) {
        Log.log(`${req.params.broker} positions error:`, e);
        res.status(e.message.startsWith('Unknown broker') ? 400 : 500).json({ error: 'Failed to fetch positions' });
    }
});


export default router;
