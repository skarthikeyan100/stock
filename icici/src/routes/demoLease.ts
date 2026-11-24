// A demo token hold is kept alive only while a client that subscribed it (by IP) still has an anonymous option stream open.
// Tokens from closed tabs therefore expire on the normal lease even while other visitors' streams are connected.
// Known limitation: the link is the client IP, so a client whose subscribe and stream calls come from different IPs (IPv4/IPv6, mobile
// network switch) is not recognised as holding the token and loses it when the 30 min lease lapses. A per-client id would need a frontend change.
export function demoLeaseHeld(subscriberIps: Map<string, number> | undefined, optionStreamsByIp: Map<string, number>): boolean {
    if (!subscriberIps) return false;
    for (const ip of subscriberIps.keys()) if ((optionStreamsByIp.get(ip) ?? 0) > 0) return true;
    return false;
}

// Per-IP subscription counts of one token: an IP that unsubscribed all its own subscriptions stops counting as a holder.
export function addSubscriberIp(ips: Map<string, number>, ip: string): void {
    ips.set(ip, (ips.get(ip) ?? 0) + 1);
}
export function removeSubscriberIp(ips: Map<string, number>, ip: string): void {
    const n = (ips.get(ip) ?? 0) - 1;
    if (n <= 0) ips.delete(ip); else ips.set(ip, n);
}

// Unsubscribe is anonymous: only an IP that itself holds a subscription to the token may release one, so a stranger cannot decrement the shared count.
export function ipHoldsToken(ips: Map<string, number> | undefined, ip: string): boolean {
    return (ips?.get(ip) ?? 0) > 0;
}
