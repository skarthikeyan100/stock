import { loadConfig } from '../src/config.js';
import { dashboardNav, BASE_URL, dismissNotice, openContext } from '../src/order/session.js';

// Headed browser: the OWNER types the password / OTP. gopocket never sees credentials.
const cfg = loadConfig();
const context = await openContext(cfg);
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE_URL);
console.log('Log in to GoPocket in the browser window (waiting up to 10 minutes)...');
try {
  await dashboardNav(page).waitFor({ state: 'visible', timeout: 10 * 60_000 });
  const notice = await dismissNotice(page);
  console.log(`Logged in. Risk notice ${notice ? 'dismissed' : 'was not shown'}. Session saved in ${cfg.profileDir}/.`);
} catch {
  console.log('Timed out waiting for login.');
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0); // the shared browser stays open
