/**
 * Gap-Screener Cover Order
 *
 * Optional, config-gated last step of the morning gap-screener pipeline (see
 * gapscreener-morning.sh): reads the local gap_screener_option_quote.csv
 * (written by gapscreener:start) and places an ANT cover order for each
 * resolved contract, via the `order` process's IPC socket (OrderClient).
 *
 * Safe no-op unless settings.gapScreenerCoverOrderEnabled is true in
 * config.yml - this is what lets gapscreener-morning.sh call
 * `npm run gapscreener:coverorder` unconditionally.
 *
 * WARNING: ANT.placeCoverOrder has never been confirmed against a live
 * AliceBlue response (see ANT.ts's placeCoverOrder comment and the
 * gap-screener cover-order plan's verification section). Do not enable
 * gapScreenerCoverOrderEnabled against a real account without first
 * live-testing it in isolation.
 *
 * Usage:
 *   npm run gapscreener:coverorder
 *
 * No CLI arguments — input CSV path is fixed, and all placement parameters
 * (user, quantity, stop-loss points) come from config.yml.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import configService from '../../prism/ConfigService';
import AntContractMaster from '../../ant/AntContractMaster';
import OrderClient from '../../processes/strategies/OrderClient';
import { sleep } from '../../util/sleep';

// Anchored to process.cwd() (always the repo root - every gapscreener:*
// npm script, and both cron wrapper scripts, run from there), NOT __dirname:
// __dirname in compiled code is dist/tools/gapscreener/, which would put
// this CSV in the build-output tree instead of alongside its TS source.
const RESULT_CSV = path.join(process.cwd(), 'src', 'tools', 'gapscreener', 'gap_screener_option_quote.csv');
const CONNECT_TIMEOUT_MS = 5000;
// Symbols already covered today, so a re-run (cron + manual, or a retry) can never place the same order twice.
const PLACED_LOG = path.join(process.cwd(), '.gapscreener_cover_placed.json');

function istDay(d: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function istWeekdayAndMinutes(): { weekday: string; minutes: number } {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    return {
        weekday: parts.find((p) => p.type === 'weekday')?.value ?? '',
        minutes: (Number(parts.find((p) => p.type === 'hour')?.value) % 24) * 60 + Number(parts.find((p) => p.type === 'minute')?.value),
    };
}

function readPlaced(): Set<string> {
    try {
        const doc = JSON.parse(fs.readFileSync(PLACED_LOG, 'utf8'));
        if (doc?.day === istDay() && Array.isArray(doc.symbols)) return new Set<string>(doc.symbols);
    } catch { /* none yet / unreadable: start empty */ }
    return new Set<string>();
}

function writePlaced(symbols: Set<string>): void {
    fs.writeFileSync(PLACED_LOG, JSON.stringify({ day: istDay(), symbols: Array.from(symbols) }));
}

interface MorningRow {
    antStockCode: string;
    optionContract: string;
    premium: number; // the morning option quote the screener recorded
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
            optionContract: (row['Option Contract'] || '').trim(),
            premium: Number(row['Option Quote']),
        }))
        .filter((row) => row.antStockCode.length > 0 && row.optionContract.length > 0);
}


async function waitUntilConnected(client: OrderClient, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (client.isConnected()) return true;
        await sleep(100);
    }
    return client.isConnected();
}

async function main(): Promise<void> {
    console.log('=== Gap-Screener Cover Order ===');
    const settings = configService.getConfig().settings as any;

    if (settings.gapScreenerCoverOrderEnabled !== true) {
        console.log('[gapScreenerCoverOrder] gapScreenerCoverOrderEnabled is not true - nothing to do.');
        return;
    }

    const userEmail: string = settings.gapScreenerCoverOrderUserEmail;
    const quantity: number = settings.gapScreenerCoverOrderQuantity;
    const stopLossPoints: number = settings.gapScreenerCoverOrderStopLossPoints;

    if (!userEmail || !quantity || !stopLossPoints) {
        throw new Error('gapScreenerCoverOrderEnabled is true but gapScreenerCoverOrderUserEmail/Quantity/StopLossPoints are not fully configured in config.yml.');
    }

    // Safety gates (this places REAL orders from a file): trading day + market hours in IST, and a CSV written today.
    // GAP_COVER_FORCE=true bypasses them for a deliberate manual run.
    const force = process.env.GAP_COVER_FORCE === 'true';
    const { weekday, minutes } = istWeekdayAndMinutes();
    if (!force && (weekday === 'Sat' || weekday === 'Sun' || minutes < 9 * 60 + 15 || minutes >= 15 * 60 + 20)) {
        console.error('[gapScreenerCoverOrder] Outside Mon-Fri 09:15-15:20 IST - refusing to place orders (set GAP_COVER_FORCE=true to override).');
        process.exitCode = 1;
        return;
    }
    if (!force && fs.existsSync(RESULT_CSV) && istDay(fs.statSync(RESULT_CSV).mtime) !== istDay()) {
        console.error(`[gapScreenerCoverOrder] ${RESULT_CSV} was not written today (${fs.statSync(RESULT_CSV).mtime.toISOString()}) - stale quotes, refusing to place orders.`);
        process.exitCode = 1;
        return;
    }

    const rows = readMorningRows(RESULT_CSV);
    if (rows.length === 0) {
        console.log('No rows with a resolved Option Contract found.');
        return;
    }
    console.log(`Found ${rows.length} row(s) from the morning run`);

    const client = OrderClient.getInstance();
    client.connect();
    const connected = await waitUntilConnected(client, CONNECT_TIMEOUT_MS);
    if (!connected) {
        console.error('[gapScreenerCoverOrder] Could not connect to the order process (is the orchestrator running?) - aborting.');
        process.exitCode = 1;
        return;
    }

    let placed = 0;
    const alreadyPlaced = readPlaced();
    for (const row of rows) {
        if (alreadyPlaced.has(row.antStockCode)) {
            console.warn(`[gapScreenerCoverOrder] skipping ${row.antStockCode}: a cover order was already placed for it today`);
            continue;
        }
        const contract = AntContractMaster.getInstance().findByTradingSymbol(row.optionContract, 'NFO');
        if (!contract) {
            console.warn(`[gapScreenerCoverOrder] skipping ${row.antStockCode}: contract ${row.optionContract} not found in NFO contract master`);
            continue;
        }
        // The configured quantity must be whole lots of THIS contract (lot sizes differ per stock), and a flat stop-loss
        // at or above the premium is meaningless (the option cannot lose more than its price).
        const lotSize = Number(contract.lotSize);
        if (!(lotSize > 0) || quantity % lotSize !== 0) {
            console.warn(`[gapScreenerCoverOrder] skipping ${row.antStockCode}: quantity ${quantity} is not a multiple of lot size ${contract.lotSize}`);
            continue;
        }
        if (Number.isFinite(row.premium) && row.premium > 0 && stopLossPoints >= row.premium) {
            console.warn(`[gapScreenerCoverOrder] skipping ${row.antStockCode}: stop-loss ${stopLossPoints} pts >= premium ${row.premium}`);
            continue;
        }
        // Recorded BEFORE the call: if it fails ambiguously (timeout) the order may be live, and a rerun must not
        // repeat it. Check the order book before clearing this by hand.
        alreadyPlaced.add(row.antStockCode);
        writePlaced(alreadyPlaced);
        try {
            await client.antPlaceCoverOrder(userEmail, {
                tradingSymbol: row.optionContract,
                instrumentId: contract.token,
                quantity,
                exchange: 'NFO',
                transactionType: 'BUY',
                stopLossPoints,
            });
            console.log(`[gapScreenerCoverOrder] Placed cover order for ${row.antStockCode} -> ${row.optionContract}`);
            placed++;
        } catch (e: any) {
            console.error(`[gapScreenerCoverOrder] Failed to place cover order for ${row.antStockCode} -> ${row.optionContract}:`, e.message);
        }
    }

    console.log(`\nPlaced ${placed}/${rows.length} cover order(s).`);
}

main()
    .catch((err) => {
        console.error('Fatal error:', err.message);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode ?? 0));
