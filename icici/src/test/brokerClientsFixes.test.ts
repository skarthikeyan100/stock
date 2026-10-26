/**
 * Focused regression tests for the broker-client review fixes.
 * Run: npx tsc && MOCK_BROKER=true node ./dist/test/brokerClientsFixes.test.js
 */
import Breeze from '../breeze/Breeze';
import { stopLimitPrice, roundToTick } from '../kite/Kite';
import { drawdownDecision } from '../prism/percentConfig';
import Prism from '../prism';
import AntContractMaster from '../ant/AntContractMaster';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    // percentConfig: zero investment base must not read as a breach
    assert(drawdownDecision(0, 0, 25) === 'unknown', 'drawdownDecision unknown when investment is 0');
    assert(drawdownDecision(-100, 1000, 5) === 'breached', 'drawdownDecision still breaches a real loss');

    // Kite GTT stop limit sits below the trigger on the tick grid
    const lim = stopLimitPrice(100);
    assert(lim < 100 && Math.abs(lim - roundToTick(lim)) < 1e-9, `stopLimitPrice(100) below trigger on tick grid (${lim})`);

    // Prism: a Not_Ok / empty reply is not an accepted order
    const prism = Prism.getInstance() as any;
    let threw = false;
    try { prism._assertOrderAccepted({ stat: 'Not_Ok', emsg: 'x' }, { tsym: 'T' }); } catch { threw = true; }
    assert(threw, 'Prism rejects stat Not_Ok');
    threw = false;
    try { prism._assertOrderAccepted(undefined, { tsym: 'T' }); } catch { threw = true; }
    assert(threw, 'Prism rejects an undefined reply');
    threw = false;
    try { prism._assertOrderAccepted({ stat: 'Ok', norenordno: '1' }, { tsym: 'T' }); } catch { threw = true; }
    assert(!threw, 'Prism accepts Ok + norenordno');

    // AntContractMaster: strike compared numerically
    const acm = AntContractMaster.getInstance() as any;
    acm.nfoCache = [{ Symbol: 'NIFTY', Exch: 'NFO', 'Strike Price': '24000.00', 'Option Type': 'CE', 'Expiry Date': '1000', Token: '9', 'Trading Symbol': 'X', 'Lot Size': '65' }];
    acm.cacheIsFresh = () => true;
    let found = false;
    try { found = acm.findOption({ symbol: 'NIFTY', exch: 'NFO', strike: '24000', optionType: 'CE', expiryEpochMs: 1000 }).token === '9'; } catch { /* */ }
    assert(found, 'findOption matches "24000.00" vs "24000"');

    // Breeze.getFillPrice: poll error does not skip timeout cancel; partial-then-cancel is not a full fill
    const breeze = Breeze.getInstance() as any;
    let cancelled = 0;
    breeze.cancelOrder = async () => { cancelled++; };
    breeze.getOrderDetail = async () => { throw new Error('net down'); };
    let msg = '';
    try { await breeze.getFillPrice('NFO', '1', 2, 1, true); } catch (e: any) { msg = e.message; }
    assert(cancelled === 1 && /did not fill/.test(msg), 'poll errors still reach the timeout cancel');

    breeze.getOrderDetail = async () => ({ Success: [{ average_price: '50', pending_quantity: '0', cancelled_quantity: '30', quantity: '65', status: 'Cancelled' }] });
    msg = '';
    try { await breeze.getFillPrice('NFO', '1', 2, 1, true); } catch (e: any) { msg = e.message; }
    assert(/partially filled/.test(msg), 'partial fill then cancel is reported as partial, not full');

    breeze.getOrderDetail = async () => ({ Success: [{ average_price: '50', pending_quantity: '0', cancelled_quantity: '0', quantity: '65', status: 'Executed' }] });
    assert((await breeze.getFillPrice('NFO', '1', 2, 1, true)) === 50, 'full fill returns the price');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
