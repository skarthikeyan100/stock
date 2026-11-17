/**
 * A user on several brokers (admin only): getUserBrokers, and the lot limit / capital sizing counted PER BROKER so one broker's
 * leg is neither blocked by nor sized against what the other brokers hold. A single-broker user keeps the user-wide count.
 * Run: npx tsc && node ./dist/test/multiBrokerUser.test.js
 */
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }

function open(user: string, broker: 'kite' | 'ant' | 'breeze', qty: number, price: number) {
    const t = new Trade();
    t.tsym = 'NIFTY26NOV24000CE'; t.token = 'tokM'; t.quantity = qty; t.price = price; t.action = 'Buy'; t.status = 'COMPLETE'; t.user = user; t.broker = broker;
    bookkeeping.trades.push(t);
}

(async () => {
    const multi = 'MultiBrokerTestUser', single = 'SingleBrokerTestUser';
    bookkeeping.updateUserSettings(multi, { lossLimit: 100000, lotLimit: 1, investmentMode: 'lotCount', broker: 'kite', brokers: ['kite', 'ant'] });
    bookkeeping.updateUserSettings(single, { lossLimit: 100000, lotLimit: 1, investmentMode: 'lotCount', broker: 'kite' });
    assert(JSON.stringify(bookkeeping.getUserBrokers(multi)) === '["kite","ant"]', 'brokers list is returned as configured');
    assert(JSON.stringify(bookkeeping.getUserBrokers(single)) === '["kite"]', 'no list -> just the one broker');

    open(multi, 'kite', 65, 100);   // one lot open on kite: at the lot limit of 1 for kite
    open(single, 'kite', 65, 100);
    assert((await bookkeeping.canPlaceOrder(multi, undefined, 'kite')).allowed === false, 'kite leg is at its own lot limit');
    assert((await bookkeeping.canPlaceOrder(multi, undefined, 'ant')).allowed === true, 'ant leg is not blocked by the kite position');
    assert((await bookkeeping.canPlaceOrder(single, undefined, 'ant')).allowed === false, 'single-broker user: the limit stays user-wide');

    // sizing: investmentAmount mode, capital 1,00,000, kite already holds 65 x 100 = 6,500
    bookkeeping.updateUserSettings(multi, { lossLimit: 100000, investmentMode: 'investmentAmount', accountCapital: 100000, broker: 'kite', brokers: ['kite', 'ant'] });
    const onKite = bookkeeping.resolveManualBuyQuantity(multi, 'NIFTY26NOV24000CE', 100, undefined, 65, 1, undefined, false, 'kite');
    const onAnt = bookkeeping.resolveManualBuyQuantity(multi, 'NIFTY26NOV24000CE', 100, undefined, 65, 1, undefined, false, 'ant');
    assert(onKite === 14 * 65, `kite is sized net of its own 6,500 position: ${onKite} (14 lots)`);
    assert(onAnt === 15 * 65, `ant is sized against its own empty book: ${onAnt} (15 lots)`);

    if (!failed) console.log('ALL PASS');
    process.exit(process.exitCode ?? 0);
})();
