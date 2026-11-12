import AntContractMaster from '../ant/AntContractMaster';

const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MINUTE = 25;

export function isPastMarketClose(): boolean {
  const now = new Date();
  return (
    now.getHours() > MARKET_CLOSE_HOUR ||
    (now.getHours() === MARKET_CLOSE_HOUR && now.getMinutes() >= MARKET_CLOSE_MINUTE)
  );
}

const EXPIRY_SQUAREOFF_HOUR = 15;
const EXPIRY_SQUAREOFF_MINUTE = 15;

// NSE moved NIFTY's weekly options expiry to Tuesday - any position still
// open into the last ~15 minutes of an expiry day risks illiquid closing
// prices/physical or cash settlement quirks, so every open position should
// be force-closed by 3:15pm on that day regardless of target/SL/drawdown
// state. Day-of-week rather than parsing each tsym's own expiry date:
// simpler, matches how the user actually reasons about this ("Tuesday,
// which is Nifty expiry day"), and tsym-expiry parsing already has known
// ambiguity caveats elsewhere in this codebase (see AntContractMaster.ts).
//
// 2026-11-04: the weekday alone is wrong when the exchange moves an expiry for a holiday (NIFTY's 2026-11-10 expiry is listed on
// 2026-11-09): a Tuesday-only rule would skip the Monday squareoff while the contracts expire. The day now comes from the ANT contract
// master's nearest NIFTY expiry; the Tuesday rule remains only for an unreadable or stale master (see isExpiryDayFor).
const DAY_MS = 86400000;

// Pure decision. `todayDayMs` and `nearestExpiryDayMs` are midnight-UTC calendar days. NIFTY lists an expiry within every 7 days, so
// a nearest expiry further out than that (or none) means the master is stale or incomplete and cannot say: use the weekday.
export function isExpiryDayFor(todayDayMs: number, nearestExpiryDayMs: number | undefined, weekday: number): boolean {
  if (nearestExpiryDayMs === undefined || nearestExpiryDayMs - todayDayMs > 7 * DAY_MS) return weekday === 2; // 0=Sun, 1=Mon, 2=Tue, ...
  return nearestExpiryDayMs === todayDayMs;
}

export function isNiftyExpiryDay(): boolean {
  const now = new Date();
  let nearest: number | undefined;
  try {
    nearest = AntContractMaster.getInstance().nearestExpiryDayMs('NIFTY');
  } catch {
    nearest = undefined; // master file missing/unreadable: fall back to the weekday
  }
  return isExpiryDayFor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()), nearest, now.getDay());
}

export function isPastExpirySquareOffTime(): boolean {
  if (!isNiftyExpiryDay()) return false;
  const now = new Date();
  return (
    now.getHours() > EXPIRY_SQUAREOFF_HOUR ||
    (now.getHours() === EXPIRY_SQUAREOFF_HOUR && now.getMinutes() >= EXPIRY_SQUAREOFF_MINUTE)
  );
}

const RECONCILE_AFTER_HOUR = 9;
const RECONCILE_AFTER_MINUTE = 10;

// Login/startup-triggered broker-position reconciliation (bookkeeping's
// reconcileKitePositions/reconcileAntPositions/reconcileBreezePositions,
// each strategy's own reconcile()) must not run against pre-market broker
// state - a login done before the market opens (as happened 2026-09-24,
// ~08:44-08:51) can see incomplete/stale broker responses and, worse, firing
// it once per broker login in quick succession re-derives the same Mongo
// aggregate multiple times, which is what actually produced a doubled
// (27950 instead of 13975) quantity that morning. Gate reconciliation to the
// first tick received once this returns true - in practice that's the first
// live tick after market open (9:15), since no real tick exists before then
// regardless of what this returns.
export function isPastReconcileTime(): boolean {
  const now = new Date();
  return (
    now.getHours() > RECONCILE_AFTER_HOUR ||
    (now.getHours() === RECONCILE_AFTER_HOUR && now.getMinutes() >= RECONCILE_AFTER_MINUTE)
  );
}

const TRADING_WINDOW_START_HOUR = 9;
// 09:15 = the NSE open. Pre-open ticks (09:00-09:15) are indicative equilibrium prices, not traded prices, so no tick, fill or cancellation reaches a strategy before it (user rule 2026-11-12).
const TRADING_WINDOW_START_MINUTE = 15;

const pad = (n: number) => n.toString().padStart(2, '0');
export const TRADING_WINDOW_LABEL =
  `${pad(TRADING_WINDOW_START_HOUR)}:${pad(TRADING_WINDOW_START_MINUTE)}-${pad(MARKET_CLOSE_HOUR)}:${pad(MARKET_CLOSE_MINUTE)}`;

// Window during which strategies may be enabled. Deliberately reuses
// isPastMarketClose() for the end boundary instead of a separately
// duplicated constant, so the two can never drift apart - a strategy staying
// enabled past the same 15:25 cutoff that already halts WS reconnect
// attempts elsewhere (AntStream.ts, AntDataStream.ts, prism.ts) would be a
// real bug, not just an inconsistency.
export function isWithinTradingWindow(): boolean {
  const now = new Date();
  const afterStart =
    now.getHours() > TRADING_WINDOW_START_HOUR ||
    (now.getHours() === TRADING_WINDOW_START_HOUR && now.getMinutes() >= TRADING_WINDOW_START_MINUTE);
  return afterStart && !isPastMarketClose();
}

// True when the local clock is at or past "HH:mm" (e.g. settings.eodCloseTime, via util/eodClose.ts). Minutes since midnight, so it is one comparison
// instead of the hour/minute pair every caller used to spell out. An unparsable value falls back to the default.
export function isPastTime(hhmm: string | undefined, fallback = '15:10', now: Date = new Date()): boolean {
  const parse = (v: string) => { const [h, m] = v.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN; };
  let limit = parse(String(hhmm ?? fallback));
  if (Number.isNaN(limit)) limit = parse(fallback);
  return now.getHours() * 60 + now.getMinutes() >= limit;
}
