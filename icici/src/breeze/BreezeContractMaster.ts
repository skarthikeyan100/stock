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

export type BreezeExchange = 'NFO' | 'BFO';

export interface FnoRecord {
    token: string;
    instrumentName: string; // 'FUTIDX' | 'FUTSTK' | 'OPTIDX' | 'OPTSTK'
    shortName: string; // ICICI's stockCode for placeOrder/getQuotes, e.g. 'NIFTY', 'VEDLIM', 'BSESEN' (SENSEX)
    series: string; // 'FUTURE' | 'OPTION'
    expiryDate: string; // 'DD-MMM-YYYY', matches Breeze's own expiryDate param format
    strikePrice: string;
    optionType: string; // 'CE' | 'PE' | 'XX' (XX for futures)
    lotSize: number;
    tickSize: number;
    companyName: string;
    exchange: BreezeExchange; // 'NFO' for NIFTY-family, 'BFO' for SENSEX - which Security Master file the row came from
}

export interface CashRecord {
    token: string;
    shortName: string; // ICICI's stockCode
    series: string;
    companyName: string;
    symbol: string; // NSE trading symbol
}

// ICICI's stockCode for SENSEX (ShortName in FOBSE/BSE Security Masters). The rest of the
// codebase names the index 'SENSEX' (tsyms, IPC payloads, ANT pricing) - this is the one
// place that translates between the two.
export const SENSEX_BREEZE_SHORT_NAME = 'BSESEN';

// Index name ('NIFTY'|'SENSEX') or ICICI shortName -> ICICI shortName used for placeOrder/getQuotes.
export function breezeShortNameFor(underlying: string): string {
    return underlying === 'SENSEX' ? SENSEX_BREEZE_SHORT_NAME : underlying;
}

// ICICI shortName -> index name the rest of the codebase uses (tsym prefix, ANT option chain).
export function indexNameFor(shortName: string): string {
    return shortName === SENSEX_BREEZE_SHORT_NAME ? 'SENSEX' : shortName;
}

// Which exchange an option/underlying trades on, derived from its ICICI shortName.
export function breezeExchangeFor(shortName: string): BreezeExchange {
    return shortName === SENSEX_BREEZE_SHORT_NAME ? 'BFO' : 'NFO';
}

// SENSEX strikes are 100 apart, NIFTY's are 50 (same split ANT/Kite/Prism use).
export function strikeStepFor(shortName: string): number {
    return shortName === SENSEX_BREEZE_SHORT_NAME ? 100 : 50;
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
// its own contract-master lookup at all, unlike Ant/Kite's numeric-token
// systems.
// 'DD-MMM-YYYY' -> local-midnight ms (NaN when unparseable, which fails every >= comparison).
function expiryMs(expiryDate: string): number {
    return new Date(expiryDate).getTime();
}

class BreezeContractMaster {
    private static instance: BreezeContractMaster;

    // Cached under data/breeze/ (downloaded zip + its extracted .txt files) -
    // matches the data/ant/, data/kite/ convention for broker contract
    // masters. Re-downloaded whenever stale (see STALE_THRESHOLD_MS below),
    // so nothing here needs to be committed/backed up.
    private readonly DATA_DIR = path.join(__dirname, '../../data/breeze');
    private readonly ZIP_PATH = path.join(this.DATA_DIR, 'SecurityMaster.zip');
    // Documented at https://api.icicidirect.com/breezeapi/documents/index.html
    // ("instruments" section) as "Security Master file for token mapping".
    private readonly ZIP_URL = 'https://directlink.icicidirect.com/NewSecurityMaster/SecurityMaster.zip';
    private readonly FNO_FILE = path.join(this.DATA_DIR, 'FONSEScripMaster.txt');
    // BSE derivatives (SENSEX/BANKEX options) - extracted from the same zip as FNO_FILE.
    private readonly BFO_FILE = path.join(this.DATA_DIR, 'FOBSEScripMaster.txt');
    private readonly NSE_FILE = path.join(this.DATA_DIR, 'NSEScripMaster.txt');

    // ICICI regenerates the Security Master daily at 8am (per their own docs) -
    // re-download once the cached copy is older than a day, rather than Ant's
    // 14-day warn-only threshold (that file is refreshed manually; this one
    // changes daily with new expiries/strikes, so it's worth auto-refreshing).
    private readonly STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

    private fnoCache: FnoRecord[] | null = null;
    private bfoCache: FnoRecord[] | null = null;
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

    // Staleness is judged by the downloaded zip's own mtime (stamped at download time), NOT the
    // extracted .txt: `unzip -o` restores the archive entries' original (old) mtimes, which made
    // the extracted file look stale on every lookup and re-download each time.
    private isStale(filePath: string): boolean {
        try {
            if (!fs.existsSync(filePath)) return true;
            const stampPath = fs.existsSync(this.ZIP_PATH) ? this.ZIP_PATH : filePath;
            return Date.now() - fs.statSync(stampPath).mtimeMs > this.STALE_THRESHOLD_MS;
        } catch {
            return true; // doesn't exist yet
        }
    }

    private downloading: Promise<void> | null = null;
    // Throttle retries after a failed refresh so a down server isn't hammered on every lookup.
    private lastFailedRefreshAt = 0;
    private readonly RETRY_BACKOFF_MS = 60 * 1000;

    // Downloads to a temp zip, extracts into a temp dir, then renames into place, so a failure at
    // any step leaves the previous (working) files untouched.
    private async downloadAndExtract(): Promise<void> {
        Log.log('[BreezeContractMaster] Downloading Security Master...');
        const response = await httpClient.get(this.ZIP_URL, { responseType: 'arraybuffer', timeout: 60000 });
        const buf = Buffer.from(response.data);
        if (buf.length < 1024) throw new Error(`Security Master download too small (${buf.length} bytes)`);
        const tmpZip = this.ZIP_PATH + '.tmp';
        const tmpDir = path.join(this.DATA_DIR, '.extract_tmp');
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.mkdirSync(tmpDir, { recursive: true });
        try {
            fs.writeFileSync(tmpZip, buf);
            // Shells out to the system `unzip` rather than pulling in a new npm
            // dependency for a one-off extraction - matches this codebase's
            // existing child_process usage elsewhere (candle.ts, decision.ts).
            execFileSync('unzip', ['-o', tmpZip, '-d', tmpDir], { timeout: 60000 });
            for (const f of [this.FNO_FILE, this.BFO_FILE, this.NSE_FILE]) {
                const extracted = path.join(tmpDir, path.basename(f));
                if (!fs.existsSync(extracted) || fs.statSync(extracted).size === 0) {
                    throw new Error(`Security Master zip is missing ${path.basename(f)}`);
                }
            }
            for (const name of fs.readdirSync(tmpDir)) {
                fs.renameSync(path.join(tmpDir, name), path.join(this.DATA_DIR, name));
            }
            fs.renameSync(tmpZip, this.ZIP_PATH); // stamps the refresh time last
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            fs.rmSync(tmpZip, { force: true });
        }
        this.fnoCache = null;
        this.bfoCache = null;
        this.nseCache = null;
        Log.log('[BreezeContractMaster] Security Master downloaded and extracted');
    }

    async ensureLoaded(): Promise<void> {
        if (!this.isStale(this.FNO_FILE)) return;
        // In-flight dedupe: concurrent lookups share one download.
        if (!this.downloading) {
            const haveOld = fs.existsSync(this.FNO_FILE);
            if (haveOld && Date.now() - this.lastFailedRefreshAt < this.RETRY_BACKOFF_MS) return;
            this.downloading = this.downloadAndExtract()
                .catch((e) => {
                    this.lastFailedRefreshAt = Date.now();
                    // Fall back to the previous file if there is one; only fail when there is nothing to use.
                    if (!haveOld) throw e;
                    Log.log(`[BreezeContractMaster] ALERT: refresh failed, using stale cached Security Master: ${e?.message ?? e}`);
                })
                .finally(() => {
                    this.downloading = null;
                });
        }
        await this.downloading;
    }

    // Warms the FNO, BFO and NSE caches at startup. Runs the daily stale-refresh first, same as
    // the lazy path would. Fail-soft: a failed download or parse is logged and lookups stay lazy.
    async preload(): Promise<void> {
        const t0 = Date.now();
        try {
            await this.ensureLoaded();
            const fno = this.loadDerivatives('NFO').length;
            const bfo = this.loadDerivatives('BFO').length;
            const nse = this.loadNse().length;
            Log.log(`[BreezeContractMaster] preload: ${fno} NFO / ${bfo} BFO / ${nse} NSE rows in ${Date.now() - t0}ms`);
        } catch (e: any) {
            Log.log(`[BreezeContractMaster] ALERT: preload failed - lookups will retry lazily: ${e?.message ?? e}`);
        }
    }

    // relax_quotes/trim: the header row has a space before each field's
    // opening quote (`"Token", "ShortName", ...`), which csv-parse's default
    // strict quoting rejects (INVALID_OPENING_QUOTE) - confirmed against a
    // live download 2026-09-17. Data rows aren't affected (no such spacing),
    // this only unblocks parsing the header row we discard anyway.
    // NFO and BFO share one column layout (verified against both live files
    // 2026-10-21: LotSize at index 27, TickSize at 28, CompanyName at 29), so
    // one parser serves both - only the file and the tagged exchange differ.
    private loadDerivatives(exchange: BreezeExchange): FnoRecord[] {
        const cached = exchange === 'BFO' ? this.bfoCache : this.fnoCache;
        if (cached) return cached;
        const file = exchange === 'BFO' ? this.BFO_FILE : this.FNO_FILE;
        const raw = fs.readFileSync(file, 'utf-8');
        const rows: string[][] = parse(raw, { skip_empty_lines: true, relax_quotes: true, trim: true });
        const [, ...dataRows] = rows; // first row is the header
        const records: FnoRecord[] = dataRows.map((row) => ({
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
            exchange,
        }));
        if (exchange === 'BFO') this.bfoCache = records;
        else this.fnoCache = records;
        Log.log(`[BreezeContractMaster] Loaded ${records.length} ${exchange} contracts`);
        return records;
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

    // The option list for one underlying - BFO for SENSEX, NFO otherwise. Callers pass either
    // an index name ('NIFTY'/'SENSEX') or an ICICI shortName; both normalize to the same list.
    private optionsFor(underlying: string): FnoRecord[] {
        return this.loadDerivatives(breezeExchangeFor(breezeShortNameFor(underlying)));
    }

    // NIFTY/BANKNIFTY's ShortName already equals the underlying name Breeze's
    // own placeOrder examples use directly (confirmed against a live download
    // 2026-09-17: ShortName "NIFTY" for NIFTY index options) - this lookup
    // mainly matters for individual stocks, where ICICI's ShortName often
    // differs from the NSE trading symbol (e.g. "VEDLIM" for NSE "VEDL").
    async findOption(underlyingShortName: string, expiryDate: string, strikePrice: number, optionType: 'CE' | 'PE'): Promise<FnoRecord | undefined> {
        await this.ensureLoaded();
        const shortName = breezeShortNameFor(underlyingShortName);
        return this.optionsFor(shortName).find(
            (r) =>
                r.series === 'OPTION' &&
                r.shortName === shortName &&
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
    // NFO and BFO token numbering is disjoint (checked 2026-10-21 - no shared
    // token between the two masters), so searching both is unambiguous.
    async findByToken(token: string): Promise<FnoRecord | undefined> {
        await this.ensureLoaded();
        return this.loadDerivatives('NFO').find((r) => r.token === token) ?? this.loadDerivatives('BFO').find((r) => r.token === token);
    }

    // Mirrors AntContractMaster.findATMOption/KiteContractMaster.findATMOption
    // exactly (same "nearest expiry >= today" rule, strike step per underlying) -
    // same logic backing the frontend's Up/Down flash-trade buttons
    // (server.ts's /demo/resolve), just resolving against Breeze's own
    // stockCode/expiryDate/strikePrice shape instead of a numeric token.
    async findATMOption(underlyingLtp: number, optionType: 'CE' | 'PE', underlyingShortName: string = 'NIFTY'): Promise<FnoRecord> {
        await this.ensureLoaded();
        const shortName = breezeShortNameFor(underlyingShortName);
        const step = strikeStepFor(shortName);
        const atmStrike = Math.round(underlyingLtp / step) * step;

        const todayStartMs = new Date().setHours(0, 0, 0, 0);
        const candidates = this.optionsFor(shortName).filter(
            (r) => r.series === 'OPTION' && r.shortName === shortName && expiryMs(r.expiryDate) >= todayStartMs
        );
        if (candidates.length === 0) {
            throw new Error(`No ${shortName} option contracts found in Security Master`);
        }
        const nearestExpiryMs = Math.min(...candidates.map((r) => expiryMs(r.expiryDate)));

        const match = candidates.find(
            (r) => expiryMs(r.expiryDate) === nearestExpiryMs && Number(r.strikePrice) === atmStrike && r.optionType === optionType
        );
        if (!match) {
            throw new Error(`No ${shortName} ${atmStrike}${optionType} contract found for nearest expiry`);
        }
        return match;
    }

    // Resolves a specific (strike, optionType) to its nearest-upcoming-expiry contract -
    // mirrors KiteContractMaster.findNearestExpiryOption. Needed because the bare-
    // execution IPC surface (breezeExecutor.ts) only carries a flat tradingSymbol string
    // (no expiry) into sell/limit-buy calls, so the full contract tuple must be
    // re-resolved from just strike+optionType - safe since both LegManager-driven
    // strategies only ever trade the nearest expiry of their underlying.
    async findNearestExpiryOption(strike: number, optionType: 'CE' | 'PE', underlyingShortName: string = 'NIFTY'): Promise<FnoRecord> {
        await this.ensureLoaded();
        const shortName = breezeShortNameFor(underlyingShortName);
        const todayStartMs = new Date().setHours(0, 0, 0, 0);
        const candidates = this.optionsFor(shortName).filter(
            (r) =>
                r.series === 'OPTION' &&
                r.shortName === shortName &&
                Number(r.strikePrice) === strike &&
                r.optionType === optionType &&
                expiryMs(r.expiryDate) >= todayStartMs
        );
        if (candidates.length === 0) {
            throw new Error(`No ${shortName} ${strike}${optionType} contract found for any upcoming expiry`);
        }
        candidates.sort((a, b) => expiryMs(a.expiryDate) - expiryMs(b.expiryDate));
        return candidates[0];
    }

    // Any one live option contract of an underlying, nearest expiry - only used to read the
    // underlying's spot price off a Breeze option quote (its spot_price field), since SENSEX
    // has no Breeze cash quote (BSE cash for BSESEN returns no data, checked 2026-10-21).
    async findNearestExpiryAnyStrike(underlyingShortName: string = 'NIFTY'): Promise<FnoRecord> {
        await this.ensureLoaded();
        const shortName = breezeShortNameFor(underlyingShortName);
        const todayStartMs = new Date().setHours(0, 0, 0, 0);
        const candidates = this.optionsFor(shortName).filter(
            (r) => r.series === 'OPTION' && r.shortName === shortName && expiryMs(r.expiryDate) >= todayStartMs
        );
        if (candidates.length === 0) throw new Error(`No ${shortName} option contracts found in Security Master`);
        candidates.sort((a, b) => expiryMs(a.expiryDate) - expiryMs(b.expiryDate));
        return candidates[0];
    }
}

export default BreezeContractMaster;
