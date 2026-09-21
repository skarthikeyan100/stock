// Common shape AntDataStream/BreezeDataStream (and a future PrismDataStream)
// already share - lets dataProcess.ts hold a registry of these instead of an
// if/else per broker.
export interface DataStream {
    connect(): Promise<void>;
    reconnect(): Promise<void>;
    subscribeOption(token: string): Promise<void>;
    unsubscribeOption(token: string): Promise<void>;
    disconnect(): void;
    // Depth-mode subscription, needed only for the momentum signal's tbq/tsq
    // (see MomentumSignal.ts) - optional since it's ANT-specific; other
    // DataStream implementations (e.g. BreezeDataStream) simply don't have it.
    subscribeOptionDepth?(token: string): Promise<void>;
    unsubscribeOptionDepth?(token: string): Promise<void>;
}
