/**
 * SimpleContinuousStrategy: NO double-up (removed 2026-11-13), against a stubbed OrderClient (no broker, no order process; every placement
 * method is a recorder, MOCK_BROKER is not needed because nothing reaches the network):
 *   - a hedge leg's profit sell buys nothing for its parent (CE and PE parents, default / onePositionPerSide / maxLegsPerSide modes); the hedge
 *     chain (the hedge's own follow-up buy) continues
 *   - a state file written before the removal (legs with doubled:true / doubleDue:true, qty 1170 = 2 x 585, resting sell 164.75) restores
 *     unchanged: reconcile accepts the broker quantity, keeps the resting sell, places no order; ticks buy nothing, even for doubleDue:true
 *   - the entry + priceDiff rule still gives 164.75 for the 1170 leg (sell shortfall placement), and the maxProfit clear price still works
 * Run: npx tsc, then: node ./dist/test/simpleNoDoubleUp.test.js
 */
import fs from 'fs';
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import { clearPrice } from '../strategy/maxProfitLock';
import { localDayKey } from '../strategy/dayKey';
import { Trade, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
let openTrades: any[] = [];
let pendingFor: (tsym: string) => any[] = () => [];
const ORDER_FNS = new Set(['buyContractBare', 'placeLimitBuyBare', 'brokerPlaceLimitSellBare', 'chunkedSquareOffLimit', 'cancelRestingLimitSells', 'cancelRestingLimitBuys', 'squareOffBare', 'attachProtection']);
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'getOpenTrades': return openTrades;
            case 'getPendingSells': return pendingFor(args[2]);
            case 'getOptionLtp': return 100;
            case 'cancelRestingLimitSells': return { filledQty: 0, cancelFailed: false };
            case 'getContractByPriceRangeBare': {
                const [, , type] = args;
                const strike = type === 'CE' ? 25100 : 25050;
                return { tradingSymbol: `N${strike}${type}`, antToken: `${type}${strike}`, exchange: 'NFO', strike, premium: 140, instrumentToken: 1, lotSize: 65 };
            }
            case 'buyContractBare': return { quantity: args[3], price: 140 };
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
(AntContractMaster as any).getInstance = () => ({ entryStrike: (_ltp: number, right: string) => (right === 'CE' ? 25100 : 25050), findByToken: () => undefined });

const count = (fn: string) => calls.filter((c) => c.fn === fn).length;
const buysOf = (tsym: string) => calls.filter((c) => c.fn === 'buyContractBare' && c.args[1] === tsym).length;
const ordersPlaced = () => calls.filter((c) => ORDER_FNS.has(c.fn)).length;
const fill = (tsym: string, token: string, qty: number, price: number) => Object.assign(new Trade(), { tsym, token, action: 'Sell', quantity: qty, price, broker: 'kite' });

function make(cfgExtra: any = {}, legs: any[] = [], persist = false): any {
    const cfg: any = { type: 'SimpleContinuousStrategy', userId: `SND-${Math.random().toString(36).slice(2)}`, initialQuantity: 65, maxInvestment: 100000, priceDiff: 10, brokers: ['kite'], maxProfit: 5000, ...cfgExtra };
    const s: any = new SimpleContinuousStrategy(cfg.userId);
    s.enabled = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    const file = `/tmp/simple-no-double-up-${cfg.userId}-${process.pid}.json`;
    s.stateFile = () => file;
    s.watch = () => {}; s.unwatch = () => {}; s.isEod = () => false;
    s.lastNiftyLtp = 25000;
    const state = { day: localDayKey(), legs: Object.fromEntries(legs.map((l) => [l.id, l])), seq: legs.length, pnlStarted: true, realizedPnl: 0, profitTripped: false };
    if (persist) fs.writeFileSync(file, JSON.stringify(state)); // restored through the real ensureLoaded
    else { s.loaded = true; s.state = state; }
    return s;
}
const leg = (id: string, tsym: string, right: 'CE' | 'PE', o: any = {}) => ({
    id, tsym, token: `${right}-${tsym}`, exchange: 'NFO', strike: 25100, right, role: 'root', entry: 150, qty: 65, soldQty: 0, soldValue: 0, hedged: true,
    status: 'open', sellQty: 65, sellShortfall: 0, sellPrice: 160, pnlRef: 150, ...o,
});
const tick = (l: any, ltp: number) => Object.assign(new OptionQuote(), { token: l.token, ltp });

(async () => {
    console.log('a hedge profit sell does not buy the parent again (CE and PE parents, every stacking mode); the chain continues');
    for (const mode of [{}, { onePositionPerSide: true }, { maxLegsPerSide: 1 }]) {
        for (const parentRight of ['CE', 'PE'] as const) {
            calls = [];
            const hr = parentRight === 'CE' ? 'PE' : 'CE';
            const parent = leg('L1', `PARENT${parentRight}`, parentRight);
            const hedge = leg('L2', `HEDGE${hr}`, hr, { role: 'hedge', parentId: 'L1', hedged: false });
            const s = make(mode, [parent, hedge]);
            await s.updateTrade(fill(hedge.tsym, hedge.token, 65, 160));
            const tag = `${JSON.stringify(mode)} ${parentRight} parent`;
            assert(hedge.status === 'closed' && parent.status === 'open', `${tag}: hedge closed, parent still open`);
            assert(buysOf(parent.tsym) === 0 && parent.qty === 65 && parent.entry === 150 && (parent as any).doubled === undefined, `${tag}: parent not bought again, quantity/entry unchanged`);
            assert(count('cancelRestingLimitSells') === 0 && parent.sellQty === 65 && parent.sellPrice === 160, `${tag}: parent's resting sell untouched`);
            assert(count('buyContractBare') === 1, `${tag}: the hedge chain continues (hedge's own follow-up buy: ${count('buyContractBare')})`);
        }
    }

    console.log('partial fill of a hedge sell buys nothing, the closing fill buys no parent');
    {
        calls = [];
        const parent = leg('L1', 'PARENTCE', 'CE');
        const hedge = leg('L2', 'HEDGEPE', 'PE', { role: 'hedge', parentId: 'L1', hedged: true, qty: 130, sellQty: 130 });
        const s = make({}, [parent, hedge]);
        await s.updateTrade(fill(hedge.tsym, hedge.token, 65, 160));
        assert(hedge.status === 'open' && ordersPlaced() === 0, 'first partial fill: nothing placed, hedge open');
        await s.updateTrade(fill(hedge.tsym, hedge.token, 65, 160));
        assert(hedge.status === 'closed' && buysOf('PARENTCE') === 0 && count('cancelRestingLimitSells') === 0, 'last fill: no buy / cancel on the parent');
    }

    console.log('state written before the removal (doubled:true / doubleDue:true, qty 1170) is carried unchanged');
    {
        calls = [];
        const l1 = leg('L1', 'NIFTY26N1725100CE', 'CE', { status: 'closed', sellQty: 0 });
        const l2 = leg('L2', 'NIFTY26N1725100CE', 'CE', { role: 'hedge', parentId: 'L1', entry: 154.744, qty: 1170, doubled: true, doubleDue: false, sellQty: 1170, sellPrice: 164.75, pnlRef: 154.744 });
        const l3 = leg('L3', 'NIFTY26N1725100PE', 'PE', { status: 'closed', sellQty: 0, entry: 130, hedged: true });
        const l4 = leg('L4', 'NIFTY26N1725100PE', 'PE', { role: 'hedge', parentId: 'L3', entry: 138.25, qty: 585, hedged: true, sellQty: 585, sellPrice: 148.25, pnlRef: 138.25 });
        const l5 = leg('L5', 'LEFTOVERCE', 'CE', { entry: 100, qty: 130, doubled: false, doubleDue: true, sellQty: 130, sellPrice: 110, pnlRef: 100 });
        openTrades = [
            { tsym: l2.tsym, token: l2.token, quantity: 1170, price: 154.744, originalEntryPrice: 154.744 },
            { tsym: l4.tsym, token: l4.token, quantity: 585, price: 138.25, originalEntryPrice: 138.25 },
            { tsym: l5.tsym, token: l5.token, quantity: 130, price: 100, originalEntryPrice: 100 },
        ];
        const s = make({ maxProfit: 1e9 }, [l1, l2, l3, l4, l5], true); // cap out of reach here; the lock is checked below
        // resting sells as the broker reports them, per contract
        const byTsym: Record<string, number> = { [l2.tsym]: 1170, [l4.tsym]: 585, [l5.tsym]: 130 };
        pendingFor = (tsym: string) => (byTsym[tsym] ? [{ quantity: byTsym[tsym] }] : []);
        await s.reconcile(1, 0);
        const st = s.state.legs;
        assert(ordersPlaced() === 0, `reconcile places no order (${calls.map((c) => c.fn).join(',')})`);
        assert(st.L2.status === 'open' && st.L2.qty === 1170 && st.L2.sellQty === 1170 && st.L2.sellPrice === 164.75 && st.L2.sellShortfall === 0, 'L2: 1170 accepted as held, resting sell 1170 @164.75 kept');
        assert(st.L4.status === 'open' && st.L4.qty === 585 && st.L4.sellQty === 585 && st.L4.sellPrice === 148.25, 'L4 kept (585, resting 148.25)');
        assert(!Object.values<any>(st).some((l) => l.id !== 'L1' && l.id !== 'L2' && l.id !== 'L3' && l.id !== 'L4' && l.id !== 'L5'), 'no orphan adopted for the 1170 quantity');
        // ticks (including the leftover doubleDue:true leg, at a profit and a loss)
        for (const [l, p] of [[l2, 170], [l2, 120], [l5, 112], [l5, 90], [l4, 150]] as [any, number][]) await s.processOptionQuote(tick(l, p));
        assert(ordersPlaced() === 0 && count('buyContractBare') === 0, `ticks place nothing, doubleDue:true triggers no buy (${calls.filter((c) => ORDER_FNS.has(c.fn)).map((c) => c.fn).join(',')})`);
        // the entry + priceDiff rule for a shortfall of the 1170 leg
        st.L2.sellQty = 585; st.L2.sellShortfall = 585; s.lastSellAttempt.clear();
        await s.processOptionQuote(tick(l2, 160));
        const sell = calls.filter((c) => c.fn === 'chunkedSquareOffLimit').pop();
        assert(sell?.args[1].price === 164.75 && sell?.args[1].quantity === 585, `shortfall of L2 rests @${sell?.args[1].price} (entry avg 154.744 + 10 = 164.75)`);
        // L4 fills: nothing goes into a double-up of its closed parent; its hedge follows (chain continues) and L2 / L5 are untouched
        calls = [];
        await s.updateTrade(fill(l4.tsym, l4.token, 585, 148.25));
        assert(buysOf(l2.tsym) === 0 && buysOf(l5.tsym) === 0 && st.L2.qty === 1170 && st.L5.qty === 130, 'L4 fill: no buy of L2 / L5 (doubleDue leg), quantities unchanged');
        assert(count('cancelRestingLimitSells') === 0, 'no cancel of any resting sell');
        // a leg with leftover doubleDue:true and a hedge profit sell as its child: still no buy of it
        calls = [];
        st.L6 = leg('L6', 'CHILDPE', 'PE', { role: 'hedge', parentId: 'L5', hedged: true });
        await s.updateTrade(fill('CHILDPE', st.L6.token, 65, 160));
        assert(buysOf('LEFTOVERCE') === 0 && st.L5.qty === 130, 'child profit sell of a doubleDue:true parent: parent not bought');
        // the max-profit lock still acts on the restored 1170 leg: cancels its resting sell and re-rests it at the clear price, buys nothing
        calls = [];
        const lk = make({ maxProfit: 5000 }, [{ ...l2, sellQty: 1170 }], true);
        openTrades = [openTrades[0]]; pendingFor = () => [{ quantity: 1170 }];
        await lk.reconcile(1, 0);
        calls = [];
        (lk as any).state.legs.L2.sellPrice = 175; // a sell above the market (170) sits out of reach; one at/below the market and >= clearPrice is kept (marketable)
        await lk.processOptionQuote(tick(l2, 170));
        await lk.checkMaxProfit();
        assert(count('buyContractBare') === 0 && count('cancelRestingLimitSells') >= 1 && count('chunkedSquareOffLimit') >= 1, 'maxProfit lock: resting sell cancelled and re-placed, no buy');
        // maxProfit clear price still works with the 1170 leg among the other legs
        const cp = clearPrice(st.L2, [st.L2, st.L5], 0, 5000);
        assert(Number.isFinite(cp) && 1170 * (cp - 154.744) + 130 * (st.L5.sellPrice - 100) >= 5000 - 1e-6, `clearPrice for the 1170 leg: ${cp}`);
    }
    for (const f of fs.readdirSync('/tmp').filter((x) => x.startsWith('simple-no-double-up-') && x.includes(String(process.pid)))) fs.unlinkSync(`/tmp/${f}`);
    process.exit(process.exitCode ?? 0); // the config watcher keeps the process alive otherwise
})();

