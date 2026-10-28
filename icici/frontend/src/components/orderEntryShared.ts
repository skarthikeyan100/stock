// Pieces the live OrderEntry and the Demo copy must agree on. They differ in where contracts come from (symbols.txt vs the ANT-native
// /demo/symbols list) and how an order is placed, but not in how the search box matches or how target/stop points are validated -
// those had drifted (demo matched from 2 characters, live from 4; demo treated 0 as "unset").

/** Characters the search box needs before it suggests anything. */
export const SYMBOL_SEARCH_MIN_CHARS = 4;
export const MAX_SUGGESTIONS = 10;

/** Items whose text contains every whitespace-separated term of `query` (already upper-cased), capped. */
export function matchSymbols<T>(query: string, items: T[], textOf: (item: T) => string): T[] {
  if (query.length < SYMBOL_SEARCH_MIN_CHARS) return [];
  const terms = query.split(/\s+/).filter((t) => t);
  return items.filter((item) => { const text = textOf(item).toUpperCase(); return terms.every((t) => text.includes(t)); }).slice(0, MAX_SUGGESTIONS);
}

/**
 * Target / stop-loss points from the two text inputs: blank = not set, otherwise a positive finite number (a zero or negative value
 * would put the target or stop on the wrong side). Returns an error message when invalid.
 */
export function parsePoints(targetPoints: string, stopLossPoints: string): { target?: number; stopLoss?: number; error?: string } {
  const tp = targetPoints ? Number(targetPoints) : undefined;
  const sl = stopLossPoints ? Number(stopLossPoints) : undefined;
  if ((tp !== undefined && !(Number.isFinite(tp) && tp > 0)) || (sl !== undefined && !(Number.isFinite(sl) && sl > 0))) {
    return { error: 'Target and stop-loss points must be positive numbers.' };
  }
  return { target: tp, stopLoss: sl };
}
