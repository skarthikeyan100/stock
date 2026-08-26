/**
 * Verifies AntContractMaster logs a warning when its backing file is older
 * than the staleness threshold.
 * Run: npm run build (compile), then: node ./dist/test/contractMasterStaleness.test.js
 */

import fs from 'fs';
import path from 'path';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const logged: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: any[]) => { logged.push(args.join(' ')); originalWarn(...args); };

// Backdate the real NFO_contract.json's mtime temporarily to exercise the
// staleness path, then restore it - safer than depending on the file
// already being stale (it might genuinely be fresh in this checkout).
const nfoPath = path.join(__dirname, '../../data/ant/NFO_contract.json');
const original = fs.statSync(nfoPath);
const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
fs.utimesSync(nfoPath, oldTime, oldTime);

const AntContractMaster = require('../ant/AntContractMaster').default;
try {
    // Bogus params - deliberately won't match any record. loadNFO() (and the
    // staleness check inside it) runs before the "not found" throw.
    AntContractMaster.getInstance().findOption({
        symbol: '__STALENESS_TEST__', exch: 'NFO', strike: '0', optionType: 'CE', expiryEpochMs: 0,
    });
} catch (e) {
    // Expected - "Contract not found", not what this test is checking.
}

fs.utimesSync(nfoPath, original.atime, original.mtime); // restore immediately, before any assertion can throw and skip this

assert(logged.some(l => l.includes('is') && l.includes('days old')), 'logs a staleness warning for a 30-day-old contract file');
console.warn = originalWarn;

if (process.exitCode === 1) {
    console.log('SOME TESTS FAILED');
} else {
    console.log('ALL TESTS PASSED');
}
