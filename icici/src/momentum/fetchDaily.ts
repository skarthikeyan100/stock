import NseClient, { StockData } from './nseClient';
import Mongo from '../tools/mongo';
import moment from 'moment';

const INDICES = ['NIFTY 50', 'NIFTY NEXT 50'];

async function fetchAndStore() {
    const client = new NseClient();
    const today = moment().format('YYYY-MM-DD');

    console.log('Launching browser...');
    await client.init();

    await Mongo.init();
    const db = Mongo.getInstance().db;
    const collection = db.collection('momentum_daily');

    await collection.createIndex({ date: 1, symbol: 1 }, { unique: true });

    for (const index of INDICES) {
        console.log(`Fetching ${index}...`);
        const stocks = await client.getIndexStocks(index);

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
    await client.close();
    await Mongo.getInstance().close();
}

fetchAndStore().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
});
