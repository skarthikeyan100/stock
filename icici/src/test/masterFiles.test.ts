/**
 * Required contract masters are checked once at start-up (user instruction 2026-10-16): every missing / empty file is named in one
 * error, an old file is only an ALERT, and nothing degrades silently.
 * Run: node ./dist/test/masterFiles.test.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { verifyMasterFiles, requiredMasterFiles } from '../util/masterFiles';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'masters-'));
const good = path.join(dir, 'good.json'); fs.writeFileSync(good, '{"NFO":[]}');
const empty = path.join(dir, 'empty.json'); fs.writeFileSync(empty, '');
const old = path.join(dir, 'old.json'); fs.writeFileSync(old, 'x');
const longAgo = new Date(Date.now() - 40 * 86_400_000); fs.utimesSync(old, longAgo, longAgo);
const missing = path.join(dir, 'missing.json');

verifyMasterFiles([{ file: good, maxAgeDays: 14, howToGet: 'n/a' }]);
assert(true, 'a present, non-empty, fresh file passes');

let err = '';
try { verifyMasterFiles([{ file: missing, maxAgeDays: 14, howToGet: 'run the downloader' }, { file: empty, maxAgeDays: 14, howToGet: 'run the downloader' }, { file: good, maxAgeDays: 14, howToGet: 'n/a' }]); } catch (e: any) { err = e.message; }
assert(err.includes(missing) && err.includes('is missing') && err.includes(empty) && err.includes('is empty') && err.includes('run the downloader'), 'every missing or empty file is named in one error, with the fix');
assert(!err.includes(good), 'a good file is not reported');

const logged: string[] = [];
const realLog = console.log;
console.log = (...a: any[]) => { logged.push(a.join(' ')); realLog(...a); };
let threw = false;
try { verifyMasterFiles([{ file: old, maxAgeDays: 14, howToGet: 'n/a' }]); } catch { threw = true; }
console.log = realLog;
assert(logged.some((l) => l.includes('days old') && l.includes(old)), 'an old file (40 days, limit 14) is logged as an ALERT naming the file and its age');
assert(!threw, 'an old file is only an ALERT, not a start failure (a holiday start finds yesterday\'s file)');

assert(requiredMasterFiles().some((f) => f.file.endsWith('ant/NSE_contract.json')), 'the NSE equity master is on the required list (it used to degrade to an empty table)');
try {
    verifyMasterFiles();
    assert(true, 'the real master files in this checkout all verify');
} catch (e: any) {
    assert(false, 'the real master files in this checkout verify: ' + e.message);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
