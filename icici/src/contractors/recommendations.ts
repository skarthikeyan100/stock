/**
 * Advanced contractors' recommendations (spec v2.1 section 9). Validation COPIES the rules of src/strategy/RecommendationStrategy.ts and the
 * `recommend` skill (neither is modified; a parity test keeps them equal): stop < order price (= entry, tick-rounded; the strategy's own offset is 5) < target,
 * contract like "24150 CE", positive prices. The approval places a normal user order under the contractor's id (src/contractors/order.ts); no strategy block is involved.
 */
import configService from '../prism/ConfigService';
import Mongo from '../tools/mongo';
import { roundToTick } from '../util/tick';
import { istDate } from './agreements';

export const DEFAULT_ENTRY_OFFSET = 5; // RecommendationStrategy's (the parity test); contractor recommendations use ENTRY_OFFSET
/** A contractor's recommendation is bought AT the recommended price: no offset (owner's rule, 2026-11-16). */
export const ENTRY_OFFSET = 0;
export type RecStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export const INDEX_UNDERLYINGS = ['NIFTY', 'SENSEX'];
/** `index` is the underlying: NIFTY / SENSEX (an index option, tradable by the strategy) or a stock symbol (a stock option, see kind). */
export interface RecommendationInput { index: string; strike: number; right: 'CE' | 'PE'; entry: number; target: number; stop: number; kind: 'INDEX' | 'STOCK' }
export interface RecommendationDoc extends RecommendationInput {
    _id?: any; contractorId: string; contractorName: string; contractorEmail: string; slot?: string /* legacy: the strategy slot of recommendations made before 2026-11-16 */; contract: string; orderPrice: number; day: string;
    status: RecStatus; createdAt: Date; decidedAt?: Date; decidedBy?: string; note?: string;
}

export const recommendationsCol = () => Mongo.getInstance().db.collection('recommendations');
export const decisionsCol = () => Mongo.getInstance().db.collection('decisions');

export const contractLabel = (strike: number, right: string) => `${strike} ${right}`;
export function parseContract(contract: unknown): { strike: number; right: 'CE' | 'PE' } | null {
    const m = /^\s*(\d{3,6})\s*(CE|PE)\s*$/i.exec(String(contract ?? ''));
    return m ? { strike: Number(m[1]), right: m[2].toUpperCase() as 'CE' | 'PE' } : null;
}
/** Splits a Search & Buy style contract name (TCS_3500_CE, NIFTY_24150_PE). */
export function parseSymbol(symbol: unknown): { underlying: string; strike: number; right: 'CE' | 'PE' } | null {
    const m = /^([A-Z0-9&-]+)_(\d+(?:\.\d+)?)_(CE|PE)$/.exec(String(symbol ?? '').trim().toUpperCase());
    return m ? { underlying: m[1], strike: Number(m[2]), right: m[3] as 'CE' | 'PE' } : null;
}

export function validateRecommendation(rawIn: any, offset = DEFAULT_ENTRY_OFFSET): { ok: true; value: RecommendationInput; contract: string; orderPrice: number } | { ok: false; error: string } {
    const sym = rawIn?.symbol !== undefined ? parseSymbol(rawIn.symbol) : null;
    if (rawIn?.symbol !== undefined && !sym) return { ok: false, error: 'pick the contract from the list (like TCS_3500_CE)' };
    const raw = sym ? { ...rawIn, index: sym.underlying, strike: sym.strike, right: sym.right } : rawIn;
    const underlying = String(raw?.index ?? 'NIFTY').trim().toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(underlying)) return { ok: false, error: 'the underlying is not valid' };
    const isIndex = INDEX_UNDERLYINGS.includes(underlying);
    const right = String(raw?.right ?? '').toUpperCase();
    if (right !== 'CE' && right !== 'PE') return { ok: false, error: 'the option type must be CE or PE' };
    const strike = Number(raw?.strike);
    // An index option follows the strategy's rules exactly (3 to 6 digit strike); a stock option may have any positive strike (some are fractional).
    if (isIndex ? !(Number.isInteger(strike) && parseContract(`${strike} ${right}`)) : !(Number.isFinite(strike) && strike > 0)) return { ok: false, error: isIndex ? 'strike must be 3 to 6 digits and right CE or PE' : 'the strike is not valid' };
    const entry = Number(raw?.entry), target = Number(raw?.target), stop = Number(raw?.stop);
    if (!(entry > 0 && target > 0 && stop > 0) || ![entry, target, stop].every(Number.isFinite)) return { ok: false, error: 'entry, target and stop must be positive numbers' };
    const orderPrice = roundToTick(entry - offset);
    if (!(stop < orderPrice && orderPrice < target)) return { ok: false, error: `need stop (${stop}) < order price (${orderPrice} = entry - ${offset}) < target (${target})` };
    return { ok: true, value: { index: underlying, strike, right: right as 'CE' | 'PE', entry, target, stop, kind: isIndex ? 'INDEX' : 'STOCK' }, contract: contractLabel(strike, right), orderPrice };
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

export async function appendDecision(d: Record<string, unknown>): Promise<void> { await decisionsCol().insertOne({ ...d, at: new Date() }); }
export const today = () => istDate();
