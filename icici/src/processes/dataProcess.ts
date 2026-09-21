// stdout is reserved for the tick protocol (JSON lines out to strategies/frontend)
// - Log.log (and anything else) writes via console.log, so redirect that to
// stderr first, before any other module (which may log at import time) loads.
console.log = console.error;

import Log from '../util/Log';
import Mongo from '../tools/mongo';
import AntDataStream from './data/AntDataStream';
import BreezeDataStream from './data/BreezeDataStream';
import { DataStream } from './data/DataStream';
import ANT from '../ant/ANT';
import Breeze from '../breeze/Breeze';
import { writeJsonLine, readJsonLines } from '../ipc/jsonLines';
import { FeedSource, DEFAULT_FEED_SOURCE } from '../ipc/feedSource';

// Entry point for the `data` process. Owns every broker connection actually
// used for ticks - one DataStream per FeedSource (see src/ipc/feedSource.ts),
// registry-dispatched so adding a new source (e.g. Prism) is a new map entry,
// not a rewrite of this dispatch logic. NIFTY + SENSEX are always subscribed
// on ANT's connect only (index ticks stay ANT-sourced regardless of which
// broker executes a trade - see the Breeze WS integration plan's scope note);
// options are subscribed/unsubscribed on demand via stdin commands from
// `strategies` (relayed by the orchestrator, which is the only process
// holding both child handles). Ticks go out over stdout as newline-delimited
// JSON - consumed by both `strategies` and `frontend` (the orchestrator pipes
// this same stdout to both children's stdin).

async function main() {
    await Mongo.init().catch((e) => Log.log('[data] Mongo.init failed (continuing without persistence):', e));

    const streams: Partial<Record<FeedSource, DataStream>> = {
        ant: AntDataStream.getInstance((tick) => writeJsonLine(process.stdout, tick)),
        breeze: BreezeDataStream.getInstance((tick) => writeJsonLine(process.stdout, tick)),
    };
    const reloadSessionFns: Partial<Record<FeedSource, () => void>> = {
        // Re-read the session file first - the singleton's in-memory session may
        // be stale (e.g. empty, from a startup attempt before login) since a
        // fresh OAuth login writes the file from the frontend process instead.
        ant: () => ANT.getInstance().reloadSession(),
        breeze: () => Breeze.getInstance().reloadSession(),
    };

    readJsonLines(
        process.stdin,
        (cmd) => {
            const source: FeedSource = cmd.source ?? DEFAULT_FEED_SOURCE;
            const stream = streams[source];
            if (!stream) {
                Log.log('[data] Unknown feed source:', source);
                return;
            }
            if (cmd.cmd === 'subscribe' && cmd.token) {
                stream.subscribeOption(cmd.token);
            } else if (cmd.cmd === 'unsubscribe' && cmd.token) {
                stream.unsubscribeOption(cmd.token);
            } else if (cmd.cmd === 'subscribeDepth' && cmd.token) {
                if (stream.subscribeOptionDepth) stream.subscribeOptionDepth(cmd.token);
                else Log.log(`[data] subscribeDepth: ${source} stream does not support depth mode`);
            } else if (cmd.cmd === 'unsubscribeDepth' && cmd.token) {
                if (stream.unsubscribeOptionDepth) stream.unsubscribeOptionDepth(cmd.token);
                else Log.log(`[data] unsubscribeDepth: ${source} stream does not support depth mode`);
            } else if (cmd.cmd === 'reconnect') {
                reloadSessionFns[source]?.();
                stream.reconnect().catch((e) => Log.log(`[data] Manual reconnect (${source}) failed:`, e));
            } else {
                Log.log('[data] Unknown stdin command:', cmd);
            }
        },
        (line, err) => Log.log('[data] Failed to parse stdin command:', line, err)
    );

    // Not fatal if any of these fail (e.g. no session yet for that broker -
    // `data` typically starts before login completes): the stdin command
    // listener above is already registered, so a later 'reconnect' (from
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
    Log.log('[data] Ready - NIFTY/SENSEX always subscribed (ANT), streaming to stdout.');
}

main().catch((e) => {
    Log.log('[data] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
