import * as kite from './pendingLimitOrders';
import * as breeze from './breezePendingLimitOrders';
import * as ant from './pendingAntLimitOrders';
import * as prism from './pendingPrismLimitOrders';
import { OptionExchange } from './BrokerExecutor';
import { CancelledListener, TrackerBroker } from './pendingOrderTracker';

// The one lookup from a broker name to its pending-order tracker, so orderProcess.ts wires them in loops instead of four
// copies of every site. Each module's exports are bound methods of its PendingOrderTracker.
export interface TrackerHandle {
    find(userId: string, tradingSymbol: string): { orderId: string; action: 'Buy' | 'Sell'; quantity: number; exchange: OptionExchange }[];
    all(): { orderId: string; userId: string; tradingSymbol: string; action: 'Buy' | 'Sell'; quantity: number; exchange: OptionExchange }[];
    load(): Promise<void>;
    poll(): Promise<void>;
    onCancelled(listener: CancelledListener): void;
}

export const TRACKERS: Record<TrackerBroker, TrackerHandle> = {
    kite: { find: kite.findPendingOrdersForSymbol, all: kite.allPendingOrders, load: kite.loadPendingLimitOrdersFromMongo, poll: kite.pollPendingLimitOrders, onCancelled: kite.onCancelled },
    breeze: { find: breeze.findPendingOrdersForSymbol, all: breeze.allPendingOrders, load: breeze.loadPendingBreezeLimitOrdersFromMongo, poll: breeze.pollPendingBreezeLimitOrders, onCancelled: breeze.onCancelled },
    ant: { find: ant.findPendingOrdersForSymbol, all: ant.allPendingOrders, load: ant.loadPendingAntLimitOrdersFromMongo, poll: ant.pollPendingAntLimitOrders, onCancelled: ant.onCancelled },
    prism: { find: prism.findPendingOrdersForSymbol, all: prism.allPendingOrders, load: prism.loadPendingPrismLimitOrdersFromMongo, poll: prism.pollPendingPrismLimitOrders, onCancelled: prism.onCancelled },
};

export const TRACKER_BROKERS = Object.keys(TRACKERS) as TrackerBroker[];
