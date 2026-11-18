import type { BrowserContext, Page } from 'playwright';
import { defaultRunner } from './claudeParser.js';
import { loadConfig } from './config.js';
import { createDeduper } from './dedupe.js';
import { logError, logInfo } from './logger.js';
import { type BuyRequest, cancelForm, ensurePendingPage, gttListed, openBuyForm, pendingEmpty, placeBracketBuy, placeExitGtt, readSpot } from './order/gopocket.js';
import fs from 'node:fs';
import { loginWithBrowserOtp, readCredentials } from './order/login.js';
import { dismissNotice, isLoggedIn, openContext } from './order/session.js';
import { type Broker, handleMessage } from './pipeline.js';
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
    await ensurePendingPage(p); // parked on Orders > Pending; the NIFTY level is in the top bar of every page
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
  await ensurePendingPage(p);
  logInfo('GoPocket session is logged in, parked on Orders > Pending');
}

// One user, one order at a time: while a message is being handled (or an order is pending) other messages are rejected.
let busy = false;

const server = createMessageServer(async (messageId, text) => {
  logInfo('Received message', { messageId, body: text });
  if (busy) {
    logInfo('rejected: another order is in progress', { messageId });
    return;
  }
  busy = true;
  try {
    await handleMessage(messageId, text, {
      cfg,
      run,
      broker,
      deduper,
      today: () => new Date().toLocaleDateString('en-CA'),
      log: (message, extra) => logInfo(message, extra),
    });
  } catch (error) {
    logError('Unhandled error while processing message', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
  }
}, async (b) => {
  // Owner-triggered, loopback only: create the exit GTT for a held contract, or check the page without ordering.
  if (busy) return logInfo('rejected: another order is in progress');
  busy = true;
  try {
    const req = b as unknown as BuyRequest & { lot: number; verifyOnly?: boolean };
    const pg = await getPage();
    if (req.verifyOnly) {
      await ensurePendingPage(pg);
      logInfo('pending empty?', { empty: await pendingEmpty(pg) });
      logInfo('GTT listed?', { listed: await gttListed(pg, req) });
      await ensurePendingPage(pg);
      logInfo('buy form opens from the Orders page', { label: await openBuyForm(pg, req, new Date().toLocaleDateString('en-CA')) });
      await cancelForm(pg);
      return;
    }
    await ensurePendingPage(pg);
    await placeExitGtt(pg, req, req.lot, new Date().toLocaleDateString('en-CA'));
    logInfo('exit GTT submitted', { underlying: req.underlying, strike: req.strike, right: req.right });
  } catch (error) {
    logError('exit GTT failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
  }
});
server.listen(cfg.port, '127.0.0.1', () => logInfo(`GoPocket listening on 127.0.0.1:${cfg.port} (dryRun=${cfg.dryRun}, headless=${cfg.headless})`));

// A restart (SIGTERM/SIGINT) must really stop this process: close the listener and the browser, then exit.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    logInfo(`${sig}: shutting down`);
    server.close();
    context
      ?.close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
