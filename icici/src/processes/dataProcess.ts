// stdout is reserved for the tick protocol (JSON lines out to strategies/frontend)
// - Log.log (and anything else) writes via console.log, so redirect that to
// stderr first, before any other module (which may log at import time) loads.
console.log = console.error;

import Log from '../util/Log';
import Mongo from '../tools/mongo';
import AntDataStream from './data/AntDataStream';
import { writeJsonLine, readJsonLines } from '../ipc/jsonLines';

// Entry point for the `data` process. Owns the one broker connection actually
// used for ticks (ANT). NIFTY + SENSEX are always subscribed on connect; options
// are subscribed/unsubscribed on demand via stdin commands from `strategies`
// (relayed by the orchestrator, which is the only process holding both child
// handles). Ticks go out over stdout as newline-delimited JSON - consumed by
// both `strategies` and `frontend` (the orchestrator pipes this same stdout to
// both children's stdin).

async function main() {
    await Mongo.init().catch((e) => Log.log('[data] Mongo.init failed (continuing without persistence):', e));

    const stream = AntDataStream.getInstance((tick) => writeJsonLine(process.stdout, tick));

    readJsonLines(
        process.stdin,
        (cmd) => {
            if (cmd.cmd === 'subscribe' && cmd.token) {
                stream.subscribeOption(cmd.token);
            } else if (cmd.cmd === 'unsubscribe' && cmd.token) {
                stream.unsubscribeOption(cmd.token);
            } else if (cmd.cmd === 'reconnect') {
                stream.reconnect().catch((e) => Log.log('[data] Manual reconnect failed:', e));
            } else {
                Log.log('[data] Unknown stdin command:', cmd);
            }
        },
        (line, err) => Log.log('[data] Failed to parse stdin command:', line, err)
    );

    await stream.connect();
    Log.log('[data] Ready - NIFTY/SENSEX always subscribed, streaming to stdout.');
}

main().catch((e) => {
    Log.log('[data] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
