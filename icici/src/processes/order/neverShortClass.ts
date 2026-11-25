// Cause classes of a NEVER-SHORT trip (user rule 2026-11-25: the ALERT fires only for a real inconsistency and names its cause).
// Pure functions, no I/O: the guards (BrokerExecutor.neverShortSellable, Kite.placeLimitSellOption) and the tests share them.
//
//   already-resting    the owner's OWN resting sells already cover every lot the broker holds: a duplicate exit attempt (retry, a second
//                      trigger). The guard is right and nothing is wrong with the data: logged, no ALERT.
//   other-owner-resting another platform owner's resting sells cover the rest of the contract on the same broker account: wait (existing 'held back').
//   other-owner-lots   the sell asked for more than the owner's own free lots while another platform owner holds the same contract on the account:
//                      clamped to the owner's own free lots so the other owner's lots are never sold (real: the caller's book is wrong).
//   stale-resting      the platform tracks resting sells of this owner but the broker holds nothing: those sells filled (or were cancelled)
//                      unbooked - real.
//   stale-leg          the broker holds nothing and the platform's book holds nothing for this owner: the caller's leg is stale - real.
//   unbooked-sell      the broker holds nothing but the platform's book holds lots: a sell happened that the platform has not booked (a GTT
//                      the platform placed, or a manual sell) - real; the cause check says which.
//   broker-short       the broker holds less than the owner's book and nothing else explains it (stale broker read or a sell outside the platform).
export type NeverShortClass = 'already-resting' | 'other-owner-resting' | 'other-owner-lots' | 'stale-resting' | 'stale-leg' | 'unbooked-sell' | 'broker-short';

export interface RefusalFacts {
    requested: number;
    live: number;
    ownResting: number;
    othersResting: number;
    ownHeld?: number;    // the owner's open quantity in the platform's book (undefined = unknown)
    othersHeld?: number; // every other platform owner's open quantity of the same contract on the same broker account
}

export function classifyRefusal(f: RefusalFacts): { cls: NeverShortClass; real: boolean } {
    const free = f.live - f.ownResting;
    if (f.live > 0 && free <= 0 && f.ownResting > 0 && (f.othersResting ?? 0) === 0) return { cls: 'already-resting', real: false };
    if (free > 0 && f.othersResting > 0) return { cls: 'other-owner-resting', real: false };
    if (f.live <= 0) {
        if (f.ownResting > 0) return { cls: 'stale-resting', real: true };
        if (f.ownHeld !== undefined && f.ownHeld <= 0) return { cls: 'stale-leg', real: true };
        if (f.ownHeld !== undefined && f.ownHeld > 0) return { cls: 'unbooked-sell', real: true };
    }
    return { cls: 'broker-short', real: true };
}

// The most `ownFreeHeld`-aware quantity one owner may sell while another platform owner holds the same contract on the same broker account:
// never more than the owner's own open lots minus the lots its own resting sells already reserve. undefined = no cap (a single owner on the
// contract, or the owner's own book is empty so there is nothing to compare).
export function ownerSellCap(h: { own: number; others: number }, ownResting: number): number | undefined {
    if (!(h.others > 0) || !(h.own > 0)) return undefined;
    return Math.max(0, h.own - Math.max(0, ownResting));
}

// The guard's owner-awareness arguments for one (broker account, contract, owner), from the platform's open rows (bookkeeping.ownerHoldings).
// Kept here as a thin injected lookup so this module stays free of bookkeeping imports (the lookup is wired by the order process).
let holdingsLookup: ((broker: string, tsym: string, userId: string) => { own: number; others: number }) | undefined;
export function setOwnerHoldingsLookup(fn: (broker: string, tsym: string, userId: string) => { own: number; others: number }): void { holdingsLookup = fn; }
export function ownerFields(broker: string, tsym: string, userId: string): { ownerHeld?: number; othersHeld?: number } {
    try { const h = holdingsLookup?.(broker, tsym, userId); return h ? { ownerHeld: h.own, othersHeld: h.others } : {}; } catch { return {}; }
}
