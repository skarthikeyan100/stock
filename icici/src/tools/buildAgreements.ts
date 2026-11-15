/**
 * Builds the signed v1.1 agreement PDFs into agreements/v1.1/ (run: `npx tsc && node dist/tools/buildAgreements.js`).
 * The PDFs are the files the Platform serves and hashes at acceptance, so they are built once and committed; a rebuild gives a new hash.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { buildAgreementPdf } from '../agreements/agreementPdf';
import { BUSINESS_V1_1 } from '../agreements/content/business-v1.1';
import { INDIVIDUAL_V1_1 } from '../agreements/content/individual-v1.1';

async function main() {
    const outDir = path.resolve(__dirname, '..', '..', 'agreements', 'v1.1');
    fs.mkdirSync(outDir, { recursive: true });
    const date = '2026-11-16';
    const manifest: Record<string, { file: string; sha256: string }> = {};
    for (const [type, doc, file] of [
        ['INDIVIDUAL', INDIVIDUAL_V1_1, 'Forecasting-Agreement-Individual-PAN-v1.1.pdf'],
        ['BUSINESS', BUSINESS_V1_1, 'Forecasting-Agreement-Business-GSTIN-v1.1.pdf'],
    ] as const) {
        const { pdf, sha256 } = await buildAgreementPdf(doc, date);
        fs.writeFileSync(path.join(outDir, file), pdf);
        manifest[type] = { file, sha256 };
        console.log(`${file}  ${pdf.length} bytes  sha256 ${sha256}`);
    }
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ version: '1.1', files: manifest }, null, 2) + '\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
