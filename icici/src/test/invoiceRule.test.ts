/**
 * Invoice rule for GSTIN-Advanced users (src/invoiceRule.ts): an invoice for every paid payout within 2 days (end of day IST), or the account is closed.
 * Run: npx tsc && node ./dist/test/invoiceRule.test.js
 */
import { installFakeDb } from './fakeDb';
import { markPayoutPaidWithProof } from '../payout';
import { invoiceDueAt, invoiceRequired, overduePayouts, runInvoiceCheck } from '../invoiceRule';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }
const iso = (d: Date) => d.toISOString();

async function main() {
    console.log('invoiceDueAt');
    assert(iso(invoiceDueAt(new Date('2026-11-11T09:00:00+05:30'))) === iso(new Date('2026-11-13T23:59:59+05:30')), 'paid Wednesday morning -> due Friday 23:59:59 IST');
    assert(iso(invoiceDueAt(new Date('2026-11-11T23:30:00+05:30'))) === iso(new Date('2026-11-13T23:59:59+05:30')), 'paid late Wednesday night -> still Friday');
    assert(iso(invoiceDueAt(new Date('2026-11-11T19:00:00Z'))) === iso(new Date('2026-11-14T23:59:59+05:30')), '19:00 UTC is already Thursday 00:30 IST -> due Saturday (IST day, not UTC day)');
    assert(iso(invoiceDueAt(new Date('2026-12-30T10:00:00+05:30'))) === iso(new Date('2027-01-01T23:59:59+05:30')), 'crosses a year end');

    console.log('invoiceRequired');
    const g = { advancedVia: 'gstin', gstin: '27AAAAA0000A1Z5', entityType: 'company', proficiencyLevel: 'advanced' };
    assert(invoiceRequired(g) === true, 'GSTIN-Advanced company: required');
    for (const [k, v] of [['advancedVia', 'admin'], ['proficiencyLevel', 'beginner']] as const) assert(invoiceRequired({ ...g, [k]: v }) === false, `not required when ${k} is ${JSON.stringify(v)}`);

    for (const [k, v] of [['gstin', ''], ['gstin', undefined], ['entityType', 'individual']] as const) assert(invoiceRequired({ ...g, [k]: v }) === true, `still required after the user clears/changes ${k} (advanced-by-GSTIN is permanent)`);

    console.log('overduePayouts');
    const now = new Date('2026-11-14T00:00:00+05:30');
    const list = [
        { id: 'late', invoiceStatus: 'pending', invoiceDueAt: new Date('2026-11-13T23:59:59+05:30') },
        { id: 'soon', invoiceStatus: 'pending', invoiceDueAt: new Date('2026-11-15T23:59:59+05:30') },
        { id: 'got', invoiceStatus: 'received', invoiceDueAt: new Date('2026-11-01T23:59:59+05:30') },
        { id: 'none' },
    ];
    assert(overduePayouts(list, now).map((p: any) => p.id).join() === 'late', 'only a pending, past-due payout is overdue');

    console.log('runInvoiceCheck');
    const db = installFakeDb();
    const users = db.collection('users'); const payouts = db.collection('payouts');
    await users.insertOne({ email: 'g@x.com', name: 'G', enabled: true, proficiencyLevel: 'advanced', advancedVia: 'gstin', gstin: '27AAAAA0000A1Z5', entityType: 'company' });
    await users.insertOne({ email: 'closed@x.com', name: 'C', enabled: true, accountClosed: true, proficiencyLevel: 'advanced', advancedVia: 'gstin', gstin: '27AAAAA0000A1Z5', entityType: 'company' });
    const run = new Date('2026-11-13T12:00:00+05:30');
    await payouts.insertOne({ user: 'g@x.com', status: 'paid', invoiceNumber: 'INV-1', invoiceStatus: 'pending', invoiceDueAt: new Date('2026-11-13T23:59:59+05:30') });   // due in ~12h: reminder
    await payouts.insertOne({ user: 'g@x.com', status: 'paid', invoiceNumber: 'INV-2', invoiceStatus: 'pending', invoiceDueAt: new Date('2026-11-12T23:59:59+05:30') });   // overdue: close
    await payouts.insertOne({ user: 'g@x.com', status: 'paid', invoiceNumber: 'INV-3', invoiceStatus: 'received', invoiceDueAt: new Date('2026-11-01T23:59:59+05:30') });  // received: untouched
    await payouts.insertOne({ user: 'g@x.com', status: 'paid', invoiceNumber: 'INV-4', invoiceStatus: 'pending', invoiceDueAt: new Date('2026-11-20T23:59:59+05:30') });   // far away: untouched
    await payouts.insertOne({ user: 'closed@x.com', status: 'paid', invoiceNumber: 'INV-5', invoiceStatus: 'pending', invoiceDueAt: new Date('2026-11-12T23:59:59+05:30') }); // overdue but already closed
    const reminded: string[] = []; const closed: string[] = [];
    const deps = { remind: async (p: any) => { reminded.push(p.invoiceNumber); }, closeAccount: async (u: any, p: any) => { closed.push(`${u.email}:${p.invoiceNumber}`); } };
    const r1 = await runInvoiceCheck(run, deps);
    assert(reminded.join() === 'INV-1' && r1.reminded.length === 1, 'a payout due within 24h gets one reminder');
    assert(closed.join() === 'g@x.com:INV-2' && r1.closed.join() === 'g@x.com', 'an overdue pending invoice closes the account');
    assert(!closed.some((c) => c.includes('INV-3') || c.includes('INV-4') || c.includes('INV-5')), 'received, far-off and already-closed accounts are left alone');
    const r2 = await runInvoiceCheck(run, deps);
    assert(reminded.length === 1 && closed.length === 1 && r2.reminded.length === 0 && r2.closed.length === 0, 'a second run repeats nothing (reminder and closure are stamped)');
    const g2 = await payouts.findOne({ invoiceNumber: 'INV-1' }) as any;
    assert(g2.invoiceReminderSentAt instanceof Date, 'the reminder is stamped on the payout');
    await payouts.updateOne({ invoiceNumber: 'INV-2' }, { $set: { invoiceStatus: 'received' } });

    console.log('markPayoutPaidWithProof sets the deadline');
    await users.insertOne({ email: 'plain@x.com', name: 'P', enabled: true, proficiencyLevel: 'beginner', entityType: 'individual' });
    const gp = await payouts.insertOne({ user: 'g@x.com', status: 'pending', invoiceNumber: 'INV-9', netAmount: 100 });
    const pp = await payouts.insertOne({ user: 'plain@x.com', status: 'pending', invoiceNumber: 'INV-10', netAmount: 100 });
    const paidG: any = await markPayoutPaidWithProof(gp.insertedId, { fileId: 'f', paidTo: 'acct' }, 'admin@x.com');
    assert(paidG.invoiceStatus === 'pending' && paidG.invoiceDueAt instanceof Date && iso(paidG.invoiceDueAt) === iso(invoiceDueAt(paidG.paidAt)), 'a GSTIN-Advanced user\'s paid payout gets invoiceStatus pending and paidAt + 2 days');
    assert(((await payouts.findOne({ invoiceNumber: 'INV-9' })) as any).invoiceStatus === 'pending', 'and it is stored on the payout');
    const paidP: any = await markPayoutPaidWithProof(pp.insertedId, { fileId: 'f', paidTo: 'acct' }, 'admin@x.com');
    assert(paidP.invoiceStatus === undefined && paidP.invoiceDueAt === undefined, 'any other user gets no invoice fields');

    if (!failed) console.log('ALL PASS');
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
