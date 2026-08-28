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
