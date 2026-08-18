import Log from '../util/Log';
import Mongo from '../tools/mongo';
import { MOCK_DATE } from '../constants';

class MockRestAPI {
    private _callbacks: any = null;
    private _niftyLtp: number = 0;
    // token → right ('call' | 'put' | '')  — replaces setInterval approach
    private _subscribedTokens: Map<string, string> = new Map();

    setCallbacks(callbacks: any): void {
        this._callbacks = callbacks;
    }

    async place_order(order: any): Promise<any> {
        const norenordno = `MOCK${Date.now()}`;
        Log.log(`[MockAPI] place_order: ${order.trantype} ${order.qty} x ${order.tsym} @ ${order.prc} → ${norenordno}`);

        const fillPrice = (order.prc === 0 || order.prctyp === 'MKT') ? this._niftyLtp : order.prc;
        setImmediate(() => {
            if (this._callbacks) {
                this._callbacks.order({
                    t: 'om',
                    norenordno,
                    status: 'COMPLETE',
                    tsym: order.tsym,
                    qty: order.qty,
                    prc: fillPrice,
                    trantype: order.trantype,
                    exch: order.exch || 'NFO',
                    fillshares: order.qty,
                    flqty: order.qty,
                    flprc: fillPrice,
                    avgprc: fillPrice,
                });
            }
        });

        return { stat: 'Ok', norenordno };
    }

    async get_quotes(exchange: string, _token: string): Promise<any> {
        const ft = new Date().toTimeString().split(' ')[0];
        if (exchange === 'NFO') {
            // Option LTP = NIFTY LTP (same price series, matches pipeline threshold scans)
            return { stat: 'Ok', lp: (this._niftyLtp || 0).toString(), ft };
        }
        // NSE: return latest NIFTY LTP from Quote collection for MOCK_DATE
        try {
            const db = Mongo.getInstance().db;
            const query = MOCK_DATE ? { date: MOCK_DATE } : {};
            const latest = await db.collection('Quote').findOne(query, { sort: { ltt: -1 } }) as any;
            if (latest) {
                return { stat: 'Ok', lp: latest.ltp.toString(), ft: latest.ltt };
            }
        } catch (e) {
            Log.log('[MockAPI] get_quotes MongoDB error:', e);
        }
        return { stat: 'Ok', lp: this._niftyLtp.toString(), ft };
    }

    async startMockStreams(): Promise<void> {
        const dateLabel = MOCK_DATE || 'all dates';
        Log.log(`[MockAPI] Starting mock NIFTY stream from Quote collection (date=${dateLabel})`);
        let quotes: any[] = [];
        let idx = 0;

        try {
            const db = Mongo.getInstance().db;
            const query = MOCK_DATE ? { date: MOCK_DATE } : {};
            quotes = await db.collection('Quote')
                .find(query)
                .sort({ ltt: 1 })
                .toArray();
            Log.log(`[MockAPI] Loaded ${quotes.length} Quote records from MongoDB (date=${dateLabel})`);
        } catch (e) {
            Log.log('[MockAPI] MongoDB fetch error, using fallback LTP 23500:', e);
            for (let i = 0; i < 500; i++) {
                quotes.push({ ltp: 23500 + Math.sin(i / 20) * 100, ltt: new Date().toTimeString().split(' ')[0] });
            }
        }

        let stopped = false;

        const sendNext = async () => {
            if (stopped || !this._callbacks || idx >= quotes.length) {
                Log.log('[MockAPI] Mock NIFTY stream exhausted all quotes');
                this._callbacks?.exhausted?.();
                return;
            }
            const record = quotes[idx++];
            this._niftyLtp = record.ltp;

            // Emit NIFTY index quote
            await this._callbacks.quote({
                t: 'tf',
                e: 'NSE',
                tk: '26000',
                lp: record.ltp.toString(),
                ft: record.ltt,
            });

            // Emit option quotes synchronously for all subscribed tokens
            // Option LTP = NIFTY LTP so target/stoploss scans match pipeline thresholds directly
            for (const [token] of this._subscribedTokens) {
                await this._callbacks.quote({
                    t: 'tf',
                    e: 'NFO',
                    tk: token,
                    lp: record.ltp.toString(),
                });
            }

            setImmediate(sendNext);
        };

        (this as any)._stopNifty = () => { stopped = true; };
        setImmediate(sendNext);
    }

    subscribe(instrument: string, right?: string): void {
        const parts = instrument.split('|');
        if (parts[0] !== 'NFO') return;
        const token = parts[1];
        if (this._subscribedTokens.has(token)) return;
        Log.log(`[MockAPI] subscribe NFO|${token} right=${right || 'unknown'} (LTP tracks NIFTY)`);
        this._subscribedTokens.set(token, right || '');
    }

    unsubscribe(token: string): void {
        if (this._subscribedTokens.has(token)) {
            this._subscribedTokens.delete(token);
            Log.log(`[MockAPI] unsubscribe NFO|${token}`);
        }
    }

    stopAll(): void {
        if ((this as any)._stopNifty) {
            (this as any)._stopNifty();
            (this as any)._stopNifty = null;
        }
        this._subscribedTokens.clear();
    }
}

export default new MockRestAPI();
