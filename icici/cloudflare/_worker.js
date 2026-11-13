// Cloudflare Pages advanced-mode worker: static files come from Pages (env.ASSETS), API + SSE paths go to the origin server.
const ORIGIN = 'https://origin.nivedhatech.com';
const API_PREFIXES = [
  '/order', '/optionstream', '/positionstream', '/niftystream', '/notificationstream', '/auth', '/users', '/admin', '/config',
  '/strategies', '/prism', '/demo', '/ant', '/kite', '/breeze', '/shoonya', '/broker', '/reconcile',
];
const isApi = (p) => API_PREFIXES.some((x) => p === x || p.startsWith(x + '/'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // A bare SPA page such as /admin or /config is a browser navigation: serve the shell, not the API handler's 404.
    const isPage = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
    if (!isApi(url.pathname) || (isPage && !url.pathname.includes('/', 1))) return env.ASSETS.fetch(request);

    const headers = new Headers(request.headers);
    if (env.CF_ORIGIN_SECRET) headers.set('X-Origin-Secret', env.CF_ORIGIN_SECRET);
    headers.set('X-Forwarded-Host', url.host);
    const upstream = await fetch(ORIGIN + url.pathname + url.search, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
    const out = new Headers(upstream.headers);
    const loc = out.get('location');
    if (loc && loc.startsWith(ORIGIN)) out.set('location', url.origin + loc.slice(ORIGIN.length));
    out.set('cache-control', out.get('cache-control') || 'no-store');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  },
};
