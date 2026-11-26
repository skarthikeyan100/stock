import { randomUUID } from 'crypto';
import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import Kite from '../../kite/Kite';
import KiteContractMaster from '../../kite/KiteContractMaster';
import AntContractMaster from '../../ant/AntContractMaster';
import BreezeContractMaster from '../../breeze/BreezeContractMaster';
import configService from '../../prism/ConfigService';
import { Trade } from '../../model/model';
import { CALL } from '../../constants';
import { parseCanonicalSymbol } from '../../model/CanonicalSymbol';
import { exchangeForIndex } from '../../util/underlyings';
import { calendarDayUtc } from '../../util/expirySkip';
import { markNotPlaced } from '../../util/notPlaced';
import { splitIntoFreezeQtyChunks } from '../../util/quantityChunks';
import { roundToTick, NFO_TICK_SIZE } from '../../util/tick';
import bookkeeping from './bookkeeping';
import * as exitMonitor from './exitMonitor';
import { TRACKERS } from './pendingTrackers';
import { defaultFreezeQty, throttleOrderPlacement } from './chunkedOrder';
import { gttIdsOf, persistGttTriggerId, reprotectAfterBuy, placeLimitBuyBareOnKite, cancelOrderOnKite } from './kiteExecutor';
import { placeLimitBuyBareOnAnt, cancelOrderOnAnt } from './antExecutor';
import { placeLimitBuyBareOnBreeze, cancelOrderOnBreeze, tsymFor } from './breezeExecutor';
import { OptionExchange, OrderAlreadyFilledError } from './BrokerExecutor';
import { startMirrorBuy, forgetRestingMirror } from './mirror';
import { EntryExit, registerEntryExit, onEntryFill, onEntryCancelled, registerLotProtector, lotEntriesOfToday } from './entryExits';
import {
    LockedBroker, isLockedBroker, registerLockedOrder, allLockedOrders, trackedOrder, kickPoll, notifyUser, onLockedBuyEnded, onLockedCancelDone, cancelLockedOrder,
} from './lockedOrders';

// A frontend user's buy at the price they clicked: a resting LIMIT order at exactly that price (rounded DOWN to the tick, so it never pays more
// than was shown) on kite, ant or breeze. It stays until it fills, is cancelled, or the exchange expires it at the close; it is never turned
// into a market order. Each order's target / stop-loss waits in Mongo `entryExits` (entryExits.ts) and is put on the filled lot here:
// target = limit price + target points, stop = limit price - stop points (re-measured from the fill when a better fill left a level on the wrong
// side of it). Sizing, limits and the loss budget are the same server-side rules as the market manual buy; a resting order keeps its value
// reserved until it ends, so a second click is sized against what is left. See also lockedOrders.ts (pending list, cancel, partial fills).

export interface LockedBuyPayload {
    contract?: string;
    index?: 'NIFTY' | 'SENSEX';
    right?: string;
    strikePrice?: number;
    /** The ANT token of the contract whose price the user clicked: refused when it is no longer what the contract resolves to. */
    token?: string;
    limitPrice: number;
    targetPoints?: number;
    stopLossPoints?: number;
}

export interface LockedBuyResult {
    resting: true; broker: LockedBroker; tsym: string; quantity: number; limitPrice: number; orderIds: string[];
    /** Set when only part of a split order could be placed. */
    error?: string;
}

interface Contract { tsym: string; token: string; exchange: OptionExchange; lotSize: number }

/** The highest tick at or below `price`: a buy never offers more than the price shown. */
export function floorToTick(price: number): number {
    return Math.round(Math.floor(price / NFO_TICK_SIZE + 1e-6) * NFO_TICK_SIZE * 100) / 100;
}

const refuse = (message: string): Error => markNotPlaced(new Error(message));

async function resolveContract(broker: LockedBroker, p: LockedBuyPayload): Promise<Contract> {
    let symbol: string;
    let strike: number;
    let optionType: 'CE' | 'PE';
    if (p.contract) {
        ({ symbol, strike, optionType } = parseCanonicalSymbol(p.contract));
    } else {
        if (!p.right || !(Number(p.strikePrice) > 0)) throw new Error('a buy at a locked price needs a contract, or a right and a strike');
        symbol = p.index === 'SENSEX' ? 'SENSEX' : 'NIFTY';
        strike = Number(p.strikePrice);
        optionType = p.right === CALL ? 'CE' : 'PE';
    }
    const ant = AntContractMaster.getInstance();
    const a = ant.findNearestExpiryOption({ symbol, exch: exchangeForIndex(symbol), strike, optionType });
    if (p.token && String(a.token) !== String(p.token)) throw new Error('The contract shown on screen is no longer the current one - check the new price and click again');
    if (broker === 'ant') return { tsym: a.tradingSymbol, token: String(a.token), exchange: a.exch as OptionExchange, lotSize: Number(a.lotSize) };
    if (broker === 'kite') {
        const k = await KiteContractMaster.getInstance().findNearestExpiryOption(strike, optionType, symbol);
        const named = ant.findByAnyBrokerTradingSymbol(k.tradingSymbol, k.exchange);
        if (named && String(named.token) !== String(a.token)) throw new Error(`Kite's contract ${k.tradingSymbol} is not the one whose price was shown - not placed`);
        return { tsym: k.tradingSymbol, token: String(a.token), exchange: k.exchange, lotSize: k.lotSize };
    }
    const b = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, symbol, undefined, calendarDayUtc(a.expiryMs));
    // A Breeze position is keyed by Breeze's own token (its ticks come from the Breeze feed), as in the market manual buy.
    return { tsym: tsymFor(b), token: b.token, exchange: b.exchange as OptionExchange, lotSize: b.lotSize };
}

// An ANT bracket row is exited as a whole through its bracket, which would book a plain lot added to it as sold while the broker still holds it.
function holdsAntBracket(userId: string, tsym: string): boolean {
    return bookkeeping.trades.some((t) => t.user === userId && t.tsym === tsym && t.broker === 'ant' && !!t.antOrderNo);
}

interface PlaceArgs {
    userId: string; broker: LockedBroker; contract: Contract; limitPrice: number; targetPoints: number; stopPoints: number; clickId: string;
    chunks: number[];
    /** The reservation of each chunk (the user's own order; the admin mirror takes none, as for every mirror). */
    reservations?: ReturnType<typeof bookkeeping.markPending>[];
    mirrorOf?: { userId: string; clickId: string };
}

async function placeOne(a: PlaceArgs, quantity: number): Promise<string> {
    const { userId, broker, contract: c, limitPrice } = a;
    if (broker === 'ant') return (await placeLimitBuyBareOnAnt(userId, c.tsym, c.token, quantity, limitPrice, c.exchange)).orderId;
    if (broker === 'breeze') return (await placeLimitBuyBareOnBreeze(userId, c.tsym, c.token, quantity, limitPrice, c.exchange)).orderId;
    return (await placeLimitBuyBareOnKite(userId, c.tsym, c.token, quantity, limitPrice, c.exchange)).orderId;
}

const cancelBuy = (broker: LockedBroker, orderId: string, exchange: OptionExchange): Promise<void> =>
    broker === 'ant' ? cancelOrderOnAnt(orderId) : broker === 'breeze' ? cancelOrderOnBreeze(orderId, exchange) : cancelOrderOnKite(orderId);

async function placeLockedOrders(a: PlaceArgs): Promise<{ orderIds: string[]; placedQuantity: number; error?: string }> {
    const { userId, broker, contract: c, limitPrice, chunks } = a;
    const orderIds: string[] = [];
    let placed = 0;
    const releaseFrom = (i: number) => { for (const r of (a.reservations ?? []).slice(i)) bookkeeping.releaseReservation(userId, r); };
    if (broker === 'ant' && holdsAntBracket(userId, c.tsym)) {
        releaseFrom(0);
        throw refuse(`${c.tsym} is held with an ANT bracket order: square it off before buying more of it`);
    }
    for (let i = 0; i < chunks.length; i++) {
        const quantity = chunks[i];
        let orderId: string;
        try {
            if (chunks.length > 1) await throttleOrderPlacement();
            orderId = await placeOne(a, quantity);
        } catch (e: any) {
            releaseFrom(i);
            if (placed === 0) throw e;
            Log.log(`[order] ALERT: limit buy ${c.tsym} for ${userId}: order ${i + 1}/${chunks.length} failed after ${placed} was placed:`, e);
            return { orderIds, placedQuantity: placed, error: `only ${placed} of ${chunks.reduce((s, q) => s + q, 0)} was placed: ${e?.message ?? e}` };
        }
        const reservation = a.reservations?.[i];
        if (reservation) reservation.orderId = orderId;
        registerLockedOrder({ orderId, broker, userId, action: 'Buy', tsym: c.tsym, token: c.token, exchange: c.exchange, quantity, price: limitPrice, placedAt: Date.now(), clickId: a.clickId, ...(a.mirrorOf ? { mirrorOf: a.mirrorOf } : {}) });
        const row: Omit<EntryExit, 'day' | 'createdAt'> = {
            userId, orderId, tsym: c.tsym, token: c.token, exchange: c.exchange, broker,
            targetPrice: a.targetPoints > 0 ? roundToTick(limitPrice + a.targetPoints) : 0,
            stopLossPrice: a.stopPoints > 0 ? Math.max(NFO_TICK_SIZE, roundToTick(limitPrice - a.stopPoints)) : 0,
            lot: true, quantity, limitPrice, targetPoints: a.targetPoints, stopPoints: a.stopPoints, inAppExit: chunks.length > 1, clickId: a.clickId, ...(a.mirrorOf ? { mirrorOf: a.mirrorOf } : {}),
        };
        try {
            await registerEntryExit(row);
        } catch (e: any) {
            // The order is live but its exits could not be recorded: take it back rather than leave a position that would have none.
            releaseFrom(i + 1);
            let filled = false;
            try { await cancelBuy(broker, orderId, c.exchange); }
            catch (ce) {
                filled = ce instanceof OrderAlreadyFilledError;
                if (!filled) Log.log(`[order] ALERT: limit buy ${orderId} (${c.tsym}, ${userId}) could not be cancelled after its exits failed to record - cancel it at the broker:`, ce);
                else {
                    await TRACKERS[broker].poll().catch(() => undefined);
                    await protectLot(userId, Object.assign(new Trade(), { action: 'Buy', brokerOrderId: orderId, broker, tsym: c.tsym, quantity: (ce as OrderAlreadyFilledError).filledQuantity, price: 0 }), { ...row, day: '', createdAt: new Date() });
                }
                throw Object.assign(new Error(`The order was placed but its target / stop-loss could not be recorded, and it ${filled ? 'had already filled' : 'could not be cancelled'}: check Pending orders and your positions. ${e?.message ?? e}`), { orderMayBeLive: true });
            }
            if (placed === 0) throw new Error(`The order was cancelled because its target / stop-loss could not be recorded: ${e?.message ?? e}`);
            return { orderIds, placedQuantity: placed, error: `only ${placed} was placed: ${e?.message ?? e}` };
        }
        orderIds.push(orderId);
        placed += quantity;
        // Booked while its row was still being written: the fill listener found no row, so run it again now.
        if (bookkeeping.isFillProcessed(orderId, broker)) {
            const held = bookkeeping.trades.find((t) => t.tsym === c.tsym && t.user === userId && (t.broker ?? 'kite') === broker);
            void onEntryFill(userId, Object.assign(new Trade(), { action: 'Buy', brokerOrderId: orderId, broker, tsym: c.tsym, quantity, price: held?.price ?? limitPrice }));
        }
    }
    return { orderIds, placedQuantity: placed };
}

/** One buy at the locked price on one broker. `gate` serialises the limit check, sizing and reservation per user (orderProcess.ts's withUserGate). */
export async function lockedBuyOnBroker(
    userId: string, p: LockedBuyPayload, brokerName: string, mirrored: boolean, gate: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<LockedBuyResult> {
    if (!isLockedBroker(brokerName)) throw refuse(`a buy at a locked price is not supported on ${brokerName}`);
    const broker = brokerName;
    const asked = Number(p.limitPrice);
    const limitPrice = floorToTick(asked);
    if (!(Number.isFinite(asked) && limitPrice > 0)) throw refuse('no usable price for this order - not placed');
    let contract: Contract;
    try {
        if (broker === 'kite' && !(await Kite.getInstance().hasValidSession())) throw new Error('Kite session not active - complete /kite/login first.');
        contract = await resolveContract(broker, p);
    } catch (e: any) { throw markNotPlaced(e); }
    if (broker === 'ant' && holdsAntBracket(userId, contract.tsym)) throw refuse(`${contract.tsym} is held with an ANT bracket order: square it off before buying more of it`);
    const settings = configService.getConfig().settings as any;
    const targetPoints = Number(p.targetPoints ?? bookkeeping.getUserTargetPoints(userId) ?? settings.targetPoints) || 0;
    const stopConfigured = Number(p.stopLossPoints ?? bookkeeping.getUserStopLossPoints(userId) ?? settings.stopLossPoints) || 0;

    const sized = await gate(async () => {
        const allowed = await bookkeeping.canPlaceOrder(userId, undefined, broker);
        if (!allowed.allowed) throw refuse(allowed.reason ?? 'order not allowed');
        const quantity = bookkeeping.resolveManualBuyQuantity(userId, contract.tsym, limitPrice, undefined, contract.lotSize, p.stopLossPoints, undefined, false, broker);
        if (!Number.isInteger(quantity) || !(quantity > 0) || (contract.lotSize > 0 && quantity % contract.lotSize !== 0)) throw refuse(`quantity ${quantity} is not a positive multiple of the lot size ${contract.lotSize} - not placed`);
        // The per-trade loss budget is an exit, not a size cap: the stop is held to budget / quantity per share.
        const stopPoints = bookkeeping.lossBudgetStopPoints(userId, broker, contract.tsym, quantity, limitPrice, stopConfigured > 0 ? stopConfigured : undefined) ?? stopConfigured;
        const chunks = splitIntoFreezeQtyChunks(quantity, defaultFreezeQty(contract.tsym, contract.exchange));
        const reservations = chunks.map((q) => bookkeeping.markPending(userId, q * limitPrice, broker));
        return { stopPoints, chunks, reservations };
    });

    const clickId = randomUUID();
    const placed = await placeLockedOrders({ userId, broker, contract, limitPrice, targetPoints, stopPoints: sized.stopPoints, clickId, chunks: sized.chunks, reservations: sized.reservations });
    Log.log(`[order] limit buy at the clicked price: ${contract.tsym} qty=${placed.placedQuantity} @ ${limitPrice} for ${userId} on ${broker} (target ${targetPoints || 'none'} pts, stop ${sized.stopPoints || 'none'} pts), orders ${placed.orderIds.join(',')}`);
    kickPoll(broker);
    // The admin copies the user's resting entry with the same price and exits, once the user's own order is in (a resting order cannot be undone like a fill).
    if (mirrored && placed.placedQuantity > 0) {
        startMirrorBuy({
            userId, broker, tsym: contract.tsym, token: contract.token, exchange: contract.exchange, quantity: placed.placedQuantity, resting: true,
            place: async (adminId, qty) => {
                const r = await placeLockedOrders({
                    userId: adminId, broker, contract, limitPrice, targetPoints, stopPoints: sized.stopPoints, clickId: randomUUID(),
                    chunks: splitIntoFreezeQtyChunks(qty, defaultFreezeQty(contract.tsym, contract.exchange)), mirrorOf: { userId, clickId },
                });
                kickPoll(broker);
                if (r.error) throw Object.assign(new Error(r.error), { partial: r.placedQuantity > 0, filledQuantity: r.placedQuantity });
            },
        });
    }
    return { resting: true, broker, tsym: contract.tsym, quantity: placed.placedQuantity, limitPrice, orderIds: placed.orderIds, ...(placed.error ? { error: placed.error } : {}) };
}

// ---- Exits of a filled lot --------------------------------------------------------------------------------------------------------------------

/** Target / stop of a filled lot, measured from the locked (limit) price; a level a better fill left on the wrong side of it is measured from the fill. */
export function lotLevels(limitPrice: number, fillPrice: number, targetPoints: number, stopPoints: number): { target?: number; stop?: number } {
    const fill = fillPrice > 0 ? fillPrice : limitPrice;
    let stop: number | undefined;
    if (stopPoints > 0) {
        stop = roundToTick(limitPrice - stopPoints);
        if (!(stop < fill)) stop = roundToTick(fill - stopPoints);
        stop = Math.max(NFO_TICK_SIZE, stop);
    }
    let target: number | undefined;
    if (targetPoints > 0) {
        target = roundToTick(limitPrice + targetPoints);
        if (!(target > fill)) target = roundToTick(fill + targetPoints);
    }
    return { target, stop };
}

// A restart restores a position's target / stop from its Buy documents, which the fill wrote without them.
function persistExits(userId: string, tsym: string, orderId: string, fields: Record<string, number>, attempt = 1): void {
    const db = Mongo.getInstance()?.db;
    if (!db || Object.keys(fields).length === 0) return;
    db.collection('Trade').updateMany({ user: userId, tsym, action: 'Buy', brokerOrderId: orderId }, { $set: fields })
        .then((r: any) => {
            if (r?.matchedCount > 0) return;
            if (attempt < 5) setTimeout(() => persistExits(userId, tsym, orderId, fields, attempt + 1), attempt * 2000).unref?.();
            else Log.log(`[order] ALERT: could not store the target / stop of ${tsym} (${userId}, order ${orderId}) - a restart would restore the position without them`);
        })
        .catch((e) => Log.log(`[order] ALERT: storing the target / stop of ${tsym} (${userId}) failed:`, e));
}

/** entryExits.ts's lot protector: puts the target / stop of a filled locked-price lot on the position (a Kite GTT where the user uses GTT, else the in-app exit monitor). */
export async function protectLot(userId: string, trade: Trade, row: EntryExit): Promise<void> {
    const broker = row.broker;
    const find = () => bookkeeping.trades.find((t) => t.tsym === row.tsym && t.user === userId && (t.broker ?? 'kite') === broker);
    const held = find();
    if (!held) { Log.log(`[order] limit entry ${row.tsym} (${userId}) filled but the position is already closed - no exits to attach`); return; }
    const fill = trade.price > 0 ? trade.price : Number(row.limitPrice);
    const { target, stop } = lotLevels(Number(row.limitPrice), fill, Number(row.targetPoints) || 0, Number(row.stopPoints) || 0);
    if (target === undefined && stop === undefined) { Log.log(`[order] limit entry ${row.tsym} (${userId}) filled at ${fill} with no target / stop requested`); return; }
    const exchange = row.exchange;
    const sellBusy = () => bookkeeping.pendingSquareOffs.has(`${broker}:${userId}:${row.tsym}`) || TRACKERS[broker].find(userId, row.tsym).some((o) => o.action === 'Sell');
    const finish = (mode: string) => {
        persistExits(userId, row.tsym, String(row.orderId), { ...(target !== undefined ? { targetPrice: target } : {}), ...(stop !== undefined ? { stopLossPrice: stop } : {}) });
        bookkeeping.tightenStopToLossBudget(userId, broker, row.tsym);
        if (broker === 'kite') void reprotectAfterBuy(userId, row.tsym);
        bookkeeping.notifyTargetStopLossChanged();
        Log.log(`[order] limit entry ${row.tsym} (${userId}) filled ${trade.quantity} at ${fill} (limit ${row.limitPrice}): target ${target ?? 'none'} / stop ${stop ?? 'none'} (${mode})`);
    };

    // Earlier lots watched in-app only (levels set, no GTT): a GTT for this lot would turn the monitor watch-only and leave them without an exit.
    const earlierInApp = held.quantity > trade.quantity && gttIdsOf(held).length === 0 && (held.stopLossPrice != null || held.targetPrice != null);
    if (broker === 'kite' && target !== undefined && stop !== undefined && bookkeeping.getUserUseGTT(userId) && !row.inAppExit && !earlierInApp && !sellBusy()) {
        // This lot's own GTT, for this lot's quantity: the GTTs of a position together never exceed it.
        const quantity = Math.min(trade.quantity, held.quantity);
        if (quantity <= defaultFreezeQty(row.tsym, exchange)) {
            try {
                const id = await Kite.getInstance().placeTargetStopLossGTT(row.tsym, exchange, quantity, fill, target - fill, fill - stop, fill);
                if (find() !== held || sellBusy() || held.quantity < quantity) {
                    // The position was sold, or a sell was placed, while the GTT was being placed: it must not stay live beside that sell.
                    await Kite.getInstance().deleteGTT(id).catch((e) => Log.log(`[order] ALERT: GTT ${id} of ${row.tsym} (${userId}) is stale and could NOT be deleted - delete it by hand in Kite:`, e));
                } else {
                    if (held.gttTriggerId == null) held.gttTriggerId = id;
                    else held.extraGttTriggerIds = [...(held.extraGttTriggerIds ?? []), id];
                    if (held.targetPrice == null) { held.targetPrice = target; held.targetPoints = roundToTick(target - fill); }
                    if (held.stopLossPrice == null) held.stopLossPrice = stop;
                    persistGttTriggerId(Object.assign(new Trade(), { tsym: row.tsym, user: userId, gttTriggerId: id }));
                    exitMonitor.registerTrade(held, exchange, 'kite', true);
                    finish(`GTT ${id}`);
                    return;
                }
            } catch (e) {
                Log.log(`[order] GTT placement failed for ${row.tsym} (${userId}) - falling back to in-app target/SL monitoring:`, e);
            }
        }
    }
    const now = find();
    if (!now) return;
    if (gttIdsOf(now).length > 0 || now.antOrderNo) {
        // Earlier lots have a broker exit the monitor leaves alone: this lot's stop is enforced as a hard stop on the whole position.
        if (stop !== undefined) now.hardStopPrice = Math.max(now.hardStopPrice ?? 0, stop);
        if (now.targetPrice == null && target !== undefined) now.targetPrice = target;
        if (now.stopLossPrice == null && stop !== undefined) now.stopLossPrice = stop;
        exitMonitor.registerTrade(now, exchange, broker, true);
        finish('in-app hard stop beside the earlier broker exit');
        return;
    }
    // The latest lot's levels govern the position, as for a market manual buy watched in-app.
    if (target !== undefined) { now.targetPrice = target; now.targetPoints = roundToTick(target - fill); }
    if (stop !== undefined) now.stopLossPrice = stop;
    exitMonitor.registerTrade(now, exchange, broker, false);
    finish('in-app exit monitor');
}

// ---- Wiring ------------------------------------------------------------------------------------------------------------------------------------

registerLotProtector(async (userId, trade, row) => {
    try {
        await protectLot(userId, trade, row);
    } catch (e) {
        notifyUser(userId, `${row.tsym} was bought but its target / stop-loss could NOT be attached. Set them on the position or square it off.`);
        throw e;
    }
});

// A user's resting buy ended (cancelled, rejected, partly filled and cut): once none of that click's orders still rest, the admin's copy is cancelled.
onLockedBuyEnded((o) => {
    if (!o.clickId || o.mirrorOf) return;
    const resting = allLockedOrders().filter((x) => !!trackedOrder(x.broker, x.orderId));
    if (resting.some((x) => x.userId === o.userId && x.orderId !== o.orderId && x.clickId === o.clickId)) return;
    for (const m of resting.filter((x) => x.mirrorOf?.userId === o.userId && x.mirrorOf.clickId === o.clickId)) {
        void cancelLockedOrder(m.userId, m.broker, m.orderId, `mirror of ${o.userId}'s order, which ended`)
            .catch((e) => Log.log(`[order] ALERT: the mirror order ${m.orderId} (${m.tsym}, ${m.userId}) of ${o.userId}'s ended order could not be cancelled - cancel it by hand:`, e));
    }
});

// After our own cancel the trackers tell no listener: drop the exits of an order that ended with nothing filled (a filled one keeps its row for the fill).
onLockedCancelDone(async (o, r) => {
    if (o.action !== 'Buy' || r.status !== 'cancelled' || trackedOrder(o.broker, o.orderId) || bookkeeping.isFillProcessed(o.orderId, o.broker)) return;
    await onEntryCancelled(o.userId, o.orderId);
    await forgetRestingMirror(o.userId, o.token);
});

/** Startup (after the pending-order trackers are loaded): today's resting locked-price buys are listed again and keep their value reserved. */
export async function loadLockedEntries(): Promise<void> {
    for (const row of await lotEntriesOfToday()) {
        if (!trackedOrder(row.broker, row.orderId)) continue;
        registerLockedOrder({ orderId: row.orderId, broker: row.broker, userId: row.userId, action: 'Buy', tsym: row.tsym, token: row.token, exchange: row.exchange, quantity: Number(row.quantity), price: Number(row.limitPrice), placedAt: new Date(row.createdAt).getTime(), clickId: row.clickId, ...(row.mirrorOf ? { mirrorOf: row.mirrorOf } : {}) });
        if (!row.mirrorOf) bookkeeping.markPending(row.userId, Number(row.quantity) * Number(row.limitPrice) || 0, row.broker).orderId = row.orderId;
    }
}
