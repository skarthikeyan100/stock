import Log from '../util/Log';
import { revokeSessions, getOrCreateUser, getUser, toClientUser } from '../user';
import { OAuth2Client } from 'google-auth-library';
import { asyncRouter } from './asyncRouter';
import { pushUserToOrderProcess, sessionCookieValue, parseSession, resolveUser, sessionRevoked, invalidateUserCache, SESSION_MAX_AGE_MS } from './session';
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
        res.cookie('session', sessionCookieValue(user.email), { signed: true, httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
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
    await pushUserToOrderProcess(user, 'session check');
    res.json(toClientUser(user));
});

router.post('/auth/logout', async function (req, res) {
    // Revokes the user's sessions server-side too (not just this browser's copy), so a leaked or copied cookie stops working.
    const email = resolveUser(req);
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
    res.sendStatus(200);
});


export default router;
