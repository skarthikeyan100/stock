import { getUser } from '../user';
import { normalizeLevel } from '../levelRules';
import { successfulWeeksFor } from '../successfulWeeks';
import Mongo from '../tools/mongo';
import { asyncRouter } from './asyncRouter';
import { resolveUser, requireAuth, requireAdmin, requireCsrfHeader, invalidateUserCache, pushUserToOrderProcess } from './session';
import { createUpgradeRequest, listUpgradeRequests, decideUpgradeRequest } from '../levelUpgrade';
import myEmitter from '../tools/emitter';
import Log from '../util/Log';

const router = asyncRouter();

// ============================== Beginner / Advanced levels ==============================
// Upgrade requests, capital requests and the invoice rule are added below as their modules land; every number comes from config.yml settings.levelRules.

async function hasPending(collection: string, email: string): Promise<boolean> {
    return !!(await Mongo.getInstance().db.collection(collection).findOne({ user: email, status: 'pending' }));
}

// The caller's own level, their progress towards the capital-increase rule and whether a request of theirs is waiting.
router.get('/user/level-status', requireAuth, async function (req, res) {
    const email = resolveUser(req) ?? '';
    const user = await getUser(email);
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    const weeks = await successfulWeeksFor(email);
    res.json({
        level: normalizeLevel(user.proficiencyLevel),
        advancedSince: user.advancedSince ?? null,
        successfulWeeks: weeks.count,
        requiredWeeks: weeks.required,
        pendingUpgradeRequest: await hasPending('upgradeRequests', email),
        pendingCapitalRequest: await hasPending('capitalRequests', email),
        accountClosed: user.accountClosed === true,
    });
});

// Tells the user (bell + notifications list) what happened to a request of theirs.
export async function notifyLevelUser(user: string, message: string): Promise<void> {
    const notification = { user, type: 'level_status' as const, message, read: false, createdAt: new Date() };
    await Mongo.getInstance().db.collection('notifications').insertOne(notification);
    myEmitter.emit('notification', { user, notification });
}

// A Beginner asks to become Advanced (after accepting the Advanced terms); an admin decides.
router.post('/user/upgrade-request', requireAuth, requireCsrfHeader, async function (req, res) {
    if (req.body?.acceptTerms !== true) { res.status(400).json({ error: 'Accept the Advanced terms to continue' }); return; }
    try {
        res.json(await createUpgradeRequest(resolveUser(req) ?? ''));
    } catch (e: any) {
        res.status(400).json({ error: e?.message ?? 'Could not create the request' });
    }
});

router.get('/admin/upgrade-requests', requireAdmin, async function (req, res) {
    const status = req.query.status;
    if (status !== undefined && status !== 'pending' && status !== 'approved' && status !== 'rejected') { res.status(400).json({ error: 'status must be pending, approved or rejected' }); return; }
    res.json(await listUpgradeRequests(status as any));
});

router.post('/admin/upgrade-requests/:id/decision', requireAdmin, async function (req, res) {
    const { decision, capital, note } = req.body ?? {};
    if (decision !== 'approve' && decision !== 'reject') { res.status(400).json({ error: "decision must be 'approve' or 'reject'" }); return; }
    if (note !== undefined && typeof note !== 'string') { res.status(400).json({ error: 'note must be a string' }); return; }
    try {
        const out = await decideUpgradeRequest(req.params.id, decision, resolveUser(req) ?? '', { capital, note });
        if (decision === 'approve' && out.user) {
            invalidateUserCache(out.user.email);
            await pushUserToOrderProcess(out.user, 'upgrade');
            notifyLevelUser(out.user.email, 'Your Advanced upgrade was approved: Search & Buy and your new limits are active').catch((e) => Log.log('[levels] notify failed', e));
        } else if (decision === 'reject') {
            notifyLevelUser(out.request.user, `Your Advanced upgrade request was not approved${note ? `: ${note}` : ''}`).catch((e) => Log.log('[levels] notify failed', e));
        }
        res.json({ request: out.request });
    } catch (e: any) {
        const msg = e?.message ?? 'Could not decide the request';
        res.status(/already decided/.test(msg) ? 409 : 400).json({ error: msg });
    }
});

export default router;
