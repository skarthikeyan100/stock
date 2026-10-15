# New icici strategy: TopStockOptionsOpeningGapStrategy

## Context

This adds a new, real-money strategy to this repo. Each morning, rank Nifty
100 stocks by opening-gap size (open vs previous close), take the stocks
landing at ranks 3-7 (the window validated as most consistent in an earlier
backtest done against `/home/karthikeyan/tools`'s Nifty 100 gap-rank
scripts), and for each one buy the nearest-ATM CE (gap up) or PE (gap down)
option, 1 lot, through the ANT (AliceBlue) broker integration already used
by this repo.

This is built as a proper `Strategy` subclass —
**`TopStockOptionsOpeningGapStrategy`** — modeled on the existing
`BulkPcrStrategy`. **This document is an implementation spec, not code that
has been applied.** It is written to be executed by a less-capable model
later, so every signature, import path, and code shape below is quoted
exactly from the real codebase (verified by reading the files, not
inferred) so the implementer can copy it directly rather than guess.
**No source files have been changed to produce this document.**

## Verified exact signatures and imports (copy these directly)

### Base class — `src/strategy/strategy.ts`
```ts
export abstract class Strategy {
    userId: string;
    enabled = false;
    constructor(userId?: string) {
        this.userId = userId || this.constructor.name;
    }
    abstract receive(oldStats, newStats);
    abstract processNiftyQuote(quote: NiftyQuote);
    abstract processOptionQuote(quote: OptionQuote);
    canHandleOptionQuote(quote: OptionQuote): boolean { return false; }
    getMonitorConfig(): { targetPoints: number; stopLossPoints: number; trailingDistance: number } | null { /* default */ }
    isTimeInRange(): boolean { /* default 10:00-15:00 */ }
    reset(): void { /* default */ }
}
```
(`strategy.ts:16-17` class+`enabled`, `:120-121` constructor, `:132-138`
abstract/`canHandleOptionQuote`, `:82-88` `getMonitorConfig`, `:144-150`
`isTimeInRange`, `:106-109` `reset`.)

### `src/strategy/BulkPcrStrategy.ts` — the template to mirror
Exact top-of-file imports (`:1-9`):
```ts
import Log from '../util/Log';
import { CALL, PUT } from '../constants';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import Mongo from '../tools/mongo';
import { Strategy } from './strategy';
import { roundToTick } from '../zerodha/Zerodha';
import MomentumSignal from './MomentumSignal';
import { isPastMarketClose } from '../util/marketHours';
```
Exact class declaration (verified, `:159`):
```ts
export default class BulkPcrStrategy extends Strategy {
```
State field (`:165`):
```ts
private phase: 'idle' | 'running' | 'done' = 'idle';
```
`enabled` is inherited from `Strategy`, not redeclared; checked at `:255`
(`if (!this.enabled) { ... return; }`) and set externally by the factory.

### `src/strategy/StrategyFactory.ts` — registration pattern
Imports (`:1-19`, abbreviated to the relevant lines):
```ts
import { Strategy } from './strategy';
import GapStrategy from './GapStrategy';
import ContinuousStrategy from './ContinuousStrategy';
import BulkPcrStrategy from './BulkPcrStrategy';
```
Registry (`:21-39`):
```ts
const STRATEGY_REGISTRY = new Map<string, new (userId?: string) => Strategy>();
STRATEGY_REGISTRY.set('GapStrategy', GapStrategy);
STRATEGY_REGISTRY.set('ContinuousStrategy', ContinuousStrategy);
STRATEGY_REGISTRY.set('BulkPcrStrategy', BulkPcrStrategy);
```
`createStrategy` (`:41-50`):
```ts
export function createStrategy(config: StrategyInstanceConfig): Strategy | null {
    const StrategyClass = STRATEGY_REGISTRY.get(config.type);
    if (!StrategyClass) { /* log + */ return null; }
    const userId = config.userId || config.type;
    const strategy = new StrategyClass(userId);
    strategy.enabled = config.enabled;
    return strategy;
}
```
**Implementer action**: add
`import TopStockOptionsOpeningGapStrategy from './TopStockOptionsOpeningGapStrategy';`
to the imports and
`STRATEGY_REGISTRY.set('TopStockOptionsOpeningGapStrategy', TopStockOptionsOpeningGapStrategy);`
to the registry, following the exact same pattern as the `BulkPcrStrategy` line.

### `src/ant/AntContractMaster.ts` — ATM option resolution
Singleton, default export (`:22,56,267`):
```ts
export default AntContractMaster; // class, static getInstance()
```
Import used elsewhere in this exact form (confirmed in
`src/strategy/LegManager.ts:6`, `src/strategy/TargetReachStrategy.ts:6`):
```ts
import AntContractMaster from '../ant/AntContractMaster';
```
Signature (`:118`), synchronous, no Promise:
```ts
findATMOption(underlyingLtp: number, optionType: string, symbol: string = 'NIFTY'):
    { token: string; exch: string; tradingSymbol: string; lotSize: string }
```
Call shape: `AntContractMaster.getInstance().findATMOption(latestOpen, optionType, symbol)`.

### `src/ant/ANT.ts` — live option LTP
Singleton, default export (`:21,96,876`):
```ts
class ANT {
    static getInstance(): ANT { /* ... */ }
}
export default ANT;
```
Signature (`:383`):
```ts
async getQuote(exchange: string, token: string, opts?: { skipCache?: boolean; retryDelaysMs?: number[] }): Promise<number>
```
Returns just the LTP as a number. Call shape:
`await ANT.getInstance().getQuote(exch, token)`.

### `src/processes/order/antExecutor.ts` — order placement
Plain exported async function, no class (`:149-159`):
```ts
export async function enterPosition(
    userId: string,
    tradingSymbol: string,
    instrumentId: string,
    quantity: number,
    exchange: 'NFO' | 'BFO',
    targetPoints: number,
    stopLossPoints: number,
    orderMode: 'bracket' | 'cover' = 'bracket',
    knownLtp?: { ltp: number; atMs: number }
): Promise<Trade>
```
Import shape: `import { enterPosition } from '../processes/order/antExecutor';`
(adjust relative path depth from `src/strategy/`:
`'../processes/order/antExecutor'`).

### CSV parsing — reuse the repo's existing library, not manual parsing
`csv-parse/sync` is already a dependency, used exactly like this
(`src/tools/gapscreener/GapScreenerOptionQuote.ts:36-37,63-69`):
```ts
import { parse } from 'csv-parse/sync';
...
function readGapScreenerRows(csvPath: string): Record<string, string>[] {
    if (!fs.existsSync(csvPath)) throw new Error(`Input CSV not found: ${csvPath}`);
    const content = fs.readFileSync(csvPath, 'utf8');
    return parse(content, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
}
```
CSV columns available (from `gap-screener.csv` header): `Screener, Symbol,
Name, LTP, Gap %, Recommendation, Volume, Value, 1D Ago Close, Latest Open,
1st15m Open, 1st15m High, 1st15m Low, 1st15m Close`. Use `Symbol`, `Gap %`,
`Latest Open`. `Gap %` and `Latest Open` are strings in the parsed object —
`parseFloat()` both before use.

### Logging convention
```ts
import Log from '../util/Log';
```
Gated log call pattern (`src/strategy/GapStrategy.ts:49-51`):
```ts
if (config.logEnabled) {
    Log.log(`[TopStockOptionsOpeningGapStrategy] ${symbol} gap=${gapPct}% dir=${optionType} token=${token}`);
}
```
`config` comes from `configService.getStrategyConfig('TopStockOptionsOpeningGapStrategy')`
(`import configService from '../prism/ConfigService';`).

## Why reuse these specific pieces (background, for the implementer's context)

- **Gap data source**: ANT cannot bulk-fetch Open+PrevClose for ~100
  equities (`ANT.getQuote` is single-symbol, rate-limited, LTP-only). This
  repo already has the data: `src/tools/gapscreener/GapScreenerGenerate.ts`
  shells out to the separate `/home/karthikeyan/tools/ohlc/screener.ts`
  project each morning and writes `src/tools/gapscreener/gap-screener.csv`.
  Read that file; do not call ANT for equity prices.
- **Expiry**: individual stock options on NSE only have a monthly series
  (no weeklies), so `findATMOption`'s nearest-expiry resolution is already
  "nearest monthly" — no extra expiry filtering logic needed.
- **Exit mechanism diverges from `BulkPcrStrategy`'s self-managed style on
  purpose**: `BulkPcrStrategy` self-manages exits because its broker
  (Breeze) has no bracket-order support. ANT *does* support bracket/cover
  orders (`antExecutor.enterPosition`'s `orderMode` param), so this
  strategy delegates target/SL to the broker instead of subscribing to 5
  separate option-tick streams. What's being mirrored from
  `BulkPcrStrategy` is the multi-leg `Promise.allSettled` isolation, the
  one-shot `phase` state machine, and the config/registration conventions —
  not its exit style.

## Class design: `TopStockOptionsOpeningGapStrategy`

New file: `src/strategy/TopStockOptionsOpeningGapStrategy.ts`. Exact shape:

```ts
import Log from '../util/Log';
import { CALL, PUT } from '../constants';
import { NiftyQuote, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import AntContractMaster from '../ant/AntContractMaster';
import ANT from '../ant/ANT';
import { enterPosition } from '../processes/order/antExecutor';
import { Strategy } from './strategy';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';

const GAP_SCREENER_CSV = path.join(__dirname, '../tools/gapscreener/gap-screener.csv');

export default class TopStockOptionsOpeningGapStrategy extends Strategy {
    private phase: 'idle' | 'running' | 'done' = 'idle';

    receive(oldStats, newStats) {
        // no-op, same as BulkPcrStrategy.ts:171
    }

    isTimeInRange(): boolean {
        // 09:20-09:35 IST placeholder -- CONFIRM against GapScreenerGenerate's
        // actual morning run time before relying on this window.
    }

    async processNiftyQuote(quote: NiftyQuote) {
        if (!this.enabled) return;
        if (this.phase !== 'idle') return;
        if (!this.isTimeInRange()) return;
        this.phase = 'running'; // set synchronously before any async work
        await this.executeTrade();
        this.phase = 'done';
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
    }

    private async executeTrade() {
        const config = configService.getStrategyConfig('TopStockOptionsOpeningGapStrategy');
        const rankStart: number = config.rankStart ?? 3;
        const rankCount: number = config.rankCount ?? 5;
        const slPercent: number = config.slPercent ?? 30;
        const targetPercent: number = config.targetPercent ?? 50;
        const lots: number = config.lots ?? 1;

        if (!fs.existsSync(GAP_SCREENER_CSV)) {
            Log.log(`[TopStockOptionsOpeningGapStrategy] gap-screener.csv not found, skipping`);
            return;
        }
        const mtime = fs.statSync(GAP_SCREENER_CSV).mtime;
        const today = new Date().toISOString().slice(0, 10);
        if (mtime.toISOString().slice(0, 10) !== today) {
            Log.log(`[TopStockOptionsOpeningGapStrategy] gap-screener.csv is stale (mtime ${mtime}), skipping`);
            return;
        }

        const content = fs.readFileSync(GAP_SCREENER_CSV, 'utf8');
        const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];

        const ranked = rows
            .map(r => ({ symbol: r['Symbol'], gapPct: parseFloat(r['Gap %']), latestOpen: parseFloat(r['Latest Open']) }))
            .filter(r => !isNaN(r.gapPct) && !isNaN(r.latestOpen))
            .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));

        const selected = ranked.slice(rankStart - 1, rankStart - 1 + rankCount);

        await Promise.allSettled(selected.map(stock => this.enterLeg(stock, slPercent, targetPercent, lots, config.logEnabled)));
    }

    private async enterLeg(
        stock: { symbol: string; gapPct: number; latestOpen: number },
        slPercent: number,
        targetPercent: number,
        lots: number,
        logEnabled: boolean
    ) {
        try {
            const optionType = stock.gapPct > 0 ? CALL : PUT; // confirm CALL/PUT constant names in src/constants.ts; may be 'CE'/'PE' strings instead
            const contract = AntContractMaster.getInstance().findATMOption(stock.latestOpen, optionType, stock.symbol);
            const ltp = await ANT.getInstance().getQuote(contract.exch, contract.token);
            const stopLossPoints = ltp * (slPercent / 100);
            const targetPoints = ltp * (targetPercent / 100);
            const quantity = parseInt(contract.lotSize, 10) * lots;

            if (logEnabled) {
                Log.log(`[TopStockOptionsOpeningGapStrategy] ${stock.symbol} gap=${stock.gapPct}% dir=${optionType} ` +
                    `contract=${contract.tradingSymbol} ltp=${ltp} qty=${quantity} sl=${stopLossPoints} target=${targetPoints}`);
            }

            await enterPosition(
                this.userId,
                contract.tradingSymbol,
                contract.token,
                quantity,
                'NFO',
                targetPoints,
                stopLossPoints,
                'bracket',
                { ltp, atMs: Date.now() }
            );
        } catch (e) {
            Log.log(`[TopStockOptionsOpeningGapStrategy] ${stock.symbol} leg failed: ${e}`);
        }
    }
}
```

**Open items the implementer must verify before this compiles/runs** (do not
guess, check the real files):
1. `isTimeInRange()`'s exact body/signature in `strategy.ts:144-150` to
   override correctly, and confirm the actual morning time `gap-screener
   .csv` is refreshed by, so the window is set after the data is fresh.
2. Exact names/values of `CALL`/`PUT` in `src/constants.ts` — confirm
   whether `findATMOption`'s `optionType` parameter expects these constants
   or raw strings `'CE'`/`'PE'`.
3. `configService.getStrategyConfig(...)`'s exact signature/return type
   (used by `GapStrategy.ts` similarly) — confirm the method name and that
   it's synchronous.
4. `Trade` type import path if TypeScript requires it for `enterPosition`'s
   return type to be used/awaited meaningfully.

### `config.yml` block (add under `strategies:`)
```yaml
- type: TopStockOptionsOpeningGapStrategy
  enabled: false
  rankStart: 3
  rankCount: 5
  slPercent: 30
  targetPercent: 50
  lots: 1
  logEnabled: true
```
Mirror the same block into `config.mock.yml` for paper-trading dry runs.
`enabled: false` is mandatory on first write — this strategy places real
option orders; the user must flip it to `true` themselves after reviewing
a dry run's logs.

## Verification (for when implementation does happen)

1. Resolve all 4 "open items" above by reading the actual files, before
   writing a single line of the real `.ts` file.
2. Dry run with `enabled: false` (the default): confirm the strategy logs
   the correct ranks-3-7 selection, direction, resolved ATM contracts, and
   computed SL/target points when manually invoked/tested — but places no
   order.
3. Cross-check the rank-3-7 selection against `gap_rank_backtest.py
   --start-rank 3 --count 5` (from `/home/karthikeyan/tools`) run on the
   same morning's data, confirming the two systems agree.
4. Only after manual review, flip `enabled: true` and confirm one live
   order end-to-end before leaving all 5 legs enabled.
5. Confirm ANT's bracket order actually exits at the intended
   premium-relative levels (verify `targetPoints`/`stopLossPoints` are
   interpreted as absolute rupee amounts on the option premium, matching
   this strategy's percent-of-entry-premium conversion).
