import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import Log from '../util/Log';
import { exchangeForIndex } from '../util/underlyings';

type Index = 'NIFTY' | 'SENSEX';
type Exchange = 'NFO' | 'BFO';

interface CsvInstrument {
    tradingsymbol: string;
    name: string;
    expiry: string; // YYYY-MM-DD
    strike: number;
    instrument_type: string;
    instrument_token: number;
    lot_size: number;
}

// Reads the locally-downloaded instrument master (data/kite/{NFO,BFO}_instruments.csv
// - see scripts/download-all-masters.sh) instead of calling Kite's API live,
// mirroring AntContractMaster's convention (src/ant/AntContractMaster.ts) of
// resolving against a downloaded file. Re-run the download script to refresh
// when the file is stale; nothing in this class calls out to the network.
class KiteContractMaster {
    private static instance: KiteContractMaster;
    private instrumentsCache: Map<Exchange, CsvInstrument[]> = new Map();

    // Index -> exchange segment / strike step. SENSEX options trade on BFO
    // (BSE F&O), not NFO, with a 100-point strike step vs NIFTY's 50 - see
    // src/broker/KiteBroker.ts's INDEX_EXCHANGE for the same mapping.
    private readonly INDEX_EXCHANGE: Record<Index, Exchange> = { NIFTY: 'NFO', SENSEX: 'BFO' };
    private readonly STRIKE_STEP: Record<Index, number> = { NIFTY: 50, SENSEX: 100 };

    // Warms the NFO and BFO instrument caches at startup (see AntContractMaster.preload).
    // The master changes every trading day (new weekly expiries are listed ahead of time) and nothing else
    // refreshes it: on 2026-10-19 a file dated Aug 20 had no 19-Oct weekly, so the Kite symbol resolved to the
    // 27-Oct monthly while the strike was priced on ANT's 19-Oct expiry. If the file was not written today, download
    // it again before loading (public endpoint, no auth). Written to a temp file and renamed, so a process reading
    // it concurrently never sees a half-written file. Any failure keeps the existing file.
    private refreshing = new Set<Exchange>();
    private cacheDay = new Map<Exchange, string>();

    private isFileFromToday(filePath: string): boolean {
        try {
            return fs.existsSync(filePath) && fs.statSync(filePath).mtime.toDateString() === new Date().toDateString();
        } catch {
            return false;
        }
    }

    // Non-blocking (async curl, so a slow/hung endpoint can no longer freeze the event loop for up
    // to 140s); deduped per exchange. On success the in-memory cache is dropped so the next lookup
    // reloads the fresh file.
    private refreshIfStale(exchange: Exchange): Promise<void> {
        const filePath = path.join(__dirname, '../../data/kite', `${exchange}_instruments.csv`);
        if (this.isFileFromToday(filePath) || this.refreshing.has(exchange)) return Promise.resolve();
        this.refreshing.add(exchange);
        const tmp = `${filePath}.${process.pid}.tmp`;
        return new Promise<void>((resolve) => {
            execFile('curl', ['-sf', '-m', '60', '-o', tmp, `https://api.kite.trade/instruments/${exchange}`], { timeout: 70000 }, (err) => {
                try {
                    if (err) throw err;
                    const lines = fs.readFileSync(tmp, 'utf-8').split('\n').length;
                    if (lines < 1000) throw new Error(`downloaded ${exchange} master has only ${lines} lines`);
                    fs.renameSync(tmp, filePath);
                    this.instrumentsCache.delete(exchange);
                    Log.log(`[KiteContractMaster] refreshed stale ${exchange} master (${lines} lines)`);
                } catch (e: any) {
                    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
                    Log.log(`[KiteContractMaster] ALERT: could not refresh the ${exchange} instrument master - using the existing file: ${e?.message ?? e}`);
                } finally {
                    this.refreshing.delete(exchange);
                    // Whatever happened, don't re-attempt on every lookup again today.
                    this.cacheDay.set(exchange, new Date().toDateString());
                    resolve();
                }
            });
        });
    }

    // Startup only: block (bounded) so the first lookups never run on a previous day's expiries
    // (the 2026-10-19 wrong-expiry incident). Runtime refreshes stay async.
    private refreshAtStartup(exchange: Exchange): void {
        const filePath = path.join(__dirname, '../../data/kite', `${exchange}_instruments.csv`);
        if (this.isFileFromToday(filePath)) return;
        const tmp = `${filePath}.${process.pid}.tmp`;
        try {
            execFileSync('curl', ['-sf', '-m', '20', '-o', tmp, `https://api.kite.trade/instruments/${exchange}`], { timeout: 25000 });
            const lines = fs.readFileSync(tmp, 'utf-8').split('\n').length;
            if (lines < 1000) throw new Error(`downloaded ${exchange} master has only ${lines} lines`);
            fs.renameSync(tmp, filePath);
            Log.log(`[KiteContractMaster] refreshed stale ${exchange} master (${lines} lines)`);
        } catch (e: any) {
            try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
            Log.log(`[KiteContractMaster] ALERT: could not refresh the ${exchange} instrument master at startup - using the existing file: ${e?.message ?? e}`);
        }
    }

    preload(): void {
        for (const exchange of ['NFO', 'BFO'] as Exchange[]) {
            this.refreshAtStartup(exchange);
            const t0 = Date.now();
            const rows = this.loadInstruments(exchange).length; // a missing / unparsable file throws: both masters are required
            Log.log(`[KiteContractMaster] preload ${exchange}: ${rows} rows in ${Date.now() - t0}ms`);
        }
    }

    static getInstance(): KiteContractMaster {
        if (!KiteContractMaster.instance) {
            KiteContractMaster.instance = new KiteContractMaster();
        }
        return KiteContractMaster.instance;
    }

    private loadInstruments(exchange: Exchange): CsvInstrument[] {
        let cached = this.instrumentsCache.get(exchange);
        if (cached) {
            // Long-lived process: once the calendar day rolls over, kick off a background refresh
            // (the cache is replaced when it lands) instead of serving yesterday's expiries forever.
            if (this.cacheDay.get(exchange) !== new Date().toDateString()) {
                void this.refreshIfStale(exchange);
            }
            return cached;
        }

        const filePath = path.join(__dirname, '../../data/kite', `${exchange}_instruments.csv`);
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const header = lines[0].split(',');
        const idx = (col: string) => header.indexOf(col);
        const tradingsymbolIdx = idx('tradingsymbol');
        const nameIdx = idx('name');
        const expiryIdx = idx('expiry');
        const strikeIdx = idx('strike');
        const typeIdx = idx('instrument_type');
        const tokenIdx = idx('instrument_token');
        const lotSizeIdx = idx('lot_size');

        cached = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            const cols = line.split(',');
            const instrumentType = cols[typeIdx];
            if (instrumentType !== 'CE' && instrumentType !== 'PE') continue; // skip futures/equity rows
            cached.push({
                tradingsymbol: cols[tradingsymbolIdx],
                name: cols[nameIdx].replace(/"/g, ''),
                expiry: cols[expiryIdx],
                strike: Number(cols[strikeIdx]),
                instrument_type: instrumentType,
                instrument_token: Number(cols[tokenIdx]),
                lot_size: Number(cols[lotSizeIdx]),
            });
        }
        this.instrumentsCache.set(exchange, cached);
        this.cacheDay.set(exchange, new Date().toDateString());
        return cached;
    }

    async findATMOption(
        underlyingLtp: number,
        optionType: 'CE' | 'PE',
        index: Index = 'NIFTY'
    ): Promise<{ tradingSymbol: string; instrumentToken: number; lotSize: number; exchange: Exchange }> {
        const strikeStep = this.STRIKE_STEP[index];
        const atmStrike = Math.round(underlyingLtp / strikeStep) * strikeStep;
        return this.findNearestExpiryOption(atmStrike, optionType, index, 0);
    }

    async findExactOption(
        strike: number,
        expiry: string,
        optionType: 'CE' | 'PE',
        index: Index = 'NIFTY'
    ): Promise<{ tradingSymbol: string; instrumentToken: number; lotSize: number; exchange: Exchange }> {
        const exchange = this.INDEX_EXCHANGE[index];
        const instruments = this.loadInstruments(exchange);
        const expiryDateString = new Date(expiry).toDateString();

        const contract = instruments.find(
            (i) =>
                i.name === index &&
                i.instrument_type === optionType &&
                i.strike === strike &&
                new Date(i.expiry).toDateString() === expiryDateString
        );

        if (!contract) {
            throw new Error(`No ${index} ${optionType} contract found for strike ${strike} expiry ${expiry}`);
        }

        return {
            tradingSymbol: contract.tradingsymbol,
            instrumentToken: contract.instrument_token,
            lotSize: contract.lot_size,
            exchange,
        };
    }

    // Exact (symbol, strike, expiry, optionType) resolution for any NFO/BFO
    // underlying, not just the NIFTY/SENSEX Index union findExactOption is
    // restricted to - used by TopStockOptionsOpeningGapStrategy, which must
    // match ANT's chosen expiry exactly (not "nearest"), the same contract
    // for an individual stock. Only SENSEX trades on BFO; every stock (and
    // NIFTY/BANKNIFTY) is NFO.
    async findExactOptionBySymbol(
        symbol: string,
        strike: number,
        expiry: string,
        optionType: 'CE' | 'PE'
    ): Promise<{ tradingSymbol: string; instrumentToken: number; lotSize: number; exchange: Exchange }> {
        const exchange: Exchange = exchangeForIndex(symbol);
        const instruments = this.loadInstruments(exchange);
        const expiryDateString = new Date(expiry).toDateString();

        const contract = instruments.find(
            (i) =>
                i.name === symbol &&
                i.instrument_type === optionType &&
                i.strike === strike &&
                new Date(i.expiry).toDateString() === expiryDateString
        );

        if (!contract) {
            throw new Error(`No ${symbol} ${optionType} contract found for strike ${strike} expiry ${expiry}`);
        }

        return {
            tradingSymbol: contract.tradingsymbol,
            instrumentToken: contract.instrument_token,
            lotSize: contract.lot_size,
            exchange,
        };
    }

    // Canonical-symbol resolution: exact (symbol, strike, optionType), no
    // expiry given - resolves to the nearest expiry (expiryOffset=0) or the
    // Nth-nearest (expiryOffset=1 => "next", etc). Not exposed as a user
    // choice anywhere yet - see src/model/CanonicalSymbol.ts.
    // `symbol` is any NFO/BFO underlying (a stock ticker, not just NIFTY/SENSEX)
    // - unlike findATMOption, this doesn't need a strike-step (the exact strike
    // is already given), so it isn't restricted to the Index union. Only
    // SENSEX trades on BFO; everything else (all stocks, NIFTY, BANKNIFTY, ...)
    // is NFO.
    async findNearestExpiryOption(
        strike: number,
        optionType: 'CE' | 'PE',
        symbol: string = 'NIFTY',
        expiryOffset = 0
    ): Promise<{ tradingSymbol: string; instrumentToken: number; lotSize: number; exchange: Exchange }> {
        const exchange: Exchange = exchangeForIndex(symbol);
        const instruments = this.loadInstruments(exchange);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const candidates = instruments
            .filter((i) => i.name === symbol && i.instrument_type === optionType && i.strike === strike && new Date(i.expiry) >= today)
            .sort((a, b) => new Date(a.expiry).getTime() - new Date(b.expiry).getTime());

        const contract = candidates[expiryOffset];
        if (!contract) {
            throw new Error(`No ${symbol} ${optionType} contract found for strike ${strike} (expiryOffset=${expiryOffset})`);
        }

        return {
            tradingSymbol: contract.tradingsymbol,
            instrumentToken: contract.instrument_token,
            lotSize: contract.lot_size,
            exchange,
        };
    }
}

export default KiteContractMaster;
