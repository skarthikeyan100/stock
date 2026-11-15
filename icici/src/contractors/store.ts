/** Mongo access for contractors, invites and (append-only) agreement acceptances. */
import * as crypto from 'crypto';
import Log from '../util/Log';
import Mongo from '../tools/mongo';
import configService from '../prism/ConfigService';
import { CONTRACTOR_ROLE, Contractor, ContractorStatus, ContractorType, levelOf } from './types';

const db = () => Mongo.getInstance().db;
export const contractorsCol = () => db().collection('contractors');
export const invitesCol = () => db().collection('invites');
export const acceptancesCol = () => db().collection('agreementAcceptances');

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** forecast.maxActiveContractors from config.yml (default 5). */
export function maxActiveContractors(): number {
    const v = Number((configService.getConfig() as any)?.forecast?.maxActiveContractors);
    return Number.isInteger(v) && v > 0 ? v : 5;
}
/** forecast.sessionDays.individual / .business (defaults 365 / 90). */
export function sessionDaysFor(type: ContractorType): number {
    const cfg = (configService.getConfig() as any)?.forecast?.sessionDays ?? {};
    const v = Number(type === 'INDIVIDUAL' ? cfg.individual : cfg.business);
    return Number.isFinite(v) && v >= 1 && v <= 400 ? Math.floor(v) : (type === 'INDIVIDUAL' ? 365 : 90);
}

export interface InviteDoc {
    _id?: any; tokenHash: string; type: ContractorType; emailLock?: string; note?: string; createdBy: string; createdAt: Date; expiresAt: Date;
    targetContractorId?: string; // a re-invite of an existing contractor
    usedAt?: Date; contractorId?: string; revokedAt?: Date;
}

export async function createInvite(o: { type: ContractorType; emailLock?: string; note?: string; createdBy: string; targetContractorId?: string }, now = new Date()): Promise<{ invite: InviteDoc; token: string }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const invite: InviteDoc = { tokenHash: hashToken(token), type: o.type, emailLock: o.emailLock?.toLowerCase(), note: o.note, createdBy: o.createdBy, createdAt: now,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS), targetContractorId: o.targetContractorId };
    const r = await invitesCol().insertOne(invite);
    invite._id = r.insertedId;
    return { invite, token };
}

export type InviteState = 'ok' | 'used' | 'revoked' | 'expired' | 'unknown';
export function inviteState(i: InviteDoc | null, now = new Date()): InviteState {
    if (!i) return 'unknown';
    if (i.usedAt) return 'used';
    if (i.revokedAt) return 'revoked';
    if (i.expiresAt.getTime() <= now.getTime()) return 'expired';
    return 'ok';
}
export async function findInviteByToken(token: string): Promise<InviteDoc | null> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    return (await invitesCol().findOne({ tokenHash: hashToken(token) })) as InviteDoc | null;
}
/** Atomically marks an unused, unrevoked, unexpired invite as used; false when someone else got there first. */
export async function consumeInvite(id: any, contractorId: string, now = new Date()): Promise<boolean> {
    const r: any = await invitesCol().findOneAndUpdate({ _id: id, usedAt: { $exists: false }, revokedAt: { $exists: false } }, { $set: { usedAt: now, contractorId } }, { returnOriginal: true });
    const before = r?.value as InviteDoc | null;
    return !!before && before.expiresAt.getTime() > now.getTime();
}
/** Revokes every unused invite aimed at a contractor (a re-invite replaces the earlier ones). */
export async function revokeOpenInvitesFor(contractorId: string, now = new Date()): Promise<void> {
    const open = await invitesCol().find({ targetContractorId: contractorId, usedAt: { $exists: false }, revokedAt: { $exists: false } }).toArray();
    for (const i of open) await invitesCol().updateOne({ _id: i._id }, { $set: { revokedAt: now } });
}

export async function getContractor(id: string): Promise<Contractor | null> { return (await contractorsCol().findOne({ id })) as Contractor | null; }
export async function getContractorByEmail(email: string): Promise<Contractor | null> { return (await contractorsCol().findOne({ email: email.toLowerCase() })) as Contractor | null; }
export async function listContractors(): Promise<Contractor[]> { return (await contractorsCol().find({}).sort({ createdAt: -1 }).toArray()) as Contractor[]; }

/** Active contractors counted against the cap: the migrated test user is excluded. */
export async function activeCount(): Promise<number> {
    return (await contractorsCol().find({ status: 'ACTIVE' }).toArray()).filter((c: any) => !c.isTest).length;
}

export function newContractorId(): string { return crypto.randomBytes(6).toString('hex'); }

/** The `users` document behind a contractor, so sessions, notifications and payouts reuse the existing code. Defaults match user.ts getOrCreateUser. */
export async function ensureContractorUser(c: Contractor, profitSplitPercent: number): Promise<void> {
    const existing = await db().collection('users').findOne({ email: c.email });
    if (existing) {
        if (existing.role !== CONTRACTOR_ROLE) throw new Error(`user ${c.email} already exists with another role`);
        await db().collection('users').updateOne({ email: c.email }, { $set: { name: c.name, enabled: true } });
        return;
    }
    const level = levelOf(c.type);
    const user = {
        email: c.email, name: c.name, picture: '', lossLimit: 15000, lotLimit: 10, lotCount: 10, investmentMode: 'investmentAmount', accountCapital: 0, investmentAmount: 0,
        useGTT: true, role: CONTRACTOR_ROLE, createdAt: new Date(), enabled: true, emailVerified: true, phoneVerified: false, addressVerified: false, dobVerified: false,
        panVerified: false, aadharVerified: false, profitSplitPercent, entityType: c.type === 'INDIVIDUAL' ? 'individual' : 'company', gstVerified: false,
        proficiencyLevel: level,
        // The existing invoice rule (src/invoiceRule.ts) and payout code key on these for a GSTIN contractor.
        ...(c.type === 'BUSINESS' ? { advancedVia: 'gstin', advancedSince: new Date() } : {}),
        contractorId: c.id,
    };
    await db().collection('users').insertOne(user);
}

export async function setUserEnabled(email: string, enabled: boolean): Promise<void> {
    await db().collection('users').updateOne({ email }, { $set: { enabled } });
}
/** Every session cookie issued at or before now stops working (the contractor has to be re-invited). */
export async function revokeUserSessions(email: string): Promise<void> {
    await db().collection('users').updateOne({ email }, { $set: { sessionsValidAfter: Date.now() } });
}

export const STATUS_TRANSITIONS: Record<ContractorStatus, ContractorStatus[]> = {
    INVITED: ['ACTIVE', 'TERMINATED'],
    AGREEMENT_PENDING: ['ACTIVE', 'TERMINATED'],
    ACTIVE: ['PAUSED', 'PAUSED_INVOICE', 'AGREEMENT_PENDING', 'TERMINATED'],
    PAUSED: ['ACTIVE', 'TERMINATED'],
    PAUSED_INVOICE: ['ACTIVE', 'PAUSED', 'TERMINATED'],
    TERMINATED: [],
};

export function newContractor(o: { email: string; name: string; type: ContractorType; invitedBy: string; isTest?: boolean }): Contractor {
    const id = newContractorId();
    return { id, email: o.email.toLowerCase(), name: o.name, type: o.type, status: 'INVITED', isTest: o.isTest || undefined, createdAt: new Date(), invitedBy: o.invitedBy,
        pseudoUserId: '' }; // a strategy slot is assigned at activation (src/contractors/slots.ts)
}

/** Why a contractor may not submit a forecast / recommendation right now, or null when they may. Shared by the forecast and recommendation APIs. */
export function submissionBlock(c: Contractor | null, currentAgreementVersion: string): string | null {
    if (!c) return 'No contractor record';
    if (c.status === 'PAUSED_INVOICE') return 'Paused: an invoice is overdue. Upload it to continue.';
    if (c.status !== 'ACTIVE') return `Your account is ${c.status.toLowerCase().replace('_', ' ')}`;
    if (c.agreementVersion !== currentAgreementVersion) return `Please accept the current agreement (v${currentAgreementVersion}) first`;
    return null;
}

/** Append-only: acceptances are only ever inserted or read. */
export interface AcceptanceDoc { contractorId: string; email: string; agreementType: ContractorType; agreementVersion: string; fileSha256: string; acceptedAtUtc: string; acceptedAtIst: string; ip: string; userAgent: string; source?: 'owner-migration'; representation6A5?: boolean; dpdpConsent: boolean }
export async function recordAcceptance(a: AcceptanceDoc): Promise<void> {
    await acceptancesCol().insertOne({ ...a });
    Log.log(`[contractor] agreement v${a.agreementVersion} accepted by ${a.email} (${a.contractorId})`);
}
export async function listAcceptances(contractorId: string): Promise<AcceptanceDoc[]> {
    return (await acceptancesCol().find({ contractorId }).sort({ acceptedAtUtc: 1 }).toArray()) as AcceptanceDoc[];
}
