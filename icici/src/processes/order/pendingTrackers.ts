import * as kite from './pendingLimitOrders';
import * as breeze from './breezePendingLimitOrders';
import * as ant from './pendingAntLimitOrders';
import * as prism from './pendingPrismLimitOrders';
import { PAPER_TRACKER } from './paperExecutor';
import { OptionExchange } from './BrokerExecutor';
import { CancelledListener, TrackerBroker } from './pendingOrderTracker';

// The one lookup from a broker name to its pending-order tracker, so orderProcess.ts wires them in loops instead of four
// copies of every site. Each module's exports are bound methods of its PendingOrderTracker.
export interface TrackerHandle {
    find(userId: string, tradingSymbol: string): { orderId: string; action: 'Buy' | 'Sell'; quantity: number; exchange: OptionExchange; price?: number }[];
    all(): { orderId: string; userId: string; tradingSymbol: string; action: 'Buy' | 'Sell'; quantity: number; exchange: OptionExchange; cancelAfter?: number }[];
    load(): Promise<void>;
    poll(): Promise<void>;
    onCancelled(listener: CancelledListener): void;
    /** True while an executor waits for this order's fill (see PendingOrderTracker.awaitBuy). */
    isHeld?(orderId: string): boolean;
}

export const TRACKERS: Record<TrackerBroker, TrackerHandle> = {
    kite: { find: kite.findPendingOrdersForSymbol, all: kite.allPendingOrders, load: kite.loadPendingLimitOrdersFromMongo, poll: kite.pollPendingLimitOrders, onCancelled: kite.onCancelled, isHeld: kite.isHeldKiteOrder },
    breeze: { find: breeze.findPendingOrdersForSymbol, all: breeze.allPendingOrders, load: breeze.loadPendingBreezeLimitOrdersFromMongo, poll: breeze.pollPendingBreezeLimitOrders, onCancelled: breeze.onCancelled, isHeld: breeze.isHeldBreezeOrder },
    ant: { find: ant.findPendingOrdersForSymbol, all: ant.allPendingOrders, load: ant.loadPendingAntLimitOrdersFromMongo, poll: ant.pollPendingAntLimitOrders, onCancelled: ant.onCancelled, isHeld: ant.isHeldAntOrder },
    prism: { find: prism.findPendingOrdersForSymbol, all: prism.allPendingOrders, load: prism.loadPendingPrismLimitOrdersFromMongo, poll: prism.pollPendingPrismLimitOrders, onCancelled: prism.onCancelled, isHeld: prism.isHeldPrismOrder },
    paper: PAPER_TRACKER, // in-memory book (paperExecutor.ts): nothing to load or poll
};

export const TRACKER_BROKERS = Object.keys(TRACKERS) as TrackerBroker[];
