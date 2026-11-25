/**
 * RuleBasedStrategy honours the block's `brokers:` list (2026-11-25: a kite-only block bought on Prism because the strategy always used the
 * Prism-only buyContract path). Each instance (one per listed broker, util/strategyInstances.ts) trades only on its own broker through the
 * broker-explicit Bare calls; an open position restored from Mongo is exited on the broker it is held on, whatever the config lists now.
 * Run: node ./dist/test/ruleBasedBroker.test.js
 */
import OrderClient from '../processes/strategies/OrderClient';
import RuleBasedStrategy from '../strategy/RuleBasedStrategy';
import { expandStrategyInstances } from '../util/strategyInstances';
import { OptionQuote, NiftyQuote, Trade } from '../model/model';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const calls: { type: string; args: any[] }[] = [];
let openTrades: any[] = [];
const stub: any = new Proxy({}, {
    get: (_t, name: string) => async (...args: any[]) => {
        calls.push({ type: name, args });
        if (name === 'getContractByPriceRangeBare') return { tradingSymbol: `${args[6]}-SYM`, instrumentToken: 1, lotSize: 65, exchange: 'NFO', strike: 25900, premium: 250, antToken: '47855' };
        if (name === 'buyContractBare') return Object.assign(new Trade(), { tsym: args[1], quantity: args[3], price: 250 });
        if (name === 'chunkedSquareOff') return { quantity: args[1].quantity };
        if (name === 'getOpenTrades') return openTrades;
        throw new Error(`unexpected OrderClient call: ${name}`);
    },
});
(OrderClient as any).getInstance = () => stub;

function make(broker: string) {
    const s: any = new RuleBasedStrategy('RuleBased-test');
    s.getConfig = () => ({ enabled: true, broker, indicators: [], quantity: 65, logEnabled: false, requireAllIndicators: true });
    s.setting = (k: string) => (k === 'target' ? 10 : k === 'stopLoss' ? 'none' : k === 'maxHoldTimeMinutes' ? 60 : undefined);
    s.instanceConfig = () => ({});
    return s;
}
const types = () => calls.map((c) => c.type);
const nifty = (ltp: number) => Object.assign(new NiftyQuote(), { ltp });
const opt = (token: string, ltp: number) => Object.assign(new OptionQuote(), { token, ltp });

async function main() {
    // 1. the block of the incident expands to ONE kite instance
    const inst = expandStrategyInstances([{ type: 'RuleBasedStrategy', enabled: true, brokers: ['kite'], indicators: ['RSI_5_80_20'] }] as any[]);
    assert(inst.length === 1 && (inst[0] as any).broker === 'kite', 'the kite-only block is one kite instance');

    // 2. kite: contract picked and bought on kite, nothing on the Prism-only path
    let s = make('kite');
    await s.processNiftyQuote(nifty(25900));
    await s.executeTrade('call', s.resolveExits(), 60);
    const pick = calls.find((c) => c.type === 'getContractByPriceRangeBare');
    const buy = calls.find((c) => c.type === 'buyContractBare');
    assert(!!pick && pick.args[6] === 'kite', 'contract lookup asks the kite executor');
    assert(!!buy && buy.args[6] === 'kite' && buy.args[3] === 65 && buy.args[1] === 'kite-SYM', 'buy goes to kite with the block quantity (65)');
    assert(!types().includes('buyContract') && !types().includes('getContractByPriceRange') && !types().includes('getToken'), 'no Prism-only call (buyContract / getContractByPriceRange / getToken)');
    assert(s.contract?.broker === 'kite', 'the position is attributed to kite');

    // 3. prism listed: prism is used (explicitly)
    calls.length = 0;
    s = make('prism');
    await s.processNiftyQuote(nifty(25900));
    await s.executeTrade('call', s.resolveExits(), 0);
    assert(calls.find((c) => c.type === 'buyContractBare')?.args[6] === 'prism' && s.contract?.broker === 'prism', 'brokers [prism] buys on prism');

    // 4. restart restore: a Prism leg of this user is managed and exited on Prism although the config now says kite
    calls.length = 0;
    openTrades = [{ tsym: 'NIFTY01DEC26C25950', token: '47893', price: 269.45, quantity: 65, broker: 'prism', entryTime: new Date(Date.now() - 61 * 60000).toISOString() }];
    s = make('kite');
    await s.reconcile();
    assert(s.contract?.broker === 'prism' && s.contract.contract === 'NIFTY01DEC26C25950', 'reconcile restores the Prism leg with its own broker');
    assert(!types().some((t) => /buy/i.test(t) && t !== 'getOpenTrades'), 'reconcile places no buy');
    await s.processOptionQuote(opt('47893', 270));
    const sell = calls.find((c) => c.type === 'chunkedSquareOff');
    assert(!!sell && sell.args[1].broker === 'prism' && sell.args[1].tradingSymbol === 'NIFTY01DEC26C25950' && sell.args[1].quantity === 65, 'max-hold exit sells on prism, qty 65');
    assert(!types().includes('sellContract'), 'no legacy sellContract call');

    // 5. a kite position is exited on kite at its target
    calls.length = 0;
    openTrades = [{ tsym: 'NIFTY01DEC26C25900', token: '47855', price: 250, quantity: 65, broker: 'kite', entryTime: new Date().toISOString() }];
    s = make('kite');
    await s.reconcile();
    await s.processOptionQuote(opt('47855', 260));
    assert(calls.find((c) => c.type === 'chunkedSquareOff')?.args[1].broker === 'kite', 'target exit sells on kite');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
