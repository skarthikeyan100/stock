/** Mongo access for forecasts. A forecast row is WRITE-ONCE: it is inserted by insertForecast and the only update is scoreOpenForecast (OPEN -> a final outcome); nothing edits direction, submittedAt or the snapshots. */
import Mongo from '../tools/mongo';

export type ForecastOutcome = 'OPEN' | 'CORRECT' | 'INCORRECT' | 'NEUTRAL' | 'VOID';
export interface ForecastDoc {
    _id?: any;
    id: string;
    contractorId: string;
    direction: 'UP' | 'DOWN';
    confidence?: 'Low' | 'Medium' | 'High';
    submittedAt: Date;           // server time
    day: string;                 // IST date of submittedAt
    windowMinutes: number;       // config snapshot
    refValueStart: number;       // NIFTY 50 at submission, from the feed
    refTickTs: number;           // when that tick arrived (ms)
    neutralThresholdPoints: number; // config snapshot
    feeAmount: number;           // config snapshot (Beginner fee per correct forecast)
    agreementVersion: string;
    outcome: ForecastOutcome;
    refValueEnd?: number;
    refTickEndTs?: number;
    scoredAt?: Date;
}
export const forecastsCol = () => Mongo.getInstance().db.collection('forecasts');
export const niftyTicksCol = () => Mongo.getInstance().db.collection('niftyTicks');

export async function insertForecast(f: ForecastDoc): Promise<void> { await forecastsCol().insertOne({ ...f }); }

/** The only mutation a forecast ever gets: OPEN -> final outcome, once (compare-and-set). Returns false if it was no longer OPEN. */
export async function scoreOpenForecast(id: string, outcome: Exclude<ForecastOutcome, 'OPEN'>, end: { value?: number; tickTs?: number }, now = new Date()): Promise<boolean> {
    const set: Record<string, unknown> = { outcome, scoredAt: now };
    if (end.value !== undefined) set.refValueEnd = end.value;
    if (end.tickTs !== undefined) set.refTickEndTs = end.tickTs;
    const r = await forecastsCol().updateOne({ id, outcome: 'OPEN' }, { $set: set });
    return r.matchedCount === 1;
}

export async function forecastsOfDay(contractorId: string, day: string): Promise<ForecastDoc[]> {
    return (await forecastsCol().find({ contractorId, day }).sort({ submittedAt: 1 }).toArray()) as ForecastDoc[];
}
export async function openForecasts(): Promise<ForecastDoc[]> { return (await forecastsCol().find({ outcome: 'OPEN' }).toArray()) as ForecastDoc[]; }

export interface Accuracy { correct: number; incorrect: number; neutral: number; void: number; scored: number; accuracyPct: number | null }
/** Share of CORRECT among CORRECT + INCORRECT + NEUTRAL (VOID is excluded: it is nobody's fault). */
export function accuracyOf(rows: Pick<ForecastDoc, 'outcome'>[]): Accuracy {
    const n = (o: string) => rows.filter((r) => r.outcome === o).length;
    const correct = n('CORRECT'), incorrect = n('INCORRECT'), neutral = n('NEUTRAL'), v = n('VOID');
    const scored = correct + incorrect + neutral;
    return { correct, incorrect, neutral, void: v, scored, accuracyPct: scored ? Math.round((correct / scored) * 1000) / 10 : null };
}
