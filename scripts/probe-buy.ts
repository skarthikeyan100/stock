import { loadConfig } from '../src/config.js';
import { placeBracketBuy } from '../src/order/gopocket.js';
import { openContext } from '../src/order/session.js';

// Dry run only: dryRun is forced true, so Buy is never clicked.
// Usage: npm run probe-buy -- CE 25400 54 1 13 14   (right strike price lots stopOffset targetOffset)
const [right = 'CE', strike = '25400', price = '54', lots = '1', stopOffset = '13', targetOffset = '14'] = process.argv.slice(2);
const cfg = { ...loadConfig(), dryRun: true };
const context = await openContext(cfg, { headless: true });
const page = await context.newPage();
const outcome = await placeBracketBuy(
  page,
  { right: right as 'CE' | 'PE', strike: Number(strike), price: Number(price), lots: Number(lots), stopOffset: Number(stopOffset), targetOffset: Number(targetOffset) },
  cfg,
  new Date().toLocaleDateString('en-CA'),
);
console.log('outcome:', outcome);
await context.close();
process.exitCode = outcome.reason === 'dry run' ? 0 : 1;
