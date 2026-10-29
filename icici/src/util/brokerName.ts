// Canonical broker names used everywhere (code, config, Mongo, API, UI).
// Legacy/vendor names are accepted on read only, so persisted data, state files and
// config written before the rename keep working. Writers always emit the canonical name.
export const ALL_BROKERS = ['ant', 'kite', 'breeze', 'prism'] as const;
export type BrokerName = typeof ALL_BROKERS[number];

const ALIASES: Record<string, BrokerName> = {
    ant: 'ant', aliceblue: 'ant', 'alice blue': 'ant', 'alice-blue': 'ant',
    kite: 'kite', zerodha: 'kite',
    breeze: 'breeze', icici: 'breeze', 'icici direct': 'breeze', icicidirect: 'breeze',
    prism: 'prism', shoonya: 'prism',
};

// Returns the canonical name for a known broker/alias; anything else is returned
// lower-cased and trimmed, so callers' own "is it a valid broker" checks still reject it.
export function normalizeBrokerName(name: unknown): string {
    if (typeof name !== 'string') return '';
    const lower = name.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(ALIASES, lower) ? ALIASES[lower] : lower;
}

// Brokers a user account can be configured to trade through (prism is only ever addressed explicitly, by strategies).
export const USER_BROKERS: readonly BrokerName[] = ['ant', 'kite', 'breeze'];
export const USER_BROKERS_TEXT = USER_BROKERS.slice(0, -1).join(', ') + ' or ' + USER_BROKERS[USER_BROKERS.length - 1];
// Plain booleans, not type predicates: an alias like 'zerodha' passes but is not yet canonical (use normalizeBrokerName).
export const isBrokerName = (name: unknown): boolean => ALL_BROKERS.includes(normalizeBrokerName(name) as BrokerName);
export const isUserBroker = (name: unknown): boolean => USER_BROKERS.includes(normalizeBrokerName(name) as BrokerName);

// The brokers a strategy block trades on: `brokers: [...]` when present and non-empty, else the legacy single `broker:` key, else
// `defaultBroker`; names normalised and de-duplicated. Six strategies each spelled this out for themselves.
export function configuredBrokersOf(cfg: object | null | undefined, defaultBroker: BrokerName = 'kite'): BrokerName[] {
    const c = (cfg ?? {}) as { brokers?: unknown; broker?: unknown };
    const raw = Array.isArray(c.brokers) && c.brokers.length > 0 ? c.brokers : [c.broker ?? defaultBroker];
    return Array.from(new Set(normalizeBrokerList(raw))) as BrokerName[];
}

export function normalizeBrokerList(list: unknown): string[] {
    return Array.isArray(list) ? list.map(normalizeBrokerName).filter(Boolean) : [];
}

// Deep read-side shim for persisted documents (strategy state, trade rows): rewrites the legacy
// vendor name used as an object key ('zerodha', 'zerodha_put', 'zerodha:maxProfit') or as a string
// value ('zerodha') to the canonical one. Pure; returns a new structure, leaves other values alone.
// Keys: 'zerodha', 'zerodha_put', 'zerodha:maxProfit' (slot/scope keys). Values: only the exact broker name, so ids
// or labels that merely start with 'zerodha_'/'zerodha:' are left alone. If a document already has the canonical key
// as well as the legacy one, the canonical entry wins and the legacy one is dropped (never overwrite newer data).
const LEGACY_KEY = /^(zerodha)(?=$|[_:])/i;
const LEGACY_VALUE = /^\s*zerodha\s*$/i;
export function normalizePersistedBrokers<T>(value: T): T {
    if (Array.isArray(value)) return value.map(normalizePersistedBrokers) as unknown as T;
    if (value && typeof value === 'object' && (value as any).constructor === Object) {
        const src = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(src)) {
            const nk = k.replace(LEGACY_KEY, 'kite');
            if (nk !== k && Object.prototype.hasOwnProperty.call(src, nk)) continue; // canonical key present: it wins
            out[nk] = normalizePersistedBrokers(src[k]);
        }
        return out as T;
    }
    if (typeof value === 'string' && LEGACY_VALUE.test(value)) return 'kite' as unknown as T;
    return value;
}
