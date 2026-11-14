/**
 * Upgrade requests and approval (src/levelUpgrade.ts), against an in-memory fake Db.
 * Run: npx tsc && node ./dist/test/levelUpgrade.test.js
 */
import { installFakeDb } from './fakeDb';
import { canRequestUpgrade, createUpgradeRequest, decideUpgradeRequest, applyAdvanced, listUpgradeRequests, gstinUpgradeDecision } from '../levelUpgrade';
import { getUser } from '../user';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }
async function throws(fn: () => Promise<unknown>, part: string): Promise<boolean> { try { await fn(); return false; } catch (e: any) { return String(e?.message ?? e).includes(part); } }

async function main() {
    const db = installFakeDb();
    const users = db.collection('users');
    const seed = (email: string, extra: Record<string, any> = {}) => users.insertOne({ email, name: email, role: 'user', enabled: true, proficiencyLevel: 'beginner', accountCapital: 100000, investmentAmount: 100000, profitSplitPercent: 35, ...extra });

    console.log('canRequestUpgrade');
    assert(canRequestUpgrade({ proficiencyLevel: undefined }).ok, 'a Beginner can request');
    assert(!canRequestUpgrade({ proficiencyLevel: 'ADVANCED' }).ok && /already/i.test(canRequestUpgrade({ proficiencyLevel: 'advanced' }).reason ?? ''), 'an Advanced user cannot ("already")');
    assert(!canRequestUpgrade({ proficiencyLevel: 'beginner', accountClosed: true }).ok, 'a closed account cannot');

    console.log('createUpgradeRequest');
    await seed('a@x.com'); await seed('closed@x.com', { accountClosed: true }); await seed('adv@x.com', { proficiencyLevel: 'advanced' });
    const r1 = await createUpgradeRequest('a@x.com');
    assert(typeof r1.id === 'string' && r1.id.length > 0, 'returns the request id');
    assert(await throws(() => createUpgradeRequest('a@x.com'), 'already'), 'a second pending request is refused');
    assert(await throws(() => createUpgradeRequest('closed@x.com'), 'closed'), 'a closed account is refused');
    assert(await throws(() => createUpgradeRequest('adv@x.com'), 'already'), 'an Advanced user is refused');
    assert(await throws(() => createUpgradeRequest('nobody@x.com'), 'not found'), 'an unknown user is refused');
    const stored: any = db.collection('upgradeRequests').docs[0];
    assert(stored.status === 'pending' && stored.acceptance?.termsSha256?.length === 64 && stored.acceptance.acceptedAt instanceof Date, 'stored pending with the acceptance timestamp and a sha256');

    console.log('listUpgradeRequests');
    const listed = await listUpgradeRequests('pending');
    assert(listed.length === 1 && listed[0].user === 'a@x.com' && listed[0].successfulWeeks === 0, 'lists the pending request with the user\'s successful weeks');

    console.log('decideUpgradeRequest approve');
    const ok = await decideUpgradeRequest(r1.id, 'approve', 'admin@x.com');
    const u: any = await getUser('a@x.com');
    assert(u.proficiencyLevel === 'advanced' && u.accountCapital === 200000 && u.investmentAmount === 200000 && u.profitSplitPercent === 25, 'approval makes the user Advanced with 2L capital and a 25% share');
    assert(u.advancedVia === 'admin' && u.advancedSince instanceof Date && u.advancedAcceptance?.termsSha256 === stored.acceptance.termsSha256, 'records how and when, and the accepted terms hash from the request');
    assert(ok.request.status === 'approved' && ok.request.decidedBy === 'admin@x.com', 'request marked approved by the admin');
    assert(await throws(() => decideUpgradeRequest(r1.id, 'approve', 'admin@x.com'), 'already decided'), 'a second approve of the same request is refused');
    assert(await throws(() => decideUpgradeRequest(r1.id, 'reject', 'admin@x.com'), 'already decided'), 'rejecting a decided request is refused');

    console.log('approve with a custom capital, reject');
    await seed('b@x.com'); await seed('c@x.com');
    const rb = await createUpgradeRequest('b@x.com'); const rc = await createUpgradeRequest('c@x.com');
    await decideUpgradeRequest(rb.id, 'approve', 'admin@x.com', { capital: 250000 });
    assert((await getUser('b@x.com'))?.accountCapital === 250000, 'the admin can set another capital');
    await seed('d@x.com');
    const rd = await createUpgradeRequest('d@x.com');
    assert(await throws(() => decideUpgradeRequest(rd.id, 'approve', 'admin@x.com', { capital: -5 }), 'capital'), 'a non-positive capital is refused');
    assert((await getUser('d@x.com'))?.proficiencyLevel === 'beginner' && (await db.collection('upgradeRequests').findOne({ user: 'd@x.com' }) as any)?.status === 'pending', 'the refused approval changed nothing: still a Beginner, request still pending');
    const rej = await decideUpgradeRequest(rc.id, 'reject', 'admin@x.com', { note: 'not yet' });
    assert(rej.request.status === 'rejected' && rej.request.note === 'not yet' && (await getUser('c@x.com'))?.proficiencyLevel === 'beginner', 'reject keeps the user a Beginner and stores the note');
    assert((await createUpgradeRequest('c@x.com')).id !== rc.id, 'after a rejection the user may request again');

    console.log('applyAdvanced');
    await seed('g@x.com');
    const g1: any = await applyAdvanced('g@x.com', { via: 'gstin' });
    assert(g1.proficiencyLevel === 'advanced' && g1.advancedVia === 'gstin' && g1.accountCapital === 200000, 'GSTIN path: Advanced at once with the default capital');
    const since = g1.advancedSince;
    const g2: any = await applyAdvanced('g@x.com', { via: 'admin', capital: 999999 });
    assert(g2.advancedVia === 'gstin' && g2.accountCapital === 200000 && String(g2.advancedSince) === String(since), 'idempotent: a second call changes nothing');

    console.log('gstinUpgradeDecision');
    const me = { callerEmail: 'u@x.com', email: 'u@x.com', user: { proficiencyLevel: 'beginner', entityType: 'company' as const }, gstin: '27AAAAA0000A1Z5', accepted: true };
    assert(gstinUpgradeDecision(me).action === 'upgrade', 'a company Beginner giving a GSTIN themself and accepting: upgrade at once');
    const notAccepted = gstinUpgradeDecision({ ...me, accepted: undefined });
    assert(notAccepted.action === 'reject' && /accept/i.test(notAccepted.reason ?? ''), 'not accepted: refused with a message to accept the Advanced terms');
    assert(gstinUpgradeDecision({ ...me, callerEmail: 'admin@x.com' }).action === 'none', 'an admin editing the GSTIN never changes the level');
    assert(gstinUpgradeDecision({ ...me, user: { ...me.user, proficiencyLevel: 'advanced' } }).action === 'none', 'an Advanced user: nothing to do');
    assert(gstinUpgradeDecision({ ...me, gstin: '  ' }).action === 'none' && gstinUpgradeDecision({ ...me, gstin: undefined }).action === 'none' && gstinUpgradeDecision({ ...me, gstin: '' }).action === 'none', 'a blank / cleared / absent GSTIN: nothing to do');
    assert(gstinUpgradeDecision({ ...me, user: { ...me.user, entityType: 'individual' as const } }).action === 'none', 'an individual account: nothing to do (the profile save itself refuses it)');
    const closed = gstinUpgradeDecision({ ...me, user: { ...me.user, accountClosed: true } });
    assert(closed.action === 'reject' && /closed/i.test(closed.reason ?? ''), 'a closed account: refused');

    if (!failed) console.log('ALL PASS');
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
