#!/usr/bin/env node
// Is dist/ what the current src/ compiles to? `tsc -w` can stop watching a file without any error (2026-11-26: after a `git merge` replaced
// three strategy files, later edits never reached dist/, every build still said "Found 0 errors", and a restart loaded the old code).
// This builds src/ into a new directory under the OS temp dir (never into dist/) and compares every emitted .js with its dist/ copy.
//
// Usage: node scripts/check-dist-fresh.js          one check, run it before any restart. Exit 0 = fresh, 1 = stale, 2 = could not check.
//        node scripts/check-dist-fresh.js --watch  runs until killed: checks again once a change in src/ or dist/ has settled, and prints an
//                                                  `ALERT:` line while dist/ is stale (scripts/monitor-strategies-alerts.sh runs this).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const SETTLE_MS = 60_000;    // tsc -w is given this long after the last source change (its slowest incremental build seen: ~25 s)
const POLL_MS = 15_000;      // --watch polls stat() results: file watching is the thing being checked, so it is not relied on here
const REPEAT_MS = 15 * 60_000; // --watch repeats an unchanged ALERT this often
const BUILD_TIMEOUT_MS = 5 * 60_000;
const LISTED = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => console.log(`[${new Date().toTimeString().slice(0, 8)}] [dist-check] ${line}`);

function walk(dir, keep, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, keep, out);
        else if (keep(p)) out.push(p);
    }
    return out;
}

// One line per file: any write, replacement or mtime-preserving copy changes it (ctime and inode included).
function fingerprint(files) {
    let newest = 0;
    const lines = files.sort().map((p) => {
        try {
            const s = fs.statSync(p);
            newest = Math.max(newest, s.mtimeMs, s.ctimeMs);
            return `${p} ${s.ino} ${s.size} ${s.mtimeMs} ${s.ctimeMs}`;
        } catch { return `${p} gone`; }
    });
    return { text: lines.join('\n'), newest };
}
const sources = () => fingerprint([...walk(SRC, () => true), path.join(ROOT, 'tsconfig.json'), path.join(ROOT, 'global.d.ts')]);
const outputs = () => fingerprint(walk(DIST, (p) => p.endsWith('.js')));

let buildDir;
let compiler;
function cleanUp() {
    if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true });
    buildDir = undefined;
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { if (compiler) compiler.kill('SIGKILL'); cleanUp(); process.exit(2); });
}

function compile(outDir) {
    return new Promise((resolve, reject) => {
        const tsc = require.resolve('typescript/lib/tsc.js', { paths: [ROOT] });
        // --outDir always points into the fresh temp directory: this script never writes into the repository.
        compiler = spawn(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.json'), '--outDir', outDir, '--noEmit', 'false'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        compiler.stdout.on('data', (d) => { output += d; });
        compiler.stderr.on('data', (d) => { output += d; });
        const timer = setTimeout(() => compiler.kill('SIGKILL'), BUILD_TIMEOUT_MS);
        compiler.on('error', (e) => { clearTimeout(timer); compiler = undefined; reject(e); });
        compiler.on('close', (code) => { clearTimeout(timer); compiler = undefined; resolve({ code, output }); });
    });
}

// The trader's manual hot restart appends a comment line to a dist/ entry file: that is not staleness.
const normalised = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith('// hot-restart marker')).join('\n').trimEnd();

function differences(builtDir) {
    const stale = [];
    const built = walk(builtDir, (p) => p.endsWith('.js'));
    for (const file of built) {
        const rel = path.relative(builtDir, file);
        const live = path.join(DIST, rel);
        if (!fs.existsSync(live)) stale.push(`dist/${rel} (missing)`);
        else if (normalised(live) !== normalised(file)) stale.push(`dist/${rel}`);
    }
    return { total: built.length, stale: stale.sort() };
}

// Builds a settled src/ and compares. A source edit during the build or the wait starts over.
async function check() {
    for (let attempt = 1; attempt <= 5; attempt++) {
        const before = sources();
        cleanUp();
        buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icici-dist-check-'));
        const { code, output } = await compile(buildDir);
        let result = differences(buildDir);
        if (result.total === 0) throw new Error(`the build produced no output (tsc exit ${code}): ${output.slice(0, 300)}`);
        // A difference right after an edit may only be tsc -w still compiling.
        const wait = before.newest + SETTLE_MS - Date.now();
        if (result.stale.length && wait > 0) {
            await sleep(Math.min(wait, SETTLE_MS));
            result = differences(buildDir);
        }
        cleanUp();
        if (sources().text === before.text) return { ...result, compileFailed: code !== 0 };
    }
    throw new Error('src/ kept changing during 5 builds');
}

function report({ total, stale, compileFailed }, listAll) {
    if (compileFailed) say('note: src/ has TypeScript errors (npx tsc --noEmit -p . lists them)');
    if (!stale.length) { say(`OK: dist/ matches src/ (${total} files)`); return; }
    const shown = listAll ? stale : stale.slice(0, LISTED);
    const more = stale.length > shown.length ? ` (+${stale.length - shown.length} more)` : '';
    say(`ALERT: STALE dist/ - ${stale.length} file(s) differ from a build of src/, a restart now loads this code: ${shown.join(', ')}${more}. `
        + 'If tsc -w reports no change for them it has stopped watching them: restart `npm run processes` when safe (a one-off tsc can be overwritten by that tsc -w).');
}

async function once() {
    try {
        const result = await check();
        report(result, true);
        process.exitCode = result.stale.length ? 1 : 0;
    } catch (e) {
        cleanUp();
        say(`ALERT: could not check dist/ against src/: ${e.message}`);
        process.exitCode = 2;
    }
}

async function watch() {
    os.setPriority(10); // inherited by the compiler: the trading processes come first
    let checked; // fingerprint of src/ + dist/ at the last check
    let alert;   // the standing problem: printed when it appears or changes, then every REPEAT_MS until a check passes
    for (;;) {
        const src = sources();
        const dist = outputs();
        const now = `${src.text}\n${dist.text}`;
        if (now !== checked && Date.now() - Math.max(src.newest, dist.newest) >= SETTLE_MS) {
            checked = now;
            try {
                const result = await check();
                const key = result.stale.join(',');
                if (!key) { if (alert) report(result, false); alert = undefined; }
                else if (alert?.key !== key) alert = { key, at: 0, print: () => report(result, false) };
            } catch (e) {
                cleanUp();
                if (alert?.key !== e.message) alert = { key: e.message, at: 0, print: () => say(`ALERT: could not check dist/ against src/: ${e.message}`) };
            }
        }
        if (alert && Date.now() - alert.at >= REPEAT_MS) { alert.print(); alert.at = Date.now(); }
        await sleep(POLL_MS);
    }
}

if (process.argv.includes('--watch')) void watch();
else void once();
