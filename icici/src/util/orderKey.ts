import Log from './Log';
import { normalizeBrokerName } from './brokerName';

/**
 * The canonical composite order key `<broker>:<orderId>` (e.g. `ant:26112500161991`), produced ONLY here.
 *
 * Broker order ids are unique only WITHIN a broker. ANT (Alice Blue) and Shoonya/Prism both issue Noren-style numbers from what looks like one
 * sequence space, so the same id string can legitimately appear on two brokers (live 2026-11-25: ANT buy 26112500161991 equalled an earlier
 * Prism order). Every dedupe set, ownership ledger, registry and Mongo lookup therefore keys on this value, never on the bare id.
 *
 * Mongo documents keep the raw `brokerOrderId` (existing docs and external tools read it) AND carry `brokerOrderKey` (this key), indexed.
 * A doc written before the key existed has none: it is matched through `orderIdFilter`, which falls back to broker + raw id for it and
 * NEVER matches a doc of another broker.
 */
export const ORDER_KEY_FIELD = 'brokerOrderKey';

// Docs written before the broker field existed (and in-memory events without one) are Kite's: the platform started on Kite.
const brokerOf = (broker: unknown): string => normalizeBrokerName(broker) || 'kite';

export function orderKey(broker: unknown, orderId: string | number): string {
    return `${brokerOf(broker)}:${orderId}`;
}

// The key of a fill/trade object (Trade, Mongo doc, closed-trade row with a sellOrderId), or undefined when it has no order id.
export function orderKeyOf(t: { broker?: unknown; brokerOrderId?: unknown } | null | undefined): string | undefined {
    const id = t?.brokerOrderId;
    return id != null && String(id) !== '' ? orderKey(t!.broker, String(id)) : undefined;
}

// Sets `brokerOrderKey` on a doc about to be persisted (idempotent). Returns the doc.
export function stampOrderKey<T extends { broker?: unknown; brokerOrderId?: unknown; brokerOrderKey?: string }>(t: T): T {
    const k = orderKeyOf(t);
    if (k) t.brokerOrderKey = k;
    return t;
}

// Mongo filter selecting the docs of ONE (broker, raw order id), keyed or legacy. `idField` is the doc's raw-id field (Trade.brokerOrderId,
// closedTrades.sellOrderId ...), `keyField` its key field. A keyed doc matches on the key alone; a doc with no key matches the raw id only when its
// broker is this one or absent (never another broker's).
export function orderIdFilter(broker: unknown, orderId: string | number, idField = 'brokerOrderId', keyField = ORDER_KEY_FIELD): Record<string, any> {
    const b = brokerOf(broker);
    const id = String(orderId);
    return {
        $or: [
            { [keyField]: orderKey(b, id) },
            { [keyField]: { $exists: false }, [idField]: id, broker: { $in: b === 'kite' ? ['kite', /^\s*zerodha\s*$/i, null] : [b, null] } },
        ],
    };
}

// Splits a key back into its parts (broker never contains ':').
export function parseOrderKey(key: string): { broker: string; orderId: string } | null {
    const i = key.indexOf(':');
    return i > 0 ? { broker: key.slice(0, i), orderId: key.slice(i + 1) } : null;
}

// ---- Collision log: the same order id string seen from two different brokers on one day -----------------------------------------------
const seenBrokers = new Map<string, Set<string>>(); // raw id -> brokers that used it today
let seenDay = '';
const MAX_SEEN = 50000;
const istDay = (now: number) => new Date(now + 330 * 60000).toISOString().slice(0, 10);

// Call wherever an order id is first handled (placement, fill). Logs ONE INFO line per colliding (id, broker pair) per day. Never throws.
export function noteOrderId(broker: unknown, orderId: string | number | undefined | null, now: number = Date.now()): boolean {
    if (orderId == null || String(orderId) === '') return false;
    try {
        const day = istDay(now);
        if (day !== seenDay) { seenBrokers.clear(); seenDay = day; }
        const id = String(orderId), b = brokerOf(broker);
        let set = seenBrokers.get(id);
        if (!set) {
            if (seenBrokers.size >= MAX_SEEN) seenBrokers.delete(seenBrokers.keys().next().value as string);
            seenBrokers.set(id, new Set([b]));
            return false;
        }
        if (set.has(b)) return false;
        const others = [...set];
        set.add(b);
        Log.log(`[order] INFO: order id ${id} seen from two brokers today (${others.join(', ')} and ${b}) - ids are only unique per broker, every lookup keys on '${orderKey(b, id)}'`);
        return true;
    } catch { return false; }
}
export function resetOrderIdCollisionLog(): void { seenBrokers.clear(); seenDay = ''; }
