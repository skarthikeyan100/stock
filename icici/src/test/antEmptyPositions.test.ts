/**
 * ANT answers a flat account's positions call with a non-Ok envelope, EC920 "Error: No positions found for this user." (live 2026-11-26 07:49:57).
 * Strict reads treated it as a failure: a valid flat session read as invalid (the pending-order poller then never polls, brokerSessions says
 * false) and the sync reported ANT as not readable. Only the exact status + message pairs are an empty book; every other reply stays a failure.
 * Run: npx tsc, then: node ./dist/test/antEmptyPositions.test.js
 */
import ANT, { antAxiosInstance } from '../ant/ANT';
import bookkeeping from '../processes/order/bookkeeping';
import Log from '../util/Log';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const FLAT = { status: 'EC920', message: 'Error: No positions found for this user.', result: null as any };
const NO_TRADES = { status: 'EC926', message: 'No trades found for this user.', result: null as any };

let reply: any = FLAT;
let httpError: any = null;
(antAxiosInstance as any).get = async () => { if (httpError) throw httpError; return { data: reply }; };

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const o = Log.log; (Log as any).log = () => {};
    try { return await fn(); } finally { (Log as any).log = o; }
}
async function outcome(fn: () => Promise<any>): Promise<{ value?: any; error?: string }> {
    try { return { value: await quiet(fn) }; } catch (e: any) { return { error: String(e?.message ?? e) }; }
}

(async () => {
    const ant: any = ANT.getInstance();
    ant.userSession = 'test-session';
    const fresh = () => { httpError = null; ant.sessionValidity.invalidate(); };
    const failing: [string, any][] = [
        ['an EC920 with another message', { status: 'EC920', message: 'Error: Session expired.', result: null }],
        ['"No positions found" under an unknown code', { status: 'EC999', message: 'No positions found for this user.', result: null }],
        ['EC915 (order book not retrievable)', { status: 'EC915', message: 'Error: Failed to retrieve the order book.', result: null }],
        ['an invalid-session envelope', { status: 'Not_Ok', message: 'Invalid session', result: null }],
        ['an empty body', ''],
        ['Ok with no result', { status: 'Ok' }],
    ];

    console.log('positions: the flat account');
    for (const [label, data] of [['EC920', FLAT], ['EC926', { ...FLAT, status: 'EC926' }], ['Ok with an empty list', { status: 'Ok', result: [] }]] as [string, any][]) {
        fresh(); reply = data;
        const r = await outcome(() => ant.getPositions({ strict: true }));
        assert(Array.isArray(r.value) && r.value.length === 0, `${label}: strict read is an empty book (${r.error ?? 'ok'})`);
        assert(await quiet(() => ant.hasValidSession()) === true, `${label}: the session reads as valid`);
    }

    console.log('positions: a real book');
    fresh(); reply = { status: 'Ok', result: [{ tradingSymbol: 'NIFTY01DEC26C25750', netQuantity: 65 }] };
    assert((await outcome(() => ant.getPositions({ strict: true }))).value?.length === 1, 'rows are returned');

    console.log('positions: anything else still fails');
    for (const [label, data] of failing) {
        fresh(); reply = data;
        const r = await outcome(() => ant.getPositions({ strict: true }));
        assert(!!r.error && /Failed to fetch positions/.test(r.error), `${label}: strict read throws`);
        assert(await quiet(() => ant.hasValidSession()) === false, `${label}: the session reads as invalid`);
    }
    fresh(); httpError = Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } });
    assert(!!(await outcome(() => ant.getPositions({ strict: true }))).error, 'HTTP 401 throws');
    assert(await quiet(() => ant.hasValidSession()) === false, 'HTTP 401: invalid session');
    fresh(); ant.userSession = null;
    assert(!!(await outcome(() => ant.getPositions({ strict: true }))).error && await ant.hasValidSession() === false, 'no session token: fails');
    ant.userSession = 'test-session';

    console.log('the sync / external-close reader (bookkeeping.readBrokerRows)');
    fresh(); reply = FLAT;
    const rows = await quiet(() => (bookkeeping as any).readBrokerRows('ant'));
    assert(Array.isArray(rows) && rows.length === 0, 'flat ANT account: readable, no rows');
    reply = failing[3][1];
    assert(await quiet(() => (bookkeeping as any).readBrokerRows('ant')) === null, 'invalid session: not readable (null), never "flat"');

    console.log('the never-short read (antExecutor.getLiveNetQuantity)');
    const { getLiveNetQuantity } = await import('../processes/order/antExecutor');
    reply = FLAT;
    assert((await outcome(() => getLiveNetQuantity('NIFTY01DEC26C25750'))).value === 0, 'flat account: 0 held');
    reply = failing[3][1];
    assert(!!(await outcome(() => getLiveNetQuantity('NIFTY01DEC26C25750'))).error, 'invalid session: throws');

    console.log('trade book (unchanged)');
    reply = NO_TRADES;
    assert((await outcome(() => ant.getTrades({ strict: true }))).value?.length === 0, 'EC926 No trades found: empty book');
    assert((await outcome(() => ant.getFilledFromTradeBook('1'))).value?.quantity === 0, 'EC926: nothing filled');
    reply = failing[3][1];
    assert(!!(await outcome(() => ant.getTrades({ strict: true }))).error, 'invalid session: strict trade read throws');
    assert(!!(await outcome(() => ant.getFilledFromTradeBook('1'))).error, 'invalid session: fill lookup throws');
    reply = FLAT;
    assert(!!(await outcome(() => ant.getTrades({ strict: true }))).error, 'a positions reply is not an empty trade book');

    console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
})();
