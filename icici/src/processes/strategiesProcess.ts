// stdout is reserved for the subscribe/unsubscribe protocol back to `data` -
// redirect console.log to stderr before any other module loads (mirrors
// dataProcess.ts).
console.log = console.error;

import net from 'net';
import fs from 'fs';
import Log from '../util/Log';
import Mongo from '../tools/mongo';
import { readJsonLines, writeJsonLine } from '../ipc/jsonLines';
import { STRATEGIES_SOCKET_PATH, StrategiesRequest, StrategiesResponse } from '../ipc/strategiesProtocol';
import strategies from '../strategy/strategies';
import OrderClient from './strategies/OrderClient';
import { registerTrade, unregisterTrade, routeOptionTick } from './strategies/tokenRouter';
import * as niftyQuoteHistory from './strategies/niftyQuoteHistory';
import * as niftyCandleBuilder from './strategies/niftyCandleBuilder';
import { NiftyQuote, OptionQuote, SensexQuote, Trade } from '../model/model';

// Entry point for the `strategies` process. No Prism/Zerodha dependency at all -
// ticks arrive over stdin (piped from `data` by the orchestrator), orders go out
// over OrderClient's IPC socket to `order`, fills come back the same way. This is
// the process meant to be killed and respawned on every strategy code change,
// without ever touching `data`'s or `order`'s live broker connections.

async function onFill(userId: string, raw: any) {
    const trade = Object.assign(new Trade(), raw) as Trade;
    const strategy = strategies.getByUserId(userId);
    if (!strategy) {
        Log.log('[strategies] Fill for unknown strategy userId:', userId);
        return;
    }
    if (trade.action === 'Buy' && trade.token) {
        registerTrade(trade.token, strategy);
    } else if (trade.action === 'Sell' && trade.token) {
        unregisterTrade(trade.token, strategy);
    }
    await strategy.updateTrade(trade);
}

async function onTick(tick: any) {
    if (tick.type === 'nifty') {
        const quote = Object.assign(new NiftyQuote(), tick.quote) as NiftyQuote;
        niftyQuoteHistory.record(quote);
        niftyCandleBuilder.record(quote);
        for (const strategy of strategies.getList()) {
            if (strategy.enabled) await strategy.processNiftyQuote(quote);
        }
    } else if (tick.type === 'sensex') {
        const quote = Object.assign(new SensexQuote(), tick.quote) as SensexQuote;
        for (const strategy of strategies.getList()) {
            if (strategy.enabled) await strategy.processSensexQuote(quote);
        }
    } else if (tick.type === 'option') {
        const quote = Object.assign(new OptionQuote(), tick.quote) as OptionQuote;
        await routeOptionTick(quote);
    }
}

async function handleStrategiesRequest(req: StrategiesRequest): Promise<StrategiesResponse> {
    try {
        switch (req.type) {
            case 'stats':
                return { kind: 'response', id: req.id, ok: true, result: strategies.getList().map((s) => s.getStats()) };

            case 'list':
                return {
                    kind: 'response',
                    id: req.id,
                    ok: true,
                    result: strategies.getList().map((s) => ({ type: s.getClassName(), userId: s.userId, enabled: s.enabled })),
                };

            case 'setEnabled': {
                const { identifier, enabled } = req.payload;
                strategies.getList().forEach((s) => {
                    if (s.userId === identifier || s.getClassName() === identifier) s.enabled = enabled;
                });
                return {
                    kind: 'response',
                    id: req.id,
                    ok: true,
                    result: strategies.getList().map((s) => ({ type: s.getClassName(), userId: s.userId, enabled: s.enabled })),
                };
            }

            case 'reset': {
                const matched = strategies.getList().filter((s) => s.getClassName() === req.payload.type);
                matched.forEach((s) => s.reset());
                return { kind: 'response', id: req.id, ok: true, result: { type: req.payload.type, reset: matched.length } };
            }

            case 'getCandles':
                return { kind: 'response', id: req.id, ok: true, result: niftyCandleBuilder.getCandles() };

            default:
                return { kind: 'response', id: req.id, ok: false, error: `Unknown request type: ${(req as any).type}` };
        }
    } catch (e: any) {
        Log.log('[strategies] Request failed:', req.type, e);
        return { kind: 'response', id: req.id, ok: false, error: e?.message ?? String(e) };
    }
}

function startStrategiesServer() {
    if (fs.existsSync(STRATEGIES_SOCKET_PATH)) fs.unlinkSync(STRATEGIES_SOCKET_PATH);
    const server = net.createServer((socket) => {
        Log.log('[strategies] Frontend client connected');
        readJsonLines(
            socket,
            async (msg) => {
                if (msg.kind === 'request') {
                    const response = await handleStrategiesRequest(msg as StrategiesRequest);
                    writeJsonLine(socket, response);
                }
            },
            (line, err) => Log.log('[strategies] Failed to parse client message:', line, err)
        );
        socket.on('error', (e) => Log.log('[strategies] Client socket error:', e));
    });
    server.listen(STRATEGIES_SOCKET_PATH, () => Log.log('[strategies] Listening on', STRATEGIES_SOCKET_PATH));
}

async function main() {
    await Mongo.init().catch((e) => Log.log('[strategies] Mongo.init failed (continuing without persistence):', e));

    OrderClient.getInstance().onFill((userId, trade) => {
        onFill(userId, trade).catch((e) => Log.log('[strategies] onFill handler failed:', e));
    });
    OrderClient.getInstance().connect();
    startStrategiesServer();

    readJsonLines(
        process.stdin,
        (tick) => {
            onTick(tick).catch((e) => Log.log('[strategies] onTick handler failed:', e));
        },
        (line, err) => Log.log('[strategies] Failed to parse stdin tick:', line, err)
    );

    await strategies.initialize();
    Log.log(`[strategies] Ready - ${strategies.getList().length} strategies loaded.`);
}

main().catch((e) => {
    Log.log('[strategies] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => {
    if (fs.existsSync(STRATEGIES_SOCKET_PATH)) fs.unlinkSync(STRATEGIES_SOCKET_PATH);
    process.exit(0);
});
