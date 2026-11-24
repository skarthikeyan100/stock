/**
 * Sends the end-of-day trading summary emails FROM THIS MACHINE ONLY. There is deliberately no HTTP endpoint for it: no user (and no admin
 * session) can trigger an email through the API.
 *
 *   npm run eod-email -- [--date=YYYY-MM-DD] [--user=<email>] [--dry-run] [--force]
 *
 * Defaults to today (IST), every user who traded. While settings.eodEmailTestRecipient is set in config.yml every email goes only to that
 * address (subject prefixed `[TEST for <user>]`); remove the key to email real users. Logic and records: src/eodEmail.ts.
 */
import 'dotenv/config';
import '../util/tz'; // pin IST: week buckets, invoice reminders and EOD dates use local time
import Mongo from './mongo';
import { sendEodEmails, todayIst } from '../eodEmail';

async function main(): Promise<void> {
    await Mongo.init();
    const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    const flag = (name: string): boolean => process.argv.includes(`--${name}`);
    const out = await sendEodEmails({ date: arg('date') ?? todayIst(), user: arg('user'), dryRun: flag('dry-run'), force: flag('force') });
    console.log(`date ${out.date}, mode ${out.mode}${out.testRecipient ? ` (all mail to ${out.testRecipient})` : ''}`);
    for (const r of out.results) console.log(`${r.status.padEnd(8)} ${r.user} -> ${r.to}${r.reason ? `  (${r.reason})` : ''}${r.subject ? `  "${r.subject}"` : ''}${r.pdfSha256 ? `  pdf ${r.pdfBytes} bytes sha256 ${r.pdfSha256}` : ''}`);
    if (!out.results.length) console.log('no user traded that day');
    if (out.results.some((r) => r.status === 'failed')) process.exitCode = 1;
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => Mongo.getInstance().close().catch(() => undefined)).finally(() => setTimeout(() => process.exit(), 200));
