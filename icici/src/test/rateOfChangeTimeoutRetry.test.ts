import assert from 'assert';
import { RateOfChangeContract } from '../strategy/RateOfChangeStrategy';

(async () => {
    const outcomes: any[] = [];
    let sells = 0;
    let failSell = true;
    const strategy: any = {
        getConfig: () => ({ maxHoldTimeMinutes: 1, logEnabled: false }),
        recordOutcome: (o: string, p: number) => outcomes.push([o, p]),
        sellContract: async () => { sells++; if (failSell) throw new Error('boom'); },
    };
    const c = new RateOfChangeContract();
    c.contract = 'X'; c.token = 't'; c.price = 100; c.quantity = 10;
    c.entryTime = Date.now() - 120_000;
    const q: any = { token: 't', ltp: 90 };

    await c.processOptionQuote(q, strategy);
    assert.strictEqual(sells, 1);
    assert.strictEqual(outcomes.length, 1);
    await c.processOptionQuote(q, strategy); // immediately after: inside the retry delay, nothing happens
    assert.strictEqual(sells, 1, 'no retry inside the delay');
    assert.strictEqual(outcomes.length, 1);

    c.sellRetryAt = Date.now() - 1; // delay elapsed: retried, still fails, outcome NOT recorded again
    await c.processOptionQuote(q, strategy);
    assert.strictEqual(sells, 2);
    assert.strictEqual(outcomes.length, 1, 'outcome recorded once');

    failSell = false;
    c.sellRetryAt = 0;
    await c.processOptionQuote(q, strategy);
    assert.strictEqual(sells, 3);
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(c.sellOrderPlaced, true);
    const closed = await c.updateTrade({ tsym: 'X', action: 'Sell', price: 90, quantity: 10 } as any, strategy);
    assert.strictEqual(closed, true);
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(c.timeoutRecorded, false);
    console.log('rateOfChangeTimeoutRetry: OK');
})().catch(e => { console.error(e); process.exit(1); });
