import { sendWelcomeEmails } from '../welcomeEmail';
import Log from '../util/Log';
import { revokeSessions, getOrCreateUser, getUser, toClientUser } from '../user';
import { OAuth2Client } from 'google-auth-library';
import { asyncRouter } from './asyncRouter';
import { pushUserToOrderProcess, sessionCookieValue, parseSession, parseActAs, actAsCookieValue, authenticateRealAdmin, getActiveUser, sessionRevoked, invalidateUserCache, SESSION_MAX_AGE_MS, ACTAS_MAX_AGE_MS } from './session';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID; // presence is enforced at start-up (server.ts)
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const router = asyncRouter();

// ============================== Auth ==============================

router.post('/auth/login', async function (req, res) {
    try {
        const { credential } = req.body;
        if (!credential) {
            res.status(400).json({ error: 'credential (Google ID token) is required' });
            return;
        }
        let payload: { email?: string; email_verified?: boolean; name?: string; picture?: string };
        try {
            const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
            payload = ticket.getPayload() ?? {};
        } catch (e) {
            Log.log('Google ID token verification failed:', e);
            res.status(401).json({ error: 'Invalid credential' });
            return;
        }
        const { email, name, picture } = payload;
        if (!email) {
            res.status(400).json({ error: 'Verified token had no email' });
            return;
        }
        // An unverified Google address can be set to anything the account holder likes (including an ADMIN_EMAILS entry).
        if (payload.email_verified !== true) {
            res.status(401).json({ error: 'Google account email is not verified' });
            return;
        }
        const user = await getOrCreateUser(email, name as string, picture as string);
        if (user.enabled === false) {
            res.status(403).json({ error: 'Account disabled' });
            return;
        }
        invalidateUserCache(user.email);
        await pushUserToOrderProcess(user, 'login');
        // First login sends the welcome email (idempotent: the storage/<user> folder marks it sent; test-recipient gate applies). Never blocks the login.
        if (user.role !== 'admin') sendWelcomeEmails([user.email]).catch((e) => Log.log('[welcome] email on login failed:', e?.message ?? e));
        res.cookie('session', sessionCookieValue(user.email), { signed: true, httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.clearCookie('actas'); // a new login never inherits an old acting-as
        res.json(toClientUser(user));
    } catch (e) {
        Log.log('Login error:', e);
        res.sendStatus(500);
    }
});

router.get('/auth/me', async function (req, res) {
    const session = parseSession(req);
    const email = session?.email;
    if (!session || !email) {
        res.status(401).json({ error: 'Not logged in' });
        return;
    }
    const user = await getUser(email);
    if (!user || sessionRevoked(req, user)) {
        res.status(401).json({ error: 'Unknown user' });
        return;
    }
    // Re-issue a legacy (timestamp-less) cookie so it picks up server-side expiry and revocation.
    if (session.legacy) res.cookie('session', sessionCookieValue(user.email), { signed: true, httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_MAX_AGE_MS });
    if (user.enabled === false) {
        res.status(403).json({ error: 'Account disabled' });
        return;
    }
    // A resumed session (cookie only, no fresh POST /auth/login) would
    // otherwise never re-sync this user's settings into the order process's
    // in-memory cache after a restart - refresh it here too, on every session
    // check, so a stale/empty cache entry doesn't silently fall back to
    // hardcoded defaults (e.g. investmentAmount=0) for manual order sizing.
    // Admin acting as another user: answer with the target (so the whole UI is theirs) plus who is really behind it. An acting-as cookie
    // that no longer holds (target gone/disabled/now an admin, or this user is no longer an admin) is dropped and the admin is themself again.
    const act = parseActAs(req);
    if (act) {
        const target = user.role === 'admin' ? await getActiveUser(act.target) : null;
        if (target && target.enabled !== false && target.role !== 'admin') {
            await pushUserToOrderProcess(target, 'session check (acting as)');
            res.json({ ...toClientUser(target), actingAs: { admin: user.email, adminName: user.name } });
            return;
        }
        res.clearCookie('actas');
    }
    await pushUserToOrderProcess(user, 'session check');
    res.json(toClientUser(user));
});

// Admin "use as another user". Authorised by the REAL session (never the effective identity, which is the target while acting).
router.post('/admin/act-as', async function (req, res) {
    const auth = await authenticateRealAdmin(req);
    if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    if (!email) { res.status(400).json({ error: 'email is required' }); return; }
    if (email === auth.admin) { res.status(400).json({ error: 'You cannot act as yourself' }); return; }
    const target = await getUser(email);
    if (!target) { res.status(404).json({ error: 'User not found' }); return; }
    if (target.role === 'admin') { res.status(400).json({ error: 'You cannot act as another admin' }); return; }
    if (target.enabled === false) { res.status(400).json({ error: 'That account is disabled' }); return; }
    res.cookie('actas', actAsCookieValue(target.email, auth.admin), { signed: true, httpOnly: true, secure: true, sameSite: 'lax', maxAge: ACTAS_MAX_AGE_MS });
    res.json({ ok: true, target: target.email });
});

router.post('/act-as/stop', async function (req, res) {
    const auth = await authenticateRealAdmin(req);
    if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }
    res.clearCookie('actas');
    res.json({ ok: true });
});

router.post('/auth/logout', async function (req, res) {
    // Revokes the user's sessions server-side too (not just this browser's copy), so a leaked or copied cookie stops working.
    // The REAL session identity: while an admin is acting as a trader, logging out must never revoke the trader's sessions.
    const email = parseSession(req)?.email;
    if (email) {
        try {
            await revokeSessions(email);
            invalidateUserCache(email);
        } catch (e) {
            // Surfaced, and the cookie is NOT cleared: reporting success would leave a copied cookie valid for up to 30 days.
            Log.log('[frontend] session revoke on logout failed:', e);
            res.status(500).json({ error: 'Logout could not be completed - try again' });
            return;
        }
    }
    res.clearCookie('session');
    res.clearCookie('actas');
    res.sendStatus(200);
});


export default router;
