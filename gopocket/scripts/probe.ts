import { loadConfig } from '../src/config.js';
import { readSpot } from '../src/order/gopocket.js';
import { dismissNotice, isLoggedIn, openContext } from '../src/order/session.js';

// Check: never clicks Buy.
const cfg = loadConfig();
const context = await openContext(cfg);
const page = await context.newPage();
const loggedIn = await isLoggedIn(page);
console.log(`logged in: ${loggedIn}`);
if (loggedIn) {
  console.log(`risk notice shown: ${await dismissNotice(page)}`);
  console.log(`NIFTY 50 spot: ${await readSpot(page)}`);
}
process.exit(loggedIn ? 0 : 1); // the shared browser stays open
