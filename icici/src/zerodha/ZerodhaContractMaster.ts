import fs from 'fs';
import path from 'path';

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

// Reads the locally-downloaded instrument master (data/zerodha/{NFO,BFO}_instruments.csv
// - see scripts/download-zerodha-master.sh) instead of calling Zerodha's API live,
// mirroring AntContractMaster's convention (src/ant/AntContractMaster.ts) of
// resolving against a downloaded file. Re-run the download script to refresh
// when the file is stale; nothing in this class calls out to the network.
class ZerodhaContractMaster {
    private static instance: ZerodhaContractMaster;
    private instrumentsCache: Map<Exchange, CsvInstrument[]> = new Map();

    // Index -> exchange segment / strike step. SENSEX options trade on BFO
    // (BSE F&O), not NFO, with a 100-point strike step vs NIFTY's 50 - see
    // src/broker/ZerodhaBroker.ts's INDEX_EXCHANGE for the same mapping.
    private readonly INDEX_EXCHANGE: Record<Index, Exchange> = { NIFTY: 'NFO', SENSEX: 'BFO' };
    private readonly STRIKE_STEP: Record<Index, number> = { NIFTY: 50, SENSEX: 100 };

    static getInstance(): ZerodhaContractMaster {
        if (!ZerodhaContractMaster.instance) {
            ZerodhaContractMaster.instance = new ZerodhaContractMaster();
        }
        return ZerodhaContractMaster.instance;
    }

    private loadInstruments(exchange: Exchange): CsvInstrument[] {
        let cached = this.instrumentsCache.get(exchange);
        if (cached) return cached;

        const filePath = path.join(__dirname, '../../data/zerodha', `${exchange}_instruments.csv`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`${filePath} not found - run scripts/download-zerodha-master.sh first`);
        }
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
        const exchange: Exchange = symbol === 'SENSEX' ? 'BFO' : 'NFO';
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

export default ZerodhaContractMaster;
