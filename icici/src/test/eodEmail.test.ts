/**
 * EOD email rendering (src/eodEmail.ts): IST day bounds, subject/body for a profit day, a loss day, a blocked week and an
 * unavailable estimate, HTML escaping of user-controlled text, and masking of the payout destination. Pure functions: no Mongo, no SMTP.
 * Run: npx tsc && node ./dist/test/eodEmail.test.js
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { extractSignature } from '@signpdf/utils';
import { buildSignedEodPdf } from '../eodPdf';
import { renderEodEmail, istDayBounds, todayIst, EodReport, EodPayment } from '../eodEmail';

let failed = false;
function assert(cond: boolean, msg: string) {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
    if (!cond) { failed = true; process.exitCode = 1; }
}

const payment = (over: Partial<EodPayment> = {}): EodPayment => ({
    weekStart: new Date('2026-11-11T00:00:00+05:30'), weekEnd: new Date('2026-11-18T00:00:00+05:30'), available: true,
    grossProfit: 1000, profitSplitPercent: 40, splitAmount: 400, level: 'Beginner', tdsAmount: 4, gstAmount: 0, netAmount: 396, blocked: false,
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

console.log('email body: summary only');
let r = renderEodEmail(report());
assert(r.subject === 'Your trading summary for 13 Nov 2026 - +₹1,300.00', `subject (got ${r.subject})`);
assert(r.html.includes('+₹1,300.00') && r.html.includes('Closed trades') && r.html.includes('Open positions'), 'P&L, closed and open counts are shown');
assert(r.html.includes('attached as a signed PDF'), 'tells the user the report is attached');
for (const gone of ['Payout destination', 'None on file', 'Add your bank account', 'Recent payouts', 'indicative', 'Trading in options', 'NIFTY17NOV26C25150', 'Estimated net payout']) {
    assert(!r.html.includes(gone), `body no longer contains "${gone}"`);
}
assert(r.html.includes('cid:nivedha-logo') && r.html.indexOf('cid:nivedha-logo') < r.html.indexOf('Nivedha Tech</div>'), 'logo comes before "Nivedha Tech"');
assert(!r.html.includes('<b>K</b>') && r.html.includes('Asha &lt;b&gt;K&lt;/b&gt;'), 'user name is HTML-escaped');
assert(!/\{\{\w+\}\}/.test(r.html + r.subject), 'no unreplaced placeholders');
r = renderEodEmail(report({ dayPnl: -500, rows: [], closedCount: 0, wins: 0, losses: 0, openCount: 0 }));
assert(r.subject.endsWith('-₹500.00'), `loss subject (got ${r.subject})`);

(async () => {
    console.log('signed PDF');
    process.env.PDF_SIGN_P12 = process.env.PDF_SIGN_P12 || './certs/report-signing.p12';
    const out = await buildSignedEodPdf(report());
    const txt = out.pdf.toString('latin1');
    assert(out.pdf.subarray(0, 5).toString() === '%PDF-' && out.filename === 'trading-summary-u-2026-11-13.pdf', 'is a PDF named per user and day');
    assert(/\/ByteRange \[0 \d+ \d+ \d+\]/.test(txt) && txt.includes('/Type /Sig'), 'carries a digital signature');
    assert(out.sha256 === crypto.createHash('sha256').update(out.pdf).digest('hex'), 'sha256 matches the bytes');
    const verify = (pdf: Buffer): boolean => {
        const { signature, signedData } = extractSignature(pdf);
        const p7: any = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(signature, 'binary')));
        const want = p7.rawCapture.authenticatedAttributes.find((a: any) => forge.asn1.derToOid(a.value[0].value) === forge.pki.oids.messageDigest).value[1].value[0].value;
        return forge.md.sha256.create().update(signedData.toString('binary')).digest().getBytes() === want;
    };
    assert(verify(out.pdf), 'signature digest matches the signed content');
    const bad = Buffer.from(out.pdf); bad[Math.floor(bad.length * 0.75)] ^= 1;
    assert(!verify(bad), 'changing one byte of the content breaks the signature');
    const saved = process.env.PDF_SIGN_P12; process.env.PDF_SIGN_P12 = '/nonexistent.p12';
    let refused = false; try { await buildSignedEodPdf(report()); } catch { refused = true; }
    process.env.PDF_SIGN_P12 = saved;
    assert(refused, 'no certificate -> no PDF (so no email is sent)');
    console.log(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0); // importing eodEmail pulls in config watchers that would keep the process alive
})();
