import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { execFileSync } from 'child_process';
import { parse } from 'csv-parse/sync';
import Log from '../util/Log';

// Isolated instance - NOT the bare `axios` default export - see
// src/prism/RestAPI.ts's header comment on why any new code making HTTP
// calls needs its own axios.create() rather than the global one.
const httpClient = axios.create();

export interface FnoRecord {
    token: string;
    instrumentName: string; // 'FUTIDX' | 'FUTSTK' | 'OPTIDX' | 'OPTSTK'
    shortName: string; // ICICI's stockCode for placeOrder/getQuotes, e.g. 'NIFTY', 'VEDLIM'
    series: string; // 'FUTURE' | 'OPTION'
    expiryDate: string; // 'DD-MMM-YYYY', matches Breeze's own expiryDate param format
    strikePrice: string;
    optionType: string; // 'CE' | 'PE' | 'XX' (XX for futures)
    lotSize: number;
    tickSize: number;
    companyName: string;
}

export interface CashRecord {
    token: string;
    shortName: string; // ICICI's stockCode
    series: string;
    companyName: string;
    symbol: string; // NSE trading symbol
}

// Wraps ICICI's officially documented Security Master download
// (https://api.icicidirect.com/breezeapi/documents/index.html, "instruments"
// section) - deliberately NOT breezeconnect's own getStockScriptList(),
// which downloads a different file from traderweb.icicidirect.com that
// resets every connection attempt from this network (confirmed live
// 2026-09-17, see Breeze.generateSession's comment) - directlink.icicidirect.com
// has no such issue.
//
// ICICI's stockCode is its own short identifier, not the NSE trading symbol
// (e.g. ShortName "VEDLIM" for NSE symbol "VEDL") - this is why Breeze needs
// its own contract-master lookup at all, unlike Ant/Zerodha's numeric-token
// systems.
class BreezeContractMaster {
    private static instance: BreezeContractMaster;

    // Cached under data/breeze/ (downloaded zip + its extracted .txt files) -
    // matches the data/ant/, data/zerodha/ convention for broker contract
    // masters. Re-downloaded whenever stale (see STALE_THRESHOLD_MS below),
    // so nothing here needs to be committed/backed up.
    private readonly DATA_DIR = path.join(__dirname, '../../data/breeze');
    private readonly ZIP_PATH = path.join(this.DATA_DIR, 'SecurityMaster.zip');
    // Documented at https://api.icicidirect.com/breezeapi/documents/index.html
    // ("instruments" section) as "Security Master file for token mapping".
    private readonly ZIP_URL = 'https://directlink.icicidirect.com/NewSecurityMaster/SecurityMaster.zip';
    private readonly FNO_FILE = path.join(this.DATA_DIR, 'FONSEScripMaster.txt');
    private readonly NSE_FILE = path.join(this.DATA_DIR, 'NSEScripMaster.txt');

    // ICICI regenerates the Security Master daily at 8am (per their own docs) -
    // re-download once the cached copy is older than a day, rather than Ant's
    // 14-day warn-only threshold (that file is refreshed manually; this one
    // changes daily with new expiries/strikes, so it's worth auto-refreshing).
    private readonly STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

    private fnoCache: FnoRecord[] | null = null;
    private nseCache: CashRecord[] | null = null;

    private constructor() {
        fs.mkdirSync(this.DATA_DIR, { recursive: true });
    }

    static getInstance(): BreezeContractMaster {
        if (!BreezeContractMaster.instance) {
            BreezeContractMaster.instance = new BreezeContractMaster();
        }
        return BreezeContractMaster.instance;
    }

    private isStale(filePath: string): boolean {
        try {
            return Date.now() - fs.statSync(filePath).mtimeMs > this.STALE_THRESHOLD_MS;
        } catch {
            return true; // doesn't exist yet
        }
    }

    private async downloadAndExtract(): Promise<void> {
        Log.log('[BreezeContractMaster] Downloading Security Master...');
        const response = await httpClient.get(this.ZIP_URL, { responseType: 'arraybuffer' });
        fs.writeFileSync(this.ZIP_PATH, response.data);
        // Shells out to the system `unzip` rather than pulling in a new npm
        // dependency for a one-off extraction - matches this codebase's
        // existing child_process usage elsewhere (candle.ts, decision.ts).
        execFileSync('unzip', ['-o', this.ZIP_PATH, '-d', this.DATA_DIR]);
        this.fnoCache = null;
        this.nseCache = null;
        Log.log('[BreezeContractMaster] Security Master downloaded and extracted');
    }

    async ensureLoaded(): Promise<void> {
        if (this.isStale(this.FNO_FILE)) {
            await this.downloadAndExtract();
        }
    }

    // relax_quotes/trim: the header row has a space before each field's
    // opening quote (`"Token", "ShortName", ...`), which csv-parse's default
    // strict quoting rejects (INVALID_OPENING_QUOTE) - confirmed against a
    // live download 2026-09-17. Data rows aren't affected (no such spacing),
    // this only unblocks parsing the header row we discard anyway.
    private loadFno(): FnoRecord[] {
        if (!this.fnoCache) {
            const raw = fs.readFileSync(this.FNO_FILE, 'utf-8');
            const rows: string[][] = parse(raw, { skip_empty_lines: true, relax_quotes: true, trim: true });
            const [, ...dataRows] = rows; // first row is the header
            this.fnoCache = dataRows.map((row) => ({
                token: row[0],
                instrumentName: row[1],
                shortName: row[2],
                series: row[3],
                expiryDate: row[4],
                strikePrice: row[5],
                optionType: row[6],
                lotSize: Number(row[27]),
                tickSize: Number(row[28]),
                companyName: row[29],
            }));
            Log.log(`[BreezeContractMaster] Loaded ${this.fnoCache.length} NFO contracts`);
        }
        return this.fnoCache;
    }

    private loadNse(): CashRecord[] {
        if (!this.nseCache) {
            const raw = fs.readFileSync(this.NSE_FILE, 'utf-8');
            const rows: string[][] = parse(raw, { skip_empty_lines: true, relax_quotes: true, trim: true });
            const [, ...dataRows] = rows;
            // Column 17 ("Symbol") is blank on every row checked (confirmed
            // against a live download) - the real NSE trading symbol lives in
            // column 60 ("ExchangeCode") instead, e.g. ExchangeCode "VEDL" /
            // ShortName "VEDLIM" for Vedanta.
            this.nseCache = dataRows.map((row) => ({
                token: row[0],
                shortName: row[1],
                series: row[2],
                companyName: row[3],
                symbol: row[60],
            }));
            Log.log(`[BreezeContractMaster] Loaded ${this.nseCache.length} NSE cash contracts`);
        }
        return this.nseCache;
    }

    // NIFTY/BANKNIFTY's ShortName already equals the underlying name Breeze's
    // own placeOrder examples use directly (confirmed against a live download
    // 2026-09-17: ShortName "NIFTY" for NIFTY index options) - this lookup
    // mainly matters for individual stocks, where ICICI's ShortName often
    // differs from the NSE trading symbol (e.g. "VEDLIM" for NSE "VEDL").
    async findOption(underlyingShortName: string, expiryDate: string, strikePrice: number, optionType: 'CE' | 'PE'): Promise<FnoRecord | undefined> {
        await this.ensureLoaded();
        return this.loadFno().find(
            (r) =>
                r.series === 'OPTION' &&
                r.shortName === underlyingShortName &&
                r.expiryDate === expiryDate &&
                Number(r.strikePrice) === strikePrice &&
                r.optionType === optionType
        );
    }

    // NSE trading symbol -> ICICI stockCode, for cash-equity orders.
    async getEquityStockCode(nseSymbol: string): Promise<string | undefined> {
        await this.ensureLoaded();
        return this.loadNse().find((r) => r.symbol === nseSymbol)?.shortName;
    }

    // Recovers full contract details from a token alone - mirrors
    // AntContractMaster.findByToken exactly, same use case: breezeExecutor.ts
    // only carries FnoRecord.token forward on Trade.token (see BrokerExecutor.ts's
    // "opaque, already-resolved" contract), so squareOff/cancelOrder/generic
    // buy() need this to reconstruct stockCode/expiryDate/strikePrice/right.
    async findByToken(token: string): Promise<FnoRecord | undefined> {
        await this.ensureLoaded();
        return this.loadFno().find((r) => r.token === token);
    }

    // Mirrors AntContractMaster.findATMOption/ZerodhaContractMaster.findATMOption
    // exactly (same 50-point strike step, same "nearest expiry >= today" rule)
    // - same logic backing the frontend's Up/Down flash-trade buttons
    // (server.ts's /demo/resolve), just resolving against Breeze's own
    // stockCode/expiryDate/strikePrice shape instead of a numeric token.
    async findATMOption(underlyingLtp: number, optionType: 'CE' | 'PE', underlyingShortName: string = 'NIFTY'): Promise<FnoRecord> {
        await this.ensureLoaded();
        const step = 50;
        const atmStrike = Math.round(underlyingLtp / step) * step;

        const todayStartMs = new Date().setHours(0, 0, 0, 0);
        const candidates = this.loadFno().filter(
            (r) => r.series === 'OPTION' && r.shortName === underlyingShortName && new Date(r.expiryDate).getTime() >= todayStartMs
        );
        if (candidates.length === 0) {
            throw new Error(`No ${underlyingShortName} option contracts found in Security Master`);
        }
        const nearestExpiryMs = Math.min(...candidates.map((r) => new Date(r.expiryDate).getTime()));

        const match = candidates.find(
            (r) => new Date(r.expiryDate).getTime() === nearestExpiryMs && Number(r.strikePrice) === atmStrike && r.optionType === optionType
        );
        if (!match) {
            throw new Error(`No ${underlyingShortName} ${atmStrike}${optionType} contract found for nearest expiry`);
        }
        return match;
    }

    // Resolves a specific (strike, optionType) to its nearest-upcoming-expiry contract -
    // mirrors ZerodhaContractMaster.findNearestExpiryOption. Needed because the bare-
    // execution IPC surface (breezeExecutor.ts) only carries a flat tradingSymbol string
    // (no expiry) into sell/limit-buy calls, so the full contract tuple must be
    // re-resolved from just strike+optionType - safe since both LegManager-driven
    // strategies only ever trade the nearest NIFTY expiry.
    async findNearestExpiryOption(strike: number, optionType: 'CE' | 'PE', underlyingShortName: string = 'NIFTY'): Promise<FnoRecord> {
        await this.ensureLoaded();
        const todayStartMs = new Date().setHours(0, 0, 0, 0);
        const candidates = this.loadFno().filter(
            (r) =>
                r.series === 'OPTION' &&
                r.shortName === underlyingShortName &&
                Number(r.strikePrice) === strike &&
                r.optionType === optionType &&
                new Date(r.expiryDate).getTime() >= todayStartMs
        );
        if (candidates.length === 0) {
            throw new Error(`No ${underlyingShortName} ${strike}${optionType} contract found for any upcoming expiry`);
        }
        candidates.sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
        return candidates[0];
    }
}

export default BreezeContractMaster;
