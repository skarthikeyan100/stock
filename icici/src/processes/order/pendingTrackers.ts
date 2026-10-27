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
    load(): Promise<void>;
    poll(): Promise<void>;
    onCancelled(listener: CancelledListener): void;
}

export const TRACKERS: Record<TrackerBroker, TrackerHandle> = {
    kite: { find: kite.findPendingOrdersForSymbol, load: kite.loadPendingLimitOrdersFromMongo, poll: kite.pollPendingLimitOrders, onCancelled: kite.onCancelled },
    breeze: { find: breeze.findPendingOrdersForSymbol, load: breeze.loadPendingBreezeLimitOrdersFromMongo, poll: breeze.pollPendingBreezeLimitOrders, onCancelled: breeze.onCancelled },
    ant: { find: ant.findPendingOrdersForSymbol, load: ant.loadPendingAntLimitOrdersFromMongo, poll: ant.pollPendingAntLimitOrders, onCancelled: ant.onCancelled },
    prism: { find: prism.findPendingOrdersForSymbol, load: prism.loadPendingPrismLimitOrdersFromMongo, poll: prism.pollPendingPrismLimitOrders, onCancelled: prism.onCancelled },
};

export const TRACKER_BROKERS = Object.keys(TRACKERS) as TrackerBroker[];
