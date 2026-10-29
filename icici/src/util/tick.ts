// NFO / BFO option tick size and rounding - broker-neutral (it used to live in kite/Kite.ts, so six strategies and four executors
// imported the whole Kite client just to round a price).
export const NFO_TICK_SIZE = 0.05;

export function roundToTick(price: number, tick: number = NFO_TICK_SIZE): number {
    // Round to the nearest tick, then fix up floating-point representation
    // drift (e.g. 0.05*3 = 0.15000000000000002) by rounding to 2 decimals -
    // safe since a 0.05 tick never needs more than 2 decimal places.
    return Math.round(Math.round(price / tick) * tick * 100) / 100;
}
