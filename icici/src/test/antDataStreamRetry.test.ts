/**
 * AntDataStream: a failed INITIAL connect must retry with bounded backoff (it used to be logged as "will retry" and never retried),
 * a login-needed failure must back off slowly, and a manual reconnect must join an in-flight attempt instead of duplicating it.
 * Run: npx tsc, then node ./dist/test/antDataStreamRetry.test.js
 */
import AntDataStream from '../processes/data/AntDataStream';
import AntSession from '../ant/AntSession';
import { nextReconnectDelayMs, isAuthError, RECONNECT_MAX_MS, RECONNECT_AUTH_MIN_MS, RECONNECT_AUTH_MAX_MS } from '../processes/data/connectRetry';

function assert(c: boolean, m: string) {
    console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`);
    if (!c) process.exitCode = 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const http = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

async function main() {
    // pure policy
    assert(nextReconnectDelayMs(2000, http(500)) === 4000, '500 doubles the delay');
    assert(nextReconnectDelayMs(50_000, http(502)) === RECONNECT_MAX_MS, 'delay is capped');
    assert(isAuthError(http(401)) && isAuthError(new Error('ANT userSession not available. Complete OAuth login first')), '401 / no session are auth errors');
    assert(!isAuthError(http(500)), '500 is not an auth error');
    assert(nextReconnectDelayMs(2000, http(401)) === RECONNECT_AUTH_MIN_MS, 'auth failure jumps to the slow floor');
    assert(nextReconnectDelayMs(200_000, http(401)) === RECONNECT_AUTH_MAX_MS, 'auth delay is capped');

    // initial connect failure keeps retrying
    const stream = AntDataStream.getInstance(() => {});
    const session = AntSession.getInstance();
    let attempts = 0;
    (session as any).getSessionId = async () => 's';
    (session as any).prepareWsSession = async () => { attempts++; throw http(500); };
    (stream as any).reconnectDelayMs = 5;
    let rejected = false;
    await stream.connectWithRetry().catch(() => { rejected = true; });
    assert(rejected && attempts === 1, 'initial failure is reported to the caller after one attempt');
    await sleep(150); // 5 + 10 + 20 + 40 ms retries
    assert(attempts >= 4, `retries happen on their own (attempts=${attempts})`);

    // a manual reconnect clears the pending timer and does not run two connects at once
    let inFlight = 0, maxInFlight = 0;
    (session as any).prepareWsSession = async () => { attempts++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(30); inFlight--; throw http(500); };
    (stream as any).reconnectDelayMs = 5;
    const before = attempts;
    await Promise.all([stream.reconnect().catch(() => {}), stream.reconnect().catch(() => {})]);
    assert(maxInFlight === 1, `never two connects in flight (max=${maxInFlight})`);
    assert(attempts - before >= 1, 'manual reconnect did attempt');
    stream.disconnect();
    await sleep(100);
    const afterStop = attempts;
    await sleep(100);
    assert(attempts === afterStop, 'disconnect() stops the retries');

    // login-needed failure backs off slowly (no hammering)
    (session as any).prepareWsSession = async () => { attempts++; throw http(401); };
    (stream as any).reconnectDelayMs = 1000;
    const b2 = attempts;
    await stream.connectWithRetry().catch(() => {});
    assert((stream as any).reconnectDelayMs >= RECONNECT_AUTH_MIN_MS, 'after a 401 the next delay is the slow floor');
    await sleep(100);
    assert(attempts - b2 === 1, 'only one attempt right after a 401');
    stream.disconnect();
}
main().then(() => process.exit(process.exitCode ?? 0));
