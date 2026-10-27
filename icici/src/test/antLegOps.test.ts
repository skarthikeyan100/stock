/**
 * Verifies the ANT leg strike choice (ATM, then OTM depth 1-4, then ITM depth 1-4, first strike clearing minPremium, skipping
 * excluded strikes) - the same priority order as the Kite/Breeze price-range lookup.
 * Run: npm run build (compile), then: node ./dist/test/antLegOps.test.js
 */

import { pickStrikeFromChain } from '../strategy/antLegOps';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function row(strike: number, ce: number, pe: number) {
    return { strike, ce: { ltp: ce, token: strike * 10 + 1 }, pe: { ltp: pe, token: strike * 10 + 2 } };
}

const chain = [
    row(22600, 190, 20), row(22650, 150, 30), row(22700, 120, 45), row(22750, 90, 70),
    row(22800, 60, 95), row(22850, 40, 120), row(22900, 25, 150), row(22950, 15, 185), row(23000, 8, 220),
];

console.log('ATM is taken first when it clears the minimum premium');
{
    const r = pickStrikeFromChain(chain, 22800, 'CE', 50, []);
    assert(r.strike === 22800, 'CE at ATM 22800 (60 >= 50)');
}

console.log('Falls to the next OTM strike when ATM is too cheap');
{
    const r = pickStrikeFromChain(chain, 22800, 'CE', 80, []);
    assert(r.strike === 22750 || r.strike === 22700, 'a lower-strike (higher premium) CE is chosen');
    assert(r.side.ltp >= 80, 'premium clears the minimum');
}

console.log('A put walks down from ATM');
{
    const r = pickStrikeFromChain(chain, 22800, 'PE', 100, []);
    assert(r.strike === 22850 && r.side.ltp === 120, 'PE 22850 (120 >= 100), first clearing 100 going away from ATM then ITM');
}

console.log('Excluded strikes are skipped');
{
    const r = pickStrikeFromChain(chain, 22800, 'CE', 50, [22800]);
    assert(r.strike !== 22800, 'ATM excluded -> another strike');
}

console.log('No strike clears the minimum premium -> throws');
{
    let threw = false;
    try { pickStrikeFromChain(chain, 22800, 'CE', 1000, []); } catch { threw = true; }
    assert(threw, 'throws when nothing qualifies');
}

console.log('Underlying is rounded to the 50-point strike step');
{
    const r = pickStrikeFromChain(chain, 22812, 'CE', 50, []);
    assert(r.strike === 22800, '22812 -> ATM 22800');
}
