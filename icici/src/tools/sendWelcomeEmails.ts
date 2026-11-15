/**
 * Sends the welcome emails (rules in the body, signed Agreement / Terms / Privacy PDFs) to new users FROM THIS MACHINE ONLY: no HTTP endpoint,
 * no command-line options.
 *
 *   npm run welcome-email
 *
 * Every enabled non-admin user without a folder under ./storage gets one; the folder (with copies of the PDFs) is created when the email goes out
 * and is the "already sent" marker. While settings.eodEmailTestRecipient is set in config.yml every email goes only to that address (subject prefixed
 * `[TEST for <user>]`) and the copies go under storage/_test/. Logic: src/welcomeEmail.ts, storage: src/mailStorage.ts.
 */
import 'dotenv/config';
import Mongo from './mongo';
import { sendWelcomeEmails } from '../welcomeEmail';

async function main(): Promise<void> {
    await Mongo.init(); // the user list is read from Mongo
    const out = await sendWelcomeEmails();
    console.log(`mode ${out.mode}${out.testRecipient ? ` (all mail to ${out.testRecipient})` : ''}`);
    for (const r of out.results) {
        console.log(`${r.status.padEnd(8)} ${r.user} -> ${r.to}${r.reason ? `  (${r.reason})` : ''}${r.subject ? `  "${r.subject}"` : ''}`);
        for (const p of r.pdfs ?? []) console.log(`           ${p.filename} ${p.bytes} bytes sha256 ${p.sha256}`);
    }
    if (!out.results.length) console.log('no users');
    if (out.results.some((r) => r.status === 'failed')) process.exitCode = 1;
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => Mongo.getInstance().close().catch(() => undefined)).finally(() => setTimeout(() => process.exit(), 200));
