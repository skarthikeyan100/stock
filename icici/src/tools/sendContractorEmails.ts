/**
 * The contractors' daily transactions email, FROM THIS MACHINE ONLY (no HTTP endpoint), like the EOD summary.
 *   npm run contractor-email -- [--date=YYYY-MM-DD] [--dry-run] [--force]
 * Each ACTIVE, non-test contractor with something to report gets their own items for the day. While settings.eodEmailTestRecipient is set every email
 * goes only to that address (subject prefixed [TEST for <contractor>]). Logic: src/contractors/emails.ts.
 */
import 'dotenv/config';
import '../util/tz'; // pin IST: week buckets, invoice reminders and EOD dates use local time
import Mongo from './mongo';
import { runDailyEmails } from '../contractors/emails';

async function main(): Promise<void> {
    await Mongo.init();
    const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    const out = await runDailyEmails({ date: arg('date'), dryRun: process.argv.includes('--dry-run'), force: process.argv.includes('--force') });
    console.log(`date ${out.date}`);
    for (const r of out.results) console.log(`${r.status.padEnd(8)} ${r.contractor}${r.to ? ` -> ${r.to}` : ''}${r.reason ? `  (${r.reason})` : ''}`);
    if (!out.results.length) console.log('no active contractors');
    if (out.results.some((r) => r.status === 'failed')) process.exitCode = 1;
}
main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => Mongo.getInstance().close().catch(() => undefined)).finally(() => setTimeout(() => process.exit(), 200));
