/**
 * Capital-increase requests (src/capitalRequests.ts): Advanced users only, after 2 successful weeks, admin decides. In-memory fake Db.
 * Run: npx tsc && node ./dist/test/capitalRequests.test.js
 */
import { installFakeDb } from './fakeDb';
import { canRequestCapital, createCapitalRequest, decideCapitalRequest, listCapitalRequests } from '../capitalRequests';
import { getUser } from '../user';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }
async function failsWith(fn: () => Promise<unknown>): Promise<string> { try { await fn(); return ''; } catch (e: any) { return String(e?.message ?? e); } }

async function main() {
    console.log('canRequestCapital');
    assert(canRequestCapital({ level: 'beginner', successfulWeeks: 5, requiredWeeks: 2 }).reason === 'Only Advanced users can request more capital', 'beginner: exact reason');
    assert(canRequestCapital({ level: 'advanced', accountClosed: true, successfulWeeks: 5, requiredWeeks: 2 }).reason === 'Your account is closed', 'closed: exact reason');
    assert(canRequestCapital({ level: 'advanced', successfulWeeks: 1, requiredWeeks: 2 }).reason === 'You need 2 successful weeks (you have 1)', 'advanced with 1 of 2 weeks: exact reason');
    assert(canRequestCapital({ level: 'advanced', successfulWeeks: 2, requiredWeeks: 2 }).ok, 'advanced with 2 weeks: ok');

    const db = installFakeDb();
    const users = db.collection('users');
    const seed = (email: string, extra: Record<string, any> = {}) => users.insertOne({ email, name: email, role: 'user', enabled: true, proficiencyLevel: 'advanced', accountCapital: 200000, investmentAmount: 200000, ...extra });
    const trades = db.collection('closedTrades');
    const goodWeeks = async (email: string) => { await trades.insertOne({ user: email, exitTime: new Date('2025-01-02T11:00:00+05:30'), realizedPnL: 5000 }); await trades.insertOne({ user: email, exitTime: new Date('2025-01-09T11:00:00+05:30'), realizedPnL: 3000 }); };

    console.log('createCapitalRequest');
    await seed('a@x.com'); await seed('beg@x.com', { proficiencyLevel: 'beginner' }); await seed('closed@x.com', { accountClosed: true });
    assert((await failsWith(() => createCapitalRequest('a@x.com', 300000))) === 'You need 2 successful weeks (you have 0)', 'no successful weeks yet: refused with the progress');
    assert((await failsWith(() => createCapitalRequest('beg@x.com', 300000))).includes('Advanced'), 'a Beginner is refused');
    await goodWeeks('a@x.com'); await goodWeeks('closed@x.com');
    assert((await failsWith(() => createCapitalRequest('closed@x.com', 300000))).includes('closed'), 'a closed account is refused');
    for (const bad of [200000, 150000, NaN, 0, -1, 2000001, Infinity]) assert((await failsWith(() => createCapitalRequest('a@x.com', bad))) !== '', `amount ${bad} refused (must be above the current capital and at most 10x)`);
    const r1 = await createCapitalRequest('a@x.com', 300000);
    assert(typeof r1.id === 'string' && r1.id.length > 0, 'two successful weeks: the request is stored');
    assert((await failsWith(() => createCapitalRequest('a@x.com', 350000))).includes('already'), 'a second pending request is refused');

    console.log('listCapitalRequests');
    const rows = await listCapitalRequests('pending');
    assert(rows.length === 1 && rows[0].requestedAmount === 300000 && rows[0].successfulWeeks === 2 && rows[0].currentCapital === 200000, 'lists the request with the successful weeks and the current capital');

    console.log('decideCapitalRequest');
    const ok = await decideCapitalRequest(r1.id, 'approve', 'admin@x.com', { amount: 250000 });
    const u: any = await getUser('a@x.com');
    assert(u.accountCapital === 250000 && u.investmentAmount === 250000 && ok.status === 'approved', 'approve writes the admin-chosen amount to both capital fields');
    assert((await failsWith(() => decideCapitalRequest(r1.id, 'approve', 'admin@x.com'))).includes('already decided'), 'a second decision is refused');
    const r2 = await createCapitalRequest('a@x.com', 400000);
    assert((await failsWith(() => decideCapitalRequest(r2.id, 'approve', 'admin@x.com', { amount: -1 }))).includes('amount'), 'a non-positive approved amount is refused');
    const rej = await decideCapitalRequest(r2.id, 'reject', 'admin@x.com', { note: 'later' });
    assert(rej.status === 'rejected' && (await getUser('a@x.com') as any).accountCapital === 250000, 'reject keeps the capital and stores the note');

    if (!failed) console.log('ALL PASS');
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
