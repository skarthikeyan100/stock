/**
 * Breeze positions with a target/stop are monitored and squared off by exitMonitor (review R5-3), and survive a restart:
 * reconcileFromTrades no longer skips them.
 * Run: node ./dist/test/exitMonitorBreeze.test.js
 */
import { Trade, OptionQuote } from '../model/model';
import * as exitMonitor from '../processes/order/exitMonitor';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const quote = (token: string, ltp: number) => Object.assign(new OptionQuote(), { token, ltp, ltt: Date.now() });
function breezeTrade(token: string): Trade {
    return Object.assign(new Trade(), { tsym: 'NIFTY26N0322500CE', token, quantity: 130, price: 100, user: 'BreezeExitUser', broker: 'breeze', targetPrice: 110, stopLossPrice: 90 });
}

async function main() {
    const exits: Array<{ broker: string; qty: number }> = [];
    exitMonitor.onExit('breeze', async (t) => { exits.push({ broker: 'breeze', qty: t.quantity }); });
    exitMonitor.onExit('kite', async (t) => { exits.push({ broker: 'kite', qty: t.quantity }); });

    const t1 = breezeTrade('breeze-tok-1');
    exitMonitor.registerTrade(t1, 'NFO', 'breeze');
    await exitMonitor.handleOptionTick(quote('breeze-tok-1', 95));
    assert(exits.length === 0, 'no exit between stop and target');
    await exitMonitor.handleOptionTick(quote('breeze-tok-1', 89));
    assert(exits.length === 1 && exits[0].broker === 'breeze' && exits[0].qty === 130, 'a Breeze stop hit squares off through the breeze handler for the full quantity');

    // Restart recovery: a restored Breeze trade with a target/stop goes back on the watch list as breeze, not kite.
    const t2 = breezeTrade('breeze-tok-2');
    exitMonitor.reconcileFromTrades([t2]);
    await exitMonitor.handleOptionTick(quote('breeze-tok-2', 111));
    assert(exits.length === 2 && exits[1].broker === 'breeze', 'a restored Breeze trade is monitored again and exits via breeze (never kite)');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
