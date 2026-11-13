// Server-side validation for POST /config, run before ConfigService writes
// the posted flat config to disk. See plans/bug-12-config-no-server-validation.md
// for the full investigation behind the field lists and the grandfathering
// behavior in validateFlatConfig.

import { PERCENT_KEYS, toPercentNumber } from './percentConfig';
import { isBrokerName } from '../util/brokerName';
import { exitValueError, timeoutValueError } from '../strategy/exitRules';
import { parseRuleIndicator } from '../strategy/ruleIndicators';
import { INDEX_LOT_SIZE } from '../constants';

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
    'cooldownSeconds', 'lossCooldownSeconds', 'profitCooldownSeconds',
    'slDistance', 'priceDiff', 'hedgeTrailDistance', 'hedgeTargetFraction', 'postAverageTargetDistance', 'minPremium', 'refillCancelDistance',
    'pointsThreshold', 'accelerationThreshold', 'numberOfDatapointsReceived',
    'maxHoldTimeMinutes', 'gapReversalThreshold',
    'averageThreshold', 'threshold', 'loopCount', 'activateIntermittentCount',
    'maxIterationCount', 'minMovementPoints', 'minMovePoints', 'maxLegsPerSide', 'stackRecoveryPoints', 'skipNearestExpiryOnExpiryDay', 'onePositionPerSide', 'upDownSampleMinutes',
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
    'maxDailyDrawdownPercent', 'maxWeeklyDrawdownPercent', 'stopLossPercent', 'mirrorPercentage',
];

// Stop levels that must be strictly positive. 0 for maxProfit/maxLoss would
// trip on the first tick; 0 for a drawdown limit would block every zero-P&L
// day. "Disabled" is expressed by removing the key instead.
const PERCENT_POSITIVE_FIELDS: string[] = [
    'maxProfit', 'maxLoss', 'maxLossPerDay', 'maxLossPerTrade', 'maxLossPerOrder', 'maxDailyDrawdownPercent', 'maxWeeklyDrawdownPercent', 'stopLossPercent',
];

// Must be non-negative (0 is allowed).
const PERCENT_NON_NEGATIVE_FIELDS: string[] = ['marketProtectionPercent'];

// target/stop-loss field-name pairs used across different strategies for the
// same "distance from entry price" concept. Within a single object, if both
// members of a pair are present, the stop-loss distance must be strictly
// less than the target distance.
// `target` / `stopLoss` are NOT a pair here: they are global exits that take points, "N%" or 'none' (strategies/exitRules.ts), and a
// stop wider than the target is a legitimate choice.
const TARGET_STOPLOSS_PAIRS: [string, string][] = [
    ['targetPoints', 'stopLossPoints'],
    ['targetPrice', 'stopLossPrice'],
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

    // settings.maxProfit: the global cap in rupees, ONE positive number for every broker (each strategy on each broker is judged separately).
    if (label === 'settings' && obj.maxProfit !== undefined && obj.maxProfit !== null) {
        const m = obj.maxProfit;
        if (!(typeof m === 'number' && Number.isFinite(m) && m > 0)) {
            errors.push(`settings.maxProfit must be a positive number of rupees, e.g. 5000 (got ${JSON.stringify(m)}); a map, list, string, percent, 0 or negative value is not allowed, remove the key for no global cap`);
        }
    }

    // Global exits (settings) and per-strategy overrides share the same value format; an absent key is not an error here.
    for (const which of ['target', 'stopLoss'] as const) {
        const err = exitValueError(label, which, obj[which]);
        if (err) errors.push(err);
    }
    // RuleBased only: the timeout is a global setting too (settings.maxHoldTimeMinutes, 'none' = no timeout). Other strategies keep their own.
    if (label === 'RuleBasedStrategy' || label === 'settings') {
        const terr = timeoutValueError(label, obj.maxHoldTimeMinutes);
        if (terr) errors.push(terr);
    }
    // RuleBased: every listed indicator must be one the live stats builder computes, else the rule could never agree.
    if (label === 'RuleBasedStrategy' && obj.indicators !== undefined) {
        const names = (Array.isArray(obj.indicators) ? obj.indicators : [obj.indicators])
            .flatMap((item: unknown) => String(item).split(',')).map((n: string) => n.trim()).filter((n: string) => n.length > 0);
        if (names.length === 0) errors.push(`${label}.indicators must list at least one indicator`);
        for (const name of names) {
            try { parseRuleIndicator(name); } catch (e: any) { errors.push(`${label}.indicators: ${e?.message ?? e}`); }
        }
    }

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
        if (field === 'maxProfit' && label === 'settings') continue; // a single rupee number, validated above
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
        // BulkPcr alone treats 0 as "no limit" for its two stop caps (PnlStop); a negative cap is still invalid.
        const zeroMeansOff = label === 'BulkPcrStrategy' && (field === 'maxLossPerOrder' || field === 'maxProfit');
        if (n !== null && (zeroMeansOff ? n < 0 : n <= 0)) {
            errors.push(zeroMeansOff
                ? `${label}.${field} must be >= 0 (0 = no limit; got ${obj[field]})`
                : `${label}.${field} must be > 0 (got ${obj[field]}); remove the key to disable it`);
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
    // The old names were renamed to maxInvestment (2026-11-04): refuse a file that still carries them rather than ignore the cap.
    if (obj.maxExposure !== undefined) errors.push(`${label}.maxExposure was renamed to maxInvestment - rename the key (same meaning: per broker)`);
    if (obj.maxExposureByBroker !== undefined) errors.push(`${label}.maxExposureByBroker was renamed to maxInvestmentByBroker - rename the key`);
    const maxInv = coerceMaxInvestment(obj.maxInvestment);
    if (obj.maxInvestment != null && !(isNum(maxInv) && maxInv > 0)) {
        errors.push(`${label}.maxInvestment must be a number > 0 (got ${JSON.stringify(obj.maxInvestment)})`);
    }
    // Per-broker amount override (any strategy): a map of known broker -> number > 0.
    if (obj.maxInvestmentByBroker != null) {
        const m = obj.maxInvestmentByBroker;
        if (typeof m !== 'object' || Array.isArray(m)) {
            errors.push(`${label}.maxInvestmentByBroker must be a mapping of broker -> amount`);
        } else {
            for (const [name, cap] of Object.entries(m)) {
                if (!isBrokerName(name)) errors.push(`${label}.maxInvestmentByBroker has an unknown broker '${name}'`);
                const n = coerceMaxInvestment(cap);
                if (!(isNum(n) && n > 0)) errors.push(`${label}.maxInvestmentByBroker.${name} must be a number > 0 (got ${JSON.stringify(cap)})`);
            }
        }
    }
    // A BulkPcr loss stop is a percent of maxInvestment: with no usable base it could never trip, so refuse the file.
    // Scoped to BulkPcr only - other strategies fall back to a default base and must keep loading as they do today.
    // maxLossPerTrade was replaced by maxLossPerOrder and is ignored at runtime: a file that still carries only the old
    // key would run with no loss stop at all, so refuse it. Likewise a hedge trail needs the per-order cap as its backstop
    // (the trail limit never sells below the entry).
    if (label === 'BulkPcrStrategy') {
        const orderCapOn = obj.maxLossPerOrder != null && toPercentNumber(obj.maxLossPerOrder) !== 0;
        if (obj.maxLossPerTrade != null && toPercentNumber(obj.maxLossPerTrade) !== 0 && !orderCapOn) {
            errors.push(`${label}.maxLossPerTrade was replaced by maxLossPerOrder - rename it (the old key is ignored)`);
        }
        if (isNum(obj.hedgeTrailDistance) && obj.hedgeTrailDistance > 0 && !orderCapOn) {
            errors.push(`${label}.hedgeTrailDistance needs maxLossPerOrder (> 0) as its loss backstop`);
        }
    }
    if (label === 'BulkPcrStrategy' && obj.maxLossPerOrder != null && !(isNum(maxInv) && maxInv > 0)) {
        errors.push(`${label}.maxLossPerOrder needs a usable maxInvestment (> 0) - the percent is taken of it`);
    }

    // eodCloseTime is one global setting (settings.eodCloseTime), read as 'HH:mm'; isPastTime falls back to the strategy's default on
    // anything else, which would silently move the end-of-day close to a time the operator did not write. A strategy block that still
    // carries the key would be ignored, so it is rejected rather than left as a silent no-op.
    if (obj.eodCloseTime != null) {
        if (label !== 'settings') {
            errors.push(`${label}.eodCloseTime is now a global setting - move it to settings.eodCloseTime and remove it from the strategy block (the strategy-level key is ignored)`);
        } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(obj.eodCloseTime))) {
            errors.push(`${label}.eodCloseTime must be 'HH:mm' (24-hour), got ${JSON.stringify(obj.eodCloseTime)}`);
        }
    }

    // eodReconcileTime: global only ('HH:mm', 24-hour); the end-of-day sync books what the brokers did during the day, so it must not be set before
    // the 15:30 close.
    if (obj.eodReconcileTime != null) {
        if (label !== 'settings') {
            errors.push(`${label}.eodReconcileTime is a global setting - move it to settings.eodReconcileTime`);
        } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(obj.eodReconcileTime))) {
            errors.push(`${label}.eodReconcileTime must be 'HH:mm' (24-hour), got ${JSON.stringify(obj.eodReconcileTime)}`);
        } else if (String(obj.eodReconcileTime) < '15:30') {
            errors.push(`${label}.eodReconcileTime must be at or after the 15:30 market close, got ${JSON.stringify(obj.eodReconcileTime)}`);
        }
    }

    // Demo replay (settings only): a bad date/speed would leave /demo silently empty, so reject it when the config is written.
    if (obj.demoReplay != null || obj.demoReplayDate != null || obj.demoReplaySpeed != null || obj.demoReplayDir != null) {
        if (label !== 'settings') {
            errors.push(`${label}.demoReplay* keys are global settings - move them to settings`);
        } else {
            if (obj.demoReplay != null && typeof obj.demoReplay !== 'boolean') errors.push(`${label}.demoReplay must be true or false, got ${JSON.stringify(obj.demoReplay)}`);
            if (obj.demoReplay === true && !/^[A-Za-z]{3}-\d{2}$/.test(String(obj.demoReplayDate ?? ''))) {
                errors.push(`${label}.demoReplayDate must look like 'Nov-13' when demoReplay is true, got ${JSON.stringify(obj.demoReplayDate)}`);
            }
            if (obj.demoReplaySpeed != null && !(isNum(obj.demoReplaySpeed) && obj.demoReplaySpeed > 0 && obj.demoReplaySpeed <= 1000)) {
                errors.push(`${label}.demoReplaySpeed must be a number > 0 and <= 1000, got ${JSON.stringify(obj.demoReplaySpeed)}`);
            }
        }
    }
    // eodEmailTestRecipient: one plain address; a list or a malformed value would send the test emails nowhere.
    if (obj.eodEmailTestRecipient != null) {
        if (label !== 'settings') errors.push(`${label}.eodEmailTestRecipient is a global setting - move it to settings`);
        else if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(obj.eodEmailTestRecipient))) errors.push(`${label}.eodEmailTestRecipient must be one email address, got ${JSON.stringify(obj.eodEmailTestRecipient)}`);
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
        // Every strategy names its brokers explicitly; the single-broker key is removed.
        if (s.broker !== undefined) errors.push(`${s.type}${s.userId ? ':' + s.userId : ''}: the broker key is REMOVED - use brokers: [...]`);
        if (!Array.isArray(s.brokers) || s.brokers.length === 0) errors.push(`${s.type}${s.userId ? ':' + s.userId : ''}.brokers is required (a non-empty list, e.g. [kite])`);
        else for (const b of s.brokers) if (!isBrokerName(b)) errors.push(`${s.type}${s.userId ? ':' + s.userId : ''}.brokers has an unknown broker ${JSON.stringify(b)}`);
        if (s.type === 'BulkPcrStrategy') {
            // Required, not defaulted at the read site: a missing quantity once fell back to a hidden size that bought about 215 lots.
            for (const field of ['quantity', 'targetPoints', 'slDistance']) {
                if (!isNum(s[field])) errors.push(`${s.type}.${field} is required for an enabled strategy (got ${JSON.stringify(s[field])})`);
            }
            if (s.index !== 'NIFTY' && s.index !== 'SENSEX') errors.push(`${s.type}.index must be NIFTY or SENSEX (got ${JSON.stringify(s.index)})`);
        }
        // Same reasoning for the other strategies that size a live order from their own config: a missing quantity used to fall back to a
        // hidden 65 (a NIFTY lot) - wrong for a SENSEX Butterfly (lot 20) and for any size the operator never chose.
        const requiredByType: Record<string, string[]> = { HourlyStrategy: ['quantity'], ButterflyStrategy: ['quantity', 'targetPoints', 'stopLossPoints'], SimpleContinuousStrategy: ['initialQuantity', 'maxInvestment', 'priceDiff'], ScaledHedgedStrategy: ['initialQuantity', 'maxInvestment', 'priceDiff'] };
        // Strategies that take their target and stop from the global exits: each must be set in the block or in settings (a value or 'none').
        // An absent key is refused rather than read as "no stop" (strategies/exitRules.ts).
        if (s.type === 'RuleBasedStrategy' || s.type === 'MomentumAtFixedTimeStrategy' || s.type === 'NextWeekStrategy' || s.type === 'BreakoutStrategy') {
            for (const key of ['target', 'stopLoss', ...(s.type === 'RuleBasedStrategy' ? ['maxHoldTimeMinutes'] : [])]) {
                const set = (o: any) => o?.[key] !== undefined && o?.[key] !== null;
                if (!set(s) && !set(parsed.settings)) errors.push(`${s.type}.${key} is not set in the block or in settings (give a value, or 'none')`);
            }
        }
        if (s.type === 'MomentumAtFixedTimeStrategy') {
            // Sized at runtime from maxInvestment (per broker); a quantity key is not read and must not be set.
            if (s.quantity !== undefined) errors.push(`${s.type}.quantity is not used - size with maxInvestment (per broker)`);
            if (!isNum(s.maxInvestment)) errors.push(`${s.type}.maxInvestment is required for an enabled strategy`);
            if (!Array.isArray(s.times) || s.times.some((t: any) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t)))) errors.push(`${s.type}.times must be a list of HH:mm times`);
        }
        if (s.type === 'NextWeekStrategy' || s.type === 'BreakoutStrategy') {
            // A fixed quantity per broker (whole lots), not a rupee budget.
            if (!isNum(s.quantity) || !(s.quantity > 0) || !Number.isInteger(s.quantity) || s.quantity % INDEX_LOT_SIZE.NIFTY !== 0) errors.push(`${s.type}.quantity must be a positive multiple of the NIFTY lot size ${INDEX_LOT_SIZE.NIFTY} (per broker; got ${JSON.stringify(s.quantity)})`);
            if (s.index !== undefined && s.index !== 'NIFTY') errors.push(`${s.type}.index must be NIFTY (got ${JSON.stringify(s.index)})`);
        }
        // maxProfit is an AMOUNT in rupees for SimpleContinuous (the other strategies' maxProfit is a percent of maxInvestment): a '%' string
        // or a non-positive number is rejected, and the key is required (no default in code).
        if ((s.type === 'SimpleContinuousStrategy' || s.type === 'ScaledHedgedStrategy') && s.maxProfit !== undefined && !(typeof s.maxProfit === 'number' && Number.isFinite(s.maxProfit) && s.maxProfit > 0)) {
            errors.push(`${s.type}.maxProfit must be a positive number of rupees, not a percent (got ${JSON.stringify(s.maxProfit)})`);
        }
        // Their maxProfit is the block's own value, or else settings.maxProfit (one number of rupees) must be set: one error per block.
        if ((s.type === 'SimpleContinuousStrategy' || s.type === 'ScaledHedgedStrategy') && s.maxProfit === undefined) {
            const g = parsed.settings?.maxProfit;
            if (!(typeof g === 'number' && Number.isFinite(g) && g > 0)) errors.push(`${s.type}.maxProfit is not set in the block and settings.maxProfit is not a positive number of rupees`);
        }
        for (const field of requiredByType[s.type] ?? []) {
            if (!isNum(s[field])) errors.push(`${s.type}.${field} is required for an enabled strategy (got ${JSON.stringify(s[field])})`);
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
