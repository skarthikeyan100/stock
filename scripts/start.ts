import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { findProcess, isListening } from '../src/startup.js';

// Starts GoPocket and the WhatsApp router, each only if it is not already running. Both are detached, so they keep
// running after this script exits; their output goes to a log file.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const ROUTER_DIR = path.resolve(process.env.WHATSAPP_DIR ?? path.join(ROOT, '..', 'whatsapp'));
const cfg = loadConfig();

// Each project's `npm run dev` tees its output into its own logs/gopocket.log or logs/whatsapp.log.
function launch(dir: string, cmd: string[]): void {
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  spawn(cmd[0], cmd.slice(1), { cwd: dir, detached: true, stdio: 'ignore' }).unref();
}

async function waitFor(check: () => Promise<boolean> | boolean, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// 1. GoPocket. If its session is logged out it opens a browser window, fills mobile + password from .env and waits for
// the OTP typed in that window (up to 10 minutes); it listens on its port only after that, and trades from that window.
if ((await isListening(cfg.port)) || findProcess(ROOT, 'src/index.ts') || findProcess(ROOT, 'node_modules/.bin/tsc-watch')) {
  console.log(`GoPocket: already running (port ${cfg.port}), not started again`);
} else {
  launch(ROOT, ['npm', 'run', 'dev']); // always under tsc-watch: restarts after every successful compile
  const up = await waitFor(() => isListening(cfg.port), 40);
  console.log(up ? `GoPocket: started, listening on port ${cfg.port}; log: logs/gopocket.log` : 'GoPocket: started, not listening yet. If a browser window opened, enter the OTP there; log: logs/gopocket.log');
}

// 2. WhatsApp router
const running = findProcess(ROUTER_DIR, 'src/index.ts');
if (running) {
  console.log(`WhatsApp router: already running (pid ${running}), not started again`);
} else {
  launch(ROUTER_DIR, ['npm', 'run', 'dev']);
  const up = await waitFor(() => findProcess(ROUTER_DIR, 'src/index.ts') !== null, 15);
  console.log(up ? `WhatsApp router: started; log: ${path.join(ROUTER_DIR, 'logs', 'whatsapp.log')} (a QR code appears there only if WhatsApp must be linked again)` : 'WhatsApp router: did not start, check its log');
  if (!up) process.exit(1);
}
