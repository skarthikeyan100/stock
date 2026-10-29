/**
 * Startup readiness (review R4-1/R4-2/R5-1): a strategy receives events only once its state is loaded, a BulkPcr instance does not
 * enter on an aligned tick before then, and a failed reconcile leaves a strategy gated rather than trading blind.
 * Run: node ./dist/test/startupReadiness.test.js
 */
import ContinuousStrategy from '../strategy/ContinuousStrategy';
import BulkPcrStrategy from '../strategy/BulkPcrStrategy';
import { NiftyQuote } from '../model/model';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const RealDate = Date;
function atTime(h: number, m: number, fn: () => void) {
    const fixed = new RealDate(2026, 9, 29, h, m, 0);
    (global as any).Date = class extends RealDate {
        constructor(...args: any[]) { super(...((args.length ? args : [fixed.getTime()]) as [number])); }
        static now() { return fixed.getTime(); }
    };
    try { fn(); } finally { (global as any).Date = RealDate; }
}

async function main() {
    const s = new ContinuousStrategy('ContinuousStrategy') as any;
    s.enabled = true;
    assert(s.stateLoaded === false, 'a fresh strategy starts with its state not loaded');
    atTime(10, 0, () => assert(s.receivesEvents() === false, 'enabled + in window but not reconciled receives nothing'));
    s.stateLoaded = true;
    atTime(10, 0, () => assert(s.receivesEvents() === true, 'once reconciled it receives events'));

    // BulkPcr: idle + enabled + aligned tick must not enter before reconcile has restored the slots.
    const b = new BulkPcrStrategy('bulkpcr-readiness') as any;
    b.enabled = true;
    b.phase = 'idle';
    let entered = false;
    b.resolveEntryRight = async () => { entered = true; return 'CE'; };
    b.isTimeInRange = () => true;
    b.eodCheck = async () => {};
    await b.processUnderlyingQuote(Object.assign(new NiftyQuote(), { ltp: 24000 }));
    assert(entered === false && b.phase === 'idle', 'BulkPcr does not start an entry before its state is loaded');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
