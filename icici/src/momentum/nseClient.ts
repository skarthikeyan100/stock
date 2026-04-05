import puppeteer, { Browser, Page } from 'puppeteer-core';

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

    async init(): Promise<void> {
        this.browser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
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
        await new Promise(r => setTimeout(r, 2000));
    }

    async getIndexStocks(indexName: string): Promise<StockData[]> {
        if (!this.page) throw new Error('Call init() first');

        const url = `${BASE_URL}/api/equity-stockIndices?index=${encodeURIComponent(indexName)}`;
        const response = await this.page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        if (!response || !response.ok()) {
            throw new Error(`Failed to fetch ${indexName}: HTTP ${response?.status()}`);
        }

        const body = await response.json();
        const stocks: StockData[] = body.data
            .filter((item: any) => item.symbol !== indexName.replace(/\s/g, ''))
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

    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }
}

export default NseClient;
