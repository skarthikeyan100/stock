/**
 * hasValidSession no longer costs a broker round trip per order (review R2-1): a positive answer is remembered briefly, per token.
 * Run: node ./dist/test/sessionValidityCache.test.js
 */
import { SessionValidityCache } from '../util/SessionValidityCache';
import Kite from '../kite/Kite';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const c = new SessionValidityCache(100);
    assert(!c.isValid('t1'), 'nothing is cached at first');
    c.markValid('t1');
    assert(c.isValid('t1'), 'a confirmed token is valid');
    assert(!c.isValid('t2'), 'a different token (new login / reload) misses the cache');
    assert(!c.isValid(null) && !c.isValid(undefined), 'no token is never valid');
    await sleep(130);
    assert(!c.isValid('t1'), 'the answer expires after the ttl');
    c.markValid('t1'); c.invalidate();
    assert(!c.isValid('t1'), 'invalidate() forgets it');

    // Kite: ten checks in a row cost one getProfile; a failure is not cached.
    const kite: any = Kite.getInstance();
    let profileCalls = 0;
    let failNext = false;
    kite.accessToken = 'tok-A';
    kite.kc = { getProfile: async () => { profileCalls++; if (failNext) throw new Error('TokenException'); return {}; } };
    for (let i = 0; i < 10; i++) assert(await kite.hasValidSession() === true, `check ${i + 1} says valid`);
    assert(profileCalls === 1, `ten order-time checks cost ${profileCalls} broker call(s)`);
    kite.accessToken = 'tok-B';
    await kite.hasValidSession();
    assert(profileCalls === 2, 'a new access token is re-validated at the broker');
    failNext = true;
    kite.sessionValidity.invalidate();
    assert(await kite.hasValidSession() === false, 'a failing profile call reads as invalid');
    failNext = false;
    assert(await kite.hasValidSession() === true && profileCalls === 4, 'and the failure was not cached (the next check goes to the broker again)');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
