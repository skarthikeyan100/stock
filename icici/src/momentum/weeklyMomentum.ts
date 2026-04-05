import Mongo from '../tools/mongo';
import moment from 'moment';

interface DailyRecord {
    date: string;
    index: string;
    symbol: string;
    ltp: number;
    volume: number;
    pChange: number;
}

interface MomentumResult {
    symbol: string;
    index: string;
    priceTrend: number;
    volumeRatio: number;
    momentumScore: number;
    earliestLTP: number;
    latestLTP: number;
}

async function calculateMomentum() {
    await Mongo.init();
    const db = Mongo.getInstance().db;
    const collection = db.collection('momentum_daily');

    // Get current week's Monday and Friday
    const monday = moment().startOf('isoWeek').format('YYYY-MM-DD');
    const friday = moment().endOf('isoWeek').subtract(2, 'days').format('YYYY-MM-DD');

    console.log(`Calculating momentum for week: ${monday} to ${friday}`);

    const records: DailyRecord[] = await collection.find({
        date: { $gte: monday, $lte: friday }
    }).sort({ date: 1 }).toArray() as any;

    if (records.length === 0) {
        console.log('No data found for this week. Run momentum:fetch on trading days first.');
        await Mongo.getInstance().close();
        return;
    }

    const dates = [...new Set(records.map(r => r.date))].sort();
    console.log(`Found data for ${dates.length} trading day(s): ${dates.join(', ')}`);

    if (dates.length < 2) {
        console.log('Only 1 day of data — ranking by daily % change instead.');
        const indices = ['NIFTY 50', 'NIFTY NEXT 50'];
        const picks: any[] = [];

        for (const idx of indices) {
            const indexStocks = records
                .filter(r => r.index === idx)
                .sort((a, b) => b.pChange - a.pChange);

            const top3 = indexStocks.slice(0, 3);
            picks.push(...top3);

            console.log(`\n=== ${idx} — Top 3 by Daily % Change ===`);
            console.log('Rank | Symbol          | % Change | LTP');
            console.log('-----|-----------------|----------|--------');
            top3.forEach((s, i) => {
                console.log(
                    `  ${i + 1}  | ${s.symbol.padEnd(15)} | ${(s.pChange.toFixed(2) + '%').padStart(8)} | ${s.ltp}`
                );
            });
        }

        const picksCollection = db.collection('momentum_picks');
        const weekKey = `${monday}_${friday}`;
        await picksCollection.replaceOne(
            { week: weekKey },
            {
                week: weekKey,
                monday,
                friday,
                calculatedAt: new Date().toISOString(),
                method: 'pChange',
                picks: picks.map(p => ({
                    symbol: p.symbol,
                    index: p.index,
                    pChange: p.pChange,
                    ltp: p.ltp,
                })),
            },
            { upsert: true }
        );

        console.log(`\nPicks saved to momentum_picks collection (week: ${weekKey})`);
        await Mongo.getInstance().close();
        return;
    }

    // Split dates into early and late halves for volume comparison
    const midpoint = Math.ceil(dates.length / 2);
    const earlyDates = dates.slice(0, midpoint);
    const lateDates = dates.slice(midpoint);

    // Group records by symbol
    const bySymbol = new Map<string, DailyRecord[]>();
    for (const rec of records) {
        const list = bySymbol.get(rec.symbol) || [];
        list.push(rec);
        bySymbol.set(rec.symbol, list);
    }

    const results: MomentumResult[] = [];

    for (const [symbol, days] of bySymbol) {
        days.sort((a, b) => a.date.localeCompare(b.date));
        const earliest = days[0];
        const latest = days[days.length - 1];

        if (earliest.ltp === 0) continue;

        const priceTrend = ((latest.ltp - earliest.ltp) / earliest.ltp) * 100;

        const earlyVolumes = days.filter(d => earlyDates.includes(d.date)).map(d => d.volume);
        const lateVolumes = days.filter(d => lateDates.includes(d.date)).map(d => d.volume);

        const avgEarly = earlyVolumes.reduce((a, b) => a + b, 0) / earlyVolumes.length || 1;
        const avgLate = lateVolumes.reduce((a, b) => a + b, 0) / lateVolumes.length || 1;
        const volumeRatio = avgLate / avgEarly;

        const momentumScore = priceTrend * volumeRatio;

        results.push({
            symbol,
            index: earliest.index,
            priceTrend: Math.round(priceTrend * 100) / 100,
            volumeRatio: Math.round(volumeRatio * 100) / 100,
            momentumScore: Math.round(momentumScore * 100) / 100,
            earliestLTP: earliest.ltp,
            latestLTP: latest.ltp,
        });
    }

    // Top 3 per index
    const indices = ['NIFTY 50', 'NIFTY NEXT 50'];
    const picks: MomentumResult[] = [];

    for (const idx of indices) {
        const indexResults = results
            .filter(r => r.index === idx)
            .sort((a, b) => b.momentumScore - a.momentumScore);

        const top3 = indexResults.slice(0, 3);
        picks.push(...top3);

        console.log(`\n=== ${idx} — Top 3 Momentum Stocks ===`);
        console.log('Rank | Symbol          | Price Trend | Vol Ratio | Score   | LTP');
        console.log('-----|-----------------|-------------|-----------|---------|--------');
        top3.forEach((s, i) => {
            console.log(
                `  ${i + 1}  | ${s.symbol.padEnd(15)} | ${(s.priceTrend + '%').padStart(10)}  | ${s.volumeRatio.toFixed(2).padStart(9)} | ${s.momentumScore.toFixed(2).padStart(7)} | ${s.latestLTP}`
            );
        });
    }

    // Store picks in MongoDB
    const picksCollection = db.collection('momentum_picks');
    const weekKey = `${monday}_${friday}`;
    await picksCollection.replaceOne(
        { week: weekKey },
        {
            week: weekKey,
            monday,
            friday,
            calculatedAt: new Date().toISOString(),
            picks: picks.map(p => ({
                symbol: p.symbol,
                index: p.index,
                priceTrend: p.priceTrend,
                volumeRatio: p.volumeRatio,
                momentumScore: p.momentumScore,
                ltp: p.latestLTP,
            })),
        },
        { upsert: true }
    );

    console.log(`\nPicks saved to momentum_picks collection (week: ${weekKey})`);
    await Mongo.getInstance().close();
}

calculateMomentum().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
});
