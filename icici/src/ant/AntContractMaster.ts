import fs from 'fs';
import path from 'path';

interface ContractRecord {
  Symbol: string;
  Token: string;
  Trading?: string;
  'Trading Symbol'?: string;
  'Strike Price': string;
  'Option Type': string;
  Exch: string;
  'Expiry Date': string;
  'Lot Size': string;
}

interface IndexToken {
  exch: string;
  token: string;
}

class AntContractMaster {
  private static instance: AntContractMaster;
  private nfoCache: ContractRecord[] | null = null;
  private bfoCache: ContractRecord[] | null = null;

  private readonly NFO_PATH = path.join(__dirname, '../../data/ant/NFO_contract.json');
  private readonly BFO_PATH = path.join(__dirname, '../../data/ant/BFO_contract.json');

  static readonly INDEX_TOKENS: Record<string, IndexToken> = {
    NIFTY: { exch: 'NSE', token: '26000' },
  };

  // Matches ZerodhaContractMaster's strike-rounding table.
  static readonly STRIKE_STEP: Record<string, number> = {
    NIFTY: 50,
    SENSEX: 100,
  };

  static getInstance(): AntContractMaster {
    if (!AntContractMaster.instance) {
      AntContractMaster.instance = new AntContractMaster();
    }
    return AntContractMaster.instance;
  }

  private loadNFO(): ContractRecord[] {
    if (!this.nfoCache) {
      const data = JSON.parse(fs.readFileSync(this.NFO_PATH, 'utf-8'));
      this.nfoCache = data.NFO || [];
    }
    return this.nfoCache;
  }

  private loadBFO(): ContractRecord[] {
    if (!this.bfoCache) {
      const data = JSON.parse(fs.readFileSync(this.BFO_PATH, 'utf-8'));
      this.bfoCache = data.BFO || [];
    }
    return this.bfoCache;
  }

  findOption(params: {
    symbol: string;
    exch: string;
    strike: string;
    optionType: string;
    expiryEpochMs: number;
  }): { token: string; exch: string; tradingSymbol: string; lotSize: string } {
    const { symbol, exch, strike, optionType, expiryEpochMs } = params;
    const cache = exch === 'NFO' ? this.loadNFO() : this.loadBFO();

    const record = cache.find(
      (r) =>
        r.Symbol === symbol &&
        r.Exch === exch &&
        r['Strike Price'] === strike &&
        r['Option Type'] === optionType &&
        parseInt(r['Expiry Date']) === expiryEpochMs
    );

    if (!record) {
      throw new Error(
        `Contract not found: ${symbol} ${exch} strike ${strike} ${optionType} expiry ${new Date(expiryEpochMs).toDateString()}`
      );
    }

    const tradingSymbol = record['Trading Symbol'] || record.Trading || '';
    return {
      token: record.Token,
      exch: record.Exch,
      tradingSymbol,
      lotSize: record['Lot Size'],
    };
  }

  // ATM-by-LTP resolution: rounds to the nearest strike step for the given
  // symbol, then delegates to findNearestExpiryOption. Mirrors
  // ZerodhaContractMaster.findATMOption.
  findATMOption(underlyingLtp: number, optionType: string, symbol: string = 'NIFTY'): { token: string; exch: string; tradingSymbol: string; lotSize: string } {
    const step = AntContractMaster.STRIKE_STEP[symbol] ?? 50;
    const atmStrike = Math.round(underlyingLtp / step) * step;
    const exch = symbol === 'SENSEX' ? 'BFO' : 'NFO';
    return this.findNearestExpiryOption({ symbol, exch, strike: atmStrike, optionType, expiryOffset: 0 });
  }

  // Exact (symbol, strike, expiry, optionType) resolution, expiry given as a
  // date string (not epoch-ms) - mirrors ZerodhaContractMaster.findExactOption's
  // caller contract. Converts internally to findOption's epoch-ms comparison.
  findExactOption(params: { symbol: string; strike: number; expiry: string; optionType: string }): { token: string; exch: string; tradingSymbol: string; lotSize: string } {
    const exch = params.symbol === 'SENSEX' ? 'BFO' : 'NFO';
    const expiryEpochMs = new Date(params.expiry).getTime();
    return this.findOption({
      symbol: params.symbol,
      exch,
      strike: String(params.strike),
      optionType: params.optionType,
      expiryEpochMs,
    });
  }

  // Canonical-symbol resolution: exact (symbol, strike, optionType), no
  // expiry given - resolves to the nearest expiry (expiryOffset=0) or the
  // Nth-nearest (expiryOffset=1 => "next", etc), same shape as
  // ZerodhaContractMaster.findNearestExpiryOption. Now wired to the ANT order
  // path (see src/processes/order/antExecutor.ts).
  findNearestExpiryOption(params: {
    symbol: string;
    exch: string;
    strike: number;
    optionType: string;
    expiryOffset?: number;
  }): { token: string; exch: string; tradingSymbol: string; lotSize: string } {
    const { symbol, exch, strike, optionType, expiryOffset = 0 } = params;
    const cache = exch === 'NFO' ? this.loadNFO() : this.loadBFO();
    // 'Expiry Date' is stored as midnight UTC of the expiry date (confirmed:
    // today's contract carries exactly 00:00:00 UTC = 5:30am IST) - comparing
    // against the raw current instant excluded a contract expiring LATER
    // TODAY for the rest of the trading day, every single week, since market
    // hours are entirely after 5:30am IST. Compare against the start of
    // today (UTC) instead, mirroring ZerodhaContractMaster's day-truncated
    // comparison (`today.setHours(0,0,0,0)`) so a same-day expiry still counts.
    const todayStartUtc = Math.floor(Date.now() / 86400000) * 86400000;

    const candidates = cache
      .filter(
        (r) =>
          r.Symbol === symbol &&
          r.Exch === exch &&
          Number(r['Strike Price']) === strike &&
          r['Option Type'] === optionType &&
          parseInt(r['Expiry Date']) >= todayStartUtc
      )
      .sort((a, b) => parseInt(a['Expiry Date']) - parseInt(b['Expiry Date']));

    const record = candidates[expiryOffset];
    if (!record) {
      throw new Error(`No ${symbol} ${exch} ${optionType} contract found for strike ${strike} (expiryOffset=${expiryOffset})`);
    }

    return {
      token: record.Token,
      exch: record.Exch,
      tradingSymbol: record['Trading Symbol'] || record.Trading || '',
      lotSize: record['Lot Size'],
    };
  }
}

export default AntContractMaster;
