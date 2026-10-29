// The merged `order` + `strategies` process (review decision 2, 2026-10-29). One process owns broker execution, risk bookkeeping and
// every strategy, so strategy -> order calls are plain in-process calls (OrderClient.useLocalServer) instead of Unix-socket hops, and
// the startup order is one sequence: order state first, then strategies (which reconcile before any tick - see
// strategiesProcess.startupReconcile). `frontend` still reaches both through the same two sockets (ORDER_IPC_SOCKET and
// STRATEGIES_IPC_SOCKET, served from here), and `data` stays a separate process feeding ticks over its own socket (ipc/DataLink).

import '../util/tz'; // pin TZ=Asia/Kolkata before any other module reads the clock
import Log from '../util/Log';
import OrderClient from './strategies/OrderClient';
import { startOrderProcess, stopOrderProcess, handleRequest, onNotification } from './orderProcess';
import { startStrategiesProcess, stopStrategiesProcess } from './strategiesProcess';

async function main() {
    await startOrderProcess();
    // Before the strategies side starts: its OrderClient must talk to the handler above, not look for a socket.
    OrderClient.getInstance().useLocalServer(handleRequest);
    onNotification((msg) => OrderClient.getInstance().deliverLocal(msg));
    await startStrategiesProcess();
    Log.log('[trading] order + strategies running in one process');
}

main().catch((e) => {
    Log.log('[trading] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => {
    stopOrderProcess();
    stopStrategiesProcess();
    process.exit(0);
});
