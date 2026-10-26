// Canonical broker names used everywhere (code, config, Mongo, API, UI).
// Legacy/vendor names are accepted on read only, so persisted data, state files and
// config written before the rename keep working. Writers always emit the canonical name.
export type BrokerName = 'ant' | 'kite' | 'breeze' | 'prism';

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
    return ALIASES[lower] ?? lower;
}

export function normalizeBrokerList(list: unknown): string[] {
    return Array.isArray(list) ? list.map(normalizeBrokerName).filter(Boolean) : [];
}

// Deep read-side shim for persisted documents (strategy state, trade rows): rewrites the legacy
// vendor name used as an object key ('zerodha', 'zerodha_put', 'zerodha:maxProfit') or as a string
// value ('zerodha') to the canonical one. Pure; returns a new structure, leaves other values alone.
const LEGACY_PREFIX = /^(zerodha)(?=$|[_:])/i;
export function normalizePersistedBrokers<T>(value: T): T {
    if (Array.isArray(value)) return value.map(normalizePersistedBrokers) as unknown as T;
    if (value && typeof value === 'object' && (value as any).constructor === Object) {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as object)) {
            out[k.replace(LEGACY_PREFIX, 'kite')] = normalizePersistedBrokers((value as any)[k]);
        }
        return out as T;
    }
    if (typeof value === 'string') return value.replace(LEGACY_PREFIX, 'kite') as unknown as T;
    return value;
}
