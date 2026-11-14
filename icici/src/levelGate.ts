/**
 * Server-side gating by proficiency level. A Beginner may use Flash Trade only, with the global target / stop-loss and the investmentAmount mode;
 * Search & Buy and own target / stop-loss / investment mode are Advanced features. Admins are never restricted. These checks are the real guard:
 * hiding the controls in the UI is not enough, a caller can send any request.
 */
import { normalizeLevel } from './levelRules';

export interface BuyGateResult { allowed: boolean; error?: string; targetPoints?: number; stopLossPoints?: number }

const usable = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);

export function gateBuy(a: { role?: string; level: unknown; contract?: string; targetPoints?: number; stopLossPoints?: number; globalTarget?: number; globalStopLoss?: number }): BuyGateResult {
    if (a.role === 'admin' || normalizeLevel(a.level) === 'advanced') return { allowed: true, targetPoints: a.targetPoints, stopLossPoints: a.stopLossPoints };
    if (a.contract) return { allowed: false, error: 'Search & Buy is available at the Advanced level' };
    return { allowed: true, targetPoints: usable(a.globalTarget), stopLossPoints: usable(a.globalStopLoss) };
}

export function gateSettings(a: { role?: string; level: unknown; investmentMode?: string; targetPoints?: number | null; stopLossPoints?: number | null }): { allowed: boolean; error?: string } {
    if (a.role === 'admin' || normalizeLevel(a.level) === 'advanced') return { allowed: true };
    if (a.investmentMode !== undefined && a.investmentMode !== 'investmentAmount') return { allowed: false, error: 'Beginner accounts always buy with the investment-amount mode. Upgrade to Advanced to choose fixed lots.' };
    if ((a.targetPoints !== undefined && a.targetPoints !== null) || (a.stopLossPoints !== undefined && a.stopLossPoints !== null)) return { allowed: false, error: 'Target and stop-loss are fixed for Beginner accounts. Upgrade to Advanced to set your own.' };
    return { allowed: true };
}
