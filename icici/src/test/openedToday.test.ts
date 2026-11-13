/** /strategyPnl ?opened filter. Run: npx tsc, then: node ./dist/test/openedToday.test.js */
import { isOpenedToday, openedFilterOf } from '../util/openedToday';
function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) process.exitCode = 1; }
const now = new Date('2026-11-13T10:00:00+05:30').getTime();
assert(isOpenedToday(new Date('2026-11-13T09:15:00+05:30'), now), 'bought today');
assert(isOpenedToday('2026-11-13T00:00:30+05:30', now), 'ISO string, just after IST midnight (18:30Z previous UTC day)');
assert(!isOpenedToday(new Date('2026-11-12T23:59:59+05:30'), now), 'bought just before IST midnight = yesterday');
assert(!isOpenedToday(new Date('2026-11-11T10:00:00+05:30'), now), 'bought on 11-11');
assert(isOpenedToday(undefined, now) && isOpenedToday(null, now), 'missing entryTime counts as today');
assert(isOpenedToday('garbage', now), 'unparseable entryTime counts as today');
assert(openedFilterOf('today') === 'today' && openedFilterOf(undefined) === 'all' && openedFilterOf('all') === 'all' && openedFilterOf('x') === 'all', 'route default is all');
