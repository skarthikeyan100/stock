// Global target / stop-loss with per-strategy override.
//
// Two keys, read through Strategy.setting(): the strategy block's own value wins, else settings.<key> in config.yml:
//   target:   10        - 10 points above the entry (average fill / entry price)
//   target:   "5%"      - 5 percent above the entry
//   stopLoss: 20        - 20 points below the entry
//   stopLoss: "10%"     - 10 percent below the entry (must be below 100%)
//   target: none / stopLoss: none   - no target / no stop (an explicit value, not an omission)
//
// An omitted key (in the block AND in settings) is an error for the strategies that use this: the strategy refuses to trade with an
// ALERT, so a missing stop can never silently mean "no stop". Points and percent are measured from the entry price the strategy holds.

export type ExitRule = { kind: 'points'; value: number } | { kind: 'percent'; value: number };

export interface ExitRules {
    target: ExitRule | null; // null = no target
    stop: ExitRule | null;   // null = no stop
}

export const EXIT_KEYS = ['target', 'stopLoss'] as const;

// Parses one exit value. Returns null for "none" (or false). Throws a plain-language Error for anything else, including an absent value.
export function parseExitRule(raw: unknown, which: 'target' | 'stopLoss'): ExitRule | null {
    if (raw === undefined || raw === null) throw new Error(`${which} is not set (give a value, or 'none' for no ${which === 'target' ? 'target' : 'stop-loss'})`);
    if (raw === false) return null;
    let text: string;
    if (typeof raw === 'number') text = String(raw);
    else if (typeof raw === 'string') text = raw.trim();
    else throw new Error(`${which} must be a number, "N%" or 'none' (got ${JSON.stringify(raw)})`);
    if (text.toLowerCase() === 'none') return null;
    const isPercent = text.endsWith('%');
    const numText = isPercent ? text.slice(0, -1).trim() : text;
    if (!/^\d+(\.\d+)?$/.test(numText)) throw new Error(`${which} must be a number, "N%" or 'none' (got ${JSON.stringify(raw)})`);
    const value = Number(numText);
    if (!(value > 0)) throw new Error(`${which} must be greater than 0 (got ${JSON.stringify(raw)}); use 'none' to disable it`);
    if (isPercent) {
        if (which === 'stopLoss' && value >= 100) throw new Error(`stopLoss percent must be below 100% (got ${JSON.stringify(raw)})`);
        return { kind: 'percent', value };
    }
    return { kind: 'points', value };
}

// Distance (points) from `base` for a rule: points as they are, percent of the base price.
export function exitDistance(rule: ExitRule, base: number): number {
    return rule.kind === 'points' ? rule.value : base * rule.value / 100;
}

// Both rules from the raw values a strategy reads (its own block first, then settings). Throws on an absent or invalid value.
export function exitRulesFrom(rawTarget: unknown, rawStop: unknown, source: string): ExitRules {
    try {
        return { target: parseExitRule(rawTarget, 'target'), stop: parseExitRule(rawStop, 'stopLoss') };
    } catch (e: any) {
        throw new Error(`${source}: ${e?.message ?? e}`);
    }
}

// Keys a strategy block still carries from before the global exits: the strategy ignores them, so they are reported, not used.
export function legacyExitKeysIn(block: Record<string, any> | null | undefined, legacy: string[]): string[] {
    return legacy.filter((k) => block?.[k] !== undefined && block?.[k] !== null);
}

// configValidation: a value that is present must parse. Absence is checked by the caller (it needs the block AND settings).
export function exitValueError(label: string, which: 'target' | 'stopLoss', raw: unknown): string | null {
    if (raw === undefined) return null;
    try {
        parseExitRule(raw, which);
        return null;
    } catch (e: any) {
        return `${label}.${which}: ${e?.message ?? e}`;
    }
}

// Timeout: the minutes a position may be held, whatever its P&L (winners and losers alike). 'none' or 0 = no timeout. Global
// settings.maxHoldTimeMinutes, overridable by the block with the same key (read through Strategy.setting()).
// Returns minutes, or null for no timeout. Throws for an absent or invalid value.
export function timeoutFrom(raw: unknown, source: string): number | null {
    try {
        if (raw === undefined || raw === null) throw new Error(`maxHoldTimeMinutes is not set (give minutes, or 'none' for no timeout)`);
        if (raw === false) return null;
        const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
        if (text.toLowerCase() === 'none') return null;
        if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`maxHoldTimeMinutes must be a number of minutes or 'none' (got ${JSON.stringify(raw)})`);
        const minutes = Number(text);
        return minutes > 0 ? minutes : null;
    } catch (e: any) {
        throw new Error(`${source}: ${e?.message ?? e}`);
    }
}

// configValidation: a present value must parse. Absence is checked by the caller.
export function timeoutValueError(label: string, raw: unknown): string | null {
    if (raw === undefined) return null;
    try {
        timeoutFrom(raw, label);
        return null;
    } catch (e: any) {
        return e?.message ?? String(e);
    }
}
