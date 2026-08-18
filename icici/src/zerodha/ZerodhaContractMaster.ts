import { Instrument } from 'kiteconnect';
import Zerodha from './Zerodha';

class ZerodhaContractMaster {
    private static instance: ZerodhaContractMaster;
    private cache: Instrument[] | null = null;
    private cacheDate: string | null = null;

    static getInstance(): ZerodhaContractMaster {
        if (!ZerodhaContractMaster.instance) {
            ZerodhaContractMaster.instance = new ZerodhaContractMaster();
        }
        return ZerodhaContractMaster.instance;
    }

    private async loadInstruments(): Promise<Instrument[]> {
        const today = new Date().toDateString();
        if (this.cache && this.cacheDate === today) {
            return this.cache;
        }
        const kc = Zerodha.getInstance().getKiteConnect();
        this.cache = await kc.getInstruments('NFO');
        this.cacheDate = today;
        return this.cache;
    }

    async findATMOption(
        underlyingLtp: number,
        optionType: 'CE' | 'PE'
    ): Promise<{ tradingSymbol: string; instrumentToken: number; lotSize: number }> {
        const instruments = await this.loadInstruments();
        const atmStrike = Math.round(underlyingLtp / 50) * 50;

        const candidates = instruments.filter(
            (i) => i.name === 'NIFTY' && i.instrument_type === optionType && i.strike === atmStrike
        );

        if (candidates.length === 0) {
            throw new Error(`No NIFTY ${optionType} contract found for strike ${atmStrike}`);
        }

        candidates.sort((a, b) => new Date(a.expiry).getTime() - new Date(b.expiry).getTime());
        const contract = candidates[0];

        return {
            tradingSymbol: contract.tradingsymbol,
            instrumentToken: contract.instrument_token,
            lotSize: contract.lot_size,
        };
    }

    async findExactOption(
        strike: number,
        expiry: string,
        optionType: 'CE' | 'PE'
    ): Promise<{ tradingSymbol: string; instrumentToken: number; lotSize: number }> {
        const instruments = await this.loadInstruments();
        const expiryDateString = new Date(expiry).toDateString();

        const contract = instruments.find(
            (i) =>
                i.name === 'NIFTY' &&
                i.instrument_type === optionType &&
                i.strike === strike &&
                new Date(i.expiry).toDateString() === expiryDateString
        );

        if (!contract) {
            throw new Error(`No NIFTY ${optionType} contract found for strike ${strike} expiry ${expiry}`);
        }

        return {
            tradingSymbol: contract.tradingsymbol,
            instrumentToken: contract.instrument_token,
            lotSize: contract.lot_size,
        };
    }
}

export default ZerodhaContractMaster;
