/**
 * markPrice: tick price first (no network), a live ANT quote only when no tick exists (cached, spaced, 429 back-off), then the stored price / cost.
 * Run: npx tsc, then: node ./dist/test/markPrice.test.js
 */
import { markPrice, recordTick, tickPrice, __setLiveFetch, __reset, LIVE_BACKOFF_MS } from '../processes/strategies/markPrice';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const row = (token: string, o: any = {}) => ({ user: 'U', tsym: `NIFTY${token}CE`, token, price: 100, ...o });

(async () => {
    let liveCalls = 0;
    let liveImpl: () => Promise<number> = async () => 130;
    __setLiveFetch(async () => { liveCalls++; return liveImpl(); });

    console.log('tick first');
    __reset(); liveCalls = 0;
    recordTick('ant', '1', 123);
    assert(await markPrice(row('1', { lastTradePrice: 90 })) === 123 && liveCalls === 0, 'a tick is used and no live call is made');
    recordTick('ant', '1', 0); recordTick('ant', '1', NaN);
    assert(tickPrice('1') === 123, 'a zero / NaN tick is ignored');
    recordTick('ant', '1', 124);
    assert(await markPrice(row('1')) === 124, 'the newest tick wins');
    assert(tickPrice('1', Date.now() + 6 * 60_000) === 0, 'a tick older than 5 minutes is not used');

    console.log('no tick: one live call, then cached');
    __reset(); liveCalls = 0;
    assert(await markPrice(row('2')) === 130 && liveCalls === 1, 'a live quote is fetched');
    assert(await markPrice(row('2')) === 130 && liveCalls === 1, 'the next read within 30 s uses the cache');

    console.log('live failure and 429');
    __reset(); liveCalls = 0;
    liveImpl = async () => { throw new Error('boom'); };
    assert(await markPrice(row('3', { lastTradePrice: 111 })) === 111, 'a failed live call falls back to the stored price');
    assert(await markPrice(row('3b', { price: 100 })) === 100, 'with no stored price either: the cost');
    __reset(); liveCalls = 0;
    liveImpl = async () => { throw new Error('Request failed with status code 429'); };
    await markPrice(row('4')); const after429 = liveCalls;
    await markPrice(row('5')); await markPrice(row('6'));
    assert(after429 === 1 && liveCalls === 1, `after a 429 no further live call is made for ${LIVE_BACKOFF_MS / 1000}s`);

    console.log('calls are spaced');
    __reset(); liveCalls = 0; liveImpl = async () => 130;
    const t0 = Date.now();
    await Promise.all([markPrice(row('7')), markPrice(row('8')), markPrice(row('9'))]);
    assert(liveCalls === 3 && Date.now() - t0 >= 2 * 1200 - 50, 'three concurrent live reads are made one after another, 1.2 s apart');
    process.exit(process.exitCode ?? 0);
})();
