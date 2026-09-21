# Security hardening — deferred auth/authorization fix

**Status: not yet implemented.** Investigated and designed 2026-09-03 while adding the
Cloudflare-only IP allowlist (see `CLAUDE.md`/git history for that change, which *is*
live). This document captures a real, unimplemented set of vulnerabilities and the
fix design for them, deferred because no real users are onboarded yet — revisit before
onboarding real users, since real money/KYC/bank data will then be at stake.

## The vulnerabilities

1. **`resolveUser()` isn't an auth check** (`src/server.ts:69-73`):
   ```ts
   function resolveUser(req: express.Request): string {
       const cookieEmail = (req as any).signedCookies?.session;
       if (cookieEmail) return cookieEmail;
       return (req.headers['x-user-id'] as string) || 'Default';
   }
   ```
   With no session cookie, it trusts the client-supplied `X-User-Id` header outright,
   and falls back to a real, tradeable pseudo-user `'Default'` if neither is present.
   Any caller can act as any user (or the default account) just by setting a header.

2. **`POST /auth/login` never verifies the Google ID token**
   (`src/server.ts:77-98`). The frontend (`frontend/src/context/AuthContext.tsx:74-87`)
   decodes the JWT payload client-side with `atob()` and POSTs the *claimed*
   `email`/`name`/`picture` — the server trusts those fields as-is and mints a signed
   session cookie for them. A session cookie therefore proves nothing about who's
   actually asking; anyone can obtain a valid cookie for any email, including an
   admin's, with a single unauthenticated POST.

3. **The cookie-signing secret is hardcoded**: `cookieParser('propfirm-secret')`
   (`server.ts:62`). Low risk on its own, but the entire auth model rests on this
   signature being unguessable/unleaked, so it should move to an env var alongside
   the rest of this fix.

4. **~45 routes have no identity/auth check of any kind** (found via full route audit
   of `src/server.ts`) — not even the broken `resolveUser()`. Highlights:
   - `GET /start` (946) — places a **live market order**, hardcoded to the
     `'Default'` user, reachable by anyone.
   - `GET /users/:email/documents/:docType` (447) — downloads **any user's
     PAN/Aadhaar/KYC document**.
   - `PATCH /users/:email/role` (200) — no check at all; combined with #2, trivial
     self-promotion to `admin`.
   - `GET`/`POST /config` (1374/1378) — read/write live strategy risk parameters.
   - Full bank details, payout history/invoices, PnL summaries, and admin trade views
     are all similarly open. See the complete classification below.

5. **No `/admin/*` authorization anywhere** — `isAdminEmail()`
   (`src/user.ts:108-109`, backed by the `ADMIN_EMAILS` env var) is only ever called
   once, at account-creation time, to set the *initial* `role`. No route checks
   `role === 'admin'` before serving/mutating admin data. The frontend's
   `RequireAdmin` gate (`frontend/src/App.tsx`) has zero server-side mirror.

## The fix (designed, not implemented)

### Real login verification
- Backend: add `google-auth-library`. In `POST /auth/login`, replace trusting
  `req.body.email/name/picture` with
  `client.verifyIdToken({ idToken: req.body.credential, audience: process.env.GOOGLE_CLIENT_ID })`
  (an `OAuth2Client`); derive `email`/`name`/`picture` from the **verified token
  payload** only. `GOOGLE_CLIENT_ID` must match the frontend's existing
  `VITE_GOOGLE_CLIENT_ID` (`frontend/.env`) — same public client ID, not a secret.
- Frontend: `AuthContext.tsx`'s `login(credential)` should POST `{ credential }` (the
  raw JWT) instead of decoding it client-side and sending the decoded fields.
- Fail closed: refuse to start the server if `GOOGLE_CLIENT_ID` is unset.

### Session cookie hardening
- `res.cookie('session', email, { signed: true, httpOnly: true, maxAge: ... })`
  (`server.ts:92`) → add `secure: true, sameSite: 'lax'`. Verified none of the broker
  OAuth callback redirects (`/prism/callback` etc.) depend on this cookie, so `'lax'`
  is safe and blocks the common CSRF vector (cross-site subresource/script requests)
  for this app's GET-based mutating routes.
- Move the signing secret to `process.env.SESSION_COOKIE_SECRET`; fail closed if
  unset.

### New middleware (`src/server.ts`, near current `resolveUser`)
```ts
function resolveUser(req: express.Request): string | null {
    return (req as any).signedCookies?.session || null;
}
function requireAuth(req, res, next) {
    if (!resolveUser(req)) { res.status(401).json({ error: 'Not logged in' }); return; }
    next();
}
async function requireAdmin(req, res, next) {
    const email = resolveUser(req);
    if (!email) { res.status(401).json({ error: 'Not logged in' }); return; }
    const user = await getUser(email);
    if (!user || user.role !== 'admin') { res.status(403).json({ error: 'Forbidden' }); return; }
    next();
}
function requireSelfOrAdmin(paramName = 'email') {
    return async (req, res, next) => {
        const email = resolveUser(req);
        if (!email) { res.status(401).json({ error: 'Not logged in' }); return; }
        if (email === req.params[paramName]) { next(); return; }
        const user = await getUser(email);
        if (user?.role === 'admin') { next(); return; }
        res.status(403).json({ error: 'Forbidden' });
    };
}
```
`X-User-Id` header trust and the `'Default'` fallback are removed — `resolveUser` only
ever returns a value the server itself signed. `getUser` is already exported from
`src/user.ts:174`.

### Full route classification (from the 2026-09-03 audit)

**`requireSelfOrAdmin('email')`** — resource keyed by a `:email` param, owner or admin only:
`POST /users/:email/settings` (224), `PATCH /users/:email/profile` (252),
`PATCH /users/:email/kyc-numbers` (269), `PATCH /users/:email/bank-details` (287),
`PATCH /users/:email/entity-type` (300), `PATCH /users/:email/company-profile` (316),
`POST /users/:email/documents/:docType` (403),
`GET /users/:email/documents/:docType` (447), `GET /users/:email/payouts` (479),
`GET /users/:email/payouts/:id/invoice` (490),
`GET /users/:email/payouts/:id/decision-log` (501),
`GET /users/:email/trades/closed` (1014), `GET /users/:email/notifications` (1179),
`PATCH /users/:email/notifications/:id/read` (1193)

**`requireAdmin`**: `GET /users` (138), `POST /users` (159), `DELETE /users/:email`
(185), `PATCH /users/:email/role` (200), `PATCH /users/:email/verify` (329),
`GET /admin/payouts` (511), `POST /admin/payouts/compute` (525),
`POST /admin/payouts` (539), `PATCH /admin/payouts/:id` (559),
`GET /admin/trades/closed` (1032), `GET /admin/trades/pnl-summary` (1055),
`GET /admin/trades/open` (1074), `GET /addTrade` (934), `GET /start` (946),
`GET /connect` (960), `GET /stats` (1237), `GET /strategies` (1261),
`GET /strategies/:type/reset` (1277), `GET /candles` (1356),
`GET /requestOtp` (1324), `GET /logout` (1346, broker logout — shared account),
`GET /config` (1374), `POST /config` (1378), `GET /replay` (1391),
`GET /ant/positions` (709), `GET /ant/trades` (720), `GET /kite/trades` (773),
`GET /kite/positions` (783), `GET /ant/stream` (810), `GET /prism/orderbook` (818),
`GET /ant/token` (701), `GET /kite/token` (765), `GET /openTrades` (978),
`GET /subscribe` (970), `GET /refreshtrades` (1086), `GET /subscribetrades` (1096)

(Confirmed via frontend grep: `/config`, `/strategies*`, `/admin/*` are called only
from `AdminPage.tsx`; nothing in the frontend calls `/stats`, `/candles`, `/replay`,
the `/ant`|`/kite` token/positions/trades routes, `/logout`, `/requestOtp`,
`/connect`, `/addTrade`, or `/start` at all — these are ops/manual-only endpoints, so
admin-only is the safe default even though their exact intended audience wasn't
otherwise documented.)

**`requireAuth`** (any logged-in user — these already call `resolveUser()` and are
self-scoped by its return value; just need the gate added in front, no handler body
changes): `GET /prism/order/buy` (833), `GET /prism/squareoff` (854),
`POST /prism/settarget` (874), `GET /ant/order/buy` (888),
`GET /ant/order/squareoff` (909), `POST /ant/order/settarget` (925),
`GET /trades` (990), `GET /closedtrades` (1001), `GET /positionstream` (1153),
`GET /notificationstream` (1205), `GET /quotes` (1292), `GET /niftyquote` (1305),
`GET /quote` (1316), `GET /search` (1338), `GET /niftystream` (1120),
`GET /optionstream` (1129).
`EventSource` sends cookies automatically for same-origin requests, so `requireAuth`
on the SSE routes works fine with no frontend changes needed there.

**Left as-is** (pre-login flows by design — still covered by the Cloudflare IP
allowlist already shipped, just not by session auth): `/prism/login`,
`/prism/callback`/`/shoonya/callback`, `/ant/login`, `/ant/callback`, `/kite/login`,
`/kite/callback`, `/auth/login`, `/auth/me` (checks the cookie itself already),
`/auth/logout`.

### New env vars required for this fix
`SESSION_COOKIE_SECRET`, `GOOGLE_CLIENT_ID` (`ADMIN_EMAILS` already exists,
`src/user.ts:104-106`).

## Still not covered even after this fix (raised, not designed)
- Order-mutating routes are `GET` instead of `POST`, no CSRF token — `sameSite: 'lax'`
  mitigates but doesn't fully close this; a real fix means changing HTTP verbs
  (bigger frontend+backend change).
- `/config`'s POST has no schema validation on write (separate bug).
- No rate limiting, no `helmet`, no generic malicious-request-path blocking, no global
  Express error handler (uncaught errors currently fall through to Express's default
  handler; every route relies on its own local try/catch).
