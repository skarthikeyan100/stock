// Remembers that a broker session was just confirmed valid, so a burst of orders does not pay one authenticated round trip each
// (Kite getProfile, Breeze getCustomerDetails, ANT getPositions: hasValidSession was called before every order, 11 times in
// kiteExecutor alone). Only a positive answer is cached, only for the token it was confirmed for (a new login, a reload or a logout
// changes the token and so misses the cache), and only briefly: a session killed elsewhere is noticed within `ttlMs`, and an order sent
// inside that window is rejected loudly by the broker rather than silently accepted.
export class SessionValidityCache {
    private token: string | null = null;
    private validUntil = 0;

    constructor(private readonly ttlMs: number = 30_000) {}

    isValid(token: string | null | undefined): boolean {
        return !!token && token === this.token && Date.now() < this.validUntil;
    }

    markValid(token: string): void {
        this.token = token;
        this.validUntil = Date.now() + this.ttlMs;
    }

    invalidate(): void {
        this.token = null;
        this.validUntil = 0;
    }
}
