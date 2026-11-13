/**
 * EOD email rendering (src/eodEmail.ts): IST day bounds, subject/body for a profit day, a loss day, a blocked week and an
 * unavailable estimate, HTML escaping of user-controlled text, and masking of the payout destination. Pure functions: no Mongo, no SMTP.
 * Run: npx tsc && node ./dist/test/eodEmail.test.js
 */
import { renderEodEmail, istDayBounds, todayIst, EodReport, EodPayment } from '../eodEmail';

let failed = false;
function assert(cond: boolean, msg: string) {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
    if (!cond) { failed = true; process.exitCode = 1; }
}

const payment = (over: Partial<EodPayment> = {}): EodPayment => ({
    weekStart: new Date('2026-11-11T00:00:00+05:30'), weekEnd: new Date('2026-11-18T00:00:00+05:30'), available: true,
    grossProfit: 1000, profitSplitPercent: 40, splitAmount: 400, tdsAmount: 4, gstAmount: 0, netAmount: 396, blocked: false,
    destination: 'Bank account ******1234 (HDFC0001), Asha', recent: [], ...over,
});
const report = (over: Partial<EodReport> = {}): EodReport => ({
    user: 'u@example.com', name: 'Asha <b>K</b>', date: '2026-11-13',
    rows: [
        { contract: 'NIFTY17NOV26C25150', quantity: 65, entryPrice: 100, exitPrice: 120, pnl: 1300, entryTime: new Date('2026-11-13T09:20:00+05:30'), exitTime: new Date('2026-11-13T09:40:00+05:30') },
        { contract: 'NIFTY17NOV26P25150', quantity: 65, entryPrice: 50, exitPrice: null, pnl: null, entryTime: new Date('2026-11-13T14:00:00+05:30'), exitTime: null },
    ],
    closedCount: 1, wins: 1, losses: 0, openCount: 1, dayPnl: 1300, payment: payment(), ...over,
});

console.log('day bounds');
const b = istDayBounds('2026-11-13');
assert(b.start.toISOString() === '2026-11-12T18:30:00.000Z' && b.end.toISOString() === '2026-11-13T18:30:00.000Z', 'IST day = 18:30Z to 18:30Z');
assert(todayIst(new Date('2026-11-13T19:00:00Z')) === '2026-11-14', 'todayIst rolls over at IST midnight');
let threw = false; try { istDayBounds('13-11-2026'); } catch { threw = true; }
assert(threw, 'bad date format rejected');

console.log('profit day');
let r = renderEodEmail(report());
assert(r.subject === 'Your trading summary for 13 Nov 2026 - +₹1,300.00', `subject (got ${r.subject})`);
assert(r.html.includes('+₹1,300.00') && r.html.includes('09:20 &rarr; 09:40') && r.html.includes('Open'), 'P&L, time range and the open row are shown');
assert(r.html.includes('Estimated net payout') && r.html.includes('₹396.00') && r.html.includes('******1234'), 'payout estimate and masked destination');
assert(!r.html.includes('<b>K</b>') && r.html.includes('Asha &lt;b&gt;K&lt;/b&gt;'), 'user name is HTML-escaped');
assert(!/\{\{\w+\}\}/.test(r.html + r.subject), 'no unreplaced placeholders');

console.log('loss day, nothing due');
r = renderEodEmail(report({ dayPnl: -500, rows: [], closedCount: 0, wins: 0, losses: 0, openCount: 0, payment: payment({ grossProfit: -500, blocked: true, blockReason: 'This period has no profit to pay out (gross ₹-500.00).', netAmount: 0 }) }));
assert(r.subject.endsWith('-₹500.00'), `loss subject (got ${r.subject})`);
assert(r.html.includes('No trades.') && r.html.includes('no net profit yet'), 'empty table and the no-profit wording');

console.log('drawdown forfeiture');
r = renderEodEmail(report({ payment: payment({ blocked: true, grossProfit: 900, netAmount: 0, blockReason: 'Week lost - exceeds the weekly loss limit.' }) }));
assert(r.html.includes('exceeds the weekly loss limit'), 'the forfeiture reason is shown');

console.log('estimate unavailable / no destination');
r = renderEodEmail(report({ payment: payment({ available: false }) }));
assert(r.html.includes('Not available right now'), 'unavailable estimate is stated');
r = renderEodEmail(report({ payment: payment({ destination: '' }) }));
assert(r.html.includes('None on file') && r.html.includes('Add your bank account or UPI ID'), 'no destination prompts to add one');

console.log(failed ? 'FAILED' : 'ALL PASSED');
process.exit(failed ? 1 : 0); // importing eodEmail pulls in config watchers that would keep the process alive
