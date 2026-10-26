// Server-side validation for POST /config, run before ConfigService writes
// the posted flat config to disk. See plans/bug-12-config-no-server-validation.md
// for the full investigation behind the field lists and the grandfathering
// behavior in validateFlatConfig.

import { PERCENT_KEYS, toPercentNumber } from './percentConfig';

function isNum(v: any): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

// Fields that must never be negative wherever they appear (in `settings` or
// in any single strategy's flat block). See the plan's field table for the
// evidence behind each one.
const NON_NEGATIVE_FIELDS: string[] = [
    'lossLimit', 'lotLimit', 'maxInvestment',
    'targetPoints', 'stopLossPoints', 'targetPrice', 'stopLossPrice', 'target', 'stopLoss',
    'minPrice', 'maxPrice', 'targetPriceDiff', 'stopLossPriceDiff', 'trailingDistance',
    'cooldownSeconds', 'safetyBufferAmount', 'maxTradesPerDay',
    'slDistance', 'postAverageTargetDistance', 'minPremium', 'refillCancelDistance',
    'pointsThreshold', 'accelerationThreshold', 'numberOfDatapointsReceived',
    'maxHoldTimeMinutes', 'gapReversalThreshold',
    'averageThreshold', 'threshold', 'loopCount', 'activateIntermittentCount',
    'maxIterationCount', 'minMovementPoints',
];

// Order/lot-size fields - zero or negative is meaningless as an order quantity.
// spawnQuantityMode is included here too: it's now a flat hedge-spawn quantity
// multiplier (see ContinuousStrategy.ts's trySpawnLevel), and while the runtime
// code itself falls back to 1 for a <=0/non-numeric value (defense-in-depth),
// this admin-facing save-time validator should reject such a value outright
// rather than silently accepting one that would just be overridden anyway.
const POSITIVE_QUANTITY_FIELDS: string[] = [
    'quantity', 'orderQuantity', 'initialQuantity', 'incrementQuantity', 'spawnQuantityMode',
];

// Documented "size from maxInvestment headroom instead of a fixed quantity"
// sentinel (see bookkeeping.resolveMaxInvestmentQuantity's own comment and
// HourlyStrategy.tryEnter) - deliberately the SAME value (-1) for every
// strategy type listed here, not a different magic number per type, so
// arming one doesn't require remembering which type uses which value. A
// strategy TYPE's own `quantity` field is allowed to be exactly this value
// instead of the normal ">0" rule below. Keyed by strategy type (the
// `label` this validator is called with for a strategy block), not a
// blanket "any negative quantity is fine" exception, so a genuine typo/
// garbage value (e.g. -3, or -1 on a type that never implemented this
// convention) still gets rejected.
const QUANTITY_SENTINEL_VALUE = -1;
const QUANTITY_SENTINEL_TYPES = ['BulkPcrStrategy', 'BulkPcrAutoStartStrategy', 'HourlyStrategy'];

// Percent-of-profit / drawdown fields, constrained to a sane 0-100 range.
const PERCENT_FIELDS: string[] = [
    'consistencyLimitPercent', 'maxDailyDrawdownPercent', 'maxWeeklyDrawdownPercent',
];

// Stop levels that must be strictly positive. 0 for maxProfit/maxLoss would
// trip on the first tick; 0 for a drawdown limit would block every zero-P&L
// day. "Disabled" is expressed by removing the key instead.
const PERCENT_POSITIVE_FIELDS: string[] = [
    'maxProfit', 'maxLoss', 'maxLossPerDay', 'maxLossPerTrade', 'maxDailyDrawdownPercent', 'maxWeeklyDrawdownPercent',
];

// Must be non-negative (0 is allowed).
const PERCENT_NON_NEGATIVE_FIELDS: string[] = ['marketProtectionPercent'];

// target/stop-loss field-name pairs used across different strategies for the
// same "distance from entry price" concept. Within a single object, if both
// members of a pair are present, the stop-loss distance must be strictly
// less than the target distance.
const TARGET_STOPLOSS_PAIRS: [string, string][] = [
    ['targetPoints', 'stopLossPoints'],
    ['targetPrice', 'stopLossPrice'],
    ['target', 'stopLoss'],
];

// maxInvestment may be quoted in YAML ("100000"): a plain numeric string is
// accepted and converted to a number. Anything else (e.g. "1,00,000") is left
// as-is so validation rejects it.
export function coerceMaxInvestment(v: unknown): unknown {
    if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    return v;
}

/**
 * Single-field range checks for one flat config object (either the
 * top-level `settings` object, or one strategy's flat block, e.g.
 * `flat.goodMorningStrategy`). Pure function - no I/O, no reference to
 * currently-persisted config. Returns an array of error strings; empty
 * array means valid.
 */
export function validateNumericRanges(label: string, obj: Record<string, any>): string[] {
    const errors: string[] = [];
    if (!obj || typeof obj !== 'object') return errors;

    for (const field of NON_NEGATIVE_FIELDS) {
        if (isNum(obj[field]) && obj[field] < 0) {
            errors.push(`${label}.${field} must be >= 0 (got ${obj[field]})`);
        }
    }

    for (const field of POSITIVE_QUANTITY_FIELDS) {
        if (isNum(obj[field]) && obj[field] <= 0) {
            if (field === 'quantity' && obj[field] === QUANTITY_SENTINEL_VALUE && QUANTITY_SENTINEL_TYPES.includes(label)) continue;
            errors.push(`${label}.${field} must be > 0 (got ${obj[field]})`);
        }
    }

    // Percent fields accept a number or "N%" (see percentConfig.ts). A value
    // that is present but unparseable is an error rather than silently skipped.
    for (const field of PERCENT_KEYS) {
        if (obj[field] == null) continue;
        const n = toPercentNumber(obj[field]);
        if (n === null) {
            errors.push(`${label}.${field} must be a number, optionally with a % sign (got ${JSON.stringify(obj[field])})`);
        }
    }
    for (const field of PERCENT_FIELDS) {
        const n = toPercentNumber(obj[field]);
        if (n !== null && (n < 0 || n > 100)) {
            errors.push(`${label}.${field} must be between 0 and 100 (got ${obj[field]})`);
        }
    }
    for (const field of PERCENT_POSITIVE_FIELDS) {
        const n = toPercentNumber(obj[field]);
        if (n !== null && n <= 0) {
            errors.push(`${label}.${field} must be > 0 (got ${obj[field]}); remove the key to disable it`);
        }
    }
    for (const field of PERCENT_NON_NEGATIVE_FIELDS) {
        const n = toPercentNumber(obj[field]);
        if (n !== null && n < 0) {
            errors.push(`${label}.${field} must be >= 0 (got ${obj[field]})`);
        }
    }

    // maxInvestment is the base every % stop is computed against. A non-numeric
    // value (e.g. "1,00,000") would make the thresholds NaN and silently
    // disable them, so it must be a positive number when present.
    const maxInv = coerceMaxInvestment(obj.maxInvestment);
    if (obj.maxInvestment != null && !(isNum(maxInv) && maxInv > 0)) {
        errors.push(`${label}.maxInvestment must be a number > 0 (got ${JSON.stringify(obj.maxInvestment)})`);
    }
    // A BulkPcr loss stop is a percent of maxInvestment: with no usable base it could never trip, so refuse the file.
    // Scoped to BulkPcr only - other strategies fall back to a default base and must keep loading as they do today.
    if (label === 'BulkPcrStrategy' && obj.maxLossPerTrade != null && !(isNum(maxInv) && maxInv > 0)) {
        errors.push(`${label}.maxLossPerTrade needs a usable maxInvestment (> 0) - the percent is taken of it`);
    }

    if (isNum(obj.minPrice) && isNum(obj.maxPrice) && obj.minPrice > obj.maxPrice) {
        errors.push(`${label}.minPrice (${obj.minPrice}) must be <= ${label}.maxPrice (${obj.maxPrice})`);
    }

    return errors;
}

/**
 * Cross-field target/stop-loss check for one flat config object. Pure
 * function, unconditional - if both fields of a pair are present as numbers
 * in `obj`, the stop-loss distance must be strictly less than the target
 * distance. This is the function to call directly in unit tests.
 */
export function validateTargetVsStopLoss(label: string, obj: Record<string, any>): string[] {
    const errors: string[] = [];
    if (!obj || typeof obj !== 'object') return errors;

    for (const [targetField, stopField] of TARGET_STOPLOSS_PAIRS) {
        if (isNum(obj[targetField]) && isNum(obj[stopField]) && obj[stopField] >= obj[targetField]) {
            errors.push(`${label}.${stopField} (${obj[stopField]}) must be less than ${label}.${targetField} (${obj[targetField]})`);
        }
    }

    return errors;
}

/**
 * Validates a whole parsed config file (or the same shape about to be written
 * by POST /config). Used by ConfigService.loadConfig - an invalid file is
 * rejected, never traded on - and by POST /config before it writes, so a save
 * that the reload would reject is refused up front. Percent values may be
 * "N" or "N%". Disabled strategy blocks are not checked: a stale value in a
 * block that is not running must not stop the process from starting.
 * Returns an array of errors; empty means valid.
 */
export function validateConfigFile(parsed: any): string[] {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return ['config is empty or is not a mapping'];
    }
    if (!parsed.settings || typeof parsed.settings !== 'object') {
        return ['settings block is required'];
    }
    if (parsed.strategies !== undefined && parsed.strategies !== null && !Array.isArray(parsed.strategies)) {
        return ['strategies must be a list'];
    }

    const errors = validateNumericRanges('settings', parsed.settings);
    for (const s of parsed.strategies || []) {
        if (!s || typeof s !== 'object' || typeof s.type !== 'string') {
            errors.push('every strategies entry needs a string type');
            continue;
        }
        if (s.enabled === false) continue;
        errors.push(...validateNumericRanges(s.type, s));
    }
    return errors;
}

/**
 * Full-payload validator for POST /config. `flat` is the request body;
 * `current` is the currently-persisted config in the same flat shape
 * (ConfigService.configToFlat()'s return value), fetched by the caller
 * BEFORE writing. Runs range checks on every object unconditionally, and
 * runs the target/stop-loss cross-field check per strategy ONLY when the
 * request is actually changing at least one field of that pair relative to
 * `current` - this grandfathers already-persisted legacy values (some of
 * this repo's current config.yml strategy blocks predate this validation
 * and would otherwise fail it - see the plan doc) while still catching a
 * request that introduces or edits a bad target/stop-loss combination.
 */
export function validateFlatConfig(flat: Record<string, any>, current: Record<string, any>): string[] {
    const errors: string[] = [];
    if (!flat || typeof flat !== 'object') {
        return ['Request body must be a JSON object'];
    }

    if (flat.settings) {
        errors.push(...validateNumericRanges('settings', flat.settings));
    }

    for (const key of Object.keys(flat)) {
        if (key === 'settings') continue;
        const incoming = flat[key];
        if (!incoming || typeof incoming !== 'object') continue;

        // Label by the block's strategy type (not the flat key) so type-keyed rules (quantity sentinel, BulkPcr) apply.
        const label = typeof incoming.type === 'string' ? incoming.type : key;
        errors.push(...validateNumericRanges(label, incoming));

        const prev = (current && current[key]) || {};
        for (const [targetField, stopField] of TARGET_STOPLOSS_PAIRS) {
            if (!isNum(incoming[targetField]) || !isNum(incoming[stopField])) continue;
            const changed = incoming[targetField] !== prev[targetField] || incoming[stopField] !== prev[stopField];
            if (!changed) continue;
            if (incoming[stopField] >= incoming[targetField]) {
                errors.push(`${key}.${stopField} (${incoming[stopField]}) must be less than ${key}.${targetField} (${incoming[targetField]})`);
            }
        }
    }

    return errors;
}
