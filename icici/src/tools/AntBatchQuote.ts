/**
 * Shared one-shot ANT websocket batch-quote helper.
 *
 * Opens a standalone websocket session (deliberately bypassing AntStream,
 * which also wires ticks into Monitor/Mongo/Decision for the live trading
 * system - not wanted for a one-shot batch report), subscribes every given
 * token in a single batch, records whichever 'lp' (last price) each token's
 * tick(s) report within QUOTE_WAIT_MS, then unsubscribes and closes.
 *
 * Used by both src/tools/gapscreener/GapScreenerOptionQuote.ts (morning run)
 * and src/tools/gapscreener/GapScreenerOptionQuoteEod.ts (EOD run) so the
 * subscribe/collect/unsubscribe logic isn't duplicated between the two.
 */

import ANT from '../ant/ANT';
import AntSession from '../ant/AntSession';
import AntWebSocket from '../ant/AntWebSocket';

// How long to wait, after subscribing, for AliceBlue's websocket to deliver
// the initial snapshot tick ('tk') for every subscribed token before giving
// up and unsubscribing. Snapshots normally arrive within ~1s of subscribing;
// this leaves headroom for network jitter across a batch of ~20-40 tokens.
export const QUOTE_WAIT_MS = 6000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function collectLiveQuotes(tokens: string[]): Promise<Map<string, number>> {
    const quotes = new Map<string, number>();
    if (tokens.length === 0) return quotes;

    const session = AntSession.getInstance();
    const sessionId = await session.getSessionId();
    await session.prepareWsSession(sessionId);
    const susertoken = session.getSusertoken(sessionId);

    const userId = ANT.getInstance().getUserId();
    if (!userId) {
        throw new Error('ANT userId not available. Complete OAuth login first (/ant/login).');
    }

    const ws = new AntWebSocket();
    const keys = tokens.map((t) => `NFO|${t}`);

    ws.on('quote', (_event, data) => {
        if (!data?.tk) return;
        console.log(`[antBatchQuote]   tick NFO|${data.tk} lp=${data.lp ?? '(none)'}`);
        if (!data.lp) return;
        const ltp = Number(data.lp);
        if (ltp > 0) quotes.set(String(data.tk), ltp);
    });
    ws.on('error', (_event, err) => {
        console.warn('[antBatchQuote] websocket error:', err);
    });

    await ws.connect({ susertoken, actid: `${userId}_API`, uid: `${userId}_API` });

    console.log(`[antBatchQuote] Subscribing to ${keys.length} option token(s)...`);
    ws.subscribe(keys);

    await sleep(QUOTE_WAIT_MS);

    console.log('[antBatchQuote] Unsubscribing and closing websocket...');
    ws.unsubscribe(keys);
    ws.close();

    return quotes;
}
