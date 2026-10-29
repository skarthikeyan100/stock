/**
 * The data socket (review R1-2): ticks fan out to every client, subscriptions are reference-counted across owners and clients, a client's
 * holds are released when it disconnects, and a client replays what it holds when `data` comes back - so no resync step is needed.
 * Run: node ./dist/test/dataLink.test.js
 */
import { DataServer } from '../processes/data/DataServer';
import { DataLink } from '../ipc/DataLink';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 6000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return true; await sleep(25); }
    return cond();
}

const PATH = `/tmp/dataLink-test-${process.pid}.sock`;
function makeServer() {
    const calls: string[] = [];
    const others: any[] = [];
    const server = new DataServer({
        subscribe: (kind, token, source, exchange) => { calls.push(`${kind === 'subscribe' ? 'sub' : 'subDepth'}:${source}:${token}:${exchange}`); },
        unsubscribe: (kind, token, source, exchange) => { calls.push(`${kind === 'subscribe' ? 'unsub' : 'unsubDepth'}:${source}:${token}:${exchange}`); },
        other: (cmd) => { others.push(cmd); },
    }, PATH);
    server.start();
    return { server, calls, others };
}

async function main() {
    let { server, calls, others } = makeServer();
    const A = new DataLink(PATH);
    const B = new DataLink(PATH);
    const ticksA: any[] = [];
    const ticksB: any[] = [];
    const statusA: boolean[] = [];
    A.onTick((t) => ticksA.push(t)); B.onTick((t) => ticksB.push(t));
    A.onStatus((up) => statusA.push(up));
    A.connect(); B.connect();
    assert(await until(() => A.isUp() && B.isUp() && server.clientCount() === 2), 'both clients connect');

    // ticks fan out
    server.broadcast({ type: 'option', quote: { token: '1', ltp: 100 } });
    assert(await until(() => ticksA.length === 1 && ticksB.length === 1), 'a tick reaches every connected client');

    // refcount across owners inside one link
    A.subscribe('strategies', { cmd: 'subscribe', token: '1', source: 'ant' });
    A.subscribe('exit', { cmd: 'subscribe', token: '1', source: 'ant', exchange: 'NFO' }); // same token, exchange spelled out
    assert(await until(() => calls.length === 1) && calls[0] === 'sub:ant:1:undefined', 'one subscribe reaches data for a token two owners hold');
    A.subscribe('strategies', { cmd: 'unsubscribe', token: '1', source: 'ant' });
    await sleep(100);
    assert(calls.length === 1, 'one owner letting go does not unsubscribe while the other still holds it');

    // refcount across clients
    B.subscribe('frontend', { cmd: 'subscribe', token: '1', source: 'ant' });
    await sleep(100);
    assert(calls.length === 1, 'a second client taking the same token does not subscribe it again');
    A.subscribe('exit', { cmd: 'unsubscribe', token: '1', source: 'ant', exchange: 'NFO' });
    await sleep(100);
    assert(calls.length === 1, 'the first client letting go does not unsubscribe while the other client holds it');
    B.subscribe('frontend', { cmd: 'unsubscribe', token: '1', source: 'ant' });
    assert(await until(() => calls.length === 2) && calls[1].startsWith('unsub:ant:1'), 'the last holder letting go unsubscribes');

    // depth is its own subscription
    A.subscribe('strategies', { cmd: 'subscribeDepth', token: '2', source: 'ant' });
    assert(await until(() => calls.includes('subDepth:ant:2:undefined')), 'depth subscriptions are separate from plain ones');
    A.subscribe('strategies', { cmd: 'unsubscribeDepth', token: '2', source: 'ant' });
    assert(await until(() => calls.includes('unsubDepth:ant:2:undefined')), 'and are released separately');

    // one-shot commands
    A.send({ cmd: 'reconnect', source: 'breeze' });
    assert(await until(() => others.length === 1 && others[0].source === 'breeze'), 'a one-shot command reaches data');

    // disconnect releases holds
    const C = new DataLink(PATH);
    C.connect();
    await until(() => C.isUp());
    C.subscribe('x', { cmd: 'subscribe', token: '3', source: 'breeze' });
    assert(await until(() => calls.includes('sub:breeze:3:undefined')), 'a third client subscribes a token');
    (C as any).socket.destroy();
    assert(await until(() => calls.includes('unsub:breeze:3:undefined')), 'its holds are released when its connection closes');

    // data goes away and comes back: the client replays what it holds
    A.subscribe('strategies', { cmd: 'subscribe', token: '9', source: 'ant', exchange: 'BFO' });
    await until(() => calls.includes('sub:ant:9:BFO'));
    server.stop();
    assert(await until(() => statusA.includes(false)), 'the client is told when data goes away (feed-down alert)');
    A.send({ cmd: 'reconnect' }); // while down: dropped, must not throw
    const second = makeServer();
    assert(await until(() => second.calls.includes('sub:ant:9:BFO'), 9000), 'a restarted data process gets the held subscription replayed (BFO exchange kept)');
    assert(statusA[statusA.length - 1] === true, 'and the client reports the feed up again');

    second.server.stop();
    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
