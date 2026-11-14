/**
 * Becoming Advanced. Two ways: a Beginner REQUESTS it (explicitly accepting the Advanced terms) and an admin approves, or a company user gives a
 * GSTIN and is approved at once (the route calls applyAdvanced with via 'gstin'; the invoice rule in invoiceRule.ts is what keeps that honest).
 * Permanent: nothing here, or reachable by a user, sets a level back to Beginner. Mongo collection `upgradeRequests`
 * {user, status: 'pending'|'approved'|'rejected', acceptance, createdAt, decidedAt, decidedBy, note, capital}; one pending request per user (a unique
 * partial index backs the check, so two simultaneous requests cannot both be stored).
 */
import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import Mongo from './tools/mongo';
import Log from './util/Log';
import { getUser, markAdvanced, levelDefaultsFor } from './user';
import { normalizeLevel } from './levelRules';
import { successfulWeeksFor } from './successfulWeeks';
import { ADVANCED_TERMS_TEXT } from './levelTable';

export const ADVANCED_TERMS_VERSION = '2026-11-14';
/** Hash of the Advanced terms the user accepted (stored with the acceptance time). */
export function advancedTermsSha256(): string {
    return crypto.createHash('sha256').update(`${ADVANCED_TERMS_VERSION}\n${ADVANCED_TERMS_TEXT.join('\n')}`).digest('hex');
}

const requests = () => Mongo.getInstance().db.collection('upgradeRequests');

let indexReady = false;
async function ensureIndex(): Promise<void> {
    if (indexReady) return;
    try {
        await requests().createIndex({ user: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
        indexReady = true;
    } catch (e) { Log.log('[upgrade] could not create the pending-request index (continuing):', e); }
}

export function canRequestUpgrade(u: { proficiencyLevel?: unknown; accountClosed?: boolean }): { ok: boolean; reason?: string } {
    if (normalizeLevel(u.proficiencyLevel) === 'advanced') return { ok: false, reason: 'You are already Advanced' };
    if (u.accountClosed === true) return { ok: false, reason: 'Your account is closed' };
    return { ok: true };
}

export async function createUpgradeRequest(email: string): Promise<{ id: string }> {
    const user = await getUser(email);
    if (!user) throw new Error('User not found');
    const can = canRequestUpgrade(user);
    if (!can.ok) throw new Error(can.reason);
    await ensureIndex();
    if (await requests().findOne({ user: email, status: 'pending' })) throw new Error('You already have an upgrade request waiting for an admin');
    try {
        const res = await requests().insertOne({
            user: email, status: 'pending', createdAt: new Date(),
            acceptance: { acceptedAt: new Date(), termsSha256: advancedTermsSha256(), termsVersion: ADVANCED_TERMS_VERSION },
        });
        return { id: String(res.insertedId) };
    } catch (e: any) {
        if (e?.code === 11000) throw new Error('You already have an upgrade request waiting for an admin');
        throw e;
    }
}

export async function listUpgradeRequests(status?: 'pending' | 'approved' | 'rejected'): Promise<any[]> {
    const rows = await requests().find(status ? { status } : {}).sort({ createdAt: -1 }).toArray();
    const out: any[] = [];
    for (const r of rows) {
        const user = await getUser(r.user);
        let successfulWeeks = 0;
        try { successfulWeeks = (await successfulWeeksFor(r.user)).count; } catch (e) { Log.log('[upgrade] successful weeks unavailable for', r.user, e); }
        out.push({ ...r, id: String(r._id), userName: user?.name, level: normalizeLevel(user?.proficiencyLevel), currentCapital: user?.accountCapital ?? user?.investmentAmount, successfulWeeks });
    }
    return out;
}

/** Makes the user Advanced: capital (default: the Advanced level's), the Advanced profit share, when/how, and the accepted terms. Idempotent. */
export async function applyAdvanced(email: string, a: { via: 'admin' | 'gstin'; capital?: number; acceptance?: { acceptedAt: Date; termsSha256: string } }): Promise<any> {
    const user = await getUser(email);
    if (!user) throw new Error('User not found');
    if (normalizeLevel(user.proficiencyLevel) === 'advanced') return user;
    const defaults = levelDefaultsFor('advanced');
    await markAdvanced(email, {
        accountCapital: a.capital ?? defaults.accountCapital,
        profitSplitPercent: defaults.profitSplitPercent,
        via: a.via,
        acceptance: a.acceptance ?? { acceptedAt: new Date(), termsSha256: advancedTermsSha256() },
    });
    return getUser(email);
}

export async function decideUpgradeRequest(id: string, decision: 'approve' | 'reject', adminEmail: string, opts: { capital?: number; note?: string } = {}): Promise<{ user?: any; request: any }> {
    if (opts.capital !== undefined && !(typeof opts.capital === 'number' && Number.isFinite(opts.capital) && opts.capital > 0)) throw new Error('capital must be a positive number');
    let oid: ObjectId;
    try { oid = new ObjectId(id); } catch { throw new Error('Request not found'); }
    const now = new Date();
    const status = decision === 'approve' ? 'approved' : 'rejected';
    // Compare-and-set: only a PENDING request can be decided, exactly once (a double click or two admins cannot upgrade twice).
    const res: any = await requests().findOneAndUpdate(
        { _id: oid, status: 'pending' },
        { $set: { status, decidedAt: now, decidedBy: adminEmail, ...(opts.note ? { note: opts.note } : {}), ...(decision === 'approve' && opts.capital ? { capital: opts.capital } : {}) } },
        { returnDocument: 'after' }
    );
    const request = res?.value;
    if (!request) {
        const existing = await requests().findOne({ _id: oid });
        throw new Error(existing ? `Request already decided (${existing.status})` : 'Request not found');
    }
    if (decision === 'reject') return { request };
    try {
        const user = await applyAdvanced(request.user, { via: 'admin', capital: opts.capital, acceptance: request.acceptance && { acceptedAt: request.acceptance.acceptedAt, termsSha256: request.acceptance.termsSha256 } });
        return { user, request };
    } catch (e) {
        // The upgrade itself failed: put the request back so the admin can retry instead of losing it.
        await requests().updateOne({ _id: oid }, { $set: { status: 'pending' }, $unset: { decidedAt: '', decidedBy: '', note: '', capital: '' } });
        throw e;
    }
}

/**
 * What saving a GSTIN on the company profile does to the level: 'upgrade' only when the user does it themself, is a Beginner on a company account,
 * gives a non-blank GSTIN and has accepted the Advanced terms (which include the invoice obligation); 'reject' (with a message) when they would
 * qualify but have not accepted or the account is closed; otherwise 'none' (an admin's edit, an Advanced user, a blank GSTIN never change the level).
 */
export function gstinUpgradeDecision(a: { callerEmail?: string | null; email: string; user: { proficiencyLevel?: unknown; entityType?: string; accountClosed?: boolean }; gstin: unknown; accepted: unknown }): { action: 'none' | 'upgrade' | 'reject'; reason?: string } {
    const giving = typeof a.gstin === 'string' && a.gstin.trim() !== '';
    if (!giving || a.callerEmail !== a.email || a.user.entityType !== 'company' || normalizeLevel(a.user.proficiencyLevel) === 'advanced') return { action: 'none' };
    const can = canRequestUpgrade(a.user);
    if (!can.ok) return { action: 'reject', reason: can.reason };
    if (a.accepted !== true) return { action: 'reject', reason: 'Accept the Advanced terms to give a GSTIN: it makes your account Advanced immediately and permanently, and an invoice is due for every payment' };
    return { action: 'upgrade' };
}
