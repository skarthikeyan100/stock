/**
 * SimpleContinuousStrategy slDistance: a leg whose price falls to entry - slDistance is cancelled and sold at market; no slDistance = no stop.
 * Run: npx tsc, then: node ./dist/test/simpleSlDistance.test.js
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
            case 'getOrderPrice': return { price: 100, bid: 100, ask: 100.05, ltp: 100, spread: 0.05 };
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
    console.log('slDistance 50: CE falls 10 (hedge, no exit), then 50 (exit)');
    calls = [];
    const ce = leg('L1', 'CE1', 'CE', { entry: 150, sellQty: 65, hedged: true });
    let s = make({ slDistance: 50 }, [ce]);
    await s.processOptionQuote(tick(ce, 140));
    assert(count('chunkedSquareOff') === 0 && ce.status === 'open', 'at entry-10 nothing is sold');
    await s.processOptionQuote(tick(ce, 100));
    assert(count('cancelRestingLimitSells') === 1, 'at entry-50 the resting sell is cancelled');
    const sell = calls.find((c) => c.fn === 'chunkedSquareOff');
    assert(!!sell && sell.args[1].tradingSymbol === 'CE1' && sell.args[1].quantity === 65, 'the whole leg is sold at market');
    assert(ce.status === 'open', 'the leg stays open until the fill event');
    await s.processOptionQuote(tick(ce, 95));
    assert(count('chunkedSquareOff') === 1, 'the next tick does not sell again');
    await s.updateTrade(fill('CE1', ce.token, 65, 99));
    assert(ce.status === 'closed' && Math.round(s.state.realizedPnl) === Math.round(65 * (99 - 150)), 'the fill closes the leg and books the loss');

    console.log('no slDistance: no stop');
    calls = [];
    const ce2 = leg('L1', 'CE2', 'CE');
    s = make({}, [ce2]);
    await s.processOptionQuote(tick(ce2, 50));
    assert(count('chunkedSquareOff') === 0 && count('cancelRestingLimitSells') === 0, 'a falling leg is left alone');

    console.log('PE leg stops the same way');
    calls = [];
    const pe = leg('L1', 'PE1', 'PE', { entry: 140 });
    s = make({ slDistance: 50 }, [pe]);
    await s.processOptionQuote(tick(pe, 90));
    assert(count('chunkedSquareOff') === 1, 'PE at entry-50 is sold');
})();
