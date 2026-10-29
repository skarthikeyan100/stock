/**
 * A restart with an open Hourly position keeps its stop and its EOD flatten (review R5-7): the cycle's invalidation level / direction are
 * restored, and a restored position flagged 'error' (reconcile cannot confirm its resting exit survived) is still closed by both.
 * Run: node ./dist/test/hourlyRestore.test.js
 */
import HourlyStrategy from '../strategy/HourlyStrategy';
import OrderClient from '../processes/strategies/OrderClient';
import { localDayKey } from '../strategy/dayKey';
import { CALL } from '../constants';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

async function main() {
    const s = new HourlyStrategy('Hourly') as any;
    s.loadState = async () => ({
        userId: 'Hourly',
        positions: { kite: { broker: 'kite', phase: 'selling', heldTsym: 'NIFTY26N0322500CE', heldToken: 't', entryAvg: 100, targetQuantity: 65, soldQty: 0, soldValue: 0 } },
        activeInvalidationLevel: 22400, activeDirection: CALL, activeDay: localDayKey(),
    });
    (OrderClient.getInstance() as any).getOpenTrades = async () => [{ tsym: 'NIFTY26N0322500CE', broker: 'kite', quantity: 65 }];
    s.persistState = () => {};
    await s.reconcile(1, 0);

    const pos = s.positions.get('kite');
    assert(pos.phase === 'error', 'a restored selling position is flagged error (resting exit unconfirmed)');
    assert(s.activeInvalidationLevel === 22400 && s.activeDirection === CALL, 'the invalidation level and direction are restored');

    const closes: string[] = [];
    s.invalidateClose = async (p: any) => { closes.push(p.broker + ':' + p.phase); };
    s.checkInvalidation(22500);
    assert(closes.length === 0, 'no close while NIFTY stays above the invalidation level');
    s.checkInvalidation(22399);
    assert(closes.length === 1 && closes[0] === 'kite:selling', 'the stop closes the restored (error-flagged) position');

    pos.phase = 'error'; pos.lastCloseAttemptAt = undefined;
    s.cfg = () => ({ eodCloseTime: '00:00' });
    s.checkEod();
    assert(closes.length === 2, 'the EOD flatten also closes the restored position');

    pos.phase = 'error'; pos.heldTsym = undefined; pos.lastCloseAttemptAt = undefined;
    s.checkEod();
    assert(closes.length === 2, 'an error position with no known contract (entry in flight) is not blindly closed');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
