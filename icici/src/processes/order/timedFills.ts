// Timed trade-book readers (pure, no I/O): one broker's raw trade/order-book rows -> TimedFill[] (order id, trade id, side, tsym, qty, price, fill time in
// epoch ms) for the non-platform-sell attribution (foreignSells.ts, bookkeeping.bookForeignSellShortfall).
//
// What each broker's book really gives (checked against the repo, 2026-11-20):
//  - kite   trade book `getTrades()`: order_id, trade_id, transaction_type, tradingsymbol, quantity, average_price, fill_timestamp (live-used since 7412a3b).
//  - prism  (Shoonya) has NO trade book wired (`get_tradebook` is a comment in RestAPI.ts); the ORDER book is read (`getOrderBook`). One row per order:
//           norenordno, trantype 'B'/'S', tsym, prd ('M' NRML / 'I' MIS), status, fillshares, avgprc, norentm 'HH:MM:SS DD-MM-YYYY' and exch_tm
//           'DD-MM-YYYY HH:MM:SS' (both real rows from logs/orchestrator-2026-11-20.log, exchange-local = IST, no offset in the string). The time is the
//           order's exchange time, not a per-fill time; the trade id is the order id.
//  - ant    (Alice Blue open-api) trade book `GET /open-api/od/v1/orders/trades`: brokerOrderId, transactionType, tradingSymbol, instrumentId, filledQuantity,
//           tradedPrice (one row per execution, confirmed live 2026-10-14). NO time or trade-id field name is confirmed anywhere in the repo.
//  - breeze `getTradeList` (NFO): order_id, action, stock_code, expiry_date ('17-Nov-2026'), strike_price, right ('Call'/'Put'), quantity, average_cost and a
//           `trade_date` (a date only, urgent.md 2026-11-09). NO time field is confirmed in the repo.
// For ant and breeze the time (and trade id) is therefore AUTO-DETECTED: the first key whose name says time/stamp and whose value parses as a full
// date-time. A row without one is returned in `untimed` and the attribution refuses to guess (ALERT only; see bookkeeping.foreignShortfalls). The key names
// of the first row are logged once per process (`describeRowKeys`) so the real field is visible after the next live run.
// Every string time without an explicit offset is read as IST (UTC+05:30), independent of the server's TZ.
import { breezeTsym, breezeLegacyTsym } from '../../breeze/BreezeContractMaster';
import type { TimedFill } from './foreignSells';

export interface TimedBook {
    fills: TimedFill[]; // rows with a parsed time
    untimed: { orderId: string; tsym: string; aliases?: string[]; token?: string; action?: 'Buy' | 'Sell'; qty?: number; price?: number; tradeId?: string }[]; // rows that could not be given a time (the row's side/qty/price kept so a time learnt elsewhere, e.g. the order-update stream, can complete it)
}

const IST_OFFSET_MS = 5.5 * 3600_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const istMs = (y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0): number => {
    if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return NaN;
    return Date.UTC(y, mo, d, h, mi, s, ms) - IST_OFFSET_MS;
};

// A broker's time value -> epoch ms, or null when it is not a full date-time (a date alone is NOT a time). Date objects and epoch numbers pass through.
export function parseBrokerTime(v: unknown): number | null {
    if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
    if (typeof v === 'number') {
        if (v > 1e12 && v < 1e14) return v; // epoch ms
        if (v > 1e9 && v < 1e11) return v * 1000; // epoch s
        return null;
    }
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    let m: RegExpExecArray | null;
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(s) && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) { const t = Date.parse(s.replace(' ', 'T')); return Number.isFinite(t) ? t : null; } // explicit offset
    if ((m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(s))) { const t = istMs(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Number(m[7].padEnd(3, '0')) : 0); return Number.isFinite(t) ? t : null; }
    if ((m = /^(\d{2}):(\d{2}):(\d{2}) (\d{2})-(\d{2})-(\d{4})$/.exec(s))) { const t = istMs(+m[6], +m[5] - 1, +m[4], +m[1], +m[2], +m[3]); return Number.isFinite(t) ? t : null; } // Shoonya norentm
    if ((m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s))) { const t = istMs(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]); return Number.isFinite(t) ? t : null; } // Shoonya exch_tm
    if ((m = /^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s))) { const t = istMs(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1], +m[4], +m[5], +m[6]); return Number.isFinite(t) ? t : null; } // '17-Nov-2026 10:40:12'
    return null;
}

// The first value in the row that is a full date-time under a key that names a time. Fill/trade/exchange keys first (a fill time beats an order time).
export function detectRowTime(row: Record<string, unknown>): { at: number; key: string } | null {
    const keys = Object.keys(row).filter((k) => /time|stamp|tm$/i.test(k));
    const rank = (k: string) => (/fill|trade|exec/i.test(k) ? 0 : /exch/i.test(k) ? 1 : 2);
    for (const k of keys.sort((a, b) => rank(a) - rank(b))) {
        const at = parseBrokerTime(row[k]);
        if (at != null) return { at, key: k };
    }
    return null;
}

// A trade id when the row carries one (key name says trade/fill id/number); otherwise null and the caller numbers the rows.
function detectTradeId(row: Record<string, unknown>): string | null {
    for (const k of Object.keys(row)) {
        if (/^(trade|fill|exec)\w*(id|no|number)$/i.test(k.replace(/_/g, '')) && row[k] != null && String(row[k]) !== '') return String(row[k]);
    }
    return null;
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const side = (v: unknown): 'Buy' | 'Sell' | null => { const t = String(v ?? '').trim().toUpperCase(); return t === 'BUY' || t === 'B' ? 'Buy' : t === 'SELL' || t === 'S' ? 'Sell' : null; };

let keysLogged = new Set<string>();
// Key names (never values) of the first row of a book, once per process per broker, for the log: tells the next reader which field is the fill time.
export function describeRowKeys(broker: string, rows: any[]): string | null {
    if (keysLogged.has(broker) || !rows.length || typeof rows[0] !== 'object') return null;
    keysLogged.add(broker);
    return `${broker} trade-book row keys: ${Object.keys(rows[0]).join(', ')}`;
}
export function resetRowKeysLogged(): void { keysLogged = new Set(); }

function finish(fills: TimedFill[], untimed: TimedBook['untimed'], row: any, base: { orderId: string; tsym: string; action: 'Buy' | 'Sell'; qty: number; price: number; aliases?: string[]; token?: string }, tradeId: string | null, idx: number, at: number | null): void {
    if (at == null) { untimed.push({ orderId: base.orderId, tsym: base.tsym, aliases: base.aliases, token: base.token, action: base.action, qty: base.qty, price: base.price, tradeId: tradeId ?? `${base.orderId}#${idx}` }); return; }
    fills.push({ ...base, tradeId: tradeId ?? `${base.orderId}#${idx}`, at } as TimedFill);
}

export function timedFillsFromKite(rows: any[]): TimedBook {
    const fills: TimedFill[] = []; const untimed: TimedBook['untimed'] = [];
    rows.forEach((r, i) => {
        const action = side(r.transaction_type);
        if (!action || !r.order_id) return;
        const at = parseBrokerTime(r.fill_timestamp) ?? parseBrokerTime(r.exchange_timestamp) ?? parseBrokerTime(r.order_timestamp);
        finish(fills, untimed, r, { orderId: String(r.order_id), tsym: String(r.tradingsymbol), action, qty: num(r.quantity), price: num(r.average_price) }, r.trade_id != null ? String(r.trade_id) : null, i, at);
    });
    return { fills, untimed };
}

export function timedFillsFromAnt(rows: any[]): TimedBook {
    const fills: TimedFill[] = []; const untimed: TimedBook['untimed'] = [];
    rows.forEach((r, i) => {
        const action = side(r.transactionType);
        if (!action || !r.brokerOrderId) return;
        const t = detectRowTime(r);
        finish(fills, untimed, r, { orderId: String(r.brokerOrderId), tsym: String(r.tradingSymbol), action, qty: num(r.filledQuantity), price: num(r.tradedPrice), token: r.instrumentId != null ? String(r.instrumentId) : undefined }, detectTradeId(r), i, t?.at ?? null);
    });
    return { fills, untimed };
}

// `getTradeList` rows. tsym = the expiry-bearing spelling; aliases = the old expiry-less spellings (a platform trade or position row may still carry one;
// the alias is shared by every expiry of that strike, so the attribution treats an alias-only match as ambiguous when two expiries are in the book).
export function timedFillsFromBreeze(rows: any[]): TimedBook {
    const fills: TimedFill[] = []; const untimed: TimedBook['untimed'] = [];
    rows.forEach((r, i) => {
        const action = side(r.action);
        const optionType = r.right === 'Call' ? 'CE' : r.right === 'Put' ? 'PE' : undefined;
        if (!action || !optionType || !r.order_id) return;
        const t = detectRowTime(r);
        finish(fills, untimed, r, {
            orderId: String(r.order_id), tsym: breezeTsym(String(r.stock_code), String(r.expiry_date), r.strike_price, optionType), action, qty: num(r.quantity), price: num(r.average_cost ?? r.average_price),
            aliases: [breezeLegacyTsym(String(r.stock_code), r.strike_price, optionType), `${r.stock_code}${r.strike_price}${optionType}`],
        }, detectTradeId(r), i, t?.at ?? null);
    });
    return { fills, untimed };
}

// Shoonya order book: executed quantity (`fillshares`) of every order that filled at all (COMPLETE, or CANCELED after a partial fill).
export function timedFillsFromPrism(rows: any[]): TimedBook {
    const fills: TimedFill[] = []; const untimed: TimedBook['untimed'] = [];
    rows.forEach((r, i) => {
        const action = side(r.trantype);
        const filled = num(r.fillshares ?? (String(r.status).toUpperCase() === 'COMPLETE' ? r.qty : 0));
        if (!action || !r.norenordno || !(filled > 0)) return;
        const at = parseBrokerTime(r.exch_tm) ?? parseBrokerTime(r.norentm);
        finish(fills, untimed, r, { orderId: String(r.norenordno), tsym: String(r.tsym), action, qty: filled, price: num(r.avgprc), token: r.token != null ? String(r.token) : undefined }, String(r.norenordno), i, at);
    });
    return { fills, untimed };
}
