import fs from 'fs';
import path from 'path';
import Log from './Log';

// The contract-master files the trading process cannot work without (user instruction 2026-10-16: these must always exist, so no
// module codes a fallback for their absence). Checked ONCE at start-up, before any master is parsed: a missing or empty file stops the
// start with a message that names every problem and the fix, instead of each lookup re-checking and degrading at some later point.
// Breeze is not listed: it downloads and extracts its own masters when they are missing (BreezeContractMaster).
const DATA = path.join(__dirname, '../../data');

interface MasterFile {
    file: string;
    maxAgeDays: number; // older than this is only a warning (a weekend or holiday start legitimately finds yesterday's file)
    howToGet: string;
}

const ANT_HOW = 'download from https://v2api.aliceblueonline.com/restpy/static/contract_master/V2/ (see CLAUDE.md, Data Files)';
const KITE_HOW = 'run scripts/download-all-masters.sh';

export function requiredMasterFiles(): MasterFile[] {
    return [
        { file: path.join(DATA, 'ant/NFO_contract.json'), maxAgeDays: 14, howToGet: ANT_HOW },
        { file: path.join(DATA, 'ant/BFO_contract.json'), maxAgeDays: 14, howToGet: ANT_HOW },
        { file: path.join(DATA, 'ant/NSE_contract.json'), maxAgeDays: 30, howToGet: ANT_HOW },
        { file: path.join(DATA, 'kite/NFO_instruments.csv'), maxAgeDays: 14, howToGet: KITE_HOW },
        { file: path.join(DATA, 'kite/BFO_instruments.csv'), maxAgeDays: 14, howToGet: KITE_HOW },
        { file: path.join(DATA, 'prism/NFO_symbols.txt'), maxAgeDays: 30, howToGet: KITE_HOW },
    ];
}

// Throws (listing everything wrong at once) when a required master is missing or empty; logs an ALERT per file older than its limit.
export function verifyMasterFiles(files: MasterFile[] = requiredMasterFiles()): void {
    const problems: string[] = [];
    for (const f of files) {
        let st: fs.Stats;
        try {
            st = fs.statSync(f.file);
        } catch {
            problems.push(`${f.file} is missing - ${f.howToGet}`);
            continue;
        }
        if (st.size === 0) {
            problems.push(`${f.file} is empty - ${f.howToGet}`);
            continue;
        }
        const ageDays = Math.floor((Date.now() - st.mtimeMs) / 86_400_000);
        if (ageDays > f.maxAgeDays) {
            Log.log(`[masters] ALERT: ${f.file} is ${ageDays} days old (limit ${f.maxAgeDays}) - ${f.howToGet}`);
        }
    }
    if (problems.length > 0) throw new Error(`required contract master file(s) unavailable:\n  ${problems.join('\n  ')}`);
}
