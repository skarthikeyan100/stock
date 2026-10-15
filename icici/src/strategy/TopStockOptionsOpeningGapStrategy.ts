import Log from '../util/Log';
import { MOCK_BROKER } from '../constants';
import { NiftyQuote, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import AntContractMaster from '../ant/AntContractMaster';
import ANT from '../ant/ANT';
import { enterPosition } from '../processes/order/antExecutor';
import { Strategy } from './strategy';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import moment from 'moment';

// Anchored to process.cwd() (always the repo root for every entry point
// that runs this strategy), NOT __dirname - same reasoning as
// GapScreenerGenerate.ts/GapScreenerOptionQuote.ts: __dirname in compiled
// code is dist/strategy/, which would miss the real CSV written alongside
// the gapscreener TS sources.
const GAP_SCREENER_CSV = path.join(process.cwd(), 'src', 'tools', 'gapscreener', 'gap-screener.csv');

// gapscreener-morning.sh (crontab) runs at 10:05 IST on trading days and
// overwrites gap-screener.csv around then - this strategy must not read it
// before that, and should give the cron job a few minutes' margin against a
// slow screener run before firing. Closes at 10:35, well before
// BulkPcrAutoStartStrategy's own 10:35 slot, to avoid colliding with it.
const TRADING_WINDOW_START = { hour: 10, minute: 10 };
const TRADING_WINDOW_END = { hour: 10, minute: 35 };

interface RankedStock {
    symbol: string;
    gapPct: number;
    latestOpen: number;
}

export default class TopStockOptionsOpeningGapStrategy extends Strategy {
    private phase: 'idle' | 'running' | 'done' = 'idle';

    // In-memory `phase` alone only prevents re-firing within one process
    // lifetime - a dev-mode hot restart (tsc-watch) or any crash/restart
    // landing inside the trading window would reset phase to 'idle' and
    // re-enter all legs a second time for the same day (the exact failure
    // class BulkPcrAutoStartStrategy hit live on 2026-10-14 for its own
    // once-per-slot-per-day firing). Persist "already ran today" to disk so
    // a restart can't re-trigger it. Namespaced by userId - config.yml can
    // configure multiple instances of this strategy (distinct userId, e.g.
    // separate broker accounts), and they must not share one fired-today
    // flag or the second instance would silently never trade.
    private firedTodayFile = path.join(__dirname, `../../.topStockOptionsOpeningGap_firedToday.${this.safeFileToken(this.userId)}.json`);

    private safeFileToken(s: string): string {
        return s.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    private hasFiredToday(): boolean {
        try {
            const recorded = JSON.parse(fs.readFileSync(this.firedTodayFile, 'utf8')) as string;
            return recorded === moment().format('YYYY-MM-DD');
        } catch {
            return false;
        }
    }

    // Returns false if the record could not be written. The caller must then not execute -
    // executing without the record would let a restart re-execute this same day.
    private recordFiredToday(): boolean {
        try {
            fs.writeFileSync(this.firedTodayFile, JSON.stringify(moment().format('YYYY-MM-DD')));
            return true;
        } catch (e: any) {
            Log.log(`[${this.userId}] ALERT: could not persist firedToday record - NOT executing: ${e?.message ?? e}`);
            return false;
        }
    }

    receive(oldStats, newStats) {
        // no-op, same as BulkPcrStrategy
    }

    isTimeInRange(): boolean {
        if (MOCK_BROKER) return true;
        const now = moment();
        const start = moment().hour(TRADING_WINDOW_START.hour).minute(TRADING_WINDOW_START.minute).second(0);
        const end = moment().hour(TRADING_WINDOW_END.hour).minute(TRADING_WINDOW_END.minute).second(0);
        return now.isAfter(start) && now.isBefore(end);
    }

    async processNiftyQuote(quote: NiftyQuote) {
        if (!this.enabled) return;
        if (this.phase !== 'idle') return;
        if (!this.isTimeInRange()) return;
        if (this.hasFiredToday()) {
            // Already ran earlier today in a prior process lifetime - mark done
            // in-memory too so this check isn't repeated on every tick.
            this.phase = 'done';
            return;
        }
        this.phase = 'running'; // set synchronously before any async work, so concurrent ticks can't double-fire
        try {
            await this.executeTrade();
        } catch (e: any) {
            // Never let a failure here (e.g. csv-parse throwing on a gap-screener.csv
            // mid-write by the 10:05 cron job) escape processNiftyQuote - the caller
            // (strategiesProcess.ts) has no per-strategy try/catch around this call,
            // so an uncaught throw here would skip every strategy later in its list
            // for this one tick.
            Log.log(`[${this.userId}] executeTrade failed: ${e?.message ?? e}`);
        } finally {
            this.phase = 'done';
        }
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false; // exit delegated to ANT's broker-side bracket order
    }

    processOptionQuote(quote: OptionQuote) {
        // no-op (see canHandleOptionQuote)
    }

    getMonitorConfig() {
        return null; // exit handled per-leg inside enterPosition's bracket order
    }

    reset(): void {
        this.phase = 'idle';
        Log.log(`[${this.userId}] Reset via admin request`);
    }

    private async executeTrade() {
        const config = configService.getStrategyConfig('TopStockOptionsOpeningGapStrategy');
        const rankStart: number = config.rankStart ?? 3;
        const rankCount: number = config.rankCount ?? 5;
        const slPercent: number = config.slPercent ?? 30;
        const targetPercent: number = config.targetPercent ?? 50;
        const lots: number = config.lots ?? 1;
        const logEnabled: boolean = config.logEnabled ?? true;

        if (!fs.existsSync(GAP_SCREENER_CSV)) {
            Log.log(`[${this.userId}] gap-screener.csv not found at ${GAP_SCREENER_CSV}, skipping`);
            return;
        }
        const mtime = fs.statSync(GAP_SCREENER_CSV).mtime;
        const today = new Date().toISOString().slice(0, 10);
        if (mtime.toISOString().slice(0, 10) !== today) {
            Log.log(`[${this.userId}] gap-screener.csv is stale (mtime ${mtime.toISOString()}), skipping`);
            return;
        }

        const content = fs.readFileSync(GAP_SCREENER_CSV, 'utf8');
        const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];

        const ranked: RankedStock[] = rows
            .map(r => ({ symbol: (r['Symbol'] || '').trim().toUpperCase(), gapPct: parseFloat(r['Gap %']), latestOpen: parseFloat(r['Latest Open']) }))
            .filter(r => r.symbol && !isNaN(r.gapPct) && !isNaN(r.latestOpen))
            .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));

        if (rankStart < 1 || rankCount < 1) {
            Log.log(`[${this.userId}] invalid rankStart=${rankStart}/rankCount=${rankCount}, skipping`);
            return;
        }
        const selected = ranked.slice(rankStart - 1, rankStart - 1 + rankCount);
        if (selected.length === 0) {
            Log.log(`[${this.userId}] no stocks in rank window ${rankStart}-${rankStart + rankCount - 1} (${ranked.length} ranked rows), skipping`);
            return;
        }

        if (logEnabled) {
            Log.log(`[${this.userId}] selected ${selected.length} stock(s) for ranks ${rankStart}-${rankStart + rankCount - 1}: ` +
                selected.map(s => `${s.symbol}(${s.gapPct}%)`).join(', '));
        }

        // Recorded only now - after every skip-worthy condition above (missing/
        // stale CSV, empty rank window) has already passed - not at the top of
        // processNiftyQuote. The 10:10-10:35 window exists specifically to
        // tolerate a late cron run; recording "fired" before a stale-CSV skip
        // would burn that retry margin on a day the screener just ran a few
        // minutes late, permanently blocking every later tick even once the
        // CSV becomes fresh. There is no async gap between here and the actual
        // order attempts below, so this still fully guards against a restart
        // re-entering the same legs.
        if (!this.recordFiredToday()) return; // ALERT already logged inside recordFiredToday

        // Each leg isolated via allSettled, same as BulkPcrStrategy's multi-leg
        // entry - one stock's contract-resolution/order failure must not abort
        // the others.
        const results = await Promise.allSettled(
            selected.map(stock => this.enterLeg(stock, slPercent, targetPercent, lots, logEnabled))
        );
        const failures = results.filter(r => r.status === 'rejected').length;
        if (failures > 0) {
            Log.log(`[${this.userId}] ${failures}/${selected.length} leg(s) failed to enter - see individual leg logs above`);
        }
    }

    private async enterLeg(
        stock: RankedStock,
        slPercent: number,
        targetPercent: number,
        lots: number,
        logEnabled: boolean
    ) {
        try {
            // optionType must be the raw 'CE'/'PE' strings used by the contract
            // master's own 'Option Type' field - NOT the CALL/PUT ('call'/'put')
            // constants from constants.ts, which are a different, sentiment-
            // check-only vocabulary.
            //
            // Deliberately using findNearestStrikeOption, not findATMOption:
            // the latter's strike-rounding step (STRIKE_STEP) only has entries
            // for NIFTY/SENSEX and falls back to a flat 50 for every other
            // symbol, which practically never matches a real listed strike
            // for an individual stock (strike increments vary wildly by price
            // band - e.g. 2.5/5/10/20/50/100).
            const optionType: 'CE' | 'PE' = stock.gapPct > 0 ? 'CE' : 'PE';
            const contract = AntContractMaster.getInstance().findNearestStrikeOption(stock.symbol, optionType, stock.latestOpen);
            const ltp = await ANT.getInstance().getQuote(contract.exch, contract.token);
            if (!ltp || ltp <= 0) {
                throw new Error(`invalid LTP ${ltp} for ${contract.tradingSymbol}`);
            }
            const stopLossPoints = ltp * (slPercent / 100);
            const targetPoints = ltp * (targetPercent / 100);
            const lotSize = parseInt(contract.lotSize, 10);
            if (!lotSize || lotSize <= 0) {
                throw new Error(`invalid lotSize ${contract.lotSize} for ${contract.tradingSymbol}`);
            }
            const quantity = lotSize * lots;

            if (logEnabled) {
                Log.log(`[${this.userId}] ${stock.symbol} gap=${stock.gapPct}% dir=${optionType} ` +
                    `contract=${contract.tradingSymbol} ltp=${ltp} qty=${quantity} sl=${stopLossPoints.toFixed(2)} target=${targetPoints.toFixed(2)}`);
            }

            await enterPosition(
                this.userId,
                contract.tradingSymbol,
                contract.token,
                quantity,
                contract.exch as 'NFO' | 'BFO',
                targetPoints,
                stopLossPoints,
                'bracket',
                { ltp, atMs: Date.now() }
            );
        } catch (e) {
            Log.log(`[${this.userId}] ${stock.symbol} leg failed: ${e?.message ?? e}`);
            throw e;
        }
    }

}
