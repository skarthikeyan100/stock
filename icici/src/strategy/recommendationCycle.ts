// Pure rules of RecommendationStrategy's optional `repeat` / `reverse` (no I/O, no imports). Both apply only after a trade that reached its target.
//   stage 0 = the recommended trade, stage 1 = the repeat (same contract, same order price), stage 2 = the reverse (opposite right, fresh ATM).
//   repeat: after the stage-0 target buy again; that trade ends the strategy unless reverse is on too.
//   reverse: after the last target (stage 0 when repeat is off, stage 1 when repeat is on) wait for the option to fall back to the recommended
//   entry price, then buy the opposite right at the ATM strike. The reverse trade ends the strategy.

export type RecStage = 0 | 1 | 2;
export type RecAction = 'finish' | 'repeat' | 'watch';

export interface RecWatch {
    brokers: string[]; // brokers that take the reverse trade
    tokens: { token: string; exchange: 'NFO' | 'BFO' }[]; // the contract(s) watched (each broker's own token)
    right: 'CE' | 'PE'; // the right of the trade that reached its target (the reverse buys the other one)
    index: 'NIFTY' | 'SENSEX';
    triggered?: boolean; // the option came back to the entry price: the reverse is bought on the next NIFTY tick
}

export interface RecState {
    stage: RecStage;
    brokers?: string[]; // brokers still in the sequence (absent at stage 0 = every leg)
    watch?: RecWatch;
}

export function oppositeRight(right: 'CE' | 'PE'): 'CE' | 'PE' {
    return right === 'CE' ? 'PE' : 'CE';
}

// A fully sold leg whose average sell price is at or above the target price it was protected with.
export function hitTarget(leg: { filledQty: number; soldQty: number; soldValue: number; exitTarget?: number }): boolean {
    if (leg.exitTarget === undefined || !(leg.filledQty > 0) || leg.soldQty < leg.filledQty || !(leg.soldQty > 0)) return false;
    return leg.soldValue / leg.soldQty >= leg.exitTarget;
}

// What to do when a stage has ended and `targetHit` is true when at least one still-allowed broker sold at its target.
export function nextAction(stage: RecStage, repeat: boolean, reverse: boolean, targetHit: boolean): RecAction {
    if (!targetHit) return 'finish';
    if (stage === 0) return repeat ? 'repeat' : reverse ? 'watch' : 'finish';
    if (stage === 1) return reverse ? 'watch' : 'finish';
    return 'finish';
}

// The option has come back to (or below) the recommended entry price.
export function backAtEntry(ltp: number, entryPrice: number): boolean {
    return ltp > 0 && entryPrice > 0 && ltp <= entryPrice;
}

export function atmStrike(niftyLtp: number, step = 50): number {
    return Math.round(niftyLtp / step) * step;
}
