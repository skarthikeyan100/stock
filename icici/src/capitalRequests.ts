/**
 * Capital-increase requests: an Advanced user with at least REQUIRED_SUCCESSFUL_WEEKS successful weeks may ask for more allocated capital; an admin
 * decides (the rule is a floor, not an entitlement). Mongo collection `capitalRequests`
 * {user, requestedAmount, status: 'pending'|'approved'|'rejected', stats, createdAt, decidedAt, decidedBy, note, amount}; one pending per user.
 */
import { ObjectId } from 'mongodb';
import Mongo from './tools/mongo';
import Log from './util/Log';
import { getUser, updateUserSettings } from './user';
import { normalizeLevel } from './levelRules';
import { successfulWeeksFor } from './successfulWeeks';

export const MAX_CAPITAL_MULTIPLE = 10;

const requests = () => Mongo.getInstance().db.collection('capitalRequests');

let indexReady = false;
async function ensureIndex(): Promise<void> {
    if (indexReady) return;
    try {
        await requests().createIndex({ user: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
        indexReady = true;
    } catch (e) { Log.log('[capital] could not create the pending-request index (continuing):', e); }
}

export function canRequestCapital(a: { level: unknown; accountClosed?: boolean; successfulWeeks: number; requiredWeeks: number }): { ok: boolean; reason?: string } {
    if (normalizeLevel(a.level) !== 'advanced') return { ok: false, reason: 'Only Advanced users can request more capital' };
    if (a.accountClosed === true) return { ok: false, reason: 'Your account is closed' };
    if (a.successfulWeeks < a.requiredWeeks) return { ok: false, reason: `You need ${a.requiredWeeks} successful weeks (you have ${a.successfulWeeks})` };
    return { ok: true };
}

export async function createCapitalRequest(email: string, requestedAmount: number): Promise<{ id: string }> {
    const user = await getUser(email);
    if (!user) throw new Error('User not found');
    const weeks = await successfulWeeksFor(email);
    const can = canRequestCapital({ level: user.proficiencyLevel, accountClosed: user.accountClosed, successfulWeeks: weeks.count, requiredWeeks: weeks.required });
    if (!can.ok) throw new Error(can.reason);
    const current = user.accountCapital ?? user.investmentAmount ?? 0;
    if (!(typeof requestedAmount === 'number' && Number.isFinite(requestedAmount) && requestedAmount > current && requestedAmount <= current * MAX_CAPITAL_MULTIPLE)) {
        throw new Error(`Ask for an amount above your current capital (${current}) and at most ${MAX_CAPITAL_MULTIPLE}x of it`);
    }
    await ensureIndex();
    if (await requests().findOne({ user: email, status: 'pending' })) throw new Error('You already have a capital request waiting for an admin');
    try {
        const res = await requests().insertOne({ user: email, requestedAmount, status: 'pending', createdAt: new Date(), stats: { successfulWeeks: weeks.count, currentCapital: current } });
        return { id: String(res.insertedId) };
    } catch (e: any) {
        if (e?.code === 11000) throw new Error('You already have a capital request waiting for an admin');
        throw e;
    }
}

export async function listCapitalRequests(status?: string): Promise<any[]> {
    const rows = await requests().find(status ? { status } : {}).sort({ createdAt: -1 }).toArray();
    const out: any[] = [];
    for (const r of rows) {
        const user = await getUser(r.user);
        let successfulWeeks = 0;
        try { successfulWeeks = (await successfulWeeksFor(r.user)).count; } catch (e) { Log.log('[capital] successful weeks unavailable for', r.user, e); }
        out.push({ ...r, id: String(r._id), userName: user?.name, currentCapital: user?.accountCapital ?? user?.investmentAmount, successfulWeeks });
    }
    return out;
}

export async function decideCapitalRequest(id: string, decision: 'approve' | 'reject', adminEmail: string, opts: { amount?: number; note?: string } = {}): Promise<any> {
    if (opts.amount !== undefined && !(typeof opts.amount === 'number' && Number.isFinite(opts.amount) && opts.amount > 0)) throw new Error('amount must be a positive number');
    let oid: ObjectId;
    try { oid = new ObjectId(id); } catch { throw new Error('Request not found'); }
    const status = decision === 'approve' ? 'approved' : 'rejected';
    // Compare-and-set: only a PENDING request can be decided, exactly once.
    const res: any = await requests().findOneAndUpdate(
        { _id: oid, status: 'pending' },
        { $set: { status, decidedAt: new Date(), decidedBy: adminEmail, ...(opts.note ? { note: opts.note } : {}), ...(decision === 'approve' && opts.amount ? { amount: opts.amount } : {}) } },
        { returnDocument: 'after' }
    );
    const request = res?.value;
    if (!request) {
        const existing = await requests().findOne({ _id: oid });
        throw new Error(existing ? `Request already decided (${existing.status})` : 'Request not found');
    }
    if (decision === 'approve') {
        try {
            await updateUserSettings(request.user, { accountCapital: opts.amount ?? request.requestedAmount } as any);
        } catch (e) {
            await requests().updateOne({ _id: oid }, { $set: { status: 'pending' }, $unset: { decidedAt: '', decidedBy: '', note: '', amount: '' } });
            throw e;
        }
    }
    return request;
}
