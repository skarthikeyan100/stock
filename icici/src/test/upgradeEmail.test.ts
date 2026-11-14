/**
 * Upgrade email (src/upgradeEmail.ts): the message, its once-only marker (mailStorage claimUpgrade) and the Advanced-terms PDF.
 * Run: npx tsc && node ./dist/test/upgradeEmail.test.js
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-email-'));
process.env.STORAGE_DIR = tmp;
import { renderUpgradeEmail } from '../upgradeEmail';
import { claimUpgrade, commitClaim, releaseClaim, userFolderName, storageRoot, removeUserStorage } from '../mailStorage';
import { buildAdvancedAddendumPdf } from '../legalPdf';
import { advancedTermsSha256 } from '../levelUpgrade';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }

console.log('body');
const r = renderUpgradeEmail({ name: 'Asha <b>K</b>', capital: 200000, profitSplitPercent: 25, viaGstin: false });
assert(r.subject.length > 0 && !/\{\{\w+\}\}/.test(r.html + r.subject), 'subject present, no unreplaced placeholders');
assert(r.html.includes('Asha &lt;b&gt;K&lt;/b&gt;') && !r.html.includes('<b>K</b>'), 'name is HTML-escaped');
assert(r.html.includes('₹2,00,000') && r.html.includes('25%') && r.html.includes('Advanced is permanent') && r.html.includes('Search &amp; Buy'), 'new capital, profit share, permanence and the comparison table');
assert(!r.html.includes('invoice for every payment'), 'no invoice note for an admin-approved user');
const g = renderUpgradeEmail({ name: 'Co', capital: 200000, profitSplitPercent: 25, viaGstin: true });
assert(/invoice for every payment/.test(g.html) && /2 days/.test(g.html), 'a GSTIN user is told about the invoice due within 2 days');

console.log('claimUpgrade');
const c1 = claimUpgrade('a@x.com', false);
assert(c1.state === 'claimed' && !fs.existsSync(path.join(storageRoot(false), userFolderName('a@x.com'))), 'first claim succeeds and does NOT create the user folder (that folder marks the welcome email as sent)');
assert(claimUpgrade('a@x.com', false).state === 'inProgress', 'a second claim while sending is in progress');
releaseClaim(c1);
const c2 = claimUpgrade('a@x.com', false);
assert(c2.state === 'claimed', 'after a failed send the claim is released and can be retaken');
if (c2.state === 'claimed') fs.writeFileSync(path.join(c2.dir, 'x.txt'), 'x');
commitClaim(c2);
assert(claimUpgrade('a@x.com', false).state === 'sent', 'after a committed send it is marked sent');
assert(claimUpgrade('a@x.com', true).state === 'claimed', 'test mode uses its own folder, so testing never marks a real user');
assert(removeUserStorage('a@x.com') && claimUpgrade('a@x.com', false).state === 'claimed', 'removing a user\'s storage also clears the upgrade marker');

console.log('terms hash and PDF');
assert(/^[0-9a-f]{64}$/.test(advancedTermsSha256()), 'accepted-terms hash is a sha256');
(async () => {
    process.env.PDF_SIGN_P12 = process.env.PDF_SIGN_P12 || './certs/report-signing.p12';
    const pdf = await buildAdvancedAddendumPdf('2026-11-14');
    assert(pdf.filename === 'Advanced-Terms.pdf' && pdf.pdf.subarray(0, 5).toString() === '%PDF-' && pdf.pdf.toString('latin1').includes('/Type /Sig'), 'Advanced-Terms.pdf is a signed PDF');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
})();
