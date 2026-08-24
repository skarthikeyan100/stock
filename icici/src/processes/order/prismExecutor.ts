import Log from '../../util/Log';
import Prism from '../../prism';
import indexMap from '../../nse_index';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';

// Prism/Shoonya's contract-by-price-range order path - the secondary/legacy
// broker path (Zerodha is primary, see zerodhaExecutor.ts). `Prism.getInstance()`
// itself is reused as-is (its internal Monitor coupling was removed in favor of
// bookkeeping.ts - see src/prism.ts); this module just exposes the read-only
// lookups and order placement over IPC and folds fills into the same
// bookkeeping/fill-notification path buyIndexOnZerodha uses.

export async function getContractByPriceRange(right: string): Promise<string | null> {
    return Prism.getInstance().getContractByPriceRange(right);
}

export async function calculateRight(ltp?: number): Promise<string> {
    return Prism.getInstance().calculateRight(ltp);
}

export async function getToken(contract: string): Promise<string> {
    return Prism.getInstance().getToken(contract);
}

export async function getNiftyQuote(): Promise<any> {
    return Prism.getInstance().getNiftyQuote();
}

export async function getIndexQuote(index: 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY'): Promise<any> {
    if (index === 'BANKNIFTY') return Prism.getInstance().getBankNiftyQuote();
    if (index === 'FINNIFTY') return Prism.getInstance().getFinNiftyQuote();
    return Prism.getInstance().getNiftyQuote();
}

export async function getStockQuote(symbol: string): Promise<any> {
    return Prism.getInstance().getStockQuote(symbol);
}

// GET /connect: re-establish Prism/Shoonya's websocket (order-fill
// notifications only - quotes come from `data`/ANT, not this).
export async function connectPrism(): Promise<void> {
    await Prism.getInstance().connect();
}

export async function getOptionQuote(token: string): Promise<any> {
    return Prism.getInstance().getOptionQuote(token);
}

export async function getStockOptionQuote(contract: string): Promise<any> {
    return Prism.getInstance().getStockOptionQuote(contract);
}

export async function buyContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
    Log.log(`[order] Buying (Prism) ${contract} qty=${quantity} for ${userId}`);
    const response = await Prism.getInstance().buyContract(contract, quantity, price);
    if (!response) throw new Error(`buyContract failed for ${contract}`);

    const trade = new Trade();
    trade.tsym = response.contract;
    trade.token = response.token;
    trade.quantity = response.qty;
    trade.price = response.price;
    trade.lastTradePrice = response.price;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;

    await bookkeeping.recordFill(trade);
    return response;
}

// GET /search: debug token finder by depth (distinct from getContractByPriceRange,
// which searches by a price *range* - this is index+depth+right -> token).
export async function findToken(index: string, depth: number, right: string): Promise<string> {
    const nseIndex = indexMap.get(index);
    return nseIndex.findToken(index, depth, right);
}

export async function getOrders(): Promise<any> {
    return Prism.getInstance().getOrders();
}

// GET /refreshtrades: pull live positions from the broker and replace
// bookkeeping.trades wholesale (Prism.refreshTradeList already calls
// bookkeeping.refreshTrades internally - see src/prism.ts's Monitor->bookkeeping
// redirect - this is just the IPC-reachable entry point for it).
export async function refreshTradeList(): Promise<any> {
    return Prism.getInstance().refreshTradeList();
}

export async function sellContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
    Log.log(`[order] Selling (Prism) ${contract} qty=${quantity} for ${userId}`);
    // Resolve price up front (rather than relying on sellContract's own
    // fallback, which doesn't return it) so bookkeeping's P&L calc has a real
    // sell price to work with.
    const resolvedPrice = price ?? (await Prism.getInstance().getStockOptionQuote(contract)).ltp;
    await Prism.getInstance().sellContract(contract, quantity, resolvedPrice, userId);

    const trade = new Trade();
    trade.tsym = contract;
    trade.token = await Prism.getInstance().getToken(contract);
    trade.quantity = quantity;
    trade.price = resolvedPrice;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;

    await bookkeeping.recordFill(trade);
    return trade;
}
