/**
 * Shared CSV-replay/mock-broker helpers for the strategy backtest tools
 * (ContinuousStrategyBacktest.ts, SupportResistanceStrategyBacktest.ts) -
 * extracted 2026-09-11 so both tools replay the same historical
 * work/data/backups/<Mon-DD>/csv/ layout and simulate fills against the same
 * synthetic contract directory, without drifting duplicate copies.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { Trade } from '../model/model';
import { CALL, PUT } from '../constants';

export function getArg(name: string, defaultValue: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}

export function getFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

// Defaults to this repo's standard backup dir (work/data/backups/<Mon-DD>/csv/,
// see discoverDayFolders below) so a backtest npm script works with no flags.
export const DEFAULT_ALL_DAYS_DIR = '/home/karthikeyan/work/data/backups';

export interface NiftyTick { ltp: number; ltt: number; }
export interface OptionTick { strike: number; optionType: 'CE' | 'PE'; tsym: string; ltp: number; ltt: number; }

// Displays in IST (the CSV's own `time` column is IST-labeled) rather than
// UTC/local, so times in the report line up with the source data.
export function fmtTime(epochMs: number): string {
    return new Date(epochMs).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
}

export function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export function loadNiftyTicks(filePath: string): NiftyTick[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const records: any[] = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    const ticks = records
        .filter((r) => r.index === 'NIFTY')
        .map((r) => ({ ltp: Number(r.ltp), ltt: Number(r.ltt) * 1000 }));
    ticks.sort((a, b) => a.ltt - b.ltt);
    return ticks;
}

// Pre-filters to NIFTY-only lines by a raw string check before handing the
// reduced text to csv-parse - cuts parse work roughly in half (SENSEX rows
// are pure waste for this tool). Reliable because the header order
// (tsym,index,strike,optionType) puts a bare quoted "NIFTY" only in the
// index column - a tsym like "NIFTY25AUG26C24050" never matches the exact
// `,"NIFTY",` substring.
export function loadNiftyOptionTicks(filePath: string): OptionTick[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const niftyLines = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].includes(',"NIFTY",')) niftyLines.push(lines[i]);
    }
    const records: any[] = parse(niftyLines.join('\n'), { columns: true, skip_empty_lines: true, trim: true });
    const ticks = records.map((r) => ({
        strike: Number(r.strike),
        optionType: r.optionType as 'CE' | 'PE',
        tsym: r.tsym as string,
        ltp: Number(r.ltp),
        ltt: Number(r.ltt) * 1000,
    }));
    ticks.sort((a, b) => a.ltt - b.ltt);
    return ticks;
}

// --- Synthetic contract directory (no live broker involved) ---

export interface ContractInfo { token: string; tsym: string; strike: number; optionType: 'CE' | 'PE'; exchange: 'NFO'; }

export function contractKey(strike: number, optionType: string): string {
    return `${strike}_${optionType}`;
}

export function buildContractDirectory(ticks: OptionTick[]): Map<string, ContractInfo> {
    const dir = new Map<string, ContractInfo>();
    for (const t of ticks) {
        const key = contractKey(t.strike, t.optionType);
        if (!dir.has(key)) {
            dir.set(key, { token: `OPT_${key}`, tsym: t.tsym, strike: t.strike, optionType: t.optionType, exchange: 'NFO' });
        }
    }
    return dir;
}

// Reads baseDir/<day>/csv/Quote.csv + OptionQuote.csv for every subfolder of
// baseDir (this repo's work/data/backups/<Mon-DD>/csv/ layout), skipping any
// day missing either file. Sorted by parsed "Mon-DD" date, not plain string
// sort, so a single-digit day (e.g. a future "Sep-5") still lands in the
// right place relative to two-digit days.
export function discoverDayFolders(baseDir: string): { day: string; niftyFile: string; optionFile: string }[] {
    const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const entries = fs.readdirSync(baseDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const found: { day: string; niftyFile: string; optionFile: string; sortKey: number }[] = [];

    for (const entry of entries) {
        const dayDir = path.join(baseDir, entry.name);
        const niftyFile = path.join(dayDir, 'csv', 'Quote.csv');
        const optionFile = path.join(dayDir, 'csv', 'OptionQuote.csv');
        if (!fs.existsSync(niftyFile) || !fs.existsSync(optionFile)) {
            console.error(`[${entry.name}] Missing Quote.csv or OptionQuote.csv under csv/ - skipping`);
            continue;
        }
        const match = entry.name.match(/^([A-Za-z]{3})-(\d{1,2})$/);
        const sortKey = match && MONTHS[match[1]] !== undefined ? MONTHS[match[1]] * 100 + Number(match[2]) : Number.MAX_SAFE_INTEGER;
        found.push({ day: entry.name, niftyFile, optionFile, sortKey });
    }

    found.sort((a, b) => a.sortKey - b.sortKey || a.day.localeCompare(b.day));
    return found.map(({ day, niftyFile, optionFile }) => ({ day, niftyFile, optionFile }));
}

// --- Trade ledger ---

export interface OpenLedgerEntry { tsym: string; right: string; entryTime: number; entryPrice: number; quantity: number; }
export interface TradeRecord {
    tsym: string; right: string; entryTime: number; entryPrice: number;
    exitTime: number; exitPrice: number; quantity: number; pnl: number;
}

// --- Mock OrderClient, data-driven from the loaded CSVs instead of test-controlled
// (compare src/test/continuousStrategyTest.ts's MockOrderClient). Shared by both
// backtest tools - `forcedRight`/PCR stub only matter to ContinuousStrategy
// (SupportResistanceStrategy never calls calculateRight/getPCR). ---

export class BacktestOrderClient {
    latestPrice = new Map<string, number>(); // contractKey -> latest known ltp, updated by the replay loop
    pendingLimitOrders = new Map<string, { tsym: string; quantity: number; limitPrice: number; exchange: 'NFO'; userId: string; orderId: string }>();
    openTrades = new Map<string, OpenLedgerEntry>(); // token -> open ledger entry
    closedTrades: TradeRecord[] = [];
    currentTime = 0; // set by the replay loop before each dispatch

    constructor(private contractDirectory: Map<string, ContractInfo>, private forcedRight: 'call' | 'put' = 'call') {}

    async calculateRight(_userId: string, _ltp?: number): Promise<string> {
        return this.forcedRight;
    }

    async getContractByPriceRangeBare(
        _userId: string, underlyingLtp: number, optionType: 'CE' | 'PE', minPremium: number,
        _index = 'NIFTY', excludeStrikes: number[] = []
    ) {
        const strikeStep = 50;
        const atmStrike = Math.round(underlyingLtp / strikeStep) * strikeStep;
        const excluded = new Set(excludeStrikes);

        const tryStrike = (strike: number) => {
            if (excluded.has(strike)) return null;
            const key = contractKey(strike, optionType);
            const contract = this.contractDirectory.get(key);
            if (!contract) return null;
            const premium = this.latestPrice.get(key);
            if (premium == null || premium < minPremium) return null;
            // Single unified synthetic token space in this backtest (no real broker
            // divergence to model) - antToken is the same value the strategy now
            // reads instead of instrumentToken.
            return { tradingSymbol: contract.tsym, instrumentToken: contract.token, antToken: contract.token, lotSize: 65, exchange: contract.exchange, strike, premium };
        };

        for (let depth = 0; depth < 5; depth++) {
            const strike = optionType === 'CE' ? atmStrike + depth * strikeStep : atmStrike - depth * strikeStep;
            const result = tryStrike(strike);
            if (result) return result;
        }
        for (let depth = 1; depth < 5; depth++) {
            const strike = optionType === 'CE' ? atmStrike - depth * strikeStep : atmStrike + depth * strikeStep;
            const result = tryStrike(strike);
            if (result) return result;
        }
        throw new Error(`No ${optionType} contract found with premium >= ${minPremium} (underlyingLtp=${underlyingLtp})`);
    }

    async buyContractBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, _exchange: 'NFO' | 'BFO', _price?: number): Promise<Trade> {
        const key = this.keyForToken(instrumentToken);
        const contract = key ? this.contractDirectory.get(key) : undefined;
        const price = key ? this.latestPrice.get(key) : undefined;
        if (!contract || price == null) throw new Error(`No known price for ${tradingSymbol} at buy time`);
        const right = contract.optionType === 'CE' ? CALL : PUT;
        this.openLeg(instrumentToken, tradingSymbol, right, quantity, price);
        return this.makeTrade(tradingSymbol, instrumentToken, quantity, price, 'Buy', userId);
    }

    async sellContractBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, _exchange: 'NFO' | 'BFO'): Promise<Trade> {
        const key = this.keyForToken(instrumentToken);
        const price = key ? this.latestPrice.get(key) : undefined;
        if (price == null) throw new Error(`No known price for ${tradingSymbol} at sell time`);
        this.closeLeg(instrumentToken, price);
        return this.makeTrade(tradingSymbol, instrumentToken, quantity, price, 'Sell', userId);
    }

    async placeLimitBuyBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO'): Promise<{ orderId: string }> {
        const orderId = `SIM_${instrumentToken}_${this.pendingLimitOrders.size + 1}`;
        this.pendingLimitOrders.set(instrumentToken, { tsym: tradingSymbol, quantity, limitPrice: price, exchange: exchange as 'NFO', userId, orderId });
        return { orderId };
    }

    // Previously unimplemented (a documented backtest gap - see ToDo.md's
    // 2026-09-01 entry) - LegManager's checkRefillDrift/cancelChildRefills/
    // closeAllLegsAndCancelReEntries all clear their own in-memory
    // pendingReEntries synchronously before this call, but without a real
    // cancel here the simulated resting order stayed in pendingLimitOrders
    // forever and could spuriously "fill" on a later tick after the strategy
    // had already moved on - fixed by actually removing the matching order.
    async cancelOrderBare(_userId: string, orderId: string): Promise<void> {
        for (const [token, order] of Array.from(this.pendingLimitOrders.entries())) {
            if (order.orderId === orderId) { this.pendingLimitOrders.delete(token); return; }
        }
    }

    // The historical CSVs backing this backtest carry no option-chain OI data,
    // so PCR gating can't be simulated - fixed neutral stub. Only ContinuousStrategy
    // reads this; SupportResistanceStrategy never calls getPCR.
    async getPCR(_userId: string, _underlying: string, _spot: number, _window: number): Promise<number> {
        return 0.5; // < 1 favors CALL
    }

    // No longer consulted by capitalCheck() (LegManager reads maxInvestment
    // directly from cfg(), not this per-user override) - kept as a harmless
    // stub since OrderClient still declares the method.
    async getUserAllottedCapital(_userId: string): Promise<number | undefined> {
        return undefined;
    }

    // Real bug found/fixed 2026-09-11 (via StrategyOrderTree.js analysis of a
    // maxProfit=100 backtest run showing a large P&L mismatch between
    // strategy.getStats() and this ledger): buyContractBare is also
    // the call LegManager.tryAverageLevel uses to average into an ALREADY-
    // OPEN leg (same token) - this used to unconditionally overwrite the
    // ledger entry with just the incremental add's own price/qty, discarding
    // the true blended cost basis, so any leg that was ever averaged closed
    // with a wrong (understated qty, wrong entry price) ledger P&L even
    // though LegManager's own avgPrice/totalQuantity tracking was correct.
    // Now blends exactly the way LegManager.tryAverageLevel does.
    openLeg(token: string, tsym: string, right: string, quantity: number, price: number): void {
        const existing = this.openTrades.get(token);
        if (existing) {
            const newQuantity = existing.quantity + quantity;
            const newEntryPrice = (existing.entryPrice * existing.quantity + price * quantity) / newQuantity;
            this.openTrades.set(token, { ...existing, entryPrice: newEntryPrice, quantity: newQuantity });
        } else {
            this.openTrades.set(token, { tsym, right, entryTime: this.currentTime, entryPrice: price, quantity });
        }
    }

    closeLeg(token: string, price: number): void {
        const open = this.openTrades.get(token);
        if (!open) return;
        this.openTrades.delete(token);
        this.closedTrades.push({
            tsym: open.tsym, right: open.right, entryTime: open.entryTime, entryPrice: open.entryPrice,
            exitTime: this.currentTime, exitPrice: price, quantity: open.quantity,
            pnl: (price - open.entryPrice) * open.quantity,
        });
    }

    private keyForToken(token: string): string | undefined {
        return token.startsWith('OPT_') ? token.slice(4) : undefined;
    }

    private makeTrade(tsym: string, token: string, quantity: number, price: number, action: 'Buy' | 'Sell', userId: string): Trade {
        const t = new Trade();
        t.tsym = tsym; t.token = token; t.quantity = quantity; t.price = price;
        t.lastTradePrice = price; t.action = action; t.status = 'COMPLETE'; t.user = userId;
        return t;
    }
}
