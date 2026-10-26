import NseClient, { StockData } from './nseClient';
import Mongo from '../tools/mongo';

const INDICES = ['NIFTY 50', 'NIFTY NEXT 50'];

async function fetchAndStore() {
    const client = new NseClient();
    // The trading day is the IST calendar day, not the host's.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    let mongoOpen = false;

    try {
        console.log('Launching browser...');
        await client.init();

        await Mongo.init();
        mongoOpen = true;
        const db = Mongo.getInstance().db;
        const collection = db.collection('momentum_daily');

        await collection.createIndex({ date: 1, symbol: 1 }, { unique: true });

        for (const index of INDICES) {
            console.log(`Fetching ${index}...`);
            const stocks = await client.getIndexStocks(index);

            // On a weekend/holiday (or before the day's first print) NSE serves the PREVIOUS session: storing that under
            // today's date would create a phantom day and skew the weekly volume ratio.
            if (client.lastDataDate && client.lastDataDate !== today) {
                console.log(`Skipping ${index}: NSE data is dated ${client.lastDataDate}, not today (${today}) - not a trading day yet.`);
                continue;
            }

            for (const stock of stocks) {
                await collection.replaceOne(
                    { date: today, symbol: stock.symbol },
                    {
                        date: today,
                        index,
                        symbol: stock.symbol,
                        ltp: stock.ltp,
                        open: stock.open,
                        high: stock.high,
                        low: stock.low,
                        previousClose: stock.previousClose,
                        pChange: stock.pChange,
                        volume: stock.volume,
                    },
                    { upsert: true }
                );
            }
            console.log(`Saved ${stocks.length} stocks for ${index}`);
        }

        console.log(`Done. Date: ${today}`);
    } finally {
        // Always release headless Chrome and the Mongo connection, even when a fetch threw.
        await client.close().catch(() => undefined);
        if (mongoOpen) await Mongo.getInstance().close().catch(() => undefined);
    }
}

fetchAndStore().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
});
