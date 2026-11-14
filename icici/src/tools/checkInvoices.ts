/**
 * Runs the invoice check once (src/invoiceRule.ts): reminds GSTIN-Advanced users whose invoice is due within a day and closes the account of any user
 * past the deadline. The frontend process also runs it hourly; this is the on-demand run.   npm run check-invoices
 */
import 'dotenv/config';
import Mongo from './mongo';
import { runInvoiceCheck } from '../invoiceRule';

async function main(): Promise<void> {
    await Mongo.init();
    const out = await runInvoiceCheck();
    console.log(`reminded: ${out.reminded.join(', ') || 'none'}`);
    console.log(`closed:   ${out.closed.join(', ') || 'none'}`);
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => Mongo.getInstance().close().catch(() => undefined)).finally(() => setTimeout(() => process.exit(), 200));
