// One place for the headers every state-changing request needs. The server rejects a state-changing request that
// lacks `X-Requested-With` (a header a cross-site page cannot add without a CORS preflight), so a forged link or form
// cannot place an order or flip a strategy on the user's behalf.
const BASE_HEADERS = { 'X-Requested-With': 'fetch' };

// Registered by AuthProvider: called when the server answers 401 (expired session, revoked cookie, deleted user) on a request other
// than the /auth/* ones, so the UI drops to the login screen instead of showing a stale 'logged in' page whose polls fail silently.
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

// A single 401 (a stray endpoint, a request racing a login) must not bounce the whole app to the login screen: the session is
// confirmed against /auth/me first, and only one confirmation runs at a time.
let confirming = false;
async function confirmSessionGone(): Promise<void> {
  if (confirming) return;
  confirming = true;
  try {
    // Bounded: a hung probe must not leave `confirming` set forever and swallow every later genuine 401.
    const probe = await fetch('/auth/me', { credentials: 'include', signal: AbortSignal.timeout(8000) });
    if (probe.status === 401) unauthorizedHandler?.();
  } catch {
    /* network trouble is not a logged-out session */
  } finally {
    confirming = false;
  }
}

export function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: { ...BASE_HEADERS, ...(init.headers as Record<string, string> | undefined) },
  });
  if (res.status === 401 && !url.startsWith('/auth/') && !url.startsWith('/demo/')) void confirmSessionGone();
  return res;
}

// POST with an optional JSON body (query-string-only endpoints just omit it).
export function apiPost(url: string, body?: unknown): Promise<Response> {
  return apiFetch(url, {
    method: 'POST',
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

// Best-effort human message from an error response: the server's { error } JSON, else the body text, else the status.
export async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      const msg = body?.error || body?.message;
      if (msg) return String(msg);
    } catch { /* not JSON */ }
    if (text && text.length < 300) return text;
  } catch { /* unreadable body */ }
  return `Request failed (${res.status})`;
}
