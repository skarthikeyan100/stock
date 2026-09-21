/**
 * Gap-Screener Nearest-OTM Option Quote
 *
 * Reads the daily gap-up/gap-down screener CSV, and for every stock with a
 * non-blank Buy/Sell recommendation, resolves the nearest OTM option (CE for
 * Buy, PE for Sell) and records its live quote.
 *
 * Strike/token resolution is purely local (AntContractMaster reading the NFO
 * contract-master JSON) - NOT AliceBlue's option-chain REST endpoint, which
 * was confirmed live to return stale ltp=0/oi=0 for liquid names (e.g.
 * ICICIBANK's entire fetched strike window) while the ANT mobile app showed a
 * real live price for the same contract.
 *
 * The live price itself comes from AliceBlue's websocket touchline feed, not
 * REST - the REST OHLC endpoint (ant.getQuote), called once per symbol in a
 * loop, hit 429s in practice. Instead this script batches every resolved
 * option token into one websocket subscribe via src/tools/AntBatchQuote.ts
 * (subscribe -> wait for ticks -> unsubscribe), shared with the EOD
 * counterpart script (GapScreenerOptionQuoteEod.ts).
 *
 * Input/output CSVs live alongside this script in src/tools/gapscreener/.
 *
 * This is the MORNING half of a two-script pair: it always resolves the
 * nearest-OTM contract fresh and writes Option Quote/Option Contract. Run
 * GapScreenerOptionQuoteEod.ts later the same day to add Option Quote EOD +
 * Result against the same contracts this script picked.
 *
 * Usage:
 *   npm run gapscreener:start
 *
 * No CLI arguments — input/output paths are fixed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import AntContractMaster from '../../ant/AntContractMaster';
import { collectLiveQuotes, QUOTE_WAIT_MS } from '../AntBatchQuote';

// Anchored to process.cwd() (always the repo root - every gapscreener:*
// npm script, and both cron wrapper scripts, run from there), NOT __dirname:
// __dirname in compiled code is dist/tools/gapscreener/, which would put
// these CSVs in the build-output tree instead of alongside their TS source.
const GAPSCREENER_DIR = path.join(process.cwd(), 'src', 'tools', 'gapscreener');
const INPUT_CSV = path.join(GAPSCREENER_DIR, 'gap-screener.csv');
const OUTPUT_CSV = path.join(GAPSCREENER_DIR, 'gap_screener_option_quote.csv');

interface ScreenerRow {
    symbol: string;
    name: string;
    ltp: number;
    recommendation: 'Buy' | 'Sell';
}

interface ResultRow {
    antStockCode: string;
    stockName: string;
    optionQuote: number;
    optionContract: string;
}

function readRecommendedRows(csvPath: string): ScreenerRow[] {
    if (!fs.existsSync(csvPath)) {
        throw new Error(`Input CSV not found: ${csvPath}`);
    }
    const content = fs.readFileSync(csvPath, 'utf8');
    const records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as Record<string, string>[];

    return records
        .map((row) => ({
            symbol: (row['Symbol'] || '').trim().toUpperCase(),
            name: (row['Name'] || '').trim(),
            ltp: Number(row['LTP']),
            recommendation: (row['Recommendation'] || '').trim() as 'Buy' | 'Sell',
        }))
        .filter((row) => row.symbol.length > 0 && (row.recommendation === 'Buy' || row.recommendation === 'Sell'));
}

// Nearest OTM strike for the given side, resolved purely from the local NFO
// contract master (no network call): for CE, the smallest strike above spot;
// for PE, the largest strike below spot.
function nearestOtmContract(
    symbol: string,
    optionType: 'CE' | 'PE',
    spot: number
): { strike: number; token: string; tradingSymbol: string } | undefined {
    const options = AntContractMaster.getInstance().listNearestExpiryOptions(symbol, 'NFO');
    const sideOptions = options.filter((o) => o.optionType === optionType);

    const candidates = optionType === 'CE'
        ? sideOptions.filter((o) => o.strike > spot).sort((a, b) => a.strike - b.strike)
        : sideOptions.filter((o) => o.strike < spot).sort((a, b) => b.strike - a.strike);

    return candidates[0];
}

interface PendingQuote {
    symbol: string;
    stockName: string;
    token: string;
    tradingSymbol: string;
}

function writeResults(results: ResultRow[], outputPath: string): void {
    const headers = ['ANT Stock Code', 'Stock Name', 'Option Quote', 'Option Contract'];
    const rows = results.map((r) => [r.antStockCode, r.stockName, r.optionQuote, r.optionContract]);
    fs.writeFileSync(outputPath, stringify([headers, ...rows]), 'utf8');
}

async function main(): Promise<void> {
    console.log('=== Gap-Screener Nearest-OTM Option Quote ===');
    console.log(`Input:  ${INPUT_CSV}`);
    console.log(`Output: ${OUTPUT_CSV}\n`);

    const rows = readRecommendedRows(INPUT_CSV);
    if (rows.length === 0) {
        console.log('No rows with a Buy/Sell recommendation found.');
        return;
    }
    console.log(`Found ${rows.length} recommended stock(s)\n`);

    const pending: PendingQuote[] = [];
    for (const row of rows) {
        const optionType: 'CE' | 'PE' = row.recommendation === 'Buy' ? 'CE' : 'PE';
        if (!Number.isFinite(row.ltp)) {
            console.warn(`[gapScreenerOptionQuote] skipping ${row.symbol}: invalid LTP "${row.ltp}"`);
            continue;
        }
        const contract = nearestOtmContract(row.symbol, optionType, row.ltp);
        if (!contract) {
            console.warn(`[gapScreenerOptionQuote] skipping ${row.symbol}: no ${optionType} contract found in NFO contract master for the nearest expiry`);
            continue;
        }
        console.log(`${row.symbol} (${row.recommendation}) -> ${contract.tradingSymbol} (token ${contract.token})`);
        pending.push({ symbol: row.symbol, stockName: row.name, token: contract.token, tradingSymbol: contract.tradingSymbol });
    }

    if (pending.length === 0) {
        console.log('\nNo option contracts resolved - nothing to subscribe to.');
        return;
    }

    console.log(`\nOpening ANT websocket session and subscribing ${pending.length} option(s)...`);
    const quotes = await collectLiveQuotes(pending.map((p) => p.token));

    const results: ResultRow[] = [];
    for (const p of pending) {
        const ltp = quotes.get(p.token);
        if (ltp == null) {
            console.warn(`[gapScreenerOptionQuote] skipping ${p.symbol}: no live tick received for ${p.tradingSymbol} within ${QUOTE_WAIT_MS}ms`);
            continue;
        }
        console.log(`${p.symbol} -> ${p.tradingSymbol} = ${ltp}`);
        results.push({ antStockCode: p.symbol, stockName: p.stockName, optionQuote: ltp, optionContract: p.tradingSymbol });
    }

    writeResults(results, OUTPUT_CSV);
    console.log(`\nWrote ${results.length}/${rows.length} rows to ${OUTPUT_CSV}`);
}

main()
    .catch((err) => {
        console.error('Fatal error:', err.message);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode ?? 0));
