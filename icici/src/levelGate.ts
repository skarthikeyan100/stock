/**
 * Server-side gating by proficiency level. A Beginner may use Flash Trade only, with the global target / stop-loss and the investmentAmount mode;
 * Search & Buy and own target / stop-loss / investment mode are Advanced features. Admins are never restricted. These checks are the real guard:
 * hiding the controls in the UI is not enough, a caller can send any request.
 */
import { normalizeLevel } from './levelRules';

export interface BuyGateResult { allowed: boolean; error?: string; targetPoints?: number; stopLossPoints?: number }

const usable = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);

export function gateBuy(a: { role?: string; level: unknown; contract?: string; targetPoints?: number; stopLossPoints?: number; globalTarget?: number; globalStopLoss?: number }): BuyGateResult {
    if (a.role === 'admin') return { allowed: true, targetPoints: a.targetPoints, stopLossPoints: a.stopLossPoints };
    // Advanced: own target/stop, but a stop of 0 would mean no protection AND no per-trade cap (quantity is sized from the stop), so it falls back to the global stop.
    if (normalizeLevel(a.level) === 'advanced') return { allowed: true, targetPoints: a.targetPoints, stopLossPoints: a.stopLossPoints === 0 ? usable(a.globalStopLoss) : a.stopLossPoints };
    if (a.contract) return { allowed: false, error: 'Search & Buy is available at the Advanced level' };
    return { allowed: true, targetPoints: usable(a.globalTarget), stopLossPoints: usable(a.globalStopLoss) };
}

export function gateSettings(a: { role?: string; level: unknown; investmentMode?: string; targetPoints?: number | null; stopLossPoints?: number | null }): { allowed: boolean; error?: string } {
    if (a.role === 'admin' || normalizeLevel(a.level) === 'advanced') return { allowed: true };
    if (a.investmentMode !== undefined && a.investmentMode !== 'investmentAmount') return { allowed: false, error: 'Beginner accounts always buy with the investment-amount mode. Upgrade to Advanced to choose fixed lots.' };
    if ((a.targetPoints !== undefined && a.targetPoints !== null) || (a.stopLossPoints !== undefined && a.stopLossPoints !== null)) return { allowed: false, error: 'Target and stop-loss are fixed for Beginner accounts. Upgrade to Advanced to set your own.' };
    return { allowed: true };
}

/** POST /order/settarget: changing the target / stop of an open position. A Beginner's are fixed; an Advanced user may not remove the stop (0), which would also defeat the per-trade cap. */
export function gateSetTarget(a: { role?: string; level: unknown; targetPoints: number; stopLossPoints: number }): { allowed: boolean; error?: string } {
    if (a.role === 'admin') return { allowed: true };
    if (normalizeLevel(a.level) !== 'advanced') return { allowed: false, error: 'Target and stop-loss are fixed for Beginner accounts. Upgrade to Advanced to set your own.' };
    if (!(a.stopLossPoints > 0)) return { allowed: false, error: 'A stop-loss above 0 is required' };
    return { allowed: true };
}

/** Advanced is permanent: no downgrade, from any caller. */
export function gateLevelChange(current: unknown, requested: 'beginner' | 'advanced'): { allowed: boolean; error?: string } {
    if (normalizeLevel(current) === 'advanced' && requested === 'beginner') return { allowed: false, error: 'Advanced is permanent; an account cannot be moved back to Beginner' };
    return { allowed: true };
}
