import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';

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
function spawnChild(name: string, scriptRelPath: string, stdio: ('pipe' | 'inherit' | 'ignore')[], extraEnv: Record<string, string> = {}): ChildProcessWithoutNullStreams {
    const child = spawn('node', [path.join(DIST, scriptRelPath)], {
        stdio,
        cwd: REPO_ROOT,
        env: { ...process.env, ...extraEnv },
    }) as ChildProcessWithoutNullStreams;
    child.on('exit', (code, signal) => log(name, `exited (code=${code} signal=${signal})`));
    return child;
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

async function main() {
    // --- data (stdin: commands from strategies; stdout: tick feed - both real protocol channels) ---
    log('boot', 'Starting data...');
    let data = spawnChild('data', 'processes/dataProcess.js', ['pipe', 'pipe', 'inherit']);

    // --- order: the Unix-socket IPC server (strategies/frontend place orders
    // through it) is the main reason it exists, but its stdin/stdout are also
    // wired into the tick-feed pipe like strategies/frontend, solely so
    // exitMonitor.ts can watch useGTT=false trades against live option ticks. ---
    log('boot', 'Starting order...');
    let order = spawnChild('order', 'processes/orderProcess.js', ['pipe', 'pipe', 'inherit'], COMMON_ENV);
    data.stdout.pipe(order.stdin, { end: false });
    order.stdout.pipe(data.stdin, { end: false });
    watchAndRestart('order', [path.join(DIST, 'processes', 'order'), path.join(DIST, 'processes', 'orderProcess.js')], () => {
        log('dev', 'Restarting order (data/strategies/frontend untouched)...');
        const old = order;
        data.stdout.unpipe(old.stdin);
        old.stdout.unpipe(data.stdin);
        old.kill('SIGTERM');
        order = spawnChild('order', 'processes/orderProcess.js', ['pipe', 'pipe', 'inherit'], COMMON_ENV);
        data.stdout.pipe(order.stdin, { end: false });
        order.stdout.pipe(data.stdin, { end: false });
    });

    // Give order a moment to bind its socket before strategies/frontend try to
    // connect (both reconnect-on-drop anyway, so this is an optimization).
    await new Promise((r) => setTimeout(r, 500));

    // --- frontend (server.ts): stdin = tick feed from data; stdout = control
    // commands back to data (e.g. 'reconnect' for /ant/connect), mirroring how
    // strategies talks to data. Both directions are real protocol channels now.
    log('boot', 'Starting frontend (server.ts)...');
    let frontend = spawnChild('frontend', 'server.js', ['pipe', 'pipe', 'inherit'], COMMON_ENV);
    data.stdout.pipe(frontend.stdin, { end: false });
    frontend.stdout.pipe(data.stdin, { end: false });
    watchAndRestart('frontend', [path.join(DIST, 'server.js')], () => {
        log('dev', 'Restarting frontend (data/order/strategies untouched)...');
        data.stdout.unpipe(frontend.stdin);
        frontend.stdout.unpipe(data.stdin);
        frontend.kill('SIGTERM');
        frontend = spawnChild('frontend', 'server.js', ['pipe', 'pipe', 'inherit'], COMMON_ENV);
        data.stdout.pipe(frontend.stdin, { end: false });
        frontend.stdout.pipe(data.stdin, { end: false });
    });

    // --- strategies (the one meant to change most often) ---
    let strategies = startStrategies();

    function startStrategies(): ChildProcessWithoutNullStreams {
        log('boot', 'Starting strategies...');
        const child = spawnChild('strategies', 'processes/strategiesProcess.js', ['pipe', 'pipe', 'inherit'], COMMON_ENV);
        data.stdout.pipe(child.stdin, { end: false });
        child.stdout.pipe(data.stdin, { end: false });
        return child;
    }

    watchAndRestart(
        'strategies',
        [path.join(DIST, 'strategy'), path.join(DIST, 'processes', 'strategiesProcess.js'), path.join(DIST, 'processes', 'strategies')],
        () => {
            log('dev', 'Restarting strategies (data/order untouched)...');
            const old = strategies;
            data.stdout.unpipe(old.stdin);
            old.stdout.unpipe(data.stdin);
            old.kill('SIGTERM');
            strategies = startStrategies();
        }
    );

    // --- data itself (rare: only strategy/order-agnostic tick logic lives here) ---
    watchAndRestart('data', [path.join(DIST, 'processes', 'data'), path.join(DIST, 'processes', 'dataProcess.js')], () => {
        log('dev', 'Restarting data (order/strategies/frontend untouched)...');
        const oldData = data;
        oldData.stdout.unpipe(frontend.stdin);
        oldData.stdout.unpipe(strategies.stdin);
        oldData.stdout.unpipe(order.stdin);
        strategies.stdout.unpipe(oldData.stdin);
        frontend.stdout.unpipe(oldData.stdin);
        order.stdout.unpipe(oldData.stdin);
        oldData.kill('SIGTERM');
        data = spawnChild('data', 'processes/dataProcess.js', ['pipe', 'pipe', 'inherit']);
        data.stdout.pipe(frontend.stdin, { end: false });
        data.stdout.pipe(strategies.stdin, { end: false });
        data.stdout.pipe(order.stdin, { end: false });
        strategies.stdout.pipe(data.stdin, { end: false });
        frontend.stdout.pipe(data.stdin, { end: false });
        order.stdout.pipe(data.stdin, { end: false });
    });
}

main().catch((e) => {
    console.log('[orchestrator] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
