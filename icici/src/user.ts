import Log from './util/Log';
import Mongo from './tools/mongo';

export interface User {
    email: string;
    name: string;
    picture: string;
    lossLimit: number;
    lotCount: number;
    investmentMode: 'lotCount' | 'investmentAmount';
    investmentAmount: number;
    role: string;
    enabled: boolean;
    createdAt: Date;
    phone?: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    addressProofId?: string;
    dobProofId?: string;
    panCardId?: string;
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
        if (Object.keys(updates).length > 0) await col.updateOne({ email }, { $set: updates });
        return {
            ...existing,
            lotCount: updates.lotCount ?? existing.lotCount,
            investmentMode: updates.investmentMode ?? existing.investmentMode,
            investmentAmount: updates.investmentAmount ?? existing.investmentAmount,
            name: updates.name ?? existing.name,
            picture: updates.picture ?? existing.picture,
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
        role,
        createdAt: new Date(),
        enabled: true,
        emailVerified: false,
        phoneVerified: false,
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

export async function updateUserSettings(email: string, settings: { lossLimit?: number; lotCount?: number; investmentMode?: string; investmentAmount?: number; enabled?: boolean }): Promise<User | null> {
    const update: any = {};
    if (settings.lossLimit !== undefined) update.lossLimit = settings.lossLimit;
    if (settings.lotCount !== undefined) update.lotCount = settings.lotCount;
    if (settings.investmentMode !== undefined) update.investmentMode = settings.investmentMode;
    if (settings.investmentAmount !== undefined) update.investmentAmount = settings.investmentAmount;
    if (settings.enabled !== undefined) update.enabled = settings.enabled;
    await collection().updateOne({ email }, { $set: update });
    return getUser(email);
}

export async function createUser(email: string, name: string, lossLimit: number, lotCount: number, role: string, investmentMode: 'lotCount' | 'investmentAmount' = 'investmentAmount', investmentAmount: number = 100000): Promise<User> {
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
        role,
        enabled: true,
        createdAt: new Date(),
        emailVerified: false,
        phoneVerified: false,
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
