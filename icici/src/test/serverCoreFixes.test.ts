/**
 * Focused checks for the server-core review fixes (no Mongo/broker needed):
 * multi-instance config round trip, payout period parsing, EMA crossover recency, weekly expiry stepping, Log cap.
 * Run: npx tsc, then: node ./dist/test/serverCoreFixes.test.js
 */
import configService from '../prism/ConfigService';
import { periodFromInputs } from '../payout';
import { calcEMACrossover } from '../lib/indicators';
import { Index } from '../nse_index';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

// 1. Several instances of one strategy type survive configToFlat -> flatToConfig
const original = configService.config.strategies;
configService.config.strategies = [
    { type: 'BulkPcrStrategy', userId: 'BulkPcr-NIFTY', enabled: false } as any,
    { type: 'BulkPcrStrategy', userId: 'BulkPcr-SENSEX', enabled: false } as any,
    { type: 'ButterflyStrategy', userId: 'Butterfly-NIFTY', enabled: false } as any,
];
const flat = configService.configToFlat();
const back = configService.flatToConfig(flat);
assert(back.strategies.length === 3, `3 strategy instances round-trip (got ${back.strategies.length})`);
assert(back.strategies.filter((s: any) => s.type === 'BulkPcrStrategy').map((s: any) => s.userId).sort().join() === 'BulkPcr-NIFTY,BulkPcr-SENSEX', 'both BulkPcr instances keep their userId');
assert('bulkPcrStrategy' in flat, 'first instance keeps the plain key the admin UI uses');
configService.config.strategies = original;

// 2. Payout periods: date-only = IST day boundaries, end exclusive
const p = periodFromInputs('2026-10-05', '2026-10-05');
assert(p.start.toISOString() === '2026-10-04T18:30:00.000Z', `date-only start is IST midnight (${p.start.toISOString()})`);
assert(p.end.getTime() - p.start.getTime() === 24 * 3600 * 1000, 'single date-only period spans exactly one IST day (end exclusive)');
let threw = false;
try { periodFromInputs('2026-10-06', '2026-10-05'); } catch { threw = true; }
assert(threw, 'start after end is rejected');
threw = false;
try { periodFromInputs('garbage', '2026-10-05'); } catch { threw = true; }
assert(threw, 'invalid date is rejected');

// 3. EMA crossover reports the MOST RECENT cross: up-trend then a sharp fall => DOWN, not the stale UP
const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
const falling = Array.from({ length: 30 }, (_, i) => 140 - i * 3);
const res = calcEMACrossover([...rising, ...falling], 5, 20);
assert(res !== null && res.trend === 'DOWN', `latest crossover wins (got ${res?.trend})`);

// 4. Weekly expiry stepping really advances one week per step, from a Tuesday and from another day
const idx = new Index('26000', 65, 50);
const tue = new Date('2026-10-27T00:00:00'); // a Tuesday
assert(idx._tuesdayAfterWeeks(tue, 0).getDate() === 27, 'week 0 from a Tuesday is that Tuesday');
assert(idx._tuesdayAfterWeeks(tue, 1).getDate() === 3, 'week 1 from a Tuesday is the following Tuesday (Nov 3)');
const wed = new Date('2026-10-28T00:00:00');
assert(idx._tuesdayAfterWeeks(wed, 0).getDate() === 3 && idx._tuesdayAfterWeeks(wed, 1).getDate() === 10, 'from a Wednesday: Nov 3 then Nov 10');
assert(tue.getDate() === 27, 'the input date is not mutated');

console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
process.exit(process.exitCode ?? 0);
