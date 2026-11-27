import type { BrowserContext, Page } from 'playwright';
import { defaultRunner } from './claudeParser.js';
import { loadConfig } from './config.js';
import { createDeduper } from './dedupe.js';
import { logError, logInfo } from './logger.js';
import { type BuyRequest, cancelForm, ensurePendingPage, gttListed, isOrderPending, openBuyForm, pendingEmpty, placeBracketBuy, placeExitGtt, readSpot } from './order/gopocket.js';
import fs from 'node:fs';
import { loginWithBrowserOtp, readCredentials } from './order/login.js';
import { BASE_URL, dismissNotice, isLoggedIn, openContext } from './order/session.js';
import { type Broker, handleMessage, serialize } from './pipeline.js';
import { createMessageServer } from './server.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const cfg = loadConfig();
const run = defaultRunner(cfg.claudeModel);
const deduper = createDeduper(cfg.dedupeWindowSeconds * 1000);

let context: BrowserContext | undefined;
let page: Page | undefined;

async function getPage(): Promise<Page> {
  if (!context || !context.browser()?.isConnected()) context = await openContext(cfg);
  if (!page || page.isClosed()) page = context.pages().find((p) => p.url().startsWith(BASE_URL)) ?? (await context.newPage());
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
    logInfo('GoPocket session is logged out: enter the OTP in the browser window');
    await loginWithBrowserOtp(p, readCredentials(process.env));
  }
  await dismissNotice(p);
  await ensurePendingPage(p);
  logInfo('GoPocket session is logged in, parked on Orders > Pending');
}

// One user, one order at a time: a message that arrives while an order is pending is rejected. Otherwise messages are
// handled one after another (they share one browser page).
const server = createMessageServer((messageId, text) => {
  logInfo('Received message', { messageId, body: text });
  if (isOrderPending()) {
    logInfo('rejected: an order is pending', { messageId });
    return Promise.resolve();
  }
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
  // Owner-triggered, loopback only: create the exit GTT for a held contract, or check the page without ordering.
  serialize(async () => {
    const req = b as unknown as BuyRequest & { lot: number; verifyOnly?: boolean };
    const pg = await getPage();
    await ensurePendingPage(pg);
    if (req.verifyOnly) {
      logInfo('pending empty?', { empty: await pendingEmpty(pg) });
      logInfo('GTT listed?', { listed: await gttListed(pg, req) });
      await ensurePendingPage(pg);
      logInfo('buy form opens from the Orders page', { label: await openBuyForm(pg, req, new Date().toLocaleDateString('en-CA')) });
      await cancelForm(pg);
      return;
    }
    await placeExitGtt(pg, req, req.lot, new Date().toLocaleDateString('en-CA'));
    logInfo('exit GTT submitted', { underlying: req.underlying, strike: req.strike, right: req.right });
  }).catch((error) => logError('owner request failed', { error: error instanceof Error ? error.message : String(error) })),
);
server.listen(cfg.port, '127.0.0.1', () => logInfo(`GoPocket listening on 127.0.0.1:${cfg.port} `));

// A restart (SIGTERM/SIGINT) must really stop this process: close the listener and exit. The browser stays open.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    logInfo(`${sig}: shutting down`);
    server.close();
    process.exit(0);
  });
}
