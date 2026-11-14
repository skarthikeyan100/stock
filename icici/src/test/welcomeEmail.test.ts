/**
 * Welcome email (src/welcomeEmail.ts, src/legalPdf.ts): rules in the body with the user's own amounts, escaping, the logo, and the three signed PDFs.
 * Run: npx tsc && node ./dist/test/welcomeEmail.test.js
 */
import { levelRules } from '../levelRules';
import 'dotenv/config';
import { renderWelcomeEmail, tradingRules, WelcomeFacts } from '../welcomeEmail';
import { agreementBlocks, buildAgreementPdf, buildLegalPdf, loadLegal } from '../legalPdf';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }

const f: WelcomeFacts = { name: 'Asha <b>K</b>', email: 'a@example.com', date: '2026-11-14', profitSplitPercent: 40, allocatedCapital: 200000, weeklyLimitPercent: 50, profitSplit: { beginner: 35, advanced: 25 }, levelCapital: { beginner: 100000, advanced: 200000 } };

console.log('body');
const r = renderWelcomeEmail(f);
assert(r.subject === 'Welcome to Nivedha Tech Trading Platform', `subject (got ${r.subject})`);
assert(tradingRules(f).length === 5 && r.html.includes('₹1,00,000') && r.html.includes('proficiency level'), "weekly rule carries this user's amount (₹1,00,000); the daily rule is generic (proficiency level)");
assert(!/(15|25)% of your allocated|₹50,000/.test(r.html), 'no fixed daily limit in the body');
assert(r.html.includes('Asha &lt;b&gt;K&lt;/b&gt;') && !r.html.includes('<b>K</b>'), 'name is HTML-escaped');
assert(r.html.includes('cid:nivedha-logo') && r.html.includes('Agreement') && r.html.includes('Privacy Policy'), 'logo and the three attachments are named');
assert(r.html.includes('Getting started') && r.html.includes('Keeping your account safe') && r.html.includes('admin@nivedhatech.com') && !/password:|Password:/.test(r.html), 'general information, safety tips and support contact; no credentials in the email');
assert(!/\{\{\w+\}\}/.test(r.html + r.subject), 'no unreplaced placeholders');

assert(r.html.includes('35%') && r.html.includes('25%') && !r.html.includes('Maximum payment'), 'profit share rule shows both levels, no max payment');

console.log('level rules (config.yml settings.levelRules)');
const cfg = { maxDailyDrawdownPercent: '30%', levelRules: { beginner: { maxDailyDrawdownPercent: '10%' }, advanced: { maxWeeklyDrawdownPercent: 60 } } };
const lb = levelRules(cfg, 'beginner'), la = levelRules(cfg, 'advanced');
assert(lb.maxDailyDrawdownPercent === 10 && lb.maxWeeklyDrawdownPercent === 30 && lb.capital === 100000, 'beginner: own daily %, weekly falls back to the level default, capital 100000');
assert(la.maxDailyDrawdownPercent === 30 && la.maxWeeklyDrawdownPercent === 60 && la.capital === 200000, 'advanced: daily falls back to settings, own weekly %, capital 200000');
assert(levelRules(undefined, undefined).level === 'beginner' && levelRules({}, 'ADVANCED').capital === 200000 && levelRules({}, 'junk').capital === 100000, 'absent config / unknown level -> built-in defaults, level defaults to beginner');

console.log('legal text');
const terms = loadLegal('terms'), privacy = loadLegal('privacy');
assert(terms.blocks.length > 100 && privacy.blocks.length > 50, 'terms and privacy extracted from the website pages');
assert(![...terms.blocks, ...privacy.blocks].some((b) => /[<>{}]/.test(b.text)), 'no leftover markup in the extracted text');
const ag = agreementBlocks({ name: 'Asha', email: 'a@example.com', date: '2026-11-14', profitSplitPercent: 35, allocatedCapital: 200000, weeklyLimitPercent: 50, profitSplit: { beginner: 35, advanced: 25 }, levelCapital: { beginner: 100000, advanced: 200000 } }).map((b) => b.text).join('\n');
assert(ag.includes('retains 35%') && ag.includes('Company retains 65%') && ag.includes('₹2,00,000'), "agreement carries the user's split and capital");
assert(!ag.includes('parallel trades') && !/Daily loss limit: 25%/.test(ag) && ag.includes('proficiency level (Beginner or Advanced)'), 'no parallel-trades sentence; the daily limit is generic');
assert(ag.includes('at the time of payment applies to the entire payment week'), 'payment clause: proficiency level at payment time covers the whole week');
const termsText = terms.blocks.map((b) => b.text).join('\n'), privacyText = privacy.blocks.map((b) => b.text).join('\n');
assert(!/parallel trades/.test(termsText) && termsText.includes('at the time of payment applies to the entire payment week'), 'terms: no parallel-trades sentence, payment clause present');
assert(!/Broker Partners:|Compliance\/KYC Partners|translated versions|\[support|Company Address|propfirm\.com/.test(privacyText + termsText), 'privacy/terms: broker and KYC sharing, translation note, address and placeholder emails are gone');

(async () => {
    console.log('PDFs');
    process.env.PDF_SIGN_P12 = process.env.PDF_SIGN_P12 || './certs/report-signing.p12';
    for (const p of [await buildAgreementPdf({ name: 'Asha', email: 'a@example.com', date: '2026-11-14', profitSplitPercent: 40, allocatedCapital: 100000, weeklyLimitPercent: 50, profitSplit: { beginner: 35, advanced: 25 }, levelCapital: { beginner: 100000, advanced: 200000 } }), await buildLegalPdf('terms', '2026-11-14'), await buildLegalPdf('privacy', '2026-11-14')]) {
        const t = p.pdf.toString('latin1');
        assert(p.pdf.subarray(0, 5).toString() === '%PDF-' && /\/ByteRange \[0 \d+ \d+ \d+\]/.test(t) && t.includes('/Type /Sig'), `${p.filename} is a signed PDF`);
    }
    console.log(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
})();
