import { getUser } from '../user';
import { normalizeLevel } from '../levelRules';
import { successfulWeeksFor } from '../successfulWeeks';
import Mongo from '../tools/mongo';
import { asyncRouter } from './asyncRouter';
import { resolveUser, requireAuth } from './session';

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

export default router;
