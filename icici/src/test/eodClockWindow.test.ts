/**
 * settings.eodCloseTime at/after 15:25 (2026-11-18: '15:30'): the strategies' trading window ends at 15:25, so the tick-driven EOD close
 * never ran. From eodCloseTime until 15:40 events keep flowing, and shouldPokeEod() drives a clock fallback when ticks stop.
 * Run: node ./dist/test/eodClockWindow.test.js
 */
import ContinuousStrategy from '../strategy/ContinuousStrategy';
import configService from '../prism/ConfigService';
import { isWithinEodEventWindow, shouldPokeEod } from '../util/eodClose';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const settings = configService.getConfig().settings as any;
const at = (h: number, m: number, s = 0) => new Date(2026, 10, 18, h, m, s);
const s = new ContinuousStrategy('ContinuousStrategy') as any;
s.stateLoaded = true;
const realNow = Date.now;
function atTime(h: number, m: number, fn: () => void) {
    const RealDate = Date;
    const fixed = at(h, m).getTime();
    (global as any).Date = class extends RealDate {
        constructor(...args: any[]) { super(...((args.length ? args : [fixed]) as [number])); }
        static now() { return fixed; }
    };
    try { fn(); } finally { (global as any).Date = RealDate; }
}

settings.eodCloseTime = '15:30';
assert(isWithinEodEventWindow(at(15, 29, 59)) === false, '15:29:59 is before the 15:30 close: window closed');
assert(isWithinEodEventWindow(at(15, 30, 0)) === true, '15:30:00 opens the event window');
assert(isWithinEodEventWindow(at(15, 39, 59)) === true, 'still open at 15:39:59');
assert(isWithinEodEventWindow(at(15, 40, 0)) === false, 'closed at 15:40');
s.enabled = true;
atTime(15, 30, () => assert(s.receivesEvents() === true, 'enabled strategy receives events at 15:30 (EOD close can run)'));
atTime(15, 27, () => assert(s.receivesEvents() === false, 'between 15:25 and the 15:30 close nothing is delivered (no late entries)'));
atTime(15, 45, () => assert(s.receivesEvents() === false, 'nothing after 15:40'));
s.enabled = false;
atTime(15, 30, () => assert(s.receivesEvents() === false, 'a disabled strategy takes no action in the EOD window'));
s.enabled = true;
s.stateLoaded = false;
atTime(15, 30, () => assert(s.receivesEvents() === false, 'a strategy that is not reconciled receives nothing'));
s.stateLoaded = true;

const t = at(15, 30, 5).getTime();
assert(shouldPokeEod(t - 5000, t) === true, 'quiet feed at 15:30:05 -> poke');
assert(shouldPokeEod(t - 500, t) === false, 'a tick 0.5s ago -> no poke');
assert(shouldPokeEod(0, at(15, 29, 59).getTime()) === false, 'no poke before the close time');
assert(shouldPokeEod(0, at(15, 41, 0).getTime()) === false, 'no poke after the window');

settings.eodCloseTime = '23:59';
assert(isWithinEodEventWindow(at(23, 59, 30)) === false, '23:59 (carry overnight) never opens an EOD window');
assert(shouldPokeEod(0, at(23, 59, 30).getTime()) === false, '23:59 never pokes');
settings.eodCloseTime = '15:10';
assert(isWithinEodEventWindow(at(15, 12)) === false, 'an EOD time inside the normal window needs no extension');
assert(shouldPokeEod(0, at(15, 12).getTime()) === true, 'but a quiet feed after 15:10 still gets the clock poke');
assert(shouldPokeEod(0, at(15, 5).getTime()) === false, 'no poke before 15:10');
delete settings.eodCloseTime;
assert(shouldPokeEod(0, at(15, 30).getTime()) === false, 'no configured eodCloseTime: no poke');
void realNow;
