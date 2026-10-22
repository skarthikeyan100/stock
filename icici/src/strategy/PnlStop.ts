import Log from '../util/Log';
import Mongo from '../tools/mongo';
import { toPercentNumber } from '../prism/percentConfig';

// Daily max-loss latch for one owner + scope (e.g. a BulkPcr broker). Standalone copy of the
// LegManager stop logic (see maxloss.md B0 #6 - LegManager is intentionally not refactored onto this).
// Once tripped it stays tripped for the rest of the local day, including across restarts, until clear().

export interface PnlStopDeps {
    ownerType: string;                 // e.g. 'BulkPcrStrategy'
    userId: string;                    // strategy instance userId, e.g. 'BulkPcr-SENSEX'
    scope: string;                     // 'ant' | 'zerodha' | ... - part of the latch key
    getMaxLossPct: () => unknown;      // raw config value, e.g. '10%' | 10 | undefined | null
    getMaxInvestment: () => number;    // configured maxInvestment (rupees)
}

export class PnlStop {
    private tripped = false;
    private unusableLogged = false;

    constructor(private deps: PnlStopDeps) {}

    isTripped(): boolean {
        return this.tripped;
    }

    // Returns true only on the call that newly trips the latch. NaN-safe: a NaN P&L never trips.
    // Disabled (returns false) when maxLoss is unset.
    evaluate(cumulativePnl: number): boolean {
        if (this.tripped) return false;
        const raw = this.deps.getMaxLossPct();
        if (raw == null) return false;
        const pct = toPercentNumber(raw);
        if (pct === null || !(pct > 0)) {
            if (!this.unusableLogged) {
                this.unusableLogged = true;
                Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] ERROR maxLoss=${JSON.stringify(raw)} is not a usable percent - NOT enforced`);
            }
            return false;
        }
        const maxInvestment = this.deps.getMaxInvestment();
        const threshold = (pct / 100) * maxInvestment;
        if (!(threshold > 0)) {
            if (!this.unusableLogged) {
                this.unusableLogged = true;
                Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] ERROR maxLoss=${pct}% has no usable maxInvestment (${maxInvestment}) - NOT enforced`);
            }
            return false;
        }
        if (!(cumulativePnl <= -threshold)) return false;
        this.tripped = true;
        this.persist();
        Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] MAX LOSS TRIPPED - cumulative=${Math.round(cumulativePnl)} threshold=-${Math.round(threshold)} (maxLoss=${pct}% of maxInvestment=${maxInvestment})`);
        return true;
    }

    // Restores today's latch from Mongo at startup. A read failure leaves the stop untripped but logs loudly.
    async load(): Promise<void> {
        try {
            const col = Mongo.getInstance()?.db.collection('strategyLatches');
            if (!col) return;
            const doc = await col.findOne({ ownerType: this.deps.ownerType, userId: this.deps.userId, scope: this.deps.scope, day: PnlStop.latchDay() });
            if (doc?.maxLossTripped) {
                this.tripped = true;
                Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] max-loss stop was already tripped earlier today - staying stopped (admin reset clears it)`);
            }
        } catch (e) {
            Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] ERROR could not read strategyLatches - continuing with the loss stop UNTRIPPED:`, e);
        }
    }

    // Admin reset only: clears memory and every persisted day for this owner + scope.
    async clear(): Promise<void> {
        this.tripped = false;
        try {
            const col = Mongo.getInstance()?.db.collection('strategyLatches');
            if (!col) return;
            await col.deleteMany({ ownerType: this.deps.ownerType, userId: this.deps.userId, scope: this.deps.scope });
        } catch (e) {
            Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] strategyLatches clear failed (continuing):`, e);
        }
    }

    private persist(): void {
        const col = Mongo.getInstance()?.db.collection('strategyLatches');
        if (!col) return;
        const key = { ownerType: this.deps.ownerType, userId: this.deps.userId, scope: this.deps.scope, day: PnlStop.latchDay() };
        col.updateOne(key, { $set: { maxLossTripped: true, updatedAt: new Date() } }, { upsert: true })
            .catch((e) => Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] strategyLatches write failed (in-memory latch still holds):`, e));
    }

    // Same local-date key as LegManager.latchDay().
    private static latchDay(): string {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
}
