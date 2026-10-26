import puppeteer, { Browser, Page } from 'puppeteer-core';
import { sleep } from '../util/sleep';

const BASE_URL = 'https://www.nseindia.com';

export interface StockData {
    symbol: string;
    ltp: number;
    open: number;
    high: number;
    low: number;
    previousClose: number;
    pChange: number;
    volume: number;
}

class NseClient {
    private browser: Browser | null = null;
    private page: Page | null = null;
    // Trading date (YYYY-MM-DD) the last getIndexStocks response is for, from NSE's own timestamp; null if unreadable.
    lastDataDate: string | null = null;

    async init(): Promise<void> {
        this.browser = await puppeteer.launch({
            executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        this.page = await this.browser.newPage();
        await this.page.setUserAgent(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        // Visit homepage first to establish session cookies
        await this.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Small delay for cookies to settle
        await sleep(2000);
    }

    async getIndexStocks(indexName: string): Promise<StockData[]> {
        if (!this.page) throw new Error('Call init() first');

        const url = `${BASE_URL}/api/equity-stockIndices?index=${encodeURIComponent(indexName)}`;
        const response = await this.page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        if (!response || !response.ok()) {
            throw new Error(`Failed to fetch ${indexName}: HTTP ${response?.status()}`);
        }

        const body = await response.json();
        // An Akamai block page / HTML 200 has no `data`: fail clearly instead of a TypeError on .filter.
        if (!body || !Array.isArray(body.data)) {
            throw new Error(`Unexpected response for ${indexName}: no data array (blocked or changed API?)`);
        }
        this.lastDataDate = NseClient.parseNseDate(body.timestamp ?? body.metadata?.timeVal);
        // The index's own summary row ('NIFTY 50', with a space) is returned alongside its constituents: drop it.
        const norm = (v: unknown) => String(v ?? '').replace(/\s/g, '').toUpperCase();
        const stocks: StockData[] = body.data
            .filter((item: any) => norm(item.symbol) !== norm(indexName) && norm(item.indexName ?? '') !== norm(indexName))
            .map((item: any) => ({
                symbol: item.symbol,
                ltp: item.lastPrice,
                open: item.open,
                high: item.dayHigh,
                low: item.dayLow,
                previousClose: item.previousClose,
                pChange: item.pChange,
                volume: item.totalTradedVolume,
            }));
        return stocks;
    }

    // '26-Oct-2026 15:30:00' (IST) -> '2026-10-26'
    static parseNseDate(raw: unknown): string | null {
        const m = String(raw ?? '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
        if (!m) return null;
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const mi = months.indexOf(m[2].toLowerCase());
        if (mi < 0) return null;
        return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }

    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }
}

export default NseClient;
