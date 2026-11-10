/**
 * effectiveExpiryOffset with settings.skipNearestExpiryOnExpiryDay: on the nearest expiry's own day the next expiry is used.
 * Run: node ./dist/test/expiryDaySkip.test.js
 */
import configService from '../prism/ConfigService';
import { effectiveExpiryOffset, expiryDayOverrideOf } from '../util/expirySkip';

const d = (y: number, m: number, day: number) => Date.UTC(y, m - 1, day);
const now = (y: number, m: number, day: number) => new Date(y, m - 1, day, 11, 0).getTime();
let failed = 0;
const check = (name: string, actual: number, expected: number) => { if (actual === expected) console.log(`PASS ${name}`); else { failed++; console.log(`FAIL ${name}: expected ${expected}, got ${actual}`); } };
const setSettings = (settings: any) => { (configService as any).getConfig = () => ({ settings }); };

const expiries = [d(2026, 11, 10), d(2026, 11, 17)]; // Tuesday 11-10 then 11-17
setSettings({ skipNearestExpiryOnExpiryDay: true });
check('expiry day -> next', effectiveExpiryOffset(expiries, 0, now(2026, 11, 10)), 1);
check('eve is not bumped by the expiry-day setting', effectiveExpiryOffset(expiries, 0, now(2026, 11, 9)), 0);
check('explicit offset untouched', effectiveExpiryOffset(expiries, 2, now(2026, 11, 10)), 2);
check('single expiry stays', effectiveExpiryOffset([expiries[0]], 0, now(2026, 11, 10)), 0);
setSettings({});
check('setting off -> nearest', effectiveExpiryOffset(expiries, 0, now(2026, 11, 10)), 0);
setSettings({ skipNearestExpiryOnEve: true });
check('eve setting still bumps the eve', effectiveExpiryOffset(expiries, 0, now(2026, 11, 9)), 1);

setSettings({ skipNearestExpiryOnExpiryDay: true });
check('per-call false overrides the setting', effectiveExpiryOffset(expiries, 0, now(2026, 11, 10), false), 0);
setSettings({});
check('per-call true overrides an absent setting', effectiveExpiryOffset(expiries, 0, now(2026, 11, 10), true), 1);
check('per-call true is a no-op off expiry day', effectiveExpiryOffset(expiries, 0, now(2026, 11, 9), true), 0);
check('override read from a block', effectiveExpiryOffset(expiries, 0, now(2026, 11, 10), expiryDayOverrideOf({ skipNearestExpiryOnExpiryDay: true })), 1);
check('no key in the block -> no override', expiryDayOverrideOf({}) === undefined ? 1 : 0, 1);

if (failed > 0) { console.log(`${failed} FAILED`); process.exit(1); }
console.log('all passed');
