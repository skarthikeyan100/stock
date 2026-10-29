import Log from '../util/Log';
import express from 'express';
import { getUser } from '../user';
import OrderClient from '../processes/strategies/OrderClient';
import { isLoopback } from '../middleware/cloudflareOnly';

const orderClient = OrderClient.getInstance();

// State-changing routes are POST-only (a cross-site top-level navigation carries the SameSite=lax session cookie, so a GET that changed
// state was a CSRF hole), and a non-loopback caller must send a custom header, which a cross-site page cannot add without a CORS
// preflight that this server never grants. Loopback callers (ops scripts) are exempt, as everywhere else in this file.
export function requireCsrfHeader(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (requestIsLoopback(req) || req.get('x-requested-with')) { next(); return; }
    res.status(403).json({ error: 'X-Requested-With header required for this state-changing request' });
}



// The one place a user's settings are pushed to the order process. It sends EVERY field: the order process replaces its cached entry, so
// a partial payload (as login and user-create used to send) silently dropped broker, caps, target/stop and accountClosed, re-opening an
// account closed by the weekly-drawdown breach on the next page open.
export function pushUserToOrderProcess(user: any, context: string): Promise<void> {
    return orderClient.updateUserSettings(user.email, {
        lossLimit: user.lossLimit,
        lotLimit: user.lotLimit ?? user.lotCount,
        investmentMode: user.investmentMode,
        accountCapital: user.accountCapital ?? user.investmentAmount,
        useGTT: user.useGTT,
        broker: user.broker,
        perOrderCap: user.perOrderCap,
        strategyCapital: user.strategyCapital ?? user.allottedCapital,
        targetPoints: user.targetPoints,
        stopLossPoints: user.stopLossPoints,
        accountClosed: user.accountClosed === true,
    }).catch((e) => Log.log(`[frontend] updateUserSettings on ${context} failed:`, e));
}

// Resolves the user ONLY from the server-signed session cookie - proves
// nothing was forged, unlike the X-User-Id header this used to also trust
// (any caller could set that header to act as anyone) or the 'Default'
// fallback (a real, tradeable pseudo-user reachable by anyone with no
// identity at all). Returns null when there's no valid session; callers that
// need a guaranteed identity go through requireAuth/requireSelfOrAdmin below
// first, which reject the request before the handler body ever runs.
// The session cookie value is `email|issuedAtMs` (signed). The issue time lets the SERVER enforce an expiry and revoke sessions;
// the cookie's maxAge is only a hint to the browser. A legacy cookie holding just the email has no issue time (treated as
// issued at 0: valid until a revocation, and re-issued with a timestamp on the next /auth/me).
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export function sessionCookieValue(email: string): string { return `${email}|${Date.now()}`; }
export function parseSession(req: express.Request): { email: string; issuedAt: number; legacy: boolean } | null {
    const raw = (req as any).signedCookies?.session;
    if (typeof raw !== 'string' || !raw) return null;
    const i = raw.lastIndexOf('|');
    if (i < 0) return { email: raw, issuedAt: 0, legacy: true };
    const issuedAt = Number(raw.slice(i + 1));
    if (!Number.isFinite(issuedAt)) return null;
    if (Date.now() - issuedAt > SESSION_MAX_AGE_MS) return null; // expired server-side, whatever the browser still holds
    return { email: raw.slice(0, i), issuedAt, legacy: false };
}
export function resolveUser(req: express.Request): string | null {
    return parseSession(req)?.email ?? null;
}
// True when the user's sessions were revoked (logout) after this cookie was issued.
export function sessionRevoked(req: express.Request, user: { sessionsValidAfter?: number } | null | undefined): boolean {
    const s = parseSession(req);
    return !!s && !!user?.sessionsValidAfter && s.issuedAt <= user.sessionsValidAfter;
}

// Loopback requests (a process on this same machine - see isLoopback's own
// comment for why that's a safe thing to trust here) skip all three checks
// below entirely, per the user's direct instruction. Used by local ops
// scripts (e.g. scripts/check-broker-sessions.sh) that have no browser
// session to present.
export function requestIsLoopback(req: express.Request): boolean {
    return isLoopback(req.socket.remoteAddress);
}

// A signed 30-day cookie must not outlive the account: the user is re-read (briefly cached) so a deleted or disabled
// user is rejected on their next request instead of keeping access until the cookie expires.
const USER_CACHE_TTL_MS = 15_000;
const userCache = new Map<string, { at: number; user: Awaited<ReturnType<typeof getUser>> }>();
// Bumped on every invalidation: a read that was in flight across an invalidation holds a document from before it and must not be cached.
// Per email, so one user's invalidation does not stop another's read from caching; the map is cleared (with a global bump) past a cap.
const userCacheEpoch = new Map<string, number>();
let userCacheGlobalEpoch = 0;
const epochOf = (email: string) => `${userCacheGlobalEpoch}:${userCacheEpoch.get(email) ?? 0}`;
export async function getActiveUser(email: string) {
    const hit = userCache.get(email);
    if (hit && Date.now() - hit.at < USER_CACHE_TTL_MS) return hit.user;
    const epoch = epochOf(email);
    const user = await getUser(email);
    if (epoch === epochOf(email)) userCache.set(email, { at: Date.now(), user });
    return user;
}
export function invalidateUserCache(email?: string): void {
    if (email && userCacheEpoch.size < 1000) { userCacheEpoch.set(email, (userCacheEpoch.get(email) ?? 0) + 1); userCache.delete(email); }
    else { userCacheGlobalEpoch++; userCacheEpoch.clear(); userCache.clear(); }
}

// The one session check behind requireAuth / requireAdmin / requireSelfOrAdmin: a valid session cookie (not expired or revoked) for a
// user that still exists and is enabled. Returns the user, or the status and message to answer with.
export async function authenticate(req: express.Request): Promise<{ ok: true; email: string; user: NonNullable<Awaited<ReturnType<typeof getUser>>> } | { ok: false; status: number; error: string; noSession?: boolean }> {
    const email = resolveUser(req);
    if (!email) return { ok: false, status: 401, error: 'Not logged in', noSession: true };
    const user = await getActiveUser(email);
    if (!user || sessionRevoked(req, user)) return { ok: false, status: 401, error: 'Unknown user' };
    if (user.enabled === false) return { ok: false, status: 403, error: 'Account disabled' };
    return { ok: true, email, user };
}

export async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    if (requestIsLoopback(req)) { next(); return; }
    const auth = await authenticate(req);
    if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }
    next();
}

export async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    if (requestIsLoopback(req)) { next(); return; }
    const auth = await authenticate(req);
    if ('error' in auth) {
        if (auth.noSession) res.status(401).json({ error: auth.error }); else res.status(403).json({ error: 'Forbidden' });
        return;
    }
    if (auth.user.role !== 'admin') { res.status(403).json({ error: 'Forbidden' }); return; }
    next();
}

export function requireSelfOrAdmin(paramName = 'email') {
    return async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
        if (requestIsLoopback(req)) { next(); return; }
        const auth = await authenticate(req);
        if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }
        if (auth.email === req.params[paramName]) { next(); return; }
        if (auth.user.role === 'admin') { next(); return; }
        res.status(403).json({ error: 'Forbidden' });
    };
}

