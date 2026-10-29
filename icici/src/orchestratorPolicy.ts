// Restart policy per child role. `data` owns the broker websockets and is never restarted during a live run (review decision 5,
// 2026-10-29): neither a crash nor a rebuilt dist/ file restarts it; an operator restarts it, outside market hours.
export type ChildRole = 'data' | 'order' | 'strategies' | 'frontend';
export type RestartReason = 'crash' | 'dist-change';

export function shouldAutoRestart(role: ChildRole, _reason: RestartReason): boolean {
    return role !== 'data';
}
