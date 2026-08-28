// Server-side validation for POST /config, run before ConfigService writes
// the posted flat config to disk. See plans/bug-12-config-no-server-validation.md
// for the full investigation behind the field lists and the grandfathering
// behavior in validateFlatConfig.

function isNum(v: any): v is number {
    return typeof v === 'number' && !Number.isNaN(v);
}

// Fields that must never be negative wherever they appear (in `settings` or
// in any single strategy's flat block). See the plan's field table for the
// evidence behind each one.
const NON_NEGATIVE_FIELDS: string[] = [
    'lossLimit', 'lotLimit', 'maxInvestment',
    'targetPoints', 'stopLossPoints', 'targetPrice', 'stopLossPrice', 'target', 'stopLoss',
    'minPrice', 'maxPrice', 'targetPriceDiff', 'stopLossPriceDiff', 'trailingDistance',
    'cooldownSeconds', 'safetyBufferAmount', 'maxTradesPerDay',
    'slDistance', 'minPremium', 'allottedCapital', 'refillCancelDistance',
    'pointsThreshold', 'accelerationThreshold', 'numberOfDatapointsReceived',
    'maxHoldTimeMinutes', 'gapReversalThreshold',
    'averageThreshold', 'threshold', 'loopCount', 'activateIntermittentCount',
    'maxIterationCount', 'minMovementPoints',
];

// Order/lot-size fields - zero or negative is meaningless as an order quantity.
const POSITIVE_QUANTITY_FIELDS: string[] = [
    'quantity', 'orderQuantity', 'initialQuantity', 'incrementQuantity',
];

// Percent-of-profit / drawdown fields, constrained to a sane 0-100 range.
const PERCENT_FIELDS: string[] = [
    'consistencyLimitPercent', 'maxDailyDrawdownPercent', 'maxMonthlyDrawdownPercent',
];

// target/stop-loss field-name pairs used across different strategies for the
// same "distance from entry price" concept. Within a single object, if both
// members of a pair are present, the stop-loss distance must be strictly
// less than the target distance.
const TARGET_STOPLOSS_PAIRS: [string, string][] = [
    ['targetPoints', 'stopLossPoints'],
    ['targetPrice', 'stopLossPrice'],
    ['target', 'stopLoss'],
];

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
            errors.push(`${label}.${field} must be > 0 (got ${obj[field]})`);
        }
    }

    for (const field of PERCENT_FIELDS) {
        if (isNum(obj[field]) && (obj[field] < 0 || obj[field] > 100)) {
            errors.push(`${label}.${field} must be between 0 and 100 (got ${obj[field]})`);
        }
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

        errors.push(...validateNumericRanges(key, incoming));

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
