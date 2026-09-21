/**
 * Regression test for the orphaned-leg bug: a target-hit/square-off sell that
 * fails to reach the broker (e.g. Kite IP-whitelist rejection) must NOT be
 * recorded as a closed outcome, and the leg must stay tracked in legsByToken
 * so the next quote tick retries the close - see orchestrator.log 09:49:34
 * (NIFTY2690823850CE) for the incident this reproduces.
 * Run: npm run build (compile), then: node ./dist/test/continuousStrategySellFailure.test.js
 */

import ContinuousStrategy from '../strategy/ContinuousStrategy';
import OrderClient from '../processes/strategies/OrderClient';
import { OptionQuote } from '../model/model';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function makeLeg(token: string) {
    return {
        legId: 'test-leg-1', token, tsym: 'NIFTY2690823850CE', strike: 23850,
        exchange: 'NFO' as const, right: 'CALL',
        entryPrice: 100, quantity: 65, isRoot: true,
        parentLegId: null, parentLevel: null, childByLevel: new Map(),
        status: 'OPEN' as const, avgPrice: 100, totalQuantity: 65,
        averagedLevels: new Set<number>(),
    };
}

async function main() {
    const orderClient = OrderClient.getInstance() as any;

    // --- Case 1: sell fails - leg must remain tracked, no outcome recorded ---
    {
        const strategy = new ContinuousStrategy('ContinuousStrategy') as any;
        const leg = makeLeg('10914050');
        strategy.legManager.getLegsByToken().set(leg.token, leg);

        orderClient.sellContractBare = async () => {
            throw new Error('IP not allowed to place orders for this app');
        };

        const quote = Object.assign(new OptionQuote(), { token: leg.token, ltp: 100000 });
        await strategy.processOptionQuote(quote);

        assert(strategy.legManager.getLegsByToken().has(leg.token), 'leg stays in legsByToken after a failed sell (not orphaned)');
        assert(strategy.legManager.getLegsByToken().get(leg.token).status === 'OPEN', 'leg status reverts to OPEN after a failed sell, so the next tick retries');
        assert(strategy.wins === 0, 'a failed sell does not get recorded as a win');
        assert(strategy.totalPnL === 0, 'a failed sell does not get recorded as PnL');
    }

    // --- Case 2: sell succeeds - leg closes and outcome IS recorded ---
    {
        const strategy = new ContinuousStrategy('ContinuousStrategy') as any;
        const leg = makeLeg('10914050');
        strategy.legManager.getLegsByToken().set(leg.token, leg);

        orderClient.sellContractBare = async () => ({ status: 'COMPLETE' });

        const quote = Object.assign(new OptionQuote(), { token: leg.token, ltp: 100000 });
        await strategy.processOptionQuote(quote);

        assert(!strategy.legManager.getLegsByToken().has(leg.token), 'leg is removed from legsByToken after a successful sell');
        assert(strategy.wins === 1, 'a successful target-hit sell is recorded as a win');
    }

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
