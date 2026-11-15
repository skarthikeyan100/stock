/**
 * Strategy slots. A strategy instance exists only if its block was in config.yml when the strategies process STARTED (a block added while
 * running needs a restart), so contractors cannot get a block created on demand. Instead config.yml carries a pool of disabled blocks:
 *   Recommendation-S01..  (type RecommendationStrategy)  for Advanced contractors' approved recommendations
 *   Forecast-S01..        (type ForecastEntryStrategy)    for Beginner forecasts that pass the filters
 * A contractor is assigned a free slot when activated; the slot id is the strategy user id its trades are booked under, so its P&L is isolated.
 * Slots are never reused after a contractor leaves (their history stays attributable); add more blocks (and restart) if the pool runs out.
 */
import configService from '../prism/ConfigService';
import { contractorsCol } from './store';
import { Contractor, ContractorType } from './types';

export const SLOT_SPEC: Record<ContractorType, { strategyType: string; prefix: string }> = {
    INDIVIDUAL: { strategyType: 'ForecastEntryStrategy', prefix: 'Forecast-S' },
    BUSINESS: { strategyType: 'RecommendationStrategy', prefix: 'Recommendation-S' },
};

export function configuredSlots(type: ContractorType): string[] {
    const spec = SLOT_SPEC[type];
    const blocks = ((configService.getConfig() as any)?.strategies ?? []) as Array<{ type?: string; userId?: string }>;
    return blocks.filter((b) => b.type === spec.strategyType && typeof b.userId === 'string' && new RegExp(`^${spec.prefix}\\d{2,}$`).test(b.userId)).map((b) => b.userId as string).sort();
}

/** Gives the contractor the first free slot (idempotent). Null when the pool is exhausted or the blocks are not in config.yml yet. */
export async function ensureSlot(c: Contractor): Promise<string | null> {
    if (c.pseudoUserId) return c.pseudoUserId;
    const used = new Set((await contractorsCol().find({}).toArray()).map((x: any) => x.pseudoUserId).filter(Boolean));
    const free = configuredSlots(c.type).find((s) => !used.has(s));
    if (!free) return null;
    // compare-and-set so two activations cannot take the same slot for one contractor twice
    const r = await contractorsCol().updateOne({ id: c.id, pseudoUserId: '' }, { $set: { pseudoUserId: free } });
    if (!r.matchedCount) return (await contractorsCol().findOne({ id: c.id }))?.pseudoUserId || null;
    c.pseudoUserId = free;
    return free;
}
