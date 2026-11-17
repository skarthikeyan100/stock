import { loadConfig } from '../src/config.js';
import { readSpot } from '../src/order/gopocket.js';
import { dismissNotice, isLoggedIn, openContext } from '../src/order/session.js';

// Headless check: never clicks Buy.
const cfg = loadConfig();
const context = await openContext(cfg, { headless: true });
const page = await context.newPage();
const loggedIn = await isLoggedIn(page);
console.log(`logged in: ${loggedIn}`);
if (loggedIn) {
  console.log(`risk notice shown: ${await dismissNotice(page)}`);
  console.log(`NIFTY 50 spot: ${await readSpot(page)}`);
}
await context.close();
process.exitCode = loggedIn ? 0 : 1;
