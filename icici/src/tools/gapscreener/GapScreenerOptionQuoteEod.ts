/**
 * Gap-Screener Option Quote - End of Day
 *
 * The EOD half of a two-script pair (see GapScreenerOptionQuote.ts, the
 * morning run). Reads gap_screener_option_quote.csv - already populated with
 * Option Quote + Option Contract by the morning run - re-resolves each row's
 * *exact same* contract (not a freshly-recomputed nearest-OTM strike, since
 * spot may have moved intraday) via AntContractMaster.findByTradingSymbol,
 * fetches its live price - via the same websocket batch helper
 * (src/tools/AntBatchQuote.ts) before 3:30pm, or via ANT's REST
 * getScripQuote (polled one token at a time, 1s apart) after 3:30pm, since
 * the websocket subscribe stops delivering ticks once the exchange session
 * ends - as the option's EOD quote.
 *
 * Also joins each row (by stock symbol) against gap-screener.csv, which
 * carries the stock's `LTP` and its `1st15m High` / `1st15m Low` (first
 * 15-minute candle, originally written by the sibling
 * /home/karthikeyan/tools/ohlc/screener.ts and copied in locally by
 * GapScreenerGenerate.ts).
 *
 * Both CSVs live alongside this script in src/tools/gapscreener/ (same files
 * gapscreener:start read/wrote).
 *
 * A bought option (CE for a Buy row, PE for a Sell row) is judged favorable
 * if EITHER of these holds:
 *   - the option's own EOD quote is above the price it was bought at
 *     (Option Quote EOD > Option Quote), or
 *   - the underlying stock has broken out of its opening range in the
 *     expected direction (Buy row: Stock LTP > Stock 1st15m High;
 *     Sell row: Stock LTP < Stock 1st15m Low)
 * - the second condition catches cases where the option/stock moved
 * favorably intraday and then retraced by the time the EOD quote was taken.
 *
 * Writes back to gap_screener_option_quote.csv:
 *   - Option Quote EOD: the fetched live option price
 *   - Stock LTP, 1st15m High, 1st15m Low: the stock-side comparison basis,
 *     carried through so the numbers behind each Result are visible without
 *     cross-referencing gap-screener.csv by hand
 *   - Result: true/false per the rule above
 *
 * A morning row whose stock no longer has a Buy/Sell Recommendation in
 * gap-screener.csv (e.g. screener.ts was re-run later in the day and the
 * recommendation changed/cleared) is dropped entirely from the output,
 * rather than kept with blank EOD columns - gap_screener_option_quote.csv
 * should only ever list stocks that currently have a recommendation.
 *
 * No "have we already run today" guard - this script always (re)computes
 * these columns for every row it finds, on the assumption an operator runs
 * it once, deliberately, later in the day.
 *
 * Usage:
 *   npm run gapscreener:end
 *
 * No CLI arguments — input/output paths are fixed (same files
 * gapscreener:start read/wrote).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import AntContractMaster from '../../ant/AntContractMaster';
import ANT from '../../ant/ANT';
import { collectLiveQuotes, QUOTE_WAIT_MS } from '../AntBatchQuote';

// Anchored to process.cwd() (always the repo root - every gapscreener:*
// npm script, and both cron wrapper scripts, run from there), NOT __dirname:
// __dirname in compiled code is dist/tools/gapscreener/, which would put
// these CSVs in the build-output tree instead of alongside their TS source.
const GAPSCREENER_DIR = path.join(process.cwd(), 'src', 'tools', 'gapscreener');
const RESULT_CSV = path.join(GAPSCREENER_DIR, 'gap_screener_option_quote.csv');
const SCREENER_CSV = path.join(GAPSCREENER_DIR, 'gap-screener.csv');

// AliceBlue's websocket only streams ticks during the live market session -
// subscribing after the exchange closes just times out (confirmed: this is
// why gapscreener:end doesn't work when run after market hours). Past this
// cutoff, fall back to polling ANT's REST getScripQuote (ScripDetails
// endpoint - confirmed live to still return post-close LTP, unlike the OHLC
// endpoint used elsewhere in ANT.ts, which returned `result: [null]` for the
// same token post-close) one token at a time instead of subscribing.
const MARKET_DATA_CUTOFF_HOUR = 15;
const MARKET_DATA_CUTOFF_MINUTE = 30;
const REST_QUOTE_DELAY_MS = 1000;

function isBeforeMarketDataCutoff(): boolean {
    const now = new Date();
    return (
        now.getHours() < MARKET_DATA_CUTOFF_HOUR ||
        (now.getHours() === MARKET_DATA_CUTOFF_HOUR && now.getMinutes() < MARKET_DATA_CUTOFF_MINUTE)
    );
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectQuotesViaRest(pending: PendingQuote[]): Promise<Map<string, number>> {
    const quotes = new Map<string, number>();
    const ant = ANT.getInstance();
    for (const p of pending) {
        try {
            const ltp = await ant.getScripQuote('NFO', p.token);
            console.log(`[antBatchQuote]   getScripQuote NFO|${p.token} ltp=${ltp}`);
            quotes.set(p.token, ltp);
        } catch (e: any) {
            console.warn(`[gapScreenerOptionQuoteEod] getScripQuote failed for ${p.antStockCode} (${p.optionContract}):`, e.message);
        }
        await sleep(REST_QUOTE_DELAY_MS);
    }
    return quotes;
}

interface MorningRow {
    antStockCode: string;
    stockName: string;
    optionQuote: number;
    optionContract: string;
}

interface PendingQuote extends MorningRow {
    token: string;
    lotSize?: number;
}

interface ScreenerRow {
    symbol: string;
    ltp: number;
    recommendation: 'Buy' | 'Sell';
    first15mHigh: number;
    first15mLow: number;
}

function readMorningRows(csvPath: string): MorningRow[] {
    if (!fs.existsSync(csvPath)) {
        throw new Error(`${csvPath} not found - run "npm run gapscreener:start" first.`);
    }
    const content = fs.readFileSync(csvPath, 'utf8');
    const records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as Record<string, string>[];

    return records
        .map((row) => ({
            antStockCode: (row['ANT Stock Code'] || '').trim().toUpperCase(),
            stockName: (row['Stock Name'] || '').trim(),
            optionQuote: Number(row['Option Quote']),
            optionContract: (row['Option Contract'] || '').trim(),
        }))
        .filter((row) => row.antStockCode.length > 0 && row.optionContract.length > 0);
}

function readScreenerRows(csvPath: string): Map<string, ScreenerRow> {
    if (!fs.existsSync(csvPath)) {
        throw new Error(`${csvPath} not found.`);
    }
    const content = fs.readFileSync(csvPath, 'utf8');
    const records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as Record<string, string>[];

    const bySymbol = new Map<string, ScreenerRow>();
    for (const row of records) {
        const symbol = (row['Symbol'] || '').trim().toUpperCase();
        if (!symbol) continue;
        bySymbol.set(symbol, {
            symbol,
            ltp: Number(row['LTP']),
            recommendation: (row['Recommendation'] || '').trim() as 'Buy' | 'Sell',
            first15mHigh: Number(row['1st15m High']),
            first15mLow: Number(row['1st15m Low']),
        });
    }
    return bySymbol;
}

interface OutputRow extends MorningRow {
    optionQuoteEod?: number;
    stockLtp?: number;
    first15mHigh?: number;
    first15mLow?: number;
    result?: boolean;
    lotSize?: number;
    capital?: number;
}

function writeResults(results: OutputRow[], outputPath: string): void {
    const headers = ['ANT Stock Code', 'Stock Name', 'Option Quote', 'Option Contract', 'Option Quote EOD', 'Stock LTP', '1st15m High', '1st15m Low', 'Result', 'Lot Size', 'Capital'];
    const rows = results.map((r) => [
        r.antStockCode,
        r.stockName,
        r.optionQuote,
        r.optionContract,
        r.optionQuoteEod ?? '',
        r.stockLtp ?? '',
        r.first15mHigh ?? '',
        r.first15mLow ?? '',
        r.result ?? '',
        r.lotSize ?? '',
        r.capital ?? '',
    ]);

    const totalCapital = results.reduce((sum, r) => sum + (r.capital ?? 0), 0);
    const missingCapitalCount = results.filter((r) => r.capital == null).length;
    if (missingCapitalCount > 0) {
        console.warn(`[gapScreenerOptionQuoteEod] ${missingCapitalCount} row(s) had no Capital (contract/lot size unresolved) - treated as 0 in the TOTAL row`);
    }
    rows.push(['', 'TOTAL', '', '', '', '', '', '', '', '', totalCapital]);

    fs.writeFileSync(outputPath, stringify([headers, ...rows]), 'utf8');
}

async function main(): Promise<void> {
    console.log('=== Gap-Screener Option Quote - End of Day ===');
    console.log(`Morning CSV: ${RESULT_CSV}`);
    console.log(`Screener CSV: ${SCREENER_CSV}\n`);

    const rows = readMorningRows(RESULT_CSV);
    if (rows.length === 0) {
        console.log('No rows with a resolved Option Contract found.');
        return;
    }
    console.log(`Found ${rows.length} row(s) from the morning run\n`);

    const screenerBySymbol = readScreenerRows(SCREENER_CSV);

    // Only stocks that currently have a Buy/Sell Recommendation in
    // gap-screener.csv stay in the output - a row whose recommendation has
    // since changed/cleared (screener.ts re-run later in the day) is dropped
    // entirely rather than carried forward with blank EOD columns.
    const recommendedRows: MorningRow[] = [];
    for (const row of rows) {
        const screenerRow = screenerBySymbol.get(row.antStockCode);
        if (!screenerRow || (screenerRow.recommendation !== 'Buy' && screenerRow.recommendation !== 'Sell')) {
            console.warn(`[gapScreenerOptionQuoteEod] dropping ${row.antStockCode}: no Buy/Sell Recommendation in ${SCREENER_CSV}`);
            continue;
        }
        recommendedRows.push(row);
    }

    if (recommendedRows.length === 0) {
        console.log('No rows with a current Buy/Sell Recommendation found.');
        return;
    }

    const pending: PendingQuote[] = [];
    const lotSizeByStock = new Map<string, number>();
    const capitalByStock = new Map<string, number>();
    for (const row of recommendedRows) {
        const contract = AntContractMaster.getInstance().findByTradingSymbol(row.optionContract, 'NFO');
        if (!contract) {
            console.warn(`[gapScreenerOptionQuoteEod] skipping ${row.antStockCode}: contract ${row.optionContract} not found in NFO contract master`);
            continue;
        }
        const lotSize = Number(contract.lotSize);
        if (Number.isFinite(lotSize)) {
            lotSizeByStock.set(row.antStockCode, lotSize);
            capitalByStock.set(row.antStockCode, lotSize * row.optionQuote);
        } else {
            console.warn(`[gapScreenerOptionQuoteEod] ${row.antStockCode}: lot size missing/non-numeric for ${row.optionContract} - Lot Size/Capital will be blank`);
        }
        console.log(`${row.antStockCode} -> ${row.optionContract} (token ${contract.token})`);
        pending.push({ ...row, token: contract.token, lotSize: Number.isFinite(lotSize) ? lotSize : undefined });
    }

    if (pending.length === 0) {
        console.log('\nNo contracts resolved - nothing to subscribe to.');
        return;
    }

    const useWebsocket = isBeforeMarketDataCutoff();
    let quotes: Map<string, number>;
    if (useWebsocket) {
        console.log(`\nOpening ANT websocket session and subscribing ${pending.length} option(s)...`);
        quotes = await collectLiveQuotes(pending.map((p) => p.token));
    } else {
        console.log(`\nPast 3:30pm - websocket subscribe won't receive ticks. Polling ANT getQuote for ${pending.length} option(s) (${REST_QUOTE_DELAY_MS}ms apart)...`);
        quotes = await collectQuotesViaRest(pending);
    }

    const byStock = new Map<string, { optionQuoteEod?: number; stockLtp?: number; first15mHigh?: number; first15mLow?: number; result?: boolean }>();
    let filled = 0;
    for (const p of pending) {
        const optionQuoteEod = quotes.get(p.token);
        if (optionQuoteEod == null) {
            const reason = useWebsocket
                ? `no live tick received for ${p.optionContract} within ${QUOTE_WAIT_MS}ms`
                : `no getQuote result for ${p.optionContract}`;
            console.warn(`[gapScreenerOptionQuoteEod] skipping ${p.antStockCode}: ${reason}`);
            continue;
        }

        // recommendedRows already guarantees a Buy/Sell match in screenerBySymbol.
        const screenerRow = screenerBySymbol.get(p.antStockCode)!;
        if (!Number.isFinite(screenerRow.ltp) || !Number.isFinite(screenerRow.first15mHigh) || !Number.isFinite(screenerRow.first15mLow)) {
            console.warn(`[gapScreenerOptionQuoteEod] skipping ${p.antStockCode}: LTP/1st15m High/1st15m Low missing or not numeric in ${SCREENER_CSV}`);
            continue;
        }

        const optionMovedFavorably = optionQuoteEod > p.optionQuote;
        const stockBrokeOut = screenerRow.recommendation === 'Buy'
            ? screenerRow.ltp > screenerRow.first15mHigh
            : screenerRow.ltp < screenerRow.first15mLow;
        const result = optionMovedFavorably || stockBrokeOut;

        console.log(`${p.antStockCode} -> ${p.optionContract} = ${optionQuoteEod} (bought ${p.optionQuote}); stock ${screenerRow.recommendation} LTP ${screenerRow.ltp} vs 1st15m High ${screenerRow.first15mHigh} / Low ${screenerRow.first15mLow}, result=${result}`);

        byStock.set(p.antStockCode, {
            optionQuoteEod,
            stockLtp: screenerRow.ltp,
            first15mHigh: screenerRow.first15mHigh,
            first15mLow: screenerRow.first15mLow,
            result,
        });
        filled++;
    }

    // Every currently-recommended row is written back, whether or not this
    // run resolved a Result for it - a fetch miss just leaves those cells
    // blank instead of dropping the (already-good) morning data. Rows
    // without a current Buy/Sell Recommendation were already dropped above.
    const output: OutputRow[] = recommendedRows.map((row) => ({
        ...row,
        ...byStock.get(row.antStockCode),
        lotSize: lotSizeByStock.get(row.antStockCode),
        capital: capitalByStock.get(row.antStockCode),
    }));

    writeResults(output, RESULT_CSV);
    console.log(`\nWrote ${output.length} row(s) to ${RESULT_CSV} (${filled}/${pending.length} with a new Result)`);
}

main()
    .catch((err) => {
        console.error('Fatal error:', err.message);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode ?? 0));
