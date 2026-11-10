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
