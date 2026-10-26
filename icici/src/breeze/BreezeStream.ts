import Log from '../util/Log';
import Breeze from './Breeze';
import myEmitter from '../tools/emitter';

// Live price-tick streaming, mirroring AntStream.ts's role but far thinner:
// breezeconnect's SDK owns the raw socket.io connection itself (including
// its default reconnection behavior - no reconnectionAttempts override is
// set anywhere in the SDK, see breezeConnect.js's self.connect - so unlike
// AntWebSocket.ts, which is hand-rolled over the raw `ws` package, there's no
// need to hand-roll backoff/reconnect logic here too).
//
// NOT yet live-verified (see ToDo.md) - written and compiled against the SDK
// source, but no live wsConnect/subscribeFeeds/tick has been observed yet.
class BreezeStream {
    private static instance: BreezeStream;
    private connected = false;
    // Key: `${shortName}${strikePrice}${optionType}` (matches breezeExecutor's
    // tsymFor) - just for dedup/unsubscribe, not sent to the API directly.
    private subscribedOptions = new Map<string, { stockCode: string; exchangeCode: string; expiryDate: string; strikePrice: string; right: string }>();

    static getInstance(): BreezeStream {
        if (!BreezeStream.instance) {
            BreezeStream.instance = new BreezeStream();
        }
        return BreezeStream.instance;
    }

    private onTick = (tick: any) => {
        myEmitter.emit('breeze-quote', tick);
    };

    connect(): void {
        if (this.connected) {
            Log.log('[BreezeStream] Already connected');
            return;
        }
        const breeze = Breeze.getInstance();
        // Registered once (Set-deduped by identity in Breeze.onQuote), not per connect().
        breeze.onQuote(this.onTick);
        breeze.wsConnect('BreezeStream');
        this.connected = true;
        Log.log('[BreezeStream] Connected');
    }

    disconnect(): void {
        Breeze.getInstance().wsDisconnect('BreezeStream');
        this.connected = false;
        this.subscribedOptions.clear();
    }

    isConnected(): boolean {
        return this.connected;
    }

    // expiryDate: 'DD-MMM-YYYY' (BreezeContractMaster.FnoRecord.expiryDate
    // format) - converted to the ISO-at-06:00-UTC wire format internally,
    // same conversion breezeExecutor.ts's expiryToIso uses.
    async subscribeOption(stockCode: string, expiryDate: string, strikePrice: string, optionType: 'CE' | 'PE', exchangeCode: 'NFO' | 'BFO' = 'NFO'): Promise<void> {
        const key = `${exchangeCode}|${stockCode}|${expiryDate}|${strikePrice}${optionType}`;
        if (this.subscribedOptions.has(key)) return;
        const right = optionType === 'CE' ? 'call' : 'put';
        await Breeze.getInstance().subscribeFeeds({
            stockCode,
            exchangeCode,
            productType: 'options',
            expiryDate,
            strikePrice,
            right,
            getExchangeQuotes: true,
            getMarketDepth: false,
        });
        this.subscribedOptions.set(key, { stockCode, exchangeCode, expiryDate, strikePrice, right });
        Log.log(`[BreezeStream] Subscribed ${key}`);
    }

    async unsubscribeOption(stockCode: string, strikePrice: string, optionType: 'CE' | 'PE', expiryDate?: string, exchangeCode: 'NFO' | 'BFO' = 'NFO'): Promise<void> {
        // Without an explicit expiry, match every subscription for this contract across expiries.
        const matches = Array.from(this.subscribedOptions.entries()).filter(([, v]) =>
            v.stockCode === stockCode && v.strikePrice === strikePrice && v.right === (optionType === 'CE' ? 'call' : 'put') &&
            v.exchangeCode === exchangeCode && (!expiryDate || v.expiryDate === expiryDate));
        for (const [key, sub] of matches) {
            await this.unsubscribeOne(key, sub);
        }
    }

    private async unsubscribeOne(key: string, sub: { stockCode: string; exchangeCode: string; expiryDate: string; strikePrice: string; right: string }): Promise<void> {
        await Breeze.getInstance().unsubscribeFeeds({
            stockCode: sub.stockCode,
            exchangeCode: sub.exchangeCode,
            productType: 'options',
            expiryDate: sub.expiryDate,
            strikePrice: sub.strikePrice,
            right: sub.right,
            getExchangeQuotes: true,
            getMarketDepth: false,
        });
        this.subscribedOptions.delete(key);
        Log.log(`[BreezeStream] Unsubscribed ${key}`);
    }
}

export default BreezeStream;
