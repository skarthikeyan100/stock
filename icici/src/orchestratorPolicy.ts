// Restart policy per child role. `data` owns the broker websockets and is never restarted during a live run (review decision 5,
// 2026-10-29): neither a crash nor a rebuilt dist/ file restarts it; an operator restarts it, outside market hours.
export type ChildRole = 'data' | 'order' | 'strategies' | 'frontend';
export type RestartReason = 'crash' | 'dist-change';

export function shouldAutoRestart(role: ChildRole, _reason: RestartReason): boolean {
    return role !== 'data';
}

// Whether a compiled-code change may restart a child now. Precedence (evaluated per detected change, never cached):
//   HOT_RESTART=true  -> allowed (explicit env escape hatch)
//   HOT_RESTART=false -> never reached (the watcher is not installed; kept here for completeness)
//   config.yml settings.hotRestartDuringMarketHours === true -> allowed
//   otherwise: allowed only outside market hours.
// `configAllows` must be false when config.yml cannot be read or parsed (fail closed).
export function shouldApplyCodeChange(input: { envHotRestart: string | undefined; configAllows: boolean; inMarketHours: boolean }): boolean {
    if (input.envHotRestart === 'true') return true;
    if (input.envHotRestart === 'false') return false;
    if (input.configAllows) return true;
    return !input.inMarketHours;
}

// Give-up limits of the crash respawner. `trading` is given up on like the other roles but sooner (user decision, 2026-11-24: it must not
// retry continuously when it keeps being rejected or crashing): 2 instead of 10, for both limits below. After giving up, the respawner
// stays stopped until the next code change or orchestrator restart.
export const MAX_QUICK_CRASHES = 10;
export const MAX_FAILED_RESTARTS = 10;
export const MAX_QUICK_CRASHES_TRADING = 2;
export const MAX_FAILED_RESTARTS_TRADING = 2;

// Consecutive children that spawned fine but exited within a minute of starting.
export function maxQuickCrashes(role: string): number {
    return role === 'trading' ? MAX_QUICK_CRASHES_TRADING : MAX_QUICK_CRASHES;
}
// Consecutive restarts that could not even spawn a child.
export function maxFailedRestarts(role: string): number {
    return role === 'trading' ? MAX_FAILED_RESTARTS_TRADING : MAX_FAILED_RESTARTS;
}
export function shouldGiveUpOnQuickCrashes(role: string, quickCrashes: number): boolean {
    return quickCrashes >= maxQuickCrashes(role);
}
export function shouldGiveUpOnFailedRestarts(role: string, failedRestarts: number): boolean {
    return failedRestarts >= maxFailedRestarts(role);
}
