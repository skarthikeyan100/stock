// Backoff policy shared by the data-process streams for a failed (initial or later) connect. A failure that needs a login (no session,
// HTTP 401/403) is retried slowly: hammering the broker with a dead token cannot fix it, and the login itself sends a 'reconnect'
// command. Every other failure (HTTP 5xx, network, timeout) retries with exponential backoff up to a minute.
export const RECONNECT_INITIAL_MS = 2000;
export const RECONNECT_MAX_MS = 60_000;
export const RECONNECT_AUTH_MIN_MS = 30_000;
export const RECONNECT_AUTH_MAX_MS = 300_000;

export function isAuthError(e: any): boolean {
    const status = e?.response?.status;
    if (status === 401 || status === 403) return true;
    const msg = String(e?.message ?? e);
    return /session not available|userSession not available|userId not available|login/i.test(msg);
}

// The delay to use AFTER a failure that happened with `currentMs` as the delay.
export function nextReconnectDelayMs(currentMs: number, e: any): number {
    if (isAuthError(e)) return Math.min(Math.max(currentMs * 2, RECONNECT_AUTH_MIN_MS), RECONNECT_AUTH_MAX_MS);
    return Math.min(currentMs * 2, RECONNECT_MAX_MS);
}

export function describeConnectError(e: any): string {
    const status = e?.response?.status;
    return `${e?.message ?? e}${status ? ` (HTTP ${status})` : ''}`;
}
