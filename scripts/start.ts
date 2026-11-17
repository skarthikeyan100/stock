import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import readline from 'node:readline/promises';
import { loginWithOtp, readCredentials } from '../src/order/login.js';
import { dismissNotice, isLoggedIn, openContext } from '../src/order/session.js';
import { findProcess, isListening } from '../src/startup.js';

// Starts GoPocket and the WhatsApp router, each only if it is not already running. Both are detached, so they keep
// running after this script exits; their output goes to a log file.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const ROUTER_DIR = path.resolve(process.env.WHATSAPP_DIR ?? path.join(ROOT, '..', 'whatsapp'));
const cfg = loadConfig();

function launch(dir: string, logName: string): void {
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const out = fs.openSync(path.join(dir, 'logs', logName), 'a');
  spawn('npx', ['tsx', 'src/index.ts'], { cwd: dir, detached: true, stdio: ['ignore', out, out] }).unref();
}

async function waitFor(check: () => Promise<boolean> | boolean, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// 1. GoPocket
if ((await isListening(cfg.port)) || findProcess(ROOT, 'src/index.ts')) {
  console.log(`GoPocket: already running (port ${cfg.port}), not started again`);
} else {
  const context = await openContext(cfg, { headless: true });
  const page = await context.newPage();
  let loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    let creds: ReturnType<typeof readCredentials> | undefined;
    try {
      creds = readCredentials(process.env);
    } catch (error) {
      console.error(`GoPocket: not logged in and cannot log in by itself: ${(error as Error).message}. Or run \`npm run login\` and start again.`);
    }
    if (creds) {
      if (!process.stdin.isTTY) {
        console.error('GoPocket: not logged in, and the OTP prompt needs an interactive terminal.');
      } else {
        try {
          console.log('GoPocket: session is logged out, logging in with the mobile and password from .env ...');
          await loginWithOtp(page, creds, async () => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const otp = await rl.question('Enter the 6-digit OTP sent to your phone: ');
            rl.close();
            return otp;
          });
          loggedIn = await isLoggedIn(page);
        } catch (error) {
          console.error(`GoPocket: login failed: ${(error as Error).message}`);
        }
      }
    }
  }
  if (loggedIn) await dismissNotice(page);
  await context.close(); // the browser profile can be used by one browser at a time
  if (!loggedIn) process.exit(1);
  launch(ROOT, 'bot.out.log');
  const up = await waitFor(() => isListening(cfg.port), 40);
  console.log(up ? `GoPocket: started (dryRun=${cfg.dryRun}), listening on port ${cfg.port}; log: logs/bot.out.log` : 'GoPocket: started but not listening after 40 s, check logs/bot.out.log');
  if (!up) process.exit(1);
}

// 2. WhatsApp router
const running = findProcess(ROUTER_DIR, 'src/index.ts');
if (running) {
  console.log(`WhatsApp router: already running (pid ${running}), not started again`);
} else {
  launch(ROUTER_DIR, 'router.out.log');
  const up = await waitFor(() => findProcess(ROUTER_DIR, 'src/index.ts') !== null, 15);
  console.log(up ? `WhatsApp router: started; log: ${path.join(ROUTER_DIR, 'logs', 'router.out.log')} (a QR code appears there only if WhatsApp must be linked again)` : 'WhatsApp router: did not start, check its log');
  if (!up) process.exit(1);
}
