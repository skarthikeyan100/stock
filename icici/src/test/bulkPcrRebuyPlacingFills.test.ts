/** BulkPcr placeRestingRebuy: placingRebuy is cleared on every exit; a fill buffered while a placement that placed nothing fails is ALERTed, not dropped. */
import assert from 'assert';
import BulkPcrStrategy from '../strategy/BulkPcrStrategy';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import Log from '../util/Log';

(configService as any).configPath = `/tmp/bulkPcrRebuyPlacingFills-config-${process.pid}.yml`;
(configService as any).config = {
    settings: {},
    strategies: [{ type: 'BulkPcrStrategy', userId: 'rb-1', enabled: true, brokers: ['ant'], targetPoints: 2, quantity: -1, slDistance: 10, index: 'NIFTY', maxInvestment: 100000, maxInvestmentByBroker: { ant: 100000 } }],
};

async function main() {
    const logs: string[] = [];
    const origLog = Log.log;
    (Log as any).log = (...a: any[]) => { logs.push(a.join(' ')); };
    try {
        const s = new BulkPcrStrategy('rb-1') as any;
        const tsym = 'NIFTY26DEC24000CE';
        s.positions.set('ant_call', { broker: 'ant', right: 'call', phase: 'selling', heldTsym: 'NIFTYC', heldToken: 'C1', entryAvg: 100, targetQuantity: 100, soldQty: 0, soldValue: 0, entryQuantity: 100 });
        s.positions.set('ant_put', { broker: 'ant', right: 'put', phase: 'pending', hedge: true, heldTsym: tsym, heldToken: 'P1', entryAvg: 40, entryQuantity: 100, rebuyLimit: { tsym, token: 'T1', price: 40 } });
        const pos = s.positions.get('ant_put');
        const client = OrderClient.getInstance() as any;
        client.placeLimitBuyBare = async () => {
            // a Buy fill for the contract arrives while the placement call is in flight
            await s.updateTrade({ broker: 'ant', tsym, action: 'Buy', quantity: 50, price: 40 });
            throw Object.assign(new Error('[NOT_PLACED] not placed'), { notPlaced: true, orderNotPlaced: true });
        };
        await s.placeRestingRebuy('ant_put');
        assert.strictEqual(pos.placingRebuy, undefined, 'placingRebuy cleared on the nothing-placed failure branch');
        assert.ok(logs.some((l) => /ALERT.*Buy fill .* qty=50 .*placed no order/.test(l)), 'the buffered fill is ALERTed, not dropped silently');

        // Success path unchanged: an early fill is replayed into the recorded re-buy and the field is cleared.
        logs.length = 0;
        pos.phase = 'pending'; pos.rebuy = undefined;
        client.placeLimitBuyBare = async () => {
            await s.updateTrade({ broker: 'ant', tsym, action: 'Buy', quantity: 40, price: 40 });
            return { orderId: 'O1' };
        };
        await s.placeRestingRebuy('ant_put');
        assert.strictEqual(pos.placingRebuy, undefined, 'placingRebuy cleared on success');
        assert.strictEqual(pos.rebuy?.filledQty, 40, `early fill replayed into the re-buy (got ${JSON.stringify(pos.rebuy)})`);
        assert.strictEqual(pos.phase, 'resting', 'still resting (40/100)');
    } finally {
        (Log as any).log = origLog;
    }
    console.log('bulkPcrRebuyPlacingFills: all passed');
}
main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
