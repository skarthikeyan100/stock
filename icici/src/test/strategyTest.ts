/**
 * Mock-based test for the refactored strategy system.
 * Tests the Monitor-as-mediator pattern without a live broker.
 *
 * Run: npm run server (compile), then: node ./dist/test/strategyTest.js
 */

import { NiftyQuote, OptionQuote, OrderInfo, Trade } from '../model/model';
import Monitor from '../monitor';
import { Strategy } from '../strategy/strategy';
import strategies from '../strategy/strategies';

// --- Mock Prism ---
// We override Monitor's requestBuy/requestSell to avoid calling real Prism.
// Instead, they simulate order placement and immediately fire a trade confirmation.

let orderCount = 0;

class MockMonitor extends Monitor {
    buyOrders: Array<{ userId: string; contract: string; qty: number; price: number }> = [];
    sellOrders: Array<{ userId: string; contract: string; qty: number; price: number }> = [];

    async requestBuy(userId: string, contract: string, qty: number, price?: number): Promise<OrderInfo | null> {
        const validation = this.canPlaceOrder(userId);
        if (!validation.allowed) {
            console.log(`  [MockMonitor] REJECTED buy for ${userId}: ${validation.reason}`);
            return null;
        }
        this.pendingUsers.add(userId);
        const orderInfo = new OrderInfo();
        orderInfo.contract = contract;
        orderInfo.qty = qty;
        orderInfo.price = price || 100;
        orderInfo.token = 'TOKEN_' + (++orderCount);
        this.buyOrders.push({ userId, contract, qty, price: orderInfo.price });
        console.log(`  [MockMonitor] BUY placed for ${userId}: ${contract} qty=${qty} price=${orderInfo.price}`);

        // Simulate order confirmation
        const tradeEvent = new Trade();
        tradeEvent.tsym = contract;
        tradeEvent.token = orderInfo.token;
        tradeEvent.quantity = qty;
        tradeEvent.price = orderInfo.price;
        tradeEvent.action = 'Buy';
        tradeEvent.status = 'COMPLETE';
        tradeEvent.right = contract.indexOf('P') !== -1 ? 'put' : 'call';
        tradeEvent.user = userId;
        tradeEvent.lastTradePrice = orderInfo.price;

        await this._processTradeEvent(tradeEvent);

        const strategy = (this as any).strategyMap.get(userId);
        if (strategy) {
            await strategy.updateTrade(tradeEvent);
        }

        return orderInfo;
    }

    async requestSell(userId: string, contract: string, qty: number, price?: number): Promise<void> {
        this.sellOrders.push({ userId, contract, qty, price: price || 100 });
        console.log(`  [MockMonitor] SELL placed for ${userId}: ${contract} qty=${qty} price=${price}`);

        const tradeEvent = new Trade();
        tradeEvent.tsym = contract;
        tradeEvent.quantity = qty;
        tradeEvent.price = price || 100;
        tradeEvent.action = 'Sell';
        tradeEvent.status = 'COMPLETE';
        tradeEvent.right = contract.indexOf('P') !== -1 ? 'put' : 'call';
        tradeEvent.user = userId;

        await this._processTradeEvent(tradeEvent);

        const strategy = (this as any).strategyMap.get(userId);
        if (strategy) {
            await strategy.updateTrade(tradeEvent);
        }
    }

    async requestBuyIndex(userId: string, index: string, ltp?: number, right?: string, qty?: number) {
        const validation = this.canPlaceOrder(userId);
        if (!validation.allowed) {
            console.log(`  [MockMonitor] REJECTED buyIndex for ${userId}: ${validation.reason}`);
            return null;
        }
        this.pendingUsers.add(userId);
        const contract = `NIFTY13FEB26${right === 'put' ? 'P' : 'C'}${ltp || 24500}`;
        const orderInfo = new OrderInfo();
        orderInfo.contract = contract;
        orderInfo.qty = qty || 65;
        orderInfo.price = 100;
        orderInfo.token = 'TOKEN_' + (++orderCount);
        this.buyOrders.push({ userId, contract, qty: orderInfo.qty, price: orderInfo.price });
        console.log(`  [MockMonitor] BUYINDEX placed for ${userId}: ${contract} qty=${orderInfo.qty}`);
        return orderInfo;
    }
}

// --- Test Helpers ---

function mockNiftyQuote(ltp: number): NiftyQuote {
    const q = new NiftyQuote();
    q.ltp = ltp;
    q.token = 'NIFTY';
    q.open = ltp - 50;
    q.high = ltp + 100;
    q.low = ltp - 100;
    q.prevClose = ltp - 30;
    q.buyQty = 5000;
    q.sellQty = 4000;
    return q;
}

function mockOptionQuote(token: string, ltp: number): OptionQuote {
    const q = new OptionQuote();
    q.ltp = ltp;
    q.token = token;
    return q;
}

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

// --- Simple Test Strategy ---

class TestBuyStrategy extends Strategy {
    niftyQuoteReceived = false;
    optionQuoteReceived = false;
    tradeConfirmed = false;
    boughtContract: string = '';

    constructor(userId: string) {
        super(userId);
        this.enabled = true;
    }

    receive(oldStats, newStats) {}

    async processNiftyQuote(quote: NiftyQuote) {
        this.niftyQuoteReceived = true;
        if (!this.ordered) {
            this.ordered = true;
            const response = await this.buyContract('NIFTY13FEB26C24500', 65, 100);
            if (response) {
                this.boughtContract = response.contract;
                this.token = response.token;
            }
        }
    }

    async processOptionQuote(quote: OptionQuote) {
        this.optionQuoteReceived = true;
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.token != null && this.token === quote.token;
    }

    updateTrade = async (trade: Trade) => {
        this.tradeConfirmed = true;
    }
}

// --- Tests ---

async function testStrategyRegistration() {
    console.log('\n--- Test: Strategy Registration ---');
    const monitor = new MockMonitor();
    Monitor.instance = monitor;

    const s1 = new TestBuyStrategy('Strategy-A');
    const s2 = new TestBuyStrategy('Strategy-B');

    monitor.registerStrategy(s1);
    monitor.registerStrategy(s2);

    assert((monitor as any).strategyMap.size === 2, 'Two strategies registered');
    assert((monitor as any).strategyMap.get('Strategy-A') === s1, 'Strategy-A found by userId');

    monitor.unregisterStrategy('Strategy-A');
    assert((monitor as any).strategyMap.size === 1, 'One strategy after unregister');
}

async function testNiftyQuoteBroadcast() {
    console.log('\n--- Test: NiftyQuote Broadcasting ---');
    const monitor = new MockMonitor();
    Monitor.instance = monitor;

    const s1 = new TestBuyStrategy('Strategy-A');
    const s2 = new TestBuyStrategy('Strategy-B');
    s2.enabled = false; // disabled, should NOT receive quotes

    // Manually add to strategies list for onNiftyQuote to iterate
    strategies.addToList(s1);
    strategies.addToList(s2);
    monitor.registerStrategy(s1);
    monitor.registerStrategy(s2);

    await monitor.onNiftyQuote(mockNiftyQuote(24500));

    assert(s1.niftyQuoteReceived === true, 'Enabled strategy received NiftyQuote');
    assert(s2.niftyQuoteReceived === false, 'Disabled strategy did NOT receive NiftyQuote');
}

async function testOrderGatewayAndConfirmation() {
    console.log('\n--- Test: Order Gateway + Trade Confirmation ---');
    const monitor = new MockMonitor();
    Monitor.instance = monitor;

    const s1 = new TestBuyStrategy('Strategy-A');
    monitor.registerStrategy(s1);
    strategies.addToList(s1);

    // Strategy places buy via Monitor
    await monitor.onNiftyQuote(mockNiftyQuote(24500));

    assert(monitor.buyOrders.length > 0, 'Buy order was placed via Monitor');
    assert(monitor.buyOrders[0].userId === 'Strategy-A', 'Order tracked with correct userId');
    assert(s1.tradeConfirmed === true, 'Strategy received trade confirmation');
    assert(monitor.trades.length > 0 || monitor.closedTrades.length > 0, 'Monitor tracks the trade');
}

async function testCanPlaceOrderRules() {
    console.log('\n--- Test: canPlaceOrder Rules ---');
    const monitor = new MockMonitor();
    Monitor.instance = monitor;

    // Test lot limit
    monitor.updateUserSettings('LotLimitUser', { lossLimit: 15000, lotLimit: 1, maxInvestment: 100000 });
    // Simulate an existing trade consuming 1 lot
    const existingTrade = new Trade();
    existingTrade.tsym = 'NIFTY13FEB26C24500';
    existingTrade.token = 'T1';
    existingTrade.quantity = 65;
    existingTrade.price = 100;
    existingTrade.user = 'LotLimitUser';
    existingTrade.action = 'Buy';
    existingTrade.right = 'call';
    monitor.trades.push(existingTrade);

    let result = monitor.canPlaceOrder('LotLimitUser');
    assert(result.allowed === false, 'Lot limit blocks order');
    assert(result.reason.includes('lot limit'), 'Reason mentions lot limit');

    // Test loss limit
    monitor.userPnL.set('LossUser', -16000);
    result = monitor.canPlaceOrder('LossUser');
    assert(result.allowed === false, 'Loss limit blocks order');
    assert(result.reason.includes('loss limit'), 'Reason mentions loss limit');

    // Test max investment
    monitor.updateUserSettings('InvestmentUser', { lossLimit: 15000, lotLimit: 100, maxInvestment: 5000 });
    const bigTrade = new Trade();
    bigTrade.tsym = 'NIFTY13FEB26C24500';
    bigTrade.token = 'T2';
    bigTrade.quantity = 100;
    bigTrade.price = 100; // 100 * 100 = 10000 > 5000
    bigTrade.user = 'InvestmentUser';
    bigTrade.action = 'Buy';
    bigTrade.right = 'call';
    monitor.trades.push(bigTrade);

    result = monitor.canPlaceOrder('InvestmentUser');
    assert(result.allowed === false, 'Investment limit blocks order');
    assert(result.reason.includes('max investment'), 'Reason mentions max investment');

    // Test allowed user
    result = monitor.canPlaceOrder('FreshUser');
    assert(result.allowed === true, 'Fresh user is allowed');
}

async function testOptionQuoteRoutesToOwner() {
    console.log('\n--- Test: OptionQuote Routes to Trade Owner ---');
    const monitor = new MockMonitor();
    Monitor.instance = monitor;

    const s1 = new TestBuyStrategy('Strategy-A');
    const s2 = new TestBuyStrategy('Strategy-B');
    monitor.registerStrategy(s1);
    monitor.registerStrategy(s2);

    // Simulate a trade owned by Strategy-A
    const trade = new Trade();
    trade.tsym = 'NIFTY13FEB26C24500';
    trade.token = 'TOKEN_99';
    trade.quantity = 65;
    trade.price = 100;
    trade.user = 'Strategy-A';
    trade.action = 'Buy';
    trade.right = 'call';
    trade.lastTradePrice = 100;
    monitor.trades.push(trade);

    s1.token = 'TOKEN_99'; // So canHandleOptionQuote returns true

    await monitor.updateQuote(mockOptionQuote('TOKEN_99', 105));

    assert(s1.optionQuoteReceived === true, 'Strategy-A received option quote for its trade');
    assert(s2.optionQuoteReceived === false, 'Strategy-B did NOT receive option quote');
}

async function testMultipleStrategiesIndependent() {
    console.log('\n--- Test: Multiple Strategies Operate Independently ---');
    const monitor = new MockMonitor();
    Monitor.instance = monitor;

    const s1 = new TestBuyStrategy('IndepA');
    const s2 = new TestBuyStrategy('IndepB');
    monitor.registerStrategy(s1);
    monitor.registerStrategy(s2);
    strategies.addToList(s1);
    strategies.addToList(s2);

    await monitor.onNiftyQuote(mockNiftyQuote(24500));

    assert(s1.ordered === true, 'Strategy IndepA placed an order');
    assert(s2.ordered === true, 'Strategy IndepB placed an order');
    assert(monitor.buyOrders.length >= 2, 'Both strategies placed orders without blocking each other');

    const userIds = monitor.buyOrders.map(o => o.userId);
    assert(userIds.includes('IndepA'), 'IndepA order found');
    assert(userIds.includes('IndepB'), 'IndepB order found');
}

// --- Run All Tests ---

async function runAllTests() {
    console.log('=== Strategy System Tests ===\n');

    // Reset singleton between tests
    const runTest = async (name: string, fn: () => Promise<void>) => {
        Monitor.instance = null;
        // Clear strategies list
        while (strategies.getList().length > 0) {
            const s = strategies.getList()[0];
            strategies.removeFromList(s.userId);
        }
        orderCount = 0;
        try {
            await fn();
        } catch (e) {
            console.log(`  ERROR in ${name}:`, e.message);
            process.exitCode = 1;
        }
    };

    await runTest('Registration', testStrategyRegistration);
    await runTest('NiftyQuote Broadcast', testNiftyQuoteBroadcast);
    await runTest('Order Gateway', testOrderGatewayAndConfirmation);
    await runTest('canPlaceOrder Rules', testCanPlaceOrderRules);
    await runTest('OptionQuote Routing', testOptionQuoteRoutesToOwner);
    await runTest('Multiple Strategies', testMultipleStrategiesIndependent);

    console.log('\n=== Tests Complete ===');
}

runAllTests();
