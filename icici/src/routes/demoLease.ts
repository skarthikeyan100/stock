// A demo token hold is kept alive only while a client that subscribed it (by IP) still has an anonymous option stream open.
// Tokens from closed tabs therefore expire on the normal lease even while other visitors' streams are connected.
export function demoLeaseHeld(subscriberIps: Set<string> | undefined, optionStreamsByIp: Map<string, number>): boolean {
    if (!subscriberIps) return false;
    for (const ip of subscriberIps) if ((optionStreamsByIp.get(ip) ?? 0) > 0) return true;
    return false;
}
