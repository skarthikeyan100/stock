/**
 * Option tick history: buffer/flush, backpressure drop, Mongo failure isolation, broker-name normalization, TTL index + startup purge,
 * storeTicks=false, index/future ticks write nothing, unresolved tokens logged. No Mongo, no network.
 * Run: npx tsc, then node ./dist/test/tickStore.test.js
 */
import { TickStore, TickStoreDeps, CollectionLike, MAX_BUFFER, TTL_SECONDS, fromAntTick, fromBreezeTick, Resolution } from '../processes/data/TickStore';
import { keyFromTsym, istDay } from '../util/tickKey';

function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) process.exitCode = 1; }

const optMeta = { tsym: 'NIFTY01DEC26P25750', u: 'NIFTY', exp: '2026-12-01', k: 25750, ot: 'PE' as const, key: 'NIFTY|2026-12-01|25750|PE' };
function fake(over: Partial<TickStoreDeps> = {}, col?: Partial<CollectionLike>) {
    const inserted: any[] = []; const indexes: any[] = []; const deletes: any[] = []; const logs: string[] = [];
    const collection: CollectionLike = {
        insertMany: async (d) => { inserted.push(...d); return {}; },
        createIndex: async (s, o) => { indexes.push([s, o]); },
        deleteMany: async (f) => { deletes.push(f); return { deletedCount: 3 }; },
        ...col,
    };
    const state = { now: Date.parse('2026-11-25T10:00:00+05:30'), enabled: true };
    const deps: TickStoreDeps = {
        getCollection: async () => collection,
        resolve: async (_s, _e, tk): Promise<Resolution> => (tk === '45407' ? { kind: 'option', meta: optMeta } : tk === '26000' || tk === 'FUT' ? { kind: 'skip' } : { kind: 'unknown' }),
        enabled: () => state.enabled, now: () => state.now, log: (m) => logs.push(m), ...over,
    };
    return { store: new TickStore(deps), inserted, indexes, deletes, logs, state };
}
const ant = (tk: string, extra: any = {}) => fromAntTick({ tk, lp: '66.4', v: '100', ap: '117.2', bp1: '66.4', sp1: '66.45', bq1: '195', sq1: '65', ft: '1764046200', ...extra }, 'NFO', Date.parse('2026-11-25T10:00:00+05:30'));

async function main() {
    console.log('normalization of the four brokers');
    const keys = ['NIFTY01DEC26P25750', 'NIFTY26D0125750PE', 'NIFTY01DEC2625750PE'].map((n) => keyFromTsym(n));
    assert(keys.every((k) => k === 'NIFTY|2026-12-01|25750|PE'), `ANT/Prism, Kite, Breeze names -> one key (${keys.join(' ; ')})`);
    assert(keyFromTsym('NIFTY25750PE') === undefined, 'expiry-less spelling without a master lookup is not guessed');
    assert(keyFromTsym('NIFTY25750PE', () => ({ symbol: 'NIFTY', expiryMs: Date.UTC(2026, 11, 1), strike: 25750, optionType: 'PE' })) === 'NIFTY|2026-12-01|25750|PE', 'expiry-less spelling resolved by the master');
    assert(istDay(Date.parse('2026-11-25T23:59:59+05:30')) === '2026-11-25' && istDay(Date.parse('2026-11-26T00:00:01+05:30')) === '2026-11-26', 'IST day boundary');
    assert(istDay(Date.parse('2026-11-25T18:29:59Z')) === '2026-11-25' && istDay(Date.parse('2026-11-25T18:30:00Z')) === '2026-11-26', 'IST day boundary from UTC instants');

    console.log('flush');
    let f = fake();
    f.store.record(ant('45407')); f.store.record(ant('45407', { lp: '67' }));
    assert(f.store.pending() === 2, 'buffered, nothing written on the tick path');
    assert(f.inserted.length === 0, 'no insert yet');
    await f.store.flush();
    assert(f.inserted.length === 2 && f.store.pending() === 0, 'flush writes the batch');
    const d = f.inserted[0];
    assert(d.key === 'NIFTY|2026-12-01|25750|PE' && d.day === '2026-11-25' && d.at instanceof Date && d.t === Date.parse('2026-11-25T10:00:00+05:30') && d.src === 'ant' && d.exch === 'NFO' && d.tk === '45407' && d.ltp === 66.4 && d.v === 100 && d.ap === 117.2 && d.bp === 66.4 && d.sp === 66.45 && d.bq === 195 && d.sq === 65 && d.ft === '1764046200' && d.tsym === 'NIFTY01DEC26P25750', 'document shape');
    const b = fromBreezeTick({ symbol: '4.1!64473', last: 65.75, bPrice: 65.5, sPrice: 65.65, bQty: 975, sQty: 325, avgPrice: 117.16, ttq: 194736165, ltt: 'Mon Nov 23 2026 12:25:35' }, '64473', 'NFO', 1);
    assert(b!.src === 'breeze' && b!.ltp === 65.75 && b!.bp === 65.5 && b!.v === 194736165 && b!.ap === 117.16, 'breeze tick parsed');

    console.log('only option ticks');
    f = fake();
    f.store.record(ant('26000')); f.store.record(ant('FUT')); // index and future tokens resolve to skip
    f.store.record(fromAntTick({ tk: '45407', tbq: '10', tsq: '20' }, 'NFO', 1)); // depth-only, no price, no bid/ask
    assert(f.store.pending() === 2, 'a depth-only update with no price/bid/ask is not queued');
    await f.store.flush();
    assert(f.inserted.length === 0, 'index and future ticks write nothing');
    f.store.record(ant('99999'));
    await f.store.flush();
    assert(f.inserted.length === 0 && f.logs.some((l) => /not in the contract master.*99999/.test(l)), 'unresolved option token: not stored, logged with a count');
    f.store.record(ant('99999')); await f.store.flush();
    assert(f.logs.filter((l) => /not in the contract master/.test(l)).length === 1, 'unresolved log is at most once a minute');

    console.log('backpressure');
    f = fake();
    for (let i = 0; i < MAX_BUFFER + 50; i++) f.store.record(ant('45407'));
    assert(f.store.pending() === MAX_BUFFER && f.store.stats.dropped === 50, 'buffer bounded, drops counted');
    f.store.record(ant('45407'));
    assert(f.logs.filter((l) => /buffer full/.test(l)).length === 1, 'one log line per minute while dropping');

    console.log('Mongo failure');
    let fail = true;
    f = fake({}, { insertMany: async (docs) => { if (fail) throw new Error('connection refused'); f.inserted.push(...docs); return {}; } });
    f.store.record(ant('45407'));
    let threw = false;
    try { await f.store.flush(); } catch (e) { threw = true; }
    assert(!threw && f.store.stats.flushFailures === 1, 'flush failure is caught');
    assert(f.store.pending() === 1 && f.logs.some((l) => /write failed/.test(l)), 'batch kept for retry, failure logged');
    fail = false; await f.store.flush();
    assert(f.inserted.length === 1, 'written once Mongo is back');
    const nodb = fake({ getCollection: async () => { throw new Error('no db'); } });
    nodb.store.record(ant('45407'));
    let t2 = false; try { nodb.store.record(ant('45407')); await nodb.store.flush(); await nodb.store.prepare(); } catch (e) { t2 = true; }
    assert(!t2, 'no Mongo connection: nothing thrown');
    const thrower = fake({ enabled: () => { throw new Error('config broke'); } });
    let t3 = false; try { thrower.store.record(ant('45407')); } catch (e) { t3 = true; }
    assert(!t3, 'record() never throws into the tick handler');

    console.log('TTL index and purge');
    f = fake();
    assert(await f.store.prepare(), 'prepare ok');
    const ttl = f.indexes.find((i) => i[1]?.expireAfterSeconds);
    assert(ttl && ttl[0].at === 1 && ttl[1].expireAfterSeconds === 36 * 3600 && TTL_SECONDS === 129600, 'TTL index on at, 36 h');
    await f.store.prepare(); assert(f.indexes.length === 2, 'prepare is idempotent (done once)');
    assert(f.deletes.length === 1 && JSON.stringify(f.deletes[0]) === JSON.stringify({ day: { $lt: '2026-11-25' } }), 'purge deletes only days before today (IST), so a same-day restart keeps today');
    f.state.now = Date.parse('2026-11-26T00:30:00+05:30');
    const g = fake(); g.state.now = f.state.now; await g.store.prepare();
    assert(g.deletes[0].day.$lt === '2026-11-26', 'next IST morning purges yesterday');
    let calls = 0; const late = fake({ getCollection: async () => { calls++; if (calls === 1) throw new Error('down'); return f.store ? { insertMany: async () => ({}), createIndex: async () => ({}), deleteMany: async () => ({ deletedCount: 0 }) } : null; } });
    assert(!(await late.store.prepare()), 'prepare failure (Mongo down at start) is not fatal');
    late.state.now += 31_000;
    assert(await late.store.prepare(), 'prepare is retried later');

    console.log('storeTicks=false');
    f = fake(); f.state.enabled = false;
    f.store.record(ant('45407')); f.store.record(ant('45407'));
    assert(f.store.pending() === 0, 'nothing buffered');
    await f.store.flush(); assert(f.inserted.length === 0, 'nothing written');
    f.state.enabled = true; f.store.record(ant('45407')); f.state.enabled = false;
    await (f.store as any).tick();
    assert(f.inserted.length === 0 && f.store.pending() === 0, 'turning it off drops what is buffered');
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
