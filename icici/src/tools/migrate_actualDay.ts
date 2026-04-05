import MongoClient from 'mongodb';

const DB_URL = 'mongodb://localhost:27017/stocks';
const COLLECTION = 'NiftyQuote';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const run = async () => {
    const client = await MongoClient.connect(DB_URL, { useUnifiedTopology: true });
    const db = client.db('stocks');
    const collection = db.collection(COLLECTION);

    const cursor = collection.find({ time: { $exists: false }, ltt: { $exists: true } });
    let updated = 0;
    let skipped = 0;
    let i = 1;
    const dateStats = new Map<string, { min: string; max: string }>();

    while (await cursor.hasNext()) {
        console.log('Record: ', i++)
        const doc = await cursor.next();
        const lttSeconds = parseInt(doc.ltt);
        if (isNaN(lttSeconds)) {
            console.log(`Skipping _id=${doc._id}: ltt="${doc.ltt}" is not a valid timestamp`);
            skipped++;
            continue;
        }
        const d = new Date(lttSeconds * 1000);
        const actualDay = DAYS[d.getDay()];
        const date = `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}`;
        const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const stats = dateStats.get(date);
        if (!stats) {
            dateStats.set(date, { min: time, max: time });
        } else {
            if (time < stats.min) stats.min = time;
            if (time > stats.max) stats.max = time;
        }
        // await collection.updateOne({ _id: doc._id }, { $set: { actualDay, date, time } });
        updated++;
    }

    console.log(`Done. Updated: ${updated}, Skipped: ${skipped}`);
    console.log('\nUnique dates:');
    [...dateStats.keys()].sort().forEach(date => {
        const { min, max } = dateStats.get(date);
        console.log(`  ${date}  min: ${min}  max: ${max}`);
    });
    await client.close();
};

run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
