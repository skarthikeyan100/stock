/**
 * Writes the Terms & Conditions PDFs for the Beginner and the Advanced level into the repo root:
 *   node dist/tools/makeLevelTerms.js
 * Numbers come from config.yml settings.levelRules (read here, not from the running processes).
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { buildLevelTermsPdf } from '../legalPdf';

async function main(): Promise<void> {
    const root = path.resolve(__dirname, '..', '..');
    const config = yaml.load(fs.readFileSync(path.join(root, 'config.yml'), 'utf8')) as { settings?: Record<string, any> };
    const date = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); // IST date
    for (const level of ['beginner', 'advanced'] as const) {
        const out = await buildLevelTermsPdf(level, config.settings ?? {}, date);
        const file = path.join(root, out.filename);
        fs.writeFileSync(file, out.pdf);
        console.log(`${file} ${out.pdf.length} bytes sha256 ${out.sha256}`);
    }
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => process.exit());
