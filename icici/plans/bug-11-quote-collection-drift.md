# Bug: Quote collection name drift

## Problem

Live NIFTY/SENSEX/option ticks from ANT are persisted to the Mongo collection
`NiftyQuote` (and `SensexQuote`/`OptionQuote`), but three read paths query a
collection literally named `Quote` instead:

- `GET /replay` in `src/server.ts` (line 1365)
- `src/tools/pipeline.ts` (line 329)
- `src/prism/MockAPI.ts` (lines 52 and 71)

Because nothing in the currently-checked-out codebase writes to a collection
named `Quote` today (see "Root cause" below), `GET /replay?date=<today>`
returns a 404 (`no quotes for date ...`) even on a day where live ticks were
actually recorded into `NiftyQuote`, and `pipeline.ts` / `MockAPI.ts` silently
operate on stale or empty data instead of the live tick history.

**Important scope note discovered during investigation (read before making
any change):** the collection-name mismatch is real and must be fixed exactly
as described below. But fixing *only* the collection name is not sufficient
to make `GET /replay?date=<today>` actually return data, because of a second,
independent problem: neither `Quote` nor `NiftyQuote` documents have a
literal `date` field, and `/replay` / `pipeline.ts` query on `{ date }`
verbatim. This plan fixes both issues together (see "Fix design"). The
"Investigation findings" section further down documents exactly what was
verified and why, including a real discrepancy between what this source tree
writes and what a synced-from-production `Quote` collection actually
contains locally — read it before rolling this out, but it does not change
what code to write.

## Root cause (exact files/lines)

**Live writer (writes `NiftyQuote`, `SensexQuote`, `OptionQuote` — all
correct, do not touch):**

- `src/model/model.ts` lines 53-69: `NiftyQuote.fromAnt(response)` builds a
  `new NiftyQuote()` instance (class declared at line 4, fields: `token`,
  `ltp`, `ltt`, `open`, `high`, `low`, `close`, `prevClose`, `volume`,
  `buyQty`, `sellQty`, `changePercent`; `fromAnt` only sets `token`, `ltp`,
  `ltt`, `prevClose`, `changePercent` — the rest stay `undefined`, matching
  the comment at model.ts:48-50 that ANT touchline ticks are partial
  updates).
- `src/ant/AntStream.ts` line 183: `Mongo.getInstance()?.insert(NiftyQuote.fromAnt(data));`
- `src/processes/data/AntDataStream.ts` line 143: same call.
- `src/tools/mongo.ts` lines 62-64:
  ```typescript
  insert = async (obj) => {
      await this.db.collection(obj.constructor.name).insertOne(obj)
  }
  ```
  `Mongo.insert()` derives the collection name from the JS class name of the
  object passed in. Since the object is `new NiftyQuote()`, this writes to a
  collection literally named `NiftyQuote` (confirmed — `NiftyQuote` is one of
  the collections that exists in the local `stocks` database).

**Readers (query the wrong collection name — these are what this plan
fixes):**

- `src/server.ts` line 1365: `db.collection('Quote').find({ date })...`
- `src/tools/pipeline.ts` line 329: `db.collection('Quote').find(query)...`
- `src/prism/MockAPI.ts` line 52: `db.collection('Quote').findOne(query, ...)`
- `src/prism/MockAPI.ts` line 71: `db.collection('Quote').find(query)...`

**`src/trade/icici.ts` line 83 (`class Quote { ... }`) is NOT actually the
writer of a collection named `Quote` — this is a correction to the bug
report's premise, confirmed by direct investigation:**

- `icici.ts`'s `class Quote` (lines 83-119) is a scraping DAO with methods
  `extractQuote`/`saveQuote`/`extract`/`close` — it is not itself a data
  record.
- `saveQuote()` (lines 103-108):
  ```typescript
  async saveQuote(symbol, rows, date, time) {
      const quote = this.extractQuote(symbol, rows, date, time)
      await Mongo.getInstance().insert(quote)
      return quote
  }
  ```
  Two bugs of its own here, unrelated to this fix (do not touch, out of
  scope): `extractQuote` is `async` but its return value is used without
  `await`, so `quote` is a `Promise`, not a `StockQuote` instance — meaning
  `Mongo.insert(quote)` would call `.constructor.name` on a `Promise` object
  (`"Promise"`), not `"Quote"` or `"StockQuote"`. Even ignoring the missing
  `await`, `extractQuote` (lines 85-100) explicitly constructs `new
  StockQuote()` (class declared lines 26-40), never `new Quote()` — so even a
  hypothetically-fixed version of this method would write to a collection
  named `StockQuote`, never `Quote`.
- Confirmed empirically: the local `stocks` Mongo database has a `StockQuote`
  collection with **0 documents**, and no `Quote()` instance is constructed
  anywhere in `src/` (`grep -rn "new Quote("` returns no hits). This path is
  genuinely dead/unreachable for populating a `Quote` collection.
- `saveQuote` is called from `icici.ts` line 387 inside a Selenium
  browser-scraping method chain (`icicinse` / `selenium-webdriver`) that is
  only reachable via `src/scheduler/scheduler.ts` (`import Icici from
  '../trade/icici'`) and `src/scheduler/stock-quote-collector.ts`
  (`icici.saveNiftyQuotes(null)` / `icici.saveStockQuotes()`). Neither
  `scheduler.ts` nor `stock-quote-collector.ts` is imported/invoked from
  `src/server.ts`, `src/orchestrator.ts`, or any `npm run` script that starts
  a live process (`server`, `processes`, `processes:once` — checked
  `package.json`) — this confirms the bug report's characterization of this
  path as legacy/unused for any live write today.

**Where the `Quote` collection's real (99k+ document) local data actually
comes from — read this, it matters for how you interpret "fixed":**

The local Mongo (`mongodb://localhost:27017/stocks`) has a real, richly
populated `Quote` collection (99,217 documents for the current date at
planning time), with documents shaped like:

```json
{ "ltp": 24128.95, "ltt": 1787888700, "token": "26000", "time": "2026-08-28 09:15:00", "index": "NIFTY" }
```

This is **not** written by anything in this checked-out `src/` tree — no
`grep` for this document shape (`time` + `index` fields together, or a
literal `.collection('Quote')` write) matches anything under `src/`.
`scripts/syncQuotes.sh` explains where it comes from: it's an
`mongodump`/`mongorestore` sync of collection `Quote` **from a remote host**
(`karthik@karthik`) into the local dev database — i.e. this data was produced
by whatever code is deployed/running on that remote host, which is evidently
a different revision than what's in this local checkout (it still writes a
collection named `Quote`, with a document shape — `time`/`index` fields, no
`prevClose`/`changePercent` — that doesn't match `NiftyQuote.fromAnt()`
either). Meanwhile, the local `NiftyQuote` collection that *this* checkout's
`AntStream.ts`/`AntDataStream.ts` write to has **0 documents** locally (the
live ANT stream has apparently never run to completion on this dev machine).

**Practical implication — flag this to whoever rolls this out, it is not
something this plan can fix by itself:** after this fix is applied, readers
will query `NiftyQuote`. That collection will only be populated once *this
checkout's* live ANT stream process (`AntStream.ts` / `AntDataStream.ts`) has
actually run and ingested ticks (locally, or wherever this exact code is
deployed) — it will **not** retroactively see the historical data currently
sitting in the local `Quote` collection (that data was produced by different,
older code on a different host, in a different, incompatible document
shape). This is expected and correct — the whole point of the fix is to stop
querying a collection that isn't `NiftyQuote`'s data — but don't be surprised
if `/replay` still 404s against a **local dev Mongo that has never run this
checkout's live ingest**; that's a data/environment gap, not a bug in the
fix. The verification steps below account for this by inserting a synthetic
document rather than depending on any pre-existing data.

## Fix design (approach + rationale)

**Direction: fix the readers, not the writer.** `NiftyQuote` is what this
codebase's actual, current live-tick write path (`AntStream.ts` /
`AntDataStream.ts` → `NiftyQuote.fromAnt()` → `Mongo.insert()`) produces.
Changing the writer to target `Quote` instead would be changing working,
correct code to match three broken readers — backwards. The three readers
are changed to query collection `NiftyQuote` instead of `Quote`.

**Document-shape compatibility — checked explicitly, and it is NOT a clean
drop-in swap:**

| Field | `NiftyQuote` (from `NiftyQuote.fromAnt()`, model.ts:53-69) | `Quote` (legacy `StockQuote`, icici.ts — dead, or the unrelated remote-synced data described above) |
|---|---|---|
| `token` | string (ANT token, e.g. `'26000'`) | present in the remote-synced data; absent from `StockQuote` |
| `ltp` | number | present in both |
| `ltt` | epoch seconds (ANT's `ft`, unparsed — type as received from the websocket JSON) | present in the remote-synced data as a Number |
| `date` | **absent** | **absent from both** — `StockQuote` never had it either; the remote-synced data has `time` (`"YYYY-MM-DD HH:mm:ss"` string), not `date` |
| `open`/`high`/`low`/`close`/`volume`/`buyQty`/`sellQty` | present as class fields but `undefined` for tick-derived docs (`fromAnt` doesn't set them) | `StockQuote` has similarly-named-but-different fields (`dayOpen`, `dayHigh`, etc.); irrelevant since this path is dead |
| `prevClose`/`changePercent` | present, computed by `fromAnt` | absent from both |

The only fields both the *existing reader code* (`server.ts`'s `/replay`,
`pipeline.ts`) actually consume are `ltt` and `ltp` (used via
`Number(q.ltt)`/`Number(q.ltp)`) — those two field **names** are identical
between what `NiftyQuote` actually has and what the readers expect, so no
reader-side field-name remapping is needed for the parsing logic itself
(`replayDecision._addPrice(Number(q.ltt), Number(q.ltp))` and
`buildCandles()`'s `Number(q.ltt)`/`Number(q.ltp)` — see
`src/lib/candle-builder.ts` lines 100-105 — both work unmodified against
`NiftyQuote` documents).

**What does need to change: the query filter itself**, because both
`server.ts`'s `/replay` and `pipeline.ts` filter with `{ date }` /
`{ date: DATE_FILTER }` — an equality match on a literal `date` field that
**does not exist on `NiftyQuote` documents** (confirmed: `NiftyQuote.fromAnt()`
never sets a `date` field; other current, working readers of `NiftyQuote` —
`src/tools/analyze.ts` line 153 and `src/tools/check_indicators.ts` line 18 —
both load with `find({})`, no date filter, precisely because there is no
`date` field to filter on). Simply swapping the collection name to
`NiftyQuote` while leaving `{ date }` as the filter would still return zero
rows and still 404 — the reported symptom would persist. So this plan also
replaces the `date`-equality filter with a day-bounds range filter computed
against `ltt` (the only timestamp `NiftyQuote` actually has), in the
exchange's timezone (`Asia/Kolkata` / IST — the same timezone this codebase
already uses elsewhere for trading-day logic, e.g. `src/index.ts` line 145,
`src/strategy/Minutes5Decision.ts` line 95, both via
`moment().tz('Asia/Kolkata')`).

A new shared helper file, `src/tools/quoteDateRange.ts`, centralizes this
logic (`dayBoundsIST(dateStr)` + `dateRangeQuery(dateStr)`) so `server.ts`,
`pipeline.ts`, and `MockAPI.ts` all compute the range identically instead of
each hand-rolling a slightly different version (avoiding exactly the kind of
inconsistency that caused this bug in the first place). The query uses
`$expr` + `$toDouble` on `ltt` rather than a plain `{ ltt: { $gte, $lt } }`
comparison, because `ltt`'s stored BSON type is not guaranteed — `fromAnt()`
assigns `quote.ltt = response.ft` with no `parseInt`/`parseFloat`, so it is
whatever type arrived over the ANT websocket's JSON payload (could be a
numeric string). `$toDouble` normalizes either a numeric string or a number
before the range comparison, so the filter is correct regardless.

## Exact code changes

### New file: `src/tools/quoteDateRange.ts`

Create this file with exactly this content:

```typescript
import moment from 'moment';
import 'moment-timezone';

// NiftyQuote/SensexQuote documents (written by NiftyQuote.fromAnt() /
// SensexQuote.fromAnt(), see src/model/model.ts, from src/ant/AntStream.ts
// and src/processes/data/AntDataStream.ts) do not carry a `date` field -
// only `ltt`, a Unix-epoch-seconds tick timestamp (ANT's `ft` field, stored
// as whatever type arrives over the websocket - see the $toDouble usage
// below). To filter by trading day, compute the day's [start, end) epoch-
// second bounds in IST (Asia/Kolkata - the exchange's timezone) and match
// `ltt` against that range instead of an equality match on a field that
// doesn't exist.

export interface DayBounds {
    start: number; // inclusive, Unix epoch seconds, 00:00:00 IST of dateStr
    end: number;   // exclusive, Unix epoch seconds, 00:00:00 IST of the next day
}

// dateStr must be 'YYYY-MM-DD'.
export function dayBoundsIST(dateStr: string): DayBounds {
    const start = moment.tz(dateStr, 'YYYY-MM-DD', 'Asia/Kolkata').startOf('day').unix();
    const end = moment.tz(dateStr, 'YYYY-MM-DD', 'Asia/Kolkata').add(1, 'day').startOf('day').unix();
    return { start, end };
}

// Mongo filter matching NiftyQuote/SensexQuote documents whose `ltt` falls
// within the given trading day (IST). Uses $expr + $toDouble because `ltt`
// may be stored as either a string or a number depending on write path -
// $toDouble normalizes both before the range comparison, so the filter is
// correct either way.
export function dateRangeQuery(dateStr: string): object {
    const { start, end } = dayBoundsIST(dateStr);
    return {
        $expr: {
            $and: [
                { $gte: [{ $toDouble: '$ltt' }, start] },
                { $lt: [{ $toDouble: '$ltt' }, end] },
            ],
        },
    };
}
```

### File: `src/server.ts`

**Step 1.** Locate the import block near the top (line 29):

Before:
```typescript
import Mongo from './tools/mongo';
```

After:
```typescript
import Mongo from './tools/mongo';
import { dateRangeQuery } from './tools/quoteDateRange';
```

(Insert the new import line immediately after the existing `import Mongo
from './tools/mongo';` line — do not reorder or touch any other import.)

**Step 2.** Locate the `/replay` route (current lines 1360-1376):

Before:
```typescript
app.get('/replay', async (req, res) => {
    const date = req.query.date as string;
    if (!date) return res.status(400).json({ error: 'date query param required' });

    const db = Mongo.getInstance().db;
    const quotes = await db.collection('Quote').find({ date }).sort({ ltt: 1 }).toArray();
    if (quotes.length === 0) return res.status(404).json({ error: `no quotes for date ${date}` });

    const replayDecision = new Decision();
    replayDecision.replayMode = true;
    for (const q of quotes) {
        replayDecision._addPrice(Number(q.ltt), Number(q.ltp));
    }
    replayDecision.flushCandles();

    res.json({ date, processed: quotes.length });
});
```

After:
```typescript
app.get('/replay', async (req, res) => {
    const date = req.query.date as string;
    if (!date) return res.status(400).json({ error: 'date query param required' });

    const db = Mongo.getInstance().db;
    // Live ticks are persisted to the 'NiftyQuote' collection (NiftyQuote.fromAnt(),
    // see src/model/model.ts + src/ant/AntStream.ts / src/processes/data/AntDataStream.ts)
    // - 'Quote' is not written by any active path. NiftyQuote documents have no `date`
    // field, only `ltt` (epoch seconds), so filter by a day-bounds range instead of an
    // equality match - see src/tools/quoteDateRange.ts.
    const quotes = await db.collection('NiftyQuote').find(dateRangeQuery(date)).sort({ ltt: 1 }).toArray();
    if (quotes.length === 0) return res.status(404).json({ error: `no quotes for date ${date}` });

    const replayDecision = new Decision();
    replayDecision.replayMode = true;
    for (const q of quotes) {
        replayDecision._addPrice(Number(q.ltt), Number(q.ltp));
    }
    replayDecision.flushCandles();

    res.json({ date, processed: quotes.length });
});
```

### File: `src/tools/pipeline.ts`

**Step 1.** Locate the import block (current lines 22-26):

Before:
```typescript
import Mongo from './mongo';
import { buildCandles } from '../lib/candle-builder';
```

After:
```typescript
import Mongo from './mongo';
import { dateRangeQuery } from './quoteDateRange';
import { buildCandles } from '../lib/candle-builder';
```

(Insert the new import immediately after `import Mongo from './mongo';` —
leave the `import { buildCandles } ...` line and everything else in this
block unchanged.)

**Step 2.** Locate this block (current lines 327-330):

Before:
```typescript
    const query = DATE_FILTER ? { date: DATE_FILTER } : {};
    if (DATE_FILTER) console.error(`  Filtering by date: ${DATE_FILTER}`);
    const rawQuotes = await db.collection('Quote').find(query).sort({ ltt: 1 }).toArray();
    console.error(`Loaded ${rawQuotes.length} raw quotes`);
```

After:
```typescript
    const query = DATE_FILTER ? dateRangeQuery(DATE_FILTER) : {};
    if (DATE_FILTER) console.error(`  Filtering by date: ${DATE_FILTER}`);
    // Live ticks are persisted to 'NiftyQuote' (NiftyQuote.fromAnt(), see
    // src/model/model.ts + src/ant/AntStream.ts / src/processes/data/AntDataStream.ts)
    // - 'Quote' is not written by any active path.
    const rawQuotes = await db.collection('NiftyQuote').find(query).sort({ ltt: 1 }).toArray();
    console.error(`Loaded ${rawQuotes.length} raw quotes`);
```

Leave everything else in `pipeline.ts` (the `DATE_FILTER` declaration at line
52, everything from line 331 onward) unchanged.

### File: `src/prism/MockAPI.ts`

**Step 1.** Locate the import block (current lines 1-3):

Before:
```typescript
import Log from '../util/Log';
import Mongo from '../tools/mongo';
import { MOCK_DATE } from '../constants';
```

After:
```typescript
import Log from '../util/Log';
import Mongo from '../tools/mongo';
import { MOCK_DATE } from '../constants';
import { dateRangeQuery } from '../tools/quoteDateRange';
```

**Step 2.** Locate the `get_quotes` method's NSE branch (current lines
48-59):

Before:
```typescript
        // NSE: return latest NIFTY LTP from Quote collection for MOCK_DATE
        try {
            const db = Mongo.getInstance().db;
            const query = MOCK_DATE ? { date: MOCK_DATE } : {};
            const latest = await db.collection('Quote').findOne(query, { sort: { ltt: -1 } }) as any;
            if (latest) {
                return { stat: 'Ok', lp: latest.ltp.toString(), ft: latest.ltt };
            }
        } catch (e) {
            Log.log('[MockAPI] get_quotes MongoDB error:', e);
        }
        return { stat: 'Ok', lp: this._niftyLtp.toString(), ft };
```

After:
```typescript
        // NSE: return latest NIFTY LTP from NiftyQuote collection for MOCK_DATE
        // (NiftyQuote is the collection live ticks actually land in - see
        // src/model/model.ts NiftyQuote.fromAnt(). 'Quote' is not written by any
        // active path. NiftyQuote documents have no `date` field, only `ltt`
        // (epoch seconds), so MOCK_DATE is matched via a day-bounds range - see
        // src/tools/quoteDateRange.ts.)
        try {
            const db = Mongo.getInstance().db;
            const query = MOCK_DATE ? dateRangeQuery(MOCK_DATE) : {};
            const latest = await db.collection('NiftyQuote').findOne(query, { sort: { ltt: -1 } }) as any;
            if (latest) {
                return { stat: 'Ok', lp: latest.ltp.toString(), ft: latest.ltt };
            }
        } catch (e) {
            Log.log('[MockAPI] get_quotes MongoDB error:', e);
        }
        return { stat: 'Ok', lp: this._niftyLtp.toString(), ft };
```

**Step 3.** Locate the start of `startMockStreams` (current lines 62-81):

Before:
```typescript
    async startMockStreams(): Promise<void> {
        const dateLabel = MOCK_DATE || 'all dates';
        Log.log(`[MockAPI] Starting mock NIFTY stream from Quote collection (date=${dateLabel})`);
        let quotes: any[] = [];
        let idx = 0;

        try {
            const db = Mongo.getInstance().db;
            const query = MOCK_DATE ? { date: MOCK_DATE } : {};
            quotes = await db.collection('Quote')
                .find(query)
                .sort({ ltt: 1 })
                .toArray();
            Log.log(`[MockAPI] Loaded ${quotes.length} Quote records from MongoDB (date=${dateLabel})`);
        } catch (e) {
            Log.log('[MockAPI] MongoDB fetch error, using fallback LTP 23500:', e);
            for (let i = 0; i < 500; i++) {
                quotes.push({ ltp: 23500 + Math.sin(i / 20) * 100, ltt: new Date().toTimeString().split(' ')[0] });
            }
        }
```

After:
```typescript
    async startMockStreams(): Promise<void> {
        const dateLabel = MOCK_DATE || 'all dates';
        Log.log(`[MockAPI] Starting mock NIFTY stream from NiftyQuote collection (date=${dateLabel})`);
        let quotes: any[] = [];
        let idx = 0;

        try {
            const db = Mongo.getInstance().db;
            const query = MOCK_DATE ? dateRangeQuery(MOCK_DATE) : {};
            quotes = await db.collection('NiftyQuote')
                .find(query)
                .sort({ ltt: 1 })
                .toArray();
            Log.log(`[MockAPI] Loaded ${quotes.length} NiftyQuote records from MongoDB (date=${dateLabel})`);
        } catch (e) {
            Log.log('[MockAPI] MongoDB fetch error, using fallback LTP 23500:', e);
            for (let i = 0; i < 500; i++) {
                quotes.push({ ltp: 23500 + Math.sin(i / 20) * 100, ltt: new Date().toTimeString().split(' ')[0] });
            }
        }
```

Leave everything else in `MockAPI.ts` (the rest of `startMockStreams` from
line 83 onward, `place_order`, etc.) unchanged.

## New test file

Create `src/test/quoteDateRange.test.ts` with exactly this content:

```typescript
/**
 * Verifies the NiftyQuote date-range query helper (src/tools/quoteDateRange.ts)
 * used by the fixed readers (GET /replay in src/server.ts, src/tools/pipeline.ts,
 * src/prism/MockAPI.ts) after the Quote -> NiftyQuote collection-name fix (bug-11).
 *
 * NiftyQuote documents (written by NiftyQuote.fromAnt(), see src/model/model.ts)
 * have no `date` field - only `ltt`, a Unix-epoch-seconds tick timestamp. This test
 * does not require a live Mongo connection: it exercises dayBoundsIST()/dateRangeQuery()
 * as pure functions and evaluates the query's $expr shape against synthetic in-memory
 * documents, standing in for "insert into NiftyQuote, run the reader, assert it comes
 * back" without needing a live database.
 *
 * Anchor values below (ltt <-> IST wall-clock time) are taken from real production
 * data synced into the local 'Quote' collection (scripts/syncQuotes.sh) on 2026-08-28:
 *   ltt=1787888700 -> '2026-08-28 09:15:00' IST (observed market-open tick)
 *   ltt=1787911151 -> '2026-08-28 15:29:11' IST (observed late-session tick)
 *
 * Run: npm run build (compile), then: node ./dist/test/quoteDateRange.test.js
 */

import { dayBoundsIST, dateRangeQuery } from '../tools/quoteDateRange';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

// Minimal stand-in for evaluating the $expr/$toDouble/$gte/$lt shape
// dateRangeQuery() produces, against a plain JS document - lets us assert
// "which synthetic docs would this query match" without a live Mongo connection.
function matchesDateRangeQuery(doc: { ltt: string | number }, query: any): boolean {
    const [gteClause, ltClause] = query.$expr.$and;
    const ltt = Number(doc.ltt);
    const start = gteClause.$gte[1];
    const end = ltClause.$lt[1];
    return ltt >= start && ltt < end;
}

async function main() {
    // ── dayBoundsIST: known-good anchor from real production data ──────────────
    const bounds = dayBoundsIST('2026-08-28');
    assert(bounds.start === 1787855400, `dayBoundsIST('2026-08-28').start is 00:00:00 IST (got ${bounds.start})`);
    assert(bounds.end === 1787941800, `dayBoundsIST('2026-08-28').end is 00:00:00 IST next day (got ${bounds.end})`);
    assert(bounds.end - bounds.start === 86400, `day span is exactly 86400 seconds (got ${bounds.end - bounds.start})`);

    // ── dateRangeQuery: structural shape ────────────────────────────────────────
    const query: any = dateRangeQuery('2026-08-28');
    assert(!!query['$expr'], 'dateRangeQuery returns a $expr filter (works regardless of ltt storage type)');

    // ── synthetic "insert into NiftyQuote, run reader" scenario ────────────────
    const inRangeDoc = { token: '26000', ltp: 24128.95, ltt: 1787888700 };      // 09:15:00 IST on the target date
    const beforeDoc = { token: '26000', ltp: 24000.00, ltt: 1787855399 };       // 23:59:59 IST the day before (1s before start)
    const afterDoc = { token: '26000', ltp: 24200.00, ltt: 1787941800 };        // 00:00:00 IST the day after (== end, exclusive)
    const lateInRangeDoc = { token: '26000', ltp: 24175.65, ltt: 1787911151 };  // 15:29:11 IST on the target date

    assert(matchesDateRangeQuery(inRangeDoc, query) === true, 'a tick from 09:15:00 IST on the target date matches');
    assert(matchesDateRangeQuery(lateInRangeDoc, query) === true, 'a tick from 15:29:11 IST on the target date matches');
    assert(matchesDateRangeQuery(beforeDoc, query) === false, 'a tick from 23:59:59 IST the day before does not match');
    assert(matchesDateRangeQuery(afterDoc, query) === false, 'a tick from exactly 00:00:00 IST the day after does not match (exclusive upper bound)');

    // ── ltt stored as a string (as it may arrive unparsed from AntStream) ──────
    const stringLttDoc = { token: '26000', ltp: 24128.95, ltt: '1787888700' };
    assert(matchesDateRangeQuery(stringLttDoc, query) === true, 'a string-typed ltt value is still matched correctly (Number() coercion, mirrors $toDouble)');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

**Why this is the primary recommended test (not a live-Mongo test):** no
existing file under `src/test/*.test.ts` connects to a real Mongo instance
(checked: `grep -rln "Mongo" src/test` returns no hits) — the established
convention (`bookkeepingDedup.test.ts`) is pure in-process logic with no
external dependency. Introducing the first-ever live-DB test dependency for
this fix would make the test flaky/unrunnable in any environment without a
reachable `mongodb://localhost:27017/stocks` (unlike this planning session's
environment, where Mongo happened to be reachable — do not assume that holds
for the environment executing this plan). `dayBoundsIST`/`dateRangeQuery` are
pure functions with no Mongo dependency, so testing them directly, plus
evaluating the exact `$expr` shape against synthetic documents, gives full
coverage of the actual logic this fix adds (the date-range math and the
type-agnostic comparison) without that risk.

If the orchestrator's environment does have a reachable local Mongo and wants
an additional real-DB smoke check, it MAY optionally also run the diagnostic
`mongosh` commands in step 4 of "Verification steps" below — but that step is
explicitly optional/diagnostic, not part of the pass/fail criteria for this
fix.

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
node ./dist/test/quoteDateRange.test.js
echo "exit code: $?"
```

Expected output from step 3: exactly these lines (order will not vary, this
test has no async interleaving):

```
  PASS: dayBoundsIST('2026-08-28').start is 00:00:00 IST (got 1787855400)
  PASS: dayBoundsIST('2026-08-28').end is 00:00:00 IST next day (got 1787941800)
  PASS: day span is exactly 86400 seconds (got 86400)
  PASS: dateRangeQuery returns a $expr filter (works regardless of ltt storage type)
  PASS: a tick from 09:15:00 IST on the target date matches
  PASS: a tick from 15:29:11 IST on the target date matches
  PASS: a tick from 23:59:59 IST the day before does not match
  PASS: a tick from exactly 00:00:00 IST the day after does not match (exclusive upper bound)
  PASS: a string-typed ltt value is still matched correctly (Number() coercion, mirrors $toDouble)
ALL TESTS PASSED
```
followed by `exit code: 0`.

If any `FAIL:` line appears, or if `npx tsc --noEmit` / `npx tsc` report
compile errors, the change is not done — do not mark this bug fixed.

**Step 4 (optional, diagnostic only — requires a locally reachable Mongo;
skip if `mongosh` / a local Mongo instance is not available in this
environment; do not treat its outcome as pass/fail for this fix):**

```bash
mongosh --quiet mongodb://localhost:27017/stocks --eval '
db.NiftyQuote.insertOne({ token: "26000", ltp: 24150.5, ltt: 1787888700 });
print("--- /replay-style query against NiftyQuote for 2026-08-28 ---");
printjson(db.NiftyQuote.find({
  $expr: { $and: [
    { $gte: [ { $toDouble: "$ltt" }, 1787855400 ] },
    { $lt:  [ { $toDouble: "$ltt" }, 1787941800 ] }
  ] }
}).toArray());
db.NiftyQuote.deleteMany({ token: "26000", ltt: 1787888700 });
'
```

Expected: the `printjson` output shows exactly one document with
`ltp: 24150.5`, `ltt: 1787888700` — proving a synthetic `NiftyQuote` document
for that date is found by the exact query shape `dateRangeQuery` produces
(this is the "insert a synthetic document ... assert it comes back" scenario
run against a real database, as an extra sanity check beyond the pure-logic
test in step 3).

## Files touched

| File | Change |
|---|---|
| `/home/karthikeyan/work/icici/src/tools/quoteDateRange.ts` (new) | New shared helper: `dayBoundsIST(dateStr)` (day-bounds epoch-seconds range in IST) and `dateRangeQuery(dateStr)` (Mongo `$expr` filter matching `ltt` against that range, type-agnostic via `$toDouble`). |
| `/home/karthikeyan/work/icici/src/server.ts` | Add import of `dateRangeQuery` after the existing `Mongo` import (line 29). In the `/replay` route (lines 1360-1376): change `db.collection('Quote').find({ date })` to `db.collection('NiftyQuote').find(dateRangeQuery(date))`. |
| `/home/karthikeyan/work/icici/src/tools/pipeline.ts` | Add import of `dateRangeQuery` after the existing `Mongo` import (line 22-ish). Change `const query = DATE_FILTER ? { date: DATE_FILTER } : {};` to use `dateRangeQuery(DATE_FILTER)`, and `db.collection('Quote')` to `db.collection('NiftyQuote')` (line 329). |
| `/home/karthikeyan/work/icici/src/prism/MockAPI.ts` | Add import of `dateRangeQuery`. In `get_quotes` (lines 48-59) and `startMockStreams` (lines 62-81): change both `MOCK_DATE ? { date: MOCK_DATE } : {}` query-building lines to use `dateRangeQuery(MOCK_DATE)`, and both `db.collection('Quote')` calls to `db.collection('NiftyQuote')`. |
| `/home/karthikeyan/work/icici/src/test/quoteDateRange.test.ts` (new) | New hand-rolled test (no jest, matches `bookkeepingDedup.test.ts` convention) covering `dayBoundsIST`/`dateRangeQuery` correctness against real anchor timestamps, without requiring a live Mongo connection. |

**Not touched (confirmed out of scope):**
- `src/trade/icici.ts` — the `Quote`/`StockQuote` classes and `saveQuote()`
  are dead/unreachable legacy code, confirmed not wired into any live process
  entrypoint. Left as-is; not part of this bug's fix.
- `src/tools/analyze.ts` and `src/tools/check_indicators.ts` — already query
  `NiftyQuote` correctly (no `date` filter, since they don't need one); no
  change needed.
- `src/tools/migrate_actualDay.ts` — a separate, already-drafted (and
  currently inert — its `$set` write is commented out) migration for
  backfilling `date`/`time`/`actualDay` fields onto old `NiftyQuote`
  documents, using a different date format (`DD-Mon`) than this fix's
  `YYYY-MM-DD`. Unrelated to this fix; do not touch or "complete" it as part
  of this change.
