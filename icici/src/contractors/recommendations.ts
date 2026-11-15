/**
 * Advanced contractors' recommendations (spec v2.1 section 9). Validation COPIES the rules of src/strategy/RecommendationStrategy.ts and the
 * `recommend` skill (neither is modified; a parity test keeps them equal): stop < order price (= entry - offset, tick-rounded) < target,
 * contract like "24150 CE", positive prices. The approval writes the contractor's slot block in config.yml, exactly what the skill does by hand.
 */
import * as fs from 'fs';
import * as path from 'path';
import configService from '../prism/ConfigService';
import Mongo from '../tools/mongo';
import { roundToTick } from '../util/tick';
import { istDate } from './agreements';

export const DEFAULT_ENTRY_OFFSET = 5;
export type RecStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface RecommendationInput { index: 'NIFTY' | 'SENSEX'; strike: number; right: 'CE' | 'PE'; entry: number; target: number; stop: number }
export interface RecommendationDoc extends RecommendationInput {
    _id?: any; contractorId: string; contractorName: string; contractorEmail: string; slot: string; contract: string; orderPrice: number; day: string;
    status: RecStatus; createdAt: Date; decidedAt?: Date; decidedBy?: string; note?: string;
}

export const recommendationsCol = () => Mongo.getInstance().db.collection('recommendations');
export const decisionsCol = () => Mongo.getInstance().db.collection('decisions');

export const contractLabel = (strike: number, right: string) => `${strike} ${right}`;
export function parseContract(contract: unknown): { strike: number; right: 'CE' | 'PE' } | null {
    const m = /^\s*(\d{3,6})\s*(CE|PE)\s*$/i.exec(String(contract ?? ''));
    return m ? { strike: Number(m[1]), right: m[2].toUpperCase() as 'CE' | 'PE' } : null;
}
/** The key RecommendationStrategy.keyOf builds: one recommendation is never placed twice a day. */
export function keyOf(contract: string, entry: number, target: number, stop: number, maxInvestment: number, offset = DEFAULT_ENTRY_OFFSET): string {
    return `${contract}|${Number(entry)}|${Number(target)}|${Number(stop)}|${Number(maxInvestment)}|${offset}`;
}

export function validateRecommendation(raw: any, offset = DEFAULT_ENTRY_OFFSET): { ok: true; value: RecommendationInput; contract: string; orderPrice: number } | { ok: false; error: string } {
    const index = String(raw?.index ?? 'NIFTY').toUpperCase();
    if (index !== 'NIFTY' && index !== 'SENSEX') return { ok: false, error: 'index must be NIFTY or SENSEX' };
    const right = String(raw?.right ?? '').toUpperCase();
    const strike = Number(raw?.strike);
    const parsed = parseContract(`${strike} ${right}`);
    if (!parsed || !Number.isInteger(strike)) return { ok: false, error: 'strike must be 3 to 6 digits and right CE or PE' };
    const entry = Number(raw?.entry), target = Number(raw?.target), stop = Number(raw?.stop);
    if (!(entry > 0 && target > 0 && stop > 0) || ![entry, target, stop].every(Number.isFinite)) return { ok: false, error: 'entry, target and stop must be positive numbers' };
    const orderPrice = roundToTick(entry - offset);
    if (!(stop < orderPrice && orderPrice < target)) return { ok: false, error: `need stop (${stop}) < order price (${orderPrice} = entry - ${offset}) < target (${target})` };
    return { ok: true, value: { index: index as 'NIFTY' | 'SENSEX', strike, right: parsed.right, entry, target, stop }, contract: contractLabel(strike, parsed.right), orderPrice };
}

/** forecast.recommendationHours {start,end} (default 09:20 to 15:00 IST) and forecast.recommendationsPerDay (default 1). */
export function recommendationRules(): { start: string; end: string; perDay: number } {
    const f: any = (configService.getConfig() as any)?.forecast ?? {};
    const hhmm = (v: unknown, d: string) => (/^\d{2}:\d{2}$/.test(String(v ?? '')) ? String(v) : d);
    const perDay = Number(f.recommendationsPerDay);
    return { start: hhmm(f.recommendationHours?.start, '09:20'), end: hhmm(f.recommendationHours?.end, '15:00'), perDay: Number.isInteger(perDay) && perDay > 0 ? perDay : 1 };
}
export function istHHMM(d = new Date()): string {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
export function withinHours(rules: { start: string; end: string }, now = new Date()): boolean { const t = istHHMM(now); return t >= rules.start && t <= rules.end; }

// ---- the slot's strategy block ----
const stateFile = (slot: string) => path.join(__dirname, `../../.RecommendationStrategy.${slot.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
export function readSlotState(slot: string): any | null { try { return JSON.parse(fs.readFileSync(stateFile(slot), 'utf8')); } catch { return null; } }

/** A trade of this slot is still in progress today (an order resting, a position open, or an entry still filling): the skill refuses a new recommendation then. */
export function tradeInProgress(state: any, today = new Date().toLocaleDateString('en-CA')): boolean {
    if (!state || state.day !== today) return false;
    for (const leg of Object.values<any>(state.legs ?? {})) {
        if (leg.status === 'placing' || leg.status === 'resting') return true;
        if (leg.status === 'filled' && (leg.soldQty ?? 0) < (leg.filledQty ?? 0)) return true;
        if (!['failed', 'cancelled', 'closed', 'filled'].includes(leg.status) && !leg.entryCancelled && (leg.filledQty ?? 0) < (leg.qty ?? 0)) return true;
    }
    return false;
}
export function slotBlock(slot: string): any | undefined {
    return ((configService.getConfig() as any)?.strategies ?? []).find((s: any) => s.type === 'RecommendationStrategy' && s.userId === slot);
}
/** Why a recommendation cannot be put on this slot now, or null. */
export function slotRefusal(slot: string, rec: { contract: string; entry: number; target: number; stop: number }, today = new Date().toLocaleDateString('en-CA')): string | null {
    const block = slotBlock(slot);
    if (!block) return `strategy slot ${slot} is not in config.yml`;
    if (block.enabled === true) return 'the previous approved recommendation has not finished yet';
    const state = readSlotState(slot);
    if (tradeInProgress(state, today)) return 'a trade of this contractor is still in progress';
    const key = keyOf(rec.contract, rec.entry, rec.target, rec.stop, Number(block.maxInvestment), block.entryOffset == null ? DEFAULT_ENTRY_OFFSET : Number(block.entryOffset));
    if (state?.day === today && (state.keys ?? []).includes(key)) return 'this recommendation already traded today';
    return null;
}
/** Arms the slot block with the recommendation (what the recommend skill does by hand). */
export function armSlot(slot: string, rec: { index: string; contract: string; entry: number; target: number; stop: number }): void {
    const cfg: any = configService.getConfig();
    const block = (cfg.strategies ?? []).find((s: any) => s.type === 'RecommendationStrategy' && s.userId === slot);
    if (!block) throw new Error(`strategy slot ${slot} is not in config.yml`);
    Object.assign(block, { enabled: true, contract: rec.contract, entryPrice: rec.entry, targetPrice: rec.target, stopLoss: rec.stop, index: rec.index });
    configService.writeConfig(cfg);
    configService.reloadNow();
}

export async function appendDecision(d: Record<string, unknown>): Promise<void> { await decisionsCol().insertOne({ ...d, at: new Date() }); }
export const today = () => istDate();
