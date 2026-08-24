import fs from 'fs';
import path from 'path';

// Reads NFO_symbols.txt directly (repo root, __dirname-relative so it doesn't
// depend on process cwd - see src/orchestrator.ts's explicit cwd fix for why
// that matters), independent of Prism's own cacheFile()/this.lines lifecycle.
// Columns: Exchange,Token,LotSize,Symbol,TradingSymbol,Expiry,Instrument,
// OptionType,StrikePrice,TickSize - confirmed against the live file.
// Expiry is `DD-MMM-YYYY` (e.g. "26-JUN-2029").

const FILE_PATH = path.join(__dirname, '../../NFO_symbols.txt');

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
}

export default PrismContractMaster;
