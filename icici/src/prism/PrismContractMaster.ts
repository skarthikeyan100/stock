import fs from 'fs';
import path from 'path';
import Log from '../util/Log';

// Reads data/prism/NFO_symbols.txt directly (__dirname-relative so it doesn't
// depend on process cwd - see src/orchestrator.ts's explicit cwd fix for why
// that matters), independent of Prism's own cacheFile()/this.lines lifecycle.
// Columns: Exchange,Token,LotSize,Symbol,TradingSymbol,Expiry,Instrument,
// OptionType,StrikePrice,TickSize - confirmed against the live file.
// Expiry is `DD-MMM-YYYY` (e.g. "26-JUN-2029").

const FILE_PATH = path.join(__dirname, '../../data/prism/NFO_symbols.txt');

interface Row {
    token: string;
    tradingSymbol: string;
    expiry: string;
    strike: number;
    optionType: string;
    symbol: string;
}

class PrismContractMaster {
    private static instance: PrismContractMaster;
    private cache: Row[] | null = null;

    // Warms the symbols cache at startup (see AntContractMaster.preload). Fail-soft.
    preload(): void {
        const t0 = Date.now();
        try {
            const rows = this.load().length;
            Log.log(`[PrismContractMaster] preload: ${rows} rows in ${Date.now() - t0}ms`);
        } catch (e: any) {
            Log.log(`[PrismContractMaster] ALERT: preload failed - lookups will retry lazily: ${e?.message ?? e}`);
        }
    }

    static getInstance(): PrismContractMaster {
        if (!PrismContractMaster.instance) {
            PrismContractMaster.instance = new PrismContractMaster();
        }
        return PrismContractMaster.instance;
    }

    private load(): Row[] {
        if (this.cache) return this.cache;
        const lines = fs.readFileSync(FILE_PATH, 'utf-8').split('\n');
        const rows: Row[] = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            const optionType = cols[7];
            if (optionType !== 'CE' && optionType !== 'PE') continue; // skip futures/blank rows
            rows.push({
                token: cols[1],
                tradingSymbol: cols[4],
                expiry: cols[5],
                strike: Number(cols[8]),
                optionType,
                symbol: cols[3],
            });
        }
        this.cache = rows;
        return rows;
    }

    // Canonical-symbol resolution: exact (symbol, strike, optionType), no
    // expiry given - resolves to the nearest expiry (expiryOffset=0) or the
    // Nth-nearest (expiryOffset=1 => "next", etc), same shape as
    // ZerodhaContractMaster.findNearestExpiryOption / AntContractMaster's
    // equivalent. Prism is the secondary/legacy execution path (Zerodha is
    // primary) - resolution only wired into order execution if/when that path
    // is used, per src/processes/order/prismExecutor.ts.
    findNearestExpiryOption(symbol: string, strike: number, optionType: 'CE' | 'PE', expiryOffset = 0): { token: string; tradingSymbol: string } {
        const rows = this.load();
        const now = Date.now();

        const candidates = rows
            .filter((r) => r.symbol === symbol && r.strike === strike && r.optionType === optionType && Date.parse(r.expiry) >= now)
            .sort((a, b) => Date.parse(a.expiry) - Date.parse(b.expiry));

        const row = candidates[expiryOffset];
        if (!row) {
            throw new Error(`No ${symbol} ${optionType} contract found for strike ${strike} (expiryOffset=${expiryOffset})`);
        }
        return { token: row.token, tradingSymbol: row.tradingSymbol };
    }

    // Per-index strike step, mirroring ZerodhaContractMaster's STRIKE_STEP map -
    // only NIFTY is wired into any current caller (orderProcess.ts's
    // chunkedBuyIndex prism branch hardcodes 'NIFTY'), but findATMOption's
    // public signature accepts any symbol, so a future BANKNIFTY/SENSEX
    // caller must round to that index's real step, not silently round to
    // NIFTY's and resolve the wrong (or no) strike.
    private static readonly STRIKE_STEP: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, SENSEX: 100 };

    // ATM-by-LTP lookup, mirroring ZerodhaContractMaster.findATMOption: round
    // to the nearest strike step for this symbol and delegate to the
    // exact-strike resolver above. Added for BulkPcrAutoStartStrategy's
    // prism support - BulkPcrStrategy only ever resolves by current spot
    // LTP, not an exact strike.
    findATMOption(underlyingLtp: number, optionType: 'CE' | 'PE', symbol: string = 'NIFTY'): { token: string; tradingSymbol: string } {
        const strikeStep = PrismContractMaster.STRIKE_STEP[symbol] ?? 50;
        const atmStrike = Math.round(underlyingLtp / strikeStep) * strikeStep;
        return this.findNearestExpiryOption(symbol, atmStrike, optionType);
    }
}

export default PrismContractMaster;
