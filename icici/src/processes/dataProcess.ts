// This host is dual-stack; Node's Happy-Eyeballs connection logic prefers
// IPv6 when both are available, which bypasses AliceBlue/ANT's IPv4-only
// allowlist for a3.aliceblueonline.com - AntDataStream.connect() ->
// AntSession.prepareWsSession()'s createWsSess call hits that same host to
// set up the tick WebSocket's session, so this process needs the override
// too (see kiteDns.ts's comment for the full root-cause writeup and why this
// is scoped to specific hostnames rather than forced process-wide).
import '../util/tz'; // pin TZ=Asia/Kolkata before any other module reads the clock
import { installIpv4OnlyHostOverride } from './order/kiteDns';
installIpv4OnlyHostOverride();

import Log from '../util/Log';
import Mongo from '../tools/mongo';
import AntDataStream from './data/AntDataStream';
import BreezeDataStream from './data/BreezeDataStream';
import { DataStream } from './data/DataStream';
import ANT from '../ant/ANT';
import Breeze from '../breeze/Breeze';
import { DataServer } from './data/DataServer';
import { FeedSource, DEFAULT_FEED_SOURCE } from '../ipc/feedSource';

// Entry point for the `data` process. Owns every broker connection actually
// used for ticks - one DataStream per FeedSource (see src/ipc/feedSource.ts),
// registry-dispatched so adding a new source (e.g. Prism) is a new map entry,
// not a rewrite of this dispatch logic. NIFTY + SENSEX are always subscribed
// on ANT's connect only (index ticks stay ANT-sourced regardless of which
// broker executes a trade - see the Breeze WS integration plan's scope note);
// options are subscribed/unsubscribed on demand by `trading` and `frontend`
// over the data Unix socket (src/ipc/dataProtocol.ts, DataServer). Ticks go
// out on that same socket as newline-delimited JSON to every connected client.

async function main() {
    await Mongo.init().catch((e) => Log.log('[data] Mongo.init failed (continuing without persistence):', e));

    // Ticks are broadcast to every connected client (the server is created below, before any stream connects).
    let server: DataServer;
    const streams: Partial<Record<FeedSource, DataStream>> = {
        ant: AntDataStream.getInstance((tick) => server.broadcast(tick)),
        breeze: BreezeDataStream.getInstance((tick) => server.broadcast(tick)),
    };
    const reloadSessionFns: Partial<Record<FeedSource, () => void>> = {
        // Re-read the session file first - the singleton's in-memory session may
        // be stale (e.g. empty, from a startup attempt before login) since a
        // fresh OAuth login writes the file from the frontend process instead.
        ant: () => ANT.getInstance().reloadSession(),
        breeze: () => Breeze.getInstance().reloadSession(),
    };

    const withStream = (source: string | undefined, op: (stream: DataStream, source: FeedSource) => void): void => {
        const feed: FeedSource = (source as FeedSource | undefined) ?? DEFAULT_FEED_SOURCE;
        const stream = streams[feed];
        if (!stream) {
            Log.log('[data] Unknown feed source:', feed);
            return;
        }
        op(stream, feed);
    };
    // The exchange ('NFO'/'BFO') comes from DataLink callers (tokenRouter / exitMonitor); each DataStream defaults to 'NFO' when omitted.
    server = new DataServer({
        subscribe: (kind, token, source, exchange) => withStream(source, (stream, feed) => {
            if (kind === 'subscribe') stream.subscribeOption(token, exchange);
            else if (stream.subscribeOptionDepth) stream.subscribeOptionDepth(token, exchange);
            else Log.log(`[data] subscribeDepth: ${feed} stream does not support depth mode`);
        }),
        unsubscribe: (kind, token, source, exchange) => withStream(source, (stream, feed) => {
            if (kind === 'subscribe') stream.unsubscribeOption(token, exchange);
            else if (stream.unsubscribeOptionDepth) stream.unsubscribeOptionDepth(token, exchange);
            else Log.log(`[data] unsubscribeDepth: ${feed} stream does not support depth mode`);
        }),
        other: (cmd) => {
            if (cmd.cmd === 'reconnect') {
                withStream(cmd.source, (stream, feed) => {
                    reloadSessionFns[feed]?.();
                    stream.reconnect().catch((e) => Log.log(`[data] Manual reconnect (${feed}) failed:`, e));
                });
            } else {
                Log.log('[data] Unknown command:', cmd);
            }
        },
    });
    server.start();
    process.on('SIGTERM', () => { server.stop(); process.exit(0); });

    // Not fatal if any of these fail (e.g. no session yet for that broker -
    // `data` typically starts before login completes): the command server
    // above is already listening, so a later 'reconnect' (from
    // /ant/callback, /breeze/callback, /ant/connect, etc. once authorized)
    // still reaches a live process instead of one that already exited. A
    // same-day session already on disk connects here immediately, same as
    // before.
    for (const [source, stream] of Object.entries(streams)) {
        stream!
            .connect()
            .then(() => Log.log(`[data] ${source} stream ready`))
            .catch((e) => Log.log(`[data] Initial ${source} connect failed (will retry via reconnect):`, e));
    }
    Log.log('[data] Ready - NIFTY/SENSEX always subscribed (ANT), streaming on the data socket.');
}

main().catch((e) => {
    Log.log('[data] Fatal startup error:', e);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    Log.log('[data] Unhandled promise rejection (process kept alive):', reason);
});
// No uncaughtException handler on purpose: an uncaught error here means the feed may be half-dead, and exiting makes that loud - the
// clients see the socket close and raise a feed-down alert (the orchestrator does not restart `data`, review decision 5; an operator
// restarts it outside market hours). Staying up would leave every position tick-starved with nothing to say so.
