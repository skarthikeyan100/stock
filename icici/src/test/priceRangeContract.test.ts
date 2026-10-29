/**
 * pickContractByPremium - the strike choice every broker's getContractByPriceRange shares (it replaced the ANT-only pickStrikeFromChain):
 * ATM first, then OTM depth 1-4, then ITM depth 1-4, first strike clearing minPremium, skipping excluded strikes; the contract is
 * resolved from the token the premium was read from.
 * Run: node ./dist/test/priceRangeContract.test.js
 */
import * as antExecutor from '../processes/order/antExecutor';
import { pickContractByPremium } from '../processes/order/priceRangeContract';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

// strike -> [ce premium, pe premium]
const chain: Record<number, [number, number]> = {
    22600: [190, 20], 22650: [150, 30], 22700: [120, 45], 22750: [90, 70], 22800: [60, 95],
    22850: [40, 120], 22900: [25, 150], 22950: [15, 185], 23000: [8, 220],
};
(antExecutor as any).estimateOptionPricesBatch = async (_i: string, cands: { strike: number; optionType: string }[]) => {
    const out = new Map<string, { premium: number; antToken: string }>();
    for (const c of cands) {
        const row = chain[c.strike];
        if (row) out.set(`${c.strike}_${c.optionType}`, { premium: c.optionType === 'CE' ? row[0] : row[1], antToken: `t${c.strike}${c.optionType}` });
    }
    return out;
};
const resolve = (strike: number, antToken: string) => ({ tradingSymbol: `NIFTY${strike}`, tokenSeen: antToken });
const pick = (ltp: number, type: 'CE' | 'PE', min: number, excl: number[] = [], index: 'NIFTY' | 'SENSEX' = 'NIFTY') =>
    pickContractByPremium(ltp, type, index, min, new Set(excl), resolve);

async function main() {
    let r = await pick(22800, 'CE', 50);
    assert(r.strike === 22800 && r.premium === 60, 'ATM is taken first when it clears the minimum premium');
    assert(r.tokenSeen === 't22800CE' && r.antToken === 't22800CE', 'the contract is resolved from the token the premium was read from');

    r = await pick(22800, 'CE', 80);
    assert(r.strike === 22850 || r.strike === 22750 || r.strike === 22700, `falls through the priority order when ATM is too cheap (got ${r.strike})`);
    assert(r.premium >= 80, 'and the premium it returns clears the minimum');

    r = await pick(22800, 'PE', 100);
    assert(r.strike === 22850 && r.premium === 120, 'a put walks down from ATM: PE 22850 (120 >= 100)');

    r = await pick(22800, 'CE', 50, [22800]);
    assert(r.strike !== 22800, 'an excluded strike is skipped');

    let threw = false;
    try { await pick(22800, 'CE', 1000); } catch { threw = true; }
    assert(threw, 'throws when no strike clears the minimum');

    r = await pick(22812, 'CE', 50);
    assert(r.strike === 22800, 'the underlying is rounded to the 50-point NIFTY step (22812 -> 22800)');

    (antExecutor as any).estimateOptionPricesBatch = async (_i: string, cands: { strike: number; optionType: string }[]) =>
        new Map(cands.map((c) => [`${c.strike}_${c.optionType}`, { premium: 500, antToken: 's' + c.strike }]));
    r = await pick(80050, 'CE', 100, [], 'SENSEX');
    assert(r.strike === 80100, 'SENSEX rounds to its 100-point step (80050 -> 80100)');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
