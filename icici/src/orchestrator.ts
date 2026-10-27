// Load .env into process.env before anything else - every child this spawns
// below inherits process.env at spawn time (see spawnChild's `{ ...process.env,
// ...extraEnv }`), so loading it here covers order/data/strategies/frontend
// too without each needing its own dotenv call. See .env.example for the full
// variable list and CLAUDE.md's Environment section for which are required.
import './util/tz'; // pin TZ=Asia/Kolkata before any other module reads the clock
import 'dotenv/config';

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { sleep } from './util/sleep';

// NOTE: do NOT force IPv4 globally here (e.g. via NODE_OPTIONS=--dns-result-
// order=ipv4first) - tried that 2026-09-25 to fix Kite's IPv4-only IP
// allowlist rejecting our IPv6 address, but it broke Breeze/ICICI in the same
// process: a Breeze order that filled fine minutes earlier (over whatever
// family was default, almost certainly IPv6 - this machine's public IPv4 is
// NAT'd/CGNAT and not the one ICICI has on file) started failing with
// "IP address used does not match with the static IP declared when this API
// key was created" the moment IPv4 was forced process-wide. Kite and Breeze
// apparently have opposite requirements, so the fix has to be scoped to only
// Kite's hostname - see src/processes/order/kiteDns.ts, applied in
// orderProcess.ts (the only process that calls api.kite.trade).

// The parent. Spawns data/order/strategies/frontend as sibling processes and
// wires their transports:
//   - data.stdout  -> strategies.stdin AND frontend.stdin AND order.stdin  (tick feed)
//   - strategies.stdout -> data.stdin AND order.stdout -> data.stdin       (subscribe/unsubscribe)
//   - order/strategies/frontend all get ORDER_IPC_SOCKET to find each other
//
// order's tick pipe exists solely for exitMonitor.ts (per-user useGTT=false
// trades watched in-app instead of via a broker GTT) - it's otherwise unused.
//
// Each child is watched and restarted independently (dev mode) - editing
// order code restarts only `order`, editing strategy code restarts only
// `strategies`, etc. The orchestrator itself is never restarted by tsc-watch;
// run it as a long-lived process alongside `tsc -w` (see package.json's
// "processes" script) so a save never tears down every child at once - that's
// the actual point of this split.

const DIST = path.join(__dirname); // this file itself runs from dist/orchestrator.js
const REPO_ROOT = path.join(DIST, '..'); // dist/ mirrors src/ 1:1, so this is the repo root
const ORDER_SOCKET_PATH = process.env.ORDER_IPC_SOCKET || '/tmp/icici-order.sock';
const STRATEGIES_SOCKET_PATH = process.env.STRATEGIES_IPC_SOCKET || '/tmp/icici-strategies.sock';
const COMMON_ENV = { ORDER_IPC_SOCKET: ORDER_SOCKET_PATH, STRATEGIES_IPC_SOCKET: STRATEGIES_SOCKET_PATH };

function log(tag: string, ...args: any[]) {
    console.log(`[orchestrator] [${tag}]`, ...args);
}

// stdio must be set deliberately per role: a 'pipe' stream that nobody ever
// reads fills its OS buffer and blocks the child's writes once full (this bit
// order/frontend in testing - their stdout was 'pipe' with no consumer, and
// normal Log.log output eventually deadlocked them). Only stdout that's
// actually piped somewhere (data, strategies, frontend, and now order - see
// exitMonitor.ts) should be 'pipe'; everything else goes straight to the
// terminal via 'inherit'. order/strategies/frontend redirect console.log to
// stderr at the very top of their entry files for exactly this reason - their
// stdout is a reserved protocol channel, not for logging.
// cwd is explicit (not inherited) so every child resolves repo-root-relative
// files (userToken.txt, .ant_session.json, config.yml, ...) the same way
// regardless of where `npm run processes` was invoked from.
// Every live child, so a shutdown signal can stop them all (and a hot restart can wait for the old one to be gone).
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
let shuttingDown = false;

interface ManagedChild extends ChildProcessWithoutNullStreams {
    intentionalStop?: boolean;
}

// onCrash: called (once) when the child exits without the orchestrator having asked it to - the role's own restart
// routine, so a dead process is respawned and re-piped with backoff instead of staying dead until the next code edit.
function spawnChild(name: string, scriptRelPath: string, stdio: ('pipe' | 'inherit' | 'ignore')[], extraEnv: Record<string, string> = {}, onCrash?: () => void): ChildProcessWithoutNullStreams {
    const child = spawn('node', [path.join(DIST, scriptRelPath)], {
        stdio,
        cwd: REPO_ROOT,
        env: { ...process.env, ...extraEnv },
    }) as ManagedChild;
    liveChildren.add(child);
    // A dead child's pipes raise EPIPE on write; unhandled, that would throw inside the orchestrator and take it (and
    // every sibling) down with it.
    for (const stream of [child.stdin, child.stdout]) {
        stream?.on('error', (e) => log(name, `pipe error (ignored): ${(e as Error).message}`));
    }
    child.on('error', (e) => log(name, `process error: ${e.message}`));
    child.on('exit', (code, signal) => {
        liveChildren.delete(child);
        log(name, `exited (code=${code} signal=${signal})`);
        if (!child.intentionalStop && !shuttingDown && onCrash) onCrash();
    });
    return child;
}

// Stops a child and resolves once it has really exited (SIGKILL after 5s), so a replacement is never spawned while the
// old process still holds its socket/port.
function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const managed = child as ManagedChild;
    managed.intentionalStop = true;
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
}

// Backoff for crash respawns: 1s, 2s, 4s ... capped at 30s; reset once a process has stayed up for a minute.
function makeRespawner(name: string, restart: () => Promise<void>, current: () => ChildProcessWithoutNullStreams | undefined): () => void {
    let failures = 0;
    let lastStart = Date.now();
    let pending = false;
    return () => {
        if (pending || shuttingDown) return;
        pending = true;
        if (Date.now() - lastStart > 60_000) failures = 0;
        const delay = Math.min(30_000, 1000 * 2 ** failures);
        failures++;
        log(name, `crashed - respawning in ${delay}ms`);
        setTimeout(async () => {
            pending = false;
            if (shuttingDown) return;
            // A hot restart may have replaced the crashed child while this timer waited: restarting again would stop the healthy one.
            const live = current();
            if (live && live.exitCode === null && live.signalCode === null) {
                log(name, 'respawn skipped - a live replacement is already running');
                return;
            }
            lastStart = Date.now();
            try { await restart(); } catch (e) { log(name, 'respawn failed:', e); }
        }, delay);
    };
}

// Watches `watchPaths` (compiled dist/ output) and calls onChange (debounced)
// whenever any of them changes - used to restart exactly one child.
function watchAndRestart(name: string, watchPaths: string[], onChange: () => void) {
    if (process.env.HOT_RESTART === 'false') return;
    const existing = watchPaths.filter((p) => fs.existsSync(p));
    let debounce: NodeJS.Timeout | null = null;
    for (const target of existing) {
        fs.watch(target, { recursive: true }, () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(onChange, 300);
        });
    }
    log('boot', `Watching ${name}:`, existing);
}

// Top-level compiled modules (dist/*.js) that several processes import directly.
const topLevel = (...files: string[]) => files.map((f) => path.join(DIST, f));

async function main() {
    // Each role is (re)started by one routine used for the first boot, a hot restart on a code change AND a crash
    // respawn: it stops the old process (waiting for it to be really gone), spawns the new one and re-pipes it.
    let data!: ChildProcessWithoutNullStreams;
    let order!: ChildProcessWithoutNullStreams;
    let frontend!: ChildProcessWithoutNullStreams;
    let strategies!: ChildProcessWithoutNullStreams;

    // Restarts of one role are serialised so a crash respawn and a hot restart can never overlap.
    const chains = new Map<string, Promise<void>>();
    const serial = (role: string, fn: () => Promise<void>): Promise<void> => {
        const next = (chains.get(role) ?? Promise.resolve()).then(fn, fn).catch((e) => log(role, 'restart failed:', e));
        chains.set(role, next);
        return next;
    };

    // --- data (stdin: commands from strategies; stdout: tick feed - both real protocol channels) ---
    const startData = () => {
        data = spawnChild('data', 'processes/dataProcess.js', ['pipe', 'pipe', 'inherit'], {}, respawnData);
        if (order) { data.stdout.pipe(order.stdin, { end: false }); order.stdout.pipe(data.stdin, { end: false }); }
        if (frontend) { data.stdout.pipe(frontend.stdin, { end: false }); frontend.stdout.pipe(data.stdin, { end: false }); }
        if (strategies) { data.stdout.pipe(strategies.stdin, { end: false }); strategies.stdout.pipe(data.stdin, { end: false }); }
    };
    const restartData = () => serial('data', async () => {
        const old = data;
        for (const other of [order, frontend, strategies]) {
            if (!other) continue;
            old.stdout.unpipe(other.stdin);
            other.stdout.unpipe(old.stdin);
        }
        await stopChild(old);
        startData();
        // The new data process has an empty subscription map: tell strategies to replay theirs (the second pass covers a data
        // process that was not yet serving its stdin the first time).
        for (const delayMs of [5_000, 20_000]) {
            setTimeout(() => {
                if (shuttingDown || !strategies || strategies.killed || !strategies.stdin.writable) return;
                strategies.stdin.write(JSON.stringify({ cmd: 'resync' }) + '\n');
            }, delayMs);
        }
    });
    const respawnData = makeRespawner('data', restartData, () => data);

    // --- order: the Unix-socket IPC server (strategies/frontend place orders through it) is the main reason it
    // exists, but its stdin/stdout are also wired into the tick-feed pipe like strategies/frontend, solely so
    // exitMonitor.ts can watch useGTT=false trades against live option ticks. ---
    const startOrder = () => {
        order = spawnChild('order', 'processes/orderProcess.js', ['pipe', 'pipe', 'inherit'], COMMON_ENV, respawnOrder);
        data.stdout.pipe(order.stdin, { end: false });
        order.stdout.pipe(data.stdin, { end: false });
    };
    const restartOrder = () => serial('order', async () => {
        const old = order;
        data.stdout.unpipe(old.stdin);
        old.stdout.unpipe(data.stdin);
        await stopChild(old);
        startOrder();
    });
    const respawnOrder = makeRespawner('order', restartOrder, () => order);

    const startFrontend = () => {
        frontend = spawnChild('frontend', 'server.js', ['pipe', 'pipe', 'inherit'], COMMON_ENV, respawnFrontend);
        data.stdout.pipe(frontend.stdin, { end: false });
        frontend.stdout.pipe(data.stdin, { end: false });
    };
    const restartFrontend = () => serial('frontend', async () => {
        const old = frontend;
        data.stdout.unpipe(old.stdin);
        old.stdout.unpipe(data.stdin);
        await stopChild(old);
        startFrontend();
    });
    const respawnFrontend = makeRespawner('frontend', restartFrontend, () => frontend);

    const startStrategies = () => {
        strategies = spawnChild('strategies', 'processes/strategiesProcess.js', ['pipe', 'pipe', 'inherit'], COMMON_ENV, respawnStrategies);
        data.stdout.pipe(strategies.stdin, { end: false });
        strategies.stdout.pipe(data.stdin, { end: false });
    };
    const restartStrategies = () => serial('strategies', async () => {
        const old = strategies;
        data.stdout.unpipe(old.stdin);
        old.stdout.unpipe(data.stdin);
        await stopChild(old);
        startStrategies();
    });
    const respawnStrategies = makeRespawner('strategies', restartStrategies, () => strategies);

    log('boot', 'Starting data...');
    startData();
    log('boot', 'Starting order...');
    startOrder();
    watchAndRestart('order', [
        path.join(DIST, 'processes', 'order'), path.join(DIST, 'processes', 'orderProcess.js'),
        path.join(DIST, 'ant'), path.join(DIST, 'kite'), path.join(DIST, 'breeze'), path.join(DIST, 'model'),
        path.join(DIST, 'util'), path.join(DIST, 'prism'), path.join(DIST, 'tools'), path.join(DIST, 'ipc'), path.join(DIST, 'lib'),
        ...topLevel('constants.js', 'orderList.js', 'nse_index.js'),
    ], () => {
        log('dev', 'Restarting order (data/strategies/frontend untouched)...');
        void restartOrder();
    });

    // Give order a moment to bind its socket before strategies/frontend try to
    // connect (both reconnect-on-drop anyway, so this is an optimization).
    await sleep(500);

    // --- frontend (server.ts): stdin = tick feed from data; stdout = control
    // commands back to data (e.g. 'reconnect' for /ant/connect), mirroring how
    // strategies talks to data. Both directions are real protocol channels now.
    log('boot', 'Starting frontend (server.ts)...');
    startFrontend();
    watchAndRestart('frontend', [
        path.join(DIST, 'server.js'),
        path.join(DIST, 'ant'), path.join(DIST, 'kite'), path.join(DIST, 'breeze'), path.join(DIST, 'model'),
        path.join(DIST, 'util'), path.join(DIST, 'prism'), path.join(DIST, 'tools'), path.join(DIST, 'ipc'),
        path.join(DIST, 'middleware'), path.join(DIST, 'lib'),
        ...topLevel('user.js', 'payout.js', 'tax.js', 'constants.js', 'monitor.js', 'decision.js', 'candle.js', 'nse_index.js', 'orderList.js'),
    ], () => {
        log('dev', 'Restarting frontend (data/order/strategies untouched)...');
        void restartFrontend();
    });

    // --- strategies (the one meant to change most often) ---
    log('boot', 'Starting strategies...');
    startStrategies();
    watchAndRestart(
        'strategies',
        [
            path.join(DIST, 'strategy'), path.join(DIST, 'processes', 'strategiesProcess.js'), path.join(DIST, 'processes', 'strategies'),
            path.join(DIST, 'ant'), path.join(DIST, 'model'), path.join(DIST, 'util'),
            path.join(DIST, 'prism'), path.join(DIST, 'tools'), path.join(DIST, 'ipc'), path.join(DIST, 'lib'),
            path.join(DIST, 'kite'), path.join(DIST, 'breeze'),
            ...topLevel('constants.js', 'nse_index.js', 'orderList.js'),
        ],
        () => {
            log('dev', 'Restarting strategies (data/order untouched)...');
            void restartStrategies();
        }
    );

    // --- data itself (rare: only strategy/order-agnostic tick logic lives here) ---
    // `data` now also watches `ant` (all 4 children import from shared dirs -
    // see the dependency table this was derived from) - editing src/ant/* now
    // correctly restarts the live WS instead of silently running stale code.
    // Intentional: AntDataStream's exponential-backoff reconnect + the
    // disk-persisted session (.ant_session.json) already make that
    // reconnection fast and automatic, so the extra restarts are cheap.
    watchAndRestart('data', [
        path.join(DIST, 'processes', 'data'), path.join(DIST, 'processes', 'dataProcess.js'),
        path.join(DIST, 'ant'), path.join(DIST, 'model'), path.join(DIST, 'util'),
        path.join(DIST, 'prism'), path.join(DIST, 'tools'), path.join(DIST, 'ipc'), path.join(DIST, 'breeze'),
    ], () => {
        log('dev', 'Restarting data (order/strategies/frontend untouched)...');
        void restartData();
    });
}

main().catch((e) => {
    console.log('[orchestrator] Fatal startup error:', e);
    process.exit(1);
});

// Stop every child (waiting for them) before exiting, so no orphan keeps a port/socket and a following
// `npm run processes` does not start a duplicate set.
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutdown', `${signal} received - stopping children`);
    await Promise.all([...liveChildren].map((c) => stopChild(c)));
    process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
// If our stdout/stderr pipe is gone (Ctrl+C also kills `| tee`), logging the resulting EPIPE would raise another EPIPE
// via the handlers below, looping forever and starving shutdown(). Swallow errors on the std streams themselves.
process.stdout.on('error', () => { /* pipe closed - nothing to log to */ });
process.stderr.on('error', () => { /* pipe closed - nothing to log to */ });
process.on('uncaughtException', (e) => {
    if ((e as NodeJS.ErrnoException)?.code === 'EPIPE') return;
    log('error', 'uncaughtException (kept running):', e);
});
process.on('unhandledRejection', (e) => log('error', 'unhandledRejection (kept running):', e));
