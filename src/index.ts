import type { BrowserContext, Page } from 'playwright';
import { defaultRunner } from './claudeParser.js';
import { loadConfig } from './config.js';
import { createDeduper } from './dedupe.js';
import { logError, logInfo } from './logger.js';
import { type BuyRequest, placeBracketBuy, placeExitGtt, readSpot } from './order/gopocket.js';
import fs from 'node:fs';
import { loginWithBrowserOtp, readCredentials } from './order/login.js';
import { dismissNotice, isLoggedIn, openContext } from './order/session.js';
import { type Broker, handleMessage, serialize } from './pipeline.js';
import { createMessageServer } from './server.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const cfg = loadConfig();
const run = defaultRunner(cfg.claudeModel);
const deduper = createDeduper(cfg.dedupeWindowSeconds * 1000);

let context: BrowserContext | undefined;
let page: Page | undefined;

async function getPage(): Promise<Page> {
  if (!context || !page || page.isClosed()) {
    await context?.close().catch(() => undefined);
    context = await openContext(cfg);
    page = await context.newPage();
  }
  return page;
}

const broker: Broker = {
  async readSpot() {
    const p = await getPage();
    if (!(await isLoggedIn(p))) throw new Error('session expired: run "npm run login" and restart');
    await dismissNotice(p);
    return readSpot(p);
  },
  async buy(req) {
    return placeBracketBuy(await getPage(), req, cfg, new Date().toLocaleDateString('en-CA'));
  },
};

// Open the browser now; if the session is logged out, log in (the owner types the OTP in the browser window).
{
  const p = await getPage();
  if (!(await isLoggedIn(p))) {
    logInfo('GoPocket session is logged out: logging in, enter the OTP in the browser window');
    await loginWithBrowserOtp(p, readCredentials(process.env));
  }
  await dismissNotice(p);
  logInfo('GoPocket session is logged in');
}

const server = createMessageServer((messageId, text) => {
  logInfo('Received message', { messageId, body: text });
  return serialize(() =>
    handleMessage(messageId, text, {
      cfg,
      run,
      broker,
      deduper,
      today: () => new Date().toLocaleDateString('en-CA'),
      log: (message, extra) => logInfo(message, extra),
    }),
  ).catch((error) => logError('Unhandled error while processing message', { error: error instanceof Error ? error.message : String(error) }));
}, (b) =>
  // Exit-only: create the sell OCO GTT for a contract that is already held (owner-triggered, loopback only).
  serialize(async () => {
    const req = b as unknown as BuyRequest & { lot: number };
    await placeExitGtt(await getPage(), req, req.lot, new Date().toLocaleDateString('en-CA'));
    logInfo('exit GTT submitted', { underlying: req.underlying, strike: req.strike, right: req.right });
  }).catch((error) => logError('exit GTT failed', { error: error instanceof Error ? error.message : String(error) })),
);
server.listen(cfg.port, '127.0.0.1', () => logInfo(`GoPocket listening on 127.0.0.1:${cfg.port} (dryRun=${cfg.dryRun}, headless=${cfg.headless})`));
