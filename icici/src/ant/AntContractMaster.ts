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
}

export default AntContractMaster;
