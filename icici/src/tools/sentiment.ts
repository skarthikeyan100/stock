/**
 * Stock Sentiment Analyzer
 *
 * Sources: Google News RSS, Reddit, StockTwits, Economic Times RSS, Moneycontrol RSS, Yahoo Finance
 * NLP: VADER Sentiment
 *
 * Usage:
 *   tsc && node dist/tools/sentiment.js
 *   tsc && node dist/tools/sentiment.js --input stocks.csv --output results.csv --concurrency 3 --delay 1500
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import axios from 'axios';
import Parser from 'rss-parser';
import pLimit from 'p-limit';
import { SentimentIntensityAnalyzer } from 'vader-sentiment';

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function getArg(name: string, defaultValue: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}

const INPUT_CSV   = getArg('input',       path.join(__dirname, '../../stocks.csv'));
const OUTPUT_CSV  = getArg('output',      path.join(__dirname, '../../sentiment_results.csv'));
const CONCURRENCY = parseInt(getArg('concurrency', '3'), 10);
const DELAY_MS    = parseInt(getArg('delay',        '1500'), 10);

// ─── Types ───────────────────────────────────────────────────────────────────

interface StockEntry {
    symbol: string;
    name: string;
}

interface VaderScore {
    pos: number;
    neg: number;
    neu: number;
    compound: number;
}

interface SentimentScore {
    label: 'Positive' | 'Negative' | 'Neutral';
    confidence: number;
    compound: number;
    positive: number;
    negative: number;
    neutral: number;
    sampleCount: number;
}

interface ResultRow {
    symbol: string;
    name: string;
    sentiment: string;
    confidence: number;
    compound: number;
    positive: number;
    negative: number;
    neutral: number;
    newsCount: number;
    redditCount: number;
    etCount: number;
    mcCount: number;
    yahooCount: number;
    sampleCount: number;
    timestamp: string;
}

// ─── CSV Reader ──────────────────────────────────────────────────────────────

function readStocks(csvPath: string): StockEntry[] {
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
        .map(row => {
            const symbol = (row['Stock'] || row['Symbol'] || row['symbol'] || row['SYMBOL'] || '').trim();
            const name   = (row['Name']  || row['name']  || row['Company'] || symbol).trim();
            return { symbol, name };
        })
        .filter(s => s.symbol.length > 0);
}

// ─── Google News Client ──────────────────────────────────────────────────────

class NewsClient {
    private rssParser = new Parser({ timeout: 10000 });

    async fetchHeadlines(symbol: string, name: string): Promise<string[]> {
        const queries: string[] = [`${symbol} NSE stock India`];
        if (name !== symbol && name.length > 0) {
            queries.push(`"${name}" stock India`);
        }

        const texts: string[] = [];
        for (const q of queries) {
            const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
            try {
                const feed = await this.rssParser.parseURL(url);
                for (const item of (feed.items || []).slice(0, 10)) {
                    if (item.title) texts.push(item.title);
                    if (item.contentSnippet) texts.push(item.contentSnippet);
                }
            } catch (err: any) {
                console.warn(`  [GoogleNews] Failed for "${q}": ${err.message}`);
            }
        }
        return texts;
    }
}

// ─── Reddit Client ───────────────────────────────────────────────────────────

class RedditClient {
    private headers = {
        'User-Agent': 'StockSentimentAnalyzer/1.0 (standalone research tool)',
        'Accept': 'application/json',
    };

    async fetchPosts(symbol: string): Promise<string[]> {
        const urls = [
            `https://www.reddit.com/r/IndianStockMarket/search.json?q=${encodeURIComponent(symbol)}&restrict_sr=1&sort=new&limit=10&t=month`,
            `https://www.reddit.com/search.json?q=${encodeURIComponent(symbol + ' NSE India')}&sort=new&limit=10&t=month`,
        ];

        const texts: string[] = [];
        for (const url of urls) {
            try {
                const res = await axios.get(url, { headers: this.headers, timeout: 10000 });
                const children: any[] = res.data?.data?.children ?? [];
                for (const child of children) {
                    const post = child.data;
                    if (post.title) texts.push(post.title);
                    if (post.selftext?.length > 0) texts.push(post.selftext.substring(0, 500));
                }
            } catch (err: any) {
                if (err.response?.status === 429) {
                    console.warn(`  [Reddit] Rate limited for ${symbol}`);
                } else {
                    console.warn(`  [Reddit] Failed for ${symbol}: ${err.message}`);
                }
            }
        }
        return texts;
    }
}

// ─── Economic Times Client ───────────────────────────────────────────────────
//
// Economic Times publishes RSS feeds for market news. We use the general
// markets feed and filter items that mention the stock symbol or name.

class EconomicTimesClient {
    private rssParser = new Parser({ timeout: 10000 });

    // ET market RSS feeds (general — filtered by symbol match after fetch)
    private feeds = [
        'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms',  // stocks news
        'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',       // markets
    ];

    async fetchHeadlines(symbol: string, name: string): Promise<string[]> {
        const texts: string[] = [];
        const terms = [symbol.toLowerCase(), name.toLowerCase()];

        for (const feedUrl of this.feeds) {
            try {
                const feed = await this.rssParser.parseURL(feedUrl);
                for (const item of feed.items || []) {
                    const combined = `${item.title || ''} ${item.contentSnippet || ''}`.toLowerCase();
                    if (terms.some(t => combined.includes(t))) {
                        if (item.title) texts.push(item.title);
                        if (item.contentSnippet) texts.push(item.contentSnippet);
                    }
                }
            } catch (err: any) {
                console.warn(`  [EconomicTimes] Feed failed: ${err.message}`);
            }
        }
        return texts;
    }
}

// ─── Moneycontrol Client ─────────────────────────────────────────────────────
//
// Moneycontrol is India's largest financial portal. We fetch their top news
// RSS and filter for relevant items.

class MoneycontrolClient {
    private rssParser = new Parser({ timeout: 10000 });

    private feeds = [
        'https://www.moneycontrol.com/rss/MCtopnews.xml',
        'https://www.moneycontrol.com/rss/marketreports.xml',
        'https://www.moneycontrol.com/rss/results.xml',
    ];

    async fetchHeadlines(symbol: string, name: string): Promise<string[]> {
        const texts: string[] = [];
        const terms = [symbol.toLowerCase(), name.toLowerCase()];

        for (const feedUrl of this.feeds) {
            try {
                const feed = await this.rssParser.parseURL(feedUrl);
                for (const item of feed.items || []) {
                    const combined = `${item.title || ''} ${item.contentSnippet || ''}`.toLowerCase();
                    if (terms.some(t => combined.includes(t))) {
                        if (item.title) texts.push(item.title);
                        if (item.contentSnippet) texts.push(item.contentSnippet);
                    }
                }
            } catch (err: any) {
                console.warn(`  [Moneycontrol] Feed failed: ${err.message}`);
            }
        }
        return texts;
    }
}

// ─── Yahoo Finance Client ────────────────────────────────────────────────────
//
// Yahoo Finance's undocumented but stable search/news endpoint — no API key.
// Appending .NS to the symbol targets NSE-listed stocks.

class YahooFinanceClient {
    async fetchNews(symbol: string, _name: string): Promise<string[]> {
        const yahooSymbol = `${symbol}.NS`;
        const texts: string[] = [];

        // Endpoint 1: news search
        try {
            const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(yahooSymbol)}&newsCount=10&enableFuzzyQuery=false`;
            const res = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 10000,
            });
            const newsItems: any[] = res.data?.news ?? [];
            for (const item of newsItems) {
                if (item.title) texts.push(item.title);
            }
        } catch (err: any) {
            console.warn(`  [Yahoo] News search failed for ${symbol}: ${err.message}`);
        }

        // Endpoint 2: quote summary (longBusinessSummary has analyst sentiment language)
        try {
            const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=assetProfile,recommendationTrend`;
            const res = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 10000,
            });
            const profile = res.data?.quoteSummary?.result?.[0]?.assetProfile;
            if (profile?.longBusinessSummary) texts.push(profile.longBusinessSummary.substring(0, 500));

            // recommendationTrend: strongBuy, buy, hold, sell, strongSell counts
            const trend = res.data?.quoteSummary?.result?.[0]?.recommendationTrend?.trend?.[0];
            if (trend) {
                const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = trend;
                // Synthesise analyst consensus into sentiment words VADER can score
                for (let i = 0; i < strongBuy;  i++) texts.push('strong buy bullish analyst upgrade');
                for (let i = 0; i < buy;        i++) texts.push('buy bullish positive outlook');
                for (let i = 0; i < hold;       i++) texts.push('hold neutral stable');
                for (let i = 0; i < sell;       i++) texts.push('sell bearish negative');
                for (let i = 0; i < strongSell; i++) texts.push('strong sell bearish downgrade caution');
            }
        } catch {
            // quoteSummary can 404 for some symbols — silently skip
        }

        return texts;
    }
}

// ─── Sentiment Analyzer ───────────────────────────────────────────────────────

class SentimentAnalyzer {
    private analyzer = SentimentIntensityAnalyzer;

    score(texts: string[]): SentimentScore {
        const empty: SentimentScore = {
            label: 'Neutral', confidence: 0, compound: 0,
            positive: 0, negative: 0, neutral: 1, sampleCount: 0,
        };
        if (texts.length === 0) return empty;

        let sumPos = 0, sumNeg = 0, sumNeu = 0, sumCompound = 0;
        let validCount = 0;

        for (const text of texts) {
            const cleaned = text
                .replace(/[^\x00-\x7F]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (cleaned.length < 3) continue;

            const scores: VaderScore = this.analyzer.polarity_scores(cleaned);
            sumPos      += scores.pos;
            sumNeg      += scores.neg;
            sumNeu      += scores.neu;
            sumCompound += scores.compound;
            validCount++;
        }

        if (validCount === 0) return empty;

        const compound = sumCompound / validCount;
        const label: 'Positive' | 'Negative' | 'Neutral' =
            compound >= 0.05  ? 'Positive' :
            compound <= -0.05 ? 'Negative' : 'Neutral';

        const confidence = Math.min(100, Math.round(Math.abs(compound) * 100));
        const round = (n: number) => Math.round(n * 1000) / 1000;

        return {
            label,
            confidence,
            compound:  round(compound),
            positive:  round(sumPos / validCount),
            negative:  round(sumNeg / validCount),
            neutral:   round(sumNeu / validCount),
            sampleCount: validCount,
        };
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function errorRow(stock: StockEntry): ResultRow {
    return {
        symbol: stock.symbol, name: stock.name,
        sentiment: 'Neutral', confidence: 0, compound: 0,
        positive: 0, negative: 0, neutral: 1,
        newsCount: 0, redditCount: 0,
        etCount: 0, mcCount: 0, yahooCount: 0,
        sampleCount: 0, timestamp: new Date().toISOString(),
    };
}

// ─── Stock Processor ─────────────────────────────────────────────────────────

async function processStock(
    stock: StockEntry,
    newsClient: NewsClient,
    redditClient: RedditClient,
    etClient: EconomicTimesClient,
    mcClient: MoneycontrolClient,
    yahooClient: YahooFinanceClient,
    analyzer: SentimentAnalyzer,
): Promise<ResultRow> {
    const [newsTexts, redditTexts, etTexts, mcTexts, yahooTexts] = await Promise.all([
        newsClient.fetchHeadlines(stock.symbol, stock.name),
        redditClient.fetchPosts(stock.symbol),
        etClient.fetchHeadlines(stock.symbol, stock.name),
        mcClient.fetchHeadlines(stock.symbol, stock.name),
        yahooClient.fetchNews(stock.symbol, stock.name),
    ]);

    const allTexts = [...newsTexts, ...redditTexts, ...etTexts, ...mcTexts, ...yahooTexts];
    const score = analyzer.score(allTexts);

    return {
        symbol:      stock.symbol,
        name:        stock.name,
        sentiment:   score.label,
        confidence:  score.confidence,
        compound:    score.compound,
        positive:    score.positive,
        negative:    score.negative,
        neutral:     score.neutral,
        newsCount:   newsTexts.length,
        redditCount: redditTexts.length,
        etCount:     etTexts.length,
        mcCount:     mcTexts.length,
        yahooCount:  yahooTexts.length,
        sampleCount: score.sampleCount,
        timestamp:   new Date().toISOString(),
    };
}

// ─── CSV Writer ───────────────────────────────────────────────────────────────

function writeResults(results: ResultRow[], outputPath: string): void {
    const headers = [
        'Symbol', 'Name', 'Sentiment', 'Confidence(%)',
        'Compound', 'Positive', 'Negative', 'Neutral',
        'GoogleNewsCount', 'RedditCount',
        'EconomicTimesCount', 'MoneycontrolCount', 'YahooFinanceCount',
        'SampleCount', 'Timestamp',
    ];
    const rows = results.map(r => [
        r.symbol, r.name, r.sentiment, r.confidence,
        r.compound, r.positive, r.negative, r.neutral,
        r.newsCount, r.redditCount,
        r.etCount, r.mcCount, r.yahooCount,
        r.sampleCount, r.timestamp,
    ]);
    const output = stringify([headers, ...rows]);
    fs.writeFileSync(outputPath, output, 'utf8');
    console.log(`\nResults written to ${outputPath} (${results.length} stocks)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('=== Stock Sentiment Analyzer ===');
    console.log(`Input:       ${INPUT_CSV}`);
    console.log(`Output:      ${OUTPUT_CSV}`);
    console.log(`Concurrency: ${CONCURRENCY} stocks`);
    console.log(`Delay:       ${DELAY_MS}ms between batches`);
    console.log('Sources:     Google News · Reddit · Economic Times · Moneycontrol · Yahoo Finance');
    console.log('NLP engine:  VADER Sentiment\n');

    let stocks: StockEntry[];
    try {
        stocks = readStocks(INPUT_CSV);
    } catch (err: any) {
        console.error(`Error reading input: ${err.message}`);
        console.error('Create a stocks.csv with at minimum a "Stock" or "Symbol" column.');
        process.exit(1);
    }

    if (stocks.length === 0) {
        console.error('No stocks found in input CSV.');
        process.exit(1);
    }
    console.log(`Loaded ${stocks.length} stocks to analyze\n`);

    const newsClient   = new NewsClient();
    const redditClient = new RedditClient();
    const etClient     = new EconomicTimesClient();
    const mcClient        = new MoneycontrolClient();
    const yahooClient     = new YahooFinanceClient();
    const analyzer        = new SentimentAnalyzer();
    const limit           = pLimit(CONCURRENCY);

    const tasks = stocks.map((stock, i) =>
        limit(async () => {
            console.log(`[${String(i + 1).padStart(3)}/${stocks.length}] ${stock.symbol}`);
            try {
                const result = await processStock(
                    stock, newsClient, redditClient,
                    etClient, mcClient, yahooClient, analyzer,
                );
                console.log(
                    `        → ${result.sentiment} (confidence: ${result.confidence}%, samples: ${result.sampleCount}) ` +
                    `news:${result.newsCount} reddit:${result.redditCount} ` +
                    `et:${result.etCount} mc:${result.mcCount} yahoo:${result.yahooCount}`
                );
                await sleep(DELAY_MS);
                return result;
            } catch (err: any) {
                console.error(`        → ERROR: ${err.message}`);
                return errorRow(stock);
            }
        })
    );

    const results = await Promise.all(tasks);

    const positive = results.filter(r => r.sentiment === 'Positive').length;
    const negative = results.filter(r => r.sentiment === 'Negative').length;
    const neutral  = results.filter(r => r.sentiment === 'Neutral').length;
    const noData   = results.filter(r => r.sampleCount === 0).length;

    console.log('\n=== Summary ===');
    console.log(`Positive: ${positive} | Negative: ${negative} | Neutral: ${neutral}`);
    console.log(`No data (0 samples): ${noData} stocks`);

    writeResults(results, OUTPUT_CSV);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
