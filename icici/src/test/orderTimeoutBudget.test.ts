/**
 * Fill-wait budget below the IPC timeout, Breeze quote cross-check, and the strategies' shared unconfirmed-buy resolver.
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/orderTimeoutBudget.test.js (from repo root)
 */
import { fillWaitPlan } from '../util/fillWait';
import { crossCheckQuote } from '../util/quoteCrossCheck';
import { resolveUnconfirmedBuy } from '../strategy/unconfirmedBuy';
import OrderClient from '../processes/strategies/OrderClient';

function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) process.exitCode = 1; }

async function main() {
    // 1. the plan (push + REST polls) stays well under the IPC timeout, with room for placement, cancel and re-check
    for (const ipc of [90000, 60000, 120000]) {
        const p = fillWaitPlan({ ipcTimeoutMs: ipc });
        assert(p.totalMs <= ipc * 0.6 && p.totalMs >= ipc * 0.4 && p.restAttempts >= 1, `ipc ${ipc}: wait ${p.totalMs}ms (push ${p.pushMs}, ${p.restAttempts} polls)`);
    }
    const d = fillWaitPlan({ ipcTimeoutMs: 90000 });
    assert(d.totalMs + 30000 <= 90000, 'default: 30 s remain for placement + cancel + re-check (old 30s+12x5s = 90s did not)');

    // 2. stale Breeze quote (2026-11-13): ask 155.85 while ANT sees ltp 165.2 / ask 165.5
    const stale = crossCheckQuote({ bestBid: 155.5, bestAsk: 155.85, ltp: 155.8 }, { ltp: 165.2, bid: 165.0, ask: 165.5 });
    assert(stale.bestAsk >= 165.5 && stale.widened, `stale ask widened to ${stale.bestAsk}`);
    assert(stale.bestBid === 155.5, 'bid keeps the lower (safer) Breeze bid');
    const fresh = crossCheckQuote({ bestBid: 165, bestAsk: 165.5, ltp: 165.2 }, { ltp: 165.2, bid: 165.0, ask: 165.5 });
    assert(fresh.bestAsk === 165.5 && fresh.bestBid === 165 && !fresh.widened, 'consistent quote untouched');
    const noLive = crossCheckQuote({ bestBid: 150, bestAsk: 151, ltp: 160 }, null);
    assert(noLive.bestAsk === 160, 'without ANT, Breeze ltp above the ask floors the buy limit');
    const staleBid = crossCheckQuote({ bestBid: 170, bestAsk: 171, ltp: 165 }, { ltp: 165, bid: 164.5, ask: 165.5 });
    assert(staleBid.bestBid === 164.5, 'a stale high bid is lowered for a sell');

    // 3. unconfirmed-buy resolver
    const calls: string[] = [];
    const mk = (o: { cancelFailed?: boolean; filledQty?: number; live?: number; liveThrows?: boolean }) => {
        (OrderClient as any).getInstance = () => ({
            cancelRestingLimitBuys: async () => { calls.push('cancel'); return { cancelFailed: !!o.cancelFailed, filledQty: o.filledQty ?? 0 }; },
            getLiveQuantity: async () => { if (o.liveThrows) throw new Error('down'); return o.live ?? 0; },
            getOpenTrades: async () => [{ tsym: 'X', quantity: o.live ?? 0, price: 101 }],
        });
    };
    const c = { tradingSymbol: 'X', premium: 100 };
    mk({}); assert((await resolveUnconfirmedBuy('u', 'breeze', c)).kind === 'none', 'cancelled, nothing held: none (retry safe)');
    mk({ live: 65 }); let r: any = await resolveUnconfirmedBuy('u', 'breeze', c);
    assert(r.kind === 'filled' && r.qty === 65 && r.price === 101, 'filled: held quantity adopted at the booked price');
    mk({ live: 30, filledQty: 30 }); r = await resolveUnconfirmedBuy('u', 'breeze', c);
    assert(r.kind === 'filled' && r.qty === 30, 'partial fill before the cancel is booked as the partial');
    mk({ cancelFailed: true, live: 65 }); assert((await resolveUnconfirmedBuy('u', 'breeze', c)).kind === 'unknown', 'cancel failed: unknown (human)');
    mk({ liveThrows: true }); assert((await resolveUnconfirmedBuy('u', 'breeze', c)).kind === 'unknown', 'broker unreadable: unknown');
    mk({ live: 130 }); r = await resolveUnconfirmedBuy('u', 'breeze', c, 65);
    assert(r.kind === 'filled' && r.qty === 65, 'add buy: only the excess over what the leg already held');
    mk({ live: 65 }); assert((await resolveUnconfirmedBuy('u', 'breeze', c, 65)).kind === 'none', 'add buy that did not fill: none (parent quantity is not a new buy)');
}
main().then(() => process.exit(process.exitCode ?? 0));
