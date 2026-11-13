/**
 * Manual buy, index + right (ATM) branch on Kite, ANT and Breeze: investmentMode 'investmentAmount' sizes to as many lots as the capital
 * allows (no lot-count cap), 'lotCount' buys one lot; per-order cap and open positions shrink it; canPlaceOrder applies the lot limit in
 * lotCount mode only. Mocks only. Run: node ./dist/test/manualBuySizing.test.js
 */
import Kite from '../kite/Kite';
import ANT from '../ant/ANT';
import Breeze from '../breeze/Breeze';
import KiteContractMaster from '../kite/KiteContractMaster';
import AntContractMaster from '../ant/AntContractMaster';
import BreezeContractMaster, { FnoRecord } from '../breeze/BreezeContractMaster';
import bookkeeping from '../processes/order/bookkeeping';
import { Trade } from '../model/model';
import { manualBuyOnKite } from '../processes/order/kiteExecutor';
import { manualBuyOnAnt } from '../processes/order/antExecutor';
import { manualBuyOnBreeze } from '../processes/order/breezeExecutor';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const STOP = 'STOP-AFTER-SIZING';
const bz: FnoRecord = { token: 'BZ1', instrumentName: 'OPTIDX', shortName: 'NIFTY', series: 'OPTION', expiryDate: '17-Nov-2026', strikePrice: '25150', optionType: 'CE', lotSize: 65, tickSize: 0.05, companyName: 'NIFTY', exchange: 'NFO' };
const antRow = { token: 'A1', exch: 'NFO', tradingSymbol: 'NIFTY26N1725150CE', lotSize: '65' };

let captured = 0;
const capture = (q: any) => { captured = Number(q); throw new Error(STOP); };

async function sizeOn(name: string, fn: () => Promise<unknown>): Promise<number> {
    captured = 0;
    try { await fn(); } catch (e: any) { if (e.message !== STOP) throw new Error(`${name}: ${e.message}`); }
    return captured;
}

async function main() {
    (ANT.getInstance() as any).getLiveQuote = async () => ({ ltp: 131, bid: 130, ask: 131 });
    for (const m of ['placeOrder', 'placeBracketOrder', 'placeCoverOrder']) (ANT.getInstance() as any)[m] = async (o: any) => capture(o.quantity); // every ANT placement is stubbed: nothing may reach the broker
    (Kite.getInstance() as any).hasValidSession = async () => true;
    (Kite.getInstance() as any).placeLimitBuyOption = async (_t: string, qty: number) => capture(qty);
    (Breeze.getInstance() as any).hasValidSession = async () => true;
    (Breeze.getInstance() as any).placeOrder = async (o: any) => capture(o.quantity);
    (Breeze.getInstance() as any).getQuotes = async () => ({ Success: [{ best_bid_price: '130', best_offer_price: '131', ltp: '131' }] });
    const am = AntContractMaster.getInstance() as any;
    am.entryStrike = () => 25150;
    am.findATMOption = () => antRow;
    am.findNearestExpiryOption = () => antRow;
    am.findExactOption = () => antRow;
    am.resolveCommonToken = () => 'C1';
    (KiteContractMaster.getInstance() as any).findATMOption = async () => ({ tradingSymbol: 'NIFTY26N1725150CE', lotSize: 65, exchange: 'NFO' });
    (BreezeContractMaster.getInstance() as any).findATMOption = async () => bz;

    const brokers: Array<[string, (u: string) => Promise<unknown>]> = [
        ['kite', (u) => manualBuyOnKite({ userId: u, right: 'call', index: 'NIFTY' })],
        ['ant', (u) => manualBuyOnAnt({ userId: u, right: 'call', index: 'NIFTY' })],
        ['breeze', (u) => manualBuyOnBreeze({ userId: u, right: 'call', index: 'NIFTY' })],
    ];
    const base = { lossLimit: 1e9, lotLimit: 10, maxInvestment: 1e9 };

    for (const [name, buy] of brokers) {
        console.log(name);
        bookkeeping.updateUserSettings(`${name}-amt`, { ...base, investmentMode: 'investmentAmount', accountCapital: 100000 });
        assert(await sizeOn(name, () => buy(`${name}-amt`)) === 11 * 65, 'investmentAmount: 100000 @ 131 -> 11 lots (more than the lot limit of 10)');

        bookkeeping.updateUserSettings(`${name}-lot`, { ...base, investmentMode: 'lotCount', accountCapital: 100000 });
        assert(await sizeOn(name, () => buy(`${name}-lot`)) === 65, 'lotCount: one lot');

        bookkeeping.updateUserSettings(`${name}-cap`, { ...base, investmentMode: 'investmentAmount', accountCapital: 100000, perOrderCap: 30000 });
        assert(await sizeOn(name, () => buy(`${name}-cap`)) === 3 * 65, 'per-order cap 30000 clamps to 3 lots');

        // 40000 of the 100000 already in open positions: capital left 60000 -> 7 lots.
        bookkeeping.updateUserSettings(`${name}-open`, { ...base, investmentMode: 'investmentAmount', accountCapital: 100000 });
        bookkeeping.trades.push(Object.assign(new Trade(), { tsym: 'X', token: 'T', quantity: 400, price: 100, user: `${name}-open`, action: 'Buy', broker: name }));
        assert(await sizeOn(name, () => buy(`${name}-open`)) === 7 * 65, 'open positions shrink the remaining capital (60000 -> 7 lots)');
    }

    console.log('canPlaceOrder lot limit');
    bookkeeping.updateUserSettings('gate-lot', { ...base, investmentMode: 'lotCount', accountCapital: 100000 });
    bookkeeping.updateUserSettings('gate-amt', { ...base, investmentMode: 'investmentAmount', accountCapital: 100000 });
    for (const u of ['gate-lot', 'gate-amt']) bookkeeping.trades.push(Object.assign(new Trade(), { tsym: 'NIFTY26N1725150CE', token: `G-${u}`, quantity: 650, price: 10, user: u, action: 'Buy' }));
    const lotMode = await bookkeeping.canPlaceOrder('gate-lot');
    assert(!lotMode.allowed && /lot limit/.test(lotMode.reason ?? ''), 'lotCount mode: 10 open lots hits the lot limit');
    const amtMode = await bookkeeping.canPlaceOrder('gate-amt');
    assert(!/lot limit/.test(amtMode.reason ?? ''), 'investmentAmount mode: 10 open lots is not blocked by the lot limit');
    bookkeeping.updateUserSettings('gate-full', { ...base, investmentMode: 'investmentAmount', accountCapital: 5000 });
    bookkeeping.trades.push(Object.assign(new Trade(), { tsym: 'NIFTY26N1725150CE', token: 'G-full', quantity: 65, price: 100, user: 'gate-full', action: 'Buy' }));
    const full = await bookkeeping.canPlaceOrder('gate-full');
    assert(!full.allowed && /no capital left/.test(full.reason ?? ''), 'investmentAmount mode: blocked by capital once it is used up');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
