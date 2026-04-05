/**
 * Compute RSI_5_80_20 and EMA_30_70 on 1-min candle closes from MongoDB.
 * Prints identical columns to analysis/check_indicators.py for direct comparison.
 *
 * Run: npx ts-node src/tools/check_indicators.ts
 */
import Mongo from './mongo';
import { buildCandles } from '../lib/candle-builder';
import { calcRSI, calcEMACrossover } from '../lib/indicators';

const RSI_PERIOD = 5, OVERBOUGHT = 80, OVERSOLD = 20;
const EMA_SHORT = 30, EMA_LONG = 70;
const INTERVAL_SECONDS = 60;

async function main() {
    await Mongo.init();
    const db = Mongo.getInstance().db;
    const quotes = await db.collection('NiftyQuote').find({}).sort({ ltt: 1 }).toArray();
    console.error(`Loaded ${quotes.length} quotes`);

    const candles = buildCandles(quotes, INTERVAL_SECONDS);
    console.error(`Built ${candles.length} 1-min candles`);

    const closes: number[] = [];
    console.log(`${'idx'.padStart(4)}  ${'close'.padStart(8)}  ${'RSI'.padStart(6)}  ${'RSI_trend'.padStart(10)}  ${'EMA_trend'.padStart(10)}`);
    console.log('-'.repeat(48));

    for (let i = 0; i < candles.length; i++) {
        closes.push(candles[i].close);

        const rsiResult = calcRSI(closes, RSI_PERIOD, OVERBOUGHT, OVERSOLD);
        const emaResult = calcEMACrossover(closes, EMA_SHORT, EMA_LONG);

        const rsiStr   = rsiResult !== null ? rsiResult.value.toFixed(2) : '  null';
        const rsiTrend = rsiResult !== null ? rsiResult.trend : 'null';
        const emaTrend = emaResult !== null ? emaResult.trend : 'null';

        console.log(`${String(i).padStart(4)}  ${candles[i].close.toFixed(2).padStart(8)}  ${rsiStr.padStart(6)}  ${rsiTrend.padStart(10)}  ${emaTrend.padStart(10)}`);
    }

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
