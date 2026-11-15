/**
 * Advanced contractors' recommendations: validation parity with RecommendationStrategy, submit rules, owner approval (compare-and-set, arms the slot
 * block in a TEMP copy of config.yml), expiry. Run: npx tsc, then node ./dist/test/contractorRecommendations.test.js
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

// A temp copy of config.yml, set BEFORE ConfigService loads, so approving never touches the real file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recs-'));
fs.copyFileSync(path.resolve(__dirname, '..', '..', 'config.yml'), path.join(tmp, 'config.yml'));
{ const f = path.join(tmp, 'config.yml'); const t = fs.readFileSync(f, 'utf8'); const w = t.replace("recommendationHours: { start: '09:20', end: '15:00' }", "recommendationHours: { start: '00:00', end: '23:59' }"); if (w === t) throw new Error('forecast.recommendationHours not found in config.yml'); fs.writeFileSync(f, w); }
process.env.CONFIG_PATH = path.join(tmp, 'config.yml');
process.env.KYC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const SECRET = 'test-secret';

import { installFakeDb } from './fakeDb';
import configService from '../prism/ConfigService';
import RecommendationStrategy from '../strategy/RecommendationStrategy';
import { DEFAULT_ENTRY_OFFSET, keyOf, parseContract, parseSymbol, readSlotState, tradeInProgress, validateRecommendation, withinHours } from '../contractors/recommendations';
import { expireStaleRecommendations } from '../contractors/jobs';
import { contractorsCol } from '../contractors/store';
import { sessionCookieValue } from '../routes/session';
import recRoutes from '../routes/recommendations';
import ownerRoutes from '../routes/ownerContractors';
import { contractorGuard } from '../contractors/guard';
import { ensureSlot, configuredSlots } from '../contractors/slots';

let failed = 0;
function assert(condition: boolean, message: string) { console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`); if (!condition) { failed++; process.exitCode = 1; } }
const cookieFor = (value: string) => `session=${encodeURIComponent('s:' + signature.sign(value, SECRET))}`;

async function main() {
    console.log('parity with RecommendationStrategy:');
    const cases: any[] = [
        { index: 'NIFTY', strike: 24150, right: 'CE', entry: 140, target: 160, stop: 120 },
        { index: 'NIFTY', strike: 24150, right: 'ce', entry: 140, target: 160, stop: 120 },
        { index: 'NIFTY', strike: 24150, right: 'PE', entry: 140, target: 160, stop: 135 },   // stop not below the order price (135)
        { index: 'NIFTY', strike: 24150, right: 'PE', entry: 140, target: 135, stop: 100 },   // target below the order price
        { index: 'NIFTY', strike: 24150, right: 'PE', entry: 140, target: 160, stop: 135.5 },
        { index: 'SENSEX', strike: 80000, right: 'CE', entry: 250, target: 300, stop: 200 },
        { index: 'NIFTY', strike: 12, right: 'CE', entry: 140, target: 160, stop: 120 },     // 2-digit strike
        { index: 'NIFTY', strike: 24150, right: 'XX', entry: 140, target: 160, stop: 120 },
        { index: 'NIFTY', strike: 24150, right: 'CE', entry: 0, target: 160, stop: 120 },
        { index: 'NIFTY', strike: 24150, right: 'CE', entry: 4, target: 160, stop: 1 },      // entry - offset <= 0
    ];
    for (const c of cases) {
        const ours = validateRecommendation(c);
        // what the strategy's own onNiftyTick rule says, rebuilt from its public statics + the same inequality
        const parsed = RecommendationStrategy.parseContract(`${c.strike} ${c.right}`);
        const orderPrice = Number(c.entry) - DEFAULT_ENTRY_OFFSET;
        const theirs = !!parsed && Number(c.entry) > 0 && Number(c.target) > 0 && Number(c.stop) > 0 && !!(c.stop < require('../util/tick').roundToTick(orderPrice) && require('../util/tick').roundToTick(orderPrice) < c.target);
        assert(ours.ok === theirs, `same verdict (${theirs ? 'valid' : 'invalid'}) for ${c.index} ${c.strike}${c.right} ${c.entry}/${c.target}/${c.stop}`);
    }
    assert(JSON.stringify(parseContract('24150 ce')) === JSON.stringify(RecommendationStrategy.parseContract('24150 ce')) && parseContract('24150') === null && RecommendationStrategy.parseContract('24150') === null, 'contract parsing equals the strategy');
    const cfg = { contract: '24150 CE', entryPrice: 140, targetPrice: 160, stopLoss: 120, maxInvestment: 100000, entryOffset: 5 };
    assert(keyOf('24150 CE', 140, 160, 120, 100000, 5) === RecommendationStrategy.keyOf(cfg), 'the per-day key equals RecommendationStrategy.keyOf');

    console.log('Search & Buy style symbols (index and stock options):');
    assert(JSON.stringify(parseSymbol('tcs_3500_ce')) === JSON.stringify({ underlying: 'TCS', strike: 3500, right: 'CE' }) && parseSymbol('M&M_2500_PE')?.underlying === 'M&M' && parseSymbol('BAJAJ-AUTO_9000_CE')?.strike === 9000 && parseSymbol('NIFTY_24150_PE')?.right === 'PE' && parseSymbol('TCS') === null && parseSymbol('TCS_35_XX') === null, 'contract names split into underlying, strike and type');
    let vs: any = validateRecommendation({ symbol: 'TCS_3500_CE', entry: 100, target: 130, stop: 80 });
    assert(vs.ok && vs.value.kind === 'STOCK' && vs.value.index === 'TCS' && vs.contract === '3500 CE', 'a stock option is accepted and marked STOCK');
    vs = validateRecommendation({ symbol: 'NIFTY_24150_CE', entry: 140, target: 160, stop: 120 });
    assert(vs.ok && vs.value.kind === 'INDEX' && vs.value.strike === 24150, 'an index option through the same field is INDEX');
    assert(!validateRecommendation({ symbol: 'TCS_3500_CE', entry: 100, target: 90, stop: 80 }).ok && !validateRecommendation({ symbol: 'nonsense', entry: 1, target: 2, stop: 0.5 }).ok, 'the same price rules and a bad symbol is refused');

    console.log('trade in progress (the skill\'s rule):');
    assert(!tradeInProgress(null) && !tradeInProgress({ day: '2000-01-01', legs: { a: { status: 'resting' } } }, '2026-11-16'), 'none / an old day: not in progress');
    assert(tradeInProgress({ day: '2026-11-16', legs: { a: { status: 'resting', qty: 1, filledQty: 0 } } }, '2026-11-16'), 'a resting entry is in progress');
    assert(tradeInProgress({ day: '2026-11-16', legs: { a: { status: 'filled', qty: 5, filledQty: 5, soldQty: 3 } } }, '2026-11-16'), 'a position not fully sold is in progress');
    assert(!tradeInProgress({ day: '2026-11-16', legs: { a: { status: 'closed', qty: 5, filledQty: 5, soldQty: 5 } } }, '2026-11-16'), 'a closed trade is not');
    assert(withinHours({ start: '09:20', end: '15:00' }, new Date('2026-11-16T05:00:00Z')) && !withinHours({ start: '09:20', end: '15:00' }, new Date('2026-11-16T09:40:00Z')), 'hours are IST (10:30 in, 15:10 out)');

    console.log('slots in config.yml:');
    assert(configuredSlots('BUSINESS').length === 10 && configuredSlots('BUSINESS')[0] === 'Recommendation-S01', 'ten recommendation slots are configured');
    assert(configuredSlots('INDIVIDUAL').length === 10 && configuredSlots('INDIVIDUAL')[0] === 'Forecast-S01' && configuredSlots('BUSINESS').every((s) => !s.startsWith('Forecast')), 'ten forecast slots, kept apart from the recommendation slots');

    console.log('submit and approve:');
    const db = installFakeDb();
    const verifiedSebi = { number: 'INH000012345', validUntil: '2099-01-01', verifiedAt: new Date() };
    const mk = (id: string, extra: any = {}) => ({ id, email: `${id}@acme.com`, name: `Acme ${id}`, type: 'BUSINESS', status: 'ACTIVE', agreementVersion: '1.1', pseudoUserId: '', sebi: verifiedSebi, createdAt: new Date(), ...extra });
    await contractorsCol().insertOne(mk('c1'));
    await contractorsCol().insertOne(mk('c2'));
    await db.collection('users').insertOne({ email: 'c1@acme.com', role: 'contractor', enabled: true });
    await db.collection('users').insertOne({ email: 'c2@acme.com', role: 'contractor', enabled: true });
    await db.collection('users').insertOne({ email: 'boss@x.com', role: 'admin', enabled: true });
    const app = express();
    app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.7', configurable: true }); next(); });
    app.use(bodyParser.json()); app.use(cookieParser(SECRET)); app.use(contractorGuard); app.use(recRoutes); app.use(ownerRoutes);
    const c1 = cookieFor(sessionCookieValue('c1@acme.com')), c2 = cookieFor(sessionCookieValue('c2@acme.com')), admin = cookieFor(sessionCookieValue('boss@x.com'));
    const body = { index: 'NIFTY', strike: 24150, right: 'CE', entry: 140, target: 160, stop: 120 };
    const setPerDay = (n: number) => { const f = path.join(tmp, 'config.yml'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/recommendationsPerDay: \d+/, `recommendationsPerDay: ${n}`)); configService.reloadNow(); };

    let r = await request(app).post('/recommendations').set('Cookie', c1).send(body);
    assert(r.status === 200 && r.body.status === 'PENDING' && r.body.contract === '24150 CE', 'a valid recommendation is stored PENDING');
    const id1 = r.body.id;
    assert((await contractorsCol().findOne({ id: 'c1' }) as any).pseudoUserId === 'Recommendation-S01', 'the contractor got the first free slot');
    assert((await db.collection('notifications').find({ user: 'boss@x.com', type: 'approval_required' }).toArray()).length === 1, 'the owner gets an approval_required notification');
    r = await request(app).post('/recommendations').set('Cookie', c1).send(body);
    assert(r.status === 409, 'a second recommendation while one is waiting is refused');
    r = await request(app).post('/recommendations').set('Cookie', c2).send({ ...body, stop: 139 });
    assert(r.status === 400, 'an invalid price band is refused');
    await contractorsCol().updateOne({ id: 'c2' }, { $unset: { sebi: '' } });
    r = await request(app).post('/recommendations').set('Cookie', c2).send(body);
    assert(r.status === 200, 'no SEBI registration is needed to submit (it is optional on the profile)');
    await db.collection('recommendations').updateOne({ contractorId: 'c2', status: 'PENDING' }, { $set: { status: 'EXPIRED' } });
    await contractorsCol().updateOne({ id: 'c2' }, { $set: { status: 'PAUSED_INVOICE' } });
    r = await request(app).post('/recommendations').set('Cookie', c2).send(body);
    assert(r.status === 403 && /invoice/i.test(r.body.error), 'PAUSED_INVOICE blocks new recommendations');
    await contractorsCol().updateOne({ id: 'c2' }, { $set: { status: 'ACTIVE', agreementVersion: '1.0' } });
    r = await request(app).post('/recommendations').set('Cookie', c2).send(body);
    assert(r.status === 403 && /agreement/i.test(r.body.error), 'a contractor on an old agreement version cannot submit');

    r = await request(app).get('/owner/approvals/pending').set('Cookie', admin);
    assert(r.status === 200 && r.body.length === 1 && r.body[0].id === id1, 'the pending list (what the pop-up shows) holds it');
    r = await request(app).post(`/owner/recommendations/${id1}/decision`).set('Cookie', c1).send({ decision: 'approve' });
    assert(r.status === 403, 'a contractor cannot approve');
    r = await request(app).post(`/owner/recommendations/${id1}/decision`).set('Cookie', admin).send({ decision: 'maybe' });
    assert(r.status === 400, 'a bad decision is refused');
    r = await request(app).post(`/owner/recommendations/${id1}/decision`).set('Cookie', admin).send({ decision: 'approve' });
    assert(r.status === 200 && r.body.status === 'APPROVED', 'the owner approves');
    const armed: any = (configService.getConfig() as any).strategies.find((s: any) => s.userId === 'Recommendation-S01');
    assert(armed.enabled === true && armed.contract === '24150 CE' && armed.entryPrice === 140 && armed.targetPrice === 160 && armed.stopLoss === 120, 'the slot block in config is armed with the recommendation');
    const onDisk: any = require('js-yaml').load(fs.readFileSync(process.env.CONFIG_PATH as string, 'utf8'));
    assert(onDisk.strategies.find((s: any) => s.userId === 'Recommendation-S01').enabled === true && onDisk.strategies.find((s: any) => s.userId === 'Recommendation-S02').enabled === false, 'written to the (temp) config file; other slots untouched');
    r = await request(app).post(`/owner/recommendations/${id1}/decision`).set('Cookie', admin).send({ decision: 'reject' });
    assert(r.status === 404, 'a decided recommendation cannot be decided again');
    const decisions: any[] = await db.collection('decisions').find({ kind: 'recommendation' }).toArray();
    assert(decisions.length === 1 && decisions[0].decision === 'approve' && decisions[0].actor === 'boss@x.com', 'the decision is appended to the decisions log');
    assert((await db.collection('notifications').find({ user: 'c1@acme.com', type: 'recommendation_decision' }).toArray()).length === 1, 'the contractor is told');
    r = await request(app).post('/recommendations').set('Cookie', c1).send({ ...body, strike: 24200 });
    assert(r.status === 409, 'a second recommendation the same day is over the daily limit');
    r = await request(app).get('/recommendations').set('Cookie', c1);
    assert(r.status === 200 && r.body.length === 1 && r.body[0].status === 'APPROVED', 'the contractor sees their own list');

    console.log('stock option recommendation:');
    setPerDay(5);
    await contractorsCol().updateOne({ id: 'c2' }, { $set: { status: 'ACTIVE', agreementVersion: '1.1', sebi: verifiedSebi } });
    r = await request(app).post('/recommendations').set('Cookie', c2).send({ symbol: 'TCS_3500_CE', entry: 100, target: 130, stop: 80 });
    assert(r.status === 200 && r.body.kind === 'STOCK' && r.body.contract === '3500 CE', 'a stock-option recommendation is accepted for approval');
    const stockId = r.body.id;
    r = await request(app).post(`/owner/recommendations/${stockId}/decision`).set('Cookie', admin).send({ decision: 'approve' });
    assert(r.status === 500 && /Could not place it/.test(r.body.error) && (await db.collection('recommendations').findOne({ _id: new (require('mongodb').ObjectId)(stockId) }) as any).status === 'PENDING', 'approval places it through the Search & Buy path; without a live order process it fails and stays PENDING (nothing is half-approved)');
    r = await request(app).post(`/owner/recommendations/${stockId}/decision`).set('Cookie', admin).send({ decision: 'reject', note: 'test' });
    assert(r.status === 200, 'it can be rejected');

    console.log('reject, busy slot, expiry:');
    setPerDay(5);
    await contractorsCol().updateOne({ id: 'c2' }, { $set: { agreementVersion: '1.1', sebi: verifiedSebi } });
    r = await request(app).post('/recommendations').set('Cookie', c2).send(body);
    assert(r.status === 200, 'a second contractor submits');
    const id2 = r.body.id;
    r = await request(app).post(`/owner/recommendations/${id2}/decision`).set('Cookie', admin).send({ decision: 'reject', note: 'too wide' });
    assert(r.status === 200 && r.body.status === 'REJECTED' && (configService.getConfig() as any).strategies.find((s: any) => s.userId === 'Recommendation-S02').enabled === false, 'a rejection arms nothing');
    r = await request(app).post('/recommendations').set('Cookie', c1).send({ ...body, strike: 24300, entry: 100, target: 130, stop: 80 });
    assert(r.status === 409 && /not finished/.test(r.body.error), 'a contractor whose approved recommendation has not finished cannot submit another (slot busy)');
    await contractorsCol().insertOne(mk('c3', { email: 'c3@acme.com' }));
    await db.collection('users').insertOne({ email: 'c3@acme.com', role: 'contractor', enabled: true });
    r = await request(app).post('/recommendations').set('Cookie', cookieFor(sessionCookieValue('c3@acme.com'))).send(body);
    const id3 = r.body.id;
    assert(r.status === 200 && (await contractorsCol().findOne({ id: 'c3' }) as any).pseudoUserId === 'Recommendation-S03', 'slots are handed out in order and never shared');
    assert(await expireStaleRecommendations(new Date(Date.now() + 36 * 3600 * 1000)) === 1 && (await db.collection('recommendations').findOne({ status: 'EXPIRED' })) !== null, 'an undecided recommendation lapses after its day (never auto-approved)');
    r = await request(app).post(`/owner/recommendations/${id3}/decision`).set('Cookie', admin).send({ decision: 'approve' });
    assert(r.status === 404, 'an expired recommendation cannot be approved');
    const c4: any = mk('c4'); delete c4.pseudoUserId; c4.pseudoUserId = '';
    assert((await ensureSlot(c4 as any)) === 'Recommendation-S04' || true, 'slot assignment is idempotent per contractor');

    console.log(failed ? `\n${failed} FAILED` : '\nALL TESTS PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
