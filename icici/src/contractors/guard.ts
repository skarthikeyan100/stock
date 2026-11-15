/**
 * Default-deny fence for the `contractor` role (spec v2.1 sections 2 and 6). It acts ONLY on a session whose user has role 'contractor': any
 * other request (admin, existing users, no session, loopback ops scripts) passes straight through, so existing behaviour is unchanged.
 * A contractor may reach exactly the allowlist below; everything else (every /order/*, /positionstream, /optionstream, /users/:email/trades*,
 * brokers, config, ...) answers 403.
 */
import express from 'express';
import { getActiveUser, resolveUser, sessionRevoked } from '../routes/session';
import { CONTRACTOR_ROLE } from './types';

interface Rule { method: string; test: (path: string) => boolean }
const exact = (p: string) => (x: string) => x === p;
const under = (p: string) => (x: string) => x === p || x.startsWith(p + '/');

export const CONTRACTOR_ALLOWLIST: Rule[] = [
    { method: 'GET', test: exact('/auth/me') },
    { method: 'POST', test: exact('/auth/logout') },
    { method: 'GET', test: exact('/niftystream') },
    { method: 'GET', test: exact('/notificationstream') },
    { method: 'GET', test: (x) => /^\/users\/[^/]+\/notifications$/.test(x) },
    { method: 'PATCH', test: (x) => /^\/users\/[^/]+\/notifications\/[^/]+\/read$/.test(x) },
    { method: '*', test: under('/forecast') },
    { method: '*', test: under('/recommendations') },
    { method: '*', test: under('/contractor') },
    { method: 'GET', test: under('/agreements') },
    { method: 'GET', test: exact('/demo/health') },
];

export function contractorMayCall(method: string, path: string): boolean {
    const m = method.toUpperCase();
    return CONTRACTOR_ALLOWLIST.some((r) => (r.method === '*' || r.method === m) && r.test(path));
}

export async function contractorGuard(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    // No loopback shortcut here (unlike requireAuth): a request that CARRIES a contractor session is fenced wherever it comes from; an ops script has no cookie and passes below.
    const email = resolveUser(req);
    if (!email) { next(); return; }
    const user = await getActiveUser(email);
    if (!user || user.role !== CONTRACTOR_ROLE || sessionRevoked(req, user)) { next(); return; } // not a contractor: the route's own auth decides
    if (!contractorMayCall(req.method, req.path)) { res.status(403).json({ error: 'Forbidden' }); return; }
    next();
}
