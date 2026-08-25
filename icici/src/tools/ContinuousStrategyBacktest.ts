/**
 * Replays a day's real tick data (a Quote.csv export of NIFTY index ticks +
 * an OptionQuote.csv export of per-contract option ticks) through a live
 * ContinuousStrategy instance (src/strategy/ContinuousStrategy.ts), with a
 * broker mock that resolves contracts/fills against the actual historical
 * premiums instead of a live Zerodha call.
 *
 * Not wired into live trading - this is a manual backtest tool, following
 * the same replay-a-CSV convention as SupportResistanceHypothesisTest.ts /
 * RateOfChangeHypothesisTest.ts, but driving a real Strategy subclass
 * instead of bespoke points-based simulation.
 *
 * `right` is forced to FORCED_RIGHT below - config.yml's `right: none`
 * requires a live broker call (OrderClient.calculateRight) to resolve, which
 * can't be replayed from CSV data.
 *
 * Caveat: Strategy.isCooldownElapsed/recordTriggerTime (src/strategy/strategy.ts)
 * use real Date.now(), not simulated tick time - a backtest run (which
 * replays a full day's ticks in seconds of real wall-clock time) will not
 * see the cooldown naturally elapse between independent T1 entries the way a
 * live day would. Expect at most one T1 chain per run unless the run itself
 * takes longer than cooldownSeconds of real time - the chain can still
 * contain many spawns/refills over the simulated day. isTimeInRange()'s
 * 10:00-15:00 gate is bypassed correctly via MOCK_BROKER=true (see the npm
 * script), since that check already has a mock-mode escape hatch.
 *
 * Usage:
 *   tsc && MOCK_BROKER=true node ./dist/tools/ContinuousStrategyBacktest.js \
 *     --niftyFile /path/to/Quote.csv --optionFile /path/to/OptionQuote.csv \
 *     [--spawnQuantityMode same|multiplied]
 *
 * Every field in config.yml's `continuousStrategy` block is used as-is except
 * `right` (always forced, see above) and `enabled` (always forced true - a
 * disabled strategy trivially produces zero trades). `--spawnQuantityMode`
 * optionally overrides that one field for a single run, to compare "same
 * quantity every level" against "multiplied by level" without editing
 * config.yml.
 */
import * as fs from 'fs';
import { parse } from 'csv-parse/sync';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import ContinuousStrategy from '../strategy/ContinuousStrategy';
import { CALL, PUT } from '../constants';

const FORCED_RIGHT = 'call';

function getArg(name: string, defaultValue: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}

const SPAWN_QUANTITY_MODE_OVERRIDE = getArg('spawnQuantityMode', '');

const NIFTY_FILE = getArg('niftyFile', '');
const OPTION_FILE = getArg('optionFile', '');

interface NiftyTick { ltp: number; ltt: number; }
interface OptionTick { strike: number; optionType: 'CE' | 'PE'; tsym: string; ltp: number; ltt: number; }

// Displays in IST (the CSV's own `time` column is IST-labeled) rather than
// UTC/local, so times in the report line up with the source data.
function fmtTime(epochMs: number): string {
    return new Date(epochMs).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function loadNiftyTicks(filePath: string): NiftyTick[] {
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
function loadNiftyOptionTicks(filePath: string): OptionTick[] {
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

interface ContractInfo { token: string; tsym: string; strike: number; optionType: 'CE' | 'PE'; exchange: 'NFO'; }

function contractKey(strike: number, optionType: string): string {
    return `${strike}_${optionType}`;
}

function buildContractDirectory(ticks: OptionTick[]): Map<string, ContractInfo> {
    const dir = new Map<string, ContractInfo>();
    for (const t of ticks) {
        const key = contractKey(t.strike, t.optionType);
        if (!dir.has(key)) {
            dir.set(key, { token: `OPT_${key}`, tsym: t.tsym, strike: t.strike, optionType: t.optionType, exchange: 'NFO' });
        }
    }
    return dir;
}

// --- Trade ledger ---

interface OpenLedgerEntry { tsym: string; right: string; entryTime: number; entryPrice: number; quantity: number; }
interface TradeRecord {
    tsym: string; right: string; entryTime: number; entryPrice: number;
    exitTime: number; exitPrice: number; quantity: number; pnl: number;
}

// --- Mock OrderClient, data-driven from the loaded CSVs instead of test-controlled
// (compare src/test/continuousStrategyTest.ts's MockOrderClient) ---

class BacktestOrderClient {
    latestPrice = new Map<string, number>(); // contractKey -> latest known ltp, updated by the replay loop
    pendingLimitOrders = new Map<string, { tsym: string; quantity: number; limitPrice: number; exchange: 'NFO'; userId: string }>();
    openTrades = new Map<string, OpenLedgerEntry>(); // token -> open ledger entry
    closedTrades: TradeRecord[] = [];
    currentTime = 0; // set by the replay loop before each dispatch

    constructor(private contractDirectory: Map<string, ContractInfo>) {}

    async calculateRight(_userId: string, _ltp?: number): Promise<string> {
        return FORCED_RIGHT;
    }

    async getContractByPriceRangeZerodha(
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
            // divergence to model) - antToken is the same value ContinuousStrategy.ts
            // now reads instead of instrumentToken (see its T1-entry comment).
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

    async buyContractZerodhaBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, _exchange: 'NFO' | 'BFO', _price?: number): Promise<Trade> {
        const key = this.keyForToken(instrumentToken);
        const contract = key ? this.contractDirectory.get(key) : undefined;
        const price = key ? this.latestPrice.get(key) : undefined;
        if (!contract || price == null) throw new Error(`No known price for ${tradingSymbol} at buy time`);
        const right = contract.optionType === 'CE' ? CALL : PUT;
        this.openLeg(instrumentToken, tradingSymbol, right, quantity, price);
        return this.makeTrade(tradingSymbol, instrumentToken, quantity, price, 'Buy', userId);
    }

    async sellContractZerodhaBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, _exchange: 'NFO' | 'BFO'): Promise<Trade> {
        const key = this.keyForToken(instrumentToken);
        const price = key ? this.latestPrice.get(key) : undefined;
        if (price == null) throw new Error(`No known price for ${tradingSymbol} at sell time`);
        this.closeLeg(instrumentToken, price);
        return this.makeTrade(tradingSymbol, instrumentToken, quantity, price, 'Sell', userId);
    }

    async placeLimitBuyZerodhaBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO'): Promise<{ orderId: string }> {
        this.pendingLimitOrders.set(instrumentToken, { tsym: tradingSymbol, quantity, limitPrice: price, exchange: exchange as 'NFO', userId });
        return { orderId: `SIM_${instrumentToken}_${this.pendingLimitOrders.size}` };
    }

    // The historical CSVs backing this backtest carry no option-chain OI data,
    // so PCR gating can't be simulated - fixed neutral stub that always aligns
    // with FORCED_RIGHT ('call'), i.e. PCR gating is effectively a no-op here.
    // Backtest P&L therefore does NOT reflect live PCR gating - a known,
    // documented gap, not a silent inaccuracy.
    async getPCR(_userId: string, _underlying: string, _spot: number, _window: number): Promise<number> {
        return 0.5; // < 1 favors CALL, matching FORCED_RIGHT
    }

    openLeg(token: string, tsym: string, right: string, quantity: number, price: number): void {
        this.openTrades.set(token, { tsym, right, entryTime: this.currentTime, entryPrice: price, quantity });
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

async function main() {
    if (!NIFTY_FILE || !OPTION_FILE) {
        console.error('Usage: node ./dist/tools/ContinuousStrategyBacktest.js --niftyFile <Quote.csv> --optionFile <OptionQuote.csv>');
        process.exit(1);
    }

    const niftyTicks = loadNiftyTicks(NIFTY_FILE);
    const optionTicks = loadNiftyOptionTicks(OPTION_FILE);
    console.error(`Loaded ${niftyTicks.length} NIFTY ticks, ${optionTicks.length} NIFTY option ticks`);
    if (niftyTicks.length === 0 || optionTicks.length === 0) {
        console.error('No ticks loaded - aborting');
        process.exit(1);
    }

    const contractDirectory = buildContractDirectory(optionTicks);
    console.error(`Contract directory: ${contractDirectory.size} contracts`);

    const mock = new BacktestOrderClient(contractDirectory);
    (OrderClient as any).instance = mock;

    // Force `right` (config.yml's `right: none` can't be resolved from CSV
    // data - see file header comment) and `enabled` (config.yml's `false` is
    // a live-trading safety default, not a strategy parameter - a disabled
    // strategy trivially produces zero trades, which isn't useful backtest
    // output). `spawnQuantityMode` is only overridden if --spawnQuantityMode
    // was passed; every other field is left exactly as config.yml has it.
    configService.config.strategies = (configService.config.strategies || []).map((s) =>
        s.type === 'ContinuousStrategy'
            ? { ...s, right: FORCED_RIGHT, enabled: true, ...(SPAWN_QUANTITY_MODE_OVERRIDE ? { spawnQuantityMode: SPAWN_QUANTITY_MODE_OVERRIDE } : {}) }
            : s
    );
    const resolvedCfg = configService.getStrategyConfig('ContinuousStrategy');
    console.error(
        `Config (right/enabled forced${SPAWN_QUANTITY_MODE_OVERRIDE ? ', spawnQuantityMode overridden' : ''} for this run, everything else from config.yml as-is): ` +
        `initialQuantity=${resolvedCfg.initialQuantity} slDistance=${resolvedCfg.slDistance} ` +
        `minPremium=${resolvedCfg.minPremium} allottedCapital=${resolvedCfg.allottedCapital} ` +
        `spawnQuantityMode=${resolvedCfg.spawnQuantityMode} right=${resolvedCfg.right} enabled=${resolvedCfg.enabled}`
    );

    const strategy: any = new ContinuousStrategy('Backtest');

    let i = 0;
    let j = 0;
    while (i < niftyTicks.length || j < optionTicks.length) {
        const nTick = niftyTicks[i];
        const oTick = optionTicks[j];
        const useNifty = oTick === undefined || (nTick !== undefined && nTick.ltt <= oTick.ltt);

        if (useNifty) {
            mock.currentTime = nTick.ltt;
            const q = new NiftyQuote();
            q.ltp = nTick.ltp;
            q.token = 'NIFTY';
            q.ltt = nTick.ltt;
            await strategy.processNiftyQuote(q);
            i++;
        } else {
            mock.currentTime = oTick.ltt;
            const key = contractKey(oTick.strike, oTick.optionType);
            // ~12.5% of this CSV's rows have a literal "NaN" ltp (a gap in the
            // historical dump, confirmed by direct inspection) - skip updating
            // the last-known-price map on those so it keeps the last valid
            // price instead of being corrupted. A NaN tick is otherwise inert
            // for a currently-open leg anyway, since every target/adverse-level
            // comparison against NaN is false.
            if (!Number.isNaN(oTick.ltp)) mock.latestPrice.set(key, oTick.ltp);
            const contract = contractDirectory.get(key)!;

            // Check pending root-refill limit orders for this contract before
            // dispatching the tick to the strategy - mirrors the real
            // pendingLimitOrders.ts poller finding a fill and calling
            // strategy.updateTrade, which happens independently of whether
            // the strategy currently "holds" (and thus can handle) the token.
            const pending = mock.pendingLimitOrders.get(contract.token);
            if (pending && oTick.ltp <= pending.limitPrice) {
                mock.pendingLimitOrders.delete(contract.token);
                const right = contract.optionType === 'CE' ? CALL : PUT;
                mock.openLeg(contract.token, pending.tsym, right, pending.quantity, oTick.ltp);
                const fillTrade = new Trade();
                fillTrade.tsym = pending.tsym;
                fillTrade.token = contract.token;
                fillTrade.quantity = pending.quantity;
                fillTrade.price = oTick.ltp;
                fillTrade.lastTradePrice = oTick.ltp;
                fillTrade.action = 'Buy';
                fillTrade.status = 'COMPLETE';
                fillTrade.user = pending.userId;
                await strategy.updateTrade(fillTrade);
            }

            const oq = new OptionQuote();
            oq.ltp = oTick.ltp;
            oq.token = contract.token;
            oq.ltt = oTick.ltt;
            if (strategy.canHandleOptionQuote(oq)) {
                await strategy.processOptionQuote(oq);
            }
            j++;
        }
    }

    // --- report ---

    const label = new Date(niftyTicks[0].ltt).toISOString().slice(0, 10);
    const dayStart = Math.min(niftyTicks[0].ltt, optionTicks[0].ltt);
    const dayEnd = Math.max(niftyTicks[niftyTicks.length - 1].ltt, optionTicks[optionTicks.length - 1].ltt);

    console.log(`\n=== ContinuousStrategy Backtest: ${label} ===`);
    console.log(`Time range: ${fmtTime(dayStart)} - ${fmtTime(dayEnd)}`);
    console.log(`NIFTY ticks: ${niftyTicks.length}, option ticks: ${optionTicks.length}, contracts: ${contractDirectory.size}`);

    console.log(`\n${'#'.padStart(3)}  ${'tsym'.padEnd(20)}  ${'right'.padStart(5)}  ${'entryTime'.padStart(9)}  ${'entry'.padStart(8)}  ${'exitTime'.padStart(9)}  ${'exit'.padStart(8)}  ${'qty'.padStart(5)}  ${'pnl'.padStart(10)}`);
    console.log('-'.repeat(95));
    mock.closedTrades.forEach((t, idx) => {
        console.log(
            `${String(idx + 1).padStart(3)}  ${t.tsym.padEnd(20)}  ${t.right.padStart(5)}  ${fmtTime(t.entryTime).padStart(9)}  ${round2(t.entryPrice).toFixed(2).padStart(8)}  ${fmtTime(t.exitTime).padStart(9)}  ${round2(t.exitPrice).toFixed(2).padStart(8)}  ${String(t.quantity).padStart(5)}  ${round2(t.pnl).toFixed(2).padStart(10)}`
        );
    });
    if (mock.closedTrades.length === 0) {
        console.log('(no closed trades)');
    }

    const openLegs: any[] = Array.from((strategy.legsByToken as Map<string, any>).values());
    if (openLegs.length > 0) {
        console.log('\n--- open at EOD (unrealized) ---');
        openLegs.forEach((leg) => {
            const key = contractKey(leg.strike, leg.right === CALL ? 'CE' : 'PE');
            const markPrice = mock.latestPrice.get(key);
            const unrealized = markPrice != null ? (markPrice - leg.entryPrice) * leg.quantity : null;
            console.log(`  ${leg.tsym} qty=${leg.quantity} entry=${round2(leg.entryPrice)} mark=${markPrice != null ? round2(markPrice) : 'n/a'} unrealized=${unrealized != null ? round2(unrealized) : 'n/a'} (${leg.isRoot ? 'root' : 'nested'})`);
        });
    }
    if (mock.pendingLimitOrders.size > 0) {
        console.log('\n--- unfilled root refill limit orders at EOD ---');
        mock.pendingLimitOrders.forEach((p) => console.log(`  ${p.tsym} qty=${p.quantity} limitPrice=${p.limitPrice}`));
    }

    const totalClosedPnL = mock.closedTrades.reduce((s, t) => s + t.pnl, 0);
    const stats = strategy.getStats();

    console.log('\n--- summary ---');
    console.log(`closed trades:                  ${mock.closedTrades.length}`);
    console.log(`open at EOD:                    ${openLegs.length}`);
    console.log(`unfilled refill orders at EOD:  ${mock.pendingLimitOrders.size}`);
    console.log(`wins:                           ${stats.wins}`);
    console.log(`losses:                         ${stats.losses}`);
    console.log(`win rate:                       ${stats.winRate != null ? stats.winRate + '%' : 'n/a'}`);
    console.log(`total P&L (strategy.getStats):  ${stats.totalPnL}`);
    console.log(`total P&L (ledger cross-check):  ${round2(totalClosedPnL)}`);

    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
