/**
 * The Beginner / Advanced comparison table (src/levelTable.ts): one source for the emails and GET /level-rules.
 * Run: npx tsc && node ./dist/test/levelTable.test.js
 */
import { levelTableRows, renderLevelTableHtml, ADVANCED_TERMS_TEXT } from '../levelTable';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }

const rows = levelTableRows({ targetPoints: 2, stopLossPoints: 10 });
const byLabel = (l: string) => rows.find((r) => r.label === l);
assert(rows.map((r) => r.label).join('|') === ['Flash Trade', 'Search & Buy', 'Target & stop-loss', 'Max loss on one trade', 'Position sizing', 'Trades per day', 'Capital', 'Daily loss limit', 'Weekly loss limit', 'Your profit share', 'Becoming Advanced', 'Can switch back?'].join('|'), 'the 12 rows, in order');
assert(byLabel('Daily loss limit')?.beginner === '15% (₹15,000)' && byLabel('Daily loss limit')?.advanced === '15% (₹30,000)', 'daily limit: percent and rupees of each level\'s own capital');
assert(byLabel('Weekly loss limit')?.beginner === '30% (₹30,000)' && byLabel('Weekly loss limit')?.advanced === '30% (₹60,000)', 'weekly limit');
assert(byLabel('Your profit share')?.beginner === '35%' && byLabel('Your profit share')?.advanced === '25%', 'profit share 35% / 25%');
assert(byLabel('Capital')?.beginner === '₹1,00,000' && (byLabel('Capital')?.advanced ?? '').startsWith('₹2,00,000'), 'capital 1L / 2L (Indian digit grouping)');
assert(byLabel('Target & stop-loss')?.beginner === 'Fixed (target 2, stop-loss 10 points)', 'beginner target/stop shows the global defaults');
assert(byLabel('Search & Buy')?.beginner === 'No' && (byLabel('Search & Buy')?.advanced ?? '').includes('stock options') && (byLabel('Search & Buy')?.advanced ?? '').includes('SENSEX'), 'Search & Buy: no / index incl. SENSEX and stock options');
assert(byLabel('Can switch back?')?.advanced === 'No' && (byLabel('Becoming Advanced')?.beginner ?? '').includes('GSTIN'), 'permanent; GSTIN path named');
const custom = levelTableRows({ levelRules: { advanced: { capital: 300000 } } });
assert(custom.find((r) => r.label === 'Daily loss limit')?.advanced === '15% (₹45,000)', 'config overrides flow into the table');

const html = renderLevelTableHtml([{ label: '<b>x</b>', beginner: '<script>1</script>', advanced: 'a&b' }]);
assert(!html.includes('<script>') && !html.includes('<b>x</b>') && html.includes('a&amp;b') && html.includes('Beginner') && html.includes('Advanced'), 'every cell is HTML-escaped; header names both levels');

assert(ADVANCED_TERMS_TEXT.length >= 4 && ADVANCED_TERMS_TEXT.some((p) => /permanent/i.test(p)) && ADVANCED_TERMS_TEXT.some((p) => /invoice/i.test(p)) && /DRAFT/.test(ADVANCED_TERMS_TEXT[0]), 'Advanced terms: permanent, invoice obligation, marked DRAFT for the owner\'s review');

if (!failed) console.log('ALL PASS');
process.exit(process.exitCode ?? 0);
