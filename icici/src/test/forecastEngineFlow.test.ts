/**
 * The forecast engine end to end on an in-memory Mongo: submit rules, the write-once record, both filters with their logged inputs, the master
 * order switch, arming a slot in a TEMP config, scoring (incl. VOID) and the contractor routes. Run: npx tsc, then node ./dist/test/forecastEngineFlow.test.js
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const signature = require('cookie-signature');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-'));
fs.copyFileSync(path.resolve(__dirname, '..', '..', 'config.yml'), path.join(tmp, 'config.yml'));
process.env.CONFIG_PATH = path.join(tmp, 'config.yml');
process.env.KYC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
for (const k of ['GMAIL_USER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) delete process.env[k];
const SECRET = 'test-secret';

import { installFakeDb } from './fakeDb';
import configService from '../prism/ConfigService';
import { ForecastEngine } from '../forecast/engine';
import { forecastsCol, scoreOpenForecast, accuracyOf } from '../forecast/store';
import { contractorsCol } from '../contractors/store';
import { sessionCookieValue } from '../routes/session';
import forecastRoutes from '../routes/forecast';
import { contractorGuard } from '../contractors/guard';

let failed = 0;
function assert(condition: boolean, message: string) { console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`); if (!condition) { failed++; process.exitCode = 1; } }
const cookieFor = (value: string) => `session=${encodeURIComponent('s:' + signature.sign(value, SECRET))}`;
const setCfg = (mut: (t: string) => string) => { const f = path.join(tmp, 'config.yml'); fs.writeFileSync(f, mut(fs.readFileSync(f, 'utf8'))); configService.reloadNow(); };

async function main() {
    const db = installFakeDb();
    // A Monday at 10:30 IST.
    let nowMs = new Date('2026-11-16T10:30:00+05:30').getTime();
    const engine = ForecastEngine.getInstance();
    engine._testHooks(() => nowMs, true);
    const tickNifty = (ltp: number) => engine.onTick({ type: 'nifty', quote: { ltp } });
    const tickFut = (tbq: number, tsq: number) => engine.onTick({ type: 'fut', quote: { tbq, tsq } });
    // 12 one-minute candles rising, then now: the trend filter passes UP
    const start = nowMs;
    for (let m = 12; m >= 1; m--) { nowMs = start - m * 60_000; tickNifty(24000 + (12 - m) * 2); }
    nowMs = start; tickNifty(24030);
    tickFut(130000, 100000);

    const ind: any = { id: 'i1', email: 'ind@x.com', name: 'Ind', type: 'INDIVIDUAL', status: 'ACTIVE', agreementVersion: '1.1', pseudoUserId: '' };
    await contractorsCol().insertOne(ind);
    await db.collection('users').insertOne({ email: 'ind@x.com', role: 'contractor', enabled: true });
    await db.collection('users').insertOne({ email: 'boss@x.com', role: 'admin', enabled: true });

    console.log('submit:');
    let r: any = await engine.submit(ind, { direction: 'UP', confidence: 'High' });
    assert(r.ok && r.forecast.direction === 'UP' && r.forecast.windowEndsAt.getTime() === nowMs + 15 * 60_000, 'a forecast is recorded with a 15-minute window');
    await new Promise((res) => setTimeout(res, 20));
    const f1: any = (await forecastsCol().find({}).toArray())[0];
    assert(f1.refValueStart === 24030 && f1.windowMinutes === 15 && f1.neutralThresholdPoints === 5 && f1.outcome === 'OPEN' && f1.agreementVersion === '1.1' && f1.submittedAt.getTime() === nowMs, 'start value from the feed, config snapshots, server time');
    r = await engine.submit(ind, { direction: 'DOWN' });
    assert(!r.ok && /still open/.test(r.error), 'a second forecast while the window is open is refused');
    r = await engine.submit({ ...ind, status: 'PAUSED' }, { direction: 'UP' });
    assert(!r.ok && r.status === 403, 'a paused contractor cannot submit');
    r = await engine.submit({ ...ind, agreementVersion: '1.0' }, { direction: 'UP' });
    assert(!r.ok && r.status === 403 && /agreement/i.test(r.error), 'an old agreement version cannot submit');
    r = await engine.submit({ ...ind, type: 'BUSINESS' }, { direction: 'UP' });
    assert(!r.ok && r.status === 403, 'a Business contractor cannot forecast');
    r = await engine.submit(ind, { direction: 'SIDEWAYS' });
    assert(!r.ok && r.status === 400, 'direction must be Up or Down');
    r = await engine.submit(ind, { direction: 'UP', confidence: 'Huge' });
    assert(!r.ok && r.status === 400, 'confidence must be Low, Medium or High');

    console.log('decision log (both filters, with inputs):');
    const dec1: any = (await db.collection('decisions').find({ kind: 'forecast' }).toArray())[0];
    assert(dec1.accepted === true && dec1.filters.length === 2 && dec1.forecastId === f1.id, 'accepted, with both filter results');
    const ob = dec1.filters.find((x: any) => x.name === 'OrderBookImbalance'), tr = dec1.filters.find((x: any) => x.name === 'Trend1m');
    assert(ob.values.buyQty === 130000 && ob.values.sellQty === 100000 && ob.values.threshold === 1.2 && ob.values.snapshotTs === nowMs, 'order-book inputs are logged');
    assert(tr.pass && tr.values.candles >= 10 && typeof tr.values.ema === 'number', 'trend inputs are logged');
    assert(dec1.orderPlaced === false && /off/.test(dec1.orderNote), 'with forecast.orders.enabled false nothing is traded');
    assert(!JSON.stringify(r).includes('accepted'), 'the contractor is never told the decision');

    console.log('daily limit and hours:');
    nowMs = start + 16 * 60_000; tickNifty(24031); tickFut(130000, 100000);
    r = await engine.submit(ind, { direction: 'DOWN' });
    assert(r.ok, 'the second forecast is allowed once the first window closed');
    nowMs = start + 32 * 60_000; tickNifty(24032); tickFut(130000, 100000);
    r = await engine.submit(ind, { direction: 'UP' });
    assert(r.ok, 'the third is allowed');
    nowMs = start + 48 * 60_000; tickNifty(24033);
    r = await engine.submit(ind, { direction: 'UP' });
    assert(!r.ok && /all 3/.test(r.error), 'the fourth is over the daily limit');
    const lateSat = new Date('2026-11-14T10:30:00+05:30').getTime();
    nowMs = lateSat; tickNifty(24000);
    r = await engine.submit({ ...ind, id: 'i2' }, { direction: 'UP' });
    assert(!r.ok && /closed/.test(r.error), 'a Saturday is refused');
    nowMs = new Date('2026-11-16T15:30:00+05:30').getTime(); tickNifty(24000);
    r = await engine.submit({ ...ind, id: 'i3' }, { direction: 'UP' });
    assert(!r.ok && /accepted from/.test(r.error), 'after 15:00 is refused');
    nowMs = new Date('2026-11-17T11:00:00+05:30').getTime();
    r = await engine.submit({ ...ind, id: 'i4' }, { direction: 'UP' });
    assert(!r.ok && r.status === 503, 'no fresh NIFTY tick: refused (no stale reference value)');

    console.log('rejection by a filter, and the pass-through alarm:');
    nowMs = new Date('2026-11-17T11:00:00+05:30').getTime(); tickNifty(24000); tickFut(100000, 130000);
    r = await engine.submit({ ...ind, id: 'i5' }, { direction: 'UP' });
    await new Promise((res) => setTimeout(res, 20));
    const dec5: any = (await db.collection('decisions').find({ kind: 'forecast', contractorId: 'i5' }).toArray())[0];
    assert(r.ok && dec5.accepted === false && /OrderBookImbalance/.test(dec5.reason) && dec5.filters.length === 2, 'recorded, but rejected: depth favours sellers; both filters still logged');
    nowMs += 4000;
    r = await engine.submit({ ...ind, id: 'i6' }, { direction: 'UP' });
    await new Promise((res) => setTimeout(res, 20));
    const dec6: any = (await db.collection('decisions').find({ kind: 'forecast', contractorId: 'i6' }).toArray())[0];
    assert(dec6 && dec6.accepted === false && /snapshot is 4000 ms old/.test(dec6.reason), 'a depth snapshot older than 3 s rejects');

    console.log('orders (master switch) and slot arming:');
    setCfg((t) => t.replace('    enabled: false                 # MASTER switch', '    enabled: true                 # MASTER switch'));
    assert(engine.ordersEnabled(), 'the master switch reads from config');
    // the real option price needs ANT; the engine reports it as unavailable here and places nothing
    const t1130 = new Date('2026-11-17T11:30:00+05:30').getTime();
    for (let m = 12; m >= 1; m--) { nowMs = t1130 - m * 60_000; tickNifty(24000 + (12 - m) * 2); }
    nowMs = t1130; tickNifty(24030); tickFut(130000, 100000);
    r = await engine.submit({ ...ind, id: 'i7' }, { direction: 'UP' });
    await new Promise((res) => setTimeout(res, 50));
    const dec7: any = (await db.collection('decisions').find({ kind: 'forecast', contractorId: 'i7' }).toArray())[0];
    assert(dec7.accepted === true && dec7.orderPlaced === false && /slot|option price|risk check/.test(dec7.orderNote), 'accepted but not armed without a slot / live option price (fails closed): ' + dec7.orderNote);
    const armed = (configService.getConfig() as any).strategies.filter((s: any) => /^Forecast-S/.test(s.userId) && s.enabled);
    assert(armed.length === 0, 'no slot block was armed');

    console.log('scoring:');
    (db.collection('forecasts') as any).docs.length = 0; // the earlier forecasts of this test are not part of the scoring cases
    const seed = async (id: string, direction: 'UP' | 'DOWN', startVal: number, submittedAt: number, refTickTs = submittedAt) => forecastsCol().insertOne({ id, contractorId: 's1', direction, submittedAt: new Date(submittedAt), day: '2026-11-17', windowMinutes: 15, refValueStart: startVal, refTickTs, neutralThresholdPoints: 5, feeAmount: 0, agreementVersion: '1.1', outcome: 'OPEN' });
    const t0 = new Date('2026-11-17T09:30:00+05:30').getTime();
    const W = 15 * 60_000;
    await seed('c-up', 'UP', 24000, t0);
    await seed('i-up', 'UP', 24000, t0 + 20_000);
    await seed('n-up', 'UP', 24000, t0 + 40_000);
    await seed('v-gap', 'UP', 24000, t0 + 60_000);
    await seed('v-start', 'UP', 24000, t0 + 80_000, t0 + 80_000 - 9000);
    const put = (ts: number, ltp: number) => db.collection('niftyTicks').insertOne({ ts: new Date(ts), ltp });
    await put(t0 + W + 500, 24010);              // c-up: +10
    await put(t0 + 20_000 + W + 1000, 23990);    // i-up: -10
    await put(t0 + 40_000 + W - 200, 24003);     // n-up: +3
    await put(t0 + 80_000 + W, 24020);           // v-start: end tick exists, but the start reference was too old
    nowMs = t0 + W + 100_000;
    const early = await engine.scoreDue(new Date(t0 + W + 2000));
    assert(early === 0, 'a window that has just closed waits a few seconds for its end tick');
    await engine.scoreDue(new Date(t0 + W + 87_000)); // past every end time + 6 s, but v-gap is still inside its 30 s grace
    const by = async (id: string) => (await forecastsCol().findOne({ id })) as any;
    assert((await by('c-up')).outcome === 'CORRECT' && (await by('c-up')).refValueEnd === 24010, 'CORRECT: the index moved up by at least 5 points');
    assert((await by('i-up')).outcome === 'INCORRECT', 'INCORRECT: it moved the other way');
    assert((await by('n-up')).outcome === 'NEUTRAL', 'NEUTRAL: a 3-point move is below the threshold');
    assert((await by('v-start')).outcome === 'VOID', 'VOID: the start reference tick was more than 5 s from the submission');
    assert((await by('v-gap')).outcome === 'OPEN', 'no end tick yet: still OPEN (retried for 30 s)');
    await engine.scoreDue(new Date(t0 + 60_000 + W + 31_000));
    assert((await by('v-gap')).outcome === 'VOID' && (await db.collection('notifications').find({ type: 'feed_gap' }).toArray()).length >= 1, 'VOID with an owner alert when no tick exists within 5 s of the end');
    console.log('write-once:');
    assert(await scoreOpenForecast('c-up', 'INCORRECT', { value: 1 }) === false && (await by('c-up')).outcome === 'CORRECT', 'a scored forecast cannot be scored again');
    const before = JSON.stringify(await by('i-up'));
    await scoreOpenForecast('i-up', 'CORRECT', {});
    assert(JSON.stringify(await by('i-up')) === before, '...and nothing about it changes');
    assert(Object.keys(await import('../forecast/store')).filter((k) => /update|delete|remove|edit/i.test(k)).join() === '', 'the store exports no editor or deleter (only insert and the one score step)');
    const acc = accuracyOf([{ outcome: 'CORRECT' }, { outcome: 'INCORRECT' }, { outcome: 'NEUTRAL' }, { outcome: 'VOID' }, { outcome: 'CORRECT' }] as any);
    assert(acc.scored === 4 && acc.accuracyPct === 50 && acc.void === 1, 'accuracy counts CORRECT among scored; VOID is excluded');

    console.log('routes:');
    const app = express();
    app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.7', configurable: true }); next(); });
    app.use(bodyParser.json()); app.use(cookieParser(SECRET)); app.use(contractorGuard); app.use(forecastRoutes);
    const ck = cookieFor(sessionCookieValue('ind@x.com'));
    const t1030 = new Date('2026-11-18T10:30:00+05:30').getTime();
    for (let m = 12; m >= 1; m--) { nowMs = t1030 - m * 60_000; tickNifty(24100 + (12 - m)); }
    nowMs = t1030; tickNifty(24112); tickFut(130000, 100000);
    const realNow = Date.now;
    Date.now = () => nowMs; // the routes build "now" from the engine clock; guard/session code reads Date.now for cookie age
    let res = await request(app).post('/forecast').set('Cookie', ck).send({ direction: 'UP', confidence: 'Medium' });
    Date.now = realNow;
    assert(res.status === 200 && /Forecast recorded at 10:30\. Window closes at 10:45\./.test(res.body.message), 'POST /forecast answers with the recorded and closing times');
    assert(!/accepted|filter|order/i.test(JSON.stringify(res.body)), 'and nothing about filters or orders');
    res = await request(app).get('/forecast/history').set('Cookie', ck);
    assert(res.status === 200 && res.body.length >= 1 && res.body[0].direction !== undefined && !JSON.stringify(res.body).includes('decision'), 'history lists own forecasts, without decisions');
    res = await request(app).get('/forecast/accuracy').set('Cookie', ck);
    assert(res.status === 200 && 'd7' in res.body && 'd30' in res.body && 'all' in res.body, 'accuracy for 7 days, 30 days and all time');
    res = await request(app).get('/forecast/state').set('Cookie', ck);
    assert(res.status === 200 && res.body.dailyLimit === 3 && res.body.available === true, 'state for the Up/Down screen');
    res = await request(app).post('/forecast').send({ direction: 'UP' });
    assert(res.status === 401 || res.status === 403, 'no cookie: refused');

    console.log(failed ? `\n${failed} FAILED` : '\nALL TESTS PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
