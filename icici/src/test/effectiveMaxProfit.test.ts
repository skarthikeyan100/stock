import assert from 'assert';
import { globalMaxProfit, effectiveMaxProfit } from '../strategy/effectiveMaxProfit';
import { validateConfigFile } from '../prism/configValidation';
import { formatPercentFields } from '../prism/percentConfig';

const settings = { maxProfit: 5000 };

assert.strictEqual(globalMaxProfit(settings), 5000);
assert.strictEqual(globalMaxProfit({ maxProfit: 0 } as any), 0, '0 = no global cap');
assert.strictEqual(globalMaxProfit({ maxProfit: -5 } as any), 0, 'negative = no global cap');
assert.strictEqual(globalMaxProfit({} as any), 0, 'absent = no global cap');
assert.strictEqual(globalMaxProfit({ maxProfit: { kite: 5000 } } as any), 0, 'a map is ignored');
assert.strictEqual(globalMaxProfit({ maxProfit: '5000%' } as any), 0, 'a percent string is ignored');
assert.strictEqual(effectiveMaxProfit(undefined, settings), 5000, 'global applies when the block has none');
assert.strictEqual(effectiveMaxProfit(1200, settings), 1200, "the block's own value wins");
assert.strictEqual(effectiveMaxProfit(0, settings), 0, "an own 0 means off, it does not fall back");

// a config write must not turn the rupee setting into '5000%'
assert.strictEqual((formatPercentFields({ maxProfit: 5000, maxLoss: 6 } as any) as any).maxProfit, 5000);

const base = { settings: { maxProfit: 5000 }, strategies: [{ type: 'GapStrategy', enabled: true, brokers: ['kite'] }] };
const mp = (c: any) => validateConfigFile(c).filter((e) => /maxProfit/.test(e));
assert.deepStrictEqual(validateConfigFile(base).filter((e) => /maxProfit|brokers|broker key/.test(e)), []);
for (const bad of [{ kite: 5000 }, [5000], '5000', '5000%', 0, -1, NaN]) {
    assert.ok(mp({ ...base, settings: { maxProfit: bad } }).some((e) => /settings\.maxProfit must be a positive number of rupees/.test(e)), `rejects ${JSON.stringify(bad)}`);
}
assert.ok(validateConfigFile({ ...base, strategies: [{ type: 'GapStrategy', enabled: true }] }).some((e) => /brokers is required/.test(e)));
assert.ok(validateConfigFile({ ...base, strategies: [{ type: 'GapStrategy', enabled: true, broker: 'kite', brokers: ['kite'] }] }).some((e) => /REMOVED/.test(e)));
const sc = { type: 'SimpleContinuousStrategy', enabled: true, brokers: ['kite', 'ant'], initialQuantity: 65, maxInvestment: 1, priceDiff: 1 };
assert.deepStrictEqual(mp({ settings: { maxProfit: 5000 }, strategies: [sc] }), []);
const none = mp({ settings: {}, strategies: [sc] });
assert.strictEqual(none.length, 1, 'one error per block, not per broker');
assert.ok(/settings\.maxProfit is not a positive number/.test(none[0]));
assert.deepStrictEqual(mp({ settings: {}, strategies: [{ ...sc, maxProfit: 4000 }] }), [], 'own value needs no global');
console.log('effectiveMaxProfit tests passed');
