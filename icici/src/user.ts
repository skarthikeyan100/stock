import Log from './util/Log';
import Mongo from './tools/mongo';
import { DEFAULT_PROFIT_SPLIT_PERCENT } from './constants';
import { USER_BROKERS_TEXT, isUserBroker, normalizeBrokerName } from './util/brokerName';

export interface User {
    email: string;
    name: string;
    picture: string;
    lossLimit: number;
    // Vocabulary migration (REFACTOR_PLAN.md section 3): the canonical names are lotLimit / accountCapital / strategyCapital. The old
    // names (lotCount / investmentAmount / allottedCapital) are the stored fields older builds read, so for now BOTH are written and
    // either is accepted on read (withCanonicalFields); the old ones are dropped in a later release once nothing reads them.
    lotLimit: number;
    /** @deprecated use lotLimit */
    lotCount: number;
    investmentMode: 'lotCount' | 'investmentAmount';
    accountCapital: number;
    /** @deprecated use accountCapital */
    investmentAmount: number;
    useGTT: boolean;
    broker?: 'kite' | 'ant' | 'breeze';
    role: string;
    enabled: boolean;
    // Set when the user's realized loss in a trading week breached the weekly
    // drawdown limit (see bookkeeping.ts closeAccountForWeeklyBreach). The user
    // document is kept; the flag blocks new orders. Only an admin clears it.
    // Session cookies issued at or before this instant are rejected (set on logout, so a copied cookie stops working).
    sessionsValidAfter?: number;
    accountClosed?: boolean;
    accountClosedAt?: Date;
    accountClosedReason?: string;
    createdAt: Date;
    phone?: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    addressProofId?: string;
    dobProofId?: string;
    panCardId?: string;
    addressVerified: boolean;
    dobVerified: boolean;
    panVerified: boolean;
    // Per-order investment cap - distinct from investmentMode/investmentAmount,
    // an optional ceiling on any single order regardless of mode.
    perOrderCap?: number;
    // Per-user override of ContinuousStrategy's config.yml-level allottedCapital
    // (aggregate cap across all of that strategy's open legs) - unset means
    // "use the strategy's own config.yml value" (see ContinuousStrategy.capitalCheck).
    strategyCapital?: number;
    /** @deprecated use strategyCapital */
    allottedCapital?: number;
    // Per-user override of config.yml's global settings.targetPriceDiff/
    // stopLossPriceDiff, used by every Kite/ANT entry path
    // (buyIndexOnKite/On Ant, manualBuyOnKite/OnAnt, buyContractOnKite)
    // when the individual request doesn't specify explicit target/stopLoss
    // points. Resolution order is: request-level points > this per-user
    // override > the global config.yml default. Unset means "use the global
    // default" - see kiteExecutor.ts/antExecutor.ts.
    targetPoints?: number;
    stopLossPoints?: number;
    // KYC identity numbers - the *documents* above (panCardId etc.) only ever
    // stored an upload + verified flag; these are the actual numbers, new.
    // Never echoed back to the client raw - see toClientUser's masked fields.
    aadharNumber?: string;
    panNumber?: string;
    legalName?: string;
    aadharDocId?: string;
    aadharVerified: boolean;
    // Payments & payouts
    profitSplitPercent: number;
    bankAccountHolderName?: string;
    bankAccountNumber?: string; // full value stored; never echoed back raw
    bankIFSC?: string;
    upiId?: string;
    // Entity type & tax - see src/tax.ts for how these drive TDS/GST computation
    entityType: 'individual' | 'company';
    gstin?: string;
    gstDocId?: string;
    gstVerified: boolean;
    companyRegisteredName?: string;
}

// Fields that must never be echoed back to the browser in full once submitted -
// server accepts them on PATCH, but every GET/response path uses toClientUser
// below instead of returning the raw document. No field-level encryption exists
// in this stack; masking-on-read is the practical minimum given that constraint.
function maskLast4(value: string | undefined, groupSize = 4): string | undefined {
    if (!value) return undefined;
    const visible = value.slice(-4);
    const masked = value.slice(0, -4).replace(/./g, 'X');
    const combined = masked + visible;
    if (groupSize <= 0) return combined;
    return combined.match(new RegExp(`.{1,${groupSize}}`, 'g'))?.join('-') ?? combined;
}

export function toClientUser(user: User): Omit<User, 'aadharNumber' | 'panNumber' | 'bankAccountNumber'> & {
    aadharNumberMasked?: string;
    panNumberMasked?: string;
    bankAccountNumberMasked?: string;
} {
    const { aadharNumber: aadharRaw, panNumber: panRaw, bankAccountNumber: bankRaw, ...rest } = user;
    // Stored values are not guaranteed to be strings (older writes were unvalidated): never let a malformed one throw.
    const aadharNumber = aadharRaw == null ? undefined : String(aadharRaw);
    const panNumber = panRaw == null ? undefined : String(panRaw);
    const bankAccountNumber = bankRaw == null ? undefined : String(bankRaw);
    return {
        ...rest,
        aadharNumberMasked: maskLast4(aadharNumber),
        panNumberMasked: panNumber ? panNumber.slice(0, -4).replace(/./g, 'X') + panNumber.slice(-4) : undefined,
        bankAccountNumberMasked: bankAccountNumber ? '*'.repeat(Math.max(0, bankAccountNumber.length - 4)) + bankAccountNumber.slice(-4) : undefined,
    };
}

// Canonical <-> stored-name pairs of the vocabulary migration. Reading a document fills each name from the other; writing sets both.
const FIELD_PAIRS = [['lotLimit', 'lotCount'], ['accountCapital', 'investmentAmount'], ['strategyCapital', 'allottedCapital']] as const;

export function withCanonicalFields<T extends Record<string, any>>(doc: T): T {
    const out: Record<string, any> = { ...doc };
    for (const [canonical, legacy] of FIELD_PAIRS) {
        const value = out[canonical] ?? out[legacy];
        if (value !== undefined && value !== null) { out[canonical] = value; out[legacy] = value; }
    }
    return out as T;
}

// One-off at startup: documents written before the migration get the canonical fields stored too (idempotent).
export async function backfillVocabularyFields(): Promise<void> {
    try {
        for (const user of await collection().find({}).toArray()) {
            const set: Record<string, any> = {};
            for (const [canonical, legacy] of FIELD_PAIRS) {
                const value = user[canonical] ?? user[legacy];
                if (value !== undefined && value !== null) {
                    if (user[canonical] !== value) set[canonical] = value;
                    if (user[legacy] !== value) set[legacy] = value;
                }
            }
            if (Object.keys(set).length > 0) await collection().updateOne({ _id: user._id }, { $set: set });
        }
    } catch (e) {
        Log.log('[User] vocabulary backfill failed (readers still accept both names):', e);
    }
}

// Runtime context passed through the order placement chain.
// Combines identity (email) with per-user trading config and current available capital.
export interface UserContext {
    email: string;
    lossLimit: number;
    lotLimit: number;
    investmentMode: 'lotCount' | 'investmentAmount';
    accountCapital: number;
    availableAmount: number; // accountCapital - currently deployed capital
}

// Admin emails - can be configured via environment variable or default list
const ADMIN_EMAILS = process.env.ADMIN_EMAILS
    ? process.env.ADMIN_EMAILS.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    : ['skarthikeyan100@gmail.com'];

function isAdminEmail(email: string): boolean {
    return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

export function normalizeEmail(email: string): string {
    return String(email ?? '').trim().toLowerCase();
}

let userIndexEnsured = false;
async function ensureUserIndex(): Promise<void> {
    if (userIndexEnsured) return;
    try {
        await collection().createIndex({ email: 1 }, { unique: true });
        userIndexEnsured = true;
    } catch (e) {
        Log.log('[User] could not create unique email index (duplicate users already exist?) - continuing:', e);
    }
}

function collection() {
    return Mongo.getInstance().db.collection('users');
}

export async function getOrCreateUser(rawEmail: string, name: string, picture: string): Promise<User> {
    const col = collection();
    await ensureUserIndex();
    const normalized = normalizeEmail(rawEmail);
    // An account created before emails were lower-cased may be stored under its original spelling.
    const existing = await col.findOne({ email: { $in: [normalized, rawEmail] } });
    const email = existing?.email ?? normalized;
    if (existing) {
        const updates: Partial<User> & { lotSize?: number } = {};
        if (existing.name !== name || existing.picture !== picture) { updates.name = name; updates.picture = picture; }
        if ((existing.lotCount ?? existing.lotLimit) === undefined) updates.lotCount = existing.lotSize ?? 10;
        if (existing.investmentMode === undefined) updates.investmentMode = 'investmentAmount';
        if ((existing.investmentAmount ?? existing.accountCapital) === undefined) updates.investmentAmount = 100000;
        if (existing.useGTT === undefined) updates.useGTT = true;
        if (existing.aadharVerified === undefined) updates.aadharVerified = false;
        if (existing.profitSplitPercent === undefined) updates.profitSplitPercent = DEFAULT_PROFIT_SPLIT_PERCENT;
        if (existing.entityType === undefined) updates.entityType = 'individual';
        if (existing.gstVerified === undefined) updates.gstVerified = false;
        if (Object.keys(updates).length > 0) await col.updateOne({ email }, { $set: updates });
        return withCanonicalFields({
            ...existing,
            lotCount: updates.lotCount ?? existing.lotCount,
            investmentMode: updates.investmentMode ?? existing.investmentMode,
            investmentAmount: updates.investmentAmount ?? existing.investmentAmount,
            useGTT: updates.useGTT ?? existing.useGTT,
            name: updates.name ?? existing.name,
            picture: updates.picture ?? existing.picture,
            aadharVerified: updates.aadharVerified ?? existing.aadharVerified,
            profitSplitPercent: updates.profitSplitPercent ?? existing.profitSplitPercent,
            entityType: updates.entityType ?? existing.entityType,
            gstVerified: updates.gstVerified ?? existing.gstVerified,
        } as User);
    }
    // Auto-assign admin role for configured admin emails
    const role = isAdminEmail(email) ? 'admin' : 'user';
    const user: User = {
        email,
        name,
        picture,
        lossLimit: 15000,
        lotLimit: 10,
        lotCount: 10,
        investmentMode: 'investmentAmount',
        accountCapital: 100000,
        investmentAmount: 100000,
        useGTT: true,
        role,
        createdAt: new Date(),
        enabled: true,
        emailVerified: false,
        phoneVerified: false,
        addressVerified: false,
        dobVerified: false,
        panVerified: false,
        aadharVerified: false,
        profitSplitPercent: DEFAULT_PROFIT_SPLIT_PERCENT,
        entityType: 'individual',
        gstVerified: false,
    };
    // Upsert-on-insert so two simultaneous first logins cannot create two users.
    await col.updateOne({ email }, { $setOnInsert: user }, { upsert: true });
    Log.log(`[User] Created new user: ${email} with role: ${role}`);
    return withCanonicalFields((await col.findOne({ email })) as unknown as User);
}

export async function getUser(email: string): Promise<User | null> {
    const doc = await collection().findOne({ email });
    return doc ? withCanonicalFields(doc as unknown as User) : null;
}

export async function getAllUsers(): Promise<User[]> {
    const docs = await collection().find({}).toArray();
    return docs.map((d) => withCanonicalFields(d as unknown as User));
}

export async function updateUserSettings(email: string, settings: { lossLimit?: number; lotLimit?: number; lotCount?: number; investmentMode?: string; accountCapital?: number; investmentAmount?: number; useGTT?: boolean; broker?: 'kite' | 'ant' | 'breeze'; enabled?: boolean; perOrderCap?: number | null; strategyCapital?: number | null; allottedCapital?: number | null; targetPoints?: number | null; stopLossPoints?: number | null; profitSplitPercent?: number }): Promise<User | null> {
    const update: any = {};
    if (settings.lossLimit !== undefined) update.lossLimit = settings.lossLimit;
    const lotLimit = settings.lotLimit ?? settings.lotCount;
    if (lotLimit !== undefined) { update.lotLimit = lotLimit; update.lotCount = lotLimit; }
    if (settings.investmentMode !== undefined) update.investmentMode = settings.investmentMode;
    const accountCapital = settings.accountCapital ?? settings.investmentAmount;
    if (accountCapital !== undefined) { update.accountCapital = accountCapital; update.investmentAmount = accountCapital; }
    if (settings.useGTT !== undefined) update.useGTT = settings.useGTT;
    if (settings.broker !== undefined) {
        const broker = normalizeBrokerName(settings.broker);
        if (!isUserBroker(broker)) throw new Error(`Invalid broker '${settings.broker}' (expected ${USER_BROKERS_TEXT})`);
        update.broker = broker;
    }
    if (settings.enabled !== undefined) update.enabled = settings.enabled;
    // null = clear a per-user override (falls back to the global/strategy default); undefined = leave as is.
    const unset: any = {};
    for (const key of ['perOrderCap', 'targetPoints', 'stopLossPoints'] as const) {
        const v = (settings as any)[key];
        if (v === null) unset[key] = '';
        else if (v !== undefined) update[key] = v;
    }
    const strategyCapital = settings.strategyCapital !== undefined ? settings.strategyCapital : settings.allottedCapital;
    if (strategyCapital === null) { unset.strategyCapital = ''; unset.allottedCapital = ''; }
    else if (strategyCapital !== undefined) { update.strategyCapital = strategyCapital; update.allottedCapital = strategyCapital; }
    if (settings.profitSplitPercent !== undefined) update.profitSplitPercent = settings.profitSplitPercent;
    const ops: any = {};
    if (Object.keys(update).length > 0) ops.$set = update;
    if (Object.keys(unset).length > 0) ops.$unset = unset;
    if (Object.keys(ops).length > 0) await collection().updateOne({ email }, ops);
    return getUser(email);
}

// Flags the account closed without removing the user. Idempotent: an already
// closed account keeps its original closedAt/reason.
export async function revokeSessions(email: string): Promise<void> {
    await collection().updateOne({ email }, { $set: { sessionsValidAfter: Date.now() } });
}

export async function closeUserAccount(email: string, reason: string): Promise<void> {
    await collection().updateOne(
        { email, accountClosed: { $ne: true } },
        { $set: { accountClosed: true, accountClosedAt: new Date(), accountClosedReason: reason } }
    );
}

const AADHAR_PATTERN = /^\d{12}$/;
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// Validates before writing, mirroring where role validation already lives
// (updateUserRole below). aadharNumber/panNumber are never echoed back raw -
// see toClientUser.
export async function updateSensitiveField(email: string, field: 'aadharNumber' | 'panNumber', value: string): Promise<User | null> {
    if (typeof value !== 'string') throw new Error(`${field} must be a string`);
    value = value.trim();
    if (field === 'aadharNumber' && !AADHAR_PATTERN.test(value)) {
        throw new Error('Aadhar number must be exactly 12 digits');
    }
    if (field === 'panNumber' && !PAN_PATTERN.test(value)) {
        throw new Error('PAN number must match the format AAAAA9999A');
    }
    // A changed number is no longer the one an admin verified.
    const set: any = { [field]: value };
    const prev: any = await collection().findOne({ email });
    if (prev && prev[field] !== value) set[field === 'aadharNumber' ? 'aadharVerified' : 'panVerified'] = false;
    await collection().updateOne({ email }, { $set: set });
    return getUser(email);
}

function cleanString(name: string, v: unknown, max: number, pattern?: RegExp, upper = false): string {
    if (typeof v !== 'string') throw new Error(`${name} must be a string`);
    let out = v.trim();
    if (upper) out = out.toUpperCase();
    if (out.length > max) throw new Error(`${name} is too long (max ${max})`);
    if (pattern && out !== '' && !pattern.test(out)) throw new Error(`${name} has an invalid format`);
    return out;
}

export async function updateProfileFields(email: string, f: { phone?: unknown; legalName?: unknown }): Promise<User | null> {
    const user = await getUser(email);
    if (!user) return null;
    const update: any = {};
    if (f.phone !== undefined) {
        update.phone = cleanString('phone', f.phone, 20, /^[0-9+\-\s()]{6,20}$/);
        if (update.phone !== user.phone) update.phoneVerified = false;
    }
    if (f.legalName !== undefined) update.legalName = cleanString('legalName', f.legalName, 100);
    if (Object.keys(update).length > 0) await collection().updateOne({ email }, { $set: update });
    return getUser(email);
}

export async function updateBankDetails(email: string, details: { bankAccountHolderName?: string; bankAccountNumber?: string; bankIFSC?: string; upiId?: string }): Promise<User | null> {
    const update: any = {};
    if (details.bankAccountHolderName !== undefined) update.bankAccountHolderName = cleanString('bankAccountHolderName', details.bankAccountHolderName, 100);
    if (details.bankAccountNumber !== undefined) update.bankAccountNumber = cleanString('bankAccountNumber', details.bankAccountNumber, 20, /^\d{6,20}$/);
    if (details.bankIFSC !== undefined) update.bankIFSC = cleanString('bankIFSC', details.bankIFSC, 11, /^[A-Z]{4}0[A-Z0-9]{6}$/, true);
    if (details.upiId !== undefined) update.upiId = cleanString('upiId', details.upiId, 100, /^[\w.\-]{2,}@[\w.\-]{2,}$/);
    if (Object.keys(update).length === 0) return getUser(email);
    await collection().updateOne({ email }, { $set: update });
    return getUser(email);
}

// Entity type shouldn't flip after money has moved - locked once the user has
// a 'paid' payouts record, matching real prop-firm practice without needing a
// full approval workflow. Checked server-side; client-side disabling alone
// isn't sufficient.
export async function updateEntityType(email: string, entityType: 'individual' | 'company'): Promise<User | null> {
    const paidPayout = await Mongo.getInstance().db.collection('payouts').findOne({ user: email, status: 'paid' });
    if (paidPayout) {
        throw new Error('Entity type is locked after your first paid payout - contact an admin to change it');
    }
    await collection().updateOne({ email }, { $set: { entityType } });
    return getUser(email);
}

export async function updateCompanyProfile(email: string, profile: { gstin?: string; companyRegisteredName?: string }): Promise<User | null> {
    const user = await getUser(email);
    if (!user) return null;
    if (user.entityType !== 'company') {
        throw new Error('Company profile fields only apply to company accounts');
    }
    const update: any = {};
    if (profile.gstin !== undefined) {
        update.gstin = cleanString('gstin', profile.gstin, 15, /^[0-9A-Z]{15}$/, true);
        // GST status drives zero-TDS tax treatment: a changed GSTIN must be re-verified.
        if (update.gstin !== user.gstin) update.gstVerified = false;
    }
    if (profile.companyRegisteredName !== undefined) update.companyRegisteredName = cleanString('companyRegisteredName', profile.companyRegisteredName, 150);
    await collection().updateOne({ email }, { $set: update });
    return getUser(email);
}

export async function createUser(email: string, name: string, lossLimit: number, lotCount: number, role: string, investmentMode: 'lotCount' | 'investmentAmount' = 'investmentAmount', investmentAmount: number = 100000, useGTT: boolean = true): Promise<User> {
    if (role !== 'admin' && role !== 'user') throw new Error('Invalid role. Must be "admin" or "user"');
    email = normalizeEmail(email);
    name = String(name ?? '').trim();
    if (!email || !name) throw new Error('Email and name are required');
    await ensureUserIndex();
    const existing = await getUser(email);
    if (existing) {
        throw new Error('User already exists');
    }
    const user: User = {
        email,
        name,
        picture: '',
        lossLimit,
        lotLimit: lotCount,
        lotCount,
        investmentMode,
        accountCapital: investmentAmount,
        investmentAmount,
        useGTT,
        role,
        enabled: true,
        createdAt: new Date(),
        emailVerified: false,
        phoneVerified: false,
        addressVerified: false,
        dobVerified: false,
        panVerified: false,
        aadharVerified: false,
        profitSplitPercent: DEFAULT_PROFIT_SPLIT_PERCENT,
        entityType: 'individual',
        gstVerified: false,
    };
    try {
        await collection().insertOne(user);
    } catch (e: any) {
        if (e?.code === 11000) throw new Error('User already exists');
        throw e;
    }
    return user;
}

export async function deleteUser(email: string): Promise<boolean> {
    const result = await collection().deleteOne({ email });
    return result.deletedCount > 0;
}

export async function updateUserRole(email: string, role: string): Promise<User | null> {
    if (role !== 'admin' && role !== 'user') {
        throw new Error('Invalid role. Must be "admin" or "user"');
    }
    await collection().updateOne({ email }, { $set: { role } });
    return getUser(email);
}
