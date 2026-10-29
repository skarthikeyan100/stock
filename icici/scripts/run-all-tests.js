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
if (!fs.existsSync(srcTests)) {
    console.error(`[test:all] ${srcTests} does not exist`);
    process.exit(2);
}

if (!process.argv.includes('--no-build')) execSync('npx tsc', { cwd: root, stdio: 'inherit' });

// Compiled tests whose source is gone are stale leftovers (tsc never deletes output): drop them so they cannot run or mask results.
if (!fs.existsSync(distTests)) {
    console.error('[test:all] dist/test does not exist - run without --no-build (or run tsc) first');
    process.exit(2);
}
const sources = new Set(fs.readdirSync(srcTests).filter((f) => f.endsWith('.test.ts')).map((f) => f.replace(/\.ts$/, '.js')));
for (const f of fs.readdirSync(distTests).filter((f) => f.endsWith('.test.js'))) {
    if (!sources.has(f)) {
        console.log(`[test:all] removing stale compiled test with no source: dist/test/${f}`);
        for (const ext of ['', '.map']) fs.rmSync(path.join(distTests, f + ext), { force: true });
    }
}

const failed = [];
const files = [...sources].sort();
// Several tests print ALL TESTS PASSED but never exit (a Mongo handle or the config watcher keeps the event loop alive). With no
// timeout the runner hung forever on the first of them, so each test gets TEST_TIMEOUT_MS; one that was killed by the timeout counts
// as passed only if it said so and printed no failed assertion.
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS) || 60_000;
for (const f of files) {
    const started = Date.now();
    const res = spawnSync('node', [path.join(distTests, f)], {
        cwd: root, env: { MOCK_BROKER: 'true', ...process.env }, timeout: TEST_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    process.stdout.write(out);
    const timedOut = res.error && res.error.code === 'ETIMEDOUT';
    const hangAfterPass = timedOut && /ALL TESTS PASSED/.test(out) && !/^\s*FAIL/m.test(out);
    const ok = res.status === 0 || hangAfterPass;
    console.log(`[test:all] ${ok ? 'PASS' : 'FAIL'} ${f} (${((Date.now() - started) / 1000).toFixed(1)}s)${hangAfterPass ? ' (passed, then did not exit)' : ok ? '' : timedOut ? ` timed out after ${TEST_TIMEOUT_MS / 1000}s` : ` exit=${res.status ?? res.signal}`}`);
    if (!ok) failed.push(f);
}
console.log(`[test:all] ${files.length - failed.length}/${files.length} passed${failed.length ? `; FAILED: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
