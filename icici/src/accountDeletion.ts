/**
 * Erases a user (DPDP Act: personal data is removed on request). The user row, the uploaded KYC/GST documents, bank and UPI details, notifications,
 * email records and the stored PDFs under ./storage/<user>/ are deleted. Trade, order and payout records are KEPT but detached from the person:
 * the email on them is replaced by a random pseudonym (`deleted-<12 hex>`, not derivable from the email), so nothing links them to the user,
 * and the same email can sign up again as a brand-new user with a clean history.
 * Order of work: refuse -> documents -> pseudonymise records -> delete personal-only records -> delete the user row LAST, so a crash midway leaves
 * the user row in place and the erase can simply be run again (every step is idempotent: renames match nothing the second time).
 */
import * as crypto from 'crypto';
import { GridFSBucket, ObjectId } from 'mongodb';
import Mongo from './tools/mongo';
import Log from './util/Log';
import { getUser, deleteUser } from './user';
import { removeUserStorage } from './mailStorage';

// Collections whose rows are kept, with the field that holds the user's email.
const KEEP_AND_PSEUDONYMISE: Array<[collection: string, field: string]> = [
    ['Trade', 'user'], ['closedTrades', 'user'], ['orderOwners', 'user'], ['payouts', 'user'], ['payoutDecisionLog', 'user'],
    ['pendingPrismLimitOrders', 'userId'], ['pendingLimitOrders', 'userId'], ['pendingAntLimitOrders', 'userId'], ['pendingBreezeLimitOrders', 'userId'],
];
// Collections whose rows exist only for this person: deleted.
const DELETE_ROWS: Array<[collection: string, field: string]> = [
    ['notifications', 'user'], ['eodEmails', 'user'], ['welcomeEmails', 'user'], ['mirrorLegs', 'userId'],
];

export type EraseResult = { ok: true; pseudonym: string; renamed: Record<string, number>; deleted: Record<string, number>; storageRemoved: boolean }
    | { ok: false; status: number; error: string };

/**
 * Erasure log (Mongo `erasureLog`, one row per request, never deleted). It holds NO personal data: the pseudonym the kept records now sit under,
 * an HMAC of the email (keyed with SESSION_COOKIE_SECRET: lets us show "this email was erased on <date>" if asked, cannot be reversed to the
 * email), who requested it (self, or the admin's email: admins are never erased), what was done per collection, and the outcome.
 */
export type ErasureRequester = { by: 'self' } | { by: 'admin'; admin: string };
const emailDigest = (email: string) => crypto.createHmac('sha256', process.env.SESSION_COOKIE_SECRET || 'erasure-log').update(email).digest('hex');

export async function eraseUser(emailIn: string, openPositionUsers: Set<string>, requester: ErasureRequester = { by: 'self' }): Promise<EraseResult> {
    const result = await eraseUserInner(emailIn, openPositionUsers, requester);
    return result;
}

async function eraseUserInner(emailIn: string, openPositionUsers: Set<string>, requester: ErasureRequester): Promise<EraseResult> {
    const email = String(emailIn ?? '').trim().toLowerCase();
    const db = Mongo.getInstance().db;
    const user = await getUser(email);
    if (!user) return { ok: false, status: 404, error: 'User not found' };
    if (user.role === 'admin') return { ok: false, status: 400, error: 'An admin account cannot be deleted here' };
    if (openPositionUsers.has(user.email)) return { ok: false, status: 409, error: 'You have open positions - square them off before deleting the account' };
    if (await db.collection('payouts').countDocuments({ user: user.email, status: 'pending' }) > 0) {
        return { ok: false, status: 409, error: 'There is a pending payment - it must be settled before the account can be deleted' };
    }

    const log = db.collection('erasureLog');
    const pseudonym = `deleted-${crypto.randomBytes(6).toString('hex')}`;
    const startedAt = new Date();
    const logId = (await log.insertOne({ pseudonym, emailHmac: emailDigest(user.email), requester, role: user.role, status: 'started', startedAt })).insertedId;
    try {
    const documentsDeleted: string[] = [];
    const bucket = new GridFSBucket(db, { bucketName: 'documents' });
    for (const f of ['addressProofId', 'dobProofId', 'panCardId', 'aadharDocId', 'gstDocId']) {
        const id = (user as any)[f];
        if (id && ObjectId.isValid(id)) { await bucket.delete(new ObjectId(id)).then(() => documentsDeleted.push(f)).catch(() => undefined); }
    }

    const renamed: Record<string, number> = {}, deleted: Record<string, number> = {};
    for (const [c, field] of KEEP_AND_PSEUDONYMISE) {
        const r = await db.collection(c).updateMany({ [field]: user.email }, { $set: { [field]: pseudonym } });
        if (r.modifiedCount) renamed[c] = r.modifiedCount;
    }
    // Payout rows stay as financial records, without the bank/UPI details copied into them.
    await db.collection('payouts').updateMany({ user: pseudonym }, { $unset: { bankSnapshot: '' } });
    for (const [c, field] of DELETE_ROWS) {
        const r = await db.collection(c).deleteMany({ [field]: user.email });
        if (r.deletedCount) deleted[c] = r.deletedCount;
    }
    const storageRemoved = removeUserStorage(user.email);
    await deleteUser(user.email);
    await log.updateOne({ _id: logId }, { $set: { status: 'completed', completedAt: new Date(), recordsPseudonymised: renamed, rowsDeleted: deleted, documentsDeleted, storageRemoved, userRowDeleted: true } });
    Log.log(`[account-deletion] erased a user: records now under ${pseudonym}, renamed=${JSON.stringify(renamed)}, deleted=${JSON.stringify(deleted)}`);
    return { ok: true, pseudonym, renamed, deleted, storageRemoved };
    } catch (e: any) {
        await log.updateOne({ _id: logId }, { $set: { status: 'failed', failedAt: new Date(), error: String(e?.message ?? e).slice(0, 300) } }).catch(() => undefined);
        throw e; // the user row is still there: the request can be repeated
    }
}
