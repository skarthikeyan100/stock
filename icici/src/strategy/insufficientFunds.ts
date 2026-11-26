// A buy the broker refused because the account cannot pay for it. The chain strategies report such a refusal once and never retry it (user's
// decision 2026-11-26): asking again cannot succeed until somebody adds funds. The words are the brokers' own: Breeze "Available Futures and Options
// Limit is insufficient ...", ANT / Prism "RED:Margin Shortfall:INR ...", Kite "Insufficient funds. Required margin is ...". Deliberately narrower
// than maxProfitLock.isNonTransientRejection, which also matches limits, invalid orders and blocked instruments.
const INSUFFICIENT_FUNDS = /insufficient\s+(funds?|balance|margin)|(funds?|margin|balance|limit)\s+is\s+insufficient|margin\s+(shortfall|exceeds)|not\s+enough\s+(funds?|margin|balance)|insufficient\s+to\s+cover/i;

export function isInsufficientFunds(e: unknown): boolean {
    return INSUFFICIENT_FUNDS.test(String((e as any)?.message ?? e));
}
