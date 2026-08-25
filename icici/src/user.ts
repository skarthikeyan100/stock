import Log from './util/Log';
import Mongo from './tools/mongo';
import { DEFAULT_PROFIT_SPLIT_PERCENT } from './constants';

export interface User {
    email: string;
    name: string;
    picture: string;
    lossLimit: number;
    lotCount: number;
    investmentMode: 'lotCount' | 'investmentAmount';
    investmentAmount: number;
    useGTT: boolean;
    role: string;
    enabled: boolean;
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
    const { aadharNumber, panNumber, bankAccountNumber, ...rest } = user;
    return {
        ...rest,
        aadharNumberMasked: maskLast4(aadharNumber),
        panNumberMasked: panNumber ? panNumber.slice(0, -4).replace(/./g, 'X') + panNumber.slice(-4) : undefined,
        bankAccountNumberMasked: bankAccountNumber ? '*'.repeat(Math.max(0, bankAccountNumber.length - 4)) + bankAccountNumber.slice(-4) : undefined,
    };
}

// Runtime context passed through the order placement chain.
// Combines identity (email) with per-user trading config and current available capital.
export interface UserContext {
    email: string;
    lossLimit: number;
    lotCount: number;
    investmentMode: 'lotCount' | 'investmentAmount';
    investmentAmount: number;
    availableAmount: number; // investmentAmount - currently deployed capital
}

// Admin emails - can be configured via environment variable or default list
const ADMIN_EMAILS = process.env.ADMIN_EMAILS
    ? process.env.ADMIN_EMAILS.split(',').map(e => e.trim())
    : ['skarthikeyan100@gmail.com'];

function isAdminEmail(email: string): boolean {
    return ADMIN_EMAILS.includes(email);
}

function collection() {
    return Mongo.getInstance().db.collection('users');
}

export async function getOrCreateUser(email: string, name: string, picture: string): Promise<User> {
    const col = collection();
    const existing = await col.findOne({ email });
    if (existing) {
        const updates: Partial<User> & { lotSize?: number } = {};
        if (existing.name !== name || existing.picture !== picture) { updates.name = name; updates.picture = picture; }
        if (existing.lotCount === undefined) updates.lotCount = existing.lotSize ?? 10;
        if (existing.investmentMode === undefined) updates.investmentMode = 'investmentAmount';
        if (existing.investmentAmount === undefined) updates.investmentAmount = 100000;
        if (existing.useGTT === undefined) updates.useGTT = true;
        if (existing.aadharVerified === undefined) updates.aadharVerified = false;
        if (existing.profitSplitPercent === undefined) updates.profitSplitPercent = DEFAULT_PROFIT_SPLIT_PERCENT;
        if (existing.entityType === undefined) updates.entityType = 'individual';
        if (existing.gstVerified === undefined) updates.gstVerified = false;
        if (Object.keys(updates).length > 0) await col.updateOne({ email }, { $set: updates });
        return {
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
        } as User;
    }
    // Auto-assign admin role for configured admin emails
    const role = isAdminEmail(email) ? 'admin' : 'user';
    const user: User = {
        email,
        name,
        picture,
        lossLimit: 15000,
        lotCount: 10,
        investmentMode: 'investmentAmount',
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
    await col.insertOne(user);
    Log.log(`[User] Created new user: ${email} with role: ${role}`);
    return user;
}

export async function getUser(email: string): Promise<User | null> {
    const doc = await collection().findOne({ email });
    return doc as User | null;
}

export async function getAllUsers(): Promise<User[]> {
    const docs = await collection().find({}).toArray();
    return docs as User[];
}

export async function updateUserSettings(email: string, settings: { lossLimit?: number; lotCount?: number; investmentMode?: string; investmentAmount?: number; useGTT?: boolean; enabled?: boolean; perOrderCap?: number; profitSplitPercent?: number }): Promise<User | null> {
    const update: any = {};
    if (settings.lossLimit !== undefined) update.lossLimit = settings.lossLimit;
    if (settings.lotCount !== undefined) update.lotCount = settings.lotCount;
    if (settings.investmentMode !== undefined) update.investmentMode = settings.investmentMode;
    if (settings.investmentAmount !== undefined) update.investmentAmount = settings.investmentAmount;
    if (settings.useGTT !== undefined) update.useGTT = settings.useGTT;
    if (settings.enabled !== undefined) update.enabled = settings.enabled;
    if (settings.perOrderCap !== undefined) update.perOrderCap = settings.perOrderCap;
    if (settings.profitSplitPercent !== undefined) update.profitSplitPercent = settings.profitSplitPercent;
    await collection().updateOne({ email }, { $set: update });
    return getUser(email);
}

const AADHAR_PATTERN = /^\d{12}$/;
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// Validates before writing, mirroring where role validation already lives
// (updateUserRole below). aadharNumber/panNumber are never echoed back raw -
// see toClientUser.
export async function updateSensitiveField(email: string, field: 'aadharNumber' | 'panNumber', value: string): Promise<User | null> {
    if (field === 'aadharNumber' && !AADHAR_PATTERN.test(value)) {
        throw new Error('Aadhar number must be exactly 12 digits');
    }
    if (field === 'panNumber' && !PAN_PATTERN.test(value)) {
        throw new Error('PAN number must match the format AAAAA9999A');
    }
    await collection().updateOne({ email }, { $set: { [field]: value } });
    return getUser(email);
}

export async function updateBankDetails(email: string, details: { bankAccountHolderName?: string; bankAccountNumber?: string; bankIFSC?: string; upiId?: string }): Promise<User | null> {
    const update: any = {};
    if (details.bankAccountHolderName !== undefined) update.bankAccountHolderName = details.bankAccountHolderName;
    if (details.bankAccountNumber !== undefined) update.bankAccountNumber = details.bankAccountNumber;
    if (details.bankIFSC !== undefined) update.bankIFSC = details.bankIFSC;
    if (details.upiId !== undefined) update.upiId = details.upiId;
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
    if (profile.gstin !== undefined) update.gstin = profile.gstin;
    if (profile.companyRegisteredName !== undefined) update.companyRegisteredName = profile.companyRegisteredName;
    await collection().updateOne({ email }, { $set: update });
    return getUser(email);
}

export async function createUser(email: string, name: string, lossLimit: number, lotCount: number, role: string, investmentMode: 'lotCount' | 'investmentAmount' = 'investmentAmount', investmentAmount: number = 100000, useGTT: boolean = true): Promise<User> {
    const existing = await getUser(email);
    if (existing) {
        throw new Error('User already exists');
    }
    const user: User = {
        email,
        name,
        picture: '',
        lossLimit,
        lotCount,
        investmentMode,
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
    await collection().insertOne(user);
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
