/** Contractor hourly jobs: agreement version switch, SEBI expiry alerts, and the KYC-change approval. Run: npx tsc, then node ./dist/test/contractorJobs.test.js */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
fs.copyFileSync(path.resolve(__dirname, '..', '..', 'config.yml'), path.join(tmp, 'config.yml'));
process.env.CONFIG_PATH = path.join(tmp, 'config.yml');
process.env.KYC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
for (const k of ['GMAIL_USER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) delete process.env[k];
import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const signature = require('cookie-signature');
import { installFakeDb } from './fakeDb';
import { runAgreementVersionSwitch, runSebiExpiryAlerts } from '../contractors/jobs';
import { contractorsCol } from '../contractors/store';
import { decryptField, encryptField } from '../contractors/kycCrypto';
import { sessionCookieValue } from '../routes/session';
import inviteRoutes from '../routes/invite';
import ownerRoutes from '../routes/ownerContractors';
import { contractorGuard } from '../contractors/guard';

let failed = 0;
function assert(condition: boolean, message: string) { console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`); if (!condition) { failed++; process.exitCode = 1; } }
const cookieFor = (value: string) => `session=${encodeURIComponent('s:' + signature.sign(value, 'test-secret'))}`;

async function main() {
    const db = installFakeDb();
    console.log('agreement version switch:');
    await contractorsCol().insertOne({ id: 'a', email: 'a@x.com', name: 'A', type: 'INDIVIDUAL', status: 'ACTIVE', agreementVersion: '1.0' });
    await contractorsCol().insertOne({ id: 'b', email: 'b@x.com', name: 'B', type: 'INDIVIDUAL', status: 'ACTIVE', agreementVersion: '1.1' });
    assert(await runAgreementVersionSwitch() === 1, 'one contractor is on an older version than the one in force');
    assert((await contractorsCol().findOne({ id: 'a' }) as any).status === 'AGREEMENT_PENDING' && (await contractorsCol().findOne({ id: 'b' }) as any).status === 'ACTIVE', 'only the old-version contractor moves to AGREEMENT_PENDING');
    assert((await db.collection('notifications').find({ user: 'a@x.com', type: 'agreement_pending' }).toArray()).length === 1, 'and is told');
    assert(await runAgreementVersionSwitch() === 0, 'nothing more on a second run');

    console.log('SEBI expiry alerts:');
    await db.collection('users').insertOne({ email: 'boss@x.com', role: 'admin', enabled: true });
    const biz = (id: string, validUntil: string) => contractorsCol().insertOne({ id, email: `${id}@x.com`, name: id, type: 'BUSINESS', status: 'ACTIVE', sebi: { number: 'INH000012345', validUntil, verifiedAt: new Date() } });
    await biz('far', '2027-06-30'); await biz('soon', '2026-12-10'); await biz('gone', '2026-11-01');
    const today = new Date('2026-11-16T10:00:00+05:30');
    assert(await runSebiExpiryAlerts(today) === 2, 'a registration within 30 days and an expired one alert; one far away does not');
    assert((await db.collection('notifications').find({ user: 'boss@x.com', type: 'sebi_expiry' }).toArray()).length === 2, 'the owner is notified');
    assert(await runSebiExpiryAlerts(today) === 0, 'each stage alerts once');
    assert((await db.collection('notifications').find({ user: 'gone@x.com' }).toArray()).length === 1, 'an expired contractor is told submissions are blocked');
    assert(await runSebiExpiryAlerts(new Date('2026-12-11T10:00:00+05:30')) === 1, 'the "soon" one alerts again once it expires');

    console.log('KYC change approval:');
    const app = express();
    app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.7', configurable: true }); next(); });
    app.use(bodyParser.json()); app.use(cookieParser('test-secret')); app.use(contractorGuard); app.use(inviteRoutes); app.use(ownerRoutes);
    const k = { legalName: 'K', address: '1 Road', panEnc: encryptField('ABCDE1234F'), bankHolder: 'K', bankAccountEnc: encryptField('111111111111'), bankIfsc: 'HDFC0001234', notGstRegistered: true };
    await contractorsCol().insertOne({ id: 'k1', email: 'k1@x.com', name: 'K1', type: 'INDIVIDUAL', status: 'ACTIVE', agreementVersion: '1.1', kyc: k });
    await db.collection('users').insertOne({ email: 'k1@x.com', role: 'contractor', enabled: true });
    const ck = cookieFor(sessionCookieValue('k1@x.com')), admin = cookieFor(sessionCookieValue('boss@x.com'));
    let r = await request(app).post('/contractor/kyc-change').set('Cookie', ck).send({ bankAccount: '222222222222', bankIfsc: 'ICIC0000123' });
    assert(r.status === 200 && r.body.pending.includes('bankAccountEnc'), 'a bank change is accepted as PENDING');
    assert(decryptField(((await contractorsCol().findOne({ id: 'k1' })) as any).kyc.bankAccountEnc) === '111111111111', 'the old account stays in force until approval');
    r = await request(app).post('/contractor/kyc-change').set('Cookie', ck).send({ bankAccount: '12' });
    assert(r.status === 400, 'an invalid account number is refused');
    r = await request(app).post('/contractor/kyc-change').set('Cookie', ck).send({ pan: 'BADPAN' });
    assert(r.status === 400, 'an invalid PAN is refused');
    r = await request(app).post('/contractor/kyc-change').set('Cookie', ck).send({ gstin: '33ABCDE1234F1Z5' });
    assert(r.status === 400 && /Business/.test(r.body.error), 'an Individual cannot add a GSTIN');
    const pending = (await request(app).get('/owner/kyc-changes').set('Cookie', admin)).body;
    assert(pending.length === 1 && !JSON.stringify(pending).includes('222222222222'), 'the owner sees the pending change without the new number in clear');
    r = await request(app).post(`/owner/kyc-changes/${pending[0].id}/decision`).set('Cookie', ck).send({ decision: 'approve' });
    assert(r.status === 403, 'a contractor cannot approve their own change');
    r = await request(app).post(`/owner/kyc-changes/${pending[0].id}/decision`).set('Cookie', admin).send({ decision: 'approve' });
    assert(r.status === 200 && decryptField(((await contractorsCol().findOne({ id: 'k1' })) as any).kyc.bankAccountEnc) === '222222222222' && ((await contractorsCol().findOne({ id: 'k1' })) as any).kyc.bankIfsc === 'ICIC0000123', 'approval applies the new bank details');
    r = await request(app).post('/contractor/kyc-change').set('Cookie', ck).send({ bankAccount: '333333333333' });
    const p2 = (await request(app).get('/owner/kyc-changes').set('Cookie', admin)).body[0];
    await request(app).post(`/owner/kyc-changes/${p2.id}/decision`).set('Cookie', admin).send({ decision: 'reject' });
    assert(decryptField(((await contractorsCol().findOne({ id: 'k1' })) as any).kyc.bankAccountEnc) === '222222222222', 'a rejected change changes nothing');
    assert((await db.collection('notifications').find({ user: 'k1@x.com', type: 'kyc_change_decision' }).toArray()).length === 2, 'the contractor is told of both decisions');

    console.log(failed ? `\n${failed} FAILED` : '\nALL TESTS PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
