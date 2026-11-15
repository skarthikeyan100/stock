/** In-app notifications for the owner (admin users) and contractors, in the existing `notifications` collection (delivered by /notificationstream). */
import Mongo from '../tools/mongo';
import Log from '../util/Log';

export async function notifyUser(user: string, type: string, message: string, extra: Record<string, unknown> = {}): Promise<void> {
    try { await Mongo.getInstance().db.collection('notifications').insertOne({ user, type, message, read: false, createdAt: new Date(), ...extra }); }
    catch (e) { Log.log('[contractor] notification failed:', e); }
}
export async function notifyAdmins(type: string, message: string, extra: Record<string, unknown> = {}): Promise<void> {
    const admins = await Mongo.getInstance().db.collection('users').find({ role: 'admin', enabled: { $ne: false } }).toArray();
    for (const a of admins) await notifyUser(a.email, type, message, extra);
}
