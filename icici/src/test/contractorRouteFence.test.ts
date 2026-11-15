/**
 * Every route the server mounts, checked against the contractor allowlist (spec v2.1 acceptance test 6): a contractor session may reach only the
 * explicitly expected set, and every order / position / trade / P&L / broker / config route answers 403 for it.
 * Run: npx tsc, then node ./dist/test/contractorRouteFence.test.js
 */
import { contractorMayCall } from '../contractors/guard';
import authRoutes from '../routes/auth';
import usersRoutes from '../routes/users';
import payoutsRoutes from '../routes/payouts';
import brokersRoutes from '../routes/brokers';
import tradingRoutes from '../routes/trading';
import streamsRoutes from '../routes/streams';
import adminRoutes from '../routes/admin';
import levelsRoutes from '../routes/levels';
import inviteRoutes from '../routes/invite';
import ownerRoutes from '../routes/ownerContractors';

let failed = 0;
function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) { failed++; process.exitCode = 1; }
}

const routers: Record<string, any> = { auth: authRoutes, users: usersRoutes, payouts: payoutsRoutes, brokers: brokersRoutes, trading: tradingRoutes, streams: streamsRoutes, admin: adminRoutes, levels: levelsRoutes, invite: inviteRoutes, owner: ownerRoutes };

function routesOf(router: any): { method: string; path: string }[] {
    const out: { method: string; path: string }[] = [];
    for (const layer of router.stack ?? []) {
        if (layer.route) for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: String(layer.route.path) });
    }
    return out;
}

// The only routes a contractor session may reach. Anything else that becomes reachable fails this test until it is reviewed and listed here.
const EXPECTED_ALLOWED = new Set([
    'GET /auth/me', 'POST /auth/logout',
    'GET /niftystream', 'GET /notificationstream',
    'GET /users/:email/notifications', 'PATCH /users/:email/notifications/:id/read',
    'GET /agreements/current', 'GET /demo/health',
    'GET /contractor/me', 'GET /contractor/agreement', 'POST /contractor/accept-agreement', 'POST /contractor/sebi', 'POST /contractor/kyc-change',
]);

const all: { src: string; method: string; path: string }[] = [];
for (const [src, r] of Object.entries(routers)) for (const x of routesOf(r)) all.push({ src, ...x });
console.log(`routes enumerated: ${all.length}`);
assert(all.length > 100, 'the enumeration found the real route tables');

const reachable = all.filter((r) => contractorMayCall(r.method, r.path.replace(/:[A-Za-z]+/g, 'x')));
const unexpected = reachable.filter((r) => !EXPECTED_ALLOWED.has(`${r.method} ${r.path}`));
assert(unexpected.length === 0, `no unexpected route is reachable by a contractor${unexpected.length ? ': ' + unexpected.map((u) => `${u.method} ${u.path}`).join(', ') : ''}`);
for (const e of EXPECTED_ALLOWED) assert(all.some((r) => `${r.method} ${r.path}` === e), `the expected route exists: ${e}`);

const mustBeDenied = all.filter((r) => /^\/(order|positionstream|optionstream|admin|config|strategies|strategyPnl|broker|ant|kite|breeze|shoonya|prism|reconcile|user|level-rules|owner)(\/|$)/.test(r.path)
    || /^\/users\/:[A-Za-z]+\/(trades|pnl-summary|payouts|settings|bank-details|documents|delete-account|profile|entity-type|company-profile|verify|role)/.test(r.path));
assert(mustBeDenied.length > 40, `${mustBeDenied.length} order/position/trade/P&L/broker/config/admin routes checked`);
assert(mustBeDenied.every((r) => !contractorMayCall(r.method, r.path.replace(/:[A-Za-z]+/g, 'x'))), 'every one of them is 403 for a contractor');
console.log(failed ? `\n${failed} FAILED` : '\nALL TESTS PASSED');
process.exit(failed ? 1 : 0);
