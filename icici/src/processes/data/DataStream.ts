// Common shape AntDataStream/BreezeDataStream (and a future PrismDataStream)
// already share - lets dataProcess.ts hold a registry of these instead of an
// if/else per broker.
export interface DataStream {
    connect(): Promise<void>;
    reconnect(): Promise<void>;
    // exchange defaults to 'NFO' in every implementation - only a SENSEX
    // (BFO) option token needs to pass 'BFO' explicitly. Added so AntDataStream
    // can key its ANT websocket subscription (`NFO|<token>` vs `BFO|<token>`)
    // correctly instead of always assuming NFO (found on code review - a
    // held BFO token subscribed as NFO| never gets a tick back from AliceBlue).
    subscribeOption(token: string, exchange?: 'NFO' | 'BFO'): Promise<void>;
    unsubscribeOption(token: string, exchange?: 'NFO' | 'BFO'): Promise<void>;
    disconnect(): void;
    // Depth-mode subscription, needed only for the momentum signal's tbq/tsq
    // (see MomentumSignal.ts) - optional since it's ANT-specific; other
    // DataStream implementations (e.g. BreezeDataStream) simply don't have it.
    subscribeOptionDepth?(token: string, exchange?: 'NFO' | 'BFO'): Promise<void>;
    unsubscribeOptionDepth?(token: string, exchange?: 'NFO' | 'BFO'): Promise<void>;
}
