import { loadConfig } from '../src/config.js';
import { placeBracketBuy } from '../src/order/gopocket.js';
import { openContext } from '../src/order/session.js';

// Dry run only: dryRun is forced true, so Buy is never clicked.
// Usage: npm run probe-buy -- NIFTY CE 25400 54 13 14   (underlying right strike price stopOffset targetOffset); always one lot
const [underlying = 'NIFTY', right = 'CE', strike = '25400', price = '54', stopOffset = '13', targetOffset = '14'] = process.argv.slice(2);
const cfg = { ...loadConfig(), dryRun: true };
const context = await openContext(cfg, { headless: true });
const page = await context.newPage();
const outcome = await placeBracketBuy(
  page,
  { underlying: underlying.toUpperCase(), right: right as 'CE' | 'PE', strike: Number(strike), price: Number(price), stopOffset: Number(stopOffset), targetOffset: Number(targetOffset) },
  cfg,
  new Date().toLocaleDateString('en-CA'),
);
console.log('outcome:', outcome);
await context.close();
process.exitCode = outcome.reason === 'dry run' ? 0 : 1;
