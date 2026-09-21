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

// Anchored to process.cwd() (always the repo root - every gapscreener:*
// npm script, and both cron wrapper scripts, run from there), NOT __dirname:
// __dirname in compiled code is dist/tools/gapscreener/, which would put
// this CSV in the build-output tree instead of alongside its TS source.
const RESULT_CSV = path.join(process.cwd(), 'src', 'tools', 'gapscreener', 'gap_screener_option_quote.csv');
const CONNECT_TIMEOUT_MS = 5000;

interface MorningRow {
    antStockCode: string;
    optionContract: string;
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
        }))
        .filter((row) => row.antStockCode.length > 0 && row.optionContract.length > 0);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    for (const row of rows) {
        const contract = AntContractMaster.getInstance().findByTradingSymbol(row.optionContract, 'NFO');
        if (!contract) {
            console.warn(`[gapScreenerCoverOrder] skipping ${row.antStockCode}: contract ${row.optionContract} not found in NFO contract master`);
            continue;
        }
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
