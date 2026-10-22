import Log from '../util/Log';
import Mongo from '../tools/mongo';
import { toPercentNumber } from '../prism/percentConfig';

// Day latch for one owner + scope (e.g. a BulkPcr broker). Tripped by a max-loss breach, it stays tripped for the
// rest of the local day, including across restarts, until clear(). A latch that could not be read back after a
// restart fails closed (isTripped() is true) until a later load() succeeds.
// Standalone copy of the LegManager stop logic (see maxloss.md B0 #6 - LegManager is intentionally not refactored onto this).

export interface PnlStopDeps {
    ownerType: string;                 // e.g. 'BulkPcrStrategy'
    userId: string;                    // strategy instance userId, e.g. 'BulkPcr-SENSEX'
    scope: string;                     // 'ant' | 'zerodha' | ... - part of the latch key
    getMaxLossPct: () => unknown;      // raw config value, e.g. '10%' | 10 | undefined | null
    getMaxInvestment: () => number;    // configured maxInvestment (rupees)
}

export class PnlStop {
    private tripped = false;
    private loadFailed = false;
    private unusableLogged = false;

    constructor(private deps: PnlStopDeps) {}

    isTripped(): boolean {
        return this.tripped || this.loadFailed;
    }

    // Returns true only on the call that newly trips the latch. NaN-safe: a NaN P&L never trips.
    // Disabled (returns false) when maxLossPerTrade is unset.
    evaluate(cumulativePnl: number): boolean {
        if (this.tripped) return false;
        const raw = this.deps.getMaxLossPct();
        if (raw == null) return false;
        const pct = toPercentNumber(raw);
        if (pct === null || !(pct > 0)) {
            if (!this.unusableLogged) {
                this.unusableLogged = true;
                Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] ERROR maxLossPerTrade=${JSON.stringify(raw)} is not a usable percent - NOT enforced`);
            }
            return false;
        }
        const maxInvestment = this.deps.getMaxInvestment();
        const threshold = (pct / 100) * maxInvestment;
        if (!(threshold > 0)) {
            if (!this.unusableLogged) {
                this.unusableLogged = true;
                Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] ERROR maxLossPerTrade=${pct}% has no usable maxInvestment (${maxInvestment}) - NOT enforced`);
            }
            return false;
        }
        if (!(cumulativePnl <= -threshold)) return false;
        this.tripped = true;
        Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] MAX LOSS TRIPPED - trade P&L=${Math.round(cumulativePnl)} threshold=-${Math.round(threshold)} (maxLossPerTrade=${pct}% of maxInvestment=${maxInvestment}) - locked out for the rest of the day`);
        return true;
    }

    // True only for a real breach (or a restored one), not for a failed read - what gets written durably.
    isLatched(): boolean {
        return this.tripped;
    }

    // Restores today's latch (set from a second durable copy, e.g. the strategy's own state doc).
    markTripped(): void {
        this.tripped = true;
    }

    // Restores today's latch from Mongo. Resolves false when the latch could not be read (the stop then
    // fails closed until a later load() succeeds). Resolves true otherwise, whether or not it was tripped.
    async load(): Promise<boolean> {
        try {
            const col = Mongo.getInstance()?.db.collection('strategyLatches');
            if (!col) throw new Error('Mongo not connected');
            const doc = await col.findOne({ ownerType: this.deps.ownerType, userId: this.deps.userId, scope: this.deps.scope, day: PnlStop.latchDay() });
            this.loadFailed = false;
            if (doc?.maxLossTripped) {
                this.tripped = true;
                Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] max-loss lockout was already tripped earlier today - staying locked out (admin reset clears it)`);
            }
            return true;
        } catch (e) {
            // Fail closed only when the cap is configured: with no maxLossPerTrade there is no lockout to protect.
            this.loadFailed = this.deps.getMaxLossPct() != null;
            Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] ERROR could not read strategyLatches${this.loadFailed ? ' - broker held CLOSED (fail-closed) until it can be read' : ''}:`, e);
            return false;
        }
    }

    // Admin reset only: clears memory and every persisted day for this owner + scope.
    async clear(): Promise<void> {
        this.tripped = false;
        this.loadFailed = false;
        try {
            const col = Mongo.getInstance()?.db.collection('strategyLatches');
            if (!col) return;
            await col.deleteMany({ ownerType: this.deps.ownerType, userId: this.deps.userId, scope: this.deps.scope });
        } catch (e) {
            Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] strategyLatches clear failed (continuing):`, e);
        }
    }

    // Durable write of the tripped latch. Retried once; resolves even on failure (the in-memory latch still holds).
    async persist(): Promise<void> {
        const key = { ownerType: this.deps.ownerType, userId: this.deps.userId, scope: this.deps.scope, day: PnlStop.latchDay() };
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const col = Mongo.getInstance()?.db.collection('strategyLatches');
                if (!col) throw new Error('Mongo not connected');
                await col.updateOne(key, { $set: { maxLossTripped: true, updatedAt: new Date() } }, { upsert: true });
                return;
            } catch (e) {
                if (attempt === 2) Log.log(`[${this.deps.ownerType}] [${this.deps.scope}] strategyLatches write failed (in-memory latch still holds):`, e);
            }
        }
    }

    // Same local-date key as LegManager.latchDay().
    private static latchDay(): string {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
}
