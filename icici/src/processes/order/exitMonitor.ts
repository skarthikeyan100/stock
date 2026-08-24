import Log from '../../util/Log';
import { writeJsonLine } from '../../ipc/jsonLines';
import { OptionQuote, Trade } from '../../model/model';

// In-app target/SL exit monitoring, for trades placed with useGTT=false (see
// bookkeeping.getUserUseGTT / zerodhaExecutor.finalizeEntry, antExecutor.finalizeEntry).
// Mirrors strategies' tokenRouter.ts+DataClient.ts pattern one level up:
// subscribe/unsubscribe commands go out on `order`'s own stdout, which the
// orchestrator relays into `data`'s stdin, and ticks come back in on `order`'s
// stdin (see orderProcess.ts). The actual squareoff call is injected per-broker
// via onExit() rather than imported directly, to avoid a circular dependency
// with zerodhaExecutor.ts/antExecutor.ts.

export type Broker = 'zerodha' | 'ant';

interface MonitoredTrade {
    trade: Trade;
    exchange: 'NFO' | 'BFO';
    broker: Broker;
}

type ExitHandler = (trade: Trade, exchange: 'NFO' | 'BFO') => Promise<void>;

const monitored = new Map<string, MonitoredTrade>(); // keyed by trade.token
const exitHandlers = new Map<Broker, ExitHandler>();

export function onExit(broker: Broker, handler: ExitHandler): void {
    exitHandlers.set(broker, handler);
}

export function registerTrade(trade: Trade, exchange: 'NFO' | 'BFO', broker: Broker): void {
    monitored.set(trade.token, { trade, exchange, broker });
    writeJsonLine(process.stdout, { cmd: 'subscribe', token: trade.token });
    Log.log(`[order] exitMonitor watching ${trade.tsym} (token ${trade.token}, ${broker}) for ${trade.user}: target=${trade.targetPrice} stopLoss=${trade.stopLossPrice}`);
}

export function unregisterTrade(token: string): void {
    if (!monitored.has(token)) return;
    monitored.delete(token);
    writeJsonLine(process.stdout, { cmd: 'unsubscribe', token });
}

export async function handleOptionTick(quote: OptionQuote): Promise<void> {
    const entry = monitored.get(String(quote.token));
    if (!entry) return;
    const { trade, exchange, broker } = entry;
    trade.lastTradePrice = quote.ltp;

    const hitTarget = trade.targetPrice != null && quote.ltp >= trade.targetPrice;
    const hitStopLoss = trade.stopLossPrice != null && quote.ltp <= trade.stopLossPrice;
    if (!hitTarget && !hitStopLoss) return;

    // Unregister before awaiting the exit so a second tick arriving while the
    // squareoff is in flight can't trigger it twice.
    unregisterTrade(trade.token);
    Log.log(`[order] exitMonitor triggering squareoff for ${trade.tsym} (${trade.user}, ${broker}): ltp=${quote.ltp} hit=${hitTarget ? 'target' : 'stopLoss'}`);

    const exitHandler = exitHandlers.get(broker);
    if (!exitHandler) {
        Log.log(`[order] exitMonitor has no exit handler registered for broker '${broker}' - cannot square off`, trade.tsym);
        return;
    }
    try {
        await exitHandler(trade, exchange);
    } catch (e) {
        Log.log('[order] exitMonitor squareoff failed:', trade.tsym, e);
    }
}
