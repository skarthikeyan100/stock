/**
 * Chain strategies (SimpleContinuous, ScaledHedged, ExperimentalScaled): a buy refused for INSUFFICIENT FUNDS / MARGIN is reported once and never
 * retried (user's decision 2026-11-26). Before: an open adverse leg called hedge() again on every option tick. Any other refusal is still retried.
 * Run: npx tsc, then: node ./dist/test/insufficientFundsNoRetry.test.js
 */
import fs from 'fs';
import OrderClient from '../processes/strategies/OrderClient';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import ScaledHedgedStrategy from '../strategy/ScaledHedgedStrategy';
import ExperimentalScaledStrategy from '../strategy/ExperimentalScaledStrategy';
import { localDayKey } from '../strategy/dayKey';
import { Trade, OptionQuote, NiftyQuote } from '../model/model';
import { NOT_PLACED_TAG } from '../ipc/orderProtocol';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
import Log from '../util/Log';
(configService.getConfig().settings as any).eodCloseTime = '23:59';
(configService.getConfig().settings as any).entryStartTime = '00:00';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

// The refusals as each broker words them (Breeze: live log 2026-11; ANT / Prism: the Noren rejreason; Kite: its margin refusal).
const FUNDS = [
    'Breeze placeOrder failed: Available Futures and Options Limit is insufficient to cover the trade value: ',
    'ANT order 1 REJECTED: {"rejectionReason":"RED:Margin Shortfall:INR 1425466.76 Available:INR 162095.21 for C-X [SHOONYA]"}',
    'Prism buy 1 (N25100PE, u) REJECTED - not filled: RED:Margin Shortfall:INR 10.00 Available:INR 1.00',
    'Kite order 1 REJECTED: Insufficient funds. Required margin is 95417.84 but available margin is 74251.80.',
    'Margin is insufficient',
    'Not enough margin to cover order',
];
const NOT_FUNDS = [
    'Too many requests',
    'Breeze placeOrder failed: Limit rate is not within the execution range',
    "User 'X' (kite) has reached max investment (100000/100000).",
    'NEVER-SHORT GUARD: nothing sellable for N (sellable=0)',
    'Insufficient permission for that call',
    'ANT order 1 did not complete within 60000ms',
];

let buys = 0;
let buyError: string | null = null;
let liveQty = 0;
let cancelFails = false;
const logs: string[] = [];
(Log as any).log = (...a: any[]) => { logs.push(a.map((x) => String((x as any)?.message ?? x)).join(' ')); };

const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        switch (fn) {
            case 'getOpenTrades': return [];
            case 'getPendingSells': return [];
            case 'getLiveQuantity': return liveQty;
            case 'cancelRestingLimitBuys': return { filledQty: 0, cancelFailed: cancelFails };
            case 'cancelRestingLimitSells': return { filledQty: 0, cancelFailed: false };
            case 'getContractByPriceRangeBare': {
                const [, , type] = args;
                return { tradingSymbol: `N25100${type}`, antToken: `${type}25100`, exchange: 'NFO', strike: 25100, premium: 140, instrumentToken: 1, lotSize: 65 };
            }
            case 'buyContractBare':
                buys++;
                if (buyError) throw new Error(buyError);
                return { quantity: args[3], price: 140 };
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;

const files: string[] = [];
function make(Cls: any, legs: any[] = []): any {
    const cfg: any = { type: Cls.name, userId: `IFN-${Math.random().toString(36).slice(2)}`, initialQuantity: 65, maxInvestment: 1000000, priceDiff: 10, brokers: ['kite'], maxProfit: 500000 };
    const s: any = new Cls(cfg.userId);
    s.enabled = true;
    s.stateLoaded = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    const file = `/tmp/insufficient-funds-${cfg.userId}-${process.pid}.json`;
    files.push(file);
    s.stateFile = () => file;
    s.watch = () => {}; s.unwatch = () => {}; s.isEod = () => false; s.isTimeInRange = () => true;
    s.placeSell = async () => {};
    s.lastNiftyLtp = 25000;
    s.loaded = true;
    s.state = { day: localDayKey(), legs: Object.fromEntries(legs.map((l) => [l.id, l])), seq: legs.length, pnlStarted: true, realizedPnl: 0, profitTripped: false, sellIdsTracked: true, seenSells: [] };
    return s;
}
const leg = (o: any = {}) => ({
    id: 'L1', tsym: 'N25100CE', token: 'CE25100', exchange: 'NFO', strike: 25100, right: 'CE', role: 'root', entry: 150, qty: 65, soldQty: 0, soldValue: 0, hedged: false,
    status: 'open', sellQty: 65, sellShortfall: 0, sellPrice: 160, pnlRef: 150, ...o,
});
const tick = (ltp: number) => Object.assign(new OptionQuote(), { token: 'CE25100', ltp });
const fill = (price: number) => Object.assign(new Trade(), { tsym: 'N25100CE', token: 'CE25100', action: 'Sell', quantity: 65, price, broker: 'kite' });
const alerts = () => logs.filter((m) => m.includes('ALERT') && /insufficient funds/i.test(m) && m.includes('not retried')).length;
const reset = (error: string | null) => { buys = 0; buyError = error; liveQty = 0; cancelFails = false; logs.length = 0; };
// Runs every retry path there is: the leg's own ticks and the Nifty-tick retry, with the throttles expired.
async function drive(s: any) {
    for (let i = 0; i < 3; i++) {
        await s.processOptionQuote(tick(135));
        s.lastWaitingHedgeRetry = 0;
        await s.retryWaitingHedges();
    }
}

(async () => {
    const { isInsufficientFunds } = await import('../strategy/insufficientFunds');
    console.log('isInsufficientFunds');
    for (const m of FUNDS) assert(isInsufficientFunds(new Error(m)), `funds: ${m.slice(0, 70)}`);
    for (const m of NOT_FUNDS) assert(!isInsufficientFunds(new Error(m)), `not funds: ${m.slice(0, 70)}`);

    for (const Cls of [SimpleContinuousStrategy, ScaledHedgedStrategy, ExperimentalScaledStrategy] as any[]) {
        console.log(`\n== ${Cls.name}`);

        console.log('hedge refused (not placed) for funds: one attempt, reported, never retried');
        for (const msg of FUNDS.slice(0, 4)) {
            reset(`${NOT_PLACED_TAG} ${msg}`);
            const l = leg();
            const s = make(Cls, [l]);
            await drive(s);
            assert(buys === 1, `one buy only (${buys}) for: ${msg.slice(0, 40)}`);
            assert(alerts() === 1, 'one ALERT');
            assert((l as any).noFunds === true && !(l as any).hedgeWaiting && Object.keys(s.state.legs).length === 1, 'leg marked, nothing waiting, no hedge leg');
            assert(JSON.parse(fs.readFileSync(s.stateFile(), 'utf8')).legs.L1.noFunds === true, 'persisted');
        }

        console.log('the refused leg then closes as the last leg (target, then loss): the stale-flag repair does not buy');
        for (const price of [160, 100]) {
            reset(`${NOT_PLACED_TAG} ${FUNDS[0]}`);
            const l = leg({ role: 'hedge' });
            const s = make(Cls, [l]);
            await s.processOptionQuote(tick(135));
            buyError = null; // even with funds back, the refused order is not sent again
            await s.updateTrade(fill(price));
            s.lastWaitingHedgeRetry = 0;
            await s.retryWaitingHedges();
            assert(l.status === 'closed' && buys === 1, `no further buy after a sell at ${price} (${buys})`);
            s.scheduleLostFollowUp?.();
            assert(!(l as any).hedgeWaiting, 'not revived by the lost-follow-up repair');
        }

        console.log('the earlier legs of the chain close after the refused one: still no buy');
        reset(`${NOT_PLACED_TAG} ${FUNDS[0]}`);
        const root = leg({ id: 'L1', tsym: 'N25100PE', token: 'PE25100', right: 'PE', hedged: true });
        const mid = leg({ id: 'L2', tsym: 'N25200CE', token: 'CE25200', role: 'hedge', parentId: 'L1', hedged: true, status: 'closed', soldQty: 65, soldValue: 65 * 160 });
        const last = leg({ id: 'L3', role: 'hedge', parentId: 'L2' });
        const chain = make(Cls, [root, mid, last]);
        await chain.processOptionQuote(tick(135));
        buyError = null;
        await chain.updateTrade(fill(100));
        await chain.updateTrade(Object.assign(fill(100), { tsym: 'N25100PE', token: 'PE25100' }));
        chain.lastWaitingHedgeRetry = 0;
        await chain.retryWaitingHedges();
        assert(root.status === 'closed' && last.status === 'closed' && buys === 1, `no further buy (${buys})`);

        console.log('unconfirmed funds rejection, broker shows nothing bought: not retried');
        reset(FUNDS[1]);
        let l: any = leg();
        let s = make(Cls, [l]);
        await drive(s);
        assert(buys === 1 && l.noFunds === true && alerts() === 1, `one buy, marked, one ALERT (buys=${buys})`);

        console.log('unconfirmed funds rejection, broker unreadable: pending, and not retried once settled as nothing bought');
        reset(FUNDS[1]);
        cancelFails = true;
        l = leg();
        s = make(Cls, [l]);
        await s.processOptionQuote(tick(135));
        assert(!!l.pendingHedge && !l.noFunds, 'recorded as pending');
        cancelFails = false;
        await s.settlePendingHedges(true);
        await drive(s);
        assert(buys === 1 && !l.pendingHedge && l.noFunds === true && alerts() === 1, `settled and never re-bought (buys=${buys})`);

        console.log('control: any other refusal is still retried');
        reset(`${NOT_PLACED_TAG} Too many requests`);
        l = leg();
        s = make(Cls, [l]);
        await drive(s);
        assert(buys > 1 && !l.noFunds, `retried (${buys})`);

        console.log('root buy refused for funds: not retried; reset() re-arms');
        reset(`${NOT_PLACED_TAG} ${FUNDS[0]}`);
        s = make(Cls);
        s.direction = async () => 'CE';
        const nifty = () => Object.assign(new NiftyQuote(), { ltp: 25000 });
        for (let i = 0; i < 3; i++) await s.processNiftyQuote(nifty());
        assert(buys === 1 && alerts() === 1, `one root buy (${buys}), one ALERT`);
        assert(JSON.parse(fs.readFileSync(s.stateFile(), 'utf8')).rootNoFunds === true, 'persisted');
        buyError = null;
        s.reset();
        await s.processNiftyQuote(nifty());
        assert(buys === 2 && Object.keys(s.state.legs).length === 1, 'after a reset the root is bought');

        console.log('control: a root refused for another reason is tried again');
        reset(`${NOT_PLACED_TAG} Too many requests`);
        s = make(Cls);
        s.direction = async () => 'CE';
        for (let i = 0; i < 3; i++) await s.processNiftyQuote(nifty());
        assert(buys === 3, `retried (${buys})`);

        console.log('unconfirmed root funds rejection, nothing bought: not retried');
        reset(FUNDS[1]);
        s = make(Cls);
        s.direction = async () => 'CE';
        for (let i = 0; i < 3; i++) await s.processNiftyQuote(nifty());
        assert(buys === 1 && alerts() === 1, `one root buy (${buys})`);
    }
    for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f);
    console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
})().catch((e) => { console.log(e); process.exit(1); });
