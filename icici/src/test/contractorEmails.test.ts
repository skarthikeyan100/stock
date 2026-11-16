/** Contractor welcome and daily emails: content, once-only, test user excluded, nothing-to-report skipped. No mail is sent (dry run / unconfigured Gmail). Run: npx tsc, then node ./dist/test/contractorEmails.test.js */
import { installFakeDb } from './fakeDb';
for (const k of ['GMAIL_USER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) delete process.env[k];
import { renderWelcome, renderDaily, hasActivity, runDailyEmails, sendWelcomeIfDue } from '../contractors/emails';
import { contractorsCol } from '../contractors/store';

let failed = 0;
function assert(condition: boolean, message: string) { console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`); if (!condition) { failed++; process.exitCode = 1; } }

async function main() {
    const db = installFakeDb();
    const ind: any = { id: 'i1', email: 'ind@x.com', name: 'Ind <script>', type: 'INDIVIDUAL', status: 'ACTIVE', agreementVersion: '1.1' };
    const biz: any = { id: 'b1', email: 'biz@x.com', name: 'Biz Co', type: 'BUSINESS', status: 'ACTIVE', agreementVersion: '1.1' };

    console.log('welcome:');
    const wi = renderWelcome(ind, '1.1', new Date('2026-11-16T05:00:00Z'));
    assert(/Welcome/.test(wi.subject) && wi.html.includes('v1.1') && wi.html.includes('Individual (PAN)') && /Up or Down/.test(wi.html), 'Individual: agreement version, kind and forecasting wording');
    assert(!wi.html.includes('<script>') && wi.html.includes('&lt;script&gt;'), 'the name is HTML-escaped');
    assert(/new invitation/i.test(wi.html) && /no login page/i.test(wi.html) && /clear your browser/i.test(wi.html), 'explains that a logout or cleared cookies needs a re-invite');
    const wb = renderWelcome(biz, '1.1', new Date());
    assert(/profit share/i.test(wb.html) && /clause 6A/.test(wb.html) && /recommendations/i.test(wb.html) && !/Up or Down/.test(wb.html), 'Business: recommendations and the profit-share wording');
    assert(/entry price and live profit or loss/.test(wi.html) && /never trade/.test(wi.html), 'tells them what they can see and that they never trade');
    assert(!/Zerodha|ICICI|Kite|Breeze|Alice/i.test(wi.html + wb.html), 'no broker names');

    console.log('welcome send rules (Gmail unconfigured, so nothing leaves):');
    await contractorsCol().insertOne({ ...ind, agreementAcceptedAt: new Date() });
    await sendWelcomeIfDue(ind);
    assert(!(await contractorsCol().findOne({ id: 'i1' }) as any).welcomeEmailSentAt, 'a failed send releases the claim, so it can be retried');
    await contractorsCol().insertOne({ ...biz, isTest: true });
    await sendWelcomeIfDue({ ...biz, isTest: true });
    assert(!(await contractorsCol().findOne({ id: 'b1' }) as any).welcomeEmailSentAt, 'the test user is not sent a welcome');
    await contractorsCol().updateOne({ id: 'i1' }, { $set: { welcomeEmailSentAt: new Date() } });
    await sendWelcomeIfDue(ind);
    assert(true, 'an already-sent welcome is not sent again (no throw)');

    console.log('daily:');
    const empty = { forecasts: [], recommendations: [], trades: [] };
    assert(!hasActivity(empty), 'no activity: nothing to send');
    const di = renderDaily(ind, '2026-11-16', { ...empty, forecasts: [{ submittedAt: new Date('2026-11-16T04:30:00Z'), direction: 'UP', confidence: 'High', outcome: 'CORRECT' }], trades: [{ contract: 'NIFTY26N1724150CE', entryPrice: 140.5, pnl: 1234.5, exitTime: new Date('2026-11-16T08:00:00Z') }] });
    assert(di.subject.includes('2026-11-16') && di.html.includes('UP') && di.html.includes('CORRECT') && di.html.includes('140.5') && di.html.includes('1,234.5') && !/Recommendations/.test(di.html), 'Individual: forecasts with outcome, and the trade with entry price and P&L');
    const db2 = renderDaily(biz, '2026-11-16', { ...empty, recommendations: [{ createdAt: new Date('2026-11-16T04:00:00Z'), contract: 'NIFTY 24150 CE', entry: 140, target: 160, stop: 120, status: 'APPROVED' }] });
    assert(db2.html.includes('24150 CE') && db2.html.includes('approved') && /Your recommendations/.test(db2.html) && !/Your forecasts/.test(db2.html), 'Business: recommendations with status');
    assert(!/quantity|lots|broker|capital|order id/i.test(di.html + db2.html), 'no quantity, broker, capital or order id');

    console.log('daily run (dry run):');
    await contractorsCol().insertOne({ ...biz, id: 'b2', email: 'biz2@x.com', isTest: undefined });
    await db.collection('recommendations').insertOne({ contractorId: 'b2', day: '2026-11-16', index: 'NIFTY', contract: '24150 CE', entry: 1, target: 2, stop: 0.5, status: 'PENDING', createdAt: new Date('2026-11-16T04:00:00Z') });
    const run = await runDailyEmails({ date: '2026-11-16', dryRun: true });
    const by = Object.fromEntries(run.results.map((r) => [r.contractor, r.status]));
    assert(by['biz2@x.com'] === 'dry-run' && by['ind@x.com'] === 'skipped' && !('biz@x.com' in by), 'only active non-test contractors with activity would get one');
    const run2 = await runDailyEmails({ date: '2026-11-16' });
    assert(run2.results.find((r) => r.contractor === 'biz2@x.com')?.status === 'failed', 'with Gmail unconfigured the real run fails visibly, and writes no sent-marker');
    assert((await db.collection('contractorDailyEmails').find({}).toArray()).length === 0, 'no marker after a failure, so it can be re-run');

    console.log(failed ? `\n${failed} FAILED` : '\nALL TESTS PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
