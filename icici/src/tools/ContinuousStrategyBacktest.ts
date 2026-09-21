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
 * Usage (single day):
 *   tsc && MOCK_BROKER=true node ./dist/tools/ContinuousStrategyBacktest.js \
 *     --niftyFile /path/to/Quote.csv --optionFile /path/to/OptionQuote.csv \
 *     [--spawnQuantityMode <number, e.g. 2>] [--averageQuantityMode same|multiplied]
 *
 * Usage (every day at once):
 *   tsc && MOCK_BROKER=true node ./dist/tools/ContinuousStrategyBacktest.js \
 *     --allDays /path/to/backups [--verbose] \
 *     [--spawnQuantityMode <number, e.g. 2>] [--averageQuantityMode same|multiplied]
 *
 * --allDays scans <baseDir>/<day>/csv/Quote.csv + OptionQuote.csv for every
 * subfolder of baseDir (matching this repo's work/data/backups/<Mon-DD>/csv/
 * layout), skipping any day missing either file, and runs a fresh backtest
 * (a brand-new ContinuousStrategy instance and mock broker per day - no
 * state carries over) for each one it finds. Prints a compact one-line
 * summary per day plus an aggregate totals row, instead of every day's full
 * detailed report - pass --verbose to also print the full per-day report
 * (the same one single-day mode always prints).
 *
 * Every field in config.yml's `continuousStrategy` block is used as-is except
 * `right` (always forced, see above) and `enabled` (always forced true - a
 * disabled strategy trivially produces zero trades). `--spawnQuantityMode`
 * optionally overrides the hedge-spawn flat quantity multiplier (a positive
 * number, e.g. 2 = double the causing leg's own totalQuantity at every
 * adverse level 1-4 - see LegManager.ts's trySpawnLevel) for the
 * whole run (every day, in --allDays mode). `--averageQuantityMode`
 * independently overrides the separate 'same'/'multiplied' loss-averaging
 * toggle (unaffected by this change) - the two flags can be varied
 * independently to compare hedge-sizing and loss-averaging strategies
 * without editing config.yml.
 */
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import ContinuousStrategy from '../strategy/ContinuousStrategy';
import { CALL, PUT } from '../constants';
import {
    getArg, getFlag, DEFAULT_ALL_DAYS_DIR, loadNiftyTicks, loadNiftyOptionTicks,
    buildContractDirectory, contractKey, fmtTime, round2, discoverDayFolders,
    BacktestOrderClient,
} from './backtestCsvUtils';

const FORCED_RIGHT: 'call' | 'put' = 'call';

const SPAWN_QUANTITY_MODE_OVERRIDE = getArg('spawnQuantityMode', '');
const AVERAGE_QUANTITY_MODE_OVERRIDE = getArg('averageQuantityMode', '');

const NIFTY_FILE = getArg('niftyFile', '');
const OPTION_FILE = getArg('optionFile', '');
const ALL_DAYS_DIR = getArg('allDays', (NIFTY_FILE || OPTION_FILE) ? '' : DEFAULT_ALL_DAYS_DIR);
const VERBOSE = getFlag('verbose');

// Force `right` (config.yml's `right: none` can't be resolved from CSV data -
// see file header comment) and `enabled` (config.yml's `false` is a
// live-trading safety default, not a strategy parameter - a disabled
// strategy trivially produces zero trades, which isn't useful backtest
// output). `spawnQuantityMode`/`averageQuantityMode` are only overridden if
// the matching CLI flag was passed; every other field is left exactly as
// config.yml has it. Applies globally to every day run in this process
// (single day or --allDays), so this only needs to run once.
function setupConfig(): void {
    configService.config.strategies = (configService.config.strategies || []).map((s) =>
        s.type === 'ContinuousStrategy'
            ? {
                ...s, right: FORCED_RIGHT, enabled: true,
                ...(SPAWN_QUANTITY_MODE_OVERRIDE ? { spawnQuantityMode: Number(SPAWN_QUANTITY_MODE_OVERRIDE) } : {}),
                ...(AVERAGE_QUANTITY_MODE_OVERRIDE ? { averageQuantityMode: AVERAGE_QUANTITY_MODE_OVERRIDE } : {}),
            }
            : s
    );
    const resolvedCfg = configService.getStrategyConfig('ContinuousStrategy');
    console.error(
        `Config (right/enabled forced${SPAWN_QUANTITY_MODE_OVERRIDE ? ', spawnQuantityMode overridden' : ''}` +
        `${AVERAGE_QUANTITY_MODE_OVERRIDE ? ', averageQuantityMode overridden' : ''}, everything else from config.yml as-is): ` +
        `initialQuantity=${resolvedCfg.initialQuantity} slDistance=${resolvedCfg.slDistance} ` +
        `minPremium=${resolvedCfg.minPremium} maxInvestment=${resolvedCfg.maxInvestment} ` +
        `spawnQuantityMode=${resolvedCfg.spawnQuantityMode} averageQuantityMode=${resolvedCfg.averageQuantityMode} ` +
        `right=${resolvedCfg.right} enabled=${resolvedCfg.enabled} maxProfit=${resolvedCfg.maxProfit}`
    );
}

interface DaySummary {
    day: string;
    niftyTicks: number;
    optionTicks: number;
    closedTrades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    totalPnL: number;
    openAtEOD: number;
    unfilledRefills: number;
    maxProfitTripped: boolean;
}

async function runBacktestForDay(niftyFile: string, optionFile: string, dayLabel: string, verbose: boolean): Promise<DaySummary> {
    const niftyTicks = loadNiftyTicks(niftyFile);
    const optionTicks = loadNiftyOptionTicks(optionFile);
    console.error(`[${dayLabel}] Loaded ${niftyTicks.length} NIFTY ticks, ${optionTicks.length} NIFTY option ticks`);
    if (niftyTicks.length === 0 || optionTicks.length === 0) {
        console.error(`[${dayLabel}] No ticks loaded - skipping`);
        return { day: dayLabel, niftyTicks: niftyTicks.length, optionTicks: optionTicks.length, closedTrades: 0, wins: 0, losses: 0, winRate: null, totalPnL: 0, openAtEOD: 0, unfilledRefills: 0, maxProfitTripped: false };
    }

    const contractDirectory = buildContractDirectory(optionTicks);
    console.error(`[${dayLabel}] Contract directory: ${contractDirectory.size} contracts`);

    const mock = new BacktestOrderClient(contractDirectory, FORCED_RIGHT);
    (OrderClient as any).instance = mock;

    const strategy: any = new ContinuousStrategy('Backtest');
    // Strategy.enabled (src/strategy/strategy.ts) defaults to false and is normally
    // synced by StrategyFactory in production (see continuousStrategyTest.ts's
    // newStrategy() helper, which bypasses it the same way) - without this the T1
    // gate silently blocks every tick and the backtest produces zero trades.
    strategy.enabled = true;

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

    // --- report (full detail only when verbose - always computed either way) ---

    const openLegs: any[] = Array.from((strategy.legManager.getLegsByToken() as Map<string, any>).values());
    const totalClosedPnL = mock.closedTrades.reduce((s, t) => s + t.pnl, 0);
    const stats = strategy.getStats();
    const maxProfitTripped: boolean = strategy.legManager.isMaxProfitTripped();

    if (verbose) {
        const dayStart = Math.min(niftyTicks[0].ltt, optionTicks[0].ltt);
        const dayEnd = Math.max(niftyTicks[niftyTicks.length - 1].ltt, optionTicks[optionTicks.length - 1].ltt);
        // Prefer the date derived from the ticks themselves for the header (matches
        // this tool's original single-day behavior) - dayLabel alone is "single-day"
        // for a direct --niftyFile/--optionFile run, not a real date.
        const isoDate = new Date(niftyTicks[0].ltt).toISOString().slice(0, 10);
        const headerLabel = dayLabel === 'single-day' ? isoDate : `${dayLabel} (${isoDate})`;

        console.log(`\n=== ContinuousStrategy Backtest: ${headerLabel} ===`);
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

        if (openLegs.length > 0) {
            console.log('\n--- open at EOD (unrealized) ---');
            openLegs.forEach((leg) => {
                const key = contractKey(leg.strike, leg.right === CALL ? 'CE' : 'PE');
                const markPrice = mock.latestPrice.get(key);
                // totalQuantity/avgPrice - not quantity/entryPrice - reflect this leg's true
                // held size/cost basis if it has been averaged (see LegManager.ts).
                const unrealized = markPrice != null ? (markPrice - leg.avgPrice) * leg.totalQuantity : null;
                console.log(`  ${leg.tsym} qty=${leg.totalQuantity} avg=${round2(leg.avgPrice)} mark=${markPrice != null ? round2(markPrice) : 'n/a'} unrealized=${unrealized != null ? round2(unrealized) : 'n/a'} (${leg.isRoot ? 'root' : 'nested'}${leg.averagedLevels.size > 0 ? `, averaged x${leg.averagedLevels.size}` : ''})`);
            });
        }
        if (mock.pendingLimitOrders.size > 0) {
            console.log('\n--- unfilled root refill limit orders at EOD ---');
            mock.pendingLimitOrders.forEach((p) => console.log(`  ${p.tsym} qty=${p.quantity} limitPrice=${p.limitPrice}`));
        }

        console.log('\n--- summary ---');
        console.log(`closed trades:                  ${mock.closedTrades.length}`);
        console.log(`open at EOD:                    ${openLegs.length}`);
        console.log(`unfilled refill orders at EOD:  ${mock.pendingLimitOrders.size}`);
        console.log(`wins:                           ${stats.wins}`);
        console.log(`losses:                         ${stats.losses}`);
        console.log(`win rate:                       ${stats.winRate != null ? stats.winRate + '%' : 'n/a'}`);
        console.log(`total P&L (strategy.getStats):  ${stats.totalPnL}`);
        console.log(`total P&L (ledger cross-check):  ${round2(totalClosedPnL)}`);
        console.log(`maxProfit tripped:              ${maxProfitTripped}`);
    }

    return {
        day: dayLabel,
        niftyTicks: niftyTicks.length,
        optionTicks: optionTicks.length,
        closedTrades: mock.closedTrades.length,
        wins: stats.wins,
        losses: stats.losses,
        winRate: stats.winRate,
        totalPnL: round2(totalClosedPnL),
        openAtEOD: openLegs.length,
        unfilledRefills: mock.pendingLimitOrders.size,
        maxProfitTripped,
    };
}

function printAggregateSummary(summaries: DaySummary[]): void {
    console.log(`\n=== ContinuousStrategy Backtest: all days (${summaries.length}) ===\n`);
    console.log(`${'day'.padEnd(10)}  ${'niftyTk'.padStart(8)}  ${'optTk'.padStart(8)}  ${'trades'.padStart(6)}  ${'wins'.padStart(5)}  ${'losses'.padStart(6)}  ${'winRate'.padStart(8)}  ${'totalPnL'.padStart(12)}  ${'openEOD'.padStart(7)}  ${'maxProfit'.padStart(9)}`);
    console.log('-'.repeat(102));
    for (const s of summaries) {
        const winRateStr = s.winRate != null ? s.winRate + '%' : 'n/a';
        console.log(
            `${s.day.padEnd(10)}  ${String(s.niftyTicks).padStart(8)}  ${String(s.optionTicks).padStart(8)}  ${String(s.closedTrades).padStart(6)}  ${String(s.wins).padStart(5)}  ${String(s.losses).padStart(6)}  ${winRateStr.padStart(8)}  ${s.totalPnL.toFixed(2).padStart(12)}  ${String(s.openAtEOD).padStart(7)}  ${(s.maxProfitTripped ? 'YES' : '-').padStart(9)}`
        );
    }
    console.log('-'.repeat(102));

    const totalTrades = summaries.reduce((sum, s) => sum + s.closedTrades, 0);
    const totalWins = summaries.reduce((sum, s) => sum + s.wins, 0);
    const totalLosses = summaries.reduce((sum, s) => sum + s.losses, 0);
    const totalPnL = round2(summaries.reduce((sum, s) => sum + s.totalPnL, 0));
    const totalOpenEOD = summaries.reduce((sum, s) => sum + s.openAtEOD, 0);
    const daysMaxProfitTripped = summaries.filter((s) => s.maxProfitTripped).length;
    const decided = totalWins + totalLosses;
    const aggregateWinRate = decided > 0 ? round2((totalWins / decided) * 100) : null;

    console.log(
        `${'TOTAL'.padEnd(10)}  ${' '.repeat(8)}  ${' '.repeat(8)}  ${String(totalTrades).padStart(6)}  ${String(totalWins).padStart(5)}  ${String(totalLosses).padStart(6)}  ${(aggregateWinRate != null ? aggregateWinRate + '%' : 'n/a').padStart(8)}  ${totalPnL.toFixed(2).padStart(12)}  ${String(totalOpenEOD).padStart(7)}  ${String(daysMaxProfitTripped).padStart(9)}`
    );

    console.log('\n--- aggregate summary ---');
    console.log(`days run:             ${summaries.length}`);
    console.log(`total closed trades:  ${totalTrades}`);
    console.log(`total wins:           ${totalWins}`);
    console.log(`total losses:         ${totalLosses}`);
    console.log(`aggregate win rate:   ${aggregateWinRate != null ? aggregateWinRate + '%' : 'n/a'}`);
    console.log(`aggregate total P&L:  ${totalPnL}`);
    console.log(`total open at EOD:    ${totalOpenEOD} (across all days - each day's open legs are separate, not carried into the next day)`);
    console.log(`days maxProfit tripped: ${daysMaxProfitTripped} / ${summaries.length}`);
}

async function main() {
    if (!ALL_DAYS_DIR && (!NIFTY_FILE || !OPTION_FILE)) {
        console.error(
            'Usage:\n' +
            '  Single day: node ./dist/tools/ContinuousStrategyBacktest.js --niftyFile <Quote.csv> --optionFile <OptionQuote.csv>\n' +
            '  All days:   node ./dist/tools/ContinuousStrategyBacktest.js --allDays <baseDir> [--verbose]'
        );
        process.exit(1);
    }

    setupConfig();

    if (ALL_DAYS_DIR) {
        const days = discoverDayFolders(ALL_DAYS_DIR);
        console.error(`Found ${days.length} day(s) with both Quote.csv and OptionQuote.csv under ${ALL_DAYS_DIR}`);
        if (days.length === 0) {
            console.error('No valid day folders found - aborting');
            process.exit(1);
        }
        const summaries: DaySummary[] = [];
        for (const d of days) {
            summaries.push(await runBacktestForDay(d.niftyFile, d.optionFile, d.day, VERBOSE));
        }
        printAggregateSummary(summaries);
    } else {
        await runBacktestForDay(NIFTY_FILE, OPTION_FILE, 'single-day', true);
    }

    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
