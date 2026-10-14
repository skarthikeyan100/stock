import dns from 'dns';

// Kite's (and, confirmed 2026-10-12, AliceBlue/ANT's) order-placement
// endpoints reject any IP not on their IPv4-only allowlist; this host is
// dual-stack and Node's Happy-Eyeballs connection logic (autoSelectFamily,
// default on since Node 18.13+) prefers IPv6 when both are available, so
// outbound calls to these hosts went out over IPv6 and got rejected - for
// Kite with "IP not allowed to place orders", for ANT with AliceBlue's
// EC097 "IP restriction: You are not allowed to place the order" (hit live
// via a manual chunkedBuyIndex test even after confirming the account's
// registered Primary IP already matched this host's own IPv4 address -
// root-caused to the connection itself going out over IPv6 instead).
// dns.setDefaultResultOrder('ipv4first') looks like the fix but does NOT
// actually work - confirmed live: autoSelectFamily does not honor it, a
// real https.get() still connected over IPv6 after calling it. Only
// forcing family:4 in dns.lookup() itself (what this override does) or the
// process-wide --dns-result-order CLI/NODE_OPTIONS flag actually changes
// the connection's family - and the CLI/NODE_OPTIONS route was tried and
// reverted (see orchestrator.ts) because it also forced Breeze/ICICI's
// calls onto IPv4, which broke Breeze (its API key's registered "static
// IP" is whatever family this connection was already using, apparently
// IPv6 - forcing IPv4 process-wide made Breeze reject every order with "IP
// address used does not match with the static IP declared when this API
// key was created", right after an order had filled fine minutes earlier
// under the unforced default).
//
// Scoped instead: only requests to these specific hosts are forced onto
// IPv4; every other hostname (Breeze, Mongo, ...) keeps using Node's
// normal default resolution, untouched. a3.aliceblueonline.com is
// AliceBlue's single domain for every ANT REST call (quotes, trades,
// positions, OHLC, option chain, place/cancel/exit order, order history,
// OAuth token) - not scoped narrower to just the placeorder path, since
// AliceBlue's IP allowlist is almost certainly account/app-wide, not
// per-endpoint, and the fix needs to apply before any one of these calls
// is made. Does NOT cover ws1.aliceblueonline.com (the live tick
// WebSocket, a different host, already working fine over whatever family
// it currently connects with) or ant.aliceblueonline.com (OAuth login,
// unaffected so far - narrow it further here if that one breaks too).
const IPV4_ONLY_HOSTS = new Set(['api.kite.trade', 'a3.aliceblueonline.com']);

export function installIpv4OnlyHostOverride(): void {
    const originalLookup = dns.lookup;
    // @ts-ignore - dns.lookup is heavily overloaded; we only need to special-case
    // the hostname match and delegate everything else (including the varying
    // callback/options signatures) straight to the original implementation.
    dns.lookup = function (hostname: string, ...args: any[]) {
        if (IPV4_ONLY_HOSTS.has(hostname)) {
            // dns.lookup has 3 call shapes: (host, cb), (host, options, cb),
            // (host, family, cb) - the family form takes a bare number, which
            // must be overwritten in place rather than unshifted (unshifting
            // an extra options arg in front of it would leave 4 positional
            // args, and Node's dns.lookup only accepts up to 3).
            if (typeof args[0] === 'number') {
                args[0] = 4;
            } else if (typeof args[0] === 'object' && args[0] !== null) {
                args[0] = { ...args[0], family: 4 };
            } else {
                args.unshift({ family: 4 });
            }
        }
        // @ts-ignore
        return originalLookup.call(dns, hostname, ...args);
    };
}
