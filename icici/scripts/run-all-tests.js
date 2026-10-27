#!/usr/bin/env node
// Runs every standalone assert-script test (src/test/*.test.ts, compiled to dist/test/*.test.js) as its own node process and fails
// if ANY exits non-zero. These scripts signal failure through process.exitCode, which jest ignores (so `jest` reported 0 tests and
// could never fail them); nothing aggregated them, so a regression only showed up if someone ran the right file by hand.
// Usage: npm run test:all            (compiles first)
//        node scripts/run-all-tests.js --no-build
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcTests = path.join(root, 'src', 'test');
const distTests = path.join(root, 'dist', 'test');

if (!process.argv.includes('--no-build')) execSync('npx tsc', { cwd: root, stdio: 'inherit' });

// Compiled tests whose source is gone are stale leftovers (tsc never deletes output): drop them so they cannot run or mask results.
const sources = new Set(fs.readdirSync(srcTests).filter((f) => f.endsWith('.test.ts')).map((f) => f.replace(/\.ts$/, '.js')));
for (const f of fs.readdirSync(distTests).filter((f) => f.endsWith('.test.js'))) {
    if (!sources.has(f)) {
        console.log(`[test:all] removing stale compiled test with no source: dist/test/${f}`);
        for (const ext of ['', '.map']) fs.rmSync(path.join(distTests, f + ext), { force: true });
    }
}

const failed = [];
const files = [...sources].sort();
for (const f of files) {
    const started = Date.now();
    const res = spawnSync('node', [path.join(distTests, f)], { cwd: root, stdio: 'inherit', env: { MOCK_BROKER: 'true', ...process.env } });
    const ok = res.status === 0;
    console.log(`[test:all] ${ok ? 'PASS' : 'FAIL'} ${f} (${((Date.now() - started) / 1000).toFixed(1)}s)${ok ? '' : ` exit=${res.status ?? res.signal}`}`);
    if (!ok) failed.push(f);
}
console.log(`[test:all] ${files.length - failed.length}/${files.length} passed${failed.length ? `; FAILED: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
