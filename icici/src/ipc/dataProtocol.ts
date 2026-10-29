// The `data` process is the server of a Unix-domain socket (newline-delimited JSON, src/ipc/jsonLines.ts): it pushes every tick to every
// connected client, and clients send it feed commands. Clients are `trading` (strategy ticks and exitMonitor watches) and `frontend`
// (the live SSE streams and the manual reconnect). Replaces the stdout/stdin pipes the orchestrator used to relay.

export const DATA_SOCKET_PATH = process.env.DATA_IPC_SOCKET || '/tmp/icici-data.sock';

// Commands a client sends to `data`. Subscriptions are per-connection and reference-counted by `data`: a token stays subscribed on the
// broker feed while any connected client holds it, and a client's holds are released when its connection closes.
export type DataCommand =
    | { cmd: 'subscribe' | 'unsubscribe' | 'subscribeDepth' | 'unsubscribeDepth'; token: string; source?: string; exchange?: 'NFO' | 'BFO' }
    | { cmd: 'reconnect'; source?: string };
