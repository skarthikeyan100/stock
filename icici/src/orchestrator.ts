// Load .env into process.env before anything else - every child this spawns
// below inherits process.env at spawn time (see spawnChild's `{ ...process.env,
// ...extraEnv }`), so loading it here covers data/trading/frontend
// too without each needing its own dotenv call. See .env.example for the full
// variable list and CLAUDE.md's Environment section for which are required.
import './util/tz'; // pin TZ=Asia/Kolkata before any other module reads the clock
import 'dotenv/config';

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { sleep } from './util/sleep';
import { shouldAutoRestart } from './orchestratorPolicy';

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

// The parent. Spawns data/trading/frontend as sibling processes (`trading` = order + strategies merged, review decision 2). They find
// each other through Unix sockets, not through the orchestrator:
//   - data serves ticks and takes feed commands on DATA_IPC_SOCKET (ipc/DataLink is the client in trading and frontend)
//   - trading serves ORDER_IPC_SOCKET and STRATEGIES_IPC_SOCKET to frontend
//
// Each child is watched and restarted independently (dev mode), except `data`, which is never restarted automatically (review
// decision 5): editing trading code restarts only `trading`, editing the API restarts only `frontend`. The orchestrator itself is
// never restarted by tsc-watch; run it as a long-lived process alongside `tsc -w` (see package.json's "processes" script) so a save
// never tears down every child at once - that's the actual point of this split.

const DIST = path.join(__dirname); // this file itself runs from dist/orchestrator.js
const REPO_ROOT = path.join(DIST, '..'); // dist/ mirrors src/ 1:1, so this is the repo root
const ORDER_SOCKET_PATH = process.env.ORDER_IPC_SOCKET || '/tmp/icici-order.sock';
const STRATEGIES_SOCKET_PATH = process.env.STRATEGIES_IPC_SOCKET || '/tmp/icici-strategies.sock';
const COMMON_ENV = { ORDER_IPC_SOCKET: ORDER_SOCKET_PATH, STRATEGIES_IPC_SOCKET: STRATEGIES_SOCKET_PATH };

function log(tag: string, ...args: any[]) {
    console.log(`[orchestrator] [${tag}]`, ...args);
}

// stdout/stderr of every child are inherited, so their logs land in the orchestrator's own output (orchestrator.log); stdin is unused.
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

function isAlive(child: ChildProcessWithoutNullStreams | undefined): boolean {
    return !!child && child.exitCode === null && child.signalCode === null;
}

// Stops a child and resolves once it has really exited (SIGKILL after 5s), so a replacement is never spawned while the
// old process still holds its socket/port.
// The first step of a crash respawn, run inside the serialised restart: a hot restart may already have replaced the crashed child.
function replacementAlreadyRunning(name: string, child: ChildProcessWithoutNullStreams | undefined, opts?: { onlyIfDead?: boolean }): boolean {
    if (!opts?.onlyIfDead || !isAlive(child)) return false;
    log(name, 'respawn skipped - a live replacement is already running');
    return true;
}

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
type RestartOutcome = 'started' | 'skipped' | 'failed';

const MAX_FAILED_RESTARTS = 10;

function makeRespawner(name: string, restart: (opts?: { onlyIfDead?: boolean }) => Promise<RestartOutcome>): () => void {
    let failures = 0;
    let failedRestarts = 0; // consecutive restarts that could not start a child (a persistently missing dist file would loop forever)
    let lastStart = Date.now();
    let pending = false;
    const respawn = (): void => {
        if (pending || shuttingDown) return;
        if (failedRestarts >= MAX_FAILED_RESTARTS) {
            log(name, `ALERT: ${failedRestarts} consecutive restarts failed - giving up until the next code change or orchestrator restart`);
            return;
        }
        pending = true;
        if (Date.now() - lastStart > 60_000) failures = 0;
        const delay = Math.min(30_000, 1000 * 2 ** failures);
        failures++;
        log(name, `respawning in ${delay}ms`);
        setTimeout(async () => {
            pending = false;
            if (shuttingDown) return;
            // onlyIfDead: the check runs INSIDE the serialised restart, right before stopping the old child. A hot restart may have
            // replaced the crashed child while this timer waited or while this restart was queued behind it; stopping then would kill the
            // healthy replacement.
            const outcome = await restart({ onlyIfDead: true });
            if (outcome === 'started') { lastStart = Date.now(); failedRestarts = 0; } // a skipped respawn must not delay the next one's backoff reset
            else if (outcome === 'failed') { failedRestarts++; respawn(); } // no child is running and no exit event will come: try again with a longer backoff
        }, delay);
    };
    return respawn;
}

// sha1 of every file under `target` (a file or a directory tree), keyed by path.
function hashTree(target: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (p: string) => {
        let st: fs.Stats;
        try { st = fs.statSync(p); } catch { return; }
        if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e)); return; }
        try { out.set(p, createHash('sha1').update(fs.readFileSync(p)).digest('hex')); } catch { /* vanished mid-scan: the next scan sees it */ }
    };
    walk(target);
    return out;
}
function sameHashes(a: Map<string, string>, b: Map<string, string>): boolean {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (b.get(k) !== v) return false;
    return true;
}

// A change seen this soon after the watch was set up is applied only once the grace has passed, never in the middle of a start.
const HOT_RESTART_BOOT_GRACE_MS = 90_000;

// Watches `watchPaths` (compiled dist/ output) and calls onChange (debounced) when a watched file's CONTENT changed - used to
// restart exactly one child. A rewrite with identical content (tsc re-emitting on start-up touched dist/ after the children were
// already running: live 2026-10-29 11:06:19, the entry ran twice) is ignored, and a real change during the first
// HOT_RESTART_BOOT_GRACE_MS is deferred to the end of the grace so the child is not restarted while it is still starting.
// HOT_RESTART=false disables it entirely. config.yml is not watched here: every process hot-reads it itself.
function watchAndRestart(name: string, watchPaths: string[], onChange: () => void) {
    if (process.env.HOT_RESTART === 'false') return;
    const existing = watchPaths.filter((p) => fs.existsSync(p));
    const graceEndsAt = Date.now() + HOT_RESTART_BOOT_GRACE_MS;
    const snapshots = new Map(existing.map((t) => [t, hashTree(t)] as const));
    let debounce: NodeJS.Timeout | null = null;
    const checkAndRestart = () => {
        let changed = false;
        for (const t of existing) {
            const now = hashTree(t);
            if (!sameHashes(snapshots.get(t)!, now)) { snapshots.set(t, now); changed = true; }
        }
        if (changed) onChange();
    };
    for (const target of existing) {
        fs.watch(target, { recursive: true }, () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(checkAndRestart, Math.max(300, graceEndsAt - Date.now()));
        });
    }
    log('boot', `Watching ${name}:`, existing);
}

// Top-level compiled modules (dist/*.js) that several processes import directly.
const topLevel = (...files: string[]) => files.map((f) => path.join(DIST, f));

// Restarts of one role are serialised so a crash respawn and a hot restart can never overlap.
const restartChains = new Map<string, Promise<void>>();
// Resolves 'started' (a new child is running), 'skipped' (a live replacement already was) or 'failed' (logged).
function serial(role: string, fn: () => Promise<'started' | 'skipped'>): Promise<RestartOutcome> {
    const next: Promise<RestartOutcome> = (restartChains.get(role) ?? Promise.resolve()).then(fn).catch((e): RestartOutcome => {
        log(role, 'restart failed:', e);
        return 'failed';
    });
    restartChains.set(role, next.then(() => undefined));
    return next;
}

// No child's stdio is a protocol channel: ticks and feed commands travel over the data Unix socket (ipc/DataLink), so stdout and stderr
// are plain logs (inherited) and stdin is unused.
const CHILD_STDIO: ('pipe' | 'inherit' | 'ignore')[] = ['ignore', 'inherit', 'inherit'];

// A restartable child: one `start` used for the first boot, a hot restart on a code change AND a crash respawn (the restart stops the
// old process, waiting for it to be really gone, then spawns the new one).
interface Role {
    child: ChildProcessWithoutNullStreams;
    start(): void;
    restart(opts?: { onlyIfDead?: boolean }): Promise<RestartOutcome>;
    respawn(): void;
}
function makeRole(name: string, script: string, env: Record<string, string>): Role {
    const role: Role = {
        child: undefined as unknown as ChildProcessWithoutNullStreams,
        start: () => { role.child = spawnChild(name, script, CHILD_STDIO, env, role.respawn); },
        restart: (opts) => serial(name, async () => {
            if (replacementAlreadyRunning(name, role.child, opts)) return 'skipped';
            await stopChild(role.child);
            role.start();
            return 'started';
        }),
        respawn: () => { /* replaced just below: it needs role.restart */ },
    };
    role.respawn = makeRespawner(name, role.restart);
    return role;
}

// Restart `role` when a watched dist/ path changes (dev hot restart).
function hotRestart(name: string, role: Role, watchPaths: string[]): void {
    watchAndRestart(name, watchPaths, () => {
        log('dev', `Restarting ${name} (the other children untouched)...`);
        void role.restart().then((outcome) => { if (outcome === 'failed') role.respawn(); });
    });
}

// dist/ directories every child imports from; a change in one restarts each child that watches it.
const sharedDirs = (...extra: string[]) => [...['ant', 'kite', 'breeze', 'model', 'util', 'prism', 'tools', 'ipc', 'lib', ...extra].map((d) => path.join(DIST, d))];

async function main() {
    // --- data: owns the broker websockets and serves ticks on its socket. Never restarted automatically (review decision 5): a crash
    // raises an alert, `trading` and `frontend` notice the closed socket and raise their own feed-down alerts, and an operator restarts
    // the run outside market hours. A rebuilt dist/ file does not restart it either, so it has no role/restart machinery. ---
    log('boot', 'Starting data...');
    spawnChild('data', 'processes/dataProcess.js', CHILD_STDIO, {}, () => {
        if (shouldAutoRestart('data', 'crash')) return;
        log('data', 'ALERT: data process exited - NOT restarting it automatically. Ticks have stopped; restart the orchestrator when it is safe.');
    });

    // --- trading (orders + strategies in one process, review decision 2): serves the order and strategies Unix-socket IPC to
    // `frontend`. ---
    const trading = makeRole('trading', 'processes/tradingProcess.js', COMMON_ENV);
    log('boot', 'Starting trading (order + strategies)...');
    trading.start();
    hotRestart('trading', trading, [
        path.join(DIST, 'processes', 'order'), path.join(DIST, 'processes', 'orderProcess.js'),
        path.join(DIST, 'strategy'), path.join(DIST, 'processes', 'strategiesProcess.js'), path.join(DIST, 'processes', 'strategies'),
        path.join(DIST, 'processes', 'tradingProcess.js'),
        ...sharedDirs(), ...topLevel('constants.js', 'orderList.js', 'nse_index.js'),
    ]);

    // Give trading a moment to bind its sockets before the frontend tries to connect (it reconnects on drop anyway, so this is an
    // optimization).
    await sleep(500);

    // --- frontend (server.ts): ticks from data and its control commands (e.g. 'reconnect' for /ant/connect) go over the data socket. ---
    const frontend = makeRole('frontend', 'server.js', COMMON_ENV);
    log('boot', 'Starting frontend (server.ts)...');
    frontend.start();
    hotRestart('frontend', frontend, [
        path.join(DIST, 'server.js'), path.join(DIST, 'middleware'),
        ...sharedDirs(), ...topLevel('user.js', 'payout.js', 'tax.js', 'constants.js', 'nse_index.js', 'orderList.js'),
    ]);
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
