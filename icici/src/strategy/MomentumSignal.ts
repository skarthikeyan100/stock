import Log from '../util/Log';
import { OptionQuote } from '../model/model';
import { Strategy } from './strategy';
import OrderClient from '../processes/strategies/OrderClient';
import { subscribeTokenDepth, unsubscribeTokenDepth } from '../processes/strategies/DataClient';
import { watchTokenOnSource, unwatchTokenOnSource, isWatching } from '../processes/strategies/tokenRouter';
import { CALL, PUT } from '../constants';
import { sleep } from '../util/sleep';
import { exchangeForIndex } from '../util/underlyings';

interface PendingLeg {
    tbq?: number;
    tsq?: number;
    refs: number; // concurrent getDirection calls sharing this token's reading
    ownsWatch: boolean; // this entry (not a slot/position) added the strategy's tick watch, so only it may remove it
}

// Momentum signal for ContinuousStrategy's PCR veto (see
// ContinuousStrategy.resolveEntryRight) - a one-shot read of AliceBlue's
// order-book imbalance (tbq/tsq, total buy/sell qty) on the nearest ATM
// CALL and PUT, only available via ANT's depth-mode WebSocket subscription
// (touchline mode does not carry tbq/tsq - see AntWebSocket.subscribeDepth).
// Subscribes a token only if not already tracked by this instance, and
// unsubscribes it again once a reading is obtained (or the wait times out) -
// a one-shot fetch, not a standing subscription. One instance per owning
// strategy (ContinuousStrategy creates its own).
export default class MomentumSignal {
    private pending = new Map<string, PendingLeg>();

    // ContinuousStrategy.canHandleOptionQuote needs this to let a momentum-
    // check tick (not a leg token) through to processOptionQuote/onTick.
    isTracking(token: string): boolean {
        return this.pending.has(token);
    }

    onTick(quote: OptionQuote): void {
        const leg = this.pending.get(quote.token);
        if (!leg) return;
        if (quote.tbq !== undefined) leg.tbq = quote.tbq;
        if (quote.tsq !== undefined) leg.tsq = quote.tsq;
    }

    // Resolves to CALL/PUT once both ATM legs' tbq/tsq favor the same
    // direction, or null if the ATM lookup fails, the wait times out, or the
    // two legs' order-book imbalance is inconclusive (doesn't agree with each
    // other). null always means "momentum unavailable" to the caller, which
    // falls back to PCR alone - never a reason to block an entry by itself.
    async getDirection(strategy: Strategy, niftyLtp: number, timeoutMs: number, index: string = 'NIFTY'): Promise<string | null> {
        let ceToken: string, peToken: string;
        try {
            const tokens = await OrderClient.getInstance().getATMTokens(strategy.userId, niftyLtp, index);
            ceToken = tokens.ce.token;
            peToken = tokens.pe.token;
        } catch (e) {
            Log.log('[MomentumSignal] ATM token lookup failed, momentum unavailable:', e);
            return null;
        }

        // SENSEX ATM tokens are BFO, not NFO - found on review: this used to
        // default to NFO regardless of `index`, which would silently never
        // get a depth tick back for a SENSEX momentum check.
        const exchange: 'NFO' | 'BFO' = exchangeForIndex(index);
        // Shared per token: a concurrent call joins the existing entry (and its reading) instead of finding it 'taken', and only the
        // last one out tears the subscription down - the first call's cleanup used to delete the entry from under the second.
        const joined: string[] = [];
        for (const token of [ceToken, peToken]) {
            const existing = this.pending.get(token);
            if (existing) {
                existing.refs++;
            } else {
                // watchTokenOnSource is a no-op when the strategy already watches the token (e.g. a live slot's tick routing):
                // removing it afterwards would silence that slot, so only remove a watch this entry added.
                const ownsWatch = !isWatching('ant', token, strategy);
                this.pending.set(token, { refs: 1, ownsWatch });
                watchTokenOnSource('ant', token, strategy, exchange);
                subscribeTokenDepth(token, 'ant', exchange);
            }
            joined.push(token);
        }

        try {
            const pollMs = 100;
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const ce = this.pending.get(ceToken);
                const pe = this.pending.get(peToken);
                if (ce?.tbq !== undefined && ce?.tsq !== undefined && pe?.tbq !== undefined && pe?.tsq !== undefined) {
                    const callFavored = ce.tbq > ce.tsq && pe.tbq < pe.tsq;
                    const putFavored = ce.tbq < ce.tsq && pe.tbq > pe.tsq;
                    Log.log(`[MomentumSignal] CE tbq=${ce.tbq} tsq=${ce.tsq} | PE tbq=${pe.tbq} tsq=${pe.tsq} -> ${callFavored ? CALL : putFavored ? PUT : 'inconclusive'}`);
                    if (callFavored) return CALL;
                    if (putFavored) return PUT;
                    return null; // inconclusive - CE/PE order books disagree with each other
                }
                await sleep(pollMs);
            }
            Log.log(`[MomentumSignal] Timed out after ${timeoutMs}ms waiting for ATM CE/PE depth ticks - momentum unavailable this window`);
            return null;
        } finally {
            for (const token of joined) {
                const entry = this.pending.get(token);
                if (!entry) continue;
                if (--entry.refs > 0) continue;
                this.pending.delete(token);
                if (entry.ownsWatch) unwatchTokenOnSource('ant', token, strategy, exchange);
                unsubscribeTokenDepth(token, 'ant', exchange);
            }
        }
    }
}
