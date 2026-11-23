/**
 * settings.entryStartTime: the global earliest time for a new entry (ScaledHedgedStrategy, HighLowStrategy).
 * Run: npx tsc, then: node ./dist/test/entryStart.test.js   (MOCK_BROKER must be unset: mock mode bypasses the gate)
 */
import configService from '../prism/ConfigService';
import { entryStartTime, isBeforeEntryStart } from '../util/entryStart';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const at = (h: number, m: number) => new Date(2026, 10, 23, h, m, 0);
const setStart = (v: any) => { (configService.config as any).settings = { ...((configService.config as any).settings ?? {}), entryStartTime: v }; };

async function main() {
    console.log('settings.entryStartTime');
    delete process.env.MOCK_BROKER;
    // MOCK_BROKER is read when constants loads, so this test checks the unset-mode logic only when the runner did not set it.
    const { MOCK_BROKER } = require('../constants');
    if (MOCK_BROKER) {
        assert(isBeforeEntryStart('10:00', at(9, 0)) === false, 'mock mode bypasses the gate (the runner sets MOCK_BROKER)');
        return;
    }
    setStart('10:00');
    assert(entryStartTime() === '10:00', 'the setting is read');
    assert(isBeforeEntryStart(undefined, at(9, 59)) === true && isBeforeEntryStart(undefined, at(10, 0)) === false, 'before 10:00 is blocked, 10:00 is open');
    setStart('9:5');
    assert(entryStartTime() === undefined, 'a malformed value is ignored');
    assert(isBeforeEntryStart(undefined, at(9, 0)) === false, 'no setting and no fallback: no limit (HighLow)');
    assert(isBeforeEntryStart('10:00', at(9, 59)) === true && isBeforeEntryStart('10:00', at(10, 0)) === false, 'no setting: the strategy fallback applies (ScaledHedged 10:00)');
    setStart('11:30');
    assert(isBeforeEntryStart('10:00', at(11, 0)) === true, 'the setting wins over the fallback');
}
main().then(() => process.exit(process.exitCode ?? 0));
