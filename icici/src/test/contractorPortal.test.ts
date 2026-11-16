/**
 * Contractor portal (spec v2.1 sections 3 to 6): KYC validation and encryption, the default-deny guard, session cookie lifetimes, invites
 * (single use, expiry, re-invite) and the accept flow through the real routes on an in-memory Mongo. Run: npx tsc, then node ./dist/test/contractorPortal.test.js
 */
import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import * as crypto from 'crypto';
import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const signature = require('cookie-signature');
import { installFakeDb } from './fakeDb';

require('dotenv').config(); // the PDF signing certificate settings (personalised agreements are signed)
process.env.KYC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.INVITE_RATE_LIMIT = '1000';
process.env.STORAGE_DIR = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'stor-')); // personalised agreements are written here, not into the repo's storage/
// Never send a real email from a test (the welcome email fires after an acceptance).
for (const k of ['GMAIL_USER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) delete process.env[k];
const SECRET = 'test-secret';

import { gstinMatchesPan, sebiUsable, validPan, validSebi, validIfsc, validAccount, daysUntil } from '../contractors/validate';
import { decryptField, encryptField, maskLast4 } from '../contractors/kycCrypto';
import { contractorMayCall, contractorGuard } from '../contractors/guard';
import { parseSession, sessionCookieValue } from '../routes/session';
import { contractorCookieValue } from '../contractors/session';
import { agreementPath, currentVersion, readAgreement, scheduleVersion, upcomingVersion } from '../contractors/agreements';
import { createInvite, consumeInvite, findInviteByToken, inviteState, submissionBlock, hashToken, activeCount, contractorsCol, invitesCol } from '../contractors/store';
import inviteRoutes from '../routes/invite';
import ownerRoutes from '../routes/ownerContractors';
import { RateLimiter } from '../contractors/rateLimit';

let failed = 0;
function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) { failed++; process.exitCode = 1; }
}
const cookieFor = (value: string) => `session=${encodeURIComponent('s:' + signature.sign(value, SECRET))}`;
const cookieFromRes = (res: any): string => {
    const raw = (res.headers['set-cookie'] ?? []).find((c: string) => c.startsWith('session='));
    return raw ? raw.split(';')[0] : '';
};

async function main() {
    // ---------- validation ----------
    console.log('validation:');
    assert(validPan('ABCDE1234F') && !validPan('abcde1234f') && !validPan('ABCDE12345'), 'PAN format');
    assert(gstinMatchesPan('33ABCDE1234F1Z5', 'ABCDE1234F'), 'GSTIN whose embedded PAN matches');
    assert(!gstinMatchesPan('33ABCDE1234F1Z5', 'ABCDE1234G'), 'GSTIN whose PAN differs is rejected');
    assert(!gstinMatchesPan('33ABCDE1234F1Y5', 'ABCDE1234F'), 'GSTIN without the Z is malformed');
    assert(validSebi('INH000012345') && !validSebi('INA000012345') && !validSebi('INH00001234'), 'SEBI: INH + 9 digits only, INA not accepted');
    assert(validIfsc('HDFC0001234') && !validIfsc('HDFC1001234'), 'IFSC format');
    assert(validAccount('123456789012') && !validAccount('12345678') && !validAccount('12AB'), 'account number');
    const sebi = { number: 'INH000012345', validUntil: '2026-12-31', verifiedAt: new Date() };
    assert(sebiUsable(sebi, '2026-12-31') && !sebiUsable(sebi, '2027-01-01'), 'a registration is usable up to and including its valid-until day');
    assert(!sebiUsable({ ...sebi, verifiedAt: undefined }, '2026-11-16'), 'an unverified registration is not usable');
    assert(daysUntil('2026-12-16', '2026-11-16') === 30, 'days until expiry');

    console.log('KYC encryption:');
    const enc = encryptField('ABCDE1234F');
    assert(!enc.includes('ABCDE1234F') && decryptField(enc) === 'ABCDE1234F', 'round trip, ciphertext hides the value');
    assert(encryptField('ABCDE1234F') !== enc, 'a fresh IV each time');
    let tamperFailed = false;
    try { decryptField(enc.slice(0, -4) + 'AAAA'); } catch { tamperFailed = true; }
    assert(tamperFailed, 'a tampered value does not decrypt');
    assert(maskLast4('ABCDE1234F') === 'XXXXXX234F', 'masked except the last 4');

    // ---------- the guard ----------
    console.log('guard allowlist:');
    for (const [m, p] of [['POST', '/order/buy'], ['POST', '/order/squareoff'], ['POST', '/order/settarget'], ['GET', '/order/contract-quote'], ['GET', '/order/can-place'], ['GET', '/positionstream'], ['GET', '/optionstream'],
        ['GET', '/users/a@b.com/trades/open'], ['GET', '/users/a@b.com/pnl-summary'], ['GET', '/users/a@b.com/payouts'], ['POST', '/users/a@b.com/bank-details'], ['GET', '/admin/trades/open'], ['GET', '/config'], ['POST', '/config'],
        ['GET', '/strategyPnl'], ['POST', '/order/lock-profits'], ['GET', '/broker/kite/positions'], ['POST', '/user/upgrade-request'], ['GET', '/level-rules'], ['POST', '/owner/invites'], ['GET', '/ant/stream']] as const) {
        assert(!contractorMayCall(m, p), `denied: ${m} ${p}`);
    }
    for (const [m, p] of [['GET', '/auth/me'], ['POST', '/auth/logout'], ['GET', '/niftystream'], ['GET', '/notificationstream'], ['GET', '/users/a@b.com/notifications'], ['PATCH', '/users/a@b.com/notifications/abc/read'],
        ['POST', '/forecast'], ['GET', '/forecast/history'], ['POST', '/recommendations'], ['GET', '/contractor/trades'], ['GET', '/agreements/current']] as const) {
        assert(contractorMayCall(m, p), `allowed: ${m} ${p}`);
    }
    assert(contractorMayCall('GET', '/my/recommend') && contractorMayCall('GET', '/my') && contractorMayCall('GET', '/privacy-policy') && contractorMayCall('GET', '/') && !contractorMayCall('POST', '/my/recommend') && !contractorMayCall('GET', '/myx') && !contractorMayCall('GET', '/console'), 'the app pages reload for a contractor (GET only); nothing else opens');
    assert(!contractorMayCall('GET', '/forecastx') && !contractorMayCall('GET', '/contractorx/trades'), 'prefixes match whole path segments');

    // ---------- session cookies ----------
    console.log('session cookie:');
    const sess = (v: string) => ({ signedCookies: { session: v } }) as any;
    assert(parseSession(sess(sessionCookieValue('a@b.com')))?.email === 'a@b.com', 'a normal two-part cookie parses as before');
    assert(parseSession(sess('a@b.com'))?.legacy === true, 'a legacy email-only cookie parses as before');
    assert(parseSession(sess(`a@b.com|${Date.now() - 31 * 86_400_000}`)) === null, 'a normal cookie still expires after 30 days');
    assert(parseSession(sess(`c@b.com|${Date.now() - 200 * 86_400_000}|365`))?.email === 'c@b.com', 'an Individual contractor cookie lives for its own 365 days');
    assert(parseSession(sess(`c@b.com|${Date.now() - 91 * 86_400_000}|90`)) === null, 'a Business contractor cookie expires after its 90 days');
    assert(parseSession(sess(`c@b.com|${Date.now()}|9999`)) === null && parseSession(sess(`c@b.com|${Date.now()}|0`)) === null, 'an out-of-range lifetime is refused');
    assert(parseSession(sess(`c@b.com|x|365`)) === null, 'a malformed issue time is refused');
    assert(contractorCookieValue('c@b.com', 'INDIVIDUAL').endsWith('|365') && contractorCookieValue('c@b.com', 'BUSINESS').endsWith('|90'), 'lifetimes by contractor type (365 / 90)');

    // ---------- agreements ----------
    console.log('agreements:');
    const db = installFakeDb();
    assert(await currentVersion('2026-11-16') === '1.1', 'the current version defaults to 1.1');
    const ind = readAgreement('INDIVIDUAL', '1.1');
    assert(ind.sha256 === crypto.createHash('sha256').update(fs.readFileSync(agreementPath('INDIVIDUAL', '1.1'))).digest('hex') && ind.bytes.slice(0, 5).toString() === '%PDF-', 'the hash is computed from the file served');
    let pastRejected = false;
    try { await scheduleVersion('1.1', '2020-01-01', 'a', '2026-11-16'); } catch { pastRejected = true; }
    assert(pastRejected, 'a version with no files / a past date cannot be scheduled');
    assert(await upcomingVersion('2026-11-16') === null, 'no upcoming version when none is scheduled');

    // ---------- invites ----------
    console.log('invites:');
    const { invite, token } = await createInvite({ type: 'INDIVIDUAL', createdBy: 'owner@x.com' });
    assert(invite.tokenHash === hashToken(token) && !JSON.stringify(invite).includes(token), 'only the hash of the token is stored');
    assert(inviteState(await findInviteByToken(token)) === 'ok', 'a fresh invite is ok');
    assert(inviteState(await findInviteByToken('x'.repeat(30))) === 'unknown', 'an unknown token is unknown');
    assert(await consumeInvite(invite._id, 'c1') === true && await consumeInvite(invite._id, 'c2') === false, 'single use: the second consume fails');
    assert(inviteState(await findInviteByToken(token)) === 'used', 'a used invite is reported used');
    const old = await createInvite({ type: 'BUSINESS', createdBy: 'o' }, new Date(Date.now() - 8 * 86_400_000));
    assert(inviteState(await findInviteByToken(old.token)) === 'expired', 'an invite expires after 7 days');
    assert(await consumeInvite(old.invite._id, 'c3') === false, 'an expired invite cannot be consumed');
    const limiter = new RateLimiter(2, 1000);
    assert(limiter.allow('k', 0) && limiter.allow('k', 1) && !limiter.allow('k', 2) && limiter.allow('k', 2000), 'rate limiter window');
    assert(submissionBlock(null, '1.1') !== null && submissionBlock({ status: 'INVITED' } as any, '1.1') !== null && submissionBlock({ status: 'ACTIVE', agreementVersion: '1.0' } as any, '1.1') !== null
        && submissionBlock({ status: 'PAUSED_INVOICE' } as any, '1.1') !== null && submissionBlock({ status: 'ACTIVE', agreementVersion: '1.1' } as any, '1.1') === null, 'submission is blocked unless ACTIVE on the current agreement');

    // ---------- the routes ----------
    console.log('accept flow:');
    const app = express();
    // supertest connects from 127.0.0.1, which requireAuth/requireAdmin treat as an ops script: present a public address instead.
    app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.7', configurable: true }); next(); });
    app.use(bodyParser.json());
    app.use(cookieParser(SECRET));
    app.use(contractorGuard);
    app.use(inviteRoutes);
    app.use(ownerRoutes);
    for (const p of ['/order/buy', '/positionstream', '/users/:e/trades/open', '/niftystream']) app.all(p, (_req, res) => { res.json({ reached: true }); });

    const indKyc = { legalName: 'Test Person', address: '12 Some Street, Chennai', pan: 'ABCDE1234F', bankHolder: 'Test Person', bankAccount: '123456789012', bankIfsc: 'HDFC0001234', notGstRegistered: true };
    const good = (kyc: any = indKyc, extra: any = {}) => ({ email: 'Person@Example.com', name: 'Test Person', acceptTerms: true, dpdpConsent: true, kyc, ...extra });
    const inv1 = await createInvite({ type: 'INDIVIDUAL', createdBy: 'owner@x.com' });

    let r = await request(app).get(`/invite/${inv1.token}`);
    assert(r.status === 200 && r.body.state === 'ok' && r.body.type === 'INDIVIDUAL' && r.body.agreement.version === '1.1', 'GET invite shows its type and the agreement version');
    r = await request(app).get(`/invite/${inv1.token}/agreement`);
    assert(r.status === 200 && r.headers['content-type'].startsWith('application/pdf') && r.headers['x-agreement-sha256'] === ind.sha256, 'the invite serves the Individual agreement with its hash');
    const binary = (res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
    r = await request(app).post(`/invite/${inv1.token}/preview`).buffer(true).parse(binary).send({ name: 'Preview Person', kyc: { legalName: 'Preview Person', address: '9 Preview Lane', pan: 'ABCDE1234F' } });
    assert(r.status === 200 && r.headers['content-type'].startsWith('application/pdf'), 'the preview returns the agreement as a PDF');
    assert(/Preview Person, resident at 9 Preview Lane/.test(require('child_process').spawnSync('pdftotext', ['-layout', '-', '-'], { input: r.body }).stdout.toString().replace(/\s+/g, ' ')), 'and it already carries the details typed so far');
    assert((await invitesCol().findOne({ tokenHash: hashToken(inv1.token) }) as any).usedAt === undefined && (await contractorsCol().find({}).toArray()).length === 0, 'a preview consumes nothing and stores nothing');
    r = await request(app).get('/invite/' + 'z'.repeat(40));
    assert(r.status === 200 && r.body.state === 'unknown', 'an unknown link says so');

    r = await request(app).post(`/invite/${inv1.token}/accept`).send({ ...good(), acceptTerms: false });
    assert(r.status === 400, 'accept without ticking the agreement is refused');
    r = await request(app).post(`/invite/${inv1.token}/accept`).send({ ...good(), dpdpConsent: false });
    assert(r.status === 400, 'accept without the data consent is refused');
    r = await request(app).post(`/invite/${inv1.token}/accept`).send(good({ ...indKyc, pan: 'BAD' }));
    assert(r.status === 400, 'an invalid PAN is refused');
    r = await request(app).post(`/invite/${inv1.token}/accept`).send(good({ ...indKyc, notGstRegistered: false }));
    assert(r.status === 422 && /Business agreement/.test(r.body.error), 'GST-registered individuals are told to switch to the Business agreement');
    assert(inviteState(await findInviteByToken(inv1.token)) === 'ok' && (await contractorsCol().find({}).toArray()).length === 0, 'failed attempts neither consume the invite nor create a record');

    r = await request(app).post(`/invite/${inv1.token}/accept`).set('User-Agent', 'JestAgent/1').send(good());
    assert(r.status === 200 && r.body.role === 'contractor' && r.body.type === 'INDIVIDUAL' && r.body.status === 'ACTIVE', 'a valid acceptance creates the contractor, active at once (no owner approval)');
    const cookie1 = cookieFromRes(r);
    assert(cookie1.startsWith('session=') && decodeURIComponent(cookie1).includes('|365'), 'the session cookie carries the 365-day Individual lifetime');
    assert(!JSON.stringify(r.body).includes('ABCDE1234F') && r.body.kyc.panMasked === 'XXXXXX234F' && r.body.accountCapital === undefined, 'the response masks the PAN and carries no capital/limits');
    const stored: any = (await contractorsCol().find({}).toArray())[0];
    assert(!JSON.stringify(stored).includes('ABCDE1234F') && !JSON.stringify(stored).includes('123456789012') && decryptField(stored.kyc.panEnc) === 'ABCDE1234F', 'PAN and bank account are stored encrypted');
    assert(stored.email === 'person@example.com' && !!stored.activatedAt && stored.pseudoUserId === undefined, 'email lower-cased; activated at once (no strategy slot is assigned any more)');
    const userDoc: any = await db.collection('users').findOne({ email: 'person@example.com' });
    assert(userDoc.role === 'contractor' && userDoc.proficiencyLevel === 'beginner' && userDoc.accountCapital === 0, 'a users record with role contractor exists');
    const acc: any[] = await db.collection('agreementAcceptances').find({}).toArray();
    assert(acc.length === 1 && acc[0].fileSha256 !== ind.sha256 && acc[0].templateSha256 === ind.sha256 && acc[0].agreementVersion === '1.1' && acc[0].userAgent === 'JestAgent/1' && acc[0].dpdpConsent === true && !!acc[0].acceptedAtUtc && !!acc[0].acceptedAtIst, 'the acceptance record has the hash of the personalised copy (and of the template), version, time, IP and user agent');
    const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
    const text = (b: Buffer) => require('child_process').spawnSync('pdftotext', ['-layout', '-', '-'], { input: b }).stdout.toString();
    const storedPdf = fs.readFileSync(stored.agreementFile);
    assert(sha(storedPdf) === acc[0].fileSha256 && sha(storedPdf) === stored.agreementSha256, 'the stored personalised PDF is exactly the file whose hash was recorded');
    const t1 = text(storedPdf);
    assert(/The Contractor: Test Person, resident at 12 Some Street, Chennai \(PAN: ABCDE1234F\)/.test(t1.replace(/\s+/g, ' ')), 'the Parties clause is filled with the name, address and PAN they gave');
    assert(/Karthikeyan S/.test(t1) && !/\bthe Company\b/.test(t1), 'the other party is named, not "the Company"');
    r = await request(app).post(`/invite/${inv1.token}/accept`).send(good());
    assert(r.status === 410, 'the same link cannot be used twice');

    console.log('contractor fence:');
    r = await request(app).get('/contractor/me').set('Cookie', cookie1);
    assert(r.status === 200 && r.body.email === 'person@example.com', 'the cookie works for the contractor view');
    for (const [m, p] of [['post', '/order/buy'], ['get', '/positionstream'], ['get', '/users/person@example.com/trades/open']] as const) {
        r = await (request(app) as any)[m](p).set('Cookie', cookie1);
        assert(r.status === 403, `contractor ${m.toUpperCase()} ${p} is 403`);
    }
    r = await request(app).get('/niftystream').set('Cookie', cookie1);
    assert(r.status === 200, 'the NIFTY stream is allowed');
    r = await request(app).post('/order/buy');
    assert(r.status === 200, 'a request with no session passes the guard untouched (the route decides)');
    await db.collection('users').insertOne({ email: 'old@user.com', role: 'user', enabled: true });
    r = await request(app).post('/order/buy').set('Cookie', cookieFor(sessionCookieValue('old@user.com')));
    assert(r.status === 200, 'an existing normal user is not affected by the guard');
    await db.collection('users').insertOne({ email: 'boss@x.com', role: 'admin', enabled: true });
    r = await request(app).post('/order/buy').set('Cookie', cookieFor(sessionCookieValue('boss@x.com')));
    assert(r.status === 200, 'an admin is not affected by the guard');
    r = await request(app).post('/owner/invites').set('Cookie', cookie1).send({ type: 'INDIVIDUAL' });
    assert(r.status === 403, 'a contractor cannot create invites');

    console.log('re-invite:');
    const adminCookie = cookieFor(sessionCookieValue('boss@x.com'));
    r = await request(app).post(`/owner/contractors/${stored.id}/reinvite`).set('Cookie', adminCookie).send({});
    assert(r.status === 200 && /\/join\//.test(r.body.link), 'the owner gets a re-invite link');
    const reToken = r.body.link.split('/join/')[1];
    r = await request(app).get('/contractor/me').set('Cookie', cookie1);
    assert(r.status === 401, 're-inviting revokes the old session: logged out until the new link is used');
    await new Promise((res) => setTimeout(res, 5));
    r = await request(app).get(`/invite/${reToken}`);
    assert(r.status === 200 && r.body.reinvite?.email === 'person@example.com' && r.body.reinvite.needsAgreement === false, 'the re-invite page shows the same contractor, no new agreement needed');
    r = await request(app).post(`/invite/${reToken}/accept`).send({});
    assert(r.status === 200 && r.body.id === stored.id, 'accepting the re-invite re-binds the same record');
    const cookie2 = cookieFromRes(r);
    r = await request(app).get('/contractor/me').set('Cookie', cookie2);
    assert(r.status === 200, 'the new cookie works');
    assert((await contractorsCol().find({}).toArray()).length === 1 && (await db.collection('agreementAcceptances').find({}).toArray()).length === 1, 'no duplicate contractor or acceptance');
    r = await request(app).post(`/invite/${reToken}/accept`).send({});
    assert(r.status === 410, 'the re-invite link is single use too');

    console.log('business accept:');
    const bizKyc = { entityName: 'Acme Research LLP', address: '5 Market Road, Mumbai', gstin: '33ABCDE1234F1Z5', analystName: 'D Forecaster',
        bankHolder: 'Acme Research LLP', bankAccount: '998877665544', bankIfsc: 'ICIC0000123', sebiNumber: 'INH000012345', sebiValidUntil: '2027-03-31' };
    const biz = await createInvite({ type: 'BUSINESS', createdBy: 'owner@x.com', emailLock: 'forecaster@acme.com' });
    const bgood = (kyc: any = bizKyc, extra: any = {}) => ({ email: 'forecaster@acme.com', name: 'D Forecaster', acceptTerms: true, dpdpConsent: true, representation6A5: true, kyc, ...extra });
    r = await request(app).post(`/invite/${biz.token}/accept`).send(bgood(bizKyc, { email: 'someone@else.com' }));
    assert(r.status === 400 && /different email/.test(r.body.error), 'an email-locked invite refuses another email');
    const fx = await createInvite({ type: 'BUSINESS', createdBy: 'o' });
    r = await request(app).post(`/invite/${fx.token}/accept`).send({ email: 'fixed@acme.com', acceptTerms: true, dpdpConsent: true, kyc: { gstin: '33ABCDE1234F1Z5' } });
    assert(r.status === 200, 'clause 6A.5 is optional: an Advanced contractor can accept without confirming it');
    const fxDoc: any = (await contractorsCol().find({ email: 'fixed@acme.com' }).toArray())[0];
    assert(fxDoc.feeModels?.length === 1 && fxDoc.feeModels[0].model === 'FIXED_PER_APPROVED' && !fxDoc.representation6A5At, 'not confirming 6A.5 puts the contractor on the fixed fee (6A.6) from the acceptance date');
    const fxAcc: any = (await db.collection('agreementAcceptances').find({ email: 'fixed@acme.com' }).toArray())[0];
    assert(fxAcc.representation6A5 === false, 'and the acceptance record says the confirmation was not given');
    const tfx = require('child_process').spawnSync('pdftotext', ['-layout', '-', '-'], { input: fs.readFileSync(fxDoc.agreementFile) }).stdout.toString().replace(/\s+/g, ' ');
    assert(/Fixed fee per Approved Recommendation under clause 6A\.6, from the Effective Date/.test(tfx) && /Not applicable \(the fixed fee applies\)/.test(tfx) && /If the Contractor does not give this confirmation when accepting this Agreement, clause 6A\.6 applies/.test(tfx), 'the agreement they accepted shows the fixed fee, not the Profit Share');
    assert((await db.collection('notifications').find({ type: 'fee_model' }).toArray()).length === 1, 'the owner is told to set the fixed amount');
    r = await request(app).post(`/invite/${biz.token}/accept`).send(bgood({ ...bizKyc, gstin: '33ABCDE1234F1Y5' }));
    assert(r.status === 400, 'a malformed GSTIN is refused');
    r = await request(app).post(`/invite/${biz.token}/accept`).send(bgood({ ...bizKyc, sebiNumber: 'INA000012345' }));
    assert(r.status === 400 && /INH/.test(r.body.error), 'an INA registration is refused');
    r = await request(app).post(`/invite/${biz.token}/accept`).send(bgood());
    assert(r.status === 200 && r.body.type === 'BUSINESS' && r.body.sebi.verified === false && decodeURIComponent(cookieFromRes(r)).includes('|90'), 'Business accepted; SEBI recorded but unverified; 90-day session');
    const bizStored: any = (await contractorsCol().find({ email: 'forecaster@acme.com' }).toArray())[0];
    const tb = require('child_process').spawnSync('pdftotext', ['-layout', '-', '-'], { input: fs.readFileSync(bizStored.agreementFile) }).stdout.toString().replace(/\s+/g, ' ');
    assert(/The Contractor: Acme Research LLP, registered office 5 Market Road, Mumbai \(PAN ABCDE1234F; GSTIN 33ABCDE1234F1Z5\), acting through D Forecaster, its Research Analyst \(the “Contractor”\)/.test(tb) && /registration number INH000012345, valid until 2027-03-31/.test(tb), 'Business: entity, address, PAN (derived from the GSTIN), GSTIN, the one Research Analyst name and SEBI details fill the Parties clause');
    assert(/through its Research Analyst, D Forecaster/.test(tb) && !/Signatures/.test(tb) && !/third part/i.test(tb) && !/7 days’ notice/.test(tb) && !/not give the same Recommendation/.test(tb), 'clause 3.4 names the forecaster; no Signatures section, no 4.3 third-party clause, no 7-day notice, no old 9.3');
    const noBlanks = (t: string) => !/\[[^\]]*\]/.test(t) && !/_{3,}/.test(t) && !/undefined|null|NaN/.test(t);
    assert(noBlanks(tb) && noBlanks(t1.replace(/\s+/g, ' ')), 'no placeholder, blank line or "undefined" in either personalised PDF');
    assert(/Research Analyst Services Agreement/.test(tb) && !/Forecasting Services Agreement/.test(tb) && /Forecasting Services Agreement/.test(t1), 'the Business document is a Research Analyst Services Agreement; the Individual one stays a Forecasting Services Agreement');
    assert(/Karthikeyan S, an individual resident in Chennai, Tamil Nadu, carrying on business under the name “Nivedha Tech”; and/.test(tb) && !/PAN:/.test(tb.split('The Contractor:')[0]), 'the owner is named without an address or PAN');
    assert(/25% of net Trade Profit per Settlement Week/.test(tb) && /3 per Trading Day/.test(tb) && /09:20 to 15:00 IST/.test(tb) && /Term\s+6 months/.test(tb), 'the Schedule carries real values from config');
    assert(!/Signatures/.test(t1), 'the Individual agreement has no Signatures section either');
    const bizUser: any = await db.collection('users').findOne({ email: 'forecaster@acme.com' });
    assert(bizUser.advancedVia === 'gstin' && bizUser.proficiencyLevel === 'advanced' && bizUser.entityType === 'company', 'the users record is set up for the existing GSTIN invoice rule');
    r = await request(app).post(`/invite/${(await createInvite({ type: 'INDIVIDUAL', createdBy: 'o' })).token}/accept`).send(good());
    assert(r.status === 409, 'an already-registered email is told to ask for a re-invite');

    console.log('only the tax identity is required:');
    const min = await createInvite({ type: 'BUSINESS', createdBy: 'o' });
    r = await request(app).post(`/invite/${min.token}/accept`).send({ email: 'min@acme.com', acceptTerms: true, dpdpConsent: true, representation6A5: true, kyc: {} });
    assert(r.status === 400 && /GSTIN/.test(r.body.error), 'without a GSTIN a Business contractor cannot accept');
    r = await request(app).post(`/invite/${min.token}/accept`).send({ email: 'min@acme.com', acceptTerms: true, dpdpConsent: true, representation6A5: true, kyc: { gstin: '33ABCDE1234F1Z5' } });
    assert(r.status === 200 && r.body.name === 'min' && r.body.missingDetails.includes('bank account') && r.body.missingDetails.includes('address'), 'with only the GSTIN (and email) it is accepted, and the profile lists what is still missing ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
    const minCk = cookieFromRes(r);
    const minDoc: any = (await contractorsCol().find({ email: 'min@acme.com' }).toArray())[0];
    const tm = require('child_process').spawnSync('pdftotext', ['-layout', '-', '-'], { input: fs.readFileSync(minDoc.agreementFile) }).stdout.toString().replace(/\s+/g, ' ');
    assert(!/\[[^\]]*\]/.test(tm) && !/_{3,}/.test(tm) && !/undefined|null/.test(tm) && /GSTIN 33ABCDE1234F1Z5/.test(tm) && !/registered office/.test(tm) && !/registration number/.test(tm), 'with only the GSTIN given the PDF simply leaves out what is unknown: no blanks');
    r = await request(app).post('/contractor/profile').set('Cookie', minCk).send({ entityName: 'Min Research LLP', analystName: 'Mina Analyst', address: '7 Late Street, Pune', bankHolder: 'Min Research LLP', bankAccount: '555555555555', bankIfsc: 'HDFC0001234' });
    assert(r.status === 200 && r.body.name === 'Mina Analyst' && r.body.kyc.bankAccountMasked === 'XXXXXXXX5555' && !r.body.missingDetails.includes('bank account'), 'the rest is completed on the profile page');
    r = await request(app).post('/contractor/profile').set('Cookie', minCk).send({ bankAccount: '666666666666', bankHolder: 'X', bankIfsc: 'HDFC0001234' });
    assert(r.status === 409, 'bank details already on file can only be changed through the owner-approved request');
    r = await request(app).post('/contractor/profile').set('Cookie', minCk).send({ gstin: '33ZZZZZ9999Z1Z5', pan: 'ZZZZZ9999Z' });
    assert(r.status === 400, 'the tax identity cannot be edited here');
    r = await request(app).post('/contractor/profile').set('Cookie', minCk).send({ bankAccount: '12' });
    assert(r.status === 409 || r.status === 400, 'a bad bank value is refused');
    const bad = await createInvite({ type: 'BUSINESS', createdBy: 'o' });
    r = await request(app).post(`/invite/${bad.token}/accept`).send({ email: 'bad@acme.com', acceptTerms: true, dpdpConsent: true, representation6A5: true, kyc: { gstin: '33ABCDE1234F1Z5', bankAccount: '12' } });
    assert(r.status === 400, 'what IS given is still checked (a bad account number)');

    console.log('auto-activation and the cap:');
    const activeNow = (await contractorsCol().find({ status: 'ACTIVE' }).toArray()).length;
    assert(activeNow >= 3, `accepted contractors were active at once (${activeNow})`);
    (db.collection('contractors') as any).docs.length = 0; // a clean slate for the cap cases
    for (let i = 0; i < 5; i++) await contractorsCol().insertOne({ id: `fill${i}`, email: `fill${i}@x.com`, status: 'ACTIVE', type: 'INDIVIDUAL' });
    const full = await createInvite({ type: 'INDIVIDUAL', createdBy: 'o' });
    r = await request(app).post(`/invite/${full.token}/accept`).send({ email: 'sixth@x.com', name: 'Sixth', acceptTerms: true, dpdpConsent: true, kyc: indKyc });
    assert(r.status === 200 && r.body.status === 'INVITED', 'with 5 active contractors a new acceptance waits (INVITED): the cap is never exceeded');
    assert((await db.collection('notifications').find({ type: 'contractor_accepted', user: 'boss@x.com' }).toArray()).some((n: any) => /cap of 5/.test(n.message)), 'and the owner is told a place is needed');
    (db.collection('contractors') as any).docs.length = 0;
    console.log('owner: cap and statuses:');
    const bizContractor: any = { ...bizStored, status: 'INVITED' };
    await contractorsCol().insertOne(bizContractor);
    await contractorsCol().insertOne({ ...stored, status: 'INVITED' }); // the first Individual, for the KYC reveal below
    for (let i = 0; i < 5; i++) await contractorsCol().insertOne({ id: `fill${i}`, email: `fill${i}@x.com`, status: 'ACTIVE', type: 'INDIVIDUAL' });
    await contractorsCol().insertOne({ id: 'testu', email: 'test@x.com', status: 'ACTIVE', type: 'INDIVIDUAL', isTest: true });
    assert(await activeCount() === 5, 'the test user is not counted against the cap');
    r = await request(app).post(`/owner/contractors/${bizContractor.id}/activate`).set('Cookie', adminCookie).send({});
    assert(r.status === 409 && /cap of 5/.test(r.body.error), 'the 6th activation is blocked while 5 are active');
    await contractorsCol().updateOne({ id: 'fill0' }, { $set: { status: 'PAUSED' } });
    r = await request(app).post(`/owner/contractors/${bizContractor.id}/activate`).set('Cookie', adminCookie).send({});
    assert(r.status === 200 && r.body.status === 'ACTIVE', 'activation succeeds once a place is free');
    r = await request(app).post(`/owner/contractors/${bizContractor.id}/pause`).set('Cookie', adminCookie).send({});
    assert(r.status === 400, 'pausing needs a reason');
    r = await request(app).post(`/owner/contractors/${bizContractor.id}/pause`).set('Cookie', adminCookie).send({ reason: 'review' });
    assert(r.status === 200 && r.body.status === 'PAUSED' && r.body.statusReason === 'review', 'pause with a reason');
    r = await request(app).post(`/owner/contractors/${bizContractor.id}/terminate`).set('Cookie', adminCookie).send({ date: '2026-12-01' });
    assert(r.status === 200 && r.body.status === 'TERMINATED' && r.body.terminatedAt === '2026-12-01', 'terminate with a date');
    r = await request(app).post(`/owner/contractors/${bizContractor.id}/activate`).set('Cookie', adminCookie).send({});
    assert(r.status === 409, 'a terminated contractor cannot be reactivated');
    r = await request(app).post(`/owner/contractors/${bizContractor.id}/reinvite`).set('Cookie', adminCookie).send({});
    assert(r.status === 404, 'a terminated contractor cannot be re-invited');
    const termUser: any = await db.collection('users').findOne({ email: 'forecaster@acme.com' });
    assert(termUser.enabled === false, 'termination disables the user record');
    r = await request(app).get(`/owner/contractors/${stored.id}/kyc`).set('Cookie', adminCookie);
    assert(r.status === 200 && r.body.pan === 'ABCDE1234F' && r.body.bankAccount === '123456789012', 'the owner can reveal the decrypted KYC');
    r = await request(app).get('/owner/contractors').set('Cookie', adminCookie);
    assert(r.status === 200 && !JSON.stringify(r.body).includes('ABCDE1234F') && !JSON.stringify(r.body).includes('Enc'), 'the list shows masked KYC only');

    console.log(failed ? `\n${failed} FAILED` : '\nALL TESTS PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
