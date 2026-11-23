// ANT trade book (GET orders/trades) semantics, confirmed live 2026-11-23 against the order-notify stream for 24 orders (13 of them filled in several
// chunks at different prices): a row's `tradedPrice` is NOT that execution's own price but the CUMULATIVE AVERAGE price of the order after that
// execution (order 26112300098603: executions at 150.60 / 150.50 / 150.50 / 150.30 came back as rows 150.60 / 150.55 / 150.52 / 150.48, and the order's
// COMPLETE push says avgprc 150.48). So summing qty * tradedPrice over an order's rows is wrong when its chunks filled at different prices; the order's
// average fill price is the tradedPrice of its LAST execution row (highest exchangeTradeId; the book lists newest first, which is the fallback when an id is
// not numeric). One helper, used by every reader of the book (fill lookup, timed fills for the sync, broker fills for the sync).

// brokerOrderId -> the order's average fill price.
export function antOrderAveragePrices(rows: any[]): Map<string, number> {
    const best = new Map<string, { id: number; price: number }>();
    for (const r of rows) {
        if (r?.brokerOrderId == null) continue;
        const key = String(r.brokerOrderId);
        const price = Number(r.tradedPrice);
        if (!Number.isFinite(price)) continue;
        const idRaw = Number(r.exchangeTradeId);
        const id = Number.isFinite(idRaw) ? idRaw : -1;
        const cur = best.get(key);
        // Strictly greater id wins; on equal / unusable ids the first row seen (newest first) is kept.
        if (!cur || id > cur.id) best.set(key, { id, price });
    }
    return new Map([...best].map(([k, v]) => [k, v.price]));
}
