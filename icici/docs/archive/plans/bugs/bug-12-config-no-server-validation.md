# Bug: No server-side /config validation

## Problem

`POST /config` writes the posted body straight to `config.yml` with no
range/sanity checks at all. A direct API call (bypassing whatever UI exists)
can set a negative `lossLimit`, a negative/zero `quantity`, an inverted
`stopLossPoints`/`targetPoints` pair, an out-of-range percentage, etc., and it
will be persisted and picked up by every strategy/monitor that reads
`ConfigService.getConfig()`.

**Correction to the original bug report's file paths, made during
investigation — read this before touching any file:**

- The bug report cites `src/tools/ConfigService.ts:41-45`. That file does not
  exist. The real file is **`src/prism/ConfigService.ts`**, and lines 41-45
  there are indeed the `flatToConfig` method (the file path was wrong, the
  line numbers happened to be right).
- The bug report describes the POST body as a `{ key, type, value }` triple
  (implying one field is posted per request, with `type` meaning a
  JS-value-type discriminator like `'number'`/`'boolean'`/`'string'`). **That
  is not how this endpoint works.** `POST /config`'s body is the **entire
  flat config object** in one shot — `{ settings: {...}, buySellStrategy:
  {...}, goodMorningStrategy: {...}, ... }` — and `v.type` in
  `flatToConfig`'s filter (`typeof v.type === 'string'`) refers to a
  *strategy's* `type` field (e.g. `"GoodMorningStrategy"`), not a
  value-type tag. Confirmed by reading `src/prism/AppConfig.ts`,
  `config.yml`, and the frontend's `src/pages/AdminPage.tsx` (line 344-349:
  `fetch('/config', { method: 'POST', body: JSON.stringify(config) })` where
  `config` is the *whole* object returned by `GET /config`, mutated in place
  field-by-field as the user edits form controls, then autosaved as one
  full-object POST on any change — see `AdminPage.tsx` lines 359-371).

This full-object-per-request shape actually **simplifies** the cross-field
`stopLossPoints`/`targetPoints` check the bug report asks for: both values
for a given strategy arrive in the *same* request, in the *same* nested
object, so no "read the other field's currently-persisted value" plumbing is
needed to compare them *if the request is introducing or changing both — see
"Fix design" below for why a persisted-value comparison is still needed for
one specific reason (protecting already-saved legacy data), which is not the
same reason the bug report assumed.*

## Root cause (exact files/lines)

**`src/server.ts`, lines 1352-1356** (confirmed unchanged from the bug
report):

```typescript
app.post('/config', (req, res) => {
    const flat = req.body;
    configService.writeConfig(configService.flatToConfig(flat));
    res.json(flat);
});
```

**`src/prism/ConfigService.ts`, lines 41-45** (the `flatToConfig` method —
this is the only "validation" that exists today, and it only decides which
top-level keys count as strategy entries; it checks nothing about value
ranges):

```typescript
  public flatToConfig(flat: Record<string, any>): AppConfig {
    const { settings, ...rest } = flat;
    const strategies = Object.values(rest).filter((v): v is StrategyInstanceConfig => !!v && typeof v.type === 'string');
    return { settings, strategies } as AppConfig;
  }
```

Between these two, nothing ever inspects an individual field's value before
`writeFileSync`ing it to `config.yml` (see `writeConfig`, lines 23-25 of the
same file).

## Investigation: config shape and which fields need constraints

`GET /config` returns, and `POST /config` accepts, an object shaped like
`config.yml` (see `/home/karthikeyan/work/icici/config.yml` and
`src/prism/AppConfig.ts`):

```yaml
settings:
  minPrice: 20
  maxPrice: 30000
  targetPriceDiff: 2
  stopLossPriceDiff: 11
  trailingDistance: 4
  cooldownSeconds: 0
  logQuotes: false
  safetyBufferAmount: 5000
  consistencyLimitPercent: 40
  maxDailyDrawdownPercent: 25
  maxMonthlyDrawdownPercent: 50
  maxTradesPerDay: 10
strategies:
  - type: SentimentStrategy
    ... (11 strategy blocks total, each with its own field set)
```

`ConfigService.configToFlat()` turns the `strategies` array into a flat map
keyed by `type` lower-camel-cased (`SentimentStrategy` → `sentimentStrategy`,
`GoodMorningStrategy` → `goodMorningStrategy`, etc.) — that is exactly the
shape `POST /config`'s body arrives in.

**Fields with an evidenced numeric-range constraint** (checked by reading
every place each field is read/used — `src/monitor.ts`, `src/orderList.ts`,
`src/processes/order/*.ts`, `src/strategy/*.ts`, `src/payout.ts`):

| Field(s) | Where used / evidence | Constraint |
|---|---|---|
| `lossLimit`, `lotLimit`, `maxInvestment` (per-strategy, optional on `StrategyInstanceConfig`) | `src/monitor.ts` / `src/processes/order/bookkeeping.ts` — loss-limit thresholds and capital caps compared directly against P&L/position value | `>= 0` |
| `quantity`, `orderQuantity`, `initialQuantity`, `incrementQuantity` | Passed straight through as broker order quantity (e.g. `src/processes/order/antExecutor.ts`, `zerodhaExecutor.ts`) — a `<= 0` order size is meaningless/would be rejected by the broker | `> 0` |
| `targetPoints`, `stopLossPoints` (GoodMorningStrategy, GoodMorningSensexStrategy, SupportResistanceStrategy, TargetReachStrategy), `targetPrice`, `stopLossPrice` (RateOfChangeStrategy, GapStrategy), `target`, `stopLoss` (RuleBasedStrategy) | Used as `trade.price + X` / `trade.price - X` in `src/monitor.ts` (`setTargetStopLoss`), `antExecutor.ts`, `zerodhaExecutor.ts` — a negative distance inverts win/loss logic | `>= 0` each |
| `minPrice`, `maxPrice` (settings) | `src/orderList.ts` lines 5-7: `price >= minPrice && price <= maxPrice` (a range filter) | `minPrice >= 0`, `maxPrice >= 0`, `minPrice <= maxPrice` |
| `targetPriceDiff`, `stopLossPriceDiff`, `trailingDistance` (settings) | `src/strategy/strategy.ts` `getMonitorConfig()`, `src/monitor.ts` trailing-stop math | `>= 0` each |
| `cooldownSeconds` (settings and per-strategy on ContinuousStrategy) | Used as a delay/interval | `>= 0` |
| `safetyBufferAmount` (settings) | `src/payout.ts` — minimum all-time profit before first payout | `>= 0` |
| `consistencyLimitPercent`, `maxDailyDrawdownPercent`, `maxMonthlyDrawdownPercent` (settings) | Percent-of-profit / drawdown thresholds | `0..100` |
| `maxTradesPerDay` (settings) | Trade count cap | `>= 0` |
| `slDistance`, `minPremium`, `allottedCapital`, `refillCancelDistance` (ContinuousStrategy) | Distance/capital amounts, always used as positive quantities in the strategy's own math | `>= 0` |
| `pointsThreshold`, `accelerationThreshold`, `numberOfDatapointsReceived`, `maxHoldTimeMinutes`, `gapReversalThreshold` (RateOfChangeStrategy/GapStrategy) | Threshold/count/duration values | `>= 0` |
| `averageThreshold`, `threshold`, `loopCount`, `activateIntermittentCount`, `maxIterationCount`, `minMovementPoints` (various strategies) | Threshold/count values | `>= 0` |

**Deliberately excluded** (evidenced as using `0` as a real "not yet set"
sentinel in current data, so a `>= 0` constraint would be vacuous and a `> 0`
constraint would be wrong): `supportPrice`, `resistancePrice`, `strike` — all
`0` in `config.yml` today for `SupportResistanceStrategy`/`TargetReachStrategy`.
Also excluded: `previousClose` (a raw index price, no constraint evidenced
beyond "some positive number" which isn't precise enough to encode safely).

**Cross-field constraint — `stopLossPoints`/`targetPoints` (and the
`targetPrice`/`stopLossPrice` and `target`/`stopLoss` field-name variants
used by other strategies for the same concept):**

**Important finding — do not skip this:** the literal rule "reject when
`stopLossPoints >= targetPoints`" (i.e. require `targetPoints >
stopLossPoints`), if applied unconditionally to every strategy block on every
`POST /config`, **breaks the app against the actual current `config.yml`**:

- `GoodMorningStrategy`: `targetPoints: 10, stopLossPoints: 10` (equal — violates the rule)
- `GoodMorningSensexStrategy`: `targetPoints: 30, stopLossPoints: 30` (equal — violates the rule)
- `SupportResistanceStrategy`: `targetPoints: 10, stopLossPoints: 15` (stop > target — violates the rule)
- `TargetReachStrategy`: `targetPoints: 10, stopLossPoints: 15` (stop > target — violates the rule)

Because `AdminPage.tsx` autosaves the **entire** config object on *any* form
edit (not just the field the user touched — see lines 344-349/359-371), an
unconditional cross-field rule would make it impossible to save *any* config
change at all until those four blocks are hand-edited in `config.yml`, which
is a live-trading risk-parameter change well outside the scope of this bug
(changing `stopLossPoints` on `SupportResistanceStrategy`/`TargetReachStrategy`,
both at `quantity: 1755`, changes real money at risk in a live system).

**Resolution used in this fix:** the cross-field check is real and enforced,
but only applied to a strategy block **when the request is actually changing
`targetPoints` and/or `stopLossPoints` (or the `targetPrice`/`stopLossPrice`
or `target`/`stopLoss` equivalents) away from what's currently persisted**.
An unmodified legacy block that merely gets echoed back unchanged by the
Admin UI's full-object autosave is left alone (grandfathered); a request that
actively sets a *new* bad combination — for either a brand-new strategy block
or an edit to an existing one — is rejected. This requires reading the
current persisted value to compare against (via
`configService.configToFlat()`, called once per request, *before* writing),
which is the one place a "read the other side" step is genuinely needed —
not because of how the request body is structured (both fields are in the
one request already), but to avoid retroactively invalidating already-saved
data this validation didn't exist to check when it was written.

This same "diff against persisted value" pattern is **not** applied to
`settings.targetPriceDiff`/`settings.stopLossPriceDiff` — those are
differently-named fields (order-default point diffs, not a strategy's own
risk template) and the current settings block (`targetPriceDiff: 2,
stopLossPriceDiff: 11`) already contradicts a naive "target > stop" reading,
so no such rule is invented for that pair. Only the three named
strategy-level pairs get the cross-field check.

`minPrice <= maxPrice` (settings) has no such conflict in current data
(`20 <= 30000`), so it is validated unconditionally, every request, no
diffing needed.

## Fix design

1. New file **`src/prism/configValidation.ts`** (co-located with
   `ConfigService.ts`, which lives in `src/prism/` not `src/tools/`) exports
   three pure functions:
   - `validateNumericRanges(label: string, obj: Record<string, any>): string[]`
     — the single-field non-negative / positive-quantity / percent / and
     (when both present in the same `obj`) `minPrice <= maxPrice` checks.
     Returns an array of human-readable error strings (empty = valid).
   - `validateTargetVsStopLoss(label: string, obj: Record<string, any>): string[]`
     — checks all three `[target, stop]` field-name pairs
     (`targetPoints`/`stopLossPoints`, `targetPrice`/`stopLossPrice`,
     `target`/`stopLoss`) **unconditionally within a single object** — if
     both members of a pair are present as numbers in `obj`, `stop >= target`
     is an error. This is the function the required unit test calls directly.
   - `validateFlatConfig(flat: Record<string, any>, current: Record<string, any>): string[]`
     — the entry point used by the live endpoint. Runs
     `validateNumericRanges` on `flat.settings` and on every other top-level
     key's object; runs `validateTargetVsStopLoss` on every non-settings key
     **only when at least one field of a pair differs from `current[key]`'s
     value for that field** (the grandfathering behavior described above).
     `current` is expected to be `configService.configToFlat()`'s return
     value, called by the caller before validating.

2. `src/server.ts`'s `POST /config` handler calls
   `validateFlatConfig(flat, configService.configToFlat())` before doing
   anything else. On a non-empty error list, respond
   `res.status(400).json({ error: errors.join('; ') })` — this exact
   `res.status(400).json({ error: '...' })` shape is already used elsewhere
   in `server.ts` (e.g. line 1362: `res.status(400).json({ error: 'date
   query param required' })`, and lines 864-866: `res.status(400).json({
   error: 'Missing token, targetPoints, or stopLossPoints' })`), so this
   fix matches the file's existing convention rather than inventing a new
   response shape. Only when there are no errors does it proceed to
   `configService.writeConfig(configService.flatToConfig(flat))`.

3. No changes to `ConfigService.ts` itself — `configToFlat()` and
   `flatToConfig()` are reused as-is; validation is a separate module
   invoked from `server.ts`, keeping `ConfigService.ts`'s existing structure
   untouched per the "keep the change minimal" guidance.

## Exact code changes

### File: `src/prism/configValidation.ts` (new file)

Create this file with exactly this content:

```typescript
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
```

### File: `src/server.ts`

**Step 1.** Add an import. Locate the existing import (currently line 21):

```typescript
import configService from './prism/ConfigService';
```

Change it to two lines (add the new import immediately after):

```typescript
import configService from './prism/ConfigService';
import { validateFlatConfig } from './prism/configValidation';
```

**Step 2.** Replace the `POST /config` handler. Locate the current block
(currently lines 1352-1356):

Before:
```typescript
app.post('/config', (req, res) => {
    const flat = req.body;
    configService.writeConfig(configService.flatToConfig(flat));
    res.json(flat);
});
```

After:
```typescript
app.post('/config', (req, res) => {
    const flat = req.body;
    const current = configService.configToFlat();
    const errors = validateFlatConfig(flat, current);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join('; ') });
    }
    configService.writeConfig(configService.flatToConfig(flat));
    res.json(flat);
});
```

Do not change the `GET /config` handler immediately above it (lines
1348-1350):

```typescript
app.get('/config', (req, res) => {
    res.json(configService.configToFlat());
});
```

No other changes to `src/server.ts` or `src/prism/ConfigService.ts` are
needed for this fix.

## New test file

Create `src/test/configValidation.test.ts` with exactly this content:

```typescript
/**
 * Verifies POST /config's server-side validation (src/prism/configValidation.ts)
 * rejects a negative lossLimit, a non-positive quantity, and an inverted
 * stopLossPoints/targetPoints pair, while still accepting a valid config
 * update - and that the target/stop-loss cross-field check grandfathers an
 * already-persisted (pre-validation) bad pair left unchanged, but still
 * rejects a request that actively introduces a new bad pair.
 * Run: npm run build (compile), then: node ./dist/test/configValidation.test.js
 */

import { validateNumericRanges, validateTargetVsStopLoss, validateFlatConfig } from '../prism/configValidation';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    // --- negative lossLimit is rejected ---
    const negLossLimitErrors = validateNumericRanges('testStrategy', { lossLimit: -100 });
    assert(negLossLimitErrors.length > 0, `negative lossLimit is rejected (errors: ${JSON.stringify(negLossLimitErrors)})`);

    // --- negative quantity is rejected ---
    const negQuantityErrors = validateNumericRanges('testStrategy', { quantity: -5 });
    assert(negQuantityErrors.length > 0, `negative quantity is rejected (errors: ${JSON.stringify(negQuantityErrors)})`);

    // --- zero quantity is also rejected (must be > 0, not just >= 0) ---
    const zeroQuantityErrors = validateNumericRanges('testStrategy', { quantity: 0 });
    assert(zeroQuantityErrors.length > 0, `zero quantity is rejected (errors: ${JSON.stringify(zeroQuantityErrors)})`);

    // --- stopLossPoints >= targetPoints is rejected ---
    const invertedErrors = validateTargetVsStopLoss('testStrategy', { targetPoints: 10, stopLossPoints: 10 });
    assert(invertedErrors.length > 0, `stopLossPoints >= targetPoints (10 >= 10) is rejected (errors: ${JSON.stringify(invertedErrors)})`);

    const invertedErrors2 = validateTargetVsStopLoss('testStrategy', { targetPoints: 10, stopLossPoints: 15 });
    assert(invertedErrors2.length > 0, `stopLossPoints > targetPoints (15 > 10) is rejected (errors: ${JSON.stringify(invertedErrors2)})`);

    // --- a valid config update passes ---
    const validRangeErrors = validateNumericRanges('testStrategy', { lossLimit: 15000, quantity: 65, minPrice: 20, maxPrice: 150 });
    assert(validRangeErrors.length === 0, `a valid range-only config passes (errors: ${JSON.stringify(validRangeErrors)})`);

    const validPairErrors = validateTargetVsStopLoss('testStrategy', { targetPoints: 10, stopLossPoints: 5 });
    assert(validPairErrors.length === 0, `a valid targetPoints > stopLossPoints pair passes (errors: ${JSON.stringify(validPairErrors)})`);

    // --- validateFlatConfig: grandfathers an unchanged legacy bad pair ---
    // Mirrors this repo's actual config.yml today: GoodMorningStrategy has
    // targetPoints:10, stopLossPoints:10 (equal, technically invalid) already
    // persisted before this validation existed. Re-posting it UNCHANGED
    // (e.g. the Admin UI's full-object autosave after an unrelated edit
    // elsewhere) must not be blocked.
    const currentFlat = {
        settings: { minPrice: 20, maxPrice: 30000 },
        goodMorningStrategy: { type: 'GoodMorningStrategy', enabled: false, quantity: 65, targetPoints: 10, stopLossPoints: 10 },
    };
    const repostUnchanged = validateFlatConfig(currentFlat, currentFlat);
    assert(repostUnchanged.length === 0, `re-posting an unchanged legacy bad target/stopLoss pair is grandfathered, not rejected (errors: ${JSON.stringify(repostUnchanged)})`);

    // --- validateFlatConfig: still rejects a NEW bad pair introduced by this request ---
    const newBadPairFlat = {
        settings: { minPrice: 20, maxPrice: 30000 },
        goodMorningStrategy: { type: 'GoodMorningStrategy', enabled: false, quantity: 65, targetPoints: 5, stopLossPoints: 10 },
    };
    const rejectedNewChange = validateFlatConfig(newBadPairFlat, currentFlat);
    assert(rejectedNewChange.length > 0, `a request that CHANGES targetPoints/stopLossPoints into a bad pair is rejected (errors: ${JSON.stringify(rejectedNewChange)})`);

    // --- validateFlatConfig: a fully valid full-payload update passes cleanly ---
    const validFullFlat = {
        settings: { minPrice: 20, maxPrice: 30000, consistencyLimitPercent: 40 },
        goodMorningStrategy: { type: 'GoodMorningStrategy', enabled: true, quantity: 65, targetPoints: 10, stopLossPoints: 5 },
    };
    const validFullErrors = validateFlatConfig(validFullFlat, currentFlat);
    assert(validFullErrors.length === 0, `a fully valid full config payload passes with no errors (errors: ${JSON.stringify(validFullErrors)})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

## Verification steps for orchestrator

Run these exact commands from the repo root:

```bash
cd /home/karthikeyan/work/icici

# 1. Typecheck only (fast, no dist/ output) - must be clean.
npx tsc --noEmit

# 2. Full compile to dist/ (this repo has no `npm run build` script - use tsc
#    directly, matching the existing test files' own run instructions).
npx tsc

# 3. Run the new test directly (no jest - hand-rolled script convention).
node ./dist/test/configValidation.test.js
echo "exit code: $?"
```

Expected output from step 3: exactly these lines (order will match the
order the `assert()` calls appear in the file above), followed by
`ALL TESTS PASSED`:

```
  PASS: negative lossLimit is rejected (errors: ["testStrategy.lossLimit must be >= 0 (got -100)"])
  PASS: negative quantity is rejected (errors: ["testStrategy.quantity must be > 0 (got -5)"])
  PASS: zero quantity is rejected (errors: ["testStrategy.quantity must be > 0 (got 0)"])
  PASS: stopLossPoints >= targetPoints (10 >= 10) is rejected (errors: ["testStrategy.stopLossPoints (10) must be less than testStrategy.targetPoints (10)"])
  PASS: stopLossPoints > targetPoints (15 > 10) is rejected (errors: ["testStrategy.stopLossPoints (15) must be less than testStrategy.targetPoints (10)"])
  PASS: a valid range-only config passes (errors: [])
  PASS: a valid targetPoints > stopLossPoints pair passes (errors: [])
  PASS: re-posting an unchanged legacy bad target/stopLoss pair is grandfathered, not rejected (errors: [])
  PASS: a request that CHANGES targetPoints/stopLossPoints into a bad pair is rejected (errors: ["goodMorningStrategy.stopLossPoints (10) must be less than goodMorningStrategy.targetPoints (5)"])
  PASS: a fully valid full config payload passes with no errors (errors: [])
ALL TESTS PASSED
```
followed by `exit code: 0`.

If any `FAIL:` line appears, or if `npx tsc --noEmit`/`npx tsc` report
compile errors, or the test exits non-zero, the change is not done — do not
mark this bug fixed:

- If the grandfathering test (`re-posting an unchanged legacy...`) fails,
  the diff comparison in `validateFlatConfig` (`incoming[targetField] !==
  prev[targetField] || incoming[stopField] !== prev[stopField]`) is wrong —
  re-check it reads from `current[key]`, not `flat[key]` itself, for `prev`.
- If the "new bad pair" test does NOT get rejected, the diff check is
  incorrectly treating the change as unchanged — re-verify `prev` in that
  test scenario truly has `targetPoints: 10, stopLossPoints: 10` (from
  `currentFlat`) while `incoming` has `targetPoints: 5, stopLossPoints: 10`,
  which do differ.
- Exact error message strings matter for the PASS/FAIL comparison above only
  in the sense that the test asserts `errors.length > 0` / `=== 0`, not
  exact string equality — so cosmetic message wording differences are fine
  as long as the truthiness/length assertions match. Do not "fix" a FAIL by
  editing the test's message text; find the logic bug in
  `configValidation.ts` instead.

### Manual smoke check (optional, confirms the live endpoint end-to-end)

Only run this if a server instance is already up on port 3000 per this
repo's normal dev workflow (`npm run server`) — do not start one solely for
this check, and do not leave a server you started running afterward:

```bash
curl -s -X POST http://localhost:3000/config \
  -H 'Content-Type: application/json' \
  -d '{"goodMorningStrategy":{"type":"GoodMorningStrategy","enabled":false,"quantity":-5,"targetPoints":10,"stopLossPoints":10}}'
```

Expected: HTTP 400 with a JSON body like
`{"error":"goodMorningStrategy.quantity must be > 0 (got -5)"}` (message
text may include additional `; `-joined errors for the same request, e.g.
the equal target/stopLoss pair if it counts as "changed" relative to the
live server's currently-persisted config) — and, importantly,
`config.yml` on disk must be unchanged (this repo is not a git repository,
so verify by re-running `curl -s http://localhost:3000/config` before and
after and comparing the two responses) since the write must not happen when
validation fails.

## Files touched

| File | Change |
|---|---|
| `/home/karthikeyan/work/icici/src/prism/configValidation.ts` (new) | New module exporting `validateNumericRanges`, `validateTargetVsStopLoss`, `validateFlatConfig` — see full content above. |
| `/home/karthikeyan/work/icici/src/server.ts` | Add `import { validateFlatConfig } from './prism/configValidation';` after the existing `configService` import (currently line 21). Replace the `POST /config` handler (currently lines 1352-1356) to call `validateFlatConfig(flat, configService.configToFlat())` first and return `res.status(400).json({ error: errors.join('; ') })` on any validation error, before the existing `configService.writeConfig(...)` call. `GET /config` is untouched. |
| `/home/karthikeyan/work/icici/src/test/configValidation.test.ts` (new) | New hand-rolled test (no jest), matching `src/test/bookkeepingDedup.test.ts`'s convention, covering: negative `lossLimit`, negative and zero `quantity`, an inverted `stopLossPoints`/`targetPoints` pair (both equal and strictly inverted), a valid single-object pass, and three `validateFlatConfig` scenarios (grandfathered legacy pair, newly-introduced bad pair rejected, fully valid full payload passes). |

Out of scope / explicitly not done by this fix:
- `src/prism/ConfigService.ts` is not modified — `configToFlat`/`flatToConfig`
  are reused as-is.
- `config.yml` is not modified. The four strategy blocks that already
  violate a naive `stopLossPoints < targetPoints` reading
  (`GoodMorningStrategy`, `GoodMorningSensexStrategy`,
  `SupportResistanceStrategy`, `TargetReachStrategy`) are left as live,
  working, grandfathered config — changing their actual risk parameters is a
  trading/business decision outside this bug's scope, not a validation bug.
- No change to `settings.targetPriceDiff`/`settings.stopLossPriceDiff` cross-
  field behavior — see "Investigation" above for why that pair is
  deliberately not given the same cross-field rule as the three
  strategy-level pairs.
- No frontend (`frontend/src/pages/AdminPage.tsx`) changes — this bug and
  fix are server-side only, matching the bug report's scope ("server-side
  `/config` validation").
